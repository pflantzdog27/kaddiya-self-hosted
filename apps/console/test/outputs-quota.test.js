// Aggregate quotas, under concurrency (spec §5, acceptance 11).
//
// The per-revision ceiling is easy: one number, one check. The aggregate
// ceilings are the interesting ones, because two saves that each see room can
// both commit unless the check and the insert are in the same transaction
// under the same lock. The limits are lowered through the environment here so
// the race can be provoked in a test rather than with 16 MB of fixtures —
// which is also a check that the environment can only lower them.

import { resetDb, close, seedOrg } from './helpers/db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.KADDIYA_OUTPUT_CONVERSATION_BYTES = '4000';
process.env.KADDIYA_OUTPUTS_PER_CONVERSATION = '3';
process.env.KADDIYA_REVISIONS_PER_OUTPUT = '2';

const outputs = await import('../server/outputs.js');
const store = await import('../server/store.js');

before(resetDb);
after(close);

const op = (label) => `${crypto.randomUUID()}:${label}`;

async function workspace(name) {
  const org = await seedOrg(name);
  const conv = await store.createConversation(org.scope);
  return { ...org, conv };
}

test('the environment can lower a limit but never raise one', async () => {
  assert.equal(outputs.LIMITS.conversationBytes, 4000, 'a lower value is taken');
  assert.equal(outputs.LIMITS.outputsPerConversation, 3);
  assert.equal(outputs.LIMITS.revisionsPerOutput, 2);

  const { execFileSync } = await import('node:child_process');
  const raised = JSON.parse(execFileSync(process.execPath, ['-e',
    "import('./server/outputs.js').then(m => console.log(JSON.stringify(m.LIMITS)))",
  ], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, KADDIYA_OUTPUT_MAX_BYTES: String(64 * 1024 * 1024), KADDIYA_OUTPUTS_PER_CONVERSATION: '9999' },
  }).toString());
  assert.equal(raised.revisionBytes, 256 * 1024, 'a value above the default is ignored');
  assert.equal(raised.outputsPerConversation, 50);
});

test('concurrent saves cannot both take the last of a conversation quota', async () => {
  const a = await workspace('acme-quota');
  const chunk = 'x'.repeat(1500);

  // Two saves that fit individually but not together, issued at once.
  const attempt = (label) => outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: label, filename: label, format: 'text',
    content: chunk, operationId: op(label),
  }).then(() => ({ ok: true }), (err) => ({ ok: false, code: err.code }));

  await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'first', filename: 'first', format: 'text',
    content: 'y'.repeat(1500), operationId: op('first'),
  });
  const results = await Promise.all([attempt('left'), attempt('right')]);
  const landed = results.filter((r) => r.ok).length;
  assert.equal(landed, 1, 'exactly one of the two fits, and the other is told so');
  assert.equal(results.find((r) => !r.ok).code, 'quota');

  // The refusal removed nothing and truncated nothing.
  const page = await outputs.listOutputs(a.scope, a.conv.id);
  assert.equal(page.outputs.length, 2);
  for (const file of page.outputs) {
    const read = await outputs.readOutput(a.scope, file.output_id);
    assert.equal(read.content.length, 1500, 'a saved file is whole or it is not there');
  }
});

test('the count and version ceilings refuse the write and keep the history', async () => {
  const a = await workspace('acme-count');
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const { reference } = await outputs.createOutput(a.scope, {
      conversationId: a.conv.id, title: `f${i}`, filename: `f${i}`, format: 'text', content: 'small', operationId: op(`c${i}`),
    });
    ids.push(reference.output_id);
  }
  await assert.rejects(outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'f4', filename: 'f4', format: 'text', content: 'small', operationId: op('c4'),
  }), (err) => err.code === 'quota' && /3 files/.test(err.message));
  assert.equal((await outputs.listOutputs(a.scope, a.conv.id)).outputs.length, 3, 'nothing was evicted to make room');

  await outputs.updateOutput(a.scope, {
    conversationId: a.conv.id, outputId: ids[0], expectedRevision: 1, content: 'v2', operationId: op('u1'),
  });
  await assert.rejects(outputs.updateOutput(a.scope, {
    conversationId: a.conv.id, outputId: ids[0], expectedRevision: 2, content: 'v3', operationId: op('u2'),
  }), (err) => err.code === 'quota' && /2 versions/.test(err.message));

  // Both existing versions survive the refusal, and both still read.
  const versions = await outputs.listRevisions(a.scope, ids[0]);
  assert.equal(versions.current_revision, 2);
  assert.equal(versions.revisions.length, 2);
  assert.equal((await outputs.readOutput(a.scope, ids[0], { revision: 1 })).content, 'small');
  assert.equal((await outputs.readOutput(a.scope, ids[0], { revision: 2 })).content, 'v2');
});
