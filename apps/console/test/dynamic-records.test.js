import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareDynamicRecord } from '../server/dynamic-records.js';
import { SnClient } from '../server/sn.js';
import { commit } from '../server/commits.js';
import { executeTool, toolDefinitions } from '../server/agent.js';

const ID = 'a'.repeat(32);
const PARENT = 'b'.repeat(32);
const field = (element, extra = {}) => ({ element, column_label: element, internal_type: 'string', read_only: 'false', ...extra });
function fixture({ table = 'sc_cat_item', parent = 'sys_metadata', defs, record } = {}) {
  const sn = new SnClient({ instanceUrl: 'https://example.service-now.com' }, { accessToken: 't' }, () => {});
  const fields = defs || [field('name'), field('active', { internal_type: 'boolean' }), field('category', { reference: 'sc_category' }), field('description')];
  const calls = [];
  sn.get = async (url, params) => {
    calls.push({ method: 'GET', url, params });
    if (url === '/api/now/table/sys_db_object') return { result: params.sysparm_query.startsWith('name=')
      ? [{ name: table, label: table === 'sc_cat_item' ? 'Catalog item' : table, super_class: parent ? PARENT : '' }]
      : [{ name: parent, label: parent, super_class: '' }] };
    if (url === '/api/now/table/sys_dictionary') return { result: params.sysparm_query.startsWith(`name=${table}^`) ? fields.filter(f => f.element !== 'description') : fields.filter(f => f.element === 'description') };
    return { result: record || { sys_id: ID, name: 'Laptop', active: 'true', description: 'Old description' } };
  };
  sn.write = async (method, url, body) => {
    calls.push({ method, url: String(url), body });
    return new Response(JSON.stringify({ result: { sys_id: ID, ...body } }));
  };
  return { sn, calls };
}
const input = { operation: 'create', table: 'sc_cat_item', fields: { name: 'Laptop', active: true, description: 'A work laptop' } };
const writes = calls => calls.filter(c => c.method !== 'GET');

test('schema distinguishes filter conditions from JavaScript, including custom script fields', async () => {
  const filter = fixture({ defs: [field('condition', { internal_type: 'conditions' })] });
  const body = { ...input, fields: { condition: 'active=true^category=hardware^ORpriority=1' } };
  await commit('dynamic.apply', { sn: filter.sn, audit: async () => {}, actionsTiers: '1,2' }, body);
  assert.equal(writes(filter.calls).length, 1);
  const script = fixture({ defs: [field('u_handler', { internal_type: { value: ID, display_value: 'Script' } })] });
  const invalid = { ...input, fields: { u_handler: 'var x = ;' } };
  await assert.rejects(prepareDynamicRecord(script.sn, invalid, '1,2'), /does not parse/);
  await assert.rejects(script.sn.applyDynamicRecord(invalid), /does not parse/);
  assert.equal(writes(script.calls).length, 0);
});

test('catalog item card discovers inherited fields and does no write', async () => {
  const { sn, calls } = fixture();
  const events = [];
  const result = await executeTool(sn, 'sn_propose_dynamic_record', input, (event, data) => events.push({ event, data }), { scope: { actionsTiers: '1,2' } });
  assert.equal(result.status, 'proposal_shown_to_user');
  assert.equal(events[0].event, 'proposal');
  assert.equal(events[0].data.action, 'dynamic.apply');
  assert.equal(events[0].data.label, 'Catalog item');
  assert.deepEqual(events[0].data.fields, input.fields);
  assert.equal(writes(calls).length, 0);
  assert.ok(calls.some(c => c.params?.sysparm_query === `sys_id=${PARENT}`));
});

test('approved catalog create uses exactly one Table API write and audits the record', async () => {
  const { sn, calls } = fixture();
  const audit = [];
  const out = await commit('dynamic.apply', { sn, audit: async e => audit.push(e), actionsTiers: '1,2' }, input);
  assert.equal(out.record.sys_id, ID);
  assert.equal(writes(calls).length, 1);
  assert.equal(writes(calls)[0].method, 'POST');
  assert.equal(new URL(writes(calls)[0].url).pathname, '/api/now/table/sc_cat_item');
  assert.deepEqual(writes(calls)[0].body, input.fields);
  assert.equal(audit[0].approved_by_user, true);
  assert.equal(audit[0].table, 'sc_cat_item');
});

test('new custom tables can produce a card without adding a preset', async () => {
  const { sn } = fixture({ table: 'u_equipment' });
  const card = await prepareDynamicRecord(sn, { ...input, table: 'u_equipment' }, '1,2');
  assert.equal(card.table, 'u_equipment');
  assert.equal(card.tier, 2);
});

test('updates show actual stored before values, apply only reviewed fields, and reject stale values', async () => {
  const { sn, calls } = fixture();
  const body = { table: 'sc_cat_item', operation: 'update', sys_id: ID, fields: { description: 'New description' } };
  const card = await prepareDynamicRecord(sn, body, '1,2');
  assert.deepEqual(card.current, { description: 'Old description' });
  await assert.rejects(sn.applyDynamicRecord({ ...body, current: { description: 'Wrong' } }), e => e.status === 409);
  assert.equal(writes(calls).length, 0);
  await sn.applyDynamicRecord({ ...body, current: card.current });
  assert.equal(writes(calls)[0].method, 'PATCH');
  assert.deepEqual(writes(calls)[0].body, body.fields);
});

