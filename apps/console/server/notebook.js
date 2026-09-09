// Instance notebook: the gotchas this instance has taught the agent — renamed
// states, ACL surprises, routing conventions, integration quirks. Stored in
// Postgres per (org, instance), text encrypted under the org key.
//
// This is a console-local write, never an instance write. It is also the one
// console-local write the agent can make on its own, so it is governed
// (ADR 0008 D5): a saved note starts PENDING and is visible only to the
// conversation that produced it. It becomes eligible for injection into every
// future conversation on this instance only after a human clicks Keep, and it
// is stored with who kept it and which conversation it came from. Without that
// gate an agent-written note would be a persistent cross-user prompt-injection
// channel — the red-team finding behind D5.
//
// Every function takes a `scope`: { ctx: OrgContext, instanceId }.

import crypto from 'node:crypto';
import { withOrg } from './db.js';

const COLUMN = 'notebook_entries.text';
const MAX_TEXT_CHARS = 500;
const MAX_NOTES = 200;
const INJECT_MAX_NOTES = 50;
const INJECT_MAX_CHARS = 6000;

const hashOf = (text) => crypto.createHash('sha256').update(text.toLowerCase()).digest();

function toNote(scope, row) {
  let text = '';
  try {
    text = scope.ctx.decrypt(COLUMN, row.text_enc);
  } catch {
    text = '';
  }
  return {
    id: row.id,
    text,
    status: row.status,
    ...(row.context ? { context: row.context } : {}),
    ...(row.saved_by ? { saved_by: row.saved_by } : {}),
    ...(row.kept_by ? { kept_by: row.kept_by } : {}),
    ...(row.kept_at ? { kept_at: new Date(row.kept_at).toISOString() } : {}),
    ...(row.conversation_id ? { conversation: row.conversation_id } : {}),
    created: new Date(row.created_at).toISOString(),
    updated: new Date(row.updated_at).toISOString(),
  };
}

/** A note counts as kept only if a human clicked Keep. */
export function isKept(note) {
  return note?.status === 'kept';
}

/** Newest first. */
export async function listNotes(scope) {
  const { rows } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `SELECT * FROM notebook_entries WHERE instance_id = $1 ORDER BY updated_at DESC`, [scope.instanceId],
  ));
  return rows.map((r) => toNote(scope, r));
}

/**
 * Record a gotcha the agent proposed. The note is saved PENDING — it is not
 * injected anywhere until a human keeps it. An exact-duplicate note is
 * refreshed (timestamp + author) instead of duplicated, and a duplicate of an
 * already-kept note stays kept. Oldest notes fall off past MAX_NOTES.
 */
export async function saveNote(scope, { text, context, user, conversation }) {
  const clean = String(text || '').trim().slice(0, MAX_TEXT_CHARS);
  if (!clean) throw new Error('A note needs text.');
  const ctxText = context ? String(context).slice(0, 80) : null;
  const convId = conversation && /^[0-9a-f-]{36}$/.test(String(conversation)) ? conversation : null;

  return withOrg(scope.ctx.orgId, async (c) => {
    const existing = await c.query(
      `SELECT * FROM notebook_entries WHERE instance_id = $1 AND text_hash = $2`, [scope.instanceId, hashOf(clean)],
    );
    if (existing.rows[0]) {
      const { rows } = await c.query(
        `UPDATE notebook_entries SET updated_at = now(), saved_by = COALESCE($2, saved_by), context = COALESCE($3, context),
                conversation_id = COALESCE($4, conversation_id)
          WHERE id = $1 RETURNING *`,
        [existing.rows[0].id, user || null, ctxText, convId],
      );
      const total = await c.query(`SELECT count(*)::int AS n FROM notebook_entries WHERE instance_id = $1`, [scope.instanceId]);
      return { updated: true, total: total.rows[0].n, note: toNote(scope, rows[0]) };
    }

    const { rows } = await c.query(
      `INSERT INTO notebook_entries (org_id, instance_id, text_enc, text_hash, context, status, saved_by, conversation_id)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, 'pending', $5, $6) RETURNING *`,
      [scope.instanceId, scope.ctx.encrypt(COLUMN, clean), hashOf(clean), ctxText, user || null, convId],
    );
    // Cap: drop the oldest beyond MAX_NOTES for this instance.
    await c.query(
      `DELETE FROM notebook_entries WHERE instance_id = $1 AND id IN (
         SELECT id FROM notebook_entries WHERE instance_id = $1 ORDER BY updated_at DESC OFFSET $2)`,
      [scope.instanceId, MAX_NOTES],
    );
    const total = await c.query(`SELECT count(*)::int AS n FROM notebook_entries WHERE instance_id = $1`, [scope.instanceId]);
    return { updated: false, total: total.rows[0].n, note: toNote(scope, rows[0]) };
  });
}

/**
 * Promote a pending note to kept, on a human click. This is the only path that
 * makes a note eligible for the system prompt of other conversations.
 */
export async function keepNote(scope, id, { user, conversation } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
  const convId = conversation && /^[0-9a-f-]{36}$/.test(String(conversation)) ? conversation : null;
  const { rows } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `UPDATE notebook_entries SET status = 'kept', kept_by = $3, kept_at = now(), updated_at = now(),
            conversation_id = COALESCE($4, conversation_id)
      WHERE id = $1 AND instance_id = $2 RETURNING *`,
    [id, scope.instanceId, user || 'unknown', convId],
  ));
  return rows[0] ? toNote(scope, rows[0]) : null;
}

/** Drop a note entirely, on a human click. */
export async function discardNote(scope, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return false;
  const { rowCount } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `DELETE FROM notebook_entries WHERE id = $1 AND instance_id = $2`, [id, scope.instanceId],
  ));
  return rowCount > 0;
}

/**
 * The block injected into the system prompt: kept notes only, newest first,
 * bounded. Attribution rides along so the model — and anyone reading the
 * prompt — can see these are member-saved hints, not instructions.
 */
export async function notesForPrompt(scope) {
  const notes = (await listNotes(scope)).filter(isKept).slice(0, INJECT_MAX_NOTES);
  if (!notes.length) return '';
  const lines = [];
  let chars = 0;
  for (const n of notes) {
    const who = n.kept_by ? ` (kept by ${n.kept_by})` : '';
    const line = `- ${n.context ? `[${n.context}] ` : ''}${n.text}${who}`;
    chars += line.length + 1;
    if (chars > INJECT_MAX_CHARS) break;
    lines.push(line);
  }
  return lines.join('\n');
}
