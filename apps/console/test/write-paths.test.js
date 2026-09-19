// The action-catalog invariant, pinned (ADR 0009 D2, ADR 0010 D1).
//
// "There is no autonomous write path in the build" is the product's central
// claim, and it is only worth making because it is checkable: the write
// endpoints fit on one page, and the agent's tool loop cannot reach any of
// them. This gate fails the build the day someone wires a mutating call into
// the tool loop — which is exactly how that claim would otherwise rot.
//
// Since ADR 0010 the page a reviewer reads is server/actions.js, and the
// lists below are derived from it rather than restated: a new action lands
// in the catalog or it does not land at all. What is still restated, on
// purpose, is the set of read tools and console-local endpoints — so that a
// write cannot slip in by being called something else.
//
// It reads source, deliberately. A behavioral test would prove the tools we
// thought to call are read-only; this proves the file contains no write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolDefinitions } from '../server/agent.js';
import { ACTIONS, CONFIG_TABLES, TIERS, endpoints, proposalTools, writableTables } from '../server/actions.js';
import { MCP_TOOLS, listTools } from '../server/mcp.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const read = (f) => fs.readFileSync(path.join(SERVER, f), 'utf8');

// Tools that only read the instance, the docs, or the console's own notebook.
// Anything not here and not in the catalog is a tool nobody reviewed.
const READ_TOOLS = [
  'sn_aggregate',
  'sn_docs_get',
  'sn_docs_search',
  'sn_list_tables',
  'sn_my_work',
  'sn_note_save',
  'sn_package_update_set',
  'sn_query',
  'sn_record',
  'sn_schema',
  'sn_similar',
  'sn_update_set',
  'sn_update_set_contents',
];

// The console's own workspace (spec §6). These write rows in THIS workspace's
// database and nothing else: no instance call, no filesystem path, no public
// URL. They are enumerated here rather than folded into READ_TOOLS because
// they do write — just never to ServiceNow — and a reviewer counting write
// paths deserves to see that distinction spelled out instead of inferred.
const WORKSPACE_TOOLS = [
  'workspace_create_output',
  'workspace_list_outputs',
  'workspace_read_output',
  'workspace_update_output',
];

// Mutating endpoints that never touch the instance: conversations, notebook,
// the agent turn itself, sign-out.
const CONSOLE_LOCAL_ENDPOINTS = [
  'DELETE /api/conversations/:id',
  'PATCH /api/conversations/:id',
  'POST /api/chat',
  'POST /api/conversations',
  'POST /api/notebook/discard',
  'POST /api/notebook/keep',
  // The artifact workspace: an output is rows in this workspace's own
  // database and bytes this console already had. "Save as document" is the
  // one mutating route — the model's own create/revise go through
  // server/outputs.js directly, never through an HTTP endpoint, and the read
  // and download routes are GETs. None of them reaches the instance, and
  // none of them is exposed to an MCP bearer (asserted below).
  'POST /api/conversations/:id/outputs',
  'POST /auth/logout',
  // Org setup, admin and billing (ADR 0008 D2/D17, Phases 2–3): rows in the
  // workspace database, never a call to the instance.
  'POST /api/org',
  'POST /api/org/draft/instance',
  'POST /api/admin/settings',
  'POST /api/admin/members/:id',
  'POST /api/admin/instances',
  // ADR 0011: runs are conversations with stages; the plan decision, the stop
  // and the stage request are console rows and streamed turns. The
  // environment toggle marks an instance non-production. None of them
  // reaches the instance except through commit(), which the catalog
  // endpoints below also use.
  'POST /api/runs',
  'POST /api/runs/:id/plan',
  'POST /api/runs/:id/stop',
  'POST /api/runs/:id/stage',
  'POST /api/admin/instances/:id/environment',
  // Model connections and instance credentials are rows in the workspace
  // database; the connection test is the only outbound call, to the provider.
  'POST /api/admin/models',
  'POST /api/admin/instances/:id/credentials',
  'POST /api/admin/instances/:id/disconnect',
  // ADR 0014: the MCP surface. POST /mcp is the JSON-RPC endpoint, and every
  // method reachable through it is a read — tools/call dispatches only through
  // MCP_TOOLS, which the test below pins as a subset of READ_TOOLS. The other
  // two are rows in the workspace database: one shows a bearer to the browser
  // that minted it, the other marks a row for revocation. Neither calls the
  // instance. This is the procedure this file's own header prescribes, and the
  // verdict above is unchanged: the write surface is the catalog and nothing else.
  'POST /mcp',
  'POST /api/mcp/tokens/:id/reveal',
  'POST /api/mcp/tokens/:id/revoke',
];

