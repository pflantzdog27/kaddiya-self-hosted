// Durable outputs: the documents, tables and snippets the work pane shows.
//
// The unit is an *output* — a stable id that survives reload, revision and
// the conversation scrolling away — and a *revision*, one complete saved
// version of it. Nothing here is a draft: a revision exists only after the
// transaction that wrote it committed, which is what lets the browser say
// "Saved" and mean it, and what lets a download hand over the exact bytes a
// person is reading rather than a re-render of them.
//
// Scope is (org, instance, user, conversation), enforced three ways because
// one is never enough: RLS pins the org inside withOrg(); the WHERE clauses
// below pin the instance and the user; and the composite foreign keys in
// 009_outputs.sql make a cross-tenant parent structurally impossible rather
// than merely unqueried. The AAD binds each ciphertext to its org, its output
// and its revision, so a blob moved between rows fails to open (keys.test.js
// proves that direction for conversations; outputs.test.js proves it here).
//
// What this module does NOT do: call a model, hold a transaction open across
// one, or reach the instance. A revision is bytes the console already has.

import crypto from 'node:crypto';
import { withOrg } from './db.js';

// ---- the format map: an explicit enum, never a guess from a filename ----
//
// `native` is what a download says it is. Code is text/plain whatever the
// language: an .html or .svg output is source to read and a file to keep, and
// serving it as its own type — even as an attachment — is one misconfigured
// header away from running in this origin. The extension still tells the
// truth, so the file opens in the right editor once it is saved.
export const FORMATS = Object.freeze({
  markdown: { ext: 'md',  native: 'text/markdown; charset=utf-8' },
  text:     { ext: 'txt', native: 'text/plain; charset=utf-8' },
  code:     { ext: null,  native: 'text/plain; charset=utf-8' },  // extension comes from `language`
  json:     { ext: 'json', native: 'application/json; charset=utf-8' },
  csv:      { ext: 'csv', native: 'text/csv; charset=utf-8' },
  tsv:      { ext: 'tsv', native: 'text/tab-separated-values; charset=utf-8' },
});

// The code languages we will label and name a file for. A language off this
// list is not an error — it becomes `text` with a .txt extension — because a
// refused document is worse than a plainly labelled one.
export const LANGUAGES = Object.freeze({
  javascript: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx', json: 'json',
  python: 'py', shell: 'sh', bash: 'sh', powershell: 'ps1', batch: 'bat',
  sql: 'sql', yaml: 'yaml', xml: 'xml', html: 'html', svg: 'svg', css: 'css',
  java: 'java', groovy: 'groovy', go: 'go', ruby: 'rb', php: 'php', rust: 'rs',
  c: 'c', cpp: 'cpp', csharp: 'cs', kotlin: 'kt', swift: 'swift',
  ini: 'ini', toml: 'toml', properties: 'properties', jelly: 'jelly',
  diff: 'diff', markdown: 'md', text: 'txt',
});

export const ACTOR_KINDS = Object.freeze(['assistant', 'user']);

// Defaults from the spec; every one may be lowered by the environment, never
// raised, so a cautious operator can tighten a deployment without a fork.
const envLimit = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 && raw < fallback ? Math.floor(raw) : fallback;
};
export const LIMITS = Object.freeze({
  revisionBytes:        envLimit('KADDIYA_OUTPUT_MAX_BYTES', 256 * 1024),
  outputsPerConversation: envLimit('KADDIYA_OUTPUTS_PER_CONVERSATION', 50),
  revisionsPerOutput:   envLimit('KADDIYA_REVISIONS_PER_OUTPUT', 50),
  conversationBytes:    envLimit('KADDIYA_OUTPUT_CONVERSATION_BYTES', 16 * 1024 * 1024),
  orgBytes:             envLimit('KADDIYA_OUTPUT_ORG_BYTES', 256 * 1024 * 1024),
  titleChars:           200,
  changeSummaryChars:   500,
  listPageSize:         25,
  listPageMax:          50,
});

const SCHEMA_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every refusal the callers distinguish, with a code an HTTP layer can map. */
export class OutputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OutputError';
    this.code = code;
  }
}

const invalid = (m) => new OutputError('invalid', m);

// ---- naming ----

// Windows will not create these, whatever the extension, and a download that
// silently fails on one operating system is worse than a renamed file.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function extensionFor(format, language) {
  if (format === 'code') return LANGUAGES[String(language || '').toLowerCase()] || 'txt';
  return FORMATS[format].ext;
}

