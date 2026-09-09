// The OpenAI Responses adapter (ADR 0009 D4; the second OpenAI-side dialect).
//
// Why a second one: the reasoning models — gpt-6-astra first — support Chat
// Completions, but not tool calling on it. OpenAI's own guidance is blunt:
// "GPT-6 Astra supports Chat Completions, but tool calling requires
// Responses" (https://developers.openai.com/api/docs/guides/latest-model,
// read 2026-09-06). Kaddiya's loop is nothing but tool calls, so for those
// models Chat Completions is not an option and no parameter tweak makes it
// one: the 400 that sends people here suggests reasoning_effort 'none', but
// that model rejects 'none' outright.
//
// The internal contract is unchanged — agent.js builds Messages-shaped
// params and reads back a Messages-shaped message. This file translates at
// the edge, the way providers/openai.js does for Chat Completions, and it is
// selected per model by the registry's `api: 'responses'`, never guessed.
//
// What is dropped, on purpose: `cache_control` (the Responses cache is
// automatic, and reports cached tokens back through usage), `betas` and
// `fallbacks` (Anthropic-only). `output_config.effort` is NOT dropped here —
// it becomes `reasoning.effort`, which is this dialect's own dial.
//
// Everything except `createResponsesClient` is pure, so the translation is
// tested without a network.

import { sseChunks } from './openai.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

// ---- request: Messages params -> a Responses request body ----

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n');
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
}

function toolResultText(block) {
  const c = block.content;
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === 'text' ? b.text : JSON.stringify(b))).join('\n');
  return JSON.stringify(c);
}

/**
 * One Messages-API message -> one or more Responses input items.
 *
 * Tool traffic is flat here rather than nested in a message: a call is a
 * `function_call` item and its result a `function_call_output` item carrying
 * the same `call_id`. Our history already orders them call-then-result, and
 * this mapping preserves that order.
 */
export function toInputItems(message) {
  const { role, content } = message;
  if (role === 'assistant') {
    const out = [];
    const text = blockText(content);
    if (text) out.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type !== 'tool_use') continue;
      out.push({
        type: 'function_call',
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      });
    }
    return out;
  }
  if (typeof content === 'string') return [{ role: 'user', content: [{ type: 'input_text', text: content }] }];
  const out = [];
  for (const b of content || []) {
    if (b?.type === 'tool_result') {
      out.push({ type: 'function_call_output', call_id: b.tool_use_id, output: toolResultText(b) });
    }
  }
  const text = blockText(content);
  if (text) out.push({ role: 'user', content: [{ type: 'input_text', text }] });
  return out;
}

/** Messages tools -> Responses function tools (flat, not nested under `function`). */
export function toResponsesTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
    // Structured Outputs would reject our schemas (not every one sets
    // additionalProperties:false); the loop validates tool input itself.
    strict: false,
  }));
}

export function toResponsesToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === 'tool') return { type: 'function', name: choice.name };
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  return 'auto';
}

