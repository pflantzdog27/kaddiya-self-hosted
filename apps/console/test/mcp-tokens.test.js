// MCP-token custody and revocation (ADR 0014 D2/D3), the sessions.test.js
// gate applied to the second credential kind: dump the mcp_tokens table and
// find zero usable tokens — neither the ServiceNow pair nor the bearer — and
// prove every row of the revocation matrix marks what it says it marks.

import { resetDb, close, seedOrg } from './helpers/db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { system, close as closePool } from '../server/db.js';
import * as sessions from '../server/sessions.js';
import * as tenancy from '../server/tenancy.js';

before(resetDb);
after(close);

const TOKENS = { accessToken: 'MCP-ACCESS-PLAINTEXT-4d5e6f', refreshToken: 'MCP-REFRESH-PLAINTEXT-7a8b9c', expiresAt: Date.now() + 1800_000 };

const mint = (org, extra = {}) => sessions.createMcpToken({
  orgId: org.org.id,
  instanceId: org.instance.id,
  memberId: org.ownerMember.id,
  userSysId: org.owner.sys_id,
  user: org.owner,
  label: 'claude-code laptop',
  tokens: TOKENS,
  ttlMs: 60_000,
  ...extra,
});

test('a token round-trips through the bearer and survives a pool restart', async () => {
  const org = await seedOrg('mcpcustody');
  const { id, bearer } = await mint(org);
  assert.match(bearer, /^kmcp_[A-Za-z0-9_-]{43}$/, 'kmcp_ + 43 base64url characters');
  assert.equal(bearer.length, 48);

  await closePool(); // "restart": nothing in memory survives
  const found = await sessions.lookupMcpToken(bearer);
  assert.ok(found, 'token found after restart');
  assert.equal(found.id, id);
  assert.deepEqual(found.tokens, TOKENS);
  assert.equal(found.orgId, org.org.id);
  assert.equal(found.instanceId, org.instance.id);
  assert.equal(found.memberId, org.ownerMember.id);
  assert.equal(found.userSysId, org.owner.sys_id);
  assert.equal(found.user.user_name, org.owner.user_name);
  assert.equal(found.label, 'claude-code laptop');
});

test('a dump of the mcp_tokens table contains neither the pair nor the bearer', async () => {
  const org = await seedOrg('mcpdump');
  const sid = await sessions.createSession({
    orgId: org.org.id, instanceId: org.instance.id, memberId: org.ownerMember.id,
    userSysId: org.owner.sys_id, user: org.owner, tokens: TOKENS, ttlMs: 60_000,
  });
  const { bearer } = await mint(org, { revealFor: sid });

  const { rows } = await system((c) => c.query(
    `SELECT token_hash, tokens_enc, reveal_enc, token_prefix, user_json::text AS user_json FROM mcp_tokens`,
  ));
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    const dump = Buffer.concat([
      row.token_hash, row.tokens_enc, row.reveal_enc || Buffer.alloc(0),
      Buffer.from(row.token_prefix), Buffer.from(row.user_json || ''),
    ]).toString('latin1');
    assert.doesNotMatch(dump, /MCP-ACCESS-PLAINTEXT/, 'access token visible in the row');
    assert.doesNotMatch(dump, /MCP-REFRESH-PLAINTEXT/, 'refresh token visible in the row');
    // The prefix is twelve characters by design; the other 36 are never stored.
    assert.doesNotMatch(dump, new RegExp(bearer.slice(12).replace(/[-_]/g, '.')), 'the bearer is recoverable from the row');
  }
});

test('wrong, tampered, short and unknown bearers all resolve to nothing', async () => {
  const org = await seedOrg('mcpwrong');
  const { bearer } = await mint(org);
  const flipped = bearer.slice(0, -1) + (bearer.endsWith('A') ? 'B' : 'A');
  assert.equal(await sessions.lookupMcpToken(flipped), undefined, 'a tampered bearer');
  assert.equal(await sessions.lookupMcpToken(bearer.slice(0, 47)), undefined, 'a 47-character value');
  assert.equal(await sessions.lookupMcpToken(bearer.slice(5)), undefined, 'the same entropy without the prefix');
  assert.equal(await sessions.lookupMcpToken('kmcp_' + sessions.newSecret(32)), undefined, 'a well-formed unknown bearer');
  assert.equal(await sessions.lookupMcpToken(''), undefined);
  assert.equal(await sessions.lookupMcpToken(undefined), undefined);
  assert.ok(await sessions.lookupMcpToken(bearer), 'the real one still resolves');
});

