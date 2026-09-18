// Update set package: an update set on the instance, rendered as the two
// files a person can actually hand over — the loadable XML and a ledger that
// says what is in it.
//
// Why this is a READ tool and not a catalog action. Packaging calls
// `GET /api/now/table/sys_update_set/{id}` and `GET /api/now/table/sys_update_xml`
// and nothing else: the update set already exists, its entries were captured
// by ServiceNow when the person committed each card, and this reads them back
// and formats them. Nothing on the instance changes, so there is nothing for
// anyone to approve (ADR 0009 D2 is about writes, and this is not one). The
// approval the package will eventually need has not been skipped — it has
// moved to the target instance, where Retrieved Update Sets → Preview shows
// the person a diff the platform computed itself, which is a better review
// than any card of ours.
//
// What the format has to be right about. The file the platform's own
// "Export to XML" produces is an `<unload>` document holding one
// `<sys_remote_update_set>` and one `<sys_update_xml>` per captured change,
// each child pointing at the parent's sys_id through `remote_update_set`.
// The column names below were read off a live instance rather than
// remembered. Field values are emitted raw (no display_value attributes):
// the loader reads values, and a display string that disagreed with its
// value would be worse than one that is absent.
//
// The one hard rule: NEVER emit a partial package. A truncated update set is
// a file that loads, previews clean, and silently omits half the work. Over
// the caps this module throws instead, and says what it found.

import crypto from 'node:crypto';

/** Beyond these, refuse rather than trim (see the header). */
export const MAX_ENTRIES = 2000;
export const MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;
const PAGE = 50;

/**
 * sys_update_xml columns an export carries, alphabetically as the platform's
 * XML writer emits them. `payload` is the captured record; the rest is the
 * bookkeeping the loader matches on (update_guid especially — it is how
 * Preview decides "same change" versus "collision").
 */
const ENTRY_FIELDS = [
  'action', 'application', 'category', 'comments', 'name', 'payload', 'payload_hash',
  'replace_on_upgrade', 'sys_created_by', 'sys_created_on', 'sys_id', 'sys_recorded_at',
  'sys_updated_by', 'sys_updated_on', 'table', 'target_name', 'type', 'update_domain',
  'update_guid', 'update_guid_history', 'view',
];

/** Columns read off the source set, for the synthesized remote-set element. */
const SET_FIELDS = [
  'sys_id', 'name', 'description', 'state', 'application', 'release_date', 'is_default',
  'parent', 'base_update_set', 'merged_to', 'sys_created_by', 'sys_created_on',
  'sys_updated_by', 'sys_updated_on', 'completed_by', 'completed_on',
];

export class PackageError extends Error {
  constructor(message, { code = 'refused' } = {}) {
    super(message);
    this.name = 'PackageError';
    this.code = code;
  }
}

// ---- XML ----

// XML 1.0 forbids most C0 controls outright; they cannot be escaped, only
// dropped. A script field with a stray 0x01 in it would otherwise produce a
// file that no parser will read, so they are counted and removed.
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * Text content escapes `& < >` and leaves quotes alone, which is what the
 * platform's own writer does. Any parser reads the two spellings the same,
 * but matching the platform keeps a Kaddiya package diffable against an
 * export of the same set.
 */
function escapeXml(value, counter) {
  const raw = String(value ?? '');
  const clean = raw.replace(ILLEGAL, () => { if (counter) counter.stripped += 1; return ''; });
  return clean.replace(/[&<>]/g, (c) => ESCAPES[c]);
}