// Every SnClient method that mutates the instance, and the raw verbs they are
// built from. None may appear in the agent's tool loop.
const MUTATORS = [
  'applyDynamicRecord',
  'createUpdateSet',
  'createArtifact',
  'updateRecord',
  'decideApproval',
  'updateArtifact',
  'orderItem',
  'createChange',
  'addJournalEntry',
  'setUserPreference',
  '.post(',
  '.patch(',
  '.write(',
];

test('the agent tool loop cannot reach any instance write', () => {
  // Three files now reach the tool loop: agent.js, which the console drives,
  // mcp.js, which an external host drives (ADR 0014), and
  // update-set-package.js, which agent.js calls for sn_package_update_set.
  // None may contain a write — mcp.js calls executeTool, never an SnClient
  // mutator, and the packager only ever GETs the set and its entries.
  for (const file of ['agent.js', 'mcp.js', 'update-set-package.js']) {
    const source = read(file);
    for (const mutator of MUTATORS) {
      assert.ok(
        !source.includes(mutator),
        `server/${file} references ${mutator}. The agent proposes writes; it never performs them (ADR 0009 D2).`,
      );
    }
  }
  // The catalog itself is pure: it names endpoints, it does not implement them.
  const actions = read('actions.js');
  for (const token of ['fetch(', "from './", 'require(']) {
    assert.ok(!actions.includes(token), `server/actions.js contains ${token} — the catalog describes writes, it does not perform them`);
  }
});

test('the tool catalog is exactly the read tools, the workspace tools and the action catalog', () => {
  const names = toolDefinitions().map((t) => t.name).sort();
  const expected = [...READ_TOOLS, ...WORKSPACE_TOOLS, ...ACTIONS.map((a) => a.tool.name)].sort();
  assert.deepEqual(names, expected, 'the tool list changed — a new read tool is added to READ_TOOLS here; a console-local write is added to WORKSPACE_TOOLS; a new instance write is an entry in server/actions.js (ADR 0010 D1)');

  // The naming is load-bearing: a reviewer counts write paths by reading these
  // names, and so does the model. Anything that can end in an instance write
  // says so by starting with sn_propose_, and nothing else may.
  assert.deepEqual(
    names.filter((n) => n.startsWith('sn_propose_')),
    ACTIONS.map((a) => a.tool.name).sort(),
  );
  for (const name of READ_TOOLS) {
    assert.ok(!name.startsWith('sn_propose_'), `${name} is listed as a read tool but named as a proposal`);
  }

  // The naming boundary runs both ways: nothing that touches the instance may
  // be called `workspace_`, and nothing console-local may be called `sn_`.
  const workspace = names.filter((n) => n.startsWith('workspace_'));
  assert.deepEqual(workspace, [...WORKSPACE_TOOLS].sort(), 'a workspace_ tool appeared that this file does not list');
  for (const name of WORKSPACE_TOOLS) {
    assert.ok(!READ_TOOLS.includes(name) && !name.startsWith('sn_'),
      `${name} is console-local and must not be named as an instance tool`);
  }
  for (const tool of toolDefinitions().filter((t) => t.name.startsWith('workspace_'))) {
    assert.match(tool.description, /NOTHING to ServiceNow|Metadata only|Read the version/,
      `${tool.name} must tell the model plainly what it does and does not touch`);
  }
});

