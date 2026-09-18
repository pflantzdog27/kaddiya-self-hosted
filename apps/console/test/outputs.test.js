// The output store, against a real database (spec §5, acceptance 1–9).
//
// Everything here runs on PGlite (or TEST_DATABASE_URL when CI supplies
// PostgreSQL) through the same withOrg() wall the console uses. The
// interesting assertions are the negative ones: another org, another member,
// another instance, a stale version, a replayed operation, a moved ciphertext.

import { resetDb, close, seedOrg } from './helpers/db.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { system, withOrg } from '../server/db.js';
import * as store from '../server/store.js';
import * as outputs from '../server/outputs.js';
import { OutputError, LIMITS, safeFilename, extensionFor } from '../server/outputs.js';

before(resetDb);
after(close);

const DOC = '# Incident escalation\n\nRoles, steps, and the after-hours exception.\n';

async function workspace(name) {
  const org = await seedOrg(name);
  const conv = await store.createConversation(org.scope);
  return { ...org, conv };
}

function op(label) {
  return `${crypto.randomUUID()}:${label}`;
}

test('a create saves one immutable revision, retrievable by id and by version', async () => {
  const a = await workspace('acme-create');
  const { reference } = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id,
    title: 'Incident escalation process',
    filename: 'incident escalation process',
    format: 'markdown',
    content: DOC,
    operationId: op('create'),
    provenance: { origin: 'assistant', turnId: crypto.randomUUID(), toolUseId: 'toolu_1' },
  });

  assert.equal(reference.revision, 1);
  assert.equal(reference.format, 'markdown');
  assert.equal(reference.filename, 'incident escalation process.md');
  assert.equal(reference.byte_length, Buffer.byteLength(DOC, 'utf8'));
  assert.equal(reference.sha256, crypto.createHash('sha256').update(DOC, 'utf8').digest('hex'));
  assert.equal(reference.status, 'saved');

  const read = await outputs.readOutput(a.scope, reference.output_id);
  assert.equal(read.content, DOC, 'the head resolves without naming a version');
  assert.equal(read.revision, 1);
  assert.equal(read.current_revision, 1);
  assert.equal(read.provenance.origin, 'assistant');

  const byNumber = await outputs.readOutput(a.scope, reference.output_id, { revision: 1 });
  assert.equal(byNumber.content, DOC);
  assert.equal(await outputs.readOutput(a.scope, reference.output_id, { revision: 2 }), null);
  assert.equal(await outputs.readOutput(a.scope, crypto.randomUUID()), null, 'a guessed id is absent');
});

test('a revision appends: v1 still reads, the head advances, metadata belongs to its version', async () => {
  const a = await workspace('acme-revise');
  const { reference: v1 } = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'Process', filename: 'process', format: 'markdown',
    content: DOC, operationId: op('c'),
  });
  const revised = DOC + '\n## After-hours exception\n\nPage the on-call manager.\n';
  const { reference: v2 } = await outputs.updateOutput(a.scope, {
    conversationId: a.conv.id, outputId: v1.output_id, expectedRevision: 1,
    content: revised, changeSummary: 'Added the after-hours exception', operationId: op('u'),
  });

  assert.equal(v2.revision, 2);
  assert.equal(v2.output_id, v1.output_id, 'a revision keeps the identity');
  assert.equal(v2.filename, v1.filename, 'the name a person already downloaded does not move');
  assert.equal(v2.byte_length, Buffer.byteLength(revised, 'utf8'));

  assert.equal((await outputs.readOutput(a.scope, v1.output_id, { revision: 1 })).content, DOC, 'v1 is immutable');
  assert.equal((await outputs.readOutput(a.scope, v1.output_id)).content, revised);
  const head = await outputs.readOutput(a.scope, v1.output_id);
  assert.equal(head.change_summary, 'Added the after-hours exception');

  const versions = await outputs.listRevisions(a.scope, v1.output_id);
  assert.equal(versions.current_revision, 2);
  assert.deepEqual(versions.revisions.map((r) => r.revision), [2, 1], 'newest first');
  assert.equal(versions.revisions[1].change_summary, null);
});

