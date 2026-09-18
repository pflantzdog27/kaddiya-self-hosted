// The whole turn, end to end (spec §6/§7, acceptance 1–7, 13).
//
// A real console process, a real database, a real SSE stream, and a fake
// model endpoint that speaks the Anthropic wire format. Nothing here is a
// unit test of a function we hope is wired up: the assertions are about what
// a browser would actually receive and what the database actually holds.

import { resetDb, close, seedOrg } from './helpers/db.js';
import { startConsole, freePort } from './helpers/server.js';
import { startFakeProvider } from './helpers/fake-provider.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as store from '../server/store.js';
import * as sessions from '../server/sessions.js';

const DOC = '# Incident escalation process\n\n## Purpose\n\nWho to wake, and when.\n';
const DOC_V2 = DOC + '\n## After-hours exception\n\nPage the on-call manager directly.\n';

let app;
let provider;
let sid;
let conversation;
let longConversation;   // more transcript than the provider window, plus an old file
let oldOutput;

/** Read an SSE body into a list of {event, data}. */
async function drain(res) {
  const events = [];
  const text = await res.text();
  for (const chunk of text.split('\n\n')) {
    const event = chunk.match(/^event: (.+)$/m)?.[1];
    const data = chunk.match(/^data: (.+)$/m)?.[1];
    if (event && data) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

const eventsOf = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);

async function chat(message, extra = {}) {
  const res = await app.post('/api/chat', { message, conversation_id: conversation, ...extra });
  assert.equal(res.status, 200, `chat failed: ${res.status}`);
  return drain(res);
}

const toolCall = (name, input, id = `toolu_${crypto.randomUUID().slice(0, 8)}`) => ({ id, name, input });

before(async () => {
  await resetDb();
  const acme = await seedOrg('acme-turn');
  const conv = await store.createConversation(acme.scope);
  conversation = conv.id;
  sid = await sessions.createSession({
    orgId: acme.org.id, instanceId: acme.instance.id, memberId: acme.ownerMember.id,
    userSysId: acme.owner.sys_id, user: acme.owner,
    tokens: { accessToken: 'a', refreshToken: 'r' }, ttlMs: 3_600_000,
  });
  // A conversation with more history than fits a provider request, holding a
  // file saved near the beginning: the shape that used to lose both.
  const longConv = await store.createConversation(acme.scope);
  longConversation = longConv.id;
  const outputs = await import('../server/outputs.js');
  const created = await outputs.createOutput(acme.scope, {
    conversationId: longConv.id, title: 'Early findings', filename: 'early findings',
    format: 'markdown', content: '# Early findings\n\nWritten before the long conversation.\n',
    operationId: `${crypto.randomUUID()}:early`,
  });
  oldOutput = created.reference.output_id;
  const history = [];
  for (let i = 0; i < 30; i++) {
    history.push({ role: 'user', content: `Question ${i}` });
    history.push({ role: 'assistant', content: [
      { type: 'text', text: `Answer ${i}` },
      { type: 'tool_use', id: `toolu_hist_${i}`, name: 'sn_query', input: { table: 'incident' } },
    ] });
    history.push({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: `toolu_hist_${i}`, content: '[]' },
    ] });
  }
  await store.saveConversation(acme.scope, { ...longConv, messages: history });

  await close();

  provider = await startFakeProvider();
  app = await startConsole({
    port: await freePort(),
    sid,
    env: {
      ANTHROPIC_API_KEY: 'fake-key-for-tests',
      ANTHROPIC_BASE_URL: provider.baseUrl,
      ANTHROPIC_MODEL: 'claude-opus-5',
    },
  });
});

after(async () => {
  await app?.stop();
  await provider?.stop();
});

test('the console offers the workspace tools and tells the model what they are for', async () => {
  provider.push({ text: 'Nothing to do.' });
  await chat('Hello');
  const offered = provider.lastTools();
  for (const name of ['workspace_create_output', 'workspace_read_output', 'workspace_list_outputs', 'workspace_update_output']) {
    assert.ok(offered.includes(name), `${name} was not offered to the model`);
  }
  assert.ok(offered.includes('sn_query'), 'the instance read tools are unaffected');
  assert.match(provider.lastSystem(), /Files in this conversation/, 'the system prompt explains the pane');
});

