// Sessions in Postgres; ServiceNow tokens encrypted under a key derived from
// the session cookie itself (ADR 0008 D8).
//
// The cookie carries a random 256-bit secret. The row stores SHA-256(sid) for
// lookup and the tokens AES-256-GCM-sealed under HKDF(sid). Nothing on the
// server can open a token without the cookie the browser holds, so a database
// dump yields zero usable tokens and a server compromise exposes only the
// sessions presented during the window — test/sessions.test.js dumps the
// table and checks.
//
// Lifetimes are an absolute ceiling from creation (8h, org-configurable
// downward), never a sliding window. Revocation matrix: logout revokes at the
// issuer and deletes; block/disconnect marks the row revoke_on_present so the
// next request revokes and deletes; silent expiry deletes.

import crypto from 'node:crypto';
import { system } from './db.js';
import { sessionKey, sealWithKey, openWithKey } from './keys.js';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

const hashSid = (sid) => crypto.createHash('sha256').update(sid).digest();
const aadFor = (sidHash) => `session:${sidHash.toString('hex')}`;

export function newSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export async function createSession({ orgId, instanceId, memberId, userSysId, user, tokens, ttlMs }) {
  const sid = newSecret(32);
  const sidHash = hashSid(sid);
  const enc = sealWithKey(sessionKey(sid), aadFor(sidHash), JSON.stringify(tokens));
  await system((c) => c.query(
    `INSERT INTO sessions (sid_hash, org_id, instance_id, member_id, sn_user_sys_id, user_json, tokens_enc, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::bigint || ' milliseconds')::interval)`,
    [sidHash, orgId, instanceId, memberId || null, userSysId || null, user ? JSON.stringify(user) : null, enc, String(ttlMs)],
  ));
  return sid;
}

/**
 * Resolve a cookie to a live session, or undefined. A row marked
 * revoke_on_present is deleted here and returned with `revoked: true` and its
 * tokens, so the caller can revoke them at the issuer and then treat the
 * request as signed out.
 */
export async function lookupSession(sid) {
  if (!sid || sid.length < 32 || sid.length > 128) return undefined;
  const sidHash = hashSid(sid);
  const { rows } = await system((c) => c.query(`SELECT * FROM sessions WHERE sid_hash = $1`, [sidHash]));
  const row = rows[0];
  if (!row) return undefined;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await deleteByHash(sidHash);
    return undefined;
  }

  let tokens;
  try {
    tokens = JSON.parse(openWithKey(sessionKey(sid), aadFor(sidHash), row.tokens_enc));
  } catch {
    await deleteByHash(sidHash);
    return undefined;
  }

  if (row.revoke_on_present) {
    await deleteByHash(sidHash);
    return { revoked: true, tokens, orgId: row.org_id, instanceId: row.instance_id };
  }

  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
    system((c) => c.query(`UPDATE sessions SET last_seen_at = now() WHERE sid_hash = $1`, [sidHash])).catch(() => {});
  }

  return {
    sidHash,
    orgId: row.org_id,
    instanceId: row.instance_id,
    memberId: row.member_id,
    userSysId: row.sn_user_sys_id,
    user: row.user_json,
    tokens,
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
    /** Re-seal after a refresh. Same cookie, same key. */
    async saveTokens(next) {
      this.tokens = next;
      const enc = sealWithKey(sessionKey(sid), aadFor(sidHash), JSON.stringify(next));
      await system((c) => c.query(`UPDATE sessions SET tokens_enc = $2 WHERE sid_hash = $1`, [sidHash, enc]));
    },
    async saveUser(user, memberId) {
      this.user = user;
      this.memberId = memberId ?? this.memberId;
      await system((c) => c.query(
        `UPDATE sessions SET user_json = $2, member_id = COALESCE($3, member_id), sn_user_sys_id = COALESCE($4, sn_user_sys_id) WHERE sid_hash = $1`,
        [sidHash, JSON.stringify(user), memberId || null, user?.sys_id || null],
      ));
    },
  };
}

async function deleteByHash(sidHash) {
  await system((c) => c.query(`DELETE FROM sessions WHERE sid_hash = $1`, [sidHash]));
}

/** Logout: returns the tokens (for issuer-side revocation) and deletes the row. */
export async function destroySession(sid) {
  if (!sid) return null;
  const session = await lookupSession(sid).catch(() => undefined);
  await deleteByHash(hashSid(sid));
  return session?.tokens || null;
}

export async function purgeExpired() {
  await system(async (c) => {
    await c.query(`DELETE FROM sessions WHERE expires_at <= now()`);
    await c.query(`DELETE FROM oauth_states WHERE expires_at <= now()`);
    await c.query(`DELETE FROM orgs WHERE status = 'draft' AND expires_at <= now()`);
  });
}

// ---- OAuth state (PKCE verifier + browser binding), pending for ten minutes ----

export async function createOAuthState({ orgId, instanceId, purpose, verifier, binding }) {
  const state = newSecret(24);
  await system((c) => c.query(
    `INSERT INTO oauth_states (state, org_id, instance_id, purpose, verifier, binding, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::bigint || ' milliseconds')::interval)`,
    [state, orgId, instanceId, purpose, verifier, binding, String(OAUTH_STATE_TTL_MS)],
  ));
  return state;
}

/** One-shot: the row is deleted whether or not it was still valid. */
export async function consumeOAuthState(state) {
  if (!state || typeof state !== 'string' || state.length > 128) return null;
  const { rows } = await system((c) => c.query(`DELETE FROM oauth_states WHERE state = $1 RETURNING *`, [state]));
  const row = rows[0];
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}