/** Attribute values additionally escape the delimiter. */
function escapeAttr(value) {
  return String(value ?? '').replace(ILLEGAL, '').replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

/** One element. Empty values become `<name/>`, which is what an export does. */
function el(name, value, counter) {
  const text = escapeXml(value, counter);
  return text === '' ? `<${name}/>` : `<${name}>${text}</${name}>`;
}

/**
 * A reference field read with sysparm_exclude_reference_link=true is a plain
 * string, but a display-value read gives `{ display_value, value }`. Take the
 * stored value either way — the loader matches on values.
 */
function stored(field) {
  if (field && typeof field === 'object') return field.value ?? '';
  return field ?? '';
}

function displayed(field) {
  if (field && typeof field === 'object') return field.display_value ?? field.value ?? '';
  return field ?? '';
}

/** `2026-09-18 14:03:22` in UTC, the format every date column in an export uses. */
function snTimestamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * The remote set's sys_id, derived from the source set rather than random, so
 * re-packaging the same set twice produces the same bytes and the same row on
 * the target (the loader dedupes on remote_sys_id). Two exports of one set
 * should be diffable; a fresh GUID each time would make every export look
 * like a new one.
 */
function remoteSysId(sourceSysId) {
  return crypto.createHash('sha256')
    .update(`kaddiya:update-set-package:${sourceSysId}`)
    .digest('hex')
    .slice(0, 32);
}

function remoteSetElement(set, { unloadDate, counter }) {
  const sysId = remoteSysId(stored(set.sys_id));
  const scope = stored(set.application) || 'global';
  const fields = [
    el('application', scope, counter),
    el('application_name', displayed(set.application) || 'Global', counter),
    el('application_scope', scope, counter),
    el('collisions', '', counter),
    el('commit_date', '', counter),
    el('deleted', '', counter),
    el('description', stored(set.description), counter),
    el('inserted', '', counter),
    el('name', stored(set.name), counter),
    el('origin_sys_id', stored(set.sys_id), counter),
    el('parent', '', counter),
    el('release_date', stored(set.release_date), counter),
    el('remote_sys_id', stored(set.sys_id), counter),
    // `loaded` is the state an import expects to find: the set arrives ready
    // to Preview, and the person commits it or does not.
    el('state', 'loaded', counter),
    el('summary', '', counter),
    el('sys_class_name', 'sys_remote_update_set', counter),
    el('sys_created_by', stored(set.sys_created_by), counter),
    el('sys_created_on', stored(set.sys_created_on), counter),
    el('sys_id', sysId, counter),
    el('sys_mod_count', '0', counter),
    el('sys_updated_by', stored(set.sys_updated_by), counter),
    el('sys_updated_on', stored(set.sys_updated_on) || unloadDate, counter),
    el('update_set', '', counter),
    el('update_source', '', counter),
    el('updated', '', counter),
  ];
  return { sysId, xml: `<sys_remote_update_set action="INSERT_OR_UPDATE">\n${fields.join('\n')}\n</sys_remote_update_set>` };
}

function entryElement(entry, remoteId, counter) {
  const fields = ENTRY_FIELDS.map((field) => {
    // Both are references whose empty value would orphan the change; global
    // is what the platform writes when a record belongs to no scope/domain.
    const fallback = field === 'application' || field === 'update_domain' ? 'global' : '';
    return [field, stored(entry[field]) || fallback];
  });
  // The link back to the parent: the loader files each change under the
  // remote set carrying this sys_id.
  fields.push(['remote_update_set', remoteId]);
  // Sorted by column name, as the platform's XML writer emits them, so two
  // packages of the same set differ only where the set differs.
  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = fields.map(([name, value]) => el(name, value, counter));
  return `<sys_update_xml action="INSERT_OR_UPDATE">\n${lines.join('\n')}\n</sys_update_xml>`;
}

// ---- reading the set ----

async function readSet(sn, sysId) {
  const res = await sn.get(`/api/now/table/sys_update_set/${encodeURIComponent(sysId)}`, {
    sysparm_fields: SET_FIELDS.join(','),
    sysparm_display_value: 'all',
  }).catch((err) => { throw new PackageError(`Could not read update set ${sysId}: ${err.message}`, { code: 'unreadable' }); });
  const set = res?.result;
  if (!set || !stored(set.sys_id)) throw new PackageError(`No update set with sys_id ${sysId} is readable on this instance.`, { code: 'not_found' });
  return set;
}

async function readEntries(sn, setId) {
  const entries = [];
  let bytes = 0;
  for (let offset = 0; ; offset += PAGE) {
    const page = await sn.get('/api/now/table/sys_update_xml', {
      sysparm_query: `update_set=${setId}^ORDERBYsys_recorded_at`,
      sysparm_fields: ENTRY_FIELDS.join(','),
      sysparm_display_value: 'false',
      sysparm_exclude_reference_link: 'true',
      sysparm_limit: PAGE,
      sysparm_offset: offset,
    });
    const rows = page?.result ?? [];
    for (const row of rows) {
      bytes += Buffer.byteLength(String(row.payload ?? ''), 'utf8');
      entries.push(row);
    }
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw new PackageError(
        `This update set is larger than Kaddiya packages in one file (over ${Math.round(MAX_PAYLOAD_BYTES / 1024 / 1024)} MB at ${entries.length}+ changes). Export it from the instance: Update Sets → the set → Export to XML.`,
        { code: 'too_large' },
      );
    }
    if (rows.length < PAGE) break;
    if (entries.length >= MAX_ENTRIES) {
      throw new PackageError(
        `This update set holds at least ${entries.length} changes; Kaddiya packages at most ${MAX_ENTRIES} in one file. Export it from the instance: Update Sets → the set → Export to XML.`,
        { code: 'too_many' },
      );
    }
  }
  return entries;
}

