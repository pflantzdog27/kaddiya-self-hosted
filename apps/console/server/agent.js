import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { prepareDynamicRecord } from './dynamic-records.js';
import { modelInfo, estimateCost } from './models.js';
import { createOpenAIClient } from './providers/openai.js';
import { createResponsesClient } from './providers/responses.js';
import { detectRelease, searchDocs, getDoc, SUPPORTED_FAMILIES } from './docs.js';
import { saveNote, notesForPrompt } from './notebook.js';
import { proposalTools, actionById } from './actions.js';
import { scriptProblems } from './commits.js';
import { nextStepStream, stripNextStep } from './nextstep.js';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompts', 'system.md'), 'utf8');

const MAX_LOOP_ITERATIONS = 12;

// One SDK client per credential (ADR 0008 D9): the org's own key or gateway
// when it has one, the labelled trial key otherwise, the environment on a
// self-hosted deployment. Constructed lazily and cached by credential, never
// at import time (imports are hoisted above dotenv). The endpoint is never a
// literal here: it is the org's configured gateway or ANTHROPIC_BASE_URL.
const clients = new Map();
function anthropic(model = {}) {
  const key = `${model.apiKey || ''}|${model.baseUrl || ''}`;
  let client = clients.get(key);
  if (!client) {
    const options = {};
    if (model.apiKey) options.apiKey = model.apiKey;
    if (model.baseUrl) options.baseURL = model.baseUrl;
    client = new Anthropic(options);
    clients.set(key, client);
    if (clients.size > 200) clients.delete(clients.keys().next().value);
  }
  return client;
}

/**
 * The adapter seam (ADR 0009 D4): one internal contract — Messages-shaped
 * params in, a Messages-shaped message out — and the endpoint's dialect
 * chosen by `model.kind`. 'anthropic' (the default) covers a direct key and
 * an Anthropic-compatible gateway; 'openai' is translated, either to Chat
 * Completions or — for the models whose tool calling only exists there — to
 * Responses, as the registry's `api` says. The loop below never learns which
 * one it got.
 */
export function clientFor(model = {}) {
  if (model.kind === 'openai') {
    const { api } = modelInfo(model.model, { kind: 'openai' });
    const create = api === 'responses' ? createResponsesClient : createOpenAIClient;
    const client = create({ apiKey: model.apiKey, baseUrl: model.baseUrl });
    return { kind: 'openai', api: api === 'responses' ? 'responses' : 'chat', stream: (params, options) => client.messages.stream(params, options) };
  }
  return { kind: 'anthropic', api: 'messages', stream: (params, options) => anthropic(model).beta.messages.stream(params, options) };
}

/**
 * The save-time check ADR 0008 D9 requires before a provider config may be
 * stored: one streamed tool-call round trip against the configured endpoint,
 * through whichever adapter the config selects. Throws with the endpoint's
 * own words when it fails.
 */
export async function smokeTestModel(model) {
  const info = modelInfo(model.model, { kind: model.kind === 'openai' ? 'openai' : 'anthropic' });
  const stream = clientFor(model).stream({
    model: model.model,
    max_tokens: 64,
    // The effort dial goes through the smoke test as well: a value this
    // model rejects (gpt-6-astra refuses 'none') then fails here, with the
    // endpoint's own words, instead of on the org's first turn.
    ...(model.effort && info.supportsEffort ? { output_config: { effort: model.effort } } : {}),
    tools: [{
      name: 'ping',
      description: 'Reply through this tool.',
      input_schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    }],
    tool_choice: { type: 'tool', name: 'ping' },
    messages: [{ role: 'user', content: 'Call the ping tool with ok=true.' }],
  });
  const message = await stream.finalMessage();
  const call = message.content.find((b) => b.type === 'tool_use');
  if (!call) throw new Error('the endpoint answered, but without a tool call — tool use is required');
  return { model: message.model, usage: message.usage };
}