test('a stale update is a conflict and loses no revision', async () => {
  const a = await workspace('acme-conflict');
  const { reference } = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'T', filename: 't', format: 'markdown', content: 'one', operationId: op('c'),
  });
  await outputs.updateOutput(a.scope, {
    conversationId: a.conv.id, outputId: reference.output_id, expectedRevision: 1, content: 'two', operationId: op('u1'),
  });
  await assert.rejects(
    outputs.updateOutput(a.scope, {
      conversationId: a.conv.id, outputId: reference.output_id, expectedRevision: 1, content: 'three', operationId: op('u2'),
    }),
    (err) => err instanceof OutputError && err.code === 'conflict' && /version 2/.test(err.message),
  );
  assert.equal((await outputs.readOutput(a.scope, reference.output_id)).content, 'two', 'the committed version survives the refusal');
  assert.equal((await outputs.listRevisions(a.scope, reference.output_id)).revisions.length, 2);
});

test('two concurrent revisions against the same version: one wins, one conflicts', async () => {
  const a = await workspace('acme-race');
  const { reference } = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'T', filename: 't', format: 'markdown', content: 'base', operationId: op('c'),
  });
  const attempt = (content) => outputs.updateOutput(a.scope, {
    conversationId: a.conv.id, outputId: reference.output_id, expectedRevision: 1, content, operationId: op('u'),
  }).then((r) => ({ ok: true, r }), (err) => ({ ok: false, err }));

  const results = await Promise.all([attempt('left'), attempt('right')]);
  assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one write lands');
  const loser = results.find((r) => !r.ok);
  assert.equal(loser.err.code, 'conflict');
  assert.equal((await outputs.listRevisions(a.scope, reference.output_id)).current_revision, 2);
});

test('an operation id is idempotent for the same bytes and a conflict for different ones', async () => {
  const a = await workspace('acme-idem');
  const operationId = op('once');
  const first = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'T', filename: 't', format: 'markdown', content: 'body', operationId,
  });
  const replay = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'T', filename: 't', format: 'markdown', content: 'body', operationId,
  });
  assert.equal(replay.replayed, true, 'a retried tool call returns the committed reference');
  assert.equal(replay.reference.output_id, first.reference.output_id, 'and creates no second file');
  assert.equal((await outputs.listOutputs(a.scope, a.conv.id)).outputs.length, 1);

  await assert.rejects(
    outputs.createOutput(a.scope, {
      conversationId: a.conv.id, title: 'T', filename: 't', format: 'markdown', content: 'different', operationId,
    }),
    (err) => err.code === 'duplicate_operation',
  );
});

test('the Files list pages, carries no bodies, and counts', async () => {
  const a = await workspace('acme-list');
  for (let i = 1; i <= 5; i++) {
    await outputs.createOutput(a.scope, {
      conversationId: a.conv.id, title: `File ${i}`, filename: `file-${i}`, format: 'text',
      content: `body ${i}`, operationId: op(`c${i}`),
    });
  }
  const page = await outputs.listOutputs(a.scope, a.conv.id, { limit: 2 });
  assert.equal(page.outputs.length, 2);
  assert.deepEqual(page.outputs.map((o) => o.title), ['File 1', 'File 2'], 'oldest first');
  assert.ok(page.outputs.every((o) => !('content' in o)), 'a list never carries a body');
  assert.ok(page.next_cursor);

  const second = await outputs.listOutputs(a.scope, a.conv.id, { limit: 2, cursor: page.next_cursor });
  assert.deepEqual(second.outputs.map((o) => o.title), ['File 3', 'File 4']);
  const last = await outputs.listOutputs(a.scope, a.conv.id, { limit: 2, cursor: second.next_cursor });
  assert.deepEqual(last.outputs.map((o) => o.title), ['File 5']);
  assert.equal(last.next_cursor, null);
  assert.equal(await outputs.countOutputs(a.scope, a.conv.id), 5);
  assert.equal((await outputs.listOutputs(a.scope, crypto.randomUUID())).outputs.length, 0);
});