function warningsFor(set, entries) {
  const warnings = [];
  const state = stored(set.state);
  if (state !== 'complete') {
    warnings.push(`This set is "${displayed(set.state) || state}", not Complete. Anything captured after this package was built is not in it.`);
  }
  if (stored(set.parent)) {
    warnings.push('This set has a parent — it is part of a batch. The package holds this set alone; its siblings and their install order are not in it.');
  }
  if (stored(set.merged_to)) {
    warnings.push('This set has been merged into another set. Packaging the merge target is usually what you want.');
  }
  const scopes = new Set(entries.map((e) => stored(e.application) || 'global'));
  if (scopes.size > 1) {
    warnings.push(`Changes span ${scopes.size} application scopes (${[...scopes].join(', ')}). The target instance needs every one of them present.`);
  }
  return warnings;
}

// ---- the ledger ----

function ledgerFor({ set, entries, xmlBytes, sha256, instanceUrl, actor, generatedAt, warnings, stripped }) {
  const name = stored(set.name);
  const byType = new Map();
  for (const entry of entries) {
    const type = stored(entry.type) || 'Unknown';
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  const rows = entries.map((entry) => [
    stored(entry.type) || '—',
    stored(entry.target_name) || stored(entry.name) || '—',
    stored(entry.table) || '—',
    stored(entry.action) || '—',
    stored(entry.sys_updated_by) || '—',
    stored(entry.sys_updated_on) || '—',
  ]);
  const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

  return [
    `# Update set package — ${name}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Update set | ${cell(name)} |`,
    `| State | ${cell(displayed(set.state) || stored(set.state))} |`,
    `| Source instance | ${cell(instanceUrl || 'unknown')} |`,
    `| Source sys_id | \`${cell(stored(set.sys_id))}\` |`,
    `| Application | ${cell(displayed(set.application) || 'Global')} |`,
    `| Created | ${cell(stored(set.sys_created_on))} by ${cell(stored(set.sys_created_by))} |`,
    stored(set.completed_on)
      ? `| Completed | ${cell(stored(set.completed_on))}${stored(set.completed_by) ? ` by ${cell(stored(set.completed_by))}` : ''} |`
      : null,
    `| Changes | ${entries.length} |`,
    `| Package size | ${Math.max(1, Math.round(xmlBytes / 1024))} KB |`,
    `| SHA-256 | \`${sha256}\` |`,
    `| Packaged | ${cell(generatedAt)} by ${cell(actor || 'unknown')} |`,
    '',
    stored(set.description) ? `${stored(set.description)}\n` : null,
    warnings.length ? `## Before you load this\n\n${warnings.map((w) => `- ${w}`).join('\n')}\n` : null,
    stripped ? `- ${stripped} control character(s) not permitted in XML were removed from captured field values.\n` : null,
    '## What is in it',
    '',
    [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, n]) => `- ${n} × ${type}`).join('\n'),
    '',
    '| Type | Target | Table | Action | Updated by | Updated |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
    '',
    '## How to load it',
    '',
    '1. On the target instance, open **Retrieved Update Sets** (`sys_remote_update_set_list.do`).',
    '2. **Import Update Set from XML**, and choose the `.xml` file beside this ledger.',
    '3. Open the retrieved set and press **Preview Update Set**. ServiceNow compares every change',
    '   against the target and reports collisions — resolve them there, not here.',
    '4. Press **Commit Update Set** when the preview is clean.',
    '',
    'Loading a package does not change the source instance, and nothing is committed on the',
    'target until step 4. To back out, use the commit record\'s **Back Out** action.',
    '',
    '---',
    '',
    `Packaged by Kaddiya from ${instanceUrl || 'the source instance'}. The XML is a faithful copy of the`,
    'captured changes on that instance; Kaddiya read them and wrote the file, and changed nothing.',
    '',
  ].filter((line) => line !== null).join('\n');
}