test('schema and tier are rechecked at commit, including stale cards after revocation', async () => {
  const { sn, calls } = fixture();
  await prepareDynamicRecord(sn, input, '1,2');
  await assert.rejects(sn.applyDynamicRecord(input, { actionsTiers: '1' }), /tier 2/);
  assert.equal(writes(calls).length, 0);
  assert.ok(!toolDefinitions('1').some(t => t.name === 'sn_propose_dynamic_record'));
});

test('invalid payloads, unknown fields, read-only fields and secrets never reach a write', async () => {
  for (const bad of [
    { table: '../sys_user' }, { operation: 'delete' }, { operation: 'update', sys_id: '../all' },
    { fields: {} }, { fields: [] }, { fields: { name: { value: 'x' } } },
    { fields: { sys_id: ID } }, { fields: { imaginary: 'x' } }, { fields: { comments: 'x' } },
    { fields: { category: 'Laptops' } }, { fields: { active: 'perhaps' } },
  ]) {
    const { sn, calls } = fixture();
    await assert.rejects(sn.applyDynamicRecord({ ...input, ...bad }));
    assert.equal(writes(calls).length, 0);
  }
  for (const def of [field('name', { read_only: 'true' }), field('name', { internal_type: { value: ID, display_value: 'Password (2 Way Encrypted)' } }), field('name', { max_length: '2' })]) {
    const { sn, calls } = fixture({ defs: [def] });
    await assert.rejects(sn.applyDynamicRecord({ ...input, fields: { name: 'Laptop' } }));
    assert.equal(writes(calls).length, 0);
  }
});

test('unreadable schema and hidden current values fail closed', async () => {
  const { sn, calls } = fixture();
  sn.get = async () => ({ result: [] });
  await assert.rejects(sn.applyDynamicRecord(input), /Cannot verify schema/);
  assert.equal(writes(calls).length, 0);
  const hidden = fixture({ record: { sys_id: ID } });
  await assert.rejects(hidden.sn.applyDynamicRecord({ ...input, operation: 'update', sys_id: ID }), /current value/);
  assert.equal(writes(hidden.calls).length, 0);
});

test('special workflows and custom extensions cannot use dynamic cards to bypass their routes', async () => {
  for (const table of ['change_request', 'sysapproval_approver', 'sys_update_set', 'sys_user_preference', 'sc_request', 'sc_req_item']) {
    const { sn, calls } = fixture({ table: 'u_extension', parent: table });
    await assert.rejects(sn.applyDynamicRecord({ ...input, table: 'u_extension' }, { actionsTiers: 'all' }), /dedicated|sn_propose_catalog_order/);
    assert.equal(writes(calls).length, 0);
  }
});

test('security tables and their extensions require tier 3 and typed manual approval', async () => {
  const { sn, calls } = fixture({ table: 'u_person', parent: 'sys_user' });
  const body = { ...input, table: 'u_person' };
  await assert.rejects(prepareDynamicRecord(sn, body, '1,2'), /tier 3/);
  await assert.rejects(sn.applyDynamicRecord(body, { actionsTiers: 'all' }), /Type the record name/);
  await assert.rejects(sn.applyDynamicRecord({ ...body, confirmation: 'Laptop' }, { actionsTiers: 'all', automatic: true }), /Type the record name/);
  assert.equal(writes(calls).length, 0);
  await sn.applyDynamicRecord({ ...body, confirmation: 'Laptop' }, { actionsTiers: 'all' });
  assert.equal(writes(calls).length, 1);
});

test('security proposals stay manual during authorized runs; ordinary proposals use shared commit', async () => {
  const security = fixture({ table: 'sys_user' });
  let commits = 0;
  const scope = { actionsTiers: 'all', planCommit: async () => { commits++; return { ok: true }; } };
  const events = [];
  await executeTool(security.sn, 'sn_propose_dynamic_record', { ...input, table: 'sys_user' }, (event, data) => events.push({ event, data }), { scope });
  assert.equal(commits, 0);
  assert.equal(events[0].data.automatic, false);
  const normal = fixture();
  const result = await executeTool(normal.sn, 'sn_propose_dynamic_record', input, () => {}, { scope });
  assert.equal(commits, 1);
  assert.equal(result.status, 'committed');
  await assert.rejects(executeTool(normal.sn, 'sn_propose_dynamic_record', input, () => {}, { scope: { readOnly: true } }), /read-only/);
});

test('instance refusal is audited as a failure, never as completed', async () => {
  const { sn } = fixture();
  sn.write = async () => new Response(JSON.stringify({ error: { message: 'ACL denied' } }), { status: 403 });
  const audit = [];
  await assert.rejects(commit('dynamic.apply', { sn, actionsTiers: '1,2', audit: async e => audit.push(e) }, input), /ACL denied/);
  assert.equal(audit[0].action, 'dynamic_apply_failed');
  assert.equal(audit[0].approved_by_user, undefined);
});

test('a successful save that omits or changes a requested field reports the discrepancy', async () => {
  const { sn } = fixture();
  sn.write = async () => new Response(JSON.stringify({ result: { sys_id: ID, name: 'Adjusted by a business rule' } }));
  const out = await commit('dynamic.apply', { sn, audit: async () => {}, actionsTiers: '1,2' }, input);
  assert.equal(out.ok, true);
  assert.equal(out.record.sys_id, ID);
  assert.match(out.warnings[0], /values were not confirmed: name, active, description/);
  assert.match(out.warnings[0], /do not repeat creation/);
});
