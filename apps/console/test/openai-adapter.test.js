// The OpenAI-compatible adapter (ADR 0009 D4): one internal contract (the
// Anthropic Messages API), translated at the edge. These tests pin the
// translation both ways without a network, then run the same streamed
// tool-call round trip the save-time smoke test performs, against a fake
// endpoint, to prove the loop cannot tell the adapters apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toChatRequest, toChatMessages, reduceChunks, sseChunks, createOpenAIClient, DEFAULT_OPENAI_BASE_URL,
} from '../server/providers/openai.js';
import { estimateCost, modelInfo } from '../server/models.js';

const PARAMS = {
  model: 'gpt-5-mini',
  max_tokens: 16000,
  system: [{ type: 'text', text: 'You are the caddie.', cache_control: { type: 'ephemeral' } }],
  tools: [{
    name: 'sn_query',
    description: 'query records',
    input_schema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'], additionalProperties: false },
  }],
  tool_choice: { type: 'tool', name: 'sn_query' },
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
  output_config: { effort: 'low' },
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

test('request translation: system, tools, tool calls and results, tool_choice; Anthropic-only params dropped', () => {
  const body = toChatRequest(PARAMS);
  assert.equal(body.model, 'gpt-5-mini');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_completion_tokens, 16000);

  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are the caddie.' },
    { role: 'user', content: 'what is open?' },
    { role: 'assistant', content: 'Looking.', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'sn_query', arguments: '{"table":"incident"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_1', content: '[{"number":"INC0010001"}]' },
  ]);
  assert.deepEqual(body.tools, [{
    type: 'function',
    function: { name: 'sn_query', description: 'query records', parameters: PARAMS.tools[0].input_schema },
  }]);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'sn_query' } });

  for (const key of ['betas', 'fallbacks', 'output_config', 'system', 'max_tokens']) {
    assert.equal(key in body, false, `${key} is Anthropic-only and must not reach the endpoint`);
  }
  assert.doesNotMatch(JSON.stringify(body), /cache_control/, 'prompt-caching hints are dropped, not forwarded');
});

test('request translation: a tool result made of blocks becomes a string; a user turn with text and results keeps both', () => {
  const out = toChatMessages({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], is_error: true },
    { type: 'text', text: 'and also this' },
  ] });
  assert.deepEqual(out, [
    { role: 'tool', tool_call_id: 'a', content: 'one\ntwo' },
    { role: 'user', content: 'and also this' },
  ]);
  assert.deepEqual(toChatMessages({ role: 'assistant', content: 'plain' }), [{ role: 'assistant', content: 'plain' }]);
  assert.equal(toChatRequest({ model: 'm', messages: [], tool_choice: { type: 'any' } }).tool_choice, 'required');
  assert.equal(toChatRequest({ model: 'm', messages: [], tool_choice: { type: 'auto' } }).tool_choice, 'auto');
});

// A streamed answer: text deltas, one tool call whose name and arguments
// arrive across several chunks, then the usage-only chunk.
const CHUNKS = [
  { id: 'c', model: 'gpt-5-mini-2026-01-01', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  { id: 'c', choices: [{ index: 0, delta: { content: 'Let me ' }, finish_reason: null }] },
  { id: 'c', choices: [{ index: 0, delta: { content: 'look.' }, finish_reason: null }] },
  { id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'sn_query', arguments: '' } }] }, finish_reason: null }] },
  { id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"table":' } }] }, finish_reason: null }] },
  { id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"incident","limit"' } }] }, finish_reason: null }] },
  { id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':5}' } }] }, finish_reason: null }] },
  { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { id: 'c', choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1000 } } },
];

test('chunk reduction: text, a tool call split across chunks, and usage become a Messages-shaped message', () => {
  const message = reduceChunks(CHUNKS);
  assert.equal(message.model, 'gpt-5-mini-2026-01-01');
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content, [
    { type: 'text', text: 'Let me look.' },
    { type: 'tool_use', id: 'call_abc', name: 'sn_query', input: { table: 'incident', limit: 5 } },
  ]);
  // prompt_tokens includes the cached ones; they are split so each part is
  // billed at its own rate.
  assert.deepEqual(message.usage, {
    input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0,
  });

  const plain = reduceChunks([
    { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } },
  ]);
  assert.equal(plain.stop_reason, 'end_turn');
  assert.deepEqual(plain.content, [{ type: 'text', text: 'done' }]);
  assert.equal(plain.usage.cache_read_input_tokens, 0);

  const cut = reduceChunks([{ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'length' }] }]);
  assert.equal(cut.stop_reason, 'max_tokens');
});

