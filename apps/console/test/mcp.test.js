// The MCP surface (ADR 0014): what a tool call does, and what the endpoint
// refuses.
//
// Two halves, in this order for one reason: a local workspace is a single
// embedded database that one process at a time may open. The module-level
// tests run first, against the test process's own pool; the HTTP test then
// closes that pool, boots server/index.js as a child (the self-hosted.test.js
// pattern), drives it over real HTTP, stops it, and reopens the pool to read
// the audit rows the child wrote. Every state change in between goes through
// the console's own admin endpoints, which is where an admin would make it.
//
// The instance host is kaddiya-test.invalid, so no instance call can ever
// succeed — which is the point for the tool-call tests: the failure proves the
// request went all the way through executeTool and SnClient to a DNS lookup,
// and came back as a tool error with an audit row behind it.

import { resetDb, close, seedOrg } from './helpers/db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import * as tenancy from '../server/tenancy.js';
import * as sessions from '../server/sessions.js';
import { listAudit } from '../server/audit.js';
import { usageSummary } from '../server/billing.js';
import {
  MCP_TOOLS, MCP_MAX_RESULT_CHARS, MCP_MAX_IN_FLIGHT_PER_TOKEN, MCP_CALLS_PER_MINUTE,
  callTool, listTools, instructionsFor, _limits,
} from '../server/mcp.js';

const MODERN = '2026-07-28';
const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'kaddiya-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

let world;   // { org, ctx, instance, member, user, sid }
let spares;  // bearers minted before the child takes the database

before(async () => {
  await resetDb();
  world = await seedWorkspace();
});
after(close);

// ---------------------------------------------------------------- module level

const fakeSnClient = (answer) => ({
  cfg: { instanceUrl: 'https://kaddiya-test.invalid' },
  async queryTable() { return typeof answer === 'function' ? answer() : answer; },
  async getRecord() { return typeof answer === 'function' ? answer() : answer; },
  async aggregate() { return typeof answer === 'function' ? answer() : answer; },
});

let principalSeq = 0;
function fakePrincipal(sn, { tokenId = '00000000-0000-4000-8000-00000000000a', label = 'unit' } = {}) {
  return {
    tokenId,
    // A fresh limiter key per principal, so one test's bucket is not another's.
    tokenHashHex: `module-${principalSeq++}`,
    label,
    user: { user_name: 'unit.tester' },
    cfg: { instanceUrl: 'https://kaddiya-test.invalid' },
    sn,
    scope: { ctx: world.ctx, instanceId: world.instance.id, userSysId: world.user.sys_id, readOnly: true },
  };
}

test('the tool list is derived from agent.js, not restated beside it', () => {
  const tools = listTools();
  assert.deepEqual(tools.map((t) => t.name), [...MCP_TOOLS], 'MCP_TOOLS order is the wire order');
  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has a title for hosts that show tools to people`);
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must be annotated read-only`);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.type, 'object');
    // Nothing here may describe console furniture the host does not have.
    assert.doesNotMatch(tool.description, /side panel/i, `${tool.name} mentions the console's side panel`);
    assert.doesNotMatch(tool.description, /\bcards?\b/i, `${tool.name} mentions a card`);
    assert.doesNotMatch(tool.description, /propos/i, `${tool.name} talks about proposing`);
  }
});

test('sn_record carries a link where the console would have opened the side panel', async () => {
  const principal = fakePrincipal(fakeSnClient({ record: { sys_id: 'abc123', number: 'INC0010001' }, journal: [] }));
  const out = await callTool(principal, 'sn_record', { table: 'incident', sys_id: 'abc123' });
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.link, 'https://kaddiya-test.invalid/incident.do?sys_id=abc123');
  assert.equal(out.structuredContent.link, parsed.link);
  assert.ok(!out.isError);
});