test('expiry is absolute: an expired row is deleted on presentation and by purgeExpired', async () => {
  const org = await seedOrg('mcpexpiry');
  const { bearer } = await mint(org, { ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await sessions.lookupMcpToken(bearer), undefined);
  const gone = await system((c) => c.query('SELECT 1 FROM mcp_tokens WHERE org_id = $1', [org.org.id]));
  assert.equal(gone.rows.length, 0, 'the presented expired row is gone');

  const { bearer: second } = await mint(org, { ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 20));
  await sessions.purgeExpired();
  const swept = await system((c) => c.query('SELECT 1 FROM mcp_tokens WHERE org_id = $1', [org.org.id]));
  assert.equal(swept.rows.length, 0, 'the sweep deletes it without a presentation');
  assert.equal(await sessions.lookupMcpToken(second), undefined);
});

test('revoke-on-present hands the pair back once, then the row is gone', async () => {
  const org = await seedOrg('mcprevoke');
  const { id, bearer } = await mint(org);
  assert.equal(await sessions.revokeMcpToken(org.ctx, id), true);
  const first = await sessions.lookupMcpToken(bearer);
  assert.equal(first.revoked, true);
  assert.equal(first.tokens.accessToken, TOKENS.accessToken, 'the caller gets the pair to revoke at the issuer');
  assert.equal(first.tokens.refreshToken, TOKENS.refreshToken);
  assert.equal(await sessions.lookupMcpToken(bearer), undefined);
  assert.equal(await sessions.revokeMcpToken(org.ctx, id), false, 'nothing is left to revoke');
});

test("a person's revoke only reaches their own tokens", async () => {
  const org = await seedOrg('mcpownership');
  const { id } = await mint(org);
  const other = await tenancy.signinMember(org.ctx, {
    org: org.org, instance: org.instance, user: { sys_id: 'other-user', user_name: 'other' },
    sn: { async myRoleNames() { return ['itil']; } },
  });
  assert.equal(await sessions.revokeMcpToken(org.ctx, id, other.id), false, 'scoped to the wrong member');
  assert.equal(await sessions.revokeMcpToken(org.ctx, id, org.ownerMember.id), true, 'scoped to the owner');
});

test('a refreshed pair is re-sealed under the same bearer', async () => {
  const org = await seedOrg('mcprefresh');
  const { bearer } = await mint(org);
  const row = await sessions.lookupMcpToken(bearer);
  await row.saveTokens({ ...TOKENS, accessToken: 'MCP-ACCESS-ROTATED' });
  assert.equal((await sessions.lookupMcpToken(bearer)).tokens.accessToken, 'MCP-ACCESS-ROTATED');
});

test('the reveal opens once, under the minting cookie only, and not after five minutes', async () => {
  const org = await seedOrg('mcpreveal');
  const make = () => sessions.createSession({
    orgId: org.org.id, instanceId: org.instance.id, memberId: org.ownerMember.id,
    userSysId: org.owner.sys_id, user: org.owner, tokens: TOKENS, ttlMs: 60_000,
  });
  const sid = await make();
  const otherSid = await make();
  const { id, bearer } = await mint(org, { revealFor: sid });

  assert.equal(await sessions.revealMcpToken(id, otherSid), null, 'another browser opens nothing');
  const revealed = await sessions.revealMcpToken(id, sid);
  assert.equal(revealed.bearer, bearer, 'the minting browser gets the bearer back');
  assert.equal(revealed.label, 'claude-code laptop');
  assert.equal(revealed.clampedBy, null, 'nothing shortened this one');
  assert.equal(await sessions.revealMcpToken(id, sid), null, 'a second call gets nothing');
  assert.ok(await sessions.lookupMcpToken(bearer), 'the token itself still works');

  // The five-minute window, checked by moving the row's own clock back.
  const { id: staleId } = await mint(org, { revealFor: sid });
  await system((c) => c.query(`UPDATE mcp_tokens SET reveal_expires_at = now() - interval '1 second' WHERE id = $1`, [staleId]));
  assert.equal(await sessions.revealMcpToken(staleId, sid), null, 'the window has closed');
  await sessions.purgeExpired();
  const swept = await system((c) => c.query('SELECT reveal_enc FROM mcp_tokens WHERE id = $1', [staleId]));
  assert.equal(swept.rows[0].reveal_enc, null, 'the sweep clears a stale reveal without deleting the token');
});

test('block, disconnect and an org-level disable each mark the right rows and no other org (D3)', async () => {
  const a = await seedOrg('mcpmatrix-a');
  const b = await seedOrg('mcpmatrix-b');
  const aToken = await mint(a);
  const bToken = await mint(b);
  const marked = async (bearer) => (await sessions.lookupMcpToken(bearer))?.revoked === true;
  const fresh = async (org, from) => (await mint(org, from || {})).bearer;

  // Blocking a member.
  await tenancy.setMember(a.ctx, a.ownerMember.id, { status: 'blocked' });
  assert.equal(await marked(aToken.bearer), true, 'the blocked member’s token is marked');
  assert.equal(await marked(bToken.bearer), false, "another org's token is untouched");
  await tenancy.setMember(a.ctx, a.ownerMember.id, { status: 'active', actor: 'test' });

  // Disconnecting the instance.
  const aSecond = await fresh(a);
  await tenancy.disconnectInstance(a.ctx, a.instance.id);
  assert.equal(await marked(aSecond), true, 'the disconnected instance’s token is marked');
  assert.equal(await marked(bToken.bearer), false, "another org's token is untouched");

  // Turning MCP off for the org.
  const bSecond = await fresh(b);
  const bThird = await fresh(b);
  await tenancy.updateOrgSettings(b.ctx, { mcp_enabled: true });
  await tenancy.updateOrgSettings(b.ctx, { mcp_enabled: false });
  assert.equal(await marked(bSecond), true, 'every token in the org is marked');
  assert.equal(await marked(bThird), true);
  const aThird = await fresh(a);
  assert.equal(await marked(aThird), false, "org A's tokens are untouched by org B's switch");
});

test('mcpTokenTtlFor clamps to the org ceiling, the code ceiling and the refresh lifespan, and names which', () => {
  const day = 24 * 60 * 60 * 1000;
  const noLimits = { mcp_token_ttl_ms: null };

  assert.deepEqual(tenancy.mcpTokenTtlFor(noLimits, 7 * day, {}), { ttlMs: 7 * day, clampedBy: null });
  assert.deepEqual(tenancy.mcpTokenTtlFor(noLimits, 0, {}), { ttlMs: tenancy.MCP_TOKEN_DEFAULT_MS, clampedBy: null }, '30 days by default');

  assert.deepEqual(
    tenancy.mcpTokenTtlFor(noLimits, 365 * day, {}),
    { ttlMs: tenancy.MCP_TOKEN_CEILING_MS, clampedBy: 'code_ceiling' },
  );
  assert.deepEqual(
    tenancy.mcpTokenTtlFor({ mcp_token_ttl_ms: day }, 30 * day, {}),
    { ttlMs: day, clampedBy: 'org_ceiling' },
  );
  // The kit's recommended 28,800 s refresh lifespan, which is the whole reason
  // this bound is recorded and explained rather than silently applied.
  assert.deepEqual(
    tenancy.mcpTokenTtlFor(noLimits, 30 * day, { refresh_token_lifespan_s: 28_800 }),
    { ttlMs: 8 * 60 * 60 * 1000, clampedBy: 'refresh_token_lifespan' },
  );
  assert.deepEqual(
    tenancy.mcpTokenTtlFor(noLimits, 30 * day, { refresh_token_lifespan_s: 60 * day / 1000 }),
    { ttlMs: 30 * day, clampedBy: null },
    'a lifespan longer than the request clamps nothing',
  );
  // The order of explanation: the tightest bound wins and is the one named.
  assert.deepEqual(
    tenancy.mcpTokenTtlFor({ mcp_token_ttl_ms: 7 * day }, 365 * day, { refresh_token_lifespan_s: 3600 }),
    { ttlMs: 3600_000, clampedBy: 'refresh_token_lifespan' },
  );
});

test('the clamp that shortened a token is recorded with it, not recomputed later', async () => {
  const org = await seedOrg('mcpclamp');
  const sid = await sessions.createSession({
    orgId: org.org.id, instanceId: org.instance.id, memberId: org.ownerMember.id,
    userSysId: org.owner.sys_id, user: org.owner, tokens: TOKENS, ttlMs: 60_000,
  });
  // As the callback mints it: eight hours out of a thirty-day request, because
  // the instance's refresh-token lifespan says so.
  const { ttlMs, clampedBy } = tenancy.mcpTokenTtlFor(org.org, 30 * 24 * 60 * 60 * 1000, { refresh_token_lifespan_s: 28_800 });
  const { id } = await mint(org, { ttlMs, clampedBy, revealFor: sid });

  const revealed = await sessions.revealMcpToken(id, sid);
  assert.equal(revealed.clampedBy, 'refresh_token_lifespan', 'the reveal names the bound that applied');
  assert.equal([...(await sessions.listMcpTokens(org.ctx))].find((t) => t.id === id).clamped_by, 'refresh_token_lifespan');

  // Raising the lifespan on the instance later does not rewrite history: this
  // token really was cut to eight hours, and the panel still says why.
  await tenancy.updateOrgSettings(org.ctx, { mcp_token_ttl_ms: null });
  const still = (await sessions.listMcpTokens(org.ctx)).find((t) => t.id === id);
  assert.equal(still.clamped_by, 'refresh_token_lifespan');
  assert.ok(new Date(still.expires_at).getTime() - Date.now() <= 8 * 60 * 60 * 1000 + 5000);
});

test('verifyInstance records the registry refresh lifespan when the read returns one', async () => {
  const { org: draft } = await tenancy.createOrgDraft({ name: 'lifespan' });
  const ctx = tenancy.contextFor(draft);
  const instance = await tenancy.addInstanceDraft(ctx, { host: 'lifespan.service-now.com', clientId: 'c'.repeat(32), clientSecret: 'secret-for-lifespan-test' });
  const sn = {
    async readOAuthEntity(clientId) {
      return { sys_id: 'e1', client_id: clientId, redirect_url: process.env.BASE_URL + '/auth/callback', refresh_token_lifespan: '28800' };
    },
    async instanceProperty() { return 'sn-lifespan'; },
  };
  const verified = await tenancy.verifyInstance(ctx, instance.id, {
    sn, user: { sys_id: 'u', user_name: 'u' }, expectedRedirect: process.env.BASE_URL + '/auth/callback',
  });
  assert.equal(verified.refresh_token_lifespan_s, 28_800);
});
