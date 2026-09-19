// Shared setup for the database-backed tests. Import this module FIRST in a
// test file: it pins the environment before server/db.js or server/keys.js
// can read it.
//
// The database name must end in `_test` — these helpers truncate every table.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

let testDirectory;
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.KADDIYA_STORAGE = 'postgres';
  if (!/_test(\?.*)?$/.test(process.env.DATABASE_URL)) throw new Error('Test database name must end in _test.');
} else {
  // Never reuse an operator's database or local data directory in tests.
  delete process.env.DATABASE_URL;
  process.env.KADDIYA_STORAGE = 'local';
  testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaddiya-test-'));
  process.env.KADDIYA_DATA_DIR = testDirectory;
}
process.env.KADDIYA_MASTER_KEY = process.env.KADDIYA_MASTER_KEY || '11'.repeat(32);
process.env.BASE_URL = process.env.BASE_URL || 'http://localhost:3999';

import { migrate, system, close } from '../../server/db.js';
import * as tenancy from '../../server/tenancy.js';

after(async () => {
  await close();
  if (testDirectory) fs.rmSync(testDirectory, { recursive: true, force: true });
});

const TABLES = [
  'output_revisions', 'outputs', 'conversation_turns',
  'usage_events', 'audit_events', 'notebook_entries', 'conversations', 'members',
  'oauth_states', 'sessions', 'mcp_tokens', 'instance_aliases', 'instances', 'orgs', 'stripe_events',
];

export async function resetDb() {
  await migrate();
  await system((c) => c.query(`TRUNCATE ${TABLES.join(', ')} CASCADE`));
}

export { close };

/** A fake ServiceNow client that answers the verification and join-policy reads. */
export function fakeSn({ snInstanceId = 'sn-instance-1', redirect = process.env.BASE_URL + '/auth/callback', roles = ['itil'], rolesError, entityError } = {}) {
  return {
    cfg: { instanceUrl: 'https://fake.service-now.com' },
    async readOAuthEntity(clientId) {
      if (entityError) throw new Error(entityError);
      return { sys_id: 'entity-1', name: 'Kaddiya', client_id: clientId, redirect_url: redirect, active: 'true' };
    },
    async instanceProperty(name) {
      return name === 'instance_id' ? snInstanceId : '';
    },
    async myRoleNames() {
      if (rolesError) throw new Error(rolesError);
      return roles;
    },
    async whoami() {
      return { sys_id: 'user-admin', user_name: 'admin', name: 'System Administrator' };
    },
  };
}

/**
 * An active org with one verified instance and an owner, built through the
 * real registration path (draft → instance draft → verification read-back).
 */
export async function seedOrg(name, { host = `${name}.service-now.com`, snInstanceId = `sn-${name}`, joinPolicy } = {}) {
  const { org: draft } = await tenancy.createOrgDraft({ name });
  const ctx = tenancy.contextFor(draft);
  const instance = await tenancy.addInstanceDraft(ctx, { host, clientId: 'c'.repeat(32), clientSecret: 'secret-' + name, label: 'prod' });
  const owner = { sys_id: `owner-${name}`, user_name: `owner.${name}`, name: `Owner of ${name}` };
  await tenancy.verifyInstance(ctx, instance.id, { sn: fakeSn({ snInstanceId }), user: owner, expectedRedirect: process.env.BASE_URL + '/auth/callback' });
  if (joinPolicy) await tenancy.updateOrgSettings(ctx, { join_policy: joinPolicy });
  const org = await tenancy.getOrg(draft.id);
  const fresh = tenancy.contextFor(org);
  const members = await tenancy.listMembers(fresh);
  return {
    org,
    ctx: fresh,
    instance: await tenancy.getInstance(fresh, instance.id),
    owner,
    ownerMember: members.find((m) => m.sn_user_sys_id === owner.sys_id),
    scope: { ctx: fresh, instanceId: instance.id, userSysId: owner.sys_id },
  };
}
