// The commit functions behind the action catalog — one implementation per
// catalog entry, two callers (ADR 0011 D3):
//
//   1. the human-click endpoints in index.js (a card's button), and
//   2. plan-approved runs, where the server commits each proposal the agent
//      makes on the approving user's own token, on a non-production instance,
//      because that person approved the plan (ADR 0011 D3, conditions 1–4).
//
// Both callers pass the same deps: the signed-in user's instance client and
// an audit sink already scoped to that user. Neither path can reach a table
// or field the catalog does not list; the allow-lists live here, next to the
// write, so a card cannot talk its way past them and neither can a plan.
//
// This module is pure of HTTP: it throws CommitError with a status the
// endpoint maps to a response, and it never sees a session or a request.

import vm from 'node:vm';
import { ARTIFACT_TABLES } from './sn.js';
import { TASK_TABLES, TASK_FIELDS, CHANGE_TYPES, CHANGE_FIELDS, actionById } from './actions.js';

export class CommitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new CommitError(400, message);

/**
 * A script that will not parse will not save on the instance either, and the
 * developer would see the failure only after clicking. Compile it first
 * (`vm.Script` parses; it never runs). ServiceNow server scripts are ES5-ish
 * JavaScript; anything the Node parser rejects, Rhino rejects too.
 */
export function checkScript(source, label = 'script') {
  if (typeof source !== 'string' || !source.trim()) return null;
  try {
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename: `${label}.js` });
    return null;
  } catch (err) {
    return `${label} does not parse: ${err.message}`;
  }
}

const SCRIPT_FIELDS = ['script', 'condition', 'client_script', 'script_plain', 'link'];

export function scriptProblems(fields) {
  const problems = [];
  for (const f of SCRIPT_FIELDS) {
    if (typeof fields?.[f] !== 'string' || fields[f].length < 20) continue;
    const problem = checkScript(fields[f], f);
    if (problem) problems.push(problem);
  }
  // A Service Portal widget's option schema is JSON; the instance rejects
  // anything else at save time, so refuse it here for the same reason.
  if (typeof fields?.option_schema === 'string' && fields.option_schema.trim()) {
    try { JSON.parse(fields.option_schema); } catch (err) { problems.push(`option_schema is not valid JSON: ${err.message}`); }
  }
  return problems;
}

