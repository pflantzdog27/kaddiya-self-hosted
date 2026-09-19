// The release-blocking isolation gates of ADR 0008 D6, as tests:
//   (a) schema gate — every tenant table carries RLS and an org policy with
//       both USING and WITH CHECK; content tables FORCE it on the owner too;
//   (b) two seeded orgs probe every store — nothing crosses;
//   (c) a query outside withOrg() errors rather than returns;
//   (d) lives in keys.test.js (org B's ciphertext fails under org A);
//   (e) the directory role is used only where the module comment in
//       server/db.js says it may be.

import { resetDb, close, seedOrg } from './helpers/db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { system, withOrg, APP_ROLE } from '../server/db.js';
import * as store from '../server/store.js';
import * as outputs from '../server/outputs.js';
import * as notebook from '../server/notebook.js';
import { audit, listAudit } from '../server/audit.js';
import * as tenancy from '../server/tenancy.js';
import { recordUsage, usageSummary } from '../server/billing.js';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');

before(resetDb);
after(close);

test('(a) every table with an org_id column has RLS and a policy with USING and WITH CHECK', async () => {
  const { rows: tables } = await system((c) => c.query(
    `SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'org_id'`,
  ));
  const names = tables.map((t) => t.table_name).concat('orgs').sort();
  assert.ok(names.length >= 10, `expected the tenant tables, found ${names.join(', ')}`);

  for (const table of names) {
    const { rows: [rel] } = await system((c) => c.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table],
    ));
    assert.equal(rel.relrowsecurity, true, `${table}: row level security is not enabled`);
    const { rows: policies } = await system((c) => c.query(
      `SELECT polname, polroles, pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS with_check
         FROM pg_policy WHERE polrelid = $1::regclass`, [table],
    ));
    const tenant = policies.find((p) => p.qual && p.qual.includes('app.org_id'));
    assert.ok(tenant, `${table}: no policy reads app.org_id`);
    assert.ok(tenant.with_check && tenant.with_check.includes('app.org_id'), `${table}: policy has no WITH CHECK on app.org_id`);
  }

  // Content tables are forced: the owner role cannot read across orgs either.
  for (const table of ['conversations', 'notebook_entries', 'audit_events', 'usage_events', 'members',
    'outputs', 'output_revisions', 'conversation_turns']) {
    const { rows: [rel] } = await system((c) => c.query(`SELECT relforcerowsecurity FROM pg_class WHERE relname = $1`, [table]));
    assert.equal(rel.relforcerowsecurity, true, `${table}: FORCE ROW LEVEL SECURITY is off`);
  }

  const { rows: [role] } = await system((c) => c.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = $1`, [APP_ROLE]));
  assert.equal(role.rolbypassrls, false, 'the app role must be NOBYPASSRLS');
});

test('(b) two seeded orgs: conversations, notes, audit, usage and members never cross', async () => {
  const a = await seedOrg('acme');
  const b = await seedOrg('globex');

  const conv = await store.createConversation(a.scope);
  await store.saveConversation(a.scope, { ...conv, messages: [{ role: 'user', content: 'INC0010001 from acme' }] });
  const noteA = (await notebook.saveNote(a.scope, { text: 'Acme renamed state 4.', user: 'owner.acme' })).note;
  await notebook.keepNote(a.scope, noteA.id, { user: 'owner.acme' });
  await audit(a.scope, { user: 'owner.acme', action: 'write', table: 'incident', sys_id: 'x', query: 'active=true' });
  await recordUsage(a.ctx, { instanceId: a.instance.id, provider: 'trial', usage: { input_tokens: 10, output_tokens: 5 }, cost: 0.01 });

  // Through the stores, with B's context and even A's ids.
  const bScope = { ctx: b.ctx, instanceId: a.instance.id, userSysId: a.owner.sys_id };
  assert.equal(await store.getConversation(bScope, conv.id), null, 'B reads A conversation by id');
  assert.deepEqual(await store.listConversations(bScope), [], 'B lists A conversations');
  assert.equal(await notebook.notesForPrompt(bScope), '', 'B prompt sees A notes');
  assert.equal(await notebook.keepNote(bScope, noteA.id, { user: 'x' }), null, 'B keeps A note');
  assert.equal(await notebook.discardNote(bScope, noteA.id), false, 'B discards A note');
  assert.deepEqual(await listAudit(b.scope), [], 'B reads A audit');
  assert.equal((await usageSummary(b.ctx)).turns_total, 0, 'B sees A usage');
  assert.equal(await store.deleteConversation(bScope, conv.id), false, 'B deletes A conversation');
  assert.equal((await tenancy.listMembers(b.ctx)).some((m) => m.sn_user_sys_id === a.owner.sys_id), false, 'B lists A members');

  // Raw SQL under B's context: the wall holds without a WHERE clause.
  for (const table of ['conversations', 'notebook_entries', 'audit_events', 'usage_events', 'members', 'instances', 'sessions']) {
    const { rows } = await withOrg(b.org.id, (c) => c.query(`SELECT org_id FROM ${table}`));
    assert.ok(rows.every((r) => r.org_id === b.org.id), `${table}: B's context returned a row of another org`);
  }

  // WITH CHECK: B cannot write a row stamped with A's org_id.
  await assert.rejects(
    withOrg(b.org.id, (c) => c.query(
      `INSERT INTO conversations (id, org_id, instance_id, sn_user_sys_id, body_enc) VALUES (gen_random_uuid(), $1, $2, 'u', '\\x00')`,
      [a.org.id, a.instance.id],
    )),
    /row-level security/,
  );

  // A still sees its own.
  assert.equal((await store.listConversations(a.scope)).length, 1);
  assert.match(await notebook.notesForPrompt(a.scope), /Acme renamed/);
  assert.equal((await listAudit(a.scope)).length, 1);
  assert.equal((await listAudit(a.scope))[0].query, 'active=true', 'the encrypted payload round-trips for its own org');
});