test('org B, another member and another instance cannot reach org A by guessing ids', async () => {
  const a = await workspace('acme-tenant');
  const b = await workspace('initech-tenant');
  const { reference } = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'Private', filename: 'private', format: 'markdown',
    content: 'confidential', operationId: op('c'),
  });

  // Another org, with the real id in hand.
  assert.equal(await outputs.readOutput(b.scope, reference.output_id), null);
  assert.equal(await outputs.listRevisions(b.scope, reference.output_id), null);
  assert.equal((await outputs.listOutputs(b.scope, a.conv.id)).outputs.length, 0);
  await assert.rejects(outputs.updateOutput(b.scope, {
    conversationId: a.conv.id, outputId: reference.output_id, expectedRevision: 1, content: 'x', operationId: op('u'),
  }), (err) => err.code === 'not_found');

  // Another member of the same org.
  const otherMember = { ...a.scope, userSysId: 'someone-else' };
  assert.equal(await outputs.readOutput(otherMember, reference.output_id), null);
  assert.equal(await outputs.listRevisions(otherMember, reference.output_id), null);

  // The same member on another instance.
  const otherInstance = { ...a.scope, instanceId: b.instance.id };
  assert.equal(await outputs.readOutput(otherInstance, reference.output_id), null);

  // And a create cannot be parented onto another tenant's conversation.
  await assert.rejects(outputs.createOutput(b.scope, {
    conversationId: a.conv.id, title: 'X', filename: 'x', format: 'text', content: 'x', operationId: op('c'),
  }), (err) => err.code === 'not_found');
});

test('a ciphertext moved to another output or version fails to open', async () => {
  const a = await workspace('acme-aad');
  const one = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'One', filename: 'one', format: 'markdown', content: 'first', operationId: op('c1'),
  });
  const two = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'Two', filename: 'two', format: 'markdown', content: 'second', operationId: op('c2'),
  });
  await outputs.updateOutput(a.scope, {
    conversationId: a.conv.id, outputId: one.reference.output_id, expectedRevision: 1, content: 'first v2', operationId: op('u'),
  });

  const blobOf = async (outputId, revision) => {
    const { rows } = await withOrg(a.scope.ctx.orgId, (c) => c.query(
      'SELECT payload_enc FROM output_revisions WHERE output_id = $1 AND revision = $2', [outputId, revision],
    ));
    return rows[0].payload_enc;
  };
  const stored = await blobOf(one.reference.output_id, 1);
  assert.doesNotMatch(Buffer.from(stored).toString('latin1'), /first/, 'the body is not stored in the clear');
  assert.doesNotMatch(Buffer.from(stored).toString('latin1'), /One/, 'nor is the title: a filename is instance data too');

  // Swap output 1 v1's blob onto output 2 v1, and onto output 1 v2.
  for (const [target, revision] of [[two.reference.output_id, 1], [one.reference.output_id, 2]]) {
    await system((c) => c.query('UPDATE output_revisions SET payload_enc = $1 WHERE output_id = $2 AND revision = $3',
      [stored, target, revision]));
    assert.equal(await outputs.readOutput(a.scope, target, { revision }), null,
      'a blob from another output or version must not open in its place');
  }
});

test('deleting the conversation takes its outputs and revisions with it', async () => {
  const a = await workspace('acme-delete');
  const { reference } = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'Doomed', filename: 'doomed', format: 'markdown', content: 'x', operationId: op('c'),
  });
  await outputs.updateOutput(a.scope, {
    conversationId: a.conv.id, outputId: reference.output_id, expectedRevision: 1, content: 'y', operationId: op('u'),
  });
  assert.equal(await store.deleteConversation(a.scope, a.conv.id), true);
  assert.equal(await outputs.readOutput(a.scope, reference.output_id), null);
  assert.equal(await outputs.listRevisions(a.scope, reference.output_id), null);
  const { rows } = await system((c) => c.query('SELECT count(*)::int AS n FROM output_revisions WHERE output_id = $1', [reference.output_id]));
  assert.equal(rows[0].n, 0, 'no orphaned revision survives its output');
});

test('limits refuse the whole write and never truncate', async () => {
  const a = await workspace('acme-limits');
  const oversized = 'é'.repeat(LIMITS.revisionBytes); // two bytes each: over the ceiling by bytes, not by length
  await assert.rejects(
    outputs.createOutput(a.scope, {
      conversationId: a.conv.id, title: 'Big', filename: 'big', format: 'markdown', content: oversized, operationId: op('c'),
    }),
    (err) => err.code === 'too_large',
  );
  assert.equal((await outputs.listOutputs(a.scope, a.conv.id)).outputs.length, 0, 'nothing partial was saved');

  await assert.rejects(outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'Empty', filename: 'e', format: 'markdown', content: '', operationId: op('c'),
  }), (err) => err.code === 'invalid');
  await assert.rejects(outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'Bad', filename: 'b', format: 'xlsx', content: 'x', operationId: op('c'),
  }), (err) => err.code === 'invalid' && /Unknown format/.test(err.message));
  await assert.rejects(outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'No op', filename: 'n', format: 'text', content: 'x', operationId: '',
  }), (err) => err.code === 'invalid');
});

