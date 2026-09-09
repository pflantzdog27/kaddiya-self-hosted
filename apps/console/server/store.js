// Conversation persistence in Postgres, scoped to (org, instance, user)
// (ADR 0008 D5/D7). Index fields stay plaintext; the message bodies — which
// carry instance data — are one encrypted blob under the org key.
//
// Every function takes a `scope`: { ctx: OrgContext, instanceId, userSysId }.
// The tenant is pinned by withOrg() from ctx; the user and instance filters
// are ordinary WHERE clauses on top of that wall.

import crypto from 'node:crypto';
import { withOrg } from './db.js';

const COLUMN = 'conversations.body';
const META = 'id, title, pinned, turns, created_at, updated_at';

function titleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New chat';
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

function meta(row) {
  return {
    id: row.id,
    title: row.title,
    pinned: !!row.pinned,
    turns: row.turns,
    created: new Date(row.created_at).toISOString(),
    updated: new Date(row.updated_at).toISOString(),
  };
}

export async function createConversation(scope) {
  const id = crypto.randomUUID();
  const { rows } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `INSERT INTO conversations (id, org_id, instance_id, sn_user_sys_id, body_enc)
     VALUES ($1, current_setting('app.org_id')::uuid, $2, $3, $4) RETURNING ${META}`,
    [id, scope.instanceId, scope.userSysId, scope.ctx.encrypt(COLUMN, '[]')],
  ));
  return { ...meta(rows[0]), messages: [] };
}

export async function getConversation(scope, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
  const { rows } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `SELECT ${META}, body_enc FROM conversations WHERE id = $1 AND instance_id = $2 AND sn_user_sys_id = $3`,
    [id, scope.instanceId, scope.userSysId],
  ));
  const row = rows[0];
  if (!row) return null;
  let body;
  try {
    body = JSON.parse(scope.ctx.decrypt(COLUMN, row.body_enc));
  } catch {
    return null; // wrong key or tampered blob: treat as absent, never as someone else's
  }
  // v1 bodies are a bare message array; v2 (ADR 0011) is { messages, run }.
  const messages = Array.isArray(body) ? body : Array.isArray(body?.messages) ? body.messages : [];
  const run = Array.isArray(body) ? null : body?.run || null;
  return { ...meta(row), messages, run };
}

export async function saveConversation(scope, conv) {
  const messages = Array.isArray(conv.messages) ? conv.messages : [];
  let title = conv.title;
  if ((!title || title === 'New chat') && messages.length) {
    const first = messages.find((m) => m.role === 'user' && typeof m.content === 'string');
    if (first) title = titleFrom(first.content);
  }
  const turns = messages.filter((m) => m.role === 'user' && typeof m.content === 'string').length;
  if (!title || title === 'New chat') {
    if (conv.run?.goal) title = titleFrom(`Run: ${conv.run.goal}`);
  }
  const body = conv.run ? { v: 2, messages, run: conv.run } : messages;
  const { rows } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `UPDATE conversations SET title = $4, turns = $5, body_enc = $6, updated_at = now()
      WHERE id = $1 AND instance_id = $2 AND sn_user_sys_id = $3 RETURNING ${META}`,
    [conv.id, scope.instanceId, scope.userSysId, title || 'New chat', turns, scope.ctx.encrypt(COLUMN, JSON.stringify(body))],
  ));
  if (!rows[0]) throw new Error('conversation not found');
  return { ...meta(rows[0]), messages, run: conv.run || null };
}

/** Listing metadata only — never decrypts a body. */
export async function listConversations(scope) {
  const { rows } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `SELECT ${META} FROM conversations WHERE instance_id = $1 AND sn_user_sys_id = $2 ORDER BY updated_at DESC LIMIT 200`,
    [scope.instanceId, scope.userSysId],
  ));
  return rows.map(meta);
}

export async function updateConversation(scope, id, patch) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
  const sets = [];
  const values = [id, scope.instanceId, scope.userSysId];
  if (typeof patch.pinned === 'boolean') {
    values.push(patch.pinned);
    sets.push(`pinned = $${values.length}`);
  }
  if (typeof patch.title === 'string' && patch.title.trim()) {
    values.push(patch.title.trim().slice(0, 120));
    sets.push(`title = $${values.length}`);
  }
  const query = sets.length
    ? `UPDATE conversations SET ${sets.join(', ')} WHERE id = $1 AND instance_id = $2 AND sn_user_sys_id = $3 RETURNING ${META}`
    : `SELECT ${META} FROM conversations WHERE id = $1 AND instance_id = $2 AND sn_user_sys_id = $3`;
  const { rows } = await withOrg(scope.ctx.orgId, (c) => c.query(query, values));
  return rows[0] ? meta(rows[0]) : null;
}

export async function deleteConversation(scope, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return false;
  const { rowCount } = await withOrg(scope.ctx.orgId, (c) => c.query(
    `DELETE FROM conversations WHERE id = $1 AND instance_id = $2 AND sn_user_sys_id = $3`,
    [id, scope.instanceId, scope.userSysId],
  ));
  return rowCount > 0;
}