test('a result past the cap is truncated, and only an object is ever the structured value', async () => {
  const big = { rows: 'x'.repeat(MCP_MAX_RESULT_CHARS + 5000) };
  const out = await callTool(fakePrincipal(fakeSnClient(big)), 'sn_query', { table: 'incident' });
  assert.ok(out.content[0].text.length <= MCP_MAX_RESULT_CHARS + 64);
  assert.match(out.content[0].text, /\(truncated — narrow the query\)$/);
  assert.equal(out.structuredContent, undefined, 'a truncated body no longer parses as the structured value');

  const list = await callTool(fakePrincipal(fakeSnClient([{ number: 'INC1' }])), 'sn_query', { table: 'incident' });
  assert.equal(list.structuredContent, undefined, 'the structured slot is an object, never an array');
  assert.deepEqual(JSON.parse(list.content[0].text), [{ number: 'INC1' }]);
});

test("a thrown tool error becomes isError with the instance's own words", async () => {
  const sn = fakeSnClient(() => { throw new Error('ServiceNow 403 on /api/now/table/incident: insufficient rights'); });
  const out = await callTool(fakePrincipal(sn), 'sn_query', { table: 'incident' });
  assert.equal(out.isError, true, 'the model reads the refusal and stops, rather than the host failing');
  assert.match(out.content[0].text, /403 .*insufficient rights/);
});

test('every proposal tool, and sn_note_save, is an unknown tool here', async () => {
  const principal = fakePrincipal(fakeSnClient({}));
  for (const name of ['sn_propose_reply', 'sn_propose_artifact', 'sn_propose_record_update', 'sn_propose_change', 'sn_note_save']) {
    await assert.rejects(
      () => callTool(principal, name, {}),
      (err) => err.code === -32602 && /Unknown tool/.test(err.message),
      `${name} must be refused as an unknown name, never executed`,
    );
  }
});

test('the in-flight bound holds a burst back, per token, as a tool error', async () => {
  _limits._reset();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const principal = fakePrincipal(fakeSnClient(() => held.then(() => ({ ok: true }))));

  const burst = Array.from({ length: MCP_MAX_IN_FLIGHT_PER_TOKEN + 3 }, () => callTool(principal, 'sn_query', { table: 'incident' }));
  // The three past the bound are refused immediately, without joining
  // withSlot()'s unbounded queue behind the eight that are running.
  const refused = await Promise.all(burst.slice(MCP_MAX_IN_FLIGHT_PER_TOKEN));
  for (const out of refused) {
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, new RegExp(`${MCP_MAX_IN_FLIGHT_PER_TOKEN} calls in flight per token`));
  }

  // Another token is unaffected: the bound is per token, not per process.
  const other = fakePrincipal(fakeSnClient({ ok: true }));
  assert.ok(!(await callTool(other, 'sn_query', { table: 'incident' })).isError);

  release();
  const ran = await Promise.all(burst.slice(0, MCP_MAX_IN_FLIGHT_PER_TOKEN));
  for (const out of ran) assert.ok(!out.isError, 'the eight inside the bound all ran');
  _limits._reset();
});

test('the rate limit is a sentence the model can act on, not a transport failure', async () => {
  _limits._reset();
  const principal = fakePrincipal(fakeSnClient({ ok: true }));
  let limited = null;
  let ran = 0;
  for (let i = 0; i < MCP_CALLS_PER_MINUTE + 10 && !limited; i++) {
    const out = await callTool(principal, 'sn_query', { table: 'incident' });
    if (out.isError) limited = out; else ran += 1;
  }
  assert.ok(limited, `expected the allowance to run out inside ${MCP_CALLS_PER_MINUTE + 10} calls`);
  assert.ok(ran >= MCP_CALLS_PER_MINUTE - 2, `expected about ${MCP_CALLS_PER_MINUTE} to get through, got ${ran}`);
  assert.match(limited.content[0].text, new RegExp(`${MCP_CALLS_PER_MINUTE} calls a minute per token`));
  _limits._reset();
});

