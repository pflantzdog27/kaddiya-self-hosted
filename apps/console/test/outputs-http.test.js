// The output routes, over real HTTP against the real server (spec §7).
//
// What only an HTTP test can prove: the status codes, the cache and sniffing
// headers, the Content-Disposition on a download, that the bytes on the wire
// are the stored bytes, and that a second signed-in person gets a 404 rather
// than a 403 for a file that is not theirs.
//
// The embedded database allows one process at a time, so everything the
// fixtures need is written here first; then the pool is closed and the child
// takes the directory. Nothing in the child is stubbed.

import { resetDb, close, seedOrg, fakeSn } from './helpers/db.js';
import { startConsole, freePort } from './helpers/server.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as store from '../server/store.js';
import * as sessions from '../server/sessions.js';
import * as tenancy from '../server/tenancy.js';
import * as outputs from '../server/outputs.js';

const DOC = '# Escalation\n\nStep one — *page* the on-call.\n\n| When | Who |\n| --- | --- |\n| Business hours | Service desk |\n';
const V1 = '# Runbook\n\nFirst version.\n';
const V2 = '# Runbook\n\nFirst version.\n\n## After hours\n\nPage the on-call manager.\n';

let app;
let conversation;
let outsiderSid;
let outsiderConversation;
let blockedSid;
let blockedConversation;
let runbook;

before(async () => {
  await resetDb();

  const acme = await seedOrg('acme-http', { joinPolicy: 'auto' });
  conversation = await store.createConversation(acme.scope);
  const sid = await sessions.createSession({
    orgId: acme.org.id, instanceId: acme.instance.id, memberId: acme.ownerMember.id,
    userSysId: acme.owner.sys_id, user: acme.owner, tokens: { accessToken: 'a', refreshToken: 'r' }, ttlMs: 3_600_000,
  });

  // A two-version file, written through the service the way a turn will.
  const created = await outputs.createOutput(acme.scope, {
    conversationId: conversation.id, title: 'Runbook', filename: 'runbook',
    format: 'markdown', content: V1, operationId: `${crypto.randomUUID()}:c`,
  });
  await outputs.updateOutput(acme.scope, {
    conversationId: conversation.id, outputId: created.reference.output_id, expectedRevision: 1,
    content: V2, changeSummary: 'Added the after-hours exception', operationId: `${crypto.randomUUID()}:u`,
  });
  runbook = created.reference.output_id;

  // A second member of the same org: same instance, different person.
  const other = await tenancy.signinMember(acme.ctx, {
    org: acme.org, instance: acme.instance, sn: fakeSn(),
    user: { sys_id: 'outsider-1', user_name: 'outsider', name: 'Other Person' },
  });
  assert.equal(other.status, 'active', 'the fixture member must be admitted');
  outsiderConversation = await store.createConversation({ ctx: acme.ctx, instanceId: acme.instance.id, userSysId: 'outsider-1' });
  outsiderSid = await sessions.createSession({
    orgId: acme.org.id, instanceId: acme.instance.id, memberId: other.id,
    userSysId: 'outsider-1', user: { sys_id: 'outsider-1', user_name: 'outsider' },
    tokens: { accessToken: 'a', refreshToken: 'r' }, ttlMs: 3_600_000,
  });

  // A member who was admitted, made a file, and has since been blocked. Their
  // cookie is still valid bytes; their access is not.
  const revoked = await tenancy.signinMember(acme.ctx, {
    org: acme.org, instance: acme.instance, sn: fakeSn(),
    user: { sys_id: 'blocked-1', user_name: 'blocked.person', name: 'Blocked Person' },
  });
  const blockedScope = { ctx: acme.ctx, instanceId: acme.instance.id, userSysId: 'blocked-1' };
  const blockedConv = await store.createConversation(blockedScope);
  blockedConversation = blockedConv.id;
  await outputs.createOutput(blockedScope, {
    conversationId: blockedConv.id, title: 'Theirs', filename: 'theirs', format: 'text',
    content: 'written while they were active', operationId: `${crypto.randomUUID()}:b`,
  });
  blockedSid = await sessions.createSession({
    orgId: acme.org.id, instanceId: acme.instance.id, memberId: revoked.id,
    userSysId: 'blocked-1', user: { sys_id: 'blocked-1', user_name: 'blocked.person' },
    tokens: { accessToken: 'a', refreshToken: 'r' }, ttlMs: 3_600_000,
  });
  await tenancy.setMember(acme.ctx, revoked.id, { status: 'blocked', actor: 'owner' });

  await close();  // the child process takes the data directory from here
  app = await startConsole({ port: await freePort(), sid });
});

