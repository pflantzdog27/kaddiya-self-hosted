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
//
// MCP tokens (ADR 0014 D2/D3) are the same mechanism for a second credential
// kind. The bearer carries a random 256-bit secret under a `kmcp_` prefix; the
// row stores SHA-256(bearer) for lookup and a ServiceNow pair — its own, from
// a second authorization-code grant, not the browser session's — sealed under
// HKDF(bearer). The bearer itself is shown once: createMcpToken seals it under
// the *minting cookie's* key into reveal_enc for five minutes, so only that
// browser can read it back and no admin ever can. D3 extends the revocation
// matrix: user revoke, admin revoke, member block, instance disconnect and an
// org-level disable all mark revoke_on_present, and the next presentation
// revokes at the issuer and deletes. Silent expiry deletes.
//
// The bearer lookup happens before the tenant is known, which is why it lives
// here — in the one module besides db.js/tenancy.js/billing.js that
// test/db-gates.test.js (e) allows to call system().

import crypto from 'node:crypto';
import { system, withOrg } from './db.js';
import { sessionKey, mcpTokenKey, sealWithKey, openWithKey } from './keys.js';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

/** `kmcp_` + 43 base64url chars from 32 random bytes: 48 chars, 256 bits (ADR 0014 D2). */
export const MCP_TOKEN_PREFIX = 'kmcp_';
export const MCP_TOKEN_LENGTH = MCP_TOKEN_PREFIX.length + 43;
const MCP_REVEAL_TTL_MS = 5 * 60 * 1000;

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
    // ADR 0014 D3: silent expiry deletes. The ciphertext goes with the row, so
    // the pair is unopenable from here on and expires on the instance's own
    // schedule — the posture sessions already have.
    await c.query(`DELETE FROM mcp_tokens WHERE expires_at <= now()`);
    await c.query(`UPDATE mcp_tokens SET reveal_enc = NULL, reveal_expires_at = NULL WHERE reveal_expires_at <= now()`);
  });
}

// ---- OAuth state (PKCE verifier + browser binding), pending for ten minutes ----

