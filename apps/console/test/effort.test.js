import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effortValues, modelCatalog, resolveEffort } from '../server/models.js';
import { availableModels } from '../server/billing.js';
import { smokeTestModel } from '../server/agent.js';

test('effort capabilities distinguish models, dialects and provider defaults', () => {
  assert.deepEqual(effortValues('gpt-5.4'), ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(effortValues('gpt-5-mini'), ['minimal', 'low', 'medium', 'high']);
  assert.ok(effortValues('claude-sonnet-5').includes('max'));
  for (const model of ['gpt-4.1', 'claude-haiku-4-5', 'enterprise-alias']) {
    assert.deepEqual(effortValues(model), []);
    assert.throws(() => resolveEffort(model, { requested: 'high' }), /supported/);
    assert.equal(resolveEffort(model, { configured: 'high' }), '');
  }
  assert.deepEqual(effortValues('gpt-5.4', { kind: 'anthropic' }), []);
  assert.equal(resolveEffort('gpt-5.4', { configured: 'high', requested: 'low' }), 'low');
  assert.equal(resolveEffort('gpt-5.4', { configured: 'high', requested: '' }), 'high');
  assert.equal(resolveEffort('gpt-5.4'), '');
  assert.equal(resolveEffort('gpt-5.4', { requested: 'none' }), 'none');
  for (const requested of ['none', 'minimal', 'ultra', null, [], {}, 4]) {
    assert.throws(() => resolveEffort('gpt-6-astra', { requested }), /supported/);
  }
});

test('public model choices carry per-connection defaults without exposing secrets in either edition', () => {
  for (const edition of ['self-hosted', 'saas']) {
    const org = { edition, model_provider: 'trial', model_connections: [
      { id: 'a', label: 'Fast', provider: 'openai', model_id: 'gpt-5.4', effort: 'low', key_enc: 'secret' },
      { id: 'b', label: 'Deep', provider: 'openai', model_id: 'gpt-5.4', effort: 'high', key_enc: 'other-secret' },
      { id: 'c', label: 'Provider default', provider: 'openai', model_id: 'gpt-5.4', effort: '' },
    ], default_model_connection: 'b', model_effort: 'max' };
    const choices = availableModels(org);
    assert.equal(choices[0].id, 'b');
    assert.equal(choices[0].default_effort, 'high');
    assert.equal(choices.find(m => m.id === 'c').default_effort, '', 'a connection does not inherit a legacy org default');
    assert.equal(choices.find(m => m.id === 'a').default_effort, 'low');
    assert.doesNotMatch(JSON.stringify(choices), /secret|key_enc/);
  }
});

test('the catalog offers the admin editor exactly what each model accepts', () => {
  const catalog = modelCatalog();
  const byId = (id) => catalog.find((model) => model.id === id);
  assert.deepEqual(byId('gpt-5-nano').effort_values, ['minimal', 'low', 'medium', 'high']);
  assert.equal(byId('gpt-5-nano').kind, 'openai');
  assert.deepEqual(byId('claude-haiku-4-5').effort_values, [], 'a model without the dial offers nothing to pick');
  assert.equal(byId('enterprise-alias'), undefined, 'an id off the registry is absent, not guessed');
  for (const entry of catalog) {
    assert.deepEqual(entry.effort_values, effortValues(entry.id, { kind: entry.kind }));
    assert.equal(typeof entry.label, 'string');
  }
  assert.doesNotMatch(JSON.stringify(catalog), /input|output|maxToolResultChars/);
});

test('save-time validation refuses unsupported effort before contacting a provider', async () => {
  await assert.rejects(smokeTestModel({ kind: 'openai', model: 'gpt-6-astra', effort: 'none' }), /supported/);
  await assert.rejects(smokeTestModel({ kind: 'anthropic', model: 'claude-haiku-4-5', effort: 'high' }), /supported/);
});
