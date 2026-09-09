// Notebook governance, pinned (ADR 0008 D5).
//
// The notebook is the one write the agent makes without a human click, and
// what it writes lands in every future system prompt for the instance. That is
// a cross-user prompt-injection channel unless a human gates it — so the
// invariant under test is narrow and absolute: a note reaches
// notesForPrompt() only after keepNote(), never before. And a note is scoped
// to the instance it was learned on (D5): a second instance in the same org
// does not inherit it.

import { resetDb, close, seedOrg, fakeSn } from './helpers/db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as tenancy from '../server/tenancy.js';
import { saveNote, keepNote, discardNote, listNotes, notesForPrompt } from '../server/notebook.js';

let scope;
before(async () => {
  await resetDb();
  scope = (await seedOrg('notebook')).scope;
});
after(close);

test('a saved note is pending, and pending notes are not injected', async () => {
  const { note } = await saveNote(scope, {
    text: 'State 4 on incident was renamed to "Awaiting vendor" here.',
    context: 'incident',
    user: 'dana.whitfield',
    conversation: '11111111-1111-4111-8111-111111111111',
  });

  assert.equal(note.status, 'pending');
  assert.equal(await notesForPrompt(scope), '', 'a pending note must not reach the system prompt');
});

test('keeping a note records who kept it and its source conversation', async () => {
  const { note } = await saveNote(scope, {
    text: 'Requests route by location, not by assignment group.',
    user: 'dana.whitfield',
    conversation: '22222222-2222-4222-8222-222222222222',
  });

  const kept = await keepNote(scope, note.id, { user: 'sam.okafor', conversation: '22222222-2222-4222-8222-222222222222' });
  assert.equal(kept.status, 'kept');
  assert.equal(kept.kept_by, 'sam.okafor');
  assert.equal(kept.conversation, '22222222-2222-4222-8222-222222222222');
  assert.ok(kept.kept_at, 'kept_at is stamped');

  const injected = await notesForPrompt(scope);
  assert.match(injected, /Requests route by location/);
  assert.match(injected, /kept by sam\.okafor/, 'attribution rides along into the prompt');
});

test('only kept notes are injected, and discarded notes are gone', async () => {
  const keep = (await saveNote(scope, { text: 'Kept fact about this instance.' })).note;
  const pending = (await saveNote(scope, { text: 'Unreviewed fact about this instance.' })).note;
  const drop = (await saveNote(scope, { text: 'Rejected fact about this instance.' })).note;

  await keepNote(scope, keep.id, { user: 'dana.whitfield' });
  assert.equal(await discardNote(scope, drop.id), true);

  const injected = await notesForPrompt(scope);
  assert.match(injected, /Kept fact/);
  assert.doesNotMatch(injected, /Unreviewed fact/);
  assert.doesNotMatch(injected, /Rejected fact/);

  const ids = (await listNotes(scope)).map((n) => n.id);
  assert.ok(ids.includes(pending.id), 'the pending note still exists for its own conversation');
  assert.ok(!ids.includes(drop.id), 'the discarded note is gone');
});

test('a duplicate of a kept note stays kept; a duplicate of a pending note stays pending', async () => {
  const kept = (await saveNote(scope, { text: 'Duplicate me.' })).note;
  await keepNote(scope, kept.id, { user: 'dana.whitfield' });
  const again = await saveNote(scope, { text: 'duplicate me.' });
  assert.equal(again.updated, true);
  assert.equal(again.note.status, 'kept');
  assert.equal(again.note.id, kept.id);
});

test('notes are scoped to the instance they were learned on', async () => {
  const org = await tenancy.getOrg(scope.ctx.orgId);
  const ctx = tenancy.contextFor(org);
  const dev = await tenancy.addInstanceDraft(ctx, { host: 'notebookdev.service-now.com', clientId: 'g'.repeat(32), clientSecret: 'secret-dev' });
  await tenancy.verifyInstance(ctx, dev.id, { sn: fakeSn({ snInstanceId: 'sn-notebook-dev' }), user: { sys_id: 'a', user_name: 'a' }, expectedRedirect: process.env.BASE_URL + '/auth/callback' });
  const devScope = { ctx, instanceId: dev.id };
  assert.equal(await notesForPrompt(devScope), '', 'prod notes do not leak into dev');
  assert.match(await notesForPrompt(scope), /Requests route by location/);
});
