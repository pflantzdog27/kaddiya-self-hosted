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

// ---- the update set package card (a download, not a write) ----

const pkg = {
  sys_id: '0'.repeat(31) + '3', update_set: 'KD: incident autoclose', state: 'Complete',
  changes: 2, by_type: [{ type: 'Business Rule', count: 2 }],
  bytes: 8400, sha256: 'a'.repeat(64), warnings: [],
  filenames: { xml: 'kd-incident-autoclose.xml', ledger: 'kd-incident-autoclose-ledger.md' },
};

test('the package card offers two same-origin downloads and posts nothing', () => {
  const { context, requests } = frontend();
  const card = context.makePackageCard(pkg);
  // No button, no commit: the changes in the file were approved when they were
  // committed, and the package only reads them back.
  assert.equal(requests.length, 0);
  assert.match(card.innerHTML, /2 changes · 8 KB/);
  assert.match(card.innerHTML, /2 × Business Rule/);
  // The card shows what a fulfiller can act on. The hash identifies the file
  // for whoever loads it, so it lives in the ledger that travels with it and
  // in the audit row — not on the front of the card.
  assert.ok(!card.innerHTML.includes(pkg.sha256.slice(0, 16)), 'the hash belongs in the ledger, not the card');

  const hrefs = [...card.innerHTML.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, [
    `/api/update-set/${pkg.sys_id}/package.md`,
    `/api/update-set/${pkg.sys_id}/package.xml`,
  ]);
  // Same-origin paths built from the sys_id, never a URL the model chose.
  for (const href of hrefs) assert.match(href, /^\/api\/update-set\/[0-9a-f]{32}\/package\.(xml|md)$/);
});

test('a package warning reaches the card, escaped', () => {
  const { context } = frontend();
  const card = context.makePackageCard({ ...pkg, update_set: '<img src=x>', warnings: ['This set is "In progress", not Complete.'] });
  assert.match(card.innerHTML, /not Complete/);
  assert.ok(!card.innerHTML.includes('<img src=x>'), 'the set name is instance content and is escaped');
  assert.match(card.innerHTML, /&lt;img src=x&gt;/);
});