// The capability gate (spec §6): the workspace tools are offered only to a
// turn that was granted them, and that grant is independent of ServiceNow
// write permission in BOTH directions — a read-only investigation can write
// up its findings, and a turn with no workspace capability cannot save a file
// however many instance actions it is allowed to propose.
test('workspace tools are gated by their own capability, not by the instance write gate', async () => {
  const { executeTool } = await import('../server/agent.js');
  const names = (scope) => toolDefinitions(scope?.actionsTiers)
    .filter((t) => {
      if (scope?.readOnly && t.name.startsWith('sn_propose_')) return false;
      if (!scope?.outputs && t.name.startsWith('workspace_')) return false;
      return true;
    })
    .map((t) => t.name);

  const investigating = names({ readOnly: true, outputs: { conversationId: 'c', turnId: 't' } });
  assert.ok(WORKSPACE_TOOLS.every((n) => investigating.includes(n)), 'a read-only stage can still write up what it found');
  assert.ok(!investigating.some((n) => n.startsWith('sn_propose_')), 'and still cannot propose an instance write');

  const noWorkspace = names({ readOnly: false });
  assert.ok(!noWorkspace.some((n) => n.startsWith('workspace_')), 'no capability, no file tools');
  assert.ok(noWorkspace.some((n) => n.startsWith('sn_propose_')), 'while the instance proposals are unaffected');

  // And the gate is enforced at execution, not only by omission from the list.
  for (const name of WORKSPACE_TOOLS) {
    await assert.rejects(
      executeTool({}, name, {}, () => {}, { scope: { readOnly: false } }),
      /cannot save files in the workspace/,
      `${name} must refuse a turn that was never granted the capability`,
    );
  }
});

// The audit takes tool input verbatim. For a workspace write that input is the
// whole document, which would then sit in an audit row, an error log and any
// operator's grep. The row answers who saved what and whether it worked.
test('the tool audit records a saved file by shape, never by content', async () => {
  const { redactToolInput } = await import('../server/agent.js');
  const secret = '# Payroll incident\n\nThe caller is Jane Doe, employee 4471.';
  const redacted = redactToolInput('workspace_create_output', {
    title: 'Payroll incident 4471', filename: 'payroll-incident-4471', format: 'markdown', content: secret,
  });
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /Jane Doe|4471|Payroll/, 'no content, title or filename reaches the audit');
  assert.equal(redacted.format, 'markdown', 'the shape is still recorded');
  assert.equal(redacted.content_bytes, Buffer.byteLength(secret, 'utf8'));
  assert.equal(redacted.titled, true);

  const update = redactToolInput('workspace_update_output', { output_id: 'abc', expected_revision: 2, content: secret });
  assert.equal(update.output_id, 'abc');
  assert.equal(update.expected_revision, 2);
  assert.equal(update.content, undefined);

  // Instance tools are untouched: their inputs are the encoded query a
  // reviewer needs, and they carry no document.
  const query = { table: 'incident', query: 'active=true' };
  assert.deepEqual(redactToolInput('sn_query', query), query);
});