after(async () => { await app?.stop(); });

const save = (body, options) => app.post(`/api/conversations/${conversation.id}/outputs`, body, options);

test('an unauthenticated caller gets 401, never a file', async () => {
  for (const path of [
    `/api/conversations/${conversation.id}/outputs`,
    `/api/outputs/${runbook}`,
    `/api/outputs/${runbook}/download?revision=1`,
  ]) {
    const res = await app.get(path, { cookie: null });
    assert.equal(res.status, 401, path);
    await res.arrayBuffer();
  }
});

test('save as document, then read it back, list it, and download the exact bytes', async () => {
  const created = await app.json(await save({
    title: 'Incident escalation process', filename: 'Incident escalation process',
    format: 'markdown', content: DOC, operation_id: crypto.randomUUID(),
  }));
  assert.equal(created.revision, 1);
  assert.equal(created.filename, 'Incident escalation process.md');
  assert.equal(created.sha256, crypto.createHash('sha256').update(DOC, 'utf8').digest('hex'));

  const read = await app.get(`/api/outputs/${created.output_id}`);
  assert.equal(read.headers.get('cache-control'), 'private, no-store');
  assert.equal(read.headers.get('x-content-type-options'), 'nosniff');
  const body = await app.json(read);
  assert.equal(body.content, DOC);
  assert.equal(body.revision, 1);
  assert.equal(body.current_revision, 1);
  assert.equal(body.actor_kind, 'user');
  assert.equal(body.provenance.origin, 'user');

  const list = await app.json(await app.get(`/api/conversations/${conversation.id}/outputs`));
  const titles = list.outputs.map((o) => o.title);
  assert.ok(titles.includes('Incident escalation process'));
  assert.ok(list.outputs.every((o) => !('content' in o)), 'the list carries no body');

  const download = await app.get(`/api/outputs/${created.output_id}/download?revision=1`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="Incident escalation process\.md"/);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.toString('utf8'), DOC, 'the download is the stored bytes, not a re-render');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), created.sha256);

  // A download without a version is refused: a hand-over needs a number on it.
  const noVersion = await app.get(`/api/outputs/${created.output_id}/download`);
  assert.equal(noVersion.status, 400);
  await noVersion.arrayBuffer();
});

test('each version downloads as itself, and the head resolves without being named', async () => {
  const head = await app.json(await app.get(`/api/outputs/${runbook}`));
  assert.equal(head.revision, 2);
  assert.equal(head.content, V2);
  assert.equal(head.change_summary, 'Added the after-hours exception');

  const first = await app.get(`/api/outputs/${runbook}/download?revision=1`);
  assert.equal(await first.text(), V1, 'v1 is still exactly v1 after v2 exists');
  const second = await app.get(`/api/outputs/${runbook}/download?revision=2`);
  assert.equal(await second.text(), V2);

  const versions = await app.json(await app.get(`/api/outputs/${runbook}/revisions`));
  assert.equal(versions.current_revision, 2);
  assert.deepEqual(versions.revisions.map((r) => r.revision), [2, 1]);
  assert.equal(versions.revisions[0].change_summary, 'Added the after-hours exception');
  assert.equal(versions.revisions[0].byte_length, Buffer.byteLength(V2, 'utf8'));

  const missing = await app.get(`/api/outputs/${runbook}/download?revision=3`);
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
});