export async function createOAuthState({ orgId, instanceId, purpose, verifier, binding, meta }) {
  const state = newSecret(24);
  await system((c) => c.query(
    `INSERT INTO oauth_states (state, org_id, instance_id, purpose, verifier, binding, meta, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::bigint || ' milliseconds')::interval)`,
    [state, orgId, instanceId, purpose, verifier, binding, meta ? JSON.stringify(meta) : null, String(OAUTH_STATE_TTL_MS)],
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

// ---- MCP tokens (ADR 0014 D2/D3): the bearer is the key ----

const hashBearer = (bearer) => crypto.createHash('sha256').update(bearer).digest();
const mcpAadFor = (tokenHash) => `mcp:${tokenHash.toString('hex')}`;
const revealAadFor = (id) => `mcp-reveal:${id}`;

/** Cheap shape check before the database is touched: 48 chars behind `kmcp_`. */
function wellFormedBearer(bearer) {
  return typeof bearer === 'string'
    && bearer.length === MCP_TOKEN_LENGTH
    && bearer.startsWith(MCP_TOKEN_PREFIX)
    && /^[A-Za-z0-9_-]+$/.test(bearer.slice(MCP_TOKEN_PREFIX.length));
}

/**
 * Mint a bearer for one person on one instance, seal the ServiceNow pair
 * under it, and seal the bearer itself under the minting browser's cookie
 * key for a single five-minute reveal. The plaintext bearer is returned to
 * the caller once and stored nowhere.
 */
export async function createMcpToken({ orgId, instanceId, memberId, userSysId, user, label, tokens, ttlMs, clampedBy, revealFor }) {
  const bearer = MCP_TOKEN_PREFIX + newSecret(32);
  const tokenHash = hashBearer(bearer);
  const enc = sealWithKey(mcpTokenKey(bearer), mcpAadFor(tokenHash), JSON.stringify(tokens));
  const id = crypto.randomUUID();
  const reveal = revealFor ? sealWithKey(sessionKey(revealFor), revealAadFor(id), bearer) : null;
  await system((c) => c.query(
    `INSERT INTO mcp_tokens (id, token_hash, token_prefix, org_id, instance_id, member_id, sn_user_sys_id, user_json,
                             label, tokens_enc, clamped_by, reveal_enc, reveal_expires_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             CASE WHEN $12::bytea IS NULL THEN NULL ELSE now() + ($13::bigint || ' milliseconds')::interval END,
             now() + ($14::bigint || ' milliseconds')::interval)`,
    [id, tokenHash, bearer.slice(0, 12), orgId, instanceId, memberId, userSysId,
      user ? JSON.stringify(user) : null, label, enc, clampedBy || null, reveal, String(MCP_REVEAL_TTL_MS), String(ttlMs)],
  ));
  return { id, bearer, tokenHash };
}

/**
 * Resolve a bearer to a live MCP token, or undefined. The one directory read
 * on the /mcp path: everything after it is withOrg. A row marked
 * revoke_on_present is deleted here and returned with `revoked: true` and its
 * tokens, exactly as lookupSession does, so the caller revokes at the issuer.
 */
export async function lookupMcpToken(bearer) {
  if (!wellFormedBearer(bearer)) return undefined;
  const tokenHash = hashBearer(bearer);
  const { rows } = await system((c) => c.query(`SELECT * FROM mcp_tokens WHERE token_hash = $1`, [tokenHash]));
  const row = rows[0];
  if (!row) return undefined;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await deleteMcpByHash(tokenHash);
    return undefined;
  }

  let tokens;
  try {
    tokens = JSON.parse(openWithKey(mcpTokenKey(bearer), mcpAadFor(tokenHash), row.tokens_enc));
  } catch {
    await deleteMcpByHash(tokenHash);
    return undefined;
  }

  if (row.revoke_on_present) {
    await deleteMcpByHash(tokenHash);
    return { revoked: true, tokens, id: row.id, orgId: row.org_id, instanceId: row.instance_id };
  }

  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > TOUCH_INTERVAL_MS) {
    system((c) => c.query(`UPDATE mcp_tokens SET last_used_at = now() WHERE token_hash = $1`, [tokenHash])).catch(() => {});
  }

  return {
    id: row.id,
    tokenHash,
    orgId: row.org_id,
    instanceId: row.instance_id,
    memberId: row.member_id,
    userSysId: row.sn_user_sys_id,
    user: row.user_json,
    label: row.label,
    tokens,
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
    /** Re-seal after a refresh. Same bearer, same key. */
    async saveTokens(next) {
      this.tokens = next;
      const enc = sealWithKey(mcpTokenKey(bearer), mcpAadFor(tokenHash), JSON.stringify(next));
      await system((c) => c.query(`UPDATE mcp_tokens SET tokens_enc = $2 WHERE token_hash = $1`, [tokenHash, enc]));
    },
  };
}

async function deleteMcpByHash(tokenHash) {
  await system((c) => c.query(`DELETE FROM mcp_tokens WHERE token_hash = $1`, [tokenHash]));
}

/**
 * The one showing. Only the browser that minted the token can open
 * reveal_enc, because it is sealed under that cookie's key; the column is
 * nulled in the same statement, so a second call — and an admin, who has no
 * path here at all — gets nothing.
 */
export async function revealMcpToken(id, sid) {
  if (!id || !sid || !/^[0-9a-f-]{36}$/.test(String(id))) return null;
  const { rows } = await system((c) => c.query(
    `SELECT * FROM mcp_tokens WHERE id = $1 AND reveal_enc IS NOT NULL AND reveal_expires_at > now()`, [id],
  ));
  const row = rows[0];
  if (!row) return null;
  let bearer;
  try {
    bearer = openWithKey(sessionKey(sid), revealAadFor(row.id), row.reveal_enc);
  } catch {
    return null; // another browser's cookie: the AAD and the key both refuse
  }
  await system((c) => c.query(`UPDATE mcp_tokens SET reveal_enc = NULL, reveal_expires_at = NULL WHERE id = $1`, [id]));
  return {
    bearer,
    label: row.label,
    expiresAt: new Date(row.expires_at).getTime(),
    instanceId: row.instance_id,
    clampedBy: row.clamped_by || null,
  };
}

/**
 * What the profile panel and the admin table show: metadata only. The bearer
 * is not here to be listed, and `tokens_enc` cannot be opened without it.
 * withOrg, so the org wall applies even without a WHERE org_id.
 */
export async function listMcpTokens(ctx, memberId) {
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(
    `SELECT id, token_prefix, instance_id, member_id, sn_user_sys_id, user_json, label, minted_via, clamped_by,
            revoke_on_present, created_at, last_used_at, expires_at,
            (reveal_enc IS NOT NULL AND reveal_expires_at > now()) AS revealable
       FROM mcp_tokens
      WHERE ($1::uuid IS NULL OR member_id = $1::uuid)
      ORDER BY created_at DESC`,
    [memberId || null],
  ));
  return rows.map((r) => ({
    id: r.id,
    prefix: r.token_prefix,
    instance_id: r.instance_id,
    member_id: r.member_id,
    user_name: r.user_json?.user_name || r.sn_user_sys_id,
    label: r.label,
    minted_via: r.minted_via,
    clamped_by: r.clamped_by || null,
    revoked: r.revoke_on_present,
    revealable: r.revealable,
    created_at: new Date(r.created_at).toISOString(),
    last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    expires_at: new Date(r.expires_at).toISOString(),
  }));
}

/**
 * Mark for revocation (D3). Nothing is revoked at the issuer here: the server
 * cannot open the pair without the bearer, so the revocation happens on the
 * next presentation — and if the token is never presented again, the pair
 * expires on the instance's own schedule. `memberId` scopes the mark to one
 * person's own tokens; an admin passes none.
 */
export async function revokeMcpToken(ctx, id, memberId) {
  if (!/^[0-9a-f-]{36}$/.test(String(id || ''))) return false;
  const { rows } = await withOrg(ctx.orgId, (c) => c.query(
    `UPDATE mcp_tokens SET revoke_on_present = true
      WHERE id = $1 AND ($2::uuid IS NULL OR member_id = $2::uuid) RETURNING id`,
    [id, memberId || null],
  ));
  return rows.length > 0;
}

