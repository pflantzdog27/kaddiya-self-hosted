// Instance registration, verification and the join policy (ADR 0008 D1–D4).
//
// The Phase 2 gate: a second instance registers, and an instance already
// claimed by one org cannot be claimed by another. The join policy fails
// closed — a joiner whose roles cannot be read waits in the queue.

import { resetDb, close, seedOrg, fakeSn } from './helpers/db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as tenancy from '../server/tenancy.js';
import { system } from '../server/db.js';

before(resetDb);
after(close);

const CALLBACK = process.env.BASE_URL + '/auth/callback';

test('a draft org becomes active with an owner when its first instance verifies', async () => {
  const { org: draft, draftSecret } = await tenancy.createOrgDraft({ name: 'Initech' });
  assert.equal(draft.status, 'draft');
  assert.ok((await tenancy.orgForDraft(draftSecret)).id === draft.id, 'the draft cookie finds the draft');
  assert.equal(await tenancy.orgForDraft('not-the-secret'), null);

  const ctx = tenancy.contextFor(draft);
  const inst = await tenancy.addInstanceDraft(ctx, { host: 'https://Initech.service-now.com/', clientId: 'a'.repeat(32), clientSecret: 'topsecret' });
  assert.equal(inst.host, 'initech.service-now.com', 'host is normalised');
  assert.equal(await tenancy.resolveHost('initech.service-now.com'), null, 'a draft instance does not resolve at sign-in');

  const registrant = { sys_id: 'reg-1', user_name: 'admin', name: 'Admin' };
  const verified = await tenancy.verifyInstance(ctx, inst.id, { sn: fakeSn({ snInstanceId: 'sn-initech' }), user: registrant, expectedRedirect: CALLBACK });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.instance_id, 'sn-initech');

  const org = await tenancy.getOrg(draft.id);
  assert.equal(org.status, 'active');
  assert.equal(org.anchor_instance_id, inst.id);
  assert.equal(await tenancy.orgForDraft(draftSecret), null, 'the draft binding is spent');

  const members = await tenancy.listMembers(tenancy.contextFor(org));
  assert.equal(members.length, 1);
  assert.equal(members[0].role, 'owner');
  assert.equal(members[0].status, 'active');

  const resolved = await tenancy.resolveHost('INITECH.service-now.com');
  assert.equal(resolved.org.id, org.id);
  assert.equal(resolved.instance.id, inst.id);

  const config = await tenancy.instanceConfig(tenancy.contextFor(org), inst.id, process.env.BASE_URL);
  assert.equal(config.clientSecret, 'topsecret', 'the secret decrypts under the org key');
  const { rows } = await system((c) => c.query('SELECT client_secret_enc FROM instances WHERE id = $1', [inst.id]));
  assert.doesNotMatch(rows[0].client_secret_enc.toString('latin1'), /topsecret/, 'the secret is not stored in the clear');
});

test('verification refuses a wrong redirect URL and a non-admin read', async () => {
  const { org } = await tenancy.createOrgDraft({ name: 'Wrong' });
  const ctx = tenancy.contextFor(org);
  const inst = await tenancy.addInstanceDraft(ctx, { host: 'wrong.service-now.com', clientId: 'b'.repeat(32), clientSecret: 'secret-1' });
  const user = { sys_id: 'u', user_name: 'u' };
  await assert.rejects(
    tenancy.verifyInstance(ctx, inst.id, { sn: fakeSn({ redirect: 'https://elsewhere.example/cb' }), user, expectedRedirect: CALLBACK }),
    /redirect URL/,
  );
  await assert.rejects(
    tenancy.verifyInstance(ctx, inst.id, { sn: fakeSn({ entityError: 'ServiceNow 403 on /api/now/table/oauth_entity' }), user, expectedRedirect: CALLBACK }),
    /admin/,
  );
  assert.equal((await tenancy.getInstance(ctx, inst.id)).status, 'draft');
});

test('one instance, one org: a second org cannot claim an instance_id already registered', async () => {
  await seedOrg('first', { snInstanceId: 'sn-shared' });
  const { org } = await tenancy.createOrgDraft({ name: 'Second' });
  const ctx = tenancy.contextFor(org);
  const inst = await tenancy.addInstanceDraft(ctx, { host: 'first-alias.service-now.com', clientId: 'c'.repeat(32), clientSecret: 'secret-2' });
  await assert.rejects(
    tenancy.verifyInstance(ctx, inst.id, { sn: fakeSn({ snInstanceId: 'sn-shared' }), user: { sys_id: 'x', user_name: 'x' }, expectedRedirect: CALLBACK }),
    /already registered to another org/,
  );
});

