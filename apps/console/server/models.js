// Model registry: pricing + per-model API capabilities.
//
// Costs are USD per 1M tokens. The dollar figure shown in the UI is an
// ESTIMATE for steering spend — not a billing record. Check the provider's
// console for authoritative numbers.
//
// `kind` picks the adapter (ADR 0009 D4): 'anthropic' covers direct keys and
// Anthropic-compatible gateways; 'openai' is the Chat Completions dialect
// (OpenAI, Azure OpenAI, vLLM, LiteLLM, internal gateways).
//
// Anthropic cache figures use the standard multipliers (read = 0.1x input,
// 5-minute write = 1.25x input). OpenAI lists a cached-input rate per model
// (`cachedInput`); its cache is automatic, so there is no write price.
//
// OpenAI prices: https://developers.openai.com/api/docs/pricing (where
// platform.openai.com/docs/pricing redirects), standard tier, checked
// 2026-09-06 — each entry cross-checked against its model page at
// https://developers.openai.com/api/docs/models/<id> on the same day, which
// is also where the context windows come from. Models whose price the page
// does not state, or whose price third-party trackers disagreed with on that
// date (the gpt-5.6 family), are left out on purpose: an unpriced model
// cannot be trial-eligible because the trial budget gate sums cost_usd.

// Effort capabilities checked 2026-09-10 against the provider model pages:
// https://developers.openai.com/api/docs/models/gpt-5.4
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
// https://developers.openai.com/api/docs/models/gpt-5.4-nano
// https://developers.openai.com/api/docs/models/gpt-5.1
// https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://platform.claude.com/docs/en/build-with-claude/effort
export const MODELS = {
  'claude-haiku-4-5': {
    kind: 'anthropic',
    label: 'Haiku 4.5',
    input: 1, output: 5,
    contextTokens: 200_000,
    supportsEffort: false,   // effort errors on Haiku 4.5
    supportsFallbacks: false,
    maxToolResultChars: 12_000,
  },
  'claude-sonnet-5': {
    kind: 'anthropic',
    label: 'Sonnet 5',
    input: 2, output: 10,
    contextTokens: 1_000_000,
    supportsEffort: true,
    effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFallbacks: false,
    maxToolResultChars: 30_000,
  },
  'claude-opus-5': {
    kind: 'anthropic',
    label: 'Opus 5',
    input: 5, output: 25,
    contextTokens: 1_000_000,
    supportsEffort: true,
    effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFallbacks: true,
    maxToolResultChars: 30_000,
  },
  'claude-fable-5': {
    kind: 'anthropic',
    label: 'Fable 5',
    input: 10, output: 50,
    contextTokens: 1_000_000,
    supportsEffort: true,
    effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFallbacks: true,
    maxToolResultChars: 30_000,
  },

  // ---- OpenAI, USD per 1M tokens, 2026-09-06 ----
  //
  // `api: 'responses'` picks the Responses adapter for this model. It is not
  // a preference: OpenAI's guidance says gpt-6-astra "supports Chat
  // Completions, but tool calling requires Responses", and every Kaddiya
  // turn carries tools. Everything below stays on Chat Completions.
  //
  // Pricing note: the page lists a short- and a long-context tier for this
  // model ($10/$1/$50 and $20/$2/$75 per 1M). The estimate uses the short
  // tier, so a turn that crosses into the long tier costs more than the line
  // shows — the figure is a steer, not a bill (see the header).
  'gpt-6-astra': {
    kind: 'openai',
    api: 'responses',
    label: 'GPT-6 Astra',
    input: 10, cachedInput: 1, output: 50,
    contextTokens: 1_050_000,
    // reasoning.effort takes low | medium | high | xhigh | max. 'none' and
    // 'minimal' are rejected by this model, so the dial cannot be turned off.
    supportsEffort: true,
    effortValues: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFallbacks: false,
    maxToolResultChars: 30_000,
  },

  // ---- OpenAI (Chat Completions) ----
  'gpt-5.4': {
    kind: 'openai',
    label: 'GPT-5.4',
    input: 2.5, cachedInput: 0.25, output: 15,
    contextTokens: 1_050_000,
    supportsEffort: true,
    effortValues: ['none', 'low', 'medium', 'high', 'xhigh'],
    supportsFallbacks: false,
    maxToolResultChars: 30_000,
  },
  'gpt-5.4-mini': {
    kind: 'openai',
    label: 'GPT-5.4 mini',
    input: 0.75, cachedInput: 0.075, output: 4.5,
    contextTokens: 400_000,
    supportsEffort: true,
    effortValues: ['none', 'low', 'medium', 'high', 'xhigh'],
    supportsFallbacks: false,
    maxToolResultChars: 30_000,
  },
  'gpt-5.4-nano': {
    kind: 'openai',
    label: 'GPT-5.4 nano',
    input: 0.2, cachedInput: 0.02, output: 1.25,
    contextTokens: 400_000,
    supportsEffort: true,
    effortValues: ['none', 'low', 'medium', 'high', 'xhigh'],
    supportsFallbacks: false,
    maxToolResultChars: 12_000,
  },
  'gpt-5.1': {
    kind: 'openai',
    label: 'GPT-5.1',
    input: 1.25, cachedInput: 0.125, output: 10,
    contextTokens: 400_000,
    supportsEffort: true,
    effortValues: ['none', 'low', 'medium', 'high'],
    supportsFallbacks: false,
    maxToolResultChars: 30_000,
  },
  'gpt-5': {
    kind: 'openai',
    label: 'GPT-5',
    input: 1.25, cachedInput: 0.125, output: 10,
    contextTokens: 400_000,
    supportsEffort: true,
    effortValues: ['minimal', 'low', 'medium', 'high'],
    supportsFallbacks: false,
    maxToolResultChars: 30_000,
  },
  'gpt-5-mini': {
    kind: 'openai',
    label: 'GPT-5 mini',
    input: 0.25, cachedInput: 0.025, output: 2,
    contextTokens: 400_000,
    supportsEffort: true,
    effortValues: ['minimal', 'low', 'medium', 'high'],
    supportsFallbacks: false,
    maxToolResultChars: 12_000,
  },
  'gpt-5-nano': {
    kind: 'openai',
    label: 'GPT-5 nano',
    input: 0.05, cachedInput: 0.005, output: 0.4,
    contextTokens: 400_000,
    supportsEffort: true,
    effortValues: ['minimal', 'low', 'medium', 'high'],
    supportsFallbacks: false,
    maxToolResultChars: 12_000,
  },
  'gpt-4.1': {
    kind: 'openai',
    label: 'GPT-4.1',
    input: 2, cachedInput: 0.5, output: 8,
    contextTokens: 1_047_576,
    supportsEffort: false,
    supportsFallbacks: false,
    maxToolResultChars: 30_000,
  },
  'gpt-4.1-mini': {
    kind: 'openai',
    label: 'GPT-4.1 mini',
    input: 0.4, cachedInput: 0.1, output: 1.6,
    contextTokens: 1_047_576,
    supportsEffort: false,
    supportsFallbacks: false,
    maxToolResultChars: 12_000,
  },
};

