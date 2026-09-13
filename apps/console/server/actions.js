// The action catalog — every instance write, in one place (ADR 0010 D1).
//
// This module is the single source of truth for what the console can write
// to a ServiceNow instance. The agent's proposal tools, the human-click
// endpoints in index.js, the cards, the tests, the approval kit's tables and
// the numbers on the marketing site all derive from the entries below.
// Nothing else may write, and a reviewer counts the write surface by reading
// this file.
//
// Every entry obeys the ADR 0009 D2 invariant, unchanged:
//   1. the agent can only PROPOSE it — its tool renders a card and returns a
//      result saying nothing was written;
//   2. a dedicated endpoint performs the write, only on a human click, on the
//      approving user's own OAuth token, with the table/field allow-list
//      enforced there as well as in the tool schema;
//   3. the write is audit-logged with approved_by_user: true;
//   4. it is toggleable by tier (ADR 0010 D2).
//
// ADR 0013 adds one schema-discovered record action. Its payload is validated
// from live metadata before review and again at commit; it cannot choose URLs.
//
// This module is pure: no instance client, no HTTP, no dependency on any
// other server module. sn.js and index.js depend on it, not the other way
// round, so a test can load the catalog without a session.

/** Tiers (ADR 0010 D2). Which tiers are enabled is a deployment decision. */
export const TIERS = {
  1: 'task and request actions — default on',
  2: 'configuration records, including executable code — default off for enterprise orgs',
  3: 'security-sensitive configuration — explicit flag, and the approver types the record name',
};

/**
 * Configuration tables an approved artifact may be created on. Anything not
 * listed is refused server-side, so a creative prompt cannot reach sys_user,
 * ACLs, or data tables. A table enters this list only after a record has been
 * created on it from a card, on the PDI, as a non-admin developer user
 * (ADR 0010 D3) — the list is what we claim, so it holds only what we have done.
 */
export const CONFIG_TABLES = {
  sys_script: 'Business Rule',
  sys_script_include: 'Script Include',
  sys_script_client: 'Client Script',
  sys_ui_policy: 'UI Policy',
  // Service Portal (2026-09-06): a widget and the records that put it on a
  // page. Five plain records, one card each, in this order — page, container,
  // row, column, instance — each referencing the sys_id the previous card
  // created. Cited: platform-user-interface/service-portal/widget-dev-guide.md
  // and c_Pages.md. D3 verification on the PDI is owed before this reaches main.
  sp_widget: 'Service Portal Widget',
  sp_page: 'Service Portal Page',
  sp_container: 'Service Portal Container',
  sp_row: 'Service Portal Row',
  sp_column: 'Service Portal Column',
  sp_instance: 'Service Portal Widget Instance',
};

/** The allow-list as the tool descriptions say it: "Business Rule, Script Include, …". */
const CONFIG_KINDS = Object.values(CONFIG_TABLES).join(', ');

/**
 * Task-family tables a proposed update may touch, and the only fields it may
 * change. Assignment, state, priority and resolution: what a fulfiller does
 * forty times a day. change_request is deliberately absent — its state model
 * belongs to the Change Management API (a later catalog entry), not a PATCH.
 */
export const TASK_TABLES = [
  'incident', 'problem', 'sc_request', 'sc_req_item', 'sc_task', 'change_task', 'sn_hr_core_case',
];
export const TASK_FIELDS = [
  'state', 'assignment_group', 'assigned_to', 'priority', 'impact', 'urgency',
  'hold_reason', 'close_code', 'close_notes',
];

/** change_request fields a proposed change may set on creation. */
export const CHANGE_TYPES = ['normal', 'standard', 'emergency'];
export const CHANGE_FIELDS = [
  'short_description', 'description', 'category', 'priority', 'risk', 'impact', 'urgency',
  'assignment_group', 'assigned_to', 'cmdb_ci', 'business_service', 'start_date', 'end_date',
  'justification', 'implementation_plan', 'backout_plan', 'test_plan', 'change_plan', 'requested_by',
];

