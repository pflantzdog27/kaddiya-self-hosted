// Token custody (ADR 0008 D8): the cookie is the key. The gate for Phase 1
// is literal — dump the sessions table and find zero usable tokens — and a
// restart (a fresh pool) loses no sessions.

import { resetDb, close, seedOrg } from './helpers/db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { system, close as closePool } from '../server/db.js';
import * as sessions from '../server/sessions.js';

before(resetDb);
after(close);

const TOKENS = { accessToken: 'ACCESS-TOKEN-PLAINTEXT-9f8e7d', refreshToken: 'REFRESH-TOKEN-PLAINTEXT-1a2b3c', expiresAt: Date.now() + 1800_000 };

test('a session round-trips through the cookie and survives a pool restart', async () => {
  const org = await seedOrg('custody');
  const sid = await sessions.createSession({
    orgId: org.org.id, instanceId: org.instance.id, memberId: org.ownerMember.id,
    userSysId: org.owner.sys_id, user: org.owner, tokens: TOKENS, ttlMs: 60_000,
  });

  await closePool(); // "restart": nothing in memory survives
  const found = await sessions.lookupSession(sid);
  assert.ok(found, 'session found after restart');
  assert.deepEqual(found.tokens, TOKENS);
  assert.equal(found.orgId, org.org.id);
  assert.equal(found.user.user_name, org.owner.user_name);
});

test('a dump of the sessions table contains no usable token', async () => {
  const { rows } = await system((c) => c.query('SELECT sid_hash, tokens_enc, user_json::text AS user_json FROM sessions'));
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    const dump = Buffer.concat([row.sid_hash, row.tokens_enc, Buffer.from(row.user_json || '')]).toString('latin1');
    assert.doesNotMatch(dump, /ACCESS-TOKEN-PLAINTEXT/, 'access token visible in the row');
    assert.doesNotMatch(dump, /REFRESH-TOKEN-PLAINTEXT/, 'refresh token visible in the row');
  }
});

test('a wrong cookie, a tampered cookie and an unknown cookie all resolve to nothing', async () => {
  const org = await seedOrg('wrongcookie');
  const sid = await sessions.createSession({ orgId: org.org.id, instanceId: org.instance.id, userSysId: 'u', user: {}, tokens: TOKENS, ttlMs: 60_000 });
  assert.equal(await sessions.lookupSession(sid.slice(0, -1) + (sid.endsWith('A') ? 'B' : 'A')), undefined);
  assert.equal(await sessions.lookupSession('short'), undefined);
  assert.equal(await sessions.lookupSession(sessions.newSecret(32)), undefined);
  assert.ok(await sessions.lookupSession(sid));
});

test('expiry is absolute: an expired row is deleted on presentation', async () => {
  const org = await seedOrg('expiry');
  const sid = await sessions.createSession({ orgId: org.org.id, instanceId: org.instance.id, userSysId: 'u', user: {}, tokens: TOKENS, ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await sessions.lookupSession(sid), undefined);
  const { rows } = await system((c) => c.query('SELECT 1 FROM sessions WHERE org_id = $1', [org.org.id]));
  assert.equal(rows.length, 0, 'the expired row is gone');
});

test('revoke-on-present hands the tokens back once, then the row is gone', async () => {
  const org = await seedOrg('revoke');
  const sid = await sessions.createSession({ orgId: org.org.id, instanceId: org.instance.id, memberId: org.ownerMember.id, userSysId: 'u', user: {}, tokens: TOKENS, ttlMs: 60_000 });
  await system((c) => c.query('UPDATE sessions SET revoke_on_present = true WHERE org_id = $1', [org.org.id]));
  const first = await sessions.lookupSession(sid);
  assert.equal(first.revoked, true);
  assert.equal(first.tokens.accessToken, TOKENS.accessToken, 'the caller gets the tokens to revoke at the issuer');
  assert.equal(await sessions.lookupSession(sid), undefined);
});

test('a refreshed token is re-sealed under the same cookie', async () => {
  const org = await seedOrg('refresh');
  const sid = await sessions.createSession({ orgId: org.org.id, instanceId: org.instance.id, userSysId: 'u', user: {}, tokens: TOKENS, ttlMs: 60_000 });
  const s = await sessions.lookupSession(sid);
  await s.saveTokens({ ...TOKENS, accessToken: 'ACCESS-TOKEN-ROTATED' });
  assert.equal((await sessions.lookupSession(sid)).tokens.accessToken, 'ACCESS-TOKEN-ROTATED');
  const tokens = await sessions.destroySession(sid);
  assert.equal(tokens.accessToken, 'ACCESS-TOKEN-ROTATED', 'logout returns the tokens for issuer-side revocation');
  assert.equal(await sessions.lookupSession(sid), undefined);
});

test('OAuth state is one-shot and browser-bound', async () => {
  const org = await seedOrg('oauthstate');
  const state = await sessions.createOAuthState({ orgId: org.org.id, instanceId: org.instance.id, purpose: 'signin', verifier: 'v', binding: 'b' });
  const row = await sessions.consumeOAuthState(state);
  assert.equal(row.purpose, 'signin');
  assert.equal(row.binding, 'b');
  assert.equal(await sessions.consumeOAuthState(state), null, 'a state cannot be consumed twice');
});
