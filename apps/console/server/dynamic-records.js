// ADR 0013: discover a record shape, then reuse the normal approval path.
// Read-only preparation shared by proposals and commits. Never accepts a URL,
// HTTP method, executable handler, or field metadata supplied by the model.
import { CONFIG_TABLES, enabledTiers } from './actions.js';
import { scriptProblems } from './script-validation.js';

const NAME = /^[a-z][a-z0-9_]{0,159}$/;
const ID = /^[a-f0-9]{32}$/i;
const valueOf = v => v && typeof v === 'object' ? v.value : v;
const yes = v => ['true', '1'].includes(String(valueOf(v)).toLowerCase());
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };

export function validateDynamicInput(body) {
  const { table, operation, sys_id, fields } = body || {};
  if (typeof table !== 'string' || !NAME.test(table)) fail('Use an exact table name from sn_list_tables or sn_schema.');
  if (!['create', 'update'].includes(operation)) fail('Dynamic records support create or update.');
  if (operation === 'update' && !ID.test(sys_id || '')) fail('An update needs the record sys_id.');
  if (operation === 'create' && sys_id) fail('A new record cannot specify a sys_id.');
  if (!plain(fields) || !Object.keys(fields).length || Object.keys(fields).length > 100) fail('Provide 1–100 fields for one record.');
  for (const [name, value] of Object.entries(fields)) {
    if (!NAME.test(name) || name.startsWith('sys_') || ['constructor', 'prototype', '__proto__'].includes(name)) fail(`Field ${name} cannot be set by a dynamic card.`);
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) fail(`Use a scalar value for ${name}; use an empty string to clear it.`);
    if (['comments', 'work_notes'].includes(name)) fail(`Use sn_propose_reply for ${name}.`);
  }
  if (JSON.stringify(fields).length > 200000) fail('The proposed record is too large.');
}

// Unknown system tables take the security tier. Known configuration types
// retain tier 2. Check ancestors as well, including custom extensions.
function securityTable(table) {
  return (table.startsWith('sys_') && table !== 'sys_metadata' && !Object.hasOwn(CONFIG_TABLES, table)) ||
    /^(oauth|sys_auth|sys_security|sys_user|discovery_credentials|credential|auth_|sn_auth)/.test(table);
}