// ---- the package ----

/**
 * How one of the two files is served. Separated from the route so the mapping
 * — which file, what type, what name — is checkable without a server, and so
 * both credentials (cookie and MCP bearer) answer identically.
 */
export function packageResponse(pkg, format) {
  const xml = format === 'xml';
  return {
    contentType: xml ? 'application/xml; charset=utf-8' : 'text/markdown; charset=utf-8',
    filename: xml ? pkg.filenames.xml : pkg.filenames.ledger,
    body: xml ? pkg.xml : pkg.ledger,
  };
}

/**
 * Build the package for one update set.
 *
 * @param sn        an SnClient, acting as the signed-in person
 * @param sys_id    the update set; omitted means the person's current set
 * @param actor     who asked, for the ledger
 * @returns { update_set, entries, manifest, xml, ledger, sha256, bytes, warnings, filenames }
 */
export async function buildUpdateSetPackage(sn, { sys_id, actor } = {}) {
  let setId = sys_id;
  if (!setId) {
    const current = await sn.currentUpdateSet();
    setId = current?.current?.sys_id;
    if (!setId) throw new PackageError('No update set is selected, so there is nothing to package. Name one, or select it on the instance first.', { code: 'no_set' });
  }

  const set = await readSet(sn, setId);
  if (String(stored(set.is_default)) === 'true') {
    throw new PackageError('The Default update set is the instance\'s catch-all and is not portable. Package a named set instead.', { code: 'default_set' });
  }

  const entries = await readEntries(sn, stored(set.sys_id));
  if (!entries.length) {
    throw new PackageError(`"${stored(set.name)}" has no captured changes yet, so a package would be an empty file.`, { code: 'empty' });
  }

  const counter = { stripped: 0 };
  const unloadDate = snTimestamp();
  const remote = remoteSetElement(set, { unloadDate, counter });
  const body = entries.map((entry) => entryElement(entry, remote.sysId, counter));
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<unload unload_date="${escapeAttr(unloadDate)}">`,
    remote.xml,
    ...body,
    '</unload>',
    '',
  ].join('\n');

  const bytes = Buffer.byteLength(xml, 'utf8');
  const sha256 = crypto.createHash('sha256').update(xml, 'utf8').digest('hex');
  const warnings = warningsFor(set, entries);
  const generatedAt = unloadDate;
  const instanceUrl = sn.cfg?.instanceUrl || '';

  const manifest = {
    update_set: stored(set.name),
    sys_id: stored(set.sys_id),
    state: displayed(set.state) || stored(set.state),
    application: displayed(set.application) || 'Global',
    source_instance: instanceUrl,
    changes: entries.length,
    by_type: [...entries.reduce((map, e) => {
      const type = stored(e.type) || 'Unknown';
      return map.set(type, (map.get(type) ?? 0) + 1);
    }, new Map())].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    // Enough of each change to talk about it, and no payloads: the model gets
    // the shape of the package, the person downloads the package itself.
    items: entries.map((e) => ({
      type: stored(e.type),
      target_name: stored(e.target_name),
      table: stored(e.table),
      action: stored(e.action),
      updated_by: stored(e.sys_updated_by),
      updated_on: stored(e.sys_updated_on),
    })),
    bytes,
    sha256,
    packaged_at: generatedAt,
    warnings,
  };

  const slug = (stored(set.name) || 'update-set')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'update-set';

  return {
    set,
    entries,
    manifest,
    xml,
    ledger: ledgerFor({ set, entries, xmlBytes: bytes, sha256, instanceUrl, actor, generatedAt, warnings, stripped: counter.stripped }),
    sha256,
    bytes,
    warnings,
    filenames: { xml: `${slug}.xml`, ledger: `${slug}-ledger.md` },
  };
}