const DOCS = {
  tableApi: 'api-reference/rest-apis/c_TableAPI.md',
  catalogApi: 'api-reference/rest-apis/c_ServiceCatalogAPI.md',
  changeApi: 'api-reference/rest-apis/change-management-api.md',
};

/**
 * The catalog. Field by field:
 *   id        stable name, used in audit entries and toggles
 *   tier      1 · 2 · 3 (see TIERS)
 *   label     what the card calls it
 *   endpoint  the human-click endpoint in index.js ("METHOD /path")
 *   instance  what that endpoint calls on the instance, for the approval kit
 *   card      the SSE event / card kind the proposal renders as
 *   cite      the docs-cache topic for the instance surface (family-relative)
 *   tool      the Anthropic tool definition the agent sees — the description
 *             must say THIS DOES NOT WRITE ANYTHING and that only the human
 *             can click (write-paths.test.js pins both)
 */
export const ACTIONS = [
  {
    id: 'dynamic.apply',
    tier: 2,
    label: 'Proposed record',
    endpoint: 'POST /api/dynamic/apply',
    instance: { method: 'POST/PATCH', path: '/api/now/table/{table}[/{sys_id}]', discovery: 'Live table and inherited field metadata; security tables require tier 3 and typed approval.' },
    card: 'dynamic_record',
    cite: DOCS.tableApi,
    tool: {
      name: 'sn_propose_dynamic_record',
      description: 'Build a review card for creating or updating ONE record when a dedicated proposal tool does not cover its table or fields. Includes catalog item definitions (sc_cat_item), variables (item_option_new), categories, and custom tables. THIS DOES NOT WRITE ANYTHING — only the human can click Create or Apply in normal mode. Read sn_schema and the release documentation first; resolve references to sys_ids and choices to stored values. The server discovers inherited fields, validates the payload, and reads current values for updates. Provide complete scripts. For several related records, propose them in dependency order and use only confirmed sys_ids. Use dedicated tools for ordering items, approvals, change requests, journals, and update sets. Security-sensitive tables require tier 3 and a typed manual approval. If validation refuses a proposal, explain the specific schema, permission, or workflow limit and fix it where possible; never claim an absent preset card makes a supported record impossible.',
      input_schema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['create', 'update'] },
          table: { type: 'string', description: 'Exact existing table name verified on this instance.' },
          sys_id: { type: 'string', description: 'Required for update; omit for create.' },
          fields: { type: 'object', description: 'Only fields to set, with scalar stored values. Full code where applicable.', additionalProperties: true },
          rationale: { type: 'string', description: 'Why this change is needed.' },
        },
        required: ['operation', 'table', 'fields'],
        additionalProperties: false,
      },
    },
  },

  {
    id: 'journal.append',
    tier: 1,
    label: 'Draft reply',
    endpoint: 'POST /api/record/comment',
    instance: { method: 'PATCH', path: '/api/now/table/{table}/{sys_id}', fields: ['comments', 'work_notes'] },
    card: 'draft',
    cite: DOCS.tableApi,
    tool: {
      name: 'sn_propose_reply',
      description:
        'Draft a comment for a record and show it to the user for approval. THIS DOES NOT WRITE ANYTHING — it puts a draft on screen with a Send button that only the human can click. Use it whenever the user wants to reply to a requestor or add a work note. Write the reply text in full, ready to send. Choose field="comments" for anything the requestor should see, "work_notes" for internal-only notes.',
      input_schema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          sys_id: { type: 'string' },
          field: { type: 'string', enum: ['comments', 'work_notes'], description: 'comments = customer visible; work_notes = internal' },
          text: { type: 'string', description: 'The full proposed comment text' },
        },
        required: ['table', 'sys_id', 'field', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    id: 'task.update',
    tier: 1,
    label: 'Proposed update',
    endpoint: 'POST /api/record/update',
    instance: { method: 'PATCH', path: '/api/now/table/{table}/{sys_id}', tables: TASK_TABLES, fields: TASK_FIELDS },
    card: 'record_update',
    cite: DOCS.tableApi,
    tool: {
      name: 'sn_propose_record_update',
      description:
        'Propose updating ONE task record — its state, assignment, priority, impact/urgency, hold reason or resolution — and show the before/after to the user for approval. THIS DOES NOT WRITE ANYTHING — it renders the change with an Apply button that only the human can click. Read the record first with sn_record and pass its present values in `current` so the card can show exactly what changes; put only the fields that change in `changes`. One record per proposal. change_request is not on this tool: say so and describe the change instead.',
      input_schema: {
        type: 'object',
        properties: {
          table: { type: 'string', enum: TASK_TABLES },
          sys_id: { type: 'string' },
          number: { type: 'string', description: 'The record number, for the card' },
          rationale: { type: 'string', description: 'One sentence on why this change' },
          current: { type: 'object', description: 'Present values of the fields being changed, as read from the record', additionalProperties: true },
          changes: {
            type: 'object',
            description: `Only the fields that change, with their new values. Allowed: ${TASK_FIELDS.join(', ')}. Use sys_ids for reference fields (assignment_group, assigned_to) and the choice value for state/priority.`,
            additionalProperties: true,
          },
        },
        required: ['table', 'sys_id', 'changes'],
        additionalProperties: false,
      },
    },
  },
  {
    id: 'approval.decide',
    tier: 1,
    label: 'Proposed decision',
    endpoint: 'POST /api/approval/decide',
    instance: { method: 'PATCH', path: '/api/now/table/sysapproval_approver/{sys_id}', tables: ['sysapproval_approver'], fields: ['state', 'comments'] },
    card: 'approval',
    cite: DOCS.tableApi,
    tool: {
      name: 'sn_propose_approval',
      description:
        'Propose approving or rejecting ONE approval the signed-in user holds (a sysapproval_approver record where they are the approver and the state is requested) and show it to the user for approval. THIS DOES NOT WRITE ANYTHING — it renders the decision with a button that only the human can click. Summarise what is being approved (the change, request or item) before proposing; put that summary in `approving`.',
      input_schema: {
        type: 'object',
        properties: {
          sys_id: { type: 'string', description: 'sys_id of the sysapproval_approver record' },
          decision: { type: 'string', enum: ['approved', 'rejected'] },
          comments: { type: 'string', description: 'Approval comments, shown on the card and written with the decision' },
          approving: {
            type: 'object',
            description: 'What the approval is for: table, number, and a one-line summary',
            properties: {
              table: { type: 'string' },
              number: { type: 'string' },
              summary: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        required: ['sys_id', 'decision'],
        additionalProperties: false,
      },
    },
  },
  {
    id: 'catalog.order',
    tier: 1,
    label: 'Proposed order',
    endpoint: 'POST /api/catalog/order',
    instance: { method: 'POST', path: '/api/sn_sc/servicecatalog/items/{sys_id}/order_now', tables: ['sc_request', 'sc_req_item'] },
    card: 'catalog_order',
    cite: DOCS.catalogApi,
    tool: {
      name: 'sn_propose_catalog_order',
      description:
        'Propose ordering ONE catalog item, quantity 1, with its variables filled in, and show it to the user for approval. THIS DOES NOT WRITE ANYTHING — it renders the order with an Order button that only the human can click. Find the item first (sn_query on sc_cat_item, active=true) and its variables (item_option_new where cat_item is the item) so every mandatory variable is set. The request is raised as the signed-in user unless requested_for is given and their roles allow it.',
      input_schema: {
        type: 'object',
        properties: {
          item_sys_id: { type: 'string', description: 'sys_id of the sc_cat_item' },
          item_name: { type: 'string', description: 'The item name, for the card' },
          variables: { type: 'object', description: 'Variable name → value, exactly as the item defines them', additionalProperties: true },
          requested_for: { type: 'string', description: 'sys_id of the user the item is for, if not the signed-in user' },
          rationale: { type: 'string', description: 'One sentence on why' },
        },
        required: ['item_sys_id', 'item_name'],
        additionalProperties: false,
      },
    },
  },
  {
    id: 'change.create',
    tier: 1,
    label: 'Proposed change request',
    endpoint: 'POST /api/change/create',
    instance: { method: 'POST', path: '/api/sn_chg_rest/change/{normal|standard/{template}|emergency}', tables: ['change_request'], fields: CHANGE_FIELDS },
    card: 'change',
    cite: DOCS.changeApi,
    tool: {
      name: 'sn_propose_change',
      description:
        'Propose raising ONE change request — normal, emergency, or standard from an existing template — with its fields filled in, and show it to the user for approval. THIS DOES NOT WRITE ANYTHING — it renders the change with a Create button that only the human can click. For a standard change find the template first (sn_query on std_change_record_producer). Write a real implementation plan, backout plan and test plan; use sys_ids for reference fields; use "YYYY-MM-DD HH:MM:SS" for dates.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: CHANGE_TYPES },
          template_sys_id: { type: 'string', description: 'For a standard change: the std_change_record_producer sys_id' },
          template_name: { type: 'string', description: 'For the card' },
          fields: {
            type: 'object',
            description: `Field → value. Allowed: ${CHANGE_FIELDS.join(', ')}.`,
            additionalProperties: true,
          },
          rationale: { type: 'string' },
        },
        required: ['type', 'fields'],
        additionalProperties: false,
      },
    },
  },
  {
    id: 'config.create',
    tier: 2,
    label: 'Proposed change',
    endpoint: 'POST /api/artifact/create',
    instance: { method: 'POST', path: '/api/now/table/{table}', tables: Object.keys(CONFIG_TABLES) },
    card: 'artifact',
    cite: DOCS.tableApi,
    tool: {
      name: 'sn_propose_artifact',
      description:
        `Propose creating ONE configuration record (${CONFIG_KINDS}) and show it to the user for approval. THIS DOES NOT WRITE ANYTHING — it renders the proposed record with its code for review, and only the human can click Create. Write complete, production-quality field values including the full script. Always check the current update set first so you can tell the user where it will be captured. A Service Portal widget is one card (sp_widget: name, id, template, css, client_script, script, link, option_schema, controller_as, public, roles); placing it on a page is five more cards in order — sp_page, then sp_container (sp_page), sp_row (sp_container), sp_column (sp_row, size), sp_instance (sp_column, sp_widget) — each referencing the sys_id the previous card created, which you read back with sn_query after the user clicks.`,
      input_schema: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            enum: Object.keys(CONFIG_TABLES),
            description: Object.entries(CONFIG_TABLES).map(([t, l]) => `${t} = ${l}`).join(', '),
          },
          rationale: { type: 'string', description: 'One or two sentences on why this change solves the problem' },
          fields: {
            type: 'object',
            description:
              'The record fields. Business Rule: name, collection (table), when, order, active, condition, script. Script Include: name, api_name, script, active, client_callable. Service Portal widget: name, id, template (HTML), css, client_script (the controller), script (server), link (optional), option_schema (JSON), controller_as (c), public, roles. Include every script written in full.',
            additionalProperties: true,
          },
        },
        required: ['table', 'fields'],
        additionalProperties: false,
      },
    },
  },
  {
    id: 'config.update',
    tier: 2,
    label: 'Proposed change',
    endpoint: 'POST /api/artifact/update',
    instance: { method: 'PATCH', path: '/api/now/table/{table}/{sys_id}', tables: Object.keys(CONFIG_TABLES) },
    card: 'artifact_update',
    cite: DOCS.tableApi,
    tool: {
      name: 'sn_propose_artifact_update',
      description:
        `Propose updating ONE existing configuration record (${CONFIG_KINDS}) and show the before/after to the user for approval. THIS DOES NOT WRITE ANYTHING — it renders the change with an Apply button that only the human can click. Read the record first with sn_record; pass the present values of the fields you change in \`current\` and only the changed fields in \`changes\` — for a script, the complete new script. Check the current update set first so you can say where the change is captured.`,
      input_schema: {
        type: 'object',
        properties: {
          table: { type: 'string', enum: Object.keys(CONFIG_TABLES) },
          sys_id: { type: 'string' },
          name: { type: 'string', description: 'The record name, for the card' },
          rationale: { type: 'string' },
          current: { type: 'object', description: 'Present values of the fields being changed', additionalProperties: true },
          changes: { type: 'object', description: 'Only the fields that change, with their full new values', additionalProperties: true },
        },
        required: ['table', 'sys_id', 'changes'],
        additionalProperties: false,
      },
    },
  },
  {
    id: 'update_set.create',
    tier: 2,
    label: 'Proposed update set',
    endpoint: 'POST /api/update-set/create',
    instance: {
      method: 'POST',
      path: '/api/now/table/sys_update_set',
      tables: ['sys_update_set'],
      // Selecting the new set as current IS a sys_user_preference write —
      // ServiceNow has no other mechanism for it (kit doc 04, row 3a).
      alsoWrites: { method: 'POST/PATCH', path: '/api/now/table/sys_user_preference', tables: ['sys_user_preference'] },
    },
    card: 'update_set_proposal',
    cite: DOCS.tableApi,
    tool: {
      name: 'sn_propose_update_set',
      description:
        'Propose a new update set and show it to the user for approval. THIS DOES NOT WRITE ANYTHING — it renders the proposed set with a Create button that only the human can click; creating it also makes it their current set, so later configuration changes are captured in it. Propose one before proposing configuration changes when the current set is Default or unrelated to this work.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short descriptive name, e.g. "VIP incident auto-priority"' },
          description: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Which tiers this deployment enables (ADR 0010 D2), until the per-org
 * toggles of ADR 0008 P3 exist. KADDIYA_ACTIONS is a comma list of tiers
 * ("1", "1,2"), or "all". Unset means tiers 1 and 2 — the self-hosted default;
 * an enterprise org sets "1". Tier 3 is never on without saying so.
 */
export function enabledTiers(value = process.env.KADDIYA_ACTIONS) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return new Set([1, 2]);
  if (raw === 'all') return new Set(Object.keys(TIERS).map(Number));
  const tiers = new Set(raw.split(',').map((t) => Number(t.replace(/^tier/, '').trim())).filter((t) => TIERS[t]));
  return tiers.size ? tiers : new Set([1]);
}

/** The catalog entries this deployment can commit. */
export function enabledActions(value) {
  const tiers = enabledTiers(value);
  return ACTIONS.filter((a) => tiers.has(a.tier));
}

/** The one entry with this id, enabled or not. */
export function actionById(id) {
  return ACTIONS.find((a) => a.id === id) || null;
}

/**
 * The proposal tools the agent sees — only for actions someone can commit,
 * so the model never proposes what the endpoint would refuse.
 */
export function proposalTools(value) {
  return enabledActions(value).map((a) => a.tool);
}

/** The human-click endpoints, sorted — the page a reviewer reads. */
export function endpoints() {
  return ACTIONS.map((a) => a.endpoint).sort();
}

/** Every instance table an action can write, deduplicated and sorted. */
export function writableTables() {
  const tables = new Set();
  for (const a of ACTIONS) {
    for (const t of a.instance.tables || []) tables.add(t);
    for (const t of a.instance.alsoWrites?.tables || []) tables.add(t);
  }
  return [...tables].sort();
}
