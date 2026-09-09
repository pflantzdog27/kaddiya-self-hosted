import { resetDb, close, fakeSn } from './helpers/db.js';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as tenancy from '../server/tenancy.js';
import { availableModels, gateTurn } from '../server/billing.js';
import { system } from '../server/db.js';

before(resetDb);
after(close);

// This exercises the real database, draft recovery, instance verification,
// model selection and billing gate without calling external services.
test('a fresh self-hosted workspace resumes securely and runs only its own models', async t => {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    const previous = process.env[key]; delete process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  process.env.KADDIYA_TRIAL_ANTHROPIC_KEY = 'platform-key-must-not-be-used';
  assert.equal(await tenancy.selfHostedDeployment(), null);
  const draft = await tenancy.createSelfHostedDraft({ name: 'Example enterprise' });
  const ctx = tenancy.contextFor(draft.org);
  assert.equal(draft.org.edition, 'self-hosted');
  assert.equal((await tenancy.orgForDraft(draft.draftSecret)).id, draft.org.id);
  assert.equal(await tenancy.orgForDraft('foreign-browser'), null);
  assert.deepEqual(availableModels(draft.org), []);
  assert.equal((await gateTurn(draft.org, ctx)).reason, 'no_model_key');
  const instance = await tenancy.addInstanceDraft(ctx, {
    host: 'dev123456.service-now.com', clientId: 'a'.repeat(32), clientSecret: 'private-client-secret',
  });
  const recovered = await tenancy.createSelfHostedDraft({ name: 'Example enterprise' });
  assert.equal(recovered.org.id, draft.org.id);
  assert.equal(await tenancy.orgForDraft(draft.draftSecret), null, 'a resumed setup invalidates the previous draft binding');
  assert.equal((await tenancy.listInstances(ctx))[0].id, instance.id, 'recovery preserves the instance');
  const attempts = await Promise.all([1, 2, 3].map(() => tenancy.createSelfHostedDraft({ name: 'Example enterprise' })));
  assert.equal(new Set(attempts.map(a => a.org.id)).size, 1, 'concurrent setup cannot create extra workspaces');

  const user = { sys_id: 'setup-admin', user_name: 'setup.admin' };
  await assert.rejects(tenancy.verifyInstance(ctx, instance.id, {
    sn: fakeSn({ redirect: 'https://foreign.example/auth/callback' }), user,
    expectedRedirect: process.env.BASE_URL + '/auth/callback',
  }), /redirect URL/);
  assert.equal(await tenancy.selfHostedDeployment(), null, 'failed verification does not unlock the workspace');
  await tenancy.verifyInstance(ctx, instance.id, { sn: fakeSn(), user, expectedRedirect: process.env.BASE_URL + '/auth/callback' });
  const deployment = await tenancy.selfHostedDeployment();
  assert.equal(deployment.org.id, draft.org.id);
  assert.equal(deployment.org.join_policy, 'approve');
  assert.equal((await tenancy.listMembers(ctx))[0].role, 'owner');
  await assert.rejects(tenancy.createSelfHostedDraft({ name: 'Replacement' }), /already configured/);
  for (const attempt of attempts) assert.equal(await tenancy.orgForDraft(attempt.draftSecret), null);

  let org = await tenancy.saveModelConnection(ctx, { label: 'Fast', provider: 'anthropic', model_id: 'custom-fast' }, 'enterprise-key-one');
  org = await tenancy.saveModelConnection(ctx, { label: 'Reasoning', provider: 'openai', model_id: 'custom-reasoning' }, 'enterprise-key-two');
  const [first, second] = org.model_connections;
  assert.equal(availableModels(org).length, 2);
  assert.ok(availableModels(org).every(m => m.provider === 'org'));
  for (const [id, key, kind] of [[first.id, 'enterprise-key-one', 'anthropic'], [second.id, 'enterprise-key-two', 'openai']]) {
    const gate = await gateTurn(org, ctx, { modelId: id, connectionKey: tenancy.modelConnectionKey });
    assert.equal(gate.ok, true);
    assert.equal(gate.model.apiKey, key);
    assert.equal(gate.model.kind, kind);
    assert.equal(gate.plan.id, 'self-hosted');
    assert.equal(gate.plan.turns_per_month, null);
  }
  org = await tenancy.setDefaultModelConnection(ctx, second.id);
  assert.equal((await gateTurn(org, ctx, { connectionKey: tenancy.modelConnectionKey })).model.apiKey, 'enterprise-key-two');
  const raw = await system(c => c.query('SELECT model_connections FROM orgs WHERE id=$1', [org.id]));
  assert.doesNotMatch(JSON.stringify(raw.rows), /enterprise-key/);
  org = await tenancy.removeModelConnection(ctx, second.id);
  await assert.rejects(gateTurn(org, ctx, { modelId: second.id, connectionKey: tenancy.modelConnectionKey }), /no longer available/);
  org = await tenancy.removeModelConnection(ctx, first.id);
  assert.deepEqual(availableModels(org), []);
  assert.equal((await gateTurn(org, ctx)).reason, 'no_model_key');
});