// ADR 0014 D1. The MCP surface is defined by exclusion from server/actions.js,
// and this is where that claim is checked: one exported list, a subset of the
// read tools, with the same schemas the console's model sees.
test('the MCP surface is a subset of the read tools, and nothing else', () => {
  const consoleTools = new Map(toolDefinitions().map((t) => [t.name, t]));

  for (const name of MCP_TOOLS) {
    assert.ok(READ_TOOLS.includes(name), `${name} is exposed over MCP but is not a read tool`);
    assert.ok(!name.startsWith('sn_propose_'), `${name} is a proposal and must not be exposed over MCP`);
  }
  assert.ok(!MCP_TOOLS.includes('sn_note_save'),
    'sn_note_save writes the console notebook behind a keep/discard card nobody can click over MCP');
  // ADR 0014 stands: the MCP surface is read-only. The workspace tools write
  // console rows and belong to a conversation an MCP bearer does not have.
  for (const name of WORKSPACE_TOOLS) {
    assert.ok(!MCP_TOOLS.includes(name), `${name} writes this workspace and must not be reachable over MCP`);
  }
  assert.equal(new Set(MCP_TOOLS).size, MCP_TOOLS.length, 'a name appears once');
  // The one read tool deliberately left out, and no more than that.
  assert.deepEqual(READ_TOOLS.filter((n) => !MCP_TOOLS.includes(n)), ['sn_note_save']);

  const exposed = listTools();
  assert.deepEqual(exposed.map((t) => t.name), [...MCP_TOOLS], 'the wire list is MCP_TOOLS, in order');
  for (const tool of exposed) {
    // The schema is the console's, passed through: a reviewer comparing the
    // two surfaces compares one definition, not two that may drift.
    assert.deepEqual(tool.inputSchema, consoleTools.get(tool.name).input_schema,
      `${tool.name}: the MCP schema must be the console's own, verbatim`);
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} must carry readOnlyHint`);
    assert.equal(tool.annotations.destructiveHint, false);
    // A description that mentions a card, a side panel or proposing describes
    // console furniture the host does not have, and would mislead its model.
    for (const word of [/side panel/i, /\bcards?\b/i, /propos/i]) {
      assert.doesNotMatch(tool.description, word, `${tool.name}: the MCP description describes the console, not this surface`);
    }
  }
});

test('every catalog entry is complete, and its tool tells the model it wrote nothing', () => {
  assert.ok(ACTIONS.length >= 3, 'the catalog has emptied');
  const ids = new Set();
  for (const a of ACTIONS) {
    assert.match(a.id, /^[a-z_]+\.[a-z_]+$/, `${a.id}: action ids are kind.verb`);
    assert.ok(!ids.has(a.id), `${a.id} appears twice`); ids.add(a.id);
    assert.ok(TIERS[a.tier], `${a.id}: tier ${a.tier} is not defined in TIERS`);
    assert.match(a.endpoint, /^POST \/api\/[a-z-]+\/[a-z-]+$/, `${a.id}: endpoint must be "POST /api/<kind>/<verb>", got ${a.endpoint}`);
    assert.match(a.instance?.method || '', /^(POST|PATCH|POST\/PATCH)$/, `${a.id}: instance.method is the verb it sends the instance`);
    assert.match(a.instance?.path || '', /^\/api\//, `${a.id}: instance.path is what the instance sees`);
    assert.ok(typeof a.card === 'string' && a.card, `${a.id}: card kind is missing`);
    assert.match(a.cite, /^[a-z-]+\/.+\.md$/, `${a.id}: cite is a docs-cache topic path`);
    assert.match(a.tool.name, /^sn_propose_/, `${a.id}: the tool is named as a proposal`);
    assert.match(a.tool.description, /DOES NOT WRITE ANYTHING/, `${a.tool.name} must state plainly that it writes nothing`);
    assert.match(a.tool.description, /human can click|human commits|only the human/i, `${a.tool.name} must say a human commits it`);
    assert.equal(a.tool.input_schema?.type, 'object', `${a.tool.name}: input_schema is an object schema`);
  }
  assert.deepEqual(proposalTools().map((t) => t.name), ACTIONS.map((a) => a.tool.name));
});

test('the mutating endpoints are exactly the console-local ones plus the catalog', () => {
  const index = read('index.js');
  const mounted = [...index.matchAll(/app\.(post|patch|put|delete)\('([^']+)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`)
    .sort();
  const expected = [...CONSOLE_LOCAL_ENDPOINTS, ...endpoints()].sort();
  assert.deepEqual(mounted, expected, 'the endpoint list changed — an instance write is an entry in server/actions.js; update docs/kit/04-rest-api-access-policy.md in the same commit (ADR 0008 D12)');
});

