import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual renderers and event handlers without an instance or OAuth.
// Nodes retain their listeners; replacing card HTML creates fresh child nodes.
function node() {
  const listeners = new Map();
  let html = '';
  let children = new Map();
  return {
    disabled: false, value: '', style: {}, className: '',
    classList: { add() {}, remove() {}, toggle() {} },
    hasAttribute: () => true,
    addEventListener(event, handler) { listeners.set(event, handler); },
    async fire(event) { return listeners.get(event)?.({ target: this }); },
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; children = new Map(); },
    querySelector(selector) {
      if (!children.has(selector)) children.set(selector, node());
      return children.get(selector);
    },
    querySelectorAll: () => [], appendChild() {}, insertBefore() {}, remove() {},
  };
}

function frontend(response = { ok: true, record: { sys_id: 'a'.repeat(32), name: 'Laptop' } }) {
  const root = node();
  const requests = [];
  const context = vm.createContext({
    document: { body: root, getElementById: () => root, querySelector: () => root,
      querySelectorAll: () => [], createElement: node, addEventListener() {} },
    location: { assign() {} }, setInterval: () => 0, clearInterval() {}, console,
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => response };
    },
  });
  vm.runInContext(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  return { context, requests };
}

const base = { action: 'dynamic.apply', operation: 'create', table: 'sc_cat_item',
  label: 'Catalog item', name: 'Laptop', fields: { name: 'Laptop', active: false },
  labels: { name: 'Name', active: 'Active' }, confirmation: null };

test('dynamic create submits exactly the displayed fields only after a click', async () => {
  const { context, requests } = frontend();
  const card = context.makeProposalCard(base);
  assert.equal(requests.length, 0);
  assert.match(card.innerHTML, /Create Catalog item/);
  assert.match(card.innerHTML, /false/);
  await card.querySelector('.btn-primary').fire('click');
  assert.deepEqual(requests, [{ url: '/api/dynamic/apply', body: {
    table: 'sc_cat_item', operation: 'create', fields: base.fields,
  } }]);
  assert.equal(card.className, 'nc-card done');
});

test('dynamic update submits the reviewed before values and shows returned values', async () => {
  const { context, requests } = frontend({ ok: true, record: { sys_id: 'a'.repeat(32), active: 'false' } });
  const card = context.makeProposalCard({ ...base, operation: 'update', sys_id: 'a'.repeat(32),
    fields: { active: false }, current: { active: 'true' } });
  assert.match(card.innerHTML, /diff-old">true/);
  assert.match(card.innerHTML, /diff-new">false/);
  await card.querySelector('.btn-primary').fire('click');
  assert.deepEqual(requests[0].body.current, { active: 'true' });
  assert.equal(requests[0].body.operation, 'update');
  assert.match(card.innerHTML, /Record updated/);
  assert.match(card.innerHTML, /false/);
});

test('discard and restore do not write, and restore requires a fresh typed approval', async () => {
  const { context, requests } = frontend();
  const card = context.makeProposalCard({ ...base, confirmation: 'Laptop' });
  let button = card.querySelector('.btn-primary');
  assert.equal(button.disabled, true);
  await button.fire('click');
  assert.equal(requests.length, 0);
  const input = card.querySelector('.dynamic-confirmation');
  input.value = 'Laptop';
  await input.fire('input');
  assert.equal(button.disabled, false);
  await card.querySelector('.btn-ghost').fire('click');
  assert.match(card.className, /discarded/);
  await card.querySelector('.nc-restore').fire('click');
  button = card.querySelector('.btn-primary');
  assert.equal(button.disabled, true);
  assert.equal(requests.length, 0);
});

test('typing approval submits it once and cannot re-enable an in-flight write', async () => {
  const { context, requests } = frontend();
  let release;
  context.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ record: { name: 'Laptop' } }) };
  };
  const card = context.makeProposalCard({ ...base, confirmation: 'Laptop' });
  const input = card.querySelector('.dynamic-confirmation');
  const button = card.querySelector('.btn-primary');
  input.value = 'wrong';
  await input.fire('input');
  assert.equal(button.disabled, true);
  input.value = 'Laptop';
  await input.fire('input');
  const pending = button.fire('click');
  assert.equal(input.disabled, true);
  assert.equal(button.disabled, true);
  await button.fire('click');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.confirmation, 'Laptop');
  release();
  await pending;
  assert.equal(card.className, 'nc-card done');
});

test('hostile labels and complete executable content render as escaped text', () => {
  const { context, requests } = frontend();
  const script = '<script>alert("x")</script>\n' + 'long content\n'.repeat(200);
  const card = context.makeProposalCard({ ...base, label: '<img src=x onerror=alert(1)>',
    executable: true, fields: { template: script }, labels: { template: '<svg onload=alert(1)>' } });
  assert.doesNotMatch(card.innerHTML, /<script>|<img|<svg/);
  assert.ok(card.innerHTML.includes(context.escapeHtml(script)));
  assert.match(card.innerHTML, /EXECUTABLE CODE/);
  assert.equal(requests.length, 0);
});

test('partial saves stay saved and report warnings without inventing missing values', () => {
  const { context } = frontend();
  const warning = 'Record saved, but active was not confirmed. Read the record before continuing.';
  const card = context.makeProposalCard({ ...base, operation: 'update', sys_id: 'a'.repeat(32),
    fields: { active: false }, current: { active: 'true' } });
  card.markCommitted({ record: { sys_id: 'a'.repeat(32) }, warnings: [warning] });
  assert.match(card.className, /done/);
  assert.ok(card.innerHTML.includes(warning));
  assert.doesNotMatch(card.innerHTML, />false</);
  const created = context.makeProposalCard(base);
  created.markCommitted({ record: { name: 'Laptop' }, warnings: [warning] });
  assert.ok(created.innerHTML.includes(warning));
});