export function toolDefinitions(actionsTiers) {
  return [
    // Every tool that can end in an instance write comes from the catalog
    // (ADR 0010 D1), filtered to the tiers this org enables; the read tools
    // below are defined here.
    ...proposalTools(actionsTiers),
    {
      name: 'sn_query',
      description:
        'Query records from any ServiceNow table as the signed-in user (Table API). Returns display values. Use encoded query syntax.',
      input_schema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name, e.g. incident, sys_user, sc_req_item' },
          query: { type: 'string', description: 'Encoded query, e.g. active=true^priority=1' },
          fields: { type: 'string', description: 'Comma-separated field names to return (keep this tight)' },
          limit: { type: 'integer', description: 'Max records, default 15, cap 50' },
          order_by: { type: 'string', description: 'Field to sort by, descending (e.g. sys_created_on)' },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'sn_schema',
      description:
        'Get the schema of a ServiceNow table: its label, parent table (super_class), scope, and the fields defined directly on it (element, type, reference, mandatory).',
      input_schema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name, e.g. incident' },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'sn_aggregate',
      description:
        'Count / group records via the Aggregate API. Use for "how many" questions instead of pulling records.',
      input_schema: {
        type: 'object',
        properties: {
          table: { type: 'string' },
          query: { type: 'string', description: 'Encoded query filter' },
          group_by: { type: 'string', description: 'Field to group counts by (e.g. state, assignment_group)' },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'sn_my_work',
      description:
        "The signed-in user's own work queue — records assigned to them or to one of their groups, priority first. Defaults to the `task` table, which spans incidents, catalog tasks, HR cases and every other work type at once (check sys_class_name to see what each is). Use this for \"what's on my plate / my docket\".",
      input_schema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Defaults to task. Narrow to incident, sn_hr_core_case etc. only if asked.' },
          include_groups: { type: 'boolean', description: 'Include records assigned to the user\'s groups (default true)' },
          only_active: { type: 'boolean', description: 'Only active records (default true)' },
          limit: { type: 'integer' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: 'sn_record',
      description:
        'Full detail for one record plus its journal (comments and work notes), by sys_id or by number. Use this when the user focuses on a specific case. Opening a record also displays it in the side panel for the user.',
      input_schema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table the record lives on (use sys_class_name from a prior result)' },
          sys_id: { type: 'string' },
          number: { type: 'string', description: 'Alternative to sys_id, e.g. INC0010023' },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'sn_similar',
      description:
        'Find PRIOR RESOLVED records that resemble some text, with their close notes — the "have we solved this before?" lookup. Pass the short description or symptom text of the case you are working, and exclude the current record.',
      input_schema: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Defaults to incident' },
          text: { type: 'string', description: 'Symptom/description text to match against' },
          exclude_sys_id: { type: 'string', description: 'sys_id of the case being worked, so it is not returned' },
          limit: { type: 'integer' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'sn_update_set',
      description:
        "Read the signed-in user's current update set — the set that new global-scope configuration changes get captured into. Call this BEFORE proposing any configuration change so you know where the change will land.",
      input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    {
      name: 'sn_update_set_contents',
      description:
        'List the captured changes (sys_update_xml entries) inside an update set — use this after creating an artifact to prove the change was captured and show the user what is in the set.',
      input_schema: {
        type: 'object',
        properties: {
          sys_id: { type: 'string', description: 'Update set sys_id; omit for the current set' },
          limit: { type: 'integer' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: 'sn_docs_search',
      description:
        "Full-text search of the official ServiceNow documentation pinned to THIS instance's release family. Use it for platform behaviour, API and syntax questions, and before proposing configuration changes, so the answer matches the release actually running — not memory of another version. Returns matching topics; read one with sn_docs_get and cite its path or url in your answer.",
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A few concrete search words, e.g. "update set capture scope"' },
          publication: {
            type: 'string',
            description:
              'Optional publication to narrow to: application-development, api-reference, platform-administration, platform-security, platform-user-interface, it-service-management, employee-service-management, governance-risk-compliance, intelligent-experiences',
          },
          limit: { type: 'integer', description: 'Max topics, default 8' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'sn_docs_get',
      description:
        'Read one documentation topic by the markdown path sn_docs_search returned, from the docs for this instance\'s release family. Read before relying on a topic; cite it in the answer.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'A markdown/**/*.md path from sn_docs_search' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'sn_note_save',
      description:
        "Propose a gotcha about THIS instance for the console's local instance notebook. The note is shown to the user on a keep/discard card: if they keep it, it is shown to you at the start of every future conversation on this instance, so the same surprise never costs time twice; if they discard it, it is gone. Until it is kept it informs only this conversation. Save concise, durable, instance-specific facts: renamed states or choice values, ACL denials on specific tables, routing conventions, integration quirks, naming standards. Do NOT save record contents, personal data, or generic ServiceNow knowledge. This never writes to ServiceNow.",
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The gotcha, stated as a durable fact, max 500 chars' },
          context: { type: 'string', description: 'Optional table or area it applies to, e.g. "incident" or "ACLs"' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'sn_list_tables',
      description: 'Search the table catalog (sys_db_object) by name or label to discover where data lives.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Substring to match against table name or label' },
          limit: { type: 'integer' },
        },
        required: ['search'],
        additionalProperties: false,
      },
    },
  ];
}

// Draw the card, and under a plan-approved run commit it too. The card data
// carries a proposal_id so the browser can flip that card to its committed
// state when the `committed` event follows (or show the failure).
async function propose(ctx, emit, actionId, body, cardEvent, cardData, reply) {
  const proposal_id = crypto.randomUUID();
  emit(cardEvent, { proposal_id, automatic: !!ctx.scope?.planCommit, ...cardData });
  const planCommit = ctx.scope?.planCommit;
  if (!planCommit) return reply;
  try {
    const result = await planCommit(actionId, body);
    emit('committed', { proposal_id, action: actionId, result });
    return {
      status: 'committed',
      note: 'This proposal was committed under the plan the user approved, on their credentials, and is audited to them. Report it as done and carry on with the plan.',
      result,
    };
  } catch (err) {
    emit('commit_failed', { proposal_id, action: actionId, error: String(err?.message || err) });
    return {
      status: 'commit_failed',
      error: String(err?.message || err),
      note: 'The instance refused this commit. Read the error, fix the proposal if it is fixable, and propose again; otherwise report it in the run summary.',
    };
  }
}

export async function executeTool(sn, name, input, emit, ctx = {}) {
  if (ctx.scope?.readOnly && name.startsWith('sn_propose_')) throw new Error('This stage is read-only.');
  switch (name) {
    case 'sn_query': return sn.queryTable(input);
    case 'sn_schema': return sn.schema(input);
    case 'sn_aggregate': return sn.aggregate(input);
    case 'sn_list_tables': return sn.listTables(input);
    case 'sn_my_work': return sn.myWork(input);
    case 'sn_similar': return sn.similar(input);

    case 'sn_docs_search': {
      const release = await detectRelease(sn);
      return searchDocs({ family: release.family, query: input.query, publication: input.publication, limit: input.limit });
    }
    case 'sn_docs_get': {
      const release = await detectRelease(sn);
      return getDoc({ family: release.family, path: input.path });
    }

    // Writes to the console's local notebook only — never to the instance —
    // and lands PENDING behind a keep/discard card (ADR 0008 D5). An
    // unreviewed note informs this conversation and nothing else.
    case 'sn_note_save': {
      const saved = await saveNote(ctx.scope, {
        text: input.text,
        context: input.context,
        user: ctx.user?.user_name,
        conversation: ctx.conversationId,
      });
      emit('note', {
        id: saved.note.id,
        text: saved.note.text,
        context: saved.note.context || '',
        status: saved.note.status || 'pending',
      });
      return {
        status: saved.note.status === 'kept' ? 'already_kept' : 'pending_user_review',
        note: 'The note is on screen with Keep and Discard buttons. It will not be shown in future conversations unless the user keeps it. Do not claim it was saved for next time.',
      };
    }

    case 'sn_record': {
      const detail = await sn.getRecord(input);
      // Mirror the opened record into the side panel.
      emit('focus', { table: input.table, ...detail });
      return detail;
    }

    // Every sn_propose_* tool writes nothing by itself: it renders a card the
    // human commits from a separate endpoint on their click. Under a
    // plan-approved run (ADR 0011 D3) `ctx.scope.planCommit` is set, and
    // propose() commits the same payload through the same catalog function
    // right after drawing the card, on the approving user's token.
    case 'sn_propose_dynamic_record': {
      const prepared = await prepareDynamicRecord(sn, input, ctx.scope?.actionsTiers);
      // Security cards always remain manual, even during an authorized run.
      const proposalCtx = prepared.tier === 3 ? { ...ctx, scope: { ...ctx.scope, planCommit: null } } : ctx;
      return propose(proposalCtx, emit, 'dynamic.apply', prepared,
        'proposal', { action: 'dynamic.apply', ...prepared, rationale: input.rationale || '' },
        { status: 'proposal_shown_to_user', note: 'The validated record is ready for review. Nothing has been written. Security-sensitive cards require typing the record name; never claim completion until the commit succeeds.' });
    }

    case 'sn_propose_reply':
      return propose(ctx, emit, 'journal.append',
        { table: input.table, sys_id: input.sys_id, field: input.field, text: input.text },
        'draft', { table: input.table, sys_id: input.sys_id, field: input.field, text: input.text },
        { status: 'draft_shown_to_user', note: 'The draft is on screen with a Send button. Nothing has been written to the record. Do not claim it was sent — tell the user it is ready for them to review and send.' });

    case 'sn_update_set': return sn.currentUpdateSet();
    case 'sn_update_set_contents': return sn.updateSetContents(input);

    // Was an autonomous instance write until ADR 0008 D12; now a proposal card
    // like every other write in the catalog (ADR 0009 D2).
    case 'sn_propose_update_set': {
      const set = await sn.currentUpdateSet().catch(() => ({ current: null }));
      return propose(ctx, emit, 'update_set.create',
        { name: input.name, description: input.description || '' },
        'update_set_proposal', { name: input.name, description: input.description || '', current: set.current?.name || null },
        { status: 'proposal_shown_to_user', current_update_set: set.current?.name || 'Default (none selected)', note: 'The proposal is on screen with a Create button. No update set exists yet and the current set is unchanged. Do not claim it was created.' });
    }

    // A script that does not parse is not proposed at all (ADR 0011 D2): the
    // tool errors, the model fixes it, and the developer never sees a card
    // that would not save.
    case 'sn_propose_artifact': {
      const problems = scriptProblems(input.fields || {});
      if (problems.length) throw new Error(`Not proposed. ${problems.join('; ')}. Fix the script and propose again.`);
      const set = await sn.currentUpdateSet().catch(() => ({ current: null }));
      return propose(ctx, emit, 'config.create',
        { table: input.table, fields: input.fields || {} },
        'artifact', { table: input.table, rationale: input.rationale || '', fields: input.fields || {}, update_set: set.current?.name || null },
        { status: 'proposal_shown_to_user', will_be_captured_in: set.current?.name || 'Default (no update set selected)', note: 'The proposal is on screen with a Create button. Nothing exists on the instance yet. Do not claim it was created.' });
    }

    case 'sn_propose_record_update':
      return propose(ctx, emit, 'task.update',
        { table: input.table, sys_id: input.sys_id, fields: input.changes || {} },
        'proposal', { action: 'task.update', table: input.table, sys_id: input.sys_id, number: input.number || '', rationale: input.rationale || '', current: input.current || {}, changes: input.changes || {} },
        { status: 'proposal_shown_to_user', note: 'The change is on screen with an Apply button. The record is unchanged. Do not claim it was updated.' });

    case 'sn_propose_approval':
      return propose(ctx, emit, 'approval.decide',
        { sys_id: input.sys_id, decision: input.decision, comments: input.comments || '' },
        'proposal', { action: 'approval.decide', sys_id: input.sys_id, decision: input.decision, comments: input.comments || '', approving: input.approving || {} },
        { status: 'proposal_shown_to_user', note: 'The decision is on screen with a button. The approval is unchanged. Do not claim it was approved or rejected.' });

    case 'sn_propose_artifact_update': {
      const problems = scriptProblems(input.changes || {});
      if (problems.length) throw new Error(`Not proposed. ${problems.join('; ')}. Fix the script and propose again.`);
      const set = await sn.currentUpdateSet().catch(() => ({ current: null }));
      return propose(ctx, emit, 'config.update',
        { table: input.table, sys_id: input.sys_id, fields: input.changes || {} },
        'proposal', { action: 'config.update', table: input.table, sys_id: input.sys_id, name: input.name || '', rationale: input.rationale || '', current: input.current || {}, changes: input.changes || {}, update_set: set.current?.name || null },
        { status: 'proposal_shown_to_user', will_be_captured_in: set.current?.name || 'Default (no update set selected)', note: 'The change is on screen with an Apply button. The record is unchanged. Do not claim it was updated.' });
    }

    case 'sn_propose_catalog_order':
      return propose(ctx, emit, 'catalog.order',
        { item_sys_id: input.item_sys_id, variables: input.variables || {}, requested_for: input.requested_for || '' },
        'proposal', { action: 'catalog.order', item_sys_id: input.item_sys_id, item_name: input.item_name || '', variables: input.variables || {}, requested_for: input.requested_for || '', rationale: input.rationale || '' },
        { status: 'proposal_shown_to_user', note: 'The order is on screen with an Order button. Nothing has been requested. Do not claim it was ordered.' });

    case 'sn_propose_change':
      return propose(ctx, emit, 'change.create',
        { type: input.type, template_sys_id: input.template_sys_id || '', fields: input.fields || {} },
        'proposal', { action: 'change.create', type: input.type, template_sys_id: input.template_sys_id || '', template_name: input.template_name || '', fields: input.fields || {}, rationale: input.rationale || '' },
        { status: 'proposal_shown_to_user', note: 'The change request is on screen with a Create button. Nothing exists on the instance yet. Do not claim it was created.' });

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// A few rows for the tool card's expandable results table. The full result
// still goes to the model; this is only what the human sees on expand.
const PREVIEW_KEYS = [
  'number', 'short_description', 'title', 'state', 'priority', 'name', 'label',
  'publication', 'element', 'column_label', 'internal_type', 'type', 'target_name', 'action',
];

function previewOf(result) {
  const rows = Array.isArray(result) ? result
    : Array.isArray(result?.records) ? result.records
    : Array.isArray(result?.fields) ? result.fields
    : Array.isArray(result?.entries) ? result.entries
    : Array.isArray(result?.results) ? result.results
    : null;
  if (!rows?.length || typeof rows[0] !== 'object') return undefined;

  const keys = Object.keys(rows[0]).filter((k) => k !== 'sys_id');
  const preferred = PREVIEW_KEYS.filter((k) => keys.includes(k)).slice(0, 4);
  const cols = preferred.length ? preferred : keys.slice(0, 4);
  const display = (v) => {
    const s = v && typeof v === 'object' ? v.display_value ?? v.value ?? '' : v ?? '';
    const str = String(s);
    return str.length > 80 ? str.slice(0, 79) + '…' : str;
  };
  return rows.slice(0, 5).map((r) => Object.fromEntries(cols.map((k) => [k, display(r[k])])));
}

function summarize(name, result) {
  if (Array.isArray(result)) return `${result.length} record${result.length === 1 ? '' : 's'}`;
  if (name === 'sn_schema') return `${result.fields?.length ?? 0} fields`;
  if (name === 'sn_my_work') return `${result.records?.length ?? 0} on queue`;
  if (name === 'sn_similar') return `${result.records?.length ?? 0} prior · ${result.strategy}`;
  if (name === 'sn_record') return result.record?.number || 'record';
  if (name === 'sn_propose_dynamic_record') return 'record card — awaiting your approval';
  if (name === 'sn_propose_reply') return 'draft — awaiting your approval';
  if (name === 'sn_propose_artifact') return 'proposal — awaiting your approval';
  if (name === 'sn_propose_record_update') return 'proposal — awaiting your approval';
  if (name === 'sn_propose_approval') return 'decision — awaiting your approval';
  if (name === 'sn_propose_artifact_update') return 'proposal — awaiting your approval';
  if (name === 'sn_propose_catalog_order') return 'order — awaiting your approval';
  if (name === 'sn_propose_change') return 'proposal — awaiting your approval';
  if (name === 'sn_update_set') return result.current?.name || 'none selected';
  if (name === 'sn_propose_update_set') return 'proposal — awaiting your approval';
  if (name === 'sn_update_set_contents') return `${result.entries?.length ?? 0} captured change(s)`;
  if (name === 'sn_docs_search') return `${result.results?.length ?? 0} topics · ${result.family}`;
  if (name === 'sn_docs_get') return `${Math.max(1, Math.round((result.chars || 0) / 1000))}k chars · ${result.family}`;
  if (name === 'sn_note_save') return result.status === 'already_kept' ? 'already kept' : 'note — awaiting your approval';
  return 'ok';
}

/**
 * Run one agent turn. `emit(event, data)` streams progress to the browser.
 * Mutates `messages` (the per-session history) in place.
 */
export async function runAgentTurn({ cfg, sn, user, messages, userText, emit, audit, conversationId, scope, model, systemExtra, maxIterations, signal }) {
  signal?.throwIfAborted();
  await scope?.checkActive?.();
  messages.push({ role: 'user', content: userText });

  const release = await detectRelease(sn).catch(() => ({ family: SUPPORTED_FAMILIES[0], source: 'default' }));
  const notes = await notesForPrompt(scope);
  const systemText = SYSTEM_TEMPLATE
    .replaceAll('{{USER_NAME}}', user?.name || user?.user_name || 'an authenticated user')
    .replaceAll('{{USER_TITLE}}', user?.title || 'role unknown')
    .replaceAll('{{INSTANCE_URL}}', sn.cfg.instanceUrl)
    .replaceAll('{{DOCS_FAMILY}}', release.note ? `${release.family} (${release.note})` : release.family)
    .replaceAll('{{INSTANCE_NOTES}}', notes || '(none kept yet — propose the first gotcha this instance teaches you)');
  // A run stage adds its role (the reviewer, the builder mid-plan) after the
  // shared ground rules, so the invariants above stay first (ADR 0011 D1).
  const systemFull = systemExtra ? `${systemText}\n\n${systemExtra}` : systemText;

  const modelId = model?.model || cfg.model;
  const effort = model?.effort ?? cfg.effort;
  const client = clientFor(model);
  const info = modelInfo(modelId, { kind: client.kind });
  const isAnthropic = client.kind === 'anthropic';
  const usageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  // The last reply's suggested next step (server/nextstep.js): the browser
  // offers it in the composer; nothing runs from it.
  let nextStep = null;

  let exhausted = true;
  try {
  for (let i = 0; i < (maxIterations || MAX_LOOP_ITERATIONS); i++) {
    signal?.throwIfAborted();
    await scope?.checkActive?.();
    const params = {
      model: modelId,
      max_tokens: 16000,
      // tools -> system -> messages is the cache prefix order, so one breakpoint
      // at the end of system covers the tool definitions too. Watch the "cached"
      // figure in the UI to confirm it engaged (short prefixes may not qualify).
      // The cache breakpoint and the fallbacks below are Anthropic-only. The
      // effort dial is not: Responses takes it as reasoning.effort, so it is
      // set from the registry's capability rather than from the kind.
      system: [isAnthropic
        ? { type: 'text', text: systemFull, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: systemFull }],
      tools: toolDefinitions(scope?.actionsTiers).filter(t => !scope?.readOnly || !t.name.startsWith('sn_propose_')),
      messages,
    };
    // Effort is the main quality/cost dial — but it errors on models that
    // predate it (e.g. Haiku 4.5), so only send it where it is supported.
    // Each adapter renders it in its own dialect, or drops it: Chat
    // Completions has no equivalent that works alongside tools.
    if (effort && info.supportsEffort) {
      params.output_config = { effort };
    }
    // Server-side refusal fallbacks: reroute a safety-classifier decline to a
    // sibling model instead of failing the turn. Opus/Fable tier only.
    if (isAnthropic && info.supportsFallbacks) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    const stream = client.stream(params, { signal });

    const text = nextStepStream(emit);
    stream.on('text', (delta) => text.push(delta));

    const message = await stream.finalMessage();
    text.end();
    nextStep = stripNextStep(message.content) ?? nextStep;
    for (const k of Object.keys(usageTotals)) usageTotals[k] += message.usage?.[k] ?? 0;

    if (message.stop_reason === 'refusal') {
      messages.push({ role: 'assistant', content: message.content });
      emit('text', { delta: '\n\n_(The model declined this request.)_' });
      throw new Error('The model declined the task. Review the transcript before continuing.');
    }

    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    const toolUses = message.content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: message.content });

    if (message.stop_reason !== 'tool_use' || toolUses.length === 0) { exhausted = message.stop_reason === 'max_tokens'; break; }

    const toolResults = [];
    messages.push({ role: 'user', content: toolResults });
    try {
    for (const tu of toolUses) {
      signal?.throwIfAborted();
      await scope?.checkActive?.();
      const started = Date.now();
      emit('tool_start', { id: tu.id, name: tu.name, input: tu.input });
      let content;
      let isError = false;
      let summary;
      let preview;
      try {
        const result = await executeTool(sn, tu.name, tu.input, emit, { cfg, user, conversationId, scope });
        summary = summarize(tu.name, result);
        preview = previewOf(result);
        content = JSON.stringify(result);
        if (content.length > info.maxToolResultChars) {
          content = content.slice(0, info.maxToolResultChars) + `"...] (truncated — narrow the query)`;
        }
      } catch (err) {
        isError = true;
        summary = 'error';
        content = String(err?.message || err);
      }
      const ms = Date.now() - started;
      emit('tool_end', { id: tu.id, name: tu.name, ms, summary, preview, error: isError ? content : undefined });
      audit?.({ tool: tu.name, input: tu.input, ms, summary, error: isError || undefined });
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content, is_error: isError || undefined });
    }
    } finally {
      for (const tu of toolUses) if (!toolResults.some(r => r.tool_use_id === tu.id)) toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Execution interrupted. No confirmed result; read the record before retrying.', is_error: true });
    }
  }
  } catch (err) {
    err.meter = { usage: usageTotals, cost: estimateCost(info, usageTotals), model: modelId };
    throw err;
  }

  const cost = estimateCost(info, usageTotals);
  if (nextStep) emit('suggest', { text: nextStep });
  emit('done', {
    usage: usageTotals,
    cost,
    model: info.label,
    provider: model?.label || 'your key',
  });
  return { usage: usageTotals, cost, model: modelId, exhausted };
}