test('the cost line bills cached OpenAI tokens at the listed cached rate, never at the Anthropic multiplier', () => {
  const info = modelInfo('gpt-5-mini');
  assert.equal(info.kind, 'openai');
  const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 };
  assert.equal(estimateCost(info, usage), 0.25 + 0.025);
  // A priced OpenAI model with no cached rate on the page: cached tokens count as 0, not as a guess.
  assert.equal(estimateCost({ kind: 'openai', input: 1, output: 1 }, usage), 1);
});

test('a streamed tool call goes to the configured base URL and comes back through the agent-facing surface', async () => {
  const BASE = 'https://llm-gateway.internal.example.com/openai/v1';
  const sse = CHUNKS.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  let requested = null;
  let sent = null;
  const fetchImpl = async (url, init) => {
    requested = String(url);
    sent = { headers: init.headers, body: JSON.parse(init.body) };
    return new Response(
      new ReadableStream({
        start(controller) {
          // Deliver in awkward byte boundaries to exercise the line buffer.
          const bytes = new TextEncoder().encode(sse);
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };

  const client = createOpenAIClient({ apiKey: 'sk-test', baseUrl: BASE + '/', fetchImpl });
  const stream = client.messages.stream(PARAMS);
  const deltas = [];
  stream.on('text', (d) => deltas.push(d));
  const message = await stream.finalMessage();

  assert.equal(requested, `${BASE}/chat/completions`);
  assert.equal(sent.headers.authorization, 'Bearer sk-test');
  assert.equal(sent.body.stream, true);
  assert.deepEqual(deltas, ['Let me ', 'look.']);
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(
    message.content.filter((b) => b.type === 'tool_use').map((b) => [b.name, b.input]),
    [['sn_query', { table: 'incident', limit: 5 }]],
  );
  assert.equal(DEFAULT_OPENAI_BASE_URL, 'https://api.openai.com/v1');
});

test('the save-time smoke test runs through the OpenAI adapter when the config says so (ADR 0008 D9 gate, both kinds)', async () => {
  const { smokeTestModel } = await import('../server/agent.js');
  const realFetch = globalThis.fetch;
  let sent = null;
  try {
    globalThis.fetch = async (url, init) => {
      sent = { url: String(url), body: JSON.parse(init.body) };
      const chunks = [
        { model: 'gpt-5-nano', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_p', type: 'function', function: { name: 'ping', arguments: '{"ok":true}' } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } },
      ];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
    };
    const result = await smokeTestModel({ kind: 'openai', apiKey: 'sk-test', baseUrl: 'https://vllm.internal.example.com/v1', model: 'gpt-5-nano' });
    assert.equal(sent.url, 'https://vllm.internal.example.com/v1/chat/completions');
    assert.deepEqual(sent.body.tool_choice, { type: 'function', function: { name: 'ping' } });
    assert.equal(result.model, 'gpt-5-nano');
    assert.equal(result.usage.input_tokens, 20);

    // The endpoint answers, but never calls the tool: the gate refuses.
    globalThis.fetch = async () => new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200 },
    );
    await assert.rejects(
      smokeTestModel({ kind: 'openai', apiKey: 'sk-test', model: 'gpt-5-nano' }),
      /without a tool call/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an error status surfaces the endpoint's own words", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 });
  const client = createOpenAIClient({ apiKey: 'bad', fetchImpl });
  await assert.rejects(
    client.messages.stream({ model: 'gpt-5-nano', messages: [{ role: 'user', content: 'hi' }] }).finalMessage(),
    /401 .*Incorrect API key provided/,
  );
});

test('SSE parsing ignores comments and blank lines and stops at [DONE]', async () => {
  const text = ': keep-alive\n\ndata: {"a":1}\r\n\ndata: {"a":2}\n\ndata: [DONE]\n\ndata: {"a":3}\n';
  const body = new Response(text).body;
  const seen = [];
  for await (const chunk of sseChunks(body)) seen.push(chunk.a);
  assert.deepEqual(seen, [1, 2]);
});
