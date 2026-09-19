// A stand-in for a model endpoint, speaking the three dialects the console
// already supports: the Anthropic Messages stream, OpenAI Chat Completions,
// and the OpenAI Responses API.
//
// This exists so the tool flow can be exercised for real — a turn that
// actually calls workspace_create_output, actually commits, actually emits
// output_saved — without a network, a key, or a bill. It is a development
// dependency in the truest sense: no production code imports it.
//
// A scenario is a list of turns. Each turn is what the "model" says when it
// is next asked: text, tool calls, or both. The requests it received are kept
// so a test can assert what the console actually sent — which tools were
// offered, what the system prompt carried, whether a document was echoed.

import http from 'node:http';

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function anthropicStream(res, turn) {
  const blocks = [];
  if (turn.text) blocks.push({ type: 'text', text: turn.text });
  for (const call of turn.tools || []) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
  }
  const stopReason = (turn.tools || []).length ? 'tool_use' : 'end_turn';

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Math.random().toString(36).slice(2)}`, type: 'message', role: 'assistant',
      model: turn.model || 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 0 },
    },
  });

  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      // Delivered in pieces, like the real thing, so the console's streaming
      // render is exercised rather than a single final blob.
      for (const piece of String(block.text).match(/[\s\S]{1,40}/g) || []) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
      }
    } else {
      sse(res, 'content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      const json = JSON.stringify(block.input);
      for (const piece of json.match(/[\s\S]{1,60}/g) || []) {
        sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } });
      }
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });

  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 300 },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function chatCompletionsStream(res, turn) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({
    id: 'chatcmpl-1', object: 'chat.completion.chunk', model: turn.model || 'gpt-test',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
  if (turn.text) send({ role: 'assistant', content: turn.text });
  (turn.tools || []).forEach((call, index) => {
    send({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] });
  });
  send({}, (turn.tools || []).length ? 'tool_calls' : 'stop');
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 120, completion_tokens: 300 } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function responsesStream(res, turn) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let index = 0;
  if (turn.text) {
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: index, item: { type: 'message', id: 'msg_1', role: 'assistant' } });
    sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', output_index: index, delta: turn.text });
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: index, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: turn.text }] } });
    index += 1;
  }
  for (const call of turn.tools || []) {
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: index, item: { type: 'function_call', id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: '' } });
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: index, item: { type: 'function_call', id: `fc_${call.id}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.input) } });
    index += 1;
  }
  sse(res, 'response.completed', {
    type: 'response.completed',
    response: { id: 'resp_1', model: turn.model || 'gpt-test', status: 'completed', usage: { input_tokens: 120, output_tokens: 300 } },
  });
  res.end();
}

/**
 * Start the endpoint. `script` is consumed one turn per request; when it runs
 * out the model simply says it is done, so a loop can never hang on an empty
 * scenario. `dialect` picks which wire format to answer in.
 */
export async function startFakeProvider({ script = [], dialect = 'anthropic' } = {}) {
  const requests = [];
  const queue = [...script];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* recorded as-is */ }
      requests.push({ url: req.url, body: parsed });
      const turn = queue.shift() || { text: 'Done.' };
      // `delayMs` holds the response open, so a test about concurrency can be
      // about concurrency rather than about how fast the loop happened to run.
      const answer = () => {
      if (turn.status) {
        res.writeHead(turn.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: turn.error || 'fake provider error' } }));
      }
      if (dialect === 'chat') return chatCompletionsStream(res, turn);
      if (dialect === 'responses') return responsesStream(res, turn);
      return anthropicStream(res, turn);
      };
      if (turn.delayMs) setTimeout(answer, turn.delayMs);
      else answer();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    /** Queue more turns for a later request. */
    push: (...turns) => queue.push(...turns),
    remaining: () => queue.length,
    /** Every tool name the console offered, on the last request. */
    lastTools: () => (requests.at(-1)?.body?.tools || []).map((t) => t.name || t.function?.name),
    lastSystem: () => {
      const system = requests.at(-1)?.body?.system;
      if (Array.isArray(system)) return system.map((b) => b.text).join('\n');
      if (typeof system === 'string') return system;
      // Chat Completions and Responses carry it as the first message/instruction.
      return requests.at(-1)?.body?.instructions
        || (requests.at(-1)?.body?.messages || []).find((m) => m.role === 'system')?.content
        || '';
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