export function toResponsesRequest(params) {
  const input = [];
  for (const m of params.messages || []) input.push(...toInputItems(m));

  const body = {
    model: params.model,
    input,
    stream: true,
    // Nothing of the customer's conversation is left on the provider's side
    // to be listed or replayed later; the transcript we keep is our own.
    store: false,
  };
  const sys = systemText(params.system);
  if (sys) body.instructions = sys;
  if (params.max_tokens != null) body.max_output_tokens = params.max_tokens;
  const tools = toResponsesTools(params.tools);
  if (tools) body.tools = tools;
  const toolChoice = toResponsesToolChoice(params.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  // The one Anthropic-shaped param that survives: effort is this dialect's
  // dial too, under a different name. Left unset, the model's own default
  // applies — we do not invent one.
  const effort = params.output_config?.effort;
  if (effort) body.reasoning = { effort };
  if (params.temperature != null) body.temperature = params.temperature;
  return body;
}

// ---- response: streamed events -> a Messages-shaped message ----

export function newStreamState() {
  return { model: null, text: '', toolCalls: [], incomplete: null, usage: null };
}

/**
 * Fold one streamed event into the state. Returns the text delta it carried
 * (or null). Events this loop does not need — reasoning summaries, item
 * lifecycle noise — are ignored rather than guessed at.
 */
export function applyEvent(state, event) {
  const type = event?.type;
  if (type === 'error') throw new Error(event.message || JSON.stringify(event));
  if (event?.response?.model && !state.model) state.model = event.response.model;
  if (type === 'response.output_text.delta') {
    const delta = event.delta || '';
    if (!delta) return null;
    state.text += delta;
    return delta;
  }
  if (type === 'response.output_item.done' && event.item?.type === 'function_call') {
    const item = event.item;
    state.toolCalls.push({ id: item.call_id || item.id, name: item.name, args: item.arguments || '' });
    return null;
  }
  if (type === 'response.failed') {
    throw new Error(event.response?.error?.message || 'the endpoint reported response.failed');
  }
  if (type === 'response.incomplete') {
    state.incomplete = event.response?.incomplete_details?.reason || 'incomplete';
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    if (event.response?.usage) state.usage = event.response.usage;
  }
  return null;
}

function parseArguments(call) {
  const raw = String(call.args || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error(`the endpoint streamed a tool call (${call.name}) whose arguments were not valid JSON`);
  }
}

function toUsage(usage) {
  const input = usage?.input_tokens || 0;
  const cached = usage?.input_tokens_details?.cached_tokens || 0;
  return {
    // As in the Chat Completions adapter: input_tokens counts the cached
    // ones, so split them out and let estimateCost bill each at its rate.
    input_tokens: Math.max(0, input - cached),
    output_tokens: usage?.output_tokens || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

export function finishMessage(state, { model } = {}) {
  const content = [];
  if (state.text) content.push({ type: 'text', text: state.text });
  state.toolCalls.forEach((call, i) => {
    content.push({
      type: 'tool_use',
      id: call.id || `call_${i}`,
      name: call.name || '',
      input: parseArguments(call),
    });
  });
  const stop_reason = state.toolCalls.length ? 'tool_use'
    : state.incomplete === 'max_output_tokens' ? 'max_tokens'
    : 'end_turn';
  return {
    model: state.model || model || null,
    role: 'assistant',
    stop_reason,
    content,
    usage: toUsage(state.usage),
  };
}

/** Convenience for tests and non-streaming callers: events in, message out. */
export function reduceEvents(events, opts) {
  const state = newStreamState();
  for (const event of events) applyEvent(state, event);
  return finishMessage(state, opts);
}

// ---- the client: the same surface agent.js uses for every adapter ----

export function createResponsesClient({ apiKey, baseUrl, fetchImpl } = {}) {
  const root = String(baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const doFetch = fetchImpl || globalThis.fetch;

  function stream(params, { signal } = {}) {
    const listeners = { text: [] };
    const run = (async () => {
      const res = await doFetch(`${root}/responses`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(toResponsesRequest(params)),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = text;
        try { detail = JSON.parse(text)?.error?.message || text; } catch { /* plain text */ }
        throw new Error(`${res.status} from ${root}/responses: ${String(detail).slice(0, 500) || res.statusText}`);
      }
      if (!res.body) throw new Error(`${root} answered without a body`);
      const state = newStreamState();
      for await (const event of sseChunks(res.body)) {
        const delta = applyEvent(state, event);
        if (delta) for (const cb of listeners.text) cb(delta);
      }
      return finishMessage(state, { model: params.model });
    })();
    run.catch(() => {});
    return {
      on(event, cb) {
        if (listeners[event]) listeners[event].push(cb);
        return this;
      },
      finalMessage: () => run,
    };
  }

  return { messages: { stream }, beta: { messages: { stream } } };
}