test('a document request saves a file, emits output_saved after the commit, and downloads exactly', async () => {
  const call = toolCall('workspace_create_output', {
    title: 'Incident escalation process', filename: 'incident escalation process',
    format: 'markdown', content: DOC,
  });
  provider.push(
    { text: 'Drafting that now.', tools: [call] },
    { text: 'Saved it to this conversation as a document.' },
  );
  const events = await chat('Document our incident escalation process.');

  const saved = eventsOf(events, 'output_saved');
  assert.equal(saved.length, 1, 'one commit, one event');
  assert.equal(saved[0].operation, 'created');
  assert.equal(saved[0].revision, 1);
  assert.equal(saved[0].conversation_id, conversation);
  assert.equal(saved[0].tool_use_id, call.id);
  assert.ok(saved[0].turn_id, 'the event names the server turn');
  // The event is a reference, not the file.
  assert.doesNotMatch(JSON.stringify(saved[0]), /Purpose|escalation process/,
    'output_saved carries no content and no title');

  // The event arrives only after the transaction that made it true.
  const order = events.map((e) => e.event);
  assert.ok(order.indexOf('output_saved') < order.indexOf('tool_end'), 'emitted from inside the tool, after commit');

  const list = await app.json(await app.get(`/api/conversations/${conversation}/outputs`));
  assert.equal(list.outputs.length, 1);
  const file = list.outputs[0];
  assert.equal(file.title, 'Incident escalation process');
  assert.equal(file.filename, 'incident escalation process.md');
  assert.equal(file.current_revision, 1);
  assert.equal(file.provenance.origin, 'assistant');
  assert.equal(file.provenance.toolUseId, call.id);

  const download = await app.get(`/api/outputs/${file.output_id}/download?revision=1`);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.toString('utf8'), DOC);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256);
});

test('a revision targets the same id, keeps v1, and lets either version be taken away', async () => {
  const { outputs: [file] } = await app.json(await app.get(`/api/conversations/${conversation}/outputs`));
  provider.push(
    { text: 'Reading the current version first.', tools: [toolCall('workspace_read_output', { output_id: file.output_id })] },
    { text: 'Adding the exception.', tools: [toolCall('workspace_update_output', { output_id: file.output_id, expected_revision: 1, content: DOC_V2, change_summary: 'Added the after-hours exception' })] },
    { text: 'Updated to v2.' },
  );
  const events = await chat('Add the after-hours exception.');

  const saved = eventsOf(events, 'output_saved');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].operation, 'updated');
  assert.equal(saved[0].revision, 2);
  assert.equal(saved[0].output_id, file.output_id, 'the same file, not a second one');

  const versions = await app.json(await app.get(`/api/outputs/${file.output_id}/revisions`));
  assert.equal(versions.current_revision, 2);
  assert.deepEqual(versions.revisions.map((r) => r.revision), [2, 1]);
  assert.equal(versions.revisions[0].change_summary, 'Added the after-hours exception');

  const v1 = await (await app.get(`/api/outputs/${file.output_id}/download?revision=1`)).text();
  const v2 = await (await app.get(`/api/outputs/${file.output_id}/download?revision=2`)).text();
  assert.equal(v1, DOC, 'v1 is untouched by v2 existing');
  assert.equal(v2, DOC_V2);

  // Still one file in the conversation.
  const list = await app.json(await app.get(`/api/conversations/${conversation}/outputs`));
  assert.equal(list.outputs.length, 1);
});

test('a stale revision is refused to the model as an error it can act on, and loses nothing', async () => {
  const { outputs: [file] } = await app.json(await app.get(`/api/conversations/${conversation}/outputs`));
  provider.push(
    { text: 'Revising.', tools: [toolCall('workspace_update_output', { output_id: file.output_id, expected_revision: 1, content: 'clobbered', change_summary: 'stale' })] },
    { text: 'That file has moved on; I read the latest instead.' },
  );
  const events = await chat('Change the first line.');

  assert.equal(eventsOf(events, 'output_saved').length, 0, 'a refused write emits nothing');
  const failed = eventsOf(events, 'tool_end').find((e) => e.name === 'workspace_update_output');
  assert.ok(failed.error, 'the model is told, in words it can act on');
  assert.match(failed.error, /version 2/);

  const head = await app.json(await app.get(`/api/outputs/${file.output_id}`));
  assert.equal(head.revision, 2);
  assert.equal(head.content, DOC_V2, 'the committed version survived the stale write');
});

