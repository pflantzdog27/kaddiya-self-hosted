// The admin model editor's effort dial, pinned.
//
// The dial used to be a fixed list of five values on every model, so picking
// one for a model that has no dial — or a value outside its range — failed the
// save-time smoke test behind a message about the endpoint and the API key.
// The options now come from the server's registry catalog.
//
// admin.js is a browser script, not a module: it is loaded here in a vm with a
// DOM stub, and its boot `load()` is driven by a stubbed fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { modelCatalog } from '../server/models.js';

const ADMIN_JS = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin.js',
);

const ADMIN_PAYLOAD = {
  org: { name: 'Demo Area', edition: 'self-hosted', plan_status: 'active', actions: [], branding: {} },
  me: { member_id: 'm1', role: 'owner', user_name: 'admin' },
  instances: [],
  members: [],
  plan: { id: 'self-hosted', label: 'Self-hosted', turns_per_month: null, max_members: null, max_instances: null },
  plans: {},
  usage: { turns_this_month: 0, spend_this_month_usd: 0 },
  model_connections: [],
  model_catalog: modelCatalog(),
  available_models: [],
  default_model: null,
  model: {},
  callback_url: 'http://localhost:3000/auth/callback',
  mode: 'self-hosted',
  audit: [],
};

function element() {
  const el = {
    children: [],
    textContent: '',
    innerHTML: '',
    className: '',
    value: '',
    placeholder: '',
    hidden: false,
    disabled: false,
    required: false,
    open: false,
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    get options() { return el.children; },
    append(...nodes) { el.children.push(...nodes); },
    appendChild(node) { el.children.push(node); return node; },
    replaceChildren(...nodes) { el.children = [...nodes]; },
    addEventListener(type, fn) { (el.handlers ||= {})[type] = fn; },
    removeEventListener() {},
    querySelector: () => element(),
    querySelectorAll: () => [],
    hasAttribute: () => true,
    setAttribute() {},
    focus() {},
    reset() {},
  };
  return el;
}

function loadAdmin() {
  const byId = new Map();
  const bySelector = new Map();
  const sandbox = {
    document: {
      body: element(),
      getElementById(id) {
        if (!byId.has(id)) byId.set(id, element());
        return byId.get(id);
      },
      querySelector(selector) {
        if (!bySelector.has(selector)) bySelector.set(selector, element());
        return bySelector.get(selector);
      },
      querySelectorAll: () => [],
      createElement: () => element(),
      addEventListener() {},
    },
    window: { scrollTo() {}, confirm: () => true },
    location: { search: '', assign() {} },
    URLSearchParams,
    KaddiyaBranding: { editor: () => ({ load() {}, value: () => ({}) }), apply() {} },
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/api/admin') ? ADMIN_PAYLOAD : { audit: [], more: false }),
    }),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ADMIN_JS, 'utf8'), sandbox, { filename: 'admin.js' });
  return { sandbox, byId };
}

/** The effort <select>'s option values, in order. */
const offered = (byId) => byId.get('m-effort').children.map((option) => option.value);
const note = (byId) => byId.get('m-effort-note').textContent;

async function booted() {
  const loaded = loadAdmin();
  // load() runs at boot and is not awaited by the script; let it settle.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  return loaded;
}

test('the effort dial offers exactly what the typed model accepts', async () => {
  const { sandbox, byId } = await booted();
  const model = byId.get('m-model');
  const provider = byId.get('m-provider');

  provider.value = 'openai';
  model.value = 'gpt-5-nano';
  sandbox.syncEffortField();
  assert.deepEqual(offered(byId), ['', 'minimal', 'low', 'medium', 'high'],
    'the cheapest OpenAI model takes minimal — which the old fixed list never offered');
  assert.equal(byId.get('m-effort').disabled, false);
  assert.equal(note(byId), '');

  model.value = 'gpt-5.4';
  sandbox.syncEffortField();
  assert.deepEqual(offered(byId), ['', 'none', 'low', 'medium', 'high', 'xhigh'],
    'and max is absent here, because this model rejects it');

  provider.value = 'anthropic';
  model.value = 'claude-haiku-4-5';
  sandbox.syncEffortField();
  assert.deepEqual(offered(byId), [''], 'a model with no dial offers only the provider default');
  assert.equal(byId.get('m-effort').disabled, true);
  assert.match(note(byId), /does not take a reasoning effort/);

  model.value = 'claude-opus-5';
  sandbox.syncEffortField();
  assert.deepEqual(offered(byId), ['', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('the same id under a different dialect is a different model', async () => {
  const { sandbox, byId } = await booted();
  byId.get('m-model').value = 'gpt-5-nano';
  byId.get('m-provider').value = 'gateway';
  sandbox.syncEffortField();
  assert.deepEqual(offered(byId), [''], 'an OpenAI id behind an Anthropic gateway is not that registry entry');
  assert.match(note(byId), /not in Kaddiya's registry/);
});

test('an unregistered id still saves, and says so instead of failing at the smoke test', async () => {
  const { sandbox, byId } = await booted();
  byId.get('m-provider').value = 'openai';
  byId.get('m-model').value = 'gpt-5.6-mini';
  sandbox.syncEffortField();
  assert.deepEqual(offered(byId), ['']);
  assert.match(note(byId), /can still be saved/);

  byId.get('m-model').value = '';
  sandbox.syncEffortField();
  assert.equal(note(byId), '', 'an empty field is not an unknown model');
});

test('editing a connection keeps its stored effort through the rebuilt options', async () => {
  const { sandbox, byId } = await booted();
  sandbox.editModel({ id: 'c1', label: 'Fast triage', provider: 'openai', model_id: 'gpt-5-nano', effort: 'minimal' });
  assert.deepEqual(offered(byId), ['', 'minimal', 'low', 'medium', 'high']);
  assert.equal(byId.get('m-effort').value, 'minimal');

  // A stored value the model no longer accepts falls back to the default
  // rather than resubmitting something the smoke test will refuse.
  sandbox.editModel({ id: 'c2', label: 'Stale', provider: 'anthropic', model_id: 'claude-haiku-4-5', effort: 'high' });
  assert.equal(byId.get('m-effort').value, '');
});