test('every call lands in audit_events as mcp_tool_call, with the token that made it', async () => {
  _limits._reset();
  const before = (await listAudit(world.scope, { limit: 100 })).length;
  const principal = fakePrincipal(fakeSnClient({ record: { sys_id: 's1', number: 'INC42' } }), {
    tokenId: '11111111-1111-4111-8111-111111111111', label: 'audit probe',
  });
  await callTool(principal, 'sn_record', { table: 'incident', sys_id: 's1' }, { name: 'claude-code' });

  const rows = await listAudit(world.scope, { limit: 100 });
  assert.equal(rows.length, before + 1, 'exactly one row');
  const row = rows[0];
  assert.equal(row.action, 'mcp_tool_call');
  assert.equal(row.user, 'unit.tester');
  assert.equal(row.tool, 'sn_record', 'the tool name rides in the encrypted payload');
  assert.equal(row.table, 'incident', 'the index columns stay plaintext');
  assert.equal(row.sys_id, 's1');
  assert.equal(row.token_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(row.token_label, 'audit probe');
  assert.equal(row.client, 'claude-code', 'which host called');
  assert.equal(row.summary, 'INC42');
  assert.equal(row.conversation, null, 'an MCP call belongs to no console conversation');
  assert.equal(row.approved_by_user, null, 'a read is not a human-approved write');

  // A refused name is never executed and never audited.
  await callTool(principal, 'sn_query', { table: 'incident' }).catch(() => {});
  const after = await listAudit(world.scope, { limit: 100 });
  await assert.rejects(() => callTool(principal, 'sn_propose_reply', {}));
  assert.equal((await listAudit(world.scope, { limit: 100 })).length, after.length, 'a refused name writes no row');
  _limits._reset();
});

test('the instructions name the instance and the person, and promise no writes', () => {
  const text = instructionsFor('dev123.service-now.com', 'jane.doe');
  assert.match(text, /dev123\.service-now\.com/);
  assert.match(text, /jane\.doe/);
  assert.match(text, /read-only over MCP/);
  assert.match(text, /nothing here can change the instance/);
  assert.match(text, /propose it in the Kaddiya console/);
});

// ------------------------------------------------------------------ HTTP level

test('the /mcp endpoint, over real HTTP, on a booted console', async (t) => {
  // Everything the run needs from the database, before the child takes it.
  spares = [];
  for (let i = 0; i < 10; i++) spares.push(await mint(`spare ${i}`));
  const revokedUpFront = await mint('revoked up front');
  await sessions.revokeMcpToken(world.ctx, revokedUpFront.id);
  const revealable = await mint('revealable', { revealFor: world.sid, ttlMs: 30 * 24 * 60 * 60 * 1000 });
  // A second member, with a token of their own, so blocking exercises one
  // person without touching the other's.
  const second = await tenancy.signinMember(world.ctx, {
    org: world.org, instance: world.instance,
    user: { sys_id: 'second-member', user_name: 'second.member' },
    sn: { async myRoleNames() { return ['itil']; } },
  });
  const forSecond = (label) => sessions.createMcpToken({
    orgId: world.org.id, instanceId: world.instance.id, memberId: second.id,
    userSysId: 'second-member', user: { sys_id: 'second-member', user_name: 'second.member' },
    label, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }, ttlMs: 3600_000,
  });
  const secondToken = await forSecond('second member');
  const secondPending = await forSecond('second member, pending');
  const usageBefore = (await usageSummary(world.ctx)).turns_total;
  const auditBefore = (await listAudit(world.scope, { limit: 100 })).length;

  await close();
  const base = await boot(t);
  const take = () => spares.shift();
  const cookie = `sid=${world.sid}`;
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const rpc = rpcFor(base);
  const admin = (path, body) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: JSON.stringify(body),
  });

  // ---- gating ----
  const anonymous = await rpc(null, list);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate') || '', /Bearer realm="kaddiya"/);
  assert.equal((await rpc('kmcp_' + 'x'.repeat(43), list)).status, 401, 'a well-formed unknown bearer');
  assert.equal((await rpc('not-a-kaddiya-token', list)).status, 401, 'a malformed bearer');

  const working = take();
  assert.equal((await rpc(working.bearer, list, { origin: 'https://evil.example' })).status, 403, 'a foreign Origin');
  assert.equal((await rpc(working.bearer, list, { origin: base })).status, 200, 'our own Origin is fine');

  // The bearer is never accepted in a query string.
  const inUrl = await fetch(`${base}/mcp?access_token=${working.bearer}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list),
  });
  assert.equal(inUrl.status, 401);

  // GET is the 2025 standalone stream; we mint no session id, so there is none.
  const get = await fetch(base + '/mcp', { headers: { Authorization: `Bearer ${working.bearer}` } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');

  // A cookie alone opens nothing: /mcp never reads one.
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(list) })).status, 401);

  assert.equal((await rpc(revokedUpFront.bearer, list)).status, 401, 'a revoked token');

  // ---- both protocol eras ----
  const modern = await rpc(working.bearer, list);
  assert.equal(modern.status, 200);
  assert.match(modern.headers.get('content-type') || '', /application\/json/, 'responseMode json, never a stream');
  assert.deepEqual(modern.json.result.tools.map((x) => x.name), [...MCP_TOOLS]);
  assert.equal(modern.json.result.resultType, 'complete');
  assert.equal(modern.json.result.ttlMs, 300_000);
  assert.equal(modern.json.result.cacheScope, 'private');
  for (const tool of modern.json.result.tools) assert.equal(tool.annotations.readOnlyHint, true);

  const init = await rpc(working.bearer, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
  }, { era: 'legacy' });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, 'kaddiya');
  assert.equal(init.json.result.serverInfo.title, `Kaddiya · ${world.instance.host}`, 'two instances are two titles');
  assert.match(init.json.result.instructions, new RegExp(world.instance.host));
  const legacyList = await rpc(working.bearer, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { era: 'legacy' });
  assert.deepEqual(legacyList.json.result.tools.map((x) => x.name), [...MCP_TOOLS], 'the same eleven on both eras');

  const discover = await rpc(working.bearer, { jsonrpc: '2.0', id: 3, method: 'server/discover', params: {} });
  assert.deepEqual(discover.json.result.supportedVersions, [MODERN]);
  assert.deepEqual(discover.json.result.capabilities, { tools: {} });
  assert.match(discover.json.result.instructions, /nothing here can change the instance/);

  // The headers must mirror the body, or the request is refused before us.
  const mismatched = await rpc(working.bearer, list, { headers: { 'Mcp-Method': 'tools/call' } });
  assert.equal(mismatched.json.error.code, -32020);

  // ---- calling tools ----
  for (const name of ['sn_propose_reply', 'sn_propose_artifact', 'sn_note_save']) {
    const refused = await rpc(working.bearer, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
    assert.equal(refused.json.error?.code, -32602, `${name} must be -32602`);
    assert.match(refused.json.error.message, /Unknown tool/);
  }

  const called = await rpc(working.bearer, {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'sn_query', arguments: { table: 'incident', query: 'active=true' } },
  });
  assert.equal(called.status, 200);
  assert.equal(called.json.result.isError, true, 'the instance was unreachable, so the model gets a tool error');
  assert.match(called.json.result.content[0].text, /fetch failed|ENOTFOUND|getaddrinfo|kaddiya-test\.invalid/i);

  // Parallel calls on one token: all answered, none fails the transport.
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => rpc(working.bearer, {
    jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'sn_aggregate', arguments: { table: 'incident' } },
  })));
  assert.ok(burst.every((r) => r.status === 200), 'a runaway host is told to wait, never failed');

  // ---- the mint flow's browser half ----
  const started = await fetch(base + '/auth/mcp?label=laptop&ttl_ms=86400000', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(started.status, 302);
  const target = new URL(started.headers.get('location'));
  assert.equal(target.host, world.instance.host, "off to the instance's own consent screen");
  assert.equal(target.pathname, '/oauth_auth.do');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('redirect_uri'), base + '/auth/callback');
  assert.equal((await fetch(base + '/auth/mcp?label=x', { redirect: 'manual' })).headers.get('location')?.split('?')[0], '/signin');

  // A failed mint leaves the console signed in and says why there, rather
  // than answering a bare 502 the browser cannot act on.
  const state = new URL(started.headers.get('location')).searchParams.get('state');
  const binding = started.headers.get('set-cookie').match(/kd_oauth=([^;]+)/)[1];
  const failed = await fetch(`${base}/auth/callback?code=irrelevant&state=${state}`, {
    headers: { Cookie: `${cookie}; kd_oauth=${binding}` }, redirect: 'manual',
  });
  assert.match(failed.headers.get('location') || '', /^\/\?mcp_error=/);

  // ---- reveal, list, revoke ----
  const revealed = await admin(`/api/mcp/tokens/${revealable.id}/reveal`, {});
  assert.equal(revealed.status, 200);
  const body = await revealed.json();
  assert.equal(body.bearer, revealable.bearer, 'the minting browser gets the bearer back, once');
  assert.equal(body.label, 'revealable');
  assert.equal(body.base_url, base, 'the config snippets are built from this');
  assert.equal(body.clamped_by, null, 'nothing clamps a 30-day request on this instance');
  assert.equal((await admin(`/api/mcp/tokens/${revealable.id}/reveal`, {})).status, 410, 'a second showing is a 410');

  const listed = await (await fetch(base + '/api/mcp/tokens', { headers: { Cookie: cookie } })).json();
  assert.equal(listed.enabled, true);
  // The picker is built from this: "the workspace maximum" has to be a real
  // number, or a member asking for it would quietly get the 30-day default.
  assert.equal(listed.ceiling.ttl_ms, 90 * 24 * 60 * 60 * 1000);
  assert.equal(listed.ceiling.clamped_by, null, 'nothing clamps this instance');
  assert.equal(listed.base_url, base);
  const mine = listed.tokens.find((x) => x.id === revealable.id);
  assert.equal(mine.prefix, revealable.bearer.slice(0, 12));
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(revealable.bearer.slice(12)), 'the list never carries a bearer');

  const doomed = take();
  assert.equal((await admin(`/api/mcp/tokens/${doomed.id}/revoke`, {})).status, 200);
  assert.equal((await rpc(doomed.bearer, list)).status, 401, 'revoked in the console, dead on the next call');
  assert.equal((await admin(`/api/mcp/tokens/${doomed.id}/revoke`, {})).status, 404, 'and gone');

  // Merely pending is a 403 the token survives — the person is told to talk to
  // an admin, and their client works again the moment they are re-approved.
  const survivor = take();
  assert.equal((await rpc(secondPending.bearer, list)).status, 200, 'the second member starts alive');
  assert.equal((await admin(`/api/admin/members/${second.id}`, { status: 'pending' })).status, 200);
  assert.equal((await rpc(secondPending.bearer, list)).status, 403, 'membership is not active');
  assert.equal((await rpc(survivor.bearer, list)).status, 200, "another member's status is not mine");
  assert.equal((await admin(`/api/admin/members/${second.id}`, { status: 'active' })).status, 200);
  assert.equal((await rpc(secondPending.bearer, list)).status, 200, 'and it works again once re-approved');

  // Blocking is the other half of that: a revocation, not a pause.
  assert.equal((await admin(`/api/admin/members/${second.id}`, { status: 'blocked' })).status, 200);
  assert.equal((await rpc(secondToken.bearer, list)).status, 401, 'the blocked member’s token is dead on presentation');
  assert.equal((await rpc(survivor.bearer, list)).status, 200, "and another member's block is still not mine");
  assert.equal((await admin(`/api/admin/members/${second.id}`, { status: 'active' })).status, 200);
  assert.equal((await rpc(secondPending.bearer, list)).status, 401, 'un-blocking does not resurrect a revoked token');

  // ---- the org switch, last, because turning it off revokes everything ----
  const offToken = take();
  assert.equal((await admin('/api/admin/settings', { mcp_enabled: false })).status, 200);
  assert.equal((await fetch(base + '/auth/mcp?label=x', { headers: { Cookie: cookie }, redirect: 'manual' })).status, 403,
    'no new token can be minted while the surface is closed');
  assert.equal((await rpc(offToken.bearer, list)).status, 401,
    'the switch revoked every live token, so the next call is a revocation, not a pause');
  await stop();

  // A token the switch never saw — minted while the surface was already closed
  // — is refused by the gate itself, not by its own revocation flag. One more
  // boot, because only one process at a time may hold a local workspace.
  const whileOff = await mint('minted while off');
  await close();
  const reopened = await boot(t);
  const rpc2 = rpcFor(reopened);
  assert.equal((await rpc2(whileOff.bearer, list)).status, 403, 'MCP off is a 403 regardless of the token');
  assert.equal((await fetch(`${reopened}/api/update-set/${'a'.repeat(32)}/package.xml`,
    { headers: { Authorization: `Bearer ${whileOff.bearer}` } })).status, 403,
  'and the package download is closed with it — one switch, both doors (ADR 0014 D9)');
  assert.equal((await fetch(reopened + '/api/mcp/tokens', { headers: { Cookie: cookie } })
    .then((r) => r.json())).enabled, false, 'and the console says so');
  const backOn = await fetch(reopened + '/api/admin/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: reopened, Cookie: cookie }, body: JSON.stringify({ mcp_enabled: true }),
  });
  assert.equal(backOn.status, 200);
  assert.equal((await rpc2(whileOff.bearer, list)).status, 200, 'and it works the moment the admin opens the surface again');

  // ---- the package download: the one endpoint outside /mcp a bearer opens (D9) ----
  const packageUrl = `${reopened}/api/update-set/${'a'.repeat(32)}/package.xml`;
  const bearerHeaders = { Authorization: `Bearer ${whileOff.bearer}` };

  assert.equal((await fetch(packageUrl)).status, 401, 'no credential opens nothing');
  assert.equal((await fetch(packageUrl, { headers: { Authorization: `Bearer ${revokedUpFront.bearer}` } })).status, 401,
    'a revoked bearer is refused here exactly as it is at /mcp');
  assert.equal((await fetch(`${reopened}/api/update-set/not-a-sys-id/package.xml`, { headers: bearerHeaders })).status, 400);
  assert.equal((await fetch(`${reopened}/api/update-set/${'a'.repeat(32)}/package.exe`, { headers: bearerHeaders })).status, 404,
    'only the two formats exist');

  // A live bearer authenticates, and the packager is then what fails: the
  // instance is kaddiya-test.invalid, so the 409 proves the request went
  // through resolvePrincipal and all the way into the Table API read.
  const byBearer = await fetch(packageUrl, { headers: bearerHeaders });
  assert.equal(byBearer.status, 409);
  assert.equal((await byBearer.json()).code, 'unreadable');

  // And the browser's own credential still opens the same door.
  assert.equal((await fetch(packageUrl, { headers: { Cookie: cookie } })).status, 409);

  await stop();
  // ---- the parent may read the database again ----
  const rows = await listAudit(world.scope, { limit: 100 });
  assert.equal((await usageSummary(world.ctx)).turns_total, usageBefore, 'MCP consumes no model tokens and writes no usage row');

  const calls = rows.filter((r) => r.action === 'mcp_tool_call' && r.token_id === working.id);
  assert.ok(calls.length >= 11, `expected a row per call, found ${calls.length}`);
  const query = calls.find((r) => r.tool === 'sn_query');
  assert.equal(query.user, world.user.user_name);
  assert.equal(query.table, 'incident');
  assert.equal(query.token_label, 'spare 0');
  assert.equal(query.client, 'kaddiya-test', 'the host that called is on the row');
  assert.equal(query.error, true);
  assert.ok(!rows.some((r) => r.action === 'mcp_tool_call' && /propose|note_save/.test(r.tool || '')), 'no refused name was ever executed');
  assert.ok(rows.some((r) => r.action === 'mcp_token_revoke' && r.approved_by_user === true), 'the revoke is audited as a human act');

  // The package download audits the attempt, not just the success, and names
  // the token — the row a reviewer reads to answer "who pulled a package".
  const pulled = rows.find((r) => r.action === 'mcp_update_set_package');
  assert.ok(pulled, 'a bearer download is audited');
  assert.equal(pulled.token_label, 'minted while off');
  assert.equal(pulled.user, world.user.user_name);
  assert.equal(pulled.error, true, 'the failed attempt is on the record too');
  assert.ok(rows.some((r) => r.action === 'update_set_package'), 'and so is the cookie-authenticated one');
  assert.ok(!rows.some((r) => r.action === 'mcp_update_set_package' && r.approved_by_user === true),
    'a download is not a write and is never marked as approved by a human');
  assert.ok(rows.length > auditBefore);

  // The block and the disable both marked rows rather than deleting them; the
  // deletion happened on presentation, above.
  assert.equal(await sessions.lookupMcpToken(offToken.bearer), undefined);
  assert.equal(await sessions.lookupMcpToken(doomed.bearer), undefined);
});

// ---------------------------------------------------------------------- helpers

async function seedWorkspace() {
  const seeded = await seedOrg('mcp', { host: 'kaddiya-test.invalid', snInstanceId: 'sn-mcp' });
  const org = await tenancy.updateOrgSettings(seeded.ctx, { mcp_enabled: true, join_policy: 'auto' });
  const ctx = tenancy.contextFor(org);
  const sid = await sessions.createSession({
    orgId: org.id, instanceId: seeded.instance.id, memberId: seeded.ownerMember.id,
    userSysId: seeded.owner.sys_id, user: seeded.owner,
    tokens: { accessToken: 'console-access', refreshToken: 'console-refresh', expiresAt: Date.now() + 3600_000 },
    ttlMs: 3600_000,
  });
  return {
    org, ctx, instance: seeded.instance, member: seeded.ownerMember, user: seeded.owner, sid,
    scope: { ctx, instanceId: seeded.instance.id, userSysId: seeded.owner.sys_id },
  };
}

function mint(label, extra = {}) {
  return sessions.createMcpToken({
    orgId: world.org.id, instanceId: world.instance.id, memberId: world.member.id,
    userSysId: world.user.sys_id, user: world.user, label,
    // Well clear of the sixty-second proactive-refresh margin: a refresh here
    // would reach kaddiya-test.invalid and only slow the test down.
    tokens: { accessToken: 'mcp-access', refreshToken: 'mcp-refresh', expiresAt: Date.now() + 3600_000 },
    ttlMs: 3600_000,
    ...extra,
  });
}


let child;
let logs = '';

async function boot(t) {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const base = `http://localhost:${port}`;
  logs = '';
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(port), BASE_URL: base, KADDIYA_DOCS_SYNC: '0',
      SN_INSTANCE_URL: '', SN_CLIENT_ID: '', SN_CLIENT_SECRET: '',
      ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', KADDIYA_TRIAL_ANTHROPIC_KEY: '', KADDIYA_TRIAL_OPENAI_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (b) => { logs += b; });
  child.stderr.on('data', (b) => { logs += b; });
  t?.after(stop);
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error('Server failed to boot: ' + logs);
    try { if ((await fetch(base + '/api/config')).ok) return base; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Server startup timed out: ' + logs);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.send('shutdown');
  await exited;
}

/** One JSON-RPC POST. `era: 'legacy'` omits the modern envelope and its headers. */
function rpcFor(base) {
  return async function rpc(bearer, body, { era = 'modern', headers = {}, origin } = {}) {
    const message = era === 'modern'
      ? { ...body, params: { ...(body.params || {}), _meta: { ...META, ...(body.params?._meta || {}) } } }
      : body;
    const mirrored = era === 'modern'
      ? {
        'MCP-Protocol-Version': MODERN,
        'Mcp-Method': body.method,
        ...(body.params?.name ? { 'Mcp-Name': body.params.name } : {}),
      }
      : {};
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...mirrored,
        ...headers,
      },
      body: JSON.stringify(message),
    });
    const text = await res.text();
    let json = null;
    if (text.startsWith('event:')) {
      // The legacy leg answers one SSE stream carrying the same message.
      const line = text.split('\n').find((l) => l.startsWith('data:'));
      json = line ? JSON.parse(line.slice(5).trim()) : null;
    } else if (text) {
      try { json = JSON.parse(text); } catch { json = text; }
    }
    return { status: res.status, headers: res.headers, json, text };
  };
}