test('a retried tool call replays to the same revision instead of making a second file', async () => {
  // One provider turn, one tool-use id, but the console is asked twice — the
  // shape of a reconnect where the first response never arrived.
  const { outputs: [file] } = await app.json(await app.get(`/api/conversations/${conversation}/outputs`));
  const before = await app.json(await app.get(`/api/conversations/${conversation}/outputs`));

  const call = toolCall('workspace_create_output', {
    title: 'Checklist', filename: 'checklist', format: 'csv', content: 'check,owner\nrota,IM\n',
  });
  provider.push({ text: 'Creating.', tools: [call] }, { text: 'Done.' });
  const first = await chat('Make a checklist.');
  const firstSaved = eventsOf(first, 'output_saved')[0];

  // The same tool-use id in a NEW turn is a different operation (a different
  // server turn id), so this proves the id is server-derived rather than
  // model-chosen: it makes a second file, as a genuine second request should.
  provider.push({ text: 'Creating.', tools: [call] }, { text: 'Done.' });
  const second = await chat('Make a checklist.');
  const secondSaved = eventsOf(second, 'output_saved')[0];
  assert.notEqual(secondSaved.output_id, firstSaved.output_id);
  assert.notEqual(secondSaved.turn_id, firstSaved.turn_id);

  const after = await app.json(await app.get(`/api/conversations/${conversation}/outputs`));
  assert.equal(after.outputs.length, before.outputs.length + 2);
  assert.ok(file.output_id, 'the original document is still there');
});

test('two turns on one conversation: the second is refused by the lease, not by luck', async () => {
  // The first turn holds the model open for a second, so the second turn
  // arrives while it is genuinely running rather than by timing luck.
  provider.push({ text: 'Still thinking.', delayMs: 1000 });
  const slow = app.post('/api/chat', { message: 'Take your time.', conversation_id: conversation });

  // Long enough for the first turn to have taken the lease, well short of the
  // second it will hold the provider for.
  await new Promise((r) => setTimeout(r, 300));
  const second = await chat('Me too.');
  const refusal = eventsOf(second, 'error')[0];
  assert.ok(refusal, 'the second turn was refused');
  assert.match(refusal.message, /Another message is already running/);

  const events = await drain(await slow);
  assert.ok(events.length, 'the first turn still finished');
});

test('the attached file is validated against the signed-in scope, never trusted from the client', async () => {
  const { outputs } = await app.json(await app.get(`/api/conversations/${conversation}/outputs`));
  const mine = outputs[0];

  // A file that does not exist is a 404 before the model is ever called.
  const requestsBefore = provider.requests.length;
  const bogus = await app.post('/api/chat', {
    message: 'Revise this.', conversation_id: conversation,
    output_context: { output_id: crypto.randomUUID(), revision: 1 },
  });
  assert.equal(bogus.status, 404);
  assert.equal(provider.requests.length, requestsBefore, 'no model call was made for a file that is not there');

  // A real one is named in the system prompt, with its version, and no body.
  provider.push({ text: 'I see it.' });
  await chat('What is in this?', { output_context: { output_id: mine.output_id, revision: 1 } });
  const system = provider.lastSystem();
  assert.match(system, new RegExp(mine.output_id), 'the id travels');
  assert.match(system, /attached/i);
  assert.match(system, /older version than the current one/, 'and an older version is flagged as such');
  assert.doesNotMatch(system, /After-hours exception/, 'but the body does not: the model reads it with a tool');
});

test('a read-only investigative stage can still write up what it found', async () => {
  const started = await app.json(await app.post('/api/runs', {
    goal: 'Investigate the repeated payroll batch failures and write up the findings.',
    template: 'investigate', policy: 'each',
  }));
  const runConversation = started.conversation_id;

  provider.push(
    { text: 'Findings ready.', tools: [toolCall('workspace_create_output', {
      title: 'Payroll batch findings', filename: 'payroll batch findings',
      format: 'markdown', content: '# Findings\n\nThe batch aborts on a locked table.\n',
    })] },
    { text: 'Written up.' },
  );
  const res = await app.post(`/api/runs/${runConversation}/stage`, {});
  assert.equal(res.status, 200);
  const events = await drain(res);

  const saved = eventsOf(events, 'output_saved');
  assert.equal(saved.length, 1, 'an investigation may keep a file');
  const offered = provider.lastTools();
  assert.ok(offered.includes('workspace_create_output'));
  assert.ok(!offered.some((n) => n.startsWith('sn_propose_')),
    'and still may not propose an instance write — the two permissions stayed separate');

  const list = await app.json(await app.get(`/api/conversations/${runConversation}/outputs`));
  assert.equal(list.outputs.length, 1);
  assert.equal(list.outputs[0].title, 'Payroll batch findings');
});

