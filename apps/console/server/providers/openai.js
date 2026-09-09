// The OpenAI-compatible adapter (ADR 0009 D4; ADR 0008 D9 adapter 5).
//
// The internal contract stays the Anthropic Messages API: agent.js builds
// Messages-shaped params and reads back a Messages-shaped message. This file
// translates at the edge — to the Chat Completions / function-calling dialect
// on the way out, and from its streamed chunks on the way back — so one
// implementation covers OpenAI, Azure OpenAI (its `/openai/v1` surface),
// vLLM, LiteLLM and the internal gateways that speak Chat Completions.
//
// What is dropped, on purpose: `cache_control` (no prompt-caching hints in
// this dialect — OpenAI caches on its own and reports `cached_tokens`, which
// we surface as cache_read_input_tokens so the cost line stays honest),
// `betas`, `fallbacks`, `output_config` (Anthropic-only; agent.js never adds
// them for this kind). Nothing is invented: a request that needs a feature
// this dialect lacks fails at the endpoint with the endpoint's own words.
//
// The translation functions are pure and exported so they can be tested
// without a network; only `createOpenAIClient` touches `fetch`.

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

// ---- request: Messages params -> Chat Completions body ----

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

/** One Messages-API message -> one or more Chat Completions messages. */
export function toChatMessages(message) {
  const { role, content } = message;
  if (role === 'assistant') {
    const text = blockText(content);
    const calls = Array.isArray(content) ? content.filter((b) => b?.type === 'tool_use') : [];
    const out = { role: 'assistant', content: text || null };
    if (calls.length) {
      out.tool_calls = calls.map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
    }
    return [out];
  }
  // user: tool results become `tool` messages (one per result, and they must
  // directly follow the assistant turn that made the calls), then any text.
  if (typeof content === 'string') return [{ role: 'user', content }];
  const out = [];
  for (const b of content || []) {
    if (b?.type === 'tool_result') {
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b) });
    }
  }
  const text = blockText(content);
  if (text) out.push({ role: 'user', content: text });
  return out;
}

export function toChatTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export function toChatToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } };
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  return 'auto';
}

/**
 * Messages-API params (what agent.js builds) -> a streaming Chat Completions
 * request body. Anthropic-only keys are dropped here rather than forwarded.
 */
export function toChatRequest(params) {
  const messages = [];
  const sys = systemText(params.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of params.messages || []) messages.push(...toChatMessages(m));

  const body = {
    model: params.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (params.max_tokens != null) body.max_completion_tokens = params.max_tokens;
  const tools = toChatTools(params.tools);
  if (tools) body.tools = tools;
  const toolChoice = toChatToolChoice(params.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (params.temperature != null) body.temperature = params.temperature;
  if (params.stop_sequences?.length) body.stop = params.stop_sequences;
  return body;
}

// ---- response: streamed chunks -> a Messages-shaped message ----

export function newStreamState() {
  return { model: null, text: '', toolCalls: [], finishReason: null, usage: null };
}

/**
 * Fold one parsed `chat.completion.chunk` into the state. Returns the text
 * delta the chunk carried (or null) so the caller can stream it on.
 */
export function applyChunk(state, chunk) {
  if (chunk.model && !state.model) state.model = chunk.model;
  if (chunk.usage) state.usage = chunk.usage;
  let textDelta = null;
  for (const choice of chunk.choices || []) {
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      state.text += delta.content;
      textDelta = (textDelta || '') + delta.content;
    }
    for (const tc of delta.tool_calls || []) {
      const index = tc.index ?? state.toolCalls.length;
      const slot = state.toolCalls[index] || (state.toolCalls[index] = { id: null, name: null, args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = (slot.name || '') + tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) state.finishReason = choice.finish_reason;
  }
  return textDelta;
}

function parseArguments(call) {
  const raw = call.args.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error(`the endpoint streamed a tool call (${call.name}) whose arguments were not valid JSON`);
  }
}

function toUsage(usage) {
  const prompt = usage?.prompt_tokens || 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  return {
    // OpenAI's prompt_tokens includes the cached ones; split them out so
    // estimateCost bills each part at its own rate.
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: usage?.completion_tokens || 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/** The accumulated state -> a Messages-API message. */
export function finishMessage(state, { model } = {}) {
  const content = [];
  if (state.text) content.push({ type: 'text', text: state.text });
  const calls = state.toolCalls.filter(Boolean);
  calls.forEach((call, i) => {
    content.push({
      type: 'tool_use',
      id: call.id || `call_${i}`,
      name: call.name || '',
      input: parseArguments(call),
    });
  });
  const stop_reason = calls.length ? 'tool_use'
    : state.finishReason === 'length' ? 'max_tokens'
    : 'end_turn';
  return {
    model: state.model || model || null,
    role: 'assistant',
    stop_reason,
    content,
    usage: toUsage(state.usage),
  };
}

/** Convenience for tests and non-streaming callers: chunks in, message out. */
export function reduceChunks(chunks, opts) {
  const state = newStreamState();
  for (const chunk of chunks) applyChunk(state, chunk);
  return finishMessage(state, opts);
}

/**
 * Split an SSE byte stream into the JSON payloads of its `data:` lines.
 * Yields parsed objects; stops at `[DONE]`.
 */
export async function* sseChunks(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') return;
      yield JSON.parse(data);
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim();
    if (data && data !== '[DONE]') yield JSON.parse(data);
  }
}

// ---- the client: the surface agent.js uses ----

/**
 * `client.messages.stream(params)` returns an object with `.on('text', cb)`
 * and `finalMessage()` — the two things the agent loop touches on the
 * Anthropic SDK's stream — so the loop cannot tell the adapters apart.
 */
export function createOpenAIClient({ apiKey, baseUrl, fetchImpl } = {}) {
  const root = String(baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const doFetch = fetchImpl || globalThis.fetch;

  function stream(params, { signal } = {}) {
    const listeners = { text: [] };
    const run = (async () => {
      const res = await doFetch(`${root}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(toChatRequest(params)),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = text;
        try { detail = JSON.parse(text)?.error?.message || text; } catch { /* plain text */ }
        throw new Error(`${res.status} from ${root}: ${String(detail).slice(0, 500) || res.statusText}`);
      }
      if (!res.body) throw new Error(`${root} answered without a body`);
      const state = newStreamState();
      for await (const chunk of sseChunks(res.body)) {
        if (chunk?.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
        const delta = applyChunk(state, chunk);
        if (delta) for (const cb of listeners.text) cb(delta);
      }
      return finishMessage(state, { model: params.model });
    })();
    // A rejection is observed by finalMessage(); keep it from surfacing as
    // an unhandled rejection in the meantime.
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
