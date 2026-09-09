// Append-only audit in Postgres (ADR 0008 D16, first cut). The app role has
// UPDATE and DELETE revoked on audit_events, so a row written here cannot be
// edited or removed through the console. Index fields (who, what, which
// table, which record) are plaintext; the rest of the entry — tool inputs
// carry encoded queries, which carry names and case data — is encrypted
// under the org key.
//
// Hash-chaining per sealed partition and external anchoring are Phase 6.

import { withOrg } from './db.js';

const COLUMN = 'audit_events.payload';

/** Never throws: audit must not break a turn. */
export async function audit(scope, entry) {
  try {
    const { user, action, table, sys_id, conversation, approved_by_user, ...rest } = entry || {};
    const payload = Object.keys(rest).length ? scope.ctx.encrypt(COLUMN, JSON.stringify(rest)) : null;
    await withOrg(scope.ctx.orgId, (c) => c.query(
      `INSERT INTO audit_events (org_id, instance_id, user_name, action, table_name, sys_id, conversation_id, approved_by_user, payload_enc)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8)`,
      [scope.instanceId || null, user || null, String(action || (rest.tool ? 'tool_call' : 'activity')).slice(0, 64), table || null, sys_id || null,
        conversation && /^[0-9a-f-]{36}$/.test(String(conversation)) ? conversation : null,
        approved_by_user == null ? null : !!approved_by_user, payload],
    ));
  } catch (err) {
    console.error('audit write failed:', err.message);
  }
}

export async function listAudit(scope, { limit = 100, before } = {}) {
  const cursor = /^\d{1,20}$/.test(String(before || '')) ? String(before) : null;
  const { rows } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `SELECT id, instance_id, ts, user_name, action, table_name, sys_id, conversation_id, approved_by_user, payload_enc
       FROM audit_events WHERE ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $1`,
    [Math.max(1, Math.min(Number(limit) || 100, 100)), cursor],
  ));
  return rows.map((r) => {
    let payload = null;
    if (r.payload_enc) {
      try { payload = JSON.parse(scope.ctx.decrypt(COLUMN, r.payload_enc)); } catch { payload = null; }
    }
    return {
      id: String(r.id),
      ts: new Date(r.ts).toISOString(),
      instance_id: r.instance_id,
      user: r.user_name,
      action: r.action === 'unknown' ? (payload?.tool ? 'tool_call' : 'activity') : r.action,
      table: r.table_name,
      sys_id: r.sys_id,
      conversation: r.conversation_id,
      approved_by_user: r.approved_by_user,
      ...(payload || {}),
    };
  });
}