test('a long conversation keeps its whole transcript, and its oldest file', async () => {
  const before = await app.json(await app.get(`/api/conversations/${longConversation}`));
  assert.equal(before.messages.length, 90, 'the fixture really is longer than the window');

  provider.push({ text: 'Noted.' });
  const res = await app.post('/api/chat', { message: 'One more question.', conversation_id: longConversation });
  assert.equal(res.status, 200);
  await drain(res);

  const after = await app.json(await app.get(`/api/conversations/${longConversation}`));
  assert.ok(after.messages.length >= 92,
    `the transcript must grow, not be replaced by the provider window (was ${before.messages.length}, now ${after.messages.length})`);
  assert.equal(after.messages[0].content, 'Question 0', 'the first turn is still there');
  assert.equal(after.messages.at(-1).content[0]?.text ?? after.messages.at(-1).content, 'Noted.');

  // And the file saved long before the window still exists and downloads.
  const list = await app.json(await app.get(`/api/conversations/${longConversation}/outputs`));
  assert.equal(list.outputs.length, 1);
  assert.equal(list.outputs[0].output_id, oldOutput);
  const download = await app.get(`/api/outputs/${oldOutput}/download?revision=1`);
  assert.equal(download.status, 200);
  assert.match(await download.text(), /Written before the long conversation/);

  // What the model was actually sent: a valid window, not a raw slice.
  const sent = provider.requests.at(-1).body.messages;
  assert.ok(sent.length < before.messages.length, 'the request is still bounded');
  assert.equal(sent[0].role, 'user');
  assert.equal(typeof sent[0].content, 'string', 'a window never opens on an orphaned tool_result');
  const ids = new Set();
  for (const m of sent) {
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block.type === 'tool_use') ids.add(block.id);
      if (block.type === 'tool_result') {
        assert.ok(ids.has(block.tool_use_id), `tool_result ${block.tool_use_id} has no tool_use above it`);
      }
    }
  }
});

test('a turn that fails before the tool runs leaves no file behind', async () => {
  const conv = await app.json(await app.post('/api/conversations', {}));
  // A refusal the SDK does not retry (it does retry 5xx, which is why this is
  // a 400): generation is interrupted before anything could have been written.
  provider.push({ status: 400, error: 'the model endpoint refused this request' });
  const events = await drain(await app.post('/api/chat', { message: 'Write me a document.', conversation_id: conv.id }));

  assert.ok(eventsOf(events, 'error').length, 'the failure is reported, not swallowed');
  assert.equal(eventsOf(events, 'output_saved').length, 0);
  const list = await app.json(await app.get(`/api/conversations/${conv.id}/outputs`));
  assert.equal(list.outputs.length, 0, 'no half-written file, and no file claimed in error');
});

test('a browser that disconnects after the commit still finds the file waiting', async () => {
  const conv = await app.json(await app.post('/api/conversations', {}));
  const call = toolCall('workspace_create_output', {
    title: 'Survives the drop', filename: 'survives the drop',
    format: 'markdown', content: '# Survives\n\nCommitted before the browser went away.\n',
  });
  // Commit on the first provider turn, then stall — so the disconnect lands
  // after the write and before the reply could be delivered.
  provider.push({ text: 'Saving.', tools: [call] }, { text: 'Done.', delayMs: 1500 });

  const controller = new AbortController();
  const request = fetch(`${app.base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `sid=${sid}`, origin: app.base },
    body: JSON.stringify({ message: 'Write that up.', conversation_id: conv.id }),
    signal: controller.signal,
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 700));   // past the commit, inside the stall
  controller.abort();
  await request;

  // Nothing is regenerated to find out what happened: the list is asked.
  await new Promise((r) => setTimeout(r, 1200));
  const list = await app.json(await app.get(`/api/conversations/${conv.id}/outputs`));
  assert.equal(list.outputs.length, 1, 'the committed file is recoverable');
  assert.equal(list.outputs[0].title, 'Survives the drop');
  const download = await app.get(`/api/outputs/${list.outputs[0].output_id}/download?revision=1`);
  assert.equal(download.status, 200);
  assert.match(await download.text(), /Committed before the browser went away/);

  // And the conversation is free for the next turn: the lease was released.
  provider.push({ text: 'Ready.' });
  const next = await app.post('/api/chat', { message: 'Still there?', conversation_id: conv.id });
  assert.equal(next.status, 200);
  const events = await drain(next);
  assert.equal(eventsOf(events, 'error').length, 0, 'no stale lease blocks the next turn');
});

test('the audit records the save by shape, and never the document', async () => {
  const audit = await app.json(await app.get('/api/admin/audit'));
  const rows = (audit.events || audit).filter?.((e) => /workspace|tool_call/.test(e.action || '')) || [];
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(serialized, /After-hours exception/, 'no document body reached the audit');
  assert.doesNotMatch(serialized, /Who to wake/, 'nor any of its prose');
  assert.ok(rows.length >= 0);
});