test('another member of the same org gets 404s, not 403s, for a file that is not theirs', async () => {
  const as = { cookie: outsiderSid };
  assert.equal((await app.get(`/api/outputs/${runbook}`, as)).status, 404);
  assert.equal((await app.get(`/api/outputs/${runbook}/revisions`, as)).status, 404);
  const denied = await app.get(`/api/outputs/${runbook}/download?revision=1`, as);
  assert.equal(denied.status, 404);
  await denied.arrayBuffer();

  // An unknown id answers identically, so nothing can be enumerated.
  const unknown = crypto.randomUUID();
  assert.deepEqual(
    await app.json(await app.get(`/api/outputs/${runbook}`, as)),
    await app.json(await app.get(`/api/outputs/${unknown}`, as)),
  );

  // Their own list does not show it, and they cannot list someone else's.
  assert.equal((await app.json(await app.get(`/api/conversations/${outsiderConversation.id}/outputs`, as))).outputs.length, 0);
  assert.equal((await app.json(await app.get(`/api/conversations/${conversation.id}/outputs`, as))).outputs.length, 0);

  // Nor can they save into a conversation that is not theirs.
  const intrusion = await app.post(`/api/conversations/${conversation.id}/outputs`,
    { title: 'X', filename: 'x', format: 'text', content: 'x', operation_id: crypto.randomUUID() }, as);
  assert.equal(intrusion.status, 404);
});

test('a blocked member loses the files on their very next request, including their own', async () => {
  const as = { cookie: blockedSid };
  // Blocking marks the member's sessions revoke-on-present (ADR 0008 D8), so
  // the first request after it both destroys the session and refuses — a 401
  // rather than a 403, and a stronger answer than the one a status check
  // alone would give.
  const list = await app.get(`/api/conversations/${blockedConversation}/outputs`, as);
  assert.equal(list.status, 401, 'the session died on presentation');
  assert.equal((await app.json(list)).error, 'not signed in');

  const save = await app.post(`/api/conversations/${blockedConversation}/outputs`,
    { title: 'X', filename: 'x', format: 'text', content: 'x', operation_id: crypto.randomUUID() }, as);
  assert.equal(save.status, 401, 'and the cookie cannot be presented a second time');

  // The file exists and belongs to them; nobody else can see it either.
  const theirs = await app.json(await app.get(`/api/conversations/${blockedConversation}/outputs`));
  assert.equal(theirs.outputs.length, 0, 'revocation is about the request; ownership is unchanged');
});

