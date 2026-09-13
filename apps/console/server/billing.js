// Self-hosted model selection and usage accounting.
//
// This distribution has no hosted plans or platform billing. Every deployment
// runs on model credentials supplied by its operator, either in the
// environment or through the Admin model-connection screen.

import { withOrg } from './db.js';
import { modelInfo, effortValues, resolveEffort } from './models.js';
import { DEFAULT_OPENAI_BASE_URL } from './providers/openai.js';

export const PLANS = {
  'self-hosted': {
    id: 'self-hosted',
    label: 'Self-hosted',
    turns_per_month: null,
    trial_budget_usd: 0,
    max_instances: null,
    max_members: null,
    model: 'your model connections',
  },
};

export function planFor() {
  return PLANS['self-hosted'];
}

const kindOf = (provider) => (provider === 'openai' ? 'openai' : 'anthropic');

export function defaultModelFor(provider) {
  return provider === 'openai' ? 'gpt-5.4' : process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
}

/** Models configured for this deployment, ordered with the selected default first. */
function modelChoices(org = {}) {
  const own = (org.model_connections || []).map((connection) => ({
    id: connection.id,
    model_id: connection.model_id,
    label: `${connection.label} · ${connection.model_id}`,
    kind: kindOf(connection.provider),
    provider: 'org',
  }));
  const envModel = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    own.push({ id: envModel, model_id: envModel, label: `${modelInfo(envModel).label} · environment`, kind: 'anthropic', provider: 'env' });
  }
  const preferred = org.default_model_connection;
  return preferred ? [...own.filter((model) => model.id === preferred), ...own.filter((model) => model.id !== preferred)] : own;
}

/** Public capabilities and defaults, without credentials. */
export function availableModels(org = {}) {
  return modelChoices(org).map((model) => {
    const connection = (org.model_connections || []).find((candidate) => candidate.id === model.id);
    const configured = (connection ? connection.effort : process.env.ANTHROPIC_EFFORT) || '';
    return {
      ...model,
      effort_values: effortValues(model.model_id, { kind: model.kind }),
      default_effort: resolveEffort(model.model_id, { kind: model.kind, configured }),
    };
  });
}

export async function modelConfigFor(org, ctx, { connectionKey, modelId } = {}) {
  const selected = modelId || availableModels(org)[0]?.id;
  const connection = (org.model_connections || []).find((candidate) => candidate.id === selected);
  if (connection) {
    if (!connectionKey) throw new Error('Model credential lookup is unavailable.');
    return {
      provider: 'org',
      kind: kindOf(connection.provider),
      label: connection.label,
      selection_id: connection.id,
      apiKey: await connectionKey(ctx, connection.id),
      baseUrl: connection.base_url || (connection.provider === 'openai' ? DEFAULT_OPENAI_BASE_URL : undefined),
      model: connection.model_id,
      effort: connection.effort || '',
    };
  }
  if (selected && !availableModels(org).some((model) => model.id === selected)) {
    throw new Error('This model is no longer available. Choose another connection.');
  }
  if (!selected || selected === (process.env.ANTHROPIC_MODEL || 'claude-opus-5')) {
    return {
      provider: 'env',
      kind: 'anthropic',
      label: 'environment',
      apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
      baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
      model: selected,
      effort: process.env.ANTHROPIC_EFFORT || '',
    };
  }
  throw new Error('Add a model connection in Admin before starting a turn.');
}

export async function usageSummary(ctx) {
  const { rows } = await withOrg(ctx.orgId, (client) => client.query(
    `SELECT
       count(*) FILTER (WHERE ts >= date_trunc('month', now()))::int AS turns_this_month,
       count(*) FILTER (WHERE ts >= date_trunc('month', now()))::int AS trial_turns_this_month,
       count(*)::int AS turns_total,
       0::float AS trial_spend_usd,
       COALESCE(sum(cost_usd) FILTER (WHERE ts >= date_trunc('month', now())), 0)::float AS spend_this_month_usd,
       COALESCE(sum(cost_usd), 0)::float AS spend_total_usd
     FROM usage_events`,
  ));
  return rows[0];
}

export async function gateTurn(org, ctx, deps = {}) {
  const plan = planFor(org);
  const [usage, model] = await Promise.all([usageSummary(ctx), modelConfigFor(org, ctx, deps)]);
  model.effort = resolveEffort(model.model, { kind: model.kind, requested: deps.effort, configured: model.effort });
  const base = { plan, usage, model: { provider: model.provider, kind: model.kind, label: model.label, model: model.model } };
  if (!model.apiKey) {
    return { ...base, ok: false, reason: 'no_model_key', message: 'Add and test your first model in Admin → Your models to finish setup.' };
  }
  return { ...base, ok: true, model };
}

export async function recordUsage(ctx, { instanceId, userSysId, conversationId, model, provider, usage, cost }) {
  await withOrg(ctx.orgId, (client) => client.query(
    `INSERT INTO usage_events (org_id, instance_id, sn_user_sys_id, conversation_id, model, provider,
                               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [instanceId || null, userSysId || null, conversationId || null, model || null, provider || 'org',
      usage?.input_tokens || 0, usage?.output_tokens || 0, usage?.cache_read_input_tokens || 0,
      usage?.cache_creation_input_tokens || 0, cost == null ? null : Number(cost.toFixed(6))],
  ));
}
