// Platform stewardship, pinned (ADR 0008 D14).
//
// The approval kit's traffic profile tells a platform owner "at most 2 in-flight
// calls per user, 429/Retry-After honored, every call identified". Those are
// claims in a document a CAB reads, so they are tested rather than asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SnClient, USER_AGENT } from '../server/sn.js';

const cfg = { instanceUrl: 'https://example.service-now.com', clientId: 'x', clientSecret: 'y', org: 'acme' };

/** A client whose network layer is a stub we drive from the test. */
function clientWith(handler, identity = { userKey: 'user-1' }) {
  const client = new SnClient(cfg, { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 1e6 }, () => {}, {
    org: 'acme',
    ...identity,
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(calls.length, url, init);
  };
  return { client, calls };
}

const ok = (body = { result: [] }) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

test('every instance call is identified in the customer transaction log', async () => {
  const { client, calls } = clientWith(() => ok());
  await client.get('/api/now/table/incident', { sysparm_limit: 1 });

  const headers = calls[0].init.headers;
  assert.equal(headers['User-Agent'], USER_AGENT);
  assert.match(headers['User-Agent'], /^Kaddiya\/\d/);
  assert.equal(headers['X-Kaddiya-Org'], 'acme');
  assert.equal(headers['X-Kaddiya-User'], 'user-1');
  assert.equal(headers.Authorization, 'Bearer t');
});

test('header values are stripped to ASCII so a name never breaks a call', async () => {
  const { client, calls } = clientWith(() => ok(), { userKey: 'renée.okafor–1' });
  await client.get('/api/now/table/incident');

  const value = calls[0].init.headers['X-Kaddiya-User'];
  assert.doesNotMatch(value, /[^\x20-\x7e]/, 'non-ASCII would throw when the header is set');
  assert.ok(value.length > 0);
});

test('no more than two calls per user are ever in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const { client } = clientWith(() => new Promise((resolve) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    setTimeout(() => { inFlight -= 1; resolve(ok()); }, 5);
  }));

  await Promise.all(
    Array.from({ length: 10 }, () => client.get('/api/now/table/incident')),
  );
  assert.equal(peak, 2, `peak concurrency was ${peak}, the traffic profile promises 2`);
});

test('two users do not queue behind each other', async () => {
  let inFlight = 0;
  let peak = 0;
  const handler = () => new Promise((resolve) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    setTimeout(() => { inFlight -= 1; resolve(ok()); }, 5);
  });
  const a = clientWith(handler, { userKey: 'user-a' }).client;
  const b = new SnClient(cfg, { accessToken: 't' }, () => {}, { org: 'acme', userKey: 'user-b' });

  await Promise.all([
    ...Array.from({ length: 4 }, () => a.get('/api/now/table/incident')),
    ...Array.from({ length: 4 }, () => b.get('/api/now/table/incident')),
  ]);
  assert.equal(peak, 4, 'the cap is per user, not global');
});

test('429 is retried after Retry-After, at most twice, then surfaced', async () => {
  const { client, calls } = clientWith((n) => {
    return n <= 1
      ? new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })
      : ok({ result: [{ number: 'INC1' }] });
  });

  const data = await client.get('/api/now/table/incident');
  assert.equal(calls.length, 2, 'the initial call, then one retry that succeeded');
  assert.deepEqual(data.result, [{ number: 'INC1' }]);

  // A wall of 429s is given up on rather than hammered.
  const hammered = clientWith(() => new Response('no', { status: 429, headers: { 'Retry-After': '0' } }));
  await assert.rejects(
    () => hammered.client.get('/api/now/table/incident'),
    /ServiceNow 429/,
  );
  assert.equal(hammered.calls.length, 3, 'initial call plus two retries, then stop');
});

test('a 401 triggers exactly one token refresh, not a loop', async () => {
  let refreshes = 0;
  const { client, calls } = clientWith((n, url) => {
    if (String(url).includes('oauth_token.do')) {
      refreshes += 1;
      return ok({ access_token: 'new', refresh_token: 'r2', expires_in: 1800 });
    }
    return new Response('nope', { status: 401 });
  });

  await assert.rejects(() => client.get('/api/now/table/incident'), /ServiceNow 401/);
  assert.equal(refreshes, 1, 'one refresh attempt, then the error is surfaced');
  assert.equal(calls.filter((c) => !c.url.includes('oauth_token.do')).length, 2);
});