// Every commit: (deps, body) → the JSON the endpoint answers with.
// deps = { sn, audit }: the user's instance client, and an audit sink that
// already carries the user and (for a plan) the run.
const COMMITS = {
  'journal.append': async ({ sn, audit }, body) => {
    const { table, sys_id, field, text } = body || {};
    if (!table || !sys_id || !text) throw bad('table, sys_id and text are required');
    if (!['comments', 'work_notes'].includes(field)) throw bad('field must be comments or work_notes');
    try {
      const result = await sn.addJournalEntry({ table, sys_id, field, text: String(text) });
      await audit({ action: 'write', table, sys_id, field, chars: String(text).length, approved_by_user: true });
      return { ok: true, record: result };
    } catch (err) {
      await audit({ action: 'write_failed', table, sys_id, field, error: String(err.message) });
      throw new CommitError(502, String(err.message));
    }
  },

  'config.create': async ({ sn, audit }, body) => {
    const { table, fields } = body || {};
    if (!table || !fields || typeof fields !== 'object') throw bad('table and fields are required');
    if (!ARTIFACT_TABLES[table]) throw bad(`table must be one of: ${Object.keys(ARTIFACT_TABLES).join(', ')}`);
    const problems = scriptProblems(fields);
    if (problems.length) throw bad(problems.join('; '));
    try {
      const created = await sn.createArtifact({ table, fields });
      const set = await sn.currentUpdateSet().catch(() => ({ current: null }));
      await audit({ action: 'artifact_create', table, sys_id: created.sys_id, update_set: set.current?.name || null, approved_by_user: true });
      return { ok: true, created, update_set: set.current || null };
    } catch (err) {
      if (err instanceof CommitError) throw err;
      await audit({ action: 'artifact_create_failed', table, error: String(err.message) });
      throw new CommitError(502, String(err.message));
    }
  },

  'update_set.create': async ({ sn, audit }, body) => {
    const name = String(body?.name || '').trim().slice(0, 80);
    const description = String(body?.description || '').slice(0, 1000);
    if (!name) throw bad('name is required');
    try {
      const result = await sn.createUpdateSet({ name, description });
      await audit({ action: 'update_set_create', name, sys_id: result.created?.sys_id, approved_by_user: true });
      return { ok: true, ...result };
    } catch (err) {
      await audit({ action: 'update_set_create_failed', name, error: String(err.message) });
      throw new CommitError(502, String(err.message));
    }
  },

  'task.update': async ({ sn, audit }, body) => {
    const { table, sys_id, fields } = body || {};
    if (!table || !sys_id || !fields || typeof fields !== 'object') throw bad('table, sys_id and fields are required');
    if (!TASK_TABLES.includes(table)) throw bad(`table must be one of: ${TASK_TABLES.join(', ')}`);
    const notAllowed = Object.keys(fields).filter((f) => !TASK_FIELDS.includes(f));
    if (notAllowed.length) throw bad(`fields not allowed: ${notAllowed.join(', ')} — only ${TASK_FIELDS.join(', ')}`);
    try {
      const record = await sn.updateRecord({ table, sys_id, fields });
      await audit({ action: 'task_update', table, sys_id, fields: Object.keys(fields), approved_by_user: true });
      return { ok: true, record };
    } catch (err) {
      await audit({ action: 'task_update_failed', table, sys_id, error: String(err.message) });
      throw new CommitError(502, String(err.message));
    }
  },

  'approval.decide': async ({ sn, audit }, body) => {
    const { sys_id, decision } = body || {};
    const comments = String(body?.comments || '').slice(0, 4000);
    if (!sys_id || !decision) throw bad('sys_id and decision are required');
    if (!['approved', 'rejected'].includes(decision)) throw bad('decision must be approved or rejected');
    try {
      const record = await sn.decideApproval({ sys_id, decision, comments });
      await audit({ action: 'approval_decide', table: 'sysapproval_approver', sys_id, decision, approved_by_user: true });
      return { ok: true, record };
    } catch (err) {
      await audit({ action: 'approval_decide_failed', sys_id, decision, error: String(err.message) });
      throw new CommitError(502, String(err.message));
    }
  },

  'config.update': async ({ sn, audit }, body) => {
    const { table, sys_id, fields } = body || {};
    if (!table || !sys_id || !fields || typeof fields !== 'object') throw bad('table, sys_id and fields are required');
    if (!ARTIFACT_TABLES[table]) throw bad(`table must be one of: ${Object.keys(ARTIFACT_TABLES).join(', ')}`);
    const problems = scriptProblems(fields);
    if (problems.length) throw bad(problems.join('; '));
    try {
      const updated = await sn.updateArtifact({ table, sys_id, fields });
      const set = await sn.currentUpdateSet().catch(() => ({ current: null }));
      await audit({ action: 'artifact_update', table, sys_id, fields: Object.keys(fields), update_set: set.current?.name || null, approved_by_user: true });
      return { ok: true, updated, update_set: set.current || null };
    } catch (err) {
      if (err instanceof CommitError) throw err;
      await audit({ action: 'artifact_update_failed', table, sys_id, error: String(err.message) });
      throw new CommitError(502, String(err.message));
    }
  },

  'catalog.order': async ({ sn, audit }, body) => {
    const { item_sys_id, variables, requested_for } = body || {};
    if (!item_sys_id) throw bad('item_sys_id is required');
    try {
      const result = await sn.orderItem({ item_sys_id, variables, requested_for });
      await audit({ action: 'catalog_order', table: 'sc_request', sys_id: result.request_id, item: item_sys_id, approved_by_user: true });
      return { ok: true, ...result };
    } catch (err) {
      await audit({ action: 'catalog_order_failed', item: item_sys_id, error: String(err.message) });
      throw new CommitError(502, String(err.message));
    }
  },

  'change.create': async ({ sn, audit }, body) => {
    const { type, template_sys_id, fields } = body || {};
    if (!CHANGE_TYPES.includes(type)) throw bad(`type must be one of: ${CHANGE_TYPES.join(', ')}`);
    if (!fields || typeof fields !== 'object') throw bad('fields are required');
    const notAllowed = Object.keys(fields).filter((f) => !CHANGE_FIELDS.includes(f));
    if (notAllowed.length) throw bad(`fields not allowed: ${notAllowed.join(', ')}`);
    try {
      const created = await sn.createChange({ type, template_sys_id, fields });
      await audit({ action: 'change_create', table: 'change_request', sys_id: created.sys_id, change_type: type, approved_by_user: true });
      return { ok: true, created };
    } catch (err) {
      await audit({ action: 'change_create_failed', change_type: type, error: String(err.message) });
      throw new CommitError(502, String(err.message));
    }
  },
};

/** The commit for a catalog action id. Throws on an id the catalog lacks. */
export async function commit(actionId, deps, body) {
  const fn = COMMITS[actionId];
  if (!fn || !actionById(actionId)) throw new CommitError(404, `unknown action ${actionId}`);
  return fn(deps, body);
}

/** Every action id that has a commit — must equal the catalog (pinned by test). */
export function committableActions() {
  return Object.keys(COMMITS).sort();
}