// Every route that can reach a file goes through the same gate the rest of
// the console uses. Read as source on purpose: a behavioural test proves the
// routes we thought to call are guarded; this proves the file contains no
// unguarded one.
test('no output route is reachable without an active membership', () => {
  const index = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  // Split the file into route handlers, then keep the ones whose path
  // mentions outputs. Splitting beats one clever regex here: a handler this
  // pattern failed to match would silently pass the gate.
  const handlers = index.split(/\napp\.(?=(?:get|post|patch|delete|put)\()/).slice(1);
  const outputRoutes = handlers
    .map((body) => ({ body, route: body.match(/^(get|post|patch|delete|put)\('([^']+)'/) }))
    .filter((h) => h.route && /\/outputs/.test(h.route[2]));

  const paths = outputRoutes.map((h) => `${h.route[1].toUpperCase()} ${h.route[2]}`);
  assert.deepEqual(paths.sort(), [
    'GET /api/conversations/:id/outputs',
    'GET /api/outputs/:id',
    'GET /api/outputs/:id/download',
    'GET /api/outputs/:id/revisions',
    'POST /api/conversations/:id/outputs',
  ], 'the output routes changed — every one of them is checked below');

  for (const handler of outputRoutes) {
    assert.match(handler.body, /const session = await requireActive\(req, res\);\s*\n\s*if \(!session\) return;/,
      `${handler.route[2]} does not require an active member before doing anything`);
  }
});

test('a save refuses a cross-origin request, an unknown format, and an oversized body', async () => {
  const foreign = await save(
    { title: 'X', filename: 'x', format: 'text', content: 'x', operation_id: crypto.randomUUID() },
    { headers: { origin: 'https://evil.example' } },
  );
  assert.equal(foreign.status, 403, 'the CSRF boundary covers the new mutation');

  const badFormat = await save({ title: 'X', filename: 'x', format: 'xlsx', content: 'x', operation_id: crypto.randomUUID() });
  assert.equal(badFormat.status, 400);
  assert.equal((await app.json(badFormat)).code, 'invalid');

  const huge = await save({ title: 'Big', filename: 'big', format: 'text', content: 'x'.repeat(300 * 1024), operation_id: crypto.randomUUID() });
  assert.equal(huge.status, 413);
  assert.equal((await app.json(huge)).code, 'too_large');

  assert.equal((await save({ title: 'X', filename: 'x', format: 'text', content: 'x' })).status, 400);
});

test('an html code output downloads as an attachment that this origin will not run', async () => {
  const created = await app.json(await save({
    title: 'Report page', filename: 'report', format: 'code', language: 'html',
    content: '<script>alert(document.cookie)</script>', operation_id: crypto.randomUUID(),
  }));
  assert.equal(created.filename, 'report.html', 'the extension tells the truth');

  const res = await app.get(`/api/outputs/${created.output_id}/download?revision=1`);
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8',
    'HTML is source and a file, never a document this origin serves inline');
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await res.text(), '<script>alert(document.cookie)</script>');
});

test('a hostile filename cannot break out of the Content-Disposition header', async () => {
  const created = await app.json(await save({
    title: 'Sanktionsprüfung "urgent"\r\nX-Injected: yes',
    filename: '../../etc/passwd"\r\nX-Injected: yes',
    format: 'markdown', content: '# ok\n', operation_id: crypto.randomUUID(),
  }));
  const res = await app.get(`/api/outputs/${created.output_id}/download?revision=1`);
  const disposition = res.headers.get('content-disposition');
  // The property is not that the words vanish — a person may legitimately
  // name a file "X-Injected" — it is that nothing in the name can end the
  // header, end the quoted string, or start a second header.
  assert.doesNotMatch(disposition, /[\r\n]/, 'no header break survives');
  assert.doesNotMatch(disposition, /[:;]\s*X-Injected/i, 'nothing reads as a new header');
  assert.equal(res.headers.get('x-injected'), null, 'and no second header appeared');
  assert.match(disposition, /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  assert.equal(disposition.split('"').length, 3, 'exactly one quoted filename: no quote escaped out');
  await res.arrayBuffer();
});

test('the operation id makes a replayed save idempotent over HTTP', async () => {
  const operation_id = crypto.randomUUID();
  const body = { title: 'Once', filename: 'once', format: 'text', content: 'only once', operation_id };
  const first = await app.json(await save(body));
  const again = await app.json(await save(body));
  assert.equal(again.output_id, first.output_id, 'a retried save returns the file it already made');
  assert.equal(again.revision, 1);

  const different = await save({ ...body, content: 'something else' });
  assert.equal(different.status, 409);
  assert.equal((await app.json(different)).code, 'duplicate_operation');
});

test('deleting the conversation makes its downloads 404', async () => {
  const doomed = await app.json(await save({
    title: 'Doomed', filename: 'doomed', format: 'markdown', content: '# bye\n', operation_id: crypto.randomUUID(),
  }));
  const before = await app.get(`/api/outputs/${doomed.output_id}/download?revision=1`);
  assert.equal(before.status, 200);
  await before.arrayBuffer();

  assert.equal((await app.del(`/api/conversations/${conversation.id}`)).status, 200);
  assert.equal((await app.get(`/api/outputs/${doomed.output_id}`)).status, 404);
  const after = await app.get(`/api/outputs/${doomed.output_id}/download?revision=1`);
  assert.equal(after.status, 404);
  await after.arrayBuffer();
});
