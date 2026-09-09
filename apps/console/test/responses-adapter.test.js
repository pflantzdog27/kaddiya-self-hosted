// The OpenAI Responses adapter (ADR 0009 D4). Same shape of proof as the
// Chat Completions adapter's tests: the translation pinned both ways without
// a network, then the streamed tool-call round trip the save-time smoke test
// performs, against a fake endpoint.
//
// The reason this adapter exists is itself a test below: gpt-6-astra must be
// routed to /responses, because its tool calling does not exist on
// /chat/completions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toResponsesRequest, toInputItems, reduceEvents, createResponsesClient,
} from '../server/providers/responses.js';
import { clientFor, smokeTestModel } from '../server/agent.js';
import { modelInfo, estimateCost } from '../server/models.js';

const PARAMS = {
  model: 'gpt-6-astra',
  max_tokens: 16000,
  system: [{ type: 'text', text: 'You are the caddie.', cache_control: { type: 'ephemeral' } }],
  tools: [{
    name: 'sn_query',
    description: 'query records',
    input_schema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
  }],
  tool_choice: { type: 'tool', name: 'sn_query' },
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
  output_config: { effort: 'high' },
  messages: [
    { role: 'user', content: 'what is open?' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'call_1', name: 'sn_query', input: { table: 'incident' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: '[{"number":"INC0010001"}]' },
    ] },
  ],
};

test('request translation: instructions, flat tools, call/result items, and effort as reasoning.effort', () => {
  const body = toResponsesRequest(PARAMS);
  assert.equal(body.model, 'gpt-6-astra');
  assert.equal(body.stream, true);
  assert.equal(body.max_output_tokens, 16000);
  assert.equal(body.instructions, 'You are the caddie.');
  // Nothing of the conversation is left on the provider's side.
  assert.equal(body.store, false);

  assert.deepEqual(body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'what is open?' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
    { type: 'function_call', call_id: 'call_1', name: 'sn_query', arguments: '{"table":"incident"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '[{"number":"INC0010001"}]' },
  ]);
  assert.deepEqual(body.tools, [{
    type: 'function',
    name: 'sn_query',
    description: 'query records',
    parameters: PARAMS.tools[0].input_schema,
    strict: false,
  }]);
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'sn_query' });

  // The one Anthropic-shaped param that survives, in this dialect's spelling.
  assert.deepEqual(body.reasoning, { effort: 'high' });
  for (const key of ['betas', 'fallbacks', 'output_config', 'system', 'max_tokens', 'messages']) {
    assert.equal(key in body, false, `${key} is Anthropic-only and must not reach the endpoint`);
  }
  assert.doesNotMatch(JSON.stringify(body), /cache_control/, 'prompt-caching hints are dropped, not forwarded');

  // Left unset, no reasoning block is invented — the model's default applies.
  assert.equal('reasoning' in toResponsesRequest({ model: 'gpt-6-astra', messages: [] }), false);
});

test('request translation: block tool results flatten; a user turn keeps text and results; tool_choice forms', () => {
  assert.deepEqual(toInputItems({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
    { type: 'text', text: 'and also this' },
  ] }), [
    { type: 'function_call_output', call_id: 'a', output: 'one\ntwo' },
    { role: 'user', content: [{ type: 'input_text', text: 'and also this' }] },
  ]);
  assert.deepEqual(toInputItems({ role: 'assistant', content: 'plain' }), [
    { role: 'assistant', content: [{ type: 'output_text', text: 'plain' }] },
  ]);
  assert.equal(toResponsesRequest({ model: 'm', messages: [], tool_choice: { type: 'any' } }).tool_choice, 'required');
  assert.equal(toResponsesRequest({ model: 'm', messages: [], tool_choice: { type: 'auto' } }).tool_choice, 'auto');
});

// A streamed answer: text deltas, then a completed function_call item, then
// the terminal event carrying usage.
const EVENTS = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-6-astra-2026-08-01' } },
  { type: 'response.output_text.delta', delta: 'Let me ' },
  { type: 'response.output_text.delta', delta: 'look.' },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [] } },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'sn_query', arguments: '{"table":"incident","limit":5}' } },
  { type: 'response.completed', response: { model: 'gpt-6-astra-2026-08-01', usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 30 } } },
];

test('event reduction: text, a function_call item and usage become a Messages-shaped message', () => {
  const message = reduceEvents(EVENTS);
  assert.equal(message.model, 'gpt-6-astra-2026-08-01');
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content, [
    { type: 'text', text: 'Let me look.' },
    { type: 'tool_use', id: 'call_abc', name: 'sn_query', input: { table: 'incident', limit: 5 } },
  ]);
  // input_tokens counts the cached ones; they are split so each part is
  // billed at its own rate.
  assert.deepEqual(message.usage, {
    input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0,
  });

  const plain = reduceEvents([
    { type: 'response.output_text.delta', delta: 'done' },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 1 } } },
  ]);
  assert.equal(plain.stop_reason, 'end_turn');
  assert.deepEqual(plain.content, [{ type: 'text', text: 'done' }]);
  assert.equal(plain.usage.cache_read_input_tokens, 0);

  const cut = reduceEvents([
    { type: 'response.output_text.delta', delta: 'x' },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 2 } } },
  ]);
  assert.equal(cut.stop_reason, 'max_tokens');
  assert.equal(cut.usage.output_tokens, 2);
});