test('every instance write is audited as human-approved', () => {
  // The commits moved to commits.js (ADR 0011 D3): one implementation, two
  // callers, and the audit entry lives beside the write.
  const index = read('commits.js');
  const approvals = index.match(/approved_by_user: true/g) || [];
  assert.ok(
    approvals.length >= ACTIONS.length,
    `expected an approved_by_user audit entry per catalog action (${ACTIONS.length}), found ${approvals.length}`,
  );
});

test('the configuration allow-list is enforced in the client, not only the schema', () => {
  const sn = read('sn.js');
  assert.match(sn, /if \(!ARTIFACT_TABLES\[table\]\)/, 'sn.js createArtifact refuses tables off the allow-list');
  const commits = read('commits.js');
  assert.match(commits, /if \(!ARTIFACT_TABLES\[table\]\)/, 'the artifact commit refuses tables off the allow-list before calling the instance');
  assert.deepEqual(
    ACTIONS.find((a) => a.id === 'config.create').tool.input_schema.properties.table.enum,
    Object.keys(CONFIG_TABLES),
    'the tool schema enum and the server allow-list are the same list',
  );
  for (const t of writableTables()) assert.match(t, /^[a-z0-9_]+$/, `${t} is not a table name`);
});

// The tier toggle (ADR 0010 D2): a disabled action is absent from the tool
// list, so the model cannot propose what nobody can commit — and the
// endpoint refuses it anyway.
test('KADDIYA_ACTIONS removes disabled tiers from the tool list and the endpoints refuse them', async () => {
  const { enabledTiers, enabledActions } = await import('../server/actions.js');
  assert.deepEqual([...enabledTiers('')].sort(), [1, 2], 'unset = tiers 1 and 2 (self-hosted default)');
  assert.deepEqual([...enabledTiers('1')], [1], 'an enterprise org enables tier 1 only');
  assert.deepEqual([...enabledTiers('tier1,tier2')], [1, 2]);
  assert.deepEqual([...enabledTiers('all')].sort(), [1, 2, 3], '"all" is the only way to reach tier 3');
  assert.deepEqual([...enabledTiers('nonsense')], [1], 'garbage falls closed to tier 1');
  assert.ok(enabledActions('1').every((a) => a.tier === 1));

  // Through the real tool list, in a child process so the env is set before agent.js loads.
  const { execFileSync } = await import('node:child_process');
  const names = JSON.parse(execFileSync(process.execPath, ['-e',
    "import('./server/agent.js').then(m => console.log(JSON.stringify(m.toolDefinitions().map(t => t.name))))",
  ], { cwd: path.join(SERVER, '..'), env: { ...process.env, KADDIYA_ACTIONS: '1' } }).toString());
  for (const a of ACTIONS) {
    assert.equal(names.includes(a.tool.name), a.tier === 1, `${a.tool.name} (tier ${a.tier}) ${a.tier === 1 ? 'missing from' : 'present in'} the tier-1 tool list`);
  }

  // Every catalog endpoint is mounted through commitRoute(actionId), and the
  // factory checks the org's toggles before it touches the instance.
  const index = read('index.js');
  assert.match(index, /function commitRoute\(actionId\) \{[\s\S]*?requireAction\(session, actionId, res\)/, 'commitRoute checks requireAction');
  for (const a of ACTIONS) {
    const [method, route] = a.endpoint.split(' ');
    assert.ok(index.includes(`app.${method.toLowerCase()}('${route}', commitRoute('${a.id}'))`), `${a.endpoint} is not mounted through commitRoute('${a.id}')`);
  }
});