test('filenames are derived from the validated format, never taken from the model', () => {
  assert.equal(safeFilename('../../etc/passwd', 'markdown'), 'etc passwd.md');
  assert.equal(safeFilename('C:\\Windows\\system32\\config', 'text'), 'C Windows system32 config.txt');
  assert.equal(safeFilename('report"; rm -rf /', 'markdown'), 'report rm -rf.md');
  assert.equal(safeFilename('note\r\nX-Injected: yes', 'text'), 'noteX-Injected yes.txt');
  assert.equal(safeFilename('CON', 'text'), 'CON-file.txt');
  assert.equal(safeFilename('lpt1', 'csv'), 'lpt1-file.csv');
  assert.equal(safeFilename('.hidden', 'text'), 'hidden.txt');
  assert.equal(safeFilename('', 'json'), 'output.json');
  assert.equal(safeFilename('payload.exe', 'markdown'), 'payload.md', 'a proposed extension does not survive');
  assert.equal(safeFilename('data.csv', 'csv'), 'data.csv');
  assert.equal(safeFilename('Sanktionsprüfung', 'markdown'), 'Sanktionsprüfung.md', 'Unicode names survive');
  assert.equal(safeFilename('x'.repeat(300), 'text').length, 84);
  assert.equal(extensionFor('code', 'python'), 'py');
  assert.equal(extensionFor('code', 'not-a-language'), 'txt', 'an unknown language degrades to text, it does not fail');
  assert.equal(extensionFor('code', 'html'), 'html');
});

test('the turn lease is the arbiter across processes, and an expired holder cannot write late', async () => {
  const a = await workspace('acme-lease');
  const first = await outputs.acquireTurn(a.scope, a.conv.id, { holder: 'chat' });
  await assert.rejects(outputs.acquireTurn(a.scope, a.conv.id, { holder: 'chat' }),
    (err) => err.code === 'busy' && /Another message/.test(err.message));

  assert.equal(await outputs.renewTurn(a.scope, a.conv.id, first.leaseId), true);
  assert.equal((await outputs.turnHolder(a.scope, a.conv.id)).holder, 'chat');

  // A write from the lease holder lands.
  const { reference } = await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'Held', filename: 'held', format: 'text', content: 'x',
    operationId: op('c'), leaseId: first.leaseId,
  });
  assert.equal(reference.revision, 1);

  // Expire it by hand, as a crashed process would, and let another turn take over.
  await withOrg(a.scope.ctx.orgId, (c) => c.query(
    `UPDATE conversation_turns SET expires_at = now() - interval '1 second' WHERE conversation_id = $1`, [a.conv.id]));
  const second = await outputs.acquireTurn(a.scope, a.conv.id, { holder: 'run' });
  assert.notEqual(second.leaseId, first.leaseId);
  assert.equal(await outputs.renewTurn(a.scope, a.conv.id, first.leaseId), false, 'the expired holder cannot renew');

  // The stale writer is refused inside the write transaction, not merely at the gate.
  await assert.rejects(outputs.updateOutput(a.scope, {
    conversationId: a.conv.id, outputId: reference.output_id, expectedRevision: 1, content: 'late',
    operationId: op('late'), leaseId: first.leaseId,
  }), (err) => err.code === 'lease_lost');
  assert.equal((await outputs.readOutput(a.scope, reference.output_id)).content, 'x');

  assert.equal(await outputs.releaseTurn(a.scope, a.conv.id, second.leaseId), true);
  assert.equal(await outputs.turnHolder(a.scope, a.conv.id), null);
  const third = await outputs.acquireTurn(a.scope, a.conv.id, { holder: 'chat' });
  await outputs.releaseTurn(a.scope, a.conv.id, third.leaseId);
});

test('a conversation deleted mid-flight leaves no orphan and recreates nothing', async () => {
  const a = await workspace('acme-cascade');
  await outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'One', filename: 'one', format: 'text', content: 'x', operationId: op('c'),
  });
  await store.deleteConversation(a.scope, a.conv.id);
  await assert.rejects(outputs.createOutput(a.scope, {
    conversationId: a.conv.id, title: 'Late', filename: 'late', format: 'text', content: 'y', operationId: op('c2'),
  }), (err) => err.code === 'not_found');
  const { rows } = await system((c) => c.query('SELECT count(*)::int AS n FROM outputs WHERE conversation_id = $1', [a.conv.id]));
  assert.equal(rows[0].n, 0, 'a late write did not resurrect the conversation');
});