test('(c) a tenant query outside withOrg() errors instead of returning rows', async () => {
  await assert.rejects(
    system(async (c) => {
      await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
      return c.query('SELECT * FROM conversations');
    }),
    /app\.org_id|invalid input syntax for type uuid/,
  );
});

test('audit_events is append-only for the app role', async () => {
  const a = await seedOrg('appendonly');
  await audit(a.scope, { user: 'x', action: 'write' });
  await assert.rejects(withOrg(a.org.id, (c) => c.query('UPDATE audit_events SET action = $1', ['tampered'])), /permission denied/);
  await assert.rejects(withOrg(a.org.id, (c) => c.query('DELETE FROM audit_events')), /permission denied/);
});

// The same append-only shape for saved versions: an output revision is what
// a person downloaded and handed to someone. The application may add one and
// may let a deleted conversation cascade it away; it may not rewrite one.
test('output_revisions is append-only for the app role, and still cascades', async () => {
  const a = await seedOrg('outputsappend');
  const conv = await store.createConversation(a.scope);
  const { reference } = await outputs.createOutput(a.scope, {
    conversationId: conv.id, title: 'Held', filename: 'held', format: 'markdown',
    content: 'kept', operationId: `${conv.id}:1`,
  });
  await assert.rejects(withOrg(a.org.id, (c) => c.query('UPDATE output_revisions SET byte_length = 0')), /permission denied/);
  await assert.rejects(withOrg(a.org.id, (c) => c.query('DELETE FROM output_revisions')), /permission denied/);
  assert.equal((await outputs.readOutput(a.scope, reference.output_id)).content, 'kept');
  // Deleting the parent is allowed, and takes the revision with it: the
  // referential action runs as the table's owner, past both the grant and
  // the policy, which is what makes a revoked DELETE safe here.
  await store.deleteConversation(a.scope, conv.id);
  assert.equal(await outputs.readOutput(a.scope, reference.output_id), null);
});

test('(e) the directory role appears only in the modules allowed to use it', () => {
  // `site-chat.js` was on this list and is not in server/ — a stale allowance
  // widens the gate for a file nobody has reviewed, so it is gone (ADR 0014,
  // drift found in passing). `sessions.js` covers the MCP bearer lookup too:
  // a bearer resolves to an org before the tenant is known, as a cookie does.
  const ALLOWED = new Set(['db.js', 'tenancy.js', 'sessions.js', 'billing.js']);
  for (const file of fs.readdirSync(SERVER_DIR).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
    const uses = /\bsystem\(/.test(source);
    assert.ok(!uses || ALLOWED.has(file), `${file} calls system() — tenant work goes through withOrg()`);
  }
});