export function contentTypeFor(format) {
  return FORMATS[format].native;
}

/**
 * A filename we are willing to put in a Content-Disposition header and on a
 * stranger's disk. The model proposes; this disposes: directory separators,
 * traversal, control characters, quotes, leading dots and Windows reserved
 * names are removed rather than rejected, and the extension is always the one
 * the validated format earns — a `.md` output cannot be handed over as `.exe`,
 * and calling a document `.xlsx` does not make it a spreadsheet.
 */
export function safeFilename(proposed, format, language) {
  const ext = extensionFor(format, language);
  let base = String(proposed || '')
    .replace(/[\\/]+/g, ' ')            // no directories, ever
    .replace(/[\u0000-\u001f\u007f]/g, '')  // no control characters or header breaks
    .replace(/[<>:"|?*]/g, '')          // characters Windows refuses in a name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '');            // no leading dot: not a hidden file
  // Drop a proposed extension so the format's own is authoritative.
  base = base.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim();
  base = base.replace(/[^A-Za-z0-9 ._()\-\u00a0-\uffff]/g, '').trim();
  if (RESERVED.test(base)) base = `${base}-file`;
  if (!base) base = 'output';
  if (base.length > 80) base = base.slice(0, 80).trim();
  return `${base}.${ext}`;
}

/** The ASCII fallback a Content-Disposition header can carry unquoted. */
export function asciiFilename(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return ascii.trim() || 'output.txt';
}

// ---- validation ----

function validateText(content) {
  if (typeof content !== 'string') throw invalid('Content must be text.');
  if (content.includes('\u0000')) throw invalid('Content cannot contain null bytes.');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes === 0) throw invalid('An output needs content.');
  if (bytes > LIMITS.revisionBytes) {
    throw new OutputError('too_large',
      `That version is ${Math.round(bytes / 1024)} KB; the limit is ${Math.round(LIMITS.revisionBytes / 1024)} KB per version. Ask for a shorter document, or split it into sections.`);
  }
  return bytes;
}

function validateFormat(format, language) {
  const f = String(format || '').toLowerCase();
  if (!FORMATS[f]) throw invalid(`Unknown format "${format}". Use one of: ${Object.keys(FORMATS).join(', ')}.`);
  const lang = language == null ? null : String(language).toLowerCase().slice(0, 24);
  if (lang && !/^[a-z0-9+#.-]+$/.test(lang)) throw invalid('Language must be a plain identifier.');
  return { format: f, language: f === 'code' ? (lang || 'text') : null };
}

function cleanTitle(title, filename) {
  const t = String(title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, LIMITS.titleChars);
  return String(filename || 'Untitled').replace(/\.[^.]+$/, '') || 'Untitled';
}

function cleanProvenance(provenance = {}) {
  const out = { origin: ACTOR_KINDS.includes(provenance.origin) ? provenance.origin : 'assistant' };
  if (provenance.turnId && UUID.test(String(provenance.turnId))) out.turnId = String(provenance.turnId);
  if (provenance.toolUseId) out.toolUseId = String(provenance.toolUseId).slice(0, 120);
  // Source references are a *claim* by the model until something verifies
  // them, and labelling them as evidence would be the console vouching for
  // text it did not check. They travel as unverified, and the viewer says so.
  if (Array.isArray(provenance.sources) && provenance.sources.length) {
    out.sources = provenance.sources.slice(0, 20).map((s) => ({
      label: String(s?.label || '').slice(0, 120),
      table: /^[a-z0-9_]{1,80}$/i.test(String(s?.table || '')) ? String(s.table) : undefined,
      sys_id: /^[0-9a-f]{32}$/i.test(String(s?.sys_id || '')) ? String(s.sys_id) : undefined,
      verified: false,
    }));
  }
  return out;
}

function operationIdOf(operationId) {
  const id = String(operationId || '').trim();
  if (!id || id.length > 200) throw invalid('An operation id is required for a save.');
  if (!/^[A-Za-z0-9:._-]+$/.test(id)) throw invalid('Operation id must be a plain identifier.');
  return id;
}

/** The AAD: this org, this output, this revision. Nothing else opens it. */
const payloadColumn = (outputId, revision) => `outputs.payload:${outputId}:${revision}`;

function sha256Of(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// The advisory key for an org's output writes. Derived here rather than with
// hashtext() so the lock does not depend on an internal server function.
function orgLockKeys(orgId) {
  const h = crypto.createHash('sha256').update(`kaddiya-outputs:${orgId}`).digest();
  return [h.readInt32BE(0), h.readInt32BE(4)];
}

// ---- reading a stored payload back ----

function openPayload(ctx, row) {
  const json = ctx.decrypt(payloadColumn(row.output_id, row.revision), row.payload_enc);
  const payload = JSON.parse(json);
  return payload;
}

function referenceOf(row, payload) {
  return {
    output_id: row.output_id,
    revision: row.revision,
    title: payload.title,
    filename: payload.filename,
    format: payload.format,
    language: payload.language || undefined,
    byte_length: row.byte_length,
    sha256: payload.sha256,
    status: 'saved',
  };
}

function metadataOf(row, payload) {
  return {
    ...referenceOf(row, payload),
    conversation_id: row.conversation_id,
    current_revision: row.current_revision,
    change_summary: payload.changeSummary || null,
    provenance: payload.provenance || null,
    actor_kind: row.actor_kind,
    created: new Date(row.output_created_at || row.created_at).toISOString(),
    updated: new Date(row.updated_at || row.created_at).toISOString(),
    revision_created: new Date(row.created_at).toISOString(),
  };
}

// ---- the write path ----

// `created_cursor` is the creation time as PostgreSQL prints it, at full
// microsecond precision. The driver parses timestamptz into a JavaScript
// Date, which only has milliseconds — so a cursor built from that Date can
// land *before* the row it was taken from, and the next page repeats it.
// PGlite happened to hide this; PostgreSQL does not.
const OUTPUT_COLUMNS = `o.id, o.conversation_id, o.current_revision, o.created_at AS output_created_at, o.created_at::text AS created_cursor, o.updated_at`;
const REVISION_COLUMNS = `r.output_id, r.revision, r.payload_enc, r.byte_length, r.created_at, r.actor_kind`;

/**
 * One short transaction, in a fixed lock order (org advisory -> conversation
 * row -> output row) so two concurrent saves queue rather than deadlock:
 *
 *   verify the scoped parent · deduplicate the operation · check the quotas ·
 *   check expected_revision · insert the revision · advance the head
 *
 * The model is never called from in here and no network happens inside it.
 */
async function commitRevision(scope, plan) {
  const { conversationId, operationId, actorKind, leaseId } = plan;
  return withOrg(scope.ctx.orgId, async (c) => {
    const [k1, k2] = orgLockKeys(scope.ctx.orgId);
    await c.query('SELECT pg_advisory_xact_lock($1, $2)', [k1, k2]);

    // The full owner, not just the org: a conversation id from another member
    // or another instance is as absent as one that never existed.
    const { rows: [conv] } = await c.query(
      `SELECT id FROM conversations WHERE id = $1 AND instance_id = $2 AND sn_user_sys_id = $3 FOR UPDATE`,
      [conversationId, scope.instanceId, scope.userSysId],
    );
    if (!conv) throw new OutputError('not_found', 'That conversation is not available.');

    // A turn that lost its lease must not land a write behind the turn that
    // took over. Checked here, inside the same transaction as the write.
    if (leaseId) {
      const { rows: [lease] } = await c.query(
        `SELECT lease_id FROM conversation_turns WHERE conversation_id = $1 AND expires_at > now()`,
        [conversationId],
      );
      if (!lease || lease.lease_id !== leaseId) {
        throw new OutputError('lease_lost', 'This turn no longer holds the conversation; another turn took over.');
      }
    }

    // Idempotency. A retried tool call, a reconnect after a lost response, a
    // double-clicked Save: same operation id, same bytes, same revision back.
    const { rows: [prior] } = await c.query(
      `SELECT ${REVISION_COLUMNS}, o.conversation_id, o.current_revision, o.created_at AS output_created_at, o.updated_at
         FROM output_revisions r JOIN outputs o ON o.id = r.output_id AND o.org_id = r.org_id
        WHERE r.operation_id = $1`,
      [operationId],
    );
    if (prior) {
      const payload = openPayload(scope.ctx, prior);
      if (payload.sha256 !== plan.sha256) {
        throw new OutputError('duplicate_operation',
          'That operation id already saved different content. Start a new save rather than reusing it.');
      }
      return { reference: referenceOf(prior, payload), metadata: metadataOf(prior, payload), replayed: true };
    }

    let outputId = plan.outputId;
    let revision;
    let carried = plan.payload;

    if (plan.create) {
      const { rows: [{ count }] } = await c.query(
        `SELECT count(*)::int AS count FROM outputs WHERE conversation_id = $1`, [conversationId],
      );
      if (count >= LIMITS.outputsPerConversation) {
        throw new OutputError('quota', `This conversation already holds ${LIMITS.outputsPerConversation} files, the limit. Start a new conversation for more.`);
      }
      outputId = crypto.randomUUID();
      revision = 1;
      await c.query(
        `INSERT INTO outputs (id, org_id, instance_id, sn_user_sys_id, conversation_id, current_revision)
         VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, $4, 0)`,
        [outputId, scope.instanceId, scope.userSysId, conversationId],
      );
    } else {
      const { rows: [row] } = await c.query(
        `SELECT id, current_revision FROM outputs
          WHERE id = $1 AND conversation_id = $2 AND instance_id = $3 AND sn_user_sys_id = $4 FOR UPDATE`,
        [outputId, conversationId, scope.instanceId, scope.userSysId],
      );
      if (!row) throw new OutputError('not_found', 'That file is not available.');
      if (row.current_revision >= LIMITS.revisionsPerOutput) {
        throw new OutputError('quota', `This file already has ${LIMITS.revisionsPerOutput} versions, the limit. Create a new file for further work.`);
      }
      // Compare-and-swap, independent of the turn lease: a revision written
      // against a version that has since moved is a conflict to resolve, not
      // a write to retry blindly.
      if (plan.expectedRevision !== row.current_revision) {
        throw new OutputError('conflict',
          `This file is at version ${row.current_revision}; the change was written against version ${plan.expectedRevision}. Read the latest version and revise that.`);
      }
      revision = row.current_revision + 1;

      const { rows: [head] } = await c.query(
        `SELECT ${REVISION_COLUMNS} FROM output_revisions r WHERE r.output_id = $1 AND r.revision = $2`,
        [outputId, row.current_revision],
      );
      if (!head) throw new OutputError('not_found', 'That file is not available.');
      const previous = openPayload(scope.ctx, head);
      // Creation establishes identity; a revision changes the content, never
      // the format or the name the person has already downloaded once.
      carried = {
        ...carried,
        title: plan.payload.title || previous.title,
        filename: previous.filename,
        format: previous.format,
        language: previous.language ?? null,
      };
    }

    // Aggregate quotas, inside the transaction and under the org lock, so two
    // concurrent saves cannot each see room that only one of them has.
    const { rows: [convBytes] } = await c.query(
      `SELECT COALESCE(SUM(r.byte_length), 0)::bigint AS bytes
         FROM output_revisions r JOIN outputs o ON o.id = r.output_id AND o.org_id = r.org_id
        WHERE o.conversation_id = $1`, [conversationId],
    );
    if (Number(convBytes.bytes) + plan.byteLength > LIMITS.conversationBytes) {
      throw new OutputError('quota', `This conversation's files would exceed its ${Math.round(LIMITS.conversationBytes / 1048576)} MB limit. Nothing was saved or removed.`);
    }
    const { rows: [orgBytes] } = await c.query(
      `SELECT COALESCE(SUM(byte_length), 0)::bigint AS bytes FROM output_revisions`,
    );
    if (Number(orgBytes.bytes) + plan.byteLength > LIMITS.orgBytes) {
      throw new OutputError('quota', `This workspace's files would exceed its ${Math.round(LIMITS.orgBytes / 1048576)} MB limit. Nothing was saved or removed.`);
    }

    const payload = { schemaVersion: SCHEMA_VERSION, ...carried, sha256: plan.sha256 };
    await c.query(
      `INSERT INTO output_revisions (org_id, output_id, revision, payload_enc, byte_length, actor_kind, operation_id)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6)`,
      [outputId, revision, scope.ctx.encrypt(payloadColumn(outputId, revision), JSON.stringify(payload)),
        plan.byteLength, actorKind, operationId],
    );
    const { rowCount } = await c.query(
      `UPDATE outputs SET current_revision = $2, updated_at = now()
        WHERE id = $1 AND current_revision = $3`,
      [outputId, revision, revision - 1],
    );
    if (!rowCount) throw new OutputError('conflict', 'Another version landed first. Read the latest version and revise that.');

    const { rows: [saved] } = await c.query(
      `SELECT ${REVISION_COLUMNS}, ${OUTPUT_COLUMNS}
         FROM output_revisions r JOIN outputs o ON o.id = r.output_id AND o.org_id = r.org_id
        WHERE r.output_id = $1 AND r.revision = $2`,
      [outputId, revision],
    );
    return { reference: referenceOf(saved, payload), metadata: metadataOf({ ...saved, id: outputId }, payload), replayed: false };
  });
}

/** A first version: establishes the id, the format and the name. */
export async function createOutput(scope, input = {}) {
  const conversationId = String(input.conversationId || '');
  if (!UUID.test(conversationId)) throw invalid('A conversation is required.');
  const { format, language } = validateFormat(input.format, input.language);
  const content = String(input.content ?? '');
  const byteLength = validateText(content);
  const filename = safeFilename(input.filename, format, language);
  const payload = {
    title: cleanTitle(input.title, filename),
    filename,
    format,
    language,
    content,
    changeSummary: input.changeSummary ? String(input.changeSummary).slice(0, LIMITS.changeSummaryChars) : undefined,
    provenance: cleanProvenance(input.provenance),
  };
  return commitRevision(scope, {
    create: true,
    conversationId,
    operationId: operationIdOf(input.operationId),
    actorKind: ACTOR_KINDS.includes(input.actorKind) ? input.actorKind : 'assistant',
    leaseId: input.leaseId || null,
    payload,
    byteLength,
    sha256: sha256Of(content),
  });
}

/** A further version of an existing output, against the version it was written for. */
export async function updateOutput(scope, input = {}) {
  const conversationId = String(input.conversationId || '');
  const outputId = String(input.outputId || '');
  if (!UUID.test(conversationId)) throw invalid('A conversation is required.');
  if (!UUID.test(outputId)) throw new OutputError('not_found', 'That file is not available.');
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw invalid('expected_revision must be the version number this change was written against.');
  }
  const content = String(input.content ?? '');
  const byteLength = validateText(content);
  const payload = {
    title: input.title ? cleanTitle(input.title, '') : null,
    content,
    changeSummary: input.changeSummary ? String(input.changeSummary).slice(0, LIMITS.changeSummaryChars) : undefined,
    provenance: cleanProvenance(input.provenance),
  };
  return commitRevision(scope, {
    create: false,
    outputId,
    conversationId,
    expectedRevision,
    operationId: operationIdOf(input.operationId),
    actorKind: ACTOR_KINDS.includes(input.actorKind) ? input.actorKind : 'assistant',
    leaseId: input.leaseId || null,
    payload,
    byteLength,
    sha256: sha256Of(content),
  });
}

// ---- the read path ----

/**
 * Metadata and the exact text of one revision. An omitted revision resolves
 * to the current head and reports which number that was — the browser needs
 * to know what it is looking at, not merely that it is "latest".
 */
export async function readOutput(scope, outputId, { revision = null, conversationId = null } = {}) {
  if (!UUID.test(String(outputId || ''))) return null;
  if (revision != null && (!Number.isInteger(Number(revision)) || Number(revision) < 1)) return null;
  const row = await withOrg(scope.ctx.orgId, async (c) => {
    const { rows } = await c.query(
      `SELECT ${REVISION_COLUMNS}, ${OUTPUT_COLUMNS}
         FROM outputs o
         JOIN output_revisions r ON r.output_id = o.id AND r.org_id = o.org_id
        WHERE o.id = $1 AND o.instance_id = $2 AND o.sn_user_sys_id = $3
          AND ($4::uuid IS NULL OR o.conversation_id = $4::uuid)
          AND r.revision = COALESCE($5::int, o.current_revision)`,
      [outputId, scope.instanceId, scope.userSysId, conversationId, revision == null ? null : Number(revision)],
    );
    return rows[0] || null;
  });
  if (!row) return null;
  let payload;
  try { payload = openPayload(scope.ctx, row); }
  catch { return null; }  // wrong key or a moved blob: absent, never someone else's
  return { ...metadataOf(row, payload), content: payload.content };
}

/** The same, without the body: what the Files list and a card need. */
export async function outputMetadata(scope, outputId, options = {}) {
  const full = await readOutput(scope, outputId, options);
  if (!full) return null;
  const { content, ...meta } = full;
  return meta;
}

// The timestamp travels as the database's own text, never as a re-formatted
// Date, and goes back in through a ::timestamptz cast so no precision is lost
// in either direction.
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;

function encodeCursor(row) {
  const ts = row.created_cursor || new Date(row.output_created_at || row.created_at).toISOString();
  return Buffer.from(`${ts}|${row.id || row.output_id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [ts, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
    if (!UUID.test(id || '') || !TIMESTAMP_TEXT.test(ts || '')) return null;
    return { ts, id };
  } catch { return null; }
}

/**
 * One page of a conversation's files, oldest first so the list reads in the
 * order the work happened. Metadata only leaves this function — the head
 * payload is opened to read the title and format, and the body is dropped
 * here rather than travelling to the browser or a log.
 */
export async function listOutputs(scope, conversationId, { cursor = null, limit = LIMITS.listPageSize } = {}) {
  if (!UUID.test(String(conversationId || ''))) return { outputs: [], next_cursor: null };
  const size = Math.max(1, Math.min(Number(limit) || LIMITS.listPageSize, LIMITS.listPageMax));
  const after = decodeCursor(cursor);
  const rows = await withOrg(scope.ctx.orgId, async (c) => {
    const { rows } = await c.query(
      `SELECT ${REVISION_COLUMNS}, ${OUTPUT_COLUMNS}
         FROM outputs o
         JOIN output_revisions r ON r.output_id = o.id AND r.org_id = o.org_id AND r.revision = o.current_revision
        WHERE o.conversation_id = $1 AND o.instance_id = $2 AND o.sn_user_sys_id = $3
          AND ($4::timestamptz IS NULL OR (o.created_at, o.id) > ($4::timestamptz, $5::uuid))
        ORDER BY o.created_at, o.id
        LIMIT $6`,
      [conversationId, scope.instanceId, scope.userSysId, after?.ts || null, after?.id || null, size + 1],
    );
    return rows;
  });
  const page = rows.slice(0, size);
  const outputs = [];
  for (const row of page) {
    try {
      const payload = openPayload(scope.ctx, row);
      const { content, ...meta } = { ...metadataOf(row, payload), content: undefined };
      outputs.push(meta);
    } catch { /* a blob that will not open is not this list's problem to raise */ }
  }
  return { outputs, next_cursor: rows.length > size ? encodeCursor(page[page.length - 1]) : null };
}

/** Version metadata for the version selector, newest first. */
export async function listRevisions(scope, outputId, { cursor = null, limit = LIMITS.listPageSize } = {}) {
  if (!UUID.test(String(outputId || ''))) return null;
  const size = Math.max(1, Math.min(Number(limit) || LIMITS.listPageSize, LIMITS.listPageMax));
  const before = /^\d{1,9}$/.test(String(cursor || '')) ? Number(cursor) : null;
  return withOrg(scope.ctx.orgId, async (c) => {
    const { rows: [owned] } = await c.query(
      `SELECT id, current_revision FROM outputs WHERE id = $1 AND instance_id = $2 AND sn_user_sys_id = $3`,
      [outputId, scope.instanceId, scope.userSysId],
    );
    if (!owned) return null;
    const { rows } = await c.query(
      `SELECT ${REVISION_COLUMNS} FROM output_revisions r
        WHERE r.output_id = $1 AND ($2::int IS NULL OR r.revision < $2::int)
        ORDER BY r.revision DESC LIMIT $3`,
      [outputId, before, size + 1],
    );
    const page = rows.slice(0, size);
    const revisions = page.map((row) => {
      let payload = {};
      try { payload = openPayload(scope.ctx, row); } catch { /* listed by number even if unreadable */ }
      return {
        revision: row.revision,
        byte_length: row.byte_length,
        actor_kind: row.actor_kind,
        created: new Date(row.created_at).toISOString(),
        change_summary: payload.changeSummary || null,
        title: payload.title || null,
        filename: payload.filename || null,
      };
    });
    return {
      output_id: outputId,
      current_revision: owned.current_revision,
      revisions,
      next_cursor: rows.length > size ? String(page[page.length - 1].revision) : null,
    };
  });
}

/** How many files a conversation holds — the Files count, without a page of rows. */
export async function countOutputs(scope, conversationId) {
  if (!UUID.test(String(conversationId || ''))) return 0;
  const { rows: [row] } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `SELECT count(*)::int AS count FROM outputs WHERE conversation_id = $1 AND instance_id = $2 AND sn_user_sys_id = $3`,
    [conversationId, scope.instanceId, scope.userSysId],
  ));
  return row?.count || 0;
}

// ---- the turn lease ----
//
// Shared hosting makes "is this conversation busy?" a question about rows,
// not about this process's memory. The lease is short and renewed while a
// turn is alive, so a crashed process frees its conversation by expiry
// rather than by anyone remembering to clean up.

export const TURN_LEASE_MS = 90_000;

/**
 * Take the conversation for this turn, or report who has it. Expiry is the
 * only way a lease is lost without being released: an expired row is taken
 * over by id, and the previous holder's writes are refused by the lease check
 * in commitRevision() rather than being allowed to land late.
 */
export async function acquireTurn(scope, conversationId, { holder = 'chat', ttlMs = TURN_LEASE_MS } = {}) {
  if (!UUID.test(String(conversationId || ''))) throw invalid('A conversation is required.');
  const leaseId = crypto.randomUUID();
  const ttl = Math.max(5_000, Math.min(Number(ttlMs) || TURN_LEASE_MS, 10 * 60_000));
  return withOrg(scope.ctx.orgId, async (c) => {
    const { rows: [conv] } = await c.query(
      `SELECT id FROM conversations WHERE id = $1 AND instance_id = $2 AND sn_user_sys_id = $3 FOR UPDATE`,
      [conversationId, scope.instanceId, scope.userSysId],
    );
    if (!conv) throw new OutputError('not_found', 'That conversation is not available.');
    const { rows } = await c.query(
      `INSERT INTO conversation_turns (conversation_id, org_id, lease_id, holder, expires_at)
       VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, now() + ($4 || ' milliseconds')::interval)
       ON CONFLICT (conversation_id) DO UPDATE
         SET lease_id = EXCLUDED.lease_id, holder = EXCLUDED.holder,
             acquired_at = now(), renewed_at = now(), expires_at = EXCLUDED.expires_at
       WHERE conversation_turns.expires_at <= now()
       RETURNING lease_id`,
      [conversationId, leaseId, String(holder).slice(0, 24), String(ttl)],
    );
    if (rows[0]?.lease_id === leaseId) return { leaseId, conversationId };
    const { rows: [held] } = await c.query(
      `SELECT holder, expires_at FROM conversation_turns WHERE conversation_id = $1`, [conversationId],
    );
    throw new OutputError('busy', held?.holder === 'run'
      ? 'A task is already running on this conversation. Stop it before starting another.'
      : 'Another message is already running on this conversation. Wait for it to finish.');
  });
}

/** Keep a live turn's lease from expiring under it. Returns false once lost. */
export async function renewTurn(scope, conversationId, leaseId, { ttlMs = TURN_LEASE_MS } = {}) {
  if (!leaseId) return false;
  const ttl = Math.max(5_000, Math.min(Number(ttlMs) || TURN_LEASE_MS, 10 * 60_000));
  const { rowCount } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `UPDATE conversation_turns SET renewed_at = now(), expires_at = now() + ($3 || ' milliseconds')::interval
      WHERE conversation_id = $1 AND lease_id = $2 AND expires_at > now()`,
    [conversationId, leaseId, String(ttl)],
  ));
  return rowCount > 0;
}

/** Release in a finally: the next turn should not wait out an expiry. */
export async function releaseTurn(scope, conversationId, leaseId) {
  if (!leaseId) return false;
  try {
    const { rowCount } = await withOrg(scope.ctx.orgId, (c) => c.query(
      `DELETE FROM conversation_turns WHERE conversation_id = $1 AND lease_id = $2`,
      [conversationId, leaseId],
    ));
    return rowCount > 0;
  } catch { return false; }
}

/** Who holds this conversation right now, if anyone. For a 409's wording. */
export async function turnHolder(scope, conversationId) {
  if (!UUID.test(String(conversationId || ''))) return null;
  const { rows: [row] } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `SELECT holder, lease_id, expires_at FROM conversation_turns WHERE conversation_id = $1 AND expires_at > now()`,
    [conversationId],
  ));
  return row ? { holder: row.holder, leaseId: row.lease_id, expires: new Date(row.expires_at).toISOString() } : null;
}