test('an org registers a second instance and both resolve to it', async () => {
  const a = await seedOrg('multi');
  const dev = await tenancy.addInstanceDraft(a.ctx, { host: 'multidev.service-now.com', clientId: 'd'.repeat(32), clientSecret: 'secret-3', label: 'dev' });
  await tenancy.verifyInstance(a.ctx, dev.id, { sn: fakeSn({ snInstanceId: 'sn-multi-dev' }), user: { sys_id: 'admin2', user_name: 'admin2' }, expectedRedirect: CALLBACK });
  assert.equal((await tenancy.resolveHost('multidev.service-now.com')).org.id, a.org.id);
  assert.equal((await tenancy.listInstances(a.ctx)).filter((i) => i.status === 'verified').length, 2);
  const members = await tenancy.listMembers(a.ctx);
  assert.equal(members.find((m) => m.sn_user_sys_id === 'admin2').role, 'admin', 'a later verifier is an admin, not a second owner');
  assert.equal(members.filter((m) => m.role === 'owner').length, 1);
});

test('join policy: approve queue by default, auto-join when set, external denied, fail closed', async () => {
  const a = await seedOrg('door');
  const instance = a.instance;

  const pending = await tenancy.signinMember(a.ctx, { org: a.org, instance, user: { sys_id: 'p1', user_name: 'p1' }, sn: fakeSn({ roles: ['itil'] }) });
  assert.equal(pending.status, 'pending');
  assert.match(pending.pending_reason, /approve/);

  const external = await tenancy.signinMember(a.ctx, { org: a.org, instance, user: { sys_id: 'ext', user_name: 'ext' }, sn: fakeSn({ roles: ['snc_external'] }) });
  assert.equal(external.status, 'pending');
  assert.match(external.pending_reason, /snc_external/);

  const unreadable = await tenancy.signinMember(a.ctx, { org: a.org, instance, user: { sys_id: 'blind', user_name: 'blind' }, sn: fakeSn({ rolesError: 'ServiceNow 403 on sys_user_has_role' }) });
  assert.equal(unreadable.status, 'pending', 'fail closed');
  assert.match(unreadable.pending_reason, /Could not read your roles/);

  const org = await tenancy.updateOrgSettings(a.ctx, { join_policy: 'auto' });
  const auto = await tenancy.signinMember(a.ctx, { org, instance, user: { sys_id: 'a1', user_name: 'a1' }, sn: fakeSn({ roles: ['itil'] }) });
  assert.equal(auto.status, 'active');

  const stillExternal = await tenancy.signinMember(a.ctx, { org, instance, user: { sys_id: 'ext2', user_name: 'ext2' }, sn: fakeSn({ roles: ['snc_external'] }) });
  assert.equal(stillExternal.status, 'pending', 'auto-join never admits external accounts');

  const withRole = await tenancy.updateOrgSettings(a.ctx, { required_role: 'itil' });
  const noRole = await tenancy.signinMember(a.ctx, { org: withRole, instance, user: { sys_id: 'nr', user_name: 'nr' }, sn: fakeSn({ roles: ['approver_user'] }) });
  assert.equal(noRole.status, 'pending');
  assert.match(noRole.pending_reason, /itil/);

  // Approval by an admin, and blocking marks sessions for revocation.
  const approved = await tenancy.setMember(a.ctx, pending.id, { status: 'active', actor: 'owner.door' });
  assert.equal(approved.status, 'active');
  assert.equal(approved.approved_by, 'owner.door');
  const blocked = await tenancy.setMember(a.ctx, approved.id, { status: 'blocked' });
  assert.equal(blocked.status, 'blocked');
});

test('org settings only move the session ceiling downward and keep tiers sane', async () => {
  const a = await seedOrg('settings');
  const org = await tenancy.updateOrgSettings(a.ctx, { session_ttl_ms: 99 * 60 * 60 * 1000, actions_tiers: '3,1,x' });
  assert.equal(Number(org.session_ttl_ms), tenancy.SESSION_CEILING_MS);
  assert.equal(org.actions_tiers, '1,3');
  assert.equal(tenancy.sessionTtlFor({ session_ttl_ms: 60 * 60 * 1000 }), 60 * 60 * 1000);
});

test('the self-hosted seed is one active org with one verified instance, idempotent', async () => {
  const first = await tenancy.seedSelfHosted({ instanceUrl: 'https://dev000000.service-now.com', clientId: 'e'.repeat(32), clientSecret: 'env-secret' });
  const again = await tenancy.seedSelfHosted({ instanceUrl: 'https://dev000000.service-now.com', clientId: 'e'.repeat(32), clientSecret: 'env-secret-rotated' });
  assert.equal(first.org.id, again.org.id);
  assert.equal(first.instance.id, again.instance.id);
  assert.equal(again.org.edition, 'self-hosted');
  assert.equal(again.org.plan, 'self-hosted');
  const cfg = await tenancy.instanceConfig(tenancy.contextFor(again.org), again.instance.id, process.env.BASE_URL);
  assert.equal(cfg.clientSecret, 'env-secret-rotated');
  assert.equal((await tenancy.resolveHost('dev000000.service-now.com')).org.id, first.org.id);
});

test('normalizeHost refuses anything that could aim the egress inward', () => {
  for (const bad of ['localhost', '127.0.0.1', 'http://10.0.0.1', 'box.internal', 'host:8443', 'nodots', 'a..b.com']) {
    assert.throws(() => tenancy.normalizeHost(bad), undefined, bad);
  }
  assert.equal(tenancy.normalizeHost('https://Dev123456.service-now.com/nav_to.do?x=1'), 'dev123456.service-now.com');
});