test('a failed response surfaces the endpoint\'s own words rather than an empty turn', () => {
  assert.throws(
    () => reduceEvents([{ type: 'response.failed', response: { error: { message: 'the model refused the tool schema' } } }]),
    /refused the tool schema/,
  );
  assert.throws(() => reduceEvents([{ type: 'error', message: 'upstream timeout' }]), /upstream timeout/);
});

test('gpt-6-astra is routed to Responses, and the Anthropic models are untouched by it', () => {
  const astra = modelInfo('gpt-6-astra');
  assert.equal(astra.kind, 'openai');
  assert.equal(astra.api, 'responses');
  assert.equal(astra.supportsEffort, true);
  assert.equal(clientFor({ kind: 'openai', model: 'gpt-6-astra' }).api, 'responses');

  // Every other OpenAI id, known or not, stays on Chat Completions — a
  // custom endpoint (Azure, vLLM, LiteLLM) may not serve /responses at all.
  assert.equal(clientFor({ kind: 'openai', model: 'gpt-5.4' }).api, 'chat');
  assert.equal(clientFor({ kind: 'openai', model: 'some-local-llama' }).api, 'chat');

  // Haiku through Fable still go to the Anthropic adapter, unchanged.
  for (const id of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5']) {
    assert.equal(modelInfo(id).kind, 'anthropic');
    assert.equal(modelInfo(id).api, 'chat', 'the api field is inert for Anthropic ids');
    const client = clientFor({ kind: 'anthropic', apiKey: 'sk-ant-test', model: id });
    assert.equal(client.kind, 'anthropic');
    assert.equal(client.api, 'messages');
  }
});

test('the cost line bills gpt-6-astra at its listed rates, cached input included', () => {
  const info = modelInfo('gpt-6-astra');
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 };
  // Short-context tier: $10 in, $50 out, $1 cached (2026-09-06).
  assert.equal(estimateCost(info, usage), 10 + 50 + 1);
});

test('a streamed tool call goes to /responses on the configured base URL and back through the agent-facing surface', async () => {
  const BASE = 'https://my-resource.openai.azure.com/openai/v1';
  const sse = EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  let requested = null;
  let sent = null;
  const fetchImpl = async (url, init) => {
    requested = String(url);
    sent = { headers: init.headers, body: JSON.parse(init.body) };
    return new Response(
      new ReadableStream({
        start(controller) {
          // Awkward byte boundaries, to exercise the shared line buffer.
          const bytes = new TextEncoder().encode(sse);
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };

  const client = createResponsesClient({ apiKey: 'sk-test', baseUrl: BASE + '/', fetchImpl });
  const stream = client.messages.stream(PARAMS);
  const deltas = [];
  stream.on('text', (d) => deltas.push(d));
  const message = await stream.finalMessage();

  assert.equal(requested, `${BASE}/responses`);
  assert.equal(sent.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(deltas, ['Let me ', 'look.']);
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(
    message.content.filter((b) => b.type === 'tool_use').map((b) => [b.name, b.input]),
    [['sn_query', { table: 'incident', limit: 5 }]],
  );
});

test('the save-time gate exercises /responses and the effort value the org typed (ADR 0008 D9)', async () => {
  const realFetch = globalThis.fetch;
  let sent = null;
  try {
    // The fake answers in whichever dialect the adapter asked for, so this
    // test proves the routing rather than assuming it.
    globalThis.fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) };
      const payload = sent.url.endsWith('/responses') ? [
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_p', name: 'ping', arguments: '{"ok":true}' } },
        { type: 'response.completed', response: { model: 'gpt-6-astra', usage: { input_tokens: 20, output_tokens: 5 } } },
      ] : [
        { model: 'gpt-5.4', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_p', type: 'function', function: { name: 'ping', arguments: '{"ok":true}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } },
      ];
      return new Response(payload.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
    };
    const result = await smokeTestModel({ kind: 'openai', apiKey: 'sk-test', model: 'gpt-6-astra', effort: 'xhigh' });
    assert.equal(sent.url, 'https://api.openai.com/v1/responses');
    assert.deepEqual(sent.body.tool_choice, { type: 'function', name: 'ping' });
    // The dial is under test at save time, so a rejected value fails here.
    assert.deepEqual(sent.body.reasoning, { effort: 'xhigh' });
    assert.equal(result.usage.input_tokens, 20);

    // A model that does not take the dial never gets it, whatever is stored.
    await smokeTestModel({ kind: 'openai', apiKey: 'sk-test', model: 'gpt-5.4', effort: 'high' });
    assert.equal('reasoning_effort' in sent.body, false);
    assert.equal(sent.url, 'https://api.openai.com/v1/chat/completions');

    // The endpoint answers without calling the tool: the gate still refuses.
    globalThis.fetch = async () => new Response(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'pong' })}\n\ndata: [DONE]\n\n`, { status: 200 },
    );
    await assert.rejects(
      smokeTestModel({ kind: 'openai', apiKey: 'sk-test', model: 'gpt-6-astra' }),
      /without a tool call/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
