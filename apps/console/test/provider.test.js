// The model endpoint is configuration, not a constant (ADR 0008 D9).
//
// server/agent.js constructs `new Anthropic()` with no options, which is the
// whole mechanism behind the `gateway` adapter: the SDK reads ANTHROPIC_BASE_URL
// and ANTHROPIC_AUTH_TOKEN, so an enterprise can put its own LLM gateway — with
// its DLP, logging and egress rules — in front of every model call without a
// line of code changing here. /site/compare#models tells people that in public,
// so it needs to keep being true: someone "tidying" the client by pinning a
// baseURL would quietly move every customer's traffic back to the public API.
//
// The round trip below is the same shape ADR 0008 D9 requires before a provider
// config may save: one streamed tool call, start to finish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const SERVER_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'server',
);

test('no module pins the model endpoint to the public API', () => {
  for (const file of fs.readdirSync(SERVER_DIR).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
    // A per-org gateway URL (ADR 0008 D9 `gateway` adapter) is configuration
    // flowing through; a string literal here would be a pinned endpoint.
    assert.doesNotMatch(
      source, /baseURL\s*[:=]\s*['"`]/,
      `${file} pins a literal baseURL — the endpoint has to stay the org's or ANTHROPIC_BASE_URL's to configure`,
    );
    assert.doesNotMatch(
      source, /api\.anthropic\.com/,
      `${file} hardcodes api.anthropic.com — a gateway deployment would silently bypass its own proxy`,
    );
  }
});

test('a streamed tool call goes to the configured gateway, not to Anthropic', async () => {
  const GATEWAY = 'https://llm-gateway.internal.example.com/anthropic';
  const sse = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'sn_query', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"table":"incident"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

  const env = { ...process.env };
  const realFetch = globalThis.fetch;
  let requested = null;

  try {
    process.env.ANTHROPIC_BASE_URL = GATEWAY;
    process.env.ANTHROPIC_AUTH_TOKEN = 'a-token-the-customer-issued';
    delete process.env.ANTHROPIC_API_KEY;

    globalThis.fetch = async (url, init) => {
      requested = String(url);
      const auth = init?.headers?.get?.('authorization') ?? init?.headers?.authorization ?? null;
      assert.ok(auth, 'the gateway token has to reach the gateway');
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };

    // Constructed exactly the way server/agent.js does it.
    const message = await new Anthropic().beta.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      system: [{ type: 'text', text: 'system' }],
      tools: [{
        name: 'sn_query',
        description: 'query records',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
      }],
      messages: [{ role: 'user', content: 'anything' }],
    }).finalMessage();

    assert.ok(
      requested.startsWith(GATEWAY),
      `the call went to ${requested}, not through the configured gateway`,
    );
    assert.equal(message.stop_reason, 'tool_use');
    assert.deepEqual(
      message.content.filter((b) => b.type === 'tool_use').map((b) => [b.name, b.input]),
      [['sn_query', { table: 'incident' }]],
      'the tool call has to survive the round trip, or the gateway is useless to this agent',
    );
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
  }
});
