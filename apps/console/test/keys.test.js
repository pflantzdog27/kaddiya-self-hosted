// The second wall (ADR 0008 D6 gate d): org B's ciphertext fails under org
// A's context, the column is part of the binding, and a context cannot be
// built from a record's org_id alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.KADDIYA_MASTER_KEY = process.env.KADDIYA_MASTER_KEY || '22'.repeat(32);

const { OrgContext, newWrappedDek, sessionKey, sealWithKey, openWithKey } = await import('../server/keys.js');

function orgRow() {
  const id = crypto.randomUUID();
  return { id, dek_wrapped: newWrappedDek(id), key_version: 1 };
}

test("org B's ciphertext fails under org A's context", () => {
  const a = new OrgContext(orgRow());
  const b = new OrgContext(orgRow());
  const blob = b.encrypt('conversations.body', '[{"role":"user","content":"INC0010001"}]');
  assert.throws(() => a.decrypt('conversations.body', blob), /Unsupported state|unable to authenticate/);
  assert.equal(b.decrypt('conversations.body', blob), '[{"role":"user","content":"INC0010001"}]');
});

test('the column is part of the binding: a blob for one column does not open as another', () => {
  const a = new OrgContext(orgRow());
  const blob = a.encrypt('instances.client_secret', 'shh');
  assert.throws(() => a.decrypt('orgs.model_key', blob), /Unsupported state|unable to authenticate/);
});

test('a context cannot be built from a record-supplied org id', () => {
  assert.throws(() => new OrgContext({ id: crypto.randomUUID() }), /wrapped key/);
  assert.throws(() => new OrgContext({ id: crypto.randomUUID(), dek_wrapped: crypto.randomBytes(61) }), /Unsupported state|unable to authenticate|unrecognised/);
});

test('session tokens sealed under one cookie do not open under another', () => {
  const sidA = crypto.randomBytes(32).toString('base64url');
  const sidB = crypto.randomBytes(32).toString('base64url');
  const blob = sealWithKey(sessionKey(sidA), 'session:x', '{"accessToken":"t"}');
  assert.equal(openWithKey(sessionKey(sidA), 'session:x', blob), '{"accessToken":"t"}');
  assert.throws(() => openWithKey(sessionKey(sidB), 'session:x', blob), /Unsupported state|unable to authenticate/);
});