// Unknown model id: assume the conservative feature set so a typo or a newer
// model degrades to a plain request instead of a 400. The kind comes from
// the provider configuration, never guessed from the id.
const CONSERVATIVE = {
  kind: 'anthropic',
  api: 'chat',
  label: null,
  input: null, output: null,
  contextTokens: 200_000,
  supportsEffort: false,
  supportsFallbacks: false,
  maxToolResultChars: 12_000,
};

export function modelInfo(id, { kind } = {}) {
  const known = MODELS[id];
  // `api` defaults to 'chat': an unknown or newly-listed OpenAI id goes to
  // Chat Completions, which is where a custom endpoint (Azure, vLLM,
  // LiteLLM) is most likely to answer at all.
  if (known) return { id, known: true, api: 'chat', ...known };
  return { id, known: false, ...CONSERVATIVE, ...(kind ? { kind } : {}), label: id };
}

/** Registry entries of one kind, as [{ id, label, kind, ... }]. */
export function modelsOfKind(kind) {
  return Object.entries(MODELS)
    .filter(([, m]) => m.kind === kind)
    .map(([id, m]) => ({ id, ...m }));
}

/** Rough USD estimate for one turn. Returns null when pricing is unknown. */
export function estimateCost(info, usage) {
  if (info.input == null) return null;
  const M = 1_000_000;
  const cachedRead = info.kind === 'openai'
    // OpenAI bills cached prompt tokens at the model's listed cached rate;
    // when the page lists none, they are not counted rather than guessed.
    ? (info.cachedInput ?? 0)
    : info.input * 0.1;
  const cacheWrite = info.kind === 'openai' ? 0 : info.input * 1.25;
  return (
    ((usage.input_tokens || 0) * info.input +
      (usage.output_tokens || 0) * info.output +
      (usage.cache_read_input_tokens || 0) * cachedRead +
      (usage.cache_creation_input_tokens || 0) * cacheWrite) / M
  );
}

/** Capabilities for the selected dialect; unknown endpoint aliases stay conservative. */
export function effortValues(id, { kind } = {}) {
  const info = modelInfo(id, { kind });
  return info.supportsEffort && (!kind || kind === info.kind) ? [...(info.effortValues || [])] : [];
}

/** Empty/omitted means inherit the configured default, never disable reasoning. */
export function resolveEffort(id, { kind, requested, configured = '' } = {}) {
  const values = effortValues(id, { kind });
  if (requested !== undefined && requested !== '') {
    if (typeof requested !== 'string' || !values.includes(requested)) {
      throw new Error('Choose an effort level supported by this model.');
    }
    return requested;
  }
  return values.includes(configured) ? configured : '';
}
