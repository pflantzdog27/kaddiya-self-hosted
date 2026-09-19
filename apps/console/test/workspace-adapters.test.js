// The workspace tools, through all three provider dialects (acceptance 13).
//
// The agent loop's whole design is that it cannot tell the adapters apart:
// Messages-shaped params in, a Messages-shaped message out, with the dialect
// chosen by `model.kind`. A new tool family is exactly the kind of thing that
// quietly works on one endpoint and not another — a schema an adapter drops,
// a tool call it cannot reassemble — so the same call is round-tripped
// through each of them against a fake endpoint.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { clientFor, toolDefinitions, workspaceTools } from '../server/agent.js';
import { startFakeProvider } from './helpers/fake-provider.js';

const providers = [];
after(async () => { for (const p of providers) await p.stop(); });

const CREATE = {
  id: 'toolu_workspace_1',
  name: 'workspace_create_output',
  input: {
    title: 'Incident escalation process',
    filename: 'incident escalation process',
    format: 'markdown',
    content: '# Incident escalation process\n\nWho to wake, and when.\n',
  },
};

async function roundTrip({ dialect, kind, model }) {
  const provider = await startFakeProvider({ dialect, script: [{ text: 'Saving that now.', tools: [CREATE] }] });
  providers.push(provider);
  const client = clientFor({ kind, model, apiKey: 'fake', baseUrl: provider.baseUrl });
  const stream = client.stream({
    model,
    max_tokens: 16000,
    system: [{ type: 'text', text: 'You are Kaddiya.' }],
    tools: toolDefinitions(),
    messages: [{ role: 'user', content: 'Document our incident escalation process.' }],
  });
  const message = await stream.finalMessage();
  return { provider, message };
}

const CASES = [
  { label: 'Anthropic Messages', dialect: 'anthropic', kind: 'anthropic', model: 'claude-opus-5' },
  { label: 'OpenAI Chat Completions', dialect: 'chat', kind: 'openai', model: 'gpt-5-mini' },
  { label: 'OpenAI Responses', dialect: 'responses', kind: 'openai', model: 'gpt-6-astra' },
];

for (const testCase of CASES) {
  test(`${testCase.label}: the workspace tools travel and a save comes back whole`, async () => {
    const { provider, message } = await roundTrip(testCase);

    // Every workspace tool was offered, with its schema intact.
    const offered = provider.lastTools();
    for (const tool of workspaceTools()) {
      assert.ok(offered.includes(tool.name), `${testCase.label} dropped ${tool.name}`);
    }

    // And the call came back as the internal contract's shape, whatever the
    // wire format was: the loop above this never learns which one it got.
    const call = message.content.find((b) => b.type === 'tool_use');
    assert.ok(call, `${testCase.label} produced no tool call`);
    assert.equal(call.name, 'workspace_create_output');
    assert.equal(call.id, CREATE.id);
    assert.deepEqual({ ...call.input }, CREATE.input, 'the document survived the round trip byte for byte');
    assert.equal(message.stop_reason, 'tool_use');
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    assert.equal(text, 'Saving that now.');
  });
}

test('the schemas an adapter sends are the console\'s own, not a second definition', async () => {
  const anthropic = await roundTrip(CASES[0]);
  const chat = await roundTrip(CASES[1]);
  const responses = await roundTrip(CASES[2]);

  const schemaOf = (body, name) => {
    const tools = body.tools || [];
    const found = tools.find((t) => t.name === name || t.function?.name === name);
    return found?.input_schema || found?.function?.parameters || found?.parameters;
  };
  const source = workspaceTools().find((t) => t.name === 'workspace_update_output').input_schema;

  for (const [label, provider] of [['anthropic', anthropic.provider], ['chat', chat.provider], ['responses', responses.provider]]) {
    const sent = schemaOf(provider.requests.at(-1).body, 'workspace_update_output');
    assert.deepEqual(sent.properties.expected_revision, source.properties.expected_revision,
      `${label}: expected_revision must survive — it is the whole of the conflict check`);
    assert.deepEqual([...sent.required].sort(), [...source.required].sort(), `${label}: required fields changed in translation`);
  }
});

test('an endpoint that refuses fails visibly rather than inventing a saved file', async () => {
  const provider = await startFakeProvider({ script: [{ status: 400, error: 'tools are not supported on this deployment' }] });
  providers.push(provider);
  const client = clientFor({ kind: 'anthropic', model: 'claude-opus-5', apiKey: 'fake', baseUrl: provider.baseUrl });
  await assert.rejects(
    client.stream({
      model: 'claude-opus-5', max_tokens: 100,
      system: [{ type: 'text', text: 's' }], tools: toolDefinitions(),
      messages: [{ role: 'user', content: 'hi' }],
    }).finalMessage(),
    (err) => /tools are not supported|400/.test(String(err.message)),
  );
});