export async function prepareDynamicRecord(sn, body, actionsTiers) {
  validateDynamicInput(body);
  const { table, operation, sys_id, fields } = body;
  if (!enabledTiers(actionsTiers).has(2)) fail('Dynamic record cards require tier 2 in Admin → Actions.', 403);
  const definitions = new Map();
  const lineage = [];
  let metadata;
  let lookup = `name=${table}`;
  // Walk actual super_class references; display labels are not table names.
  for (let depth = 0; lookup; depth++) {
    if (depth >= 20) fail('Could not verify the table inheritance chain.');
    const data = await sn.get('/api/now/table/sys_db_object', {
      sysparm_query: lookup, sysparm_fields: 'sys_id,name,label,super_class',
      sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true', sysparm_limit: 1,
    });
    const obj = data.result?.[0];
    const name = valueOf(obj?.name);
    if (!obj || !NAME.test(name || '') || lineage.includes(name) || (!depth && name !== table)) fail(`Cannot verify schema for ${table} with your permissions.`, 403);
    metadata ||= obj;
    lineage.push(name);
    const dict = await sn.get('/api/now/table/sys_dictionary', {
      sysparm_query: `name=${name}^elementIN${Object.keys(fields).join(',')}`,
      sysparm_fields: 'element,column_label,internal_type,max_length,reference,mandatory,read_only',
      sysparm_display_value: 'all', sysparm_exclude_reference_link: 'true', sysparm_limit: 100,
    });
    for (const field of dict.result || []) {
      const element = valueOf(field.element);
      if (!definitions.has(element)) definitions.set(element, field);
    }
    const parent = valueOf(obj.super_class);
    if (parent && !ID.test(parent)) fail('Could not verify the parent table.');
    lookup = parent ? `sys_id=${parent}` : '';
  }
  if (lineage.some(t => ['change_request', 'sysapproval_approver', 'sys_update_set', 'sys_user_preference'].includes(t))) fail('This record requires its dedicated change, approval, or update-set action; dynamic cards cannot bypass that workflow.');
  if (operation === 'create' && lineage.some(t => ['sc_request', 'sc_req_item'].includes(t))) fail('Use sn_propose_catalog_order to raise a catalog request.');
  const tier = lineage.some(securityTable) ? 3 : 2;
  if (!enabledTiers(actionsTiers).has(tier)) fail(`This table requires security-sensitive actions (tier ${tier}) in Admin → Actions.`, 403);
  const labels = {};
  const scriptFields = [];
  let executable = false;
  for (const [name, value] of Object.entries(fields)) {
    const field = definitions.get(name);
    if (!field) fail(`Cannot verify field ${table}.${name}; read sn_schema and check inherited fields and permissions.`);
    if (yes(field.read_only)) fail(`${table}.${name} is read-only.`);
    const type = [valueOf(field.internal_type), field.internal_type?.display_value].filter(Boolean).join(' ').toLowerCase();
    if (/password|encrypted|credential/.test(type) || /password|secret|token/i.test(name)) fail(`Secret field ${name} cannot be displayed on a proposal card.`);
    if (yes(field.mandatory) && value === '') fail(`${name} is mandatory and cannot be cleared.`);
    const max = Number(valueOf(field.max_length));
    if (typeof value === 'string' && max > 0 && value.length > max) fail(`${name} exceeds its ${max}-character limit.`);
    if (valueOf(field.reference) && value !== '' && !ID.test(String(value))) fail(`Resolve ${name} to a sys_id before proposing it.`);
    if (/boolean/.test(type) && !['true', 'false', '0', '1'].includes(String(value))) fail(`${name} requires true or false.`);
    if (/\b(integer|longint)\b/.test(type) && !/^-?\d+$/.test(String(value))) fail(`${name} requires an integer.`);
    labels[name] = valueOf(field.column_label) || name;
    if (/script|javascript/.test(type)) scriptFields.push(name);
    executable ||= /script|html|condition/.test(type) || /script|condition|template|^link$/.test(name);
  }
  const problems = scriptProblems(fields, scriptFields);
  if (problems.length) fail(problems.join('; '));
  let current = {};
  let record = {};
  if (operation === 'update') {
    const data = await sn.get(`/api/now/table/${table}/${sys_id}`, {
      sysparm_fields: ['sys_id', 'name', 'number', ...Object.keys(fields)].join(','),
      sysparm_display_value: 'false', sysparm_exclude_reference_link: 'true',
    });
    record = data.result;
    if (!record || valueOf(record.sys_id) !== sys_id) fail('Cannot read the record to show its current values.', 403);
    for (const name of Object.keys(fields)) {
      if (!Object.hasOwn(record, name)) fail(`Cannot read the current value of ${name}; a before/after card cannot be verified.`, 403);
      current[name] = valueOf(record[name]);
    }
  }
  const name = String(valueOf(record.name) || valueOf(record.number) || fields.name || fields.short_description || sys_id || table);
  return { table, operation, ...(sys_id ? { sys_id } : {}), fields: { ...fields }, current, labels,
    label: String(valueOf(metadata.label) || table), name, tier, executable,
    confirmation: tier === 3 ? name : null };
}

export function checkDynamicApproval(prepared, body, automatic = false) {
  if (prepared.tier === 3 && (automatic || body.confirmation !== prepared.confirmation)) fail('Type the record name on this security-sensitive card to approve it.', 403);
  if (prepared.operation === 'update') {
    for (const [name, value] of Object.entries(prepared.current)) {
      if (!plain(body.current) || !Object.hasOwn(body.current, name) || String(body.current[name] ?? '') !== String(value ?? '')) fail(`The current value of ${name} changed or was not reviewed. Ask for a fresh proposal.`, 409);
    }
  }
}