test('HTTP setup requires the operator code, survives restart, and unlocks models without a purchase', async t => {
  await resetDb();
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const net = await import('node:net');
  const { createSession } = await import('../server/sessions.js');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://localhost:${port}`;
  let child;
  let logs = '';
  async function boot() {
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PORT: String(port), BASE_URL: base, KADDIYA_EDITION: 'self-hosted',
        KADDIYA_SETUP_TOKEN: 'operator-test-code', SN_INSTANCE_URL: '', SN_CLIENT_ID: '', SN_CLIENT_SECRET: '',
        ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', KADDIYA_TRIAL_ANTHROPIC_KEY: '', KADDIYA_TRIAL_OPENAI_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', b => { logs += b; });
    child.stderr.on('data', b => { logs += b; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Server failed to boot: ' + logs);
      try { if ((await fetch(base + '/api/config')).ok) return; } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Server startup timed out: ' + logs);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  t.after(stop);
  await boot();
  const post = (route, body, cookie, origin = base) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body), redirect: 'manual',
  });
  assert.equal((await fetch(base, { redirect: 'manual' })).headers.get('location'), '/start');
  assert.equal((await post('/api/org', { name: 'HTTP enterprise' })).status, 403);
  assert.equal((await post('/api/org', { name: 'HTTP enterprise', setup_token: 'wrong' })).status, 403);
  assert.equal((await post('/api/org', { name: 'HTTP enterprise', setup_token: 'operator-test-code' }, null, 'https://foreign.example')).status, 403);
  const response = await post('/api/org', { name: 'HTTP enterprise', setup_token: 'operator-test-code', edition: 'saas' });
  assert.equal(response.status, 200);
  const draft = await response.json();
  assert.equal(draft.org.edition, 'self-hosted', 'edition is controlled by the deployment, not the submitted body');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/org/draft')).status, 404);
  const saved = await post('/api/org/draft/instance', { host: 'dev567890.service-now.com', client_id: 'b'.repeat(32), client_secret: 'secret-for-test-only' }, cookie);
  assert.equal(saved.status, 200);
  const { instance } = await saved.json();
  await stop(); await boot();
  const resumed = await (await fetch(base + '/api/org/draft', { headers: { Cookie: cookie } })).json();
  assert.equal(resumed.instances[0].id, instance.id);
  assert.equal(resumed.callback_url, base + '/auth/callback');
  const org = await tenancy.getOrg(draft.org.id);
  const ctx = tenancy.contextFor(org);
  const user = { sys_id: 'http-admin', user_name: 'http.admin' };
  await tenancy.verifyInstance(ctx, instance.id, { sn: fakeSn({ redirect: base + '/auth/callback' }), user, expectedRedirect: base + '/auth/callback' });
  const member = (await tenancy.listMembers(ctx))[0];
  const sid = await createSession({ orgId: org.id, instanceId: instance.id, memberId: member.id, userSysId: user.sys_id, user,
    tokens: { accessToken: 'fake-test-token', refreshToken: 'fake-test-refresh', expiresAt: Date.now() + 3600000 }, ttlMs: 3600000 });
  const auth = { Cookie: `sid=${sid}` };
  assert.equal((await fetch(base, { headers: auth, redirect: 'manual' })).headers.get('location'), '/admin?setup=1');
  assert.equal((await fetch(base, { redirect: 'manual' })).headers.get('location'), '/signin');
  assert.equal((await post('/api/org', { name: 'Second workspace', setup_token: 'operator-test-code' })).status, 400);
  const admin = await (await fetch(base + '/api/admin', { headers: auth })).json();
  assert.equal(admin.plan.id, 'self-hosted');
  assert.deepEqual(admin.available_models, []);
  const invalid = await post('/api/admin/models', { label: 'No key', provider: 'openai', model_id: 'custom' }, `sid=${sid}`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /API key/, 'self-hosted connections reach validation without a payment gate');
  const configured = await tenancy.saveModelConnection(ctx, { label: 'Enterprise model', provider: 'openai', model_id: 'custom' }, 'test-key');
  const choice = configured.model_connections[0].id;
  const chosen = await post('/api/admin/models', { operation: 'default', id: choice }, `sid=${sid}`);
  assert.equal(chosen.status, 200);
  await stop(); await boot();
  const me = await (await fetch(base + '/api/me', { headers: auth })).json();
  assert.equal(me.default_model, choice);
  assert.equal(me.gate.ok, true);
  assert.equal(me.models.length, 1);
  assert.doesNotMatch(JSON.stringify(me), /test-key|fake-test-token/);
  assert.equal((await fetch(base, { headers: auth, redirect: 'manual' })).status, 200);
});
