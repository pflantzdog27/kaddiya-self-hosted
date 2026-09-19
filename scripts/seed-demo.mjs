// Seed a throwaway demo workspace: an org, an instance, members at every
// status, model connections, conversations that replay, notebook entries,
// MCP tokens and audit history — plus a signed-in session, so the console
// can be walked through without a ServiceNow instance or a model key.
//
// Nothing here talks to ServiceNow. Every screen in the console reads the
// workspace database (getSession and meFor make no instance call), so a
// seeded session renders the product as it looks in use. What it cannot do
// is run a turn: live streaming needs a real model and a real instance.
//
// SAFETY: this refuses to run against the default data directory. A demo
// workspace is a separate KADDIYA_DATA_DIR, on a separate port, and it is
// disposable. Your real workspace is never opened by this script.
//
//   node scripts/seed-demo.mjs --dir /tmp/kaddiya-demo
//
// It prints the session cookie and the command to start the console on it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSOLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'console');
const DEFAULT_DATA = path.resolve(CONSOLE_DIR, 'data', 'workspace');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dataDir = path.resolve(flag('dir', path.join(process.env.TMPDIR || '/tmp', 'kaddiya-demo')));
if (dataDir === DEFAULT_DATA) {
  console.error('Refusing to seed the default workspace at apps/console/data/workspace.');
  console.error('Pass --dir with a throwaway directory; your real workspace stays untouched.');
  process.exit(1);
}
const port = Number(flag('port', 3010));
const baseUrl = `http://localhost:${port}`;

// A fixed key so the demo workspace can be reopened and reseeded. It protects
// invented data in a disposable directory, and nothing else.
const MASTER_KEY = 'de306ade306ade306ade306ade306ade306ade306ade306ade306ade306ade30';

process.env.KADDIYA_STORAGE = 'local';
process.env.KADDIYA_DATA_DIR = dataDir;
process.env.KADDIYA_MASTER_KEY = MASTER_KEY;
process.env.KADDIYA_EDITION = 'self-hosted';
process.env.BASE_URL = baseUrl;
process.env.PORT = String(port);
delete process.env.DATABASE_URL;

if (args.includes('--fresh')) fs.rmSync(dataDir, { recursive: true, force: true });

const { migrate, system, withOrg, close } = await import(`${CONSOLE_DIR}/server/db.js`);
const tenancy = await import(`${CONSOLE_DIR}/server/tenancy.js`);
const sessions = await import(`${CONSOLE_DIR}/server/sessions.js`);
const store = await import(`${CONSOLE_DIR}/server/store.js`);
const { audit } = await import(`${CONSOLE_DIR}/server/audit.js`);
const outputs = await import(`${CONSOLE_DIR}/server/outputs.js`);

await migrate();

// ---- the workspace ----

const INSTANCE_HOST = 'dev89412.service-now.com';
const ORG_NAME = 'Northwind Consulting';

// Start clean so reseeding is idempotent.
await system((c) => c.query(
  `TRUNCATE output_revisions, outputs, conversation_turns,
            usage_events, audit_events, notebook_entries, conversations, members,
            oauth_states, sessions, mcp_tokens, instance_aliases, instances, orgs CASCADE`,
));

const { org: seededOrg, instance } = await tenancy.seedSelfHosted({
  instanceUrl: `https://${INSTANCE_HOST}`,
  clientId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  clientSecret: 'demo-secret-not-a-real-credential',
  name: ORG_NAME,
});

await system((c) => c.query(
  `UPDATE orgs SET
     branding = $2,
     mcp_enabled = true,
     autonomous_mode = true,
     runs_plan_mode = true,
     actions_tiers = '1,2',
     join_policy = 'approve'
   WHERE id = $1`,
  [seededOrg.id, JSON.stringify({
    accent: '#3b6fd4',
    welcome: 'Northwind ServiceNow workspace — sub-production instances only.',
  })],
));
await system((c) => c.query(`UPDATE instances SET label = 'dev89412', non_production = true WHERE id = $1`, [instance.id]));

const org = await tenancy.getOrg(seededOrg.id);
const ctx = tenancy.contextFor(org);
const scopeFor = (userSysId) => ({ ctx, instanceId: instance.id, userSysId });

// ---- members, at every status an admin has to deal with ----

const PEOPLE = [
  { key: 'avery', name: 'Avery Kline', user_name: 'avery.kline', role: 'owner', status: 'active', days: 41 },
  { key: 'jordan', name: 'Jordan Reyes', user_name: 'jordan.reyes', role: 'admin', status: 'active', days: 38 },
  { key: 'sam', name: 'Sam Okafor', user_name: 'sam.okafor', role: 'member', status: 'active', days: 26 },
  { key: 'devi', name: 'Devi Raman', user_name: 'devi.raman', role: 'member', status: 'active', days: 12 },
  { key: 'priya', name: 'Priya Nandakumar', user_name: 'priya.n', role: 'member', status: 'pending', days: 0,
    reason: 'Waiting for an org admin to approve your membership.' },
  { key: 'chris', name: 'Chris Doyle', user_name: 'chris.doyle', role: 'member', status: 'blocked', days: 55 },
];

const members = {};
for (const person of PEOPLE) {
  const sysId = crypto.createHash('sha256').update(person.user_name).digest('hex').slice(0, 32);
  const { rows } = await withOrg(org.id, (c) => c.query(
    `INSERT INTO members (org_id, instance_id, sn_user_sys_id, user_name, name, role, status, pending_reason,
                          approved_by, approved_at, created_at, last_seen_at)
     VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9,
             now() - ($10::int || ' days')::interval, now() - ($11::int || ' minutes')::interval)
     RETURNING *`,
    [instance.id, sysId, person.user_name, person.name, person.role, person.status, person.reason || null,
      person.status === 'active' ? 'avery.kline' : null,
      person.status === 'active' ? new Date(Date.now() - person.days * 864e5) : null,
      person.days || 0, person.status === 'pending' ? 22 : 90 + person.days],
  ));
  members[person.key] = { ...rows[0], sysId, ...person };
}

// ---- model connections: several providers, one default ----

const CONNECTIONS = [
  { provider: 'anthropic', label: 'Claude Opus 5', model_id: 'claude-opus-5', effort: 'high' },
  { provider: 'anthropic', label: 'Claude Haiku 4.5 (triage)', model_id: 'claude-haiku-4-5-20251001', effort: '' },
  { provider: 'gateway', label: 'Northwind gateway', model_id: 'claude-sonnet-5', base_url: 'https://llm-gateway.northwind.example.com', effort: 'medium' },
];
for (const connection of CONNECTIONS) {
  await tenancy.saveModelConnection(ctx, connection, `sk-demo-${crypto.randomBytes(12).toString('hex')}`);
}

// ---- conversations that replay ----
//
// openConversation() rebuilds tool cards from stored tool_use / tool_result
// pairs, so these render as the real transcript did. Approval cards are live
// SSE only and are shown separately in the card gallery.

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, value) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(value) }] });

async function seedConversation(person, { title, pinned = false, messages, run = null, ago = 3 }) {
  const scope = scopeFor(person.sysId);
  const conv = await store.createConversation(scope);
  await store.saveConversation(scope, { ...conv, title, messages, run });
  await withOrg(org.id, (c) => c.query(
    `UPDATE conversations SET title = $2, pinned = $3, created_at = now() - ($4::int || ' hours')::interval,
                              updated_at = now() - ($4::int || ' hours')::interval WHERE id = $1`,
    [conv.id, title, pinned, ago],
  ));
  return conv.id;
}

const avery = members.avery;

await seedConversation(avery, {
  title: 'Show my open incidents',
  ago: 30,
  messages: [
    { role: 'user', content: 'Show my open incidents. Read only; do not change anything.' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Reading your queue on dev89412.' },
      toolUse('tu_01', 'sn_my_work', { limit: 10 }),
    ] },
    toolResult('tu_01', { records: [
      { number: 'INC0012934', short_description: 'Okta SSO loop on VPN re-auth', state: 'In Progress', priority: '2 - High', assigned_to: 'Avery Kline' },
      { number: 'INC0012901', short_description: 'Shared mailbox quota exceeded — Finance', state: 'On Hold', priority: '3 - Moderate', assigned_to: 'Avery Kline' },
      { number: 'INC0012887', short_description: 'Laptop dock not detecting second monitor', state: 'In Progress', priority: '4 - Low', assigned_to: 'Avery Kline' },
      { number: 'INC0012840', short_description: 'Payroll export job failed Saturday night', state: 'In Progress', priority: '1 - Critical', assigned_to: 'Avery Kline' },
    ] }),
    { role: 'assistant', content: [{ type: 'text', text: `You have **4 open incidents**, one of them critical.

| Number | Priority | State | Summary |
| --- | --- | --- | --- |
| INC0012840 | 1 - Critical | In Progress | Payroll export job failed Saturday night |
| INC0012934 | 2 - High | In Progress | Okta SSO loop on VPN re-auth |
| INC0012901 | 3 - Moderate | On Hold | Shared mailbox quota exceeded — Finance |
| INC0012887 | 4 - Low | In Progress | Laptop dock not detecting second monitor |

INC0012840 is the one to take first: a failed payroll export has a hard weekly deadline, and it has been open since Saturday.` }] },
  ],
});

await seedConversation(avery, {
  title: 'Why did INC0012840 breach its SLA?',
  ago: 26,
  pinned: true,
  messages: [
    { role: 'user', content: 'Why did INC0012840 breach its SLA? Show me the evidence.' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Reading the record, then its task SLA rows.' },
      toolUse('tu_10', 'sn_record', { table: 'incident', number: 'INC0012840' }),
    ] },
    toolResult('tu_10', { record: {
      number: 'INC0012840', state: 'In Progress', priority: '1 - Critical',
      short_description: 'Payroll export job failed Saturday night',
      assignment_group: 'Payroll Applications', opened_at: '2026-09-12 23:14:02',
    } }),
    { role: 'assistant', content: [toolUse('tu_11', 'sn_query', {
      table: 'task_sla', query: 'task.number=INC0012840^ORDERBYstart_time', limit: 10,
    })] },
    toolResult('tu_11', { records: [
      { sla: 'Priority 1 resolution (8h)', stage: 'Breached', business_percentage: '164', start_time: '2026-09-12 23:14:02', end_time: '' },
      { sla: 'Priority 1 response (15m)', stage: 'Completed', business_percentage: '41', start_time: '2026-09-12 23:14:02', end_time: '2026-09-12 23:20:19' },
    ] }),
    { role: 'assistant', content: [toolUse('tu_12', 'sn_similar', {
      table: 'incident', text: 'payroll export job failed', exclude_sys_id: 'bc9a1f', limit: 5,
    })] },
    toolResult('tu_12', { strategy: 'short_description + close_notes', records: [
      { number: 'INC0011203', short_description: 'Payroll export failed — SFTP key rotation', close_code: 'Solved (Permanently)' },
      { number: 'INC0010488', short_description: 'Payroll export job hung on lock', close_code: 'Solved (Work Around)' },
    ] }),
    { role: 'assistant', content: [{ type: 'text', text: `**The response SLA was met; the resolution SLA breached at 164%.**

- **Response (15m)** — completed in 6 minutes, at 23:20:19 on 12 Sep.
- **Resolution (8h)** — started 12 Sep 23:14, still running, now at **164% of the allowance**.

The gap is ownership, not detection. The incident sat with *Payroll Applications*, a group whose on-call rota does not cover Saturday night; the first work note after the auto-assignment is Monday 08:41.

Two prior incidents match this failure mode — INC0011203 (SFTP key rotation) and INC0010488 (job hung on a lock). Both were resolved by the same group inside four hours during a weekday.

Worth checking whether the P1 assignment rule should route out-of-hours payroll failures to the platform on-call group instead.` }] },
  ],
});

await seedConversation(avery, {
  title: 'Package the autoclose update set',
  ago: 2,
  messages: [
    { role: 'user', content: 'The autoclose rule is done and tested. Package the update set so I can send it to the client.' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Checking what the set holds first.' },
      toolUse('tu_20', 'sn_update_set_contents', {}),
    ] },
    toolResult('tu_20', { update_set: '9b1c4e77d3ba2210', entries: [
      { type: 'Business Rule', target_name: 'Autoclose resolved incidents', action: 'INSERT_OR_UPDATE' },
      { type: 'Script Include', target_name: 'IncidentAutocloseUtil', action: 'INSERT_OR_UPDATE' },
      { type: 'System Property', target_name: 'northwind.autoclose.days', action: 'INSERT_OR_UPDATE' },
    ] }),
    { role: 'assistant', content: [toolUse('tu_21', 'sn_package_update_set', {})] },
    toolResult('tu_21', {
      update_set: 'NW: incident autoclose', sys_id: '9b1c4e77d3ba22105f4c8e1a7b6d0c33',
      state: 'Complete', application: 'Global', changes: 3, bytes: 11842,
      sha256: '7c1f0b9a4e2d6835ab90f4c7e15d2803b6a9f14c72e0d58396b1c4a7d2e60f85',
      by_type: [{ type: 'Business Rule', count: 1 }, { type: 'Script Include', count: 1 }, { type: 'System Property', count: 1 }],
      warnings: [],
    }),
    { role: 'assistant', content: [{ type: 'text', text: `**Packaged — 3 changes, 12 KB.**

| Type | Target |
| --- | --- |
| Business Rule | Autoclose resolved incidents |
| Script Include | IncidentAutocloseUtil |
| System Property | northwind.autoclose.days |

The set is Complete, everything is in the Global scope, and there are no warnings.

Both files are on the card above: the XML loads through **Retrieved Update Sets → Import Update Set from XML**, and the ledger is the hand-over document. Preview it on the target before committing — that diff is ServiceNow's, not mine.` }] },
  ],
});

// A run: the stage rail renders from this object.
await seedConversation(avery, {
  title: 'Run: autoclose resolved incidents after 5 days',
  ago: 5,
  run: {
    id: 'run_demo01', goal: 'Autoclose resolved incidents after 5 days with no customer update',
    template: 'build', policy: 'each', stage: 'done', status: 'done', revisions: 1,
    findings: null, created_at: new Date(Date.now() - 5 * 36e5).toISOString(),
    history: [
      { stage: 'spec', at: new Date(Date.now() - 5 * 36e5).toISOString() },
      { stage: 'review', at: new Date(Date.now() - 4.6 * 36e5).toISOString() },
      { stage: 'spec', at: new Date(Date.now() - 4.3 * 36e5).toISOString() },
      { stage: 'approve', at: new Date(Date.now() - 4 * 36e5).toISOString() },
      { stage: 'build', at: new Date(Date.now() - 3.4 * 36e5).toISOString() },
      { stage: 'test', at: new Date(Date.now() - 3 * 36e5).toISOString() },
      { stage: 'verify', at: new Date(Date.now() - 2.6 * 36e5).toISOString() },
    ],
  },
  messages: [
    { role: 'user', content: 'RUN · SPEC STAGE. The goal of this run: Autoclose resolved incidents after 5 days with no customer update' },
    { role: 'assistant', content: [
      toolUse('tu_30', 'sn_schema', { table: 'incident' }),
    ] },
    toolResult('tu_30', { fields: [
      { element: 'state', column_label: 'State', internal_type: 'integer' },
      { element: 'resolved_at', column_label: 'Resolved', internal_type: 'glide_date_time' },
      { element: 'close_code', column_label: 'Resolution code', internal_type: 'string' },
    ] }),
    { role: 'assistant', content: [{ type: 'text', text: `## Goal
Close incidents that have been Resolved for five days with no further customer comment.

## What I checked
| Table | What I found | Why it matters |
| --- | --- | --- |
| \`incident\` | \`state\` 6 = Resolved, 7 = Closed; \`resolved_at\` is set by the resolve UI action | The rule keys off state 6 and \`resolved_at\` |
| \`sys_script\` | No existing autoclose rule on incident | Nothing to conflict with |
| \`sysauto_script\` | \`Autoclose Incidents\` scheduled job exists but is **inactive** | Reuse the pattern, not the record |

## Artifacts
| Table | Name | Purpose | New or update |
| --- | --- | --- | --- |
| \`sys_script_include\` | \`IncidentAutocloseUtil\` | The query and close logic | New |
| \`sys_script\` | \`Autoclose resolved incidents\` | Scheduled entry point | New |

## Risks
Runs nightly over resolved incidents only. A wrong window closes records early; the property makes the window configurable, and back-out is deactivating the rule.` }] },
    { role: 'user', content: 'RUN · REVIEW STAGE. You are now the reviewer.' },
    { role: 'assistant', content: [{ type: 'text', text: `VERDICT: REVISE

## Findings
1. The spec closes on \`resolved_at\` alone. An incident re-opened and re-resolved keeps the later \`resolved_at\`, but a *customer comment* after resolution does not move it — so a commented record still closes. Check \`sys_journal_field\` for comments after \`resolved_at\`.
2. \`close_code\` is mandatory on close in this instance's UI policy. The spec does not set one.` }] },
    { role: 'user', content: 'RUN · SPEC STAGE (revision). The reviewer asked for changes:' },
    { role: 'assistant', content: [{ type: 'text', text: 'Revised: the query now excludes incidents with a journal entry after `resolved_at`, and sets `close_code = "Closed by autoclose"` with a close note naming the rule.' }] },
    { role: 'user', content: 'RUN · BUILD STAGE. The plan is approved.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Proposed both artifacts and the update set. Three cards on screen, awaiting your approval.' }] },
    { role: 'user', content: 'RUN · TEST STAGE.' },
    { role: 'assistant', content: [toolUse('tu_31', 'sn_update_set_contents', {})] },
    toolResult('tu_31', { update_set: '9b1c4e77d3ba2210', entries: [
      { type: 'Business Rule', target_name: 'Autoclose resolved incidents', action: 'INSERT_OR_UPDATE' },
      { type: 'Script Include', target_name: 'IncidentAutocloseUtil', action: 'INSERT_OR_UPDATE' },
      { type: 'System Property', target_name: 'northwind.autoclose.days', action: 'INSERT_OR_UPDATE' },
    ] }),
    { role: 'assistant', content: [{ type: 'text', text: `| Check | Expected | Observed | Result |
| --- | --- | --- | --- |
| Script Include exists | \`IncidentAutocloseUtil\` on \`sys_script_include\` | Found, active | PASS |
| Business Rule captured | In "NW: incident autoclose" | Captured | PASS |
| Property default | \`5\` | \`5\` | PASS |
| Commented record excluded | Not selected | Not selected | PASS |` }] },
    { role: 'user', content: 'RUN · VERIFY + NOTES STAGE.' },
    { role: 'assistant', content: [{ type: 'text', text: `## What changed
Two configuration records and one property, all captured in **NW: incident autoclose**.

## Test results
Four checks, four passes.

## How to back out
Deactivate the business rule; the script include is inert without it.

The package is ready to hand over — 3 changes, 12 KB, on the card above.` }] },
  ],
});

await seedConversation(members.sam, {
  title: 'Which groups can see the HR case table?',
  ago: 9,
  messages: [
    { role: 'user', content: 'Which groups can actually read sn_hr_core_case on this instance?' },
    { role: 'assistant', content: [toolUse('tu_40', 'sn_query', { table: 'sys_security_acl', query: 'name=sn_hr_core_case^operation=read', limit: 20 })] },
    toolResult('tu_40', { records: [
      { name: 'sn_hr_core_case', operation: 'read', admin_overrides: 'true', active: 'true' },
      { name: 'sn_hr_core_case.*', operation: 'read', admin_overrides: 'true', active: 'true' },
    ] }),
    { role: 'assistant', content: [{ type: 'text', text: 'Two active read ACLs, both admin-overridden, both requiring `sn_hr_core.basic`. Four groups hold that role — HR Operations, HR Business Partners, HR Service Desk, and Platform Admins.' }] },
  ],
});

// ---- the work pane: real files, not a mock-up ----
//
// The outputs are written through the real service, and the tool results
// below carry the references it returned — so the file cards rebuild on
// replay exactly as they did when the turn ran, the Files list is populated,
// and both versions really download. Seeding a card without the row behind it
// would demo a screenshot.

const PROCESS_V1 = `# Incident escalation process

## Purpose

Make it obvious, at 02:00, who to wake and when. This applies to every P1 and P2 on the
payroll and HR platforms.

## Roles

| Role | Owns | Reachable via |
| --- | --- | --- |
| Service desk | First response, triage, comms | Queue \`SD-FRONT\` |
| Incident manager | Severity, bridge, stakeholder updates | On-call rota |
| Platform on-call | Technical mitigation | Rota \`plat-primary\` |

## Steps

1. Confirm impact and set severity within **10 minutes**.
2. For P1, open the bridge and page the platform on-call.
3. Update the ticket every 30 minutes until mitigated.
4. Hand over at shift change with a written summary in the work notes.

> A severity is a decision, not a guess. If impact is unclear, escalate and correct later.
`;

const PROCESS_V2 = `${PROCESS_V1}
## After-hours exception

Between 18:00 and 07:00 the service desk pages the platform on-call **directly** and notifies
the incident manager afterwards. Waiting for an incident manager out of hours cost us
mitigation time on INC0012840; this exception exists because of that incident.
`;

const CHECKLIST = `check,owner,notes,done
"Rota populated, next 14 days",Incident manager,"Covers ""plat-primary"" and backup",yes
"Bridge number published",Service desk,"In the runbook, section 2",yes
"After-hours page tested",Platform on-call,"Test page, not a live incident",no
"Stakeholder list current",Incident manager,"Includes the payroll provider contact",no
`;

{
  const scope = scopeFor(avery.sysId);
  const conv = await store.createConversation(scope);

  const created = await outputs.createOutput(scope, {
    conversationId: conv.id, title: 'Incident escalation process',
    filename: 'incident escalation process', format: 'markdown', content: PROCESS_V1,
    operationId: `demo-${conv.id}:create`, provenance: { origin: 'assistant' },
  });
  const outputId = created.reference.output_id;
  const revised = await outputs.updateOutput(scope, {
    conversationId: conv.id, outputId, expectedRevision: 1, content: PROCESS_V2,
    changeSummary: 'Added the after-hours exception',
    operationId: `demo-${conv.id}:update`, provenance: { origin: 'assistant' },
  });
  const checklist = await outputs.createOutput(scope, {
    conversationId: conv.id, title: 'Escalation readiness checklist',
    filename: 'escalation readiness checklist', format: 'csv', content: CHECKLIST,
    operationId: `demo-${conv.id}:checklist`, provenance: { origin: 'assistant' },
  });

  await store.saveConversation(scope, {
    ...conv,
    title: 'Document the incident escalation process',
    messages: [
      { role: 'user', content: 'Document our incident escalation process — roles, the steps, and how after-hours works.' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Writing that up as a document you can keep.' },
        toolUse('tu_50', 'workspace_create_output', {
          title: 'Incident escalation process', filename: 'incident escalation process',
          format: 'markdown', content: PROCESS_V1,
        }),
      ] },
      toolResult('tu_50', created.reference),
      { role: 'assistant', content: [{ type: 'text', text: 'Saved **Incident escalation process**. It covers the purpose, the three roles, and the escalation steps. Ask for a revision and I will update the same file.' }] },

      { role: 'user', content: 'Add the after-hours exception we agreed after INC0012840.' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Reading the current version before I replace it.' },
        toolUse('tu_51', 'workspace_read_output', { output_id: outputId }),
      ] },
      toolResult('tu_51', { output_id: outputId, revision: 1, title: 'Incident escalation process', total_chars: PROCESS_V1.length, truncated: false }),
      { role: 'assistant', content: [
        { type: 'text', text: 'Adding the exception, and saying why it exists.' },
        toolUse('tu_52', 'workspace_update_output', {
          output_id: outputId, expected_revision: 1, content: PROCESS_V2,
          change_summary: 'Added the after-hours exception',
        }),
      ] },
      toolResult('tu_52', revised.reference),
      { role: 'assistant', content: [{ type: 'text', text: 'Updated to **v2**. Version 1 is still there in the version selector, and either one downloads as itself.' }] },

      { role: 'user', content: 'Give me a readiness checklist as a CSV too.' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Four checks, with an owner on each.' },
        toolUse('tu_53', 'workspace_create_output', {
          title: 'Escalation readiness checklist', filename: 'escalation readiness checklist',
          format: 'csv', content: CHECKLIST,
        }),
      ] },
      toolResult('tu_53', checklist.reference),
      { role: 'assistant', content: [{ type: 'text', text: 'Saved as a table — open it beside the document and the two tabs switch without losing either.' }] },
    ],
  });
  await withOrg(org.id, (c) => c.query(
    `UPDATE conversations SET title = $2, pinned = true, created_at = now() - interval '2 hours',
                              updated_at = now() - interval '2 hours' WHERE id = $1`,
    [conv.id, 'Document the incident escalation process'],
  ));
}

// ---- the instance notebook ----

const NOTES = [
  { text: 'Incident state 6 is "Resolved" here, not "Closed" — closure is state 7 and requires close_code.', context: 'incident', status: 'kept' },
  { text: 'The Payroll Applications group has no weekend on-call rota; P1s raised out of hours sit until Monday.', context: 'assignment', status: 'kept' },
  { text: 'sys_user.u_cost_centre is populated from Workday nightly and is read-only in the UI.', context: 'sys_user', status: 'pending' },
];
for (const note of NOTES) {
  await withOrg(org.id, (c) => c.query(
    `INSERT INTO notebook_entries (org_id, instance_id, text_enc, text_hash, context, status, saved_by, kept_by, kept_at, conversation_id)
     VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, 'avery.kline', $6, $7, NULL)`,
    [instance.id, ctx.encrypt('notebook_entries.text', note.text),
      crypto.createHash('sha256').update(note.text.toLowerCase()).digest(),
      note.context, note.status,
      note.status === 'kept' ? 'avery.kline' : null,
      note.status === 'kept' ? new Date(Date.now() - 6 * 864e5) : null],
  ));
}

// ---- MCP tokens: one live, one clamped, one revoked ----

const TOKENS = [
  { person: avery, label: 'Claude Code — laptop', ttlDays: 30, clampedBy: null, revoked: false, usedMinutesAgo: 14 },
  { person: avery, label: 'Claude Desktop', ttlDays: 7, clampedBy: 'the instance refresh token lifespan', revoked: false, usedMinutesAgo: 1400 },
  { person: members.jordan, label: 'Claude Code — review box', ttlDays: 1, clampedBy: null, revoked: true, usedMinutesAgo: 4300 },
];
for (const token of TOKENS) {
  const { id } = await sessions.createMcpToken({
    orgId: org.id, instanceId: instance.id, memberId: token.person.id,
    userSysId: token.person.sysId,
    user: { sys_id: token.person.sysId, user_name: token.person.user_name, name: token.person.name },
    label: token.label,
    tokens: { accessToken: 'demo-access', refreshToken: 'demo-refresh', expiresAt: Date.now() + 36e5 },
    ttlMs: token.ttlDays * 864e5,
    clampedBy: token.clampedBy,
  });
  // Revocation is `revoke_on_present`: the row stays, and the next call the
  // bearer makes is the one that dies. That is what an admin sees.
  await system((c) => c.query(
    `UPDATE mcp_tokens SET last_used_at = now() - ($2::int || ' minutes')::interval,
                           created_at = now() - ($3::int || ' days')::interval,
                           revoke_on_present = $4
      WHERE id = $1`,
    [id, token.usedMinutesAgo, Math.max(1, Math.round(token.usedMinutesAgo / 1440) + 1), token.revoked],
  ));
}

// ---- audit history ----

const AUDIT = [
  { user: 'avery.kline', action: 'artifact_create', table: 'sys_script_include', sys_id: 'c2f19a0b7e4d2210', approved_by_user: true, update_set: 'NW: incident autoclose' },
  { user: 'avery.kline', action: 'artifact_create', table: 'sys_script', sys_id: 'd41ab7c39e0f2210', approved_by_user: true, update_set: 'NW: incident autoclose' },
  { user: 'avery.kline', action: 'update_set_create', sys_id: '9b1c4e77d3ba2210', approved_by_user: true, name: 'NW: incident autoclose' },
  { user: 'avery.kline', action: 'update_set_package', sys_id: '9b1c4e77d3ba22105f4c8e1a7b6d0c33', changes: 3, bytes: 11842, format: 'xml' },
  { user: 'sam.okafor', action: 'write', table: 'incident', sys_id: 'bc9a1f2e77d30110', approved_by_user: true, field: 'work_notes', chars: 214 },
  { user: 'sam.okafor', action: 'task_update', table: 'incident', sys_id: 'bc9a1f2e77d30110', approved_by_user: true, fields: ['state', 'assignment_group'] },
  { user: 'jordan.reyes', action: 'mcp_tool_call', tool: 'sn_query', token_label: 'Claude Code — review box', client: 'claude-code' },
  { user: 'jordan.reyes', action: 'mcp_tool_call', tool: 'sn_schema', token_label: 'Claude Code — review box', client: 'claude-code' },
  { user: 'avery.kline', action: 'mcp_token_mint', approved_by_user: true, token_label: 'Claude Code — laptop' },
  { user: 'avery.kline', action: 'member_approve', approved_by_user: true, member: 'devi.raman' },
  { user: 'devi.raman', action: 'catalog_order', table: 'sc_request', sys_id: 'ee31c0a97b4d2210', approved_by_user: true, item: 'Standard laptop' },
  { user: 'avery.kline', action: 'member_block', approved_by_user: true, member: 'chris.doyle', reason: 'left the engagement' },
];
for (const entry of AUDIT) {
  await audit({ ctx, instanceId: instance.id }, entry);
}
// Spread them over the last few days so the list looks lived-in. This goes
// through the owner role on purpose: audit_events has UPDATE revoked from the
// application role, which is the point of the table — the console cannot
// rewrite its own history, and neither can a seeded demo pretending to be it.
await system((c) => c.query(
  `UPDATE audit_events SET ts = now() - (id % 9 || ' hours')::interval - (id * 7 || ' minutes')::interval`,
));

// ---- a signed-in session for the demo user ----

async function sessionFor(person) {
  return sessions.createSession({
    orgId: org.id,
    instanceId: instance.id,
    memberId: person.id,
    userSysId: person.sysId,
    user: {
      sys_id: person.sysId, user_name: person.user_name, name: person.name,
      email: `${person.user_name}@northwind.example.com`,
    },
    tokens: { accessToken: 'demo-access-token', refreshToken: 'demo-refresh-token', expiresAt: Date.now() + 8 * 36e5 },
    ttlMs: 8 * 36e5,
  });
}

const sid = await sessionFor(avery);
// A second session on the member who is still waiting, so the approval screen
// can be shown as that person actually sees it.
const pendingSid = await sessionFor(members.priya);

await close();

const env = [
  `KADDIYA_STORAGE=local`,
  `KADDIYA_DATA_DIR=${dataDir}`,
  `KADDIYA_MASTER_KEY=${MASTER_KEY}`,
  `KADDIYA_EDITION=self-hosted`,
  `BASE_URL=${baseUrl}`,
  `PORT=${port}`,
].join(' ');

// Machine-readable, for the capture script.
fs.writeFileSync(path.join(dataDir, 'demo.json'), JSON.stringify({
  baseUrl, port, dataDir, masterKey: MASTER_KEY, sid, pendingSid,
  org: ORG_NAME, instanceHost: INSTANCE_HOST,
}, null, 2));

console.log(`
Demo workspace seeded.

  directory   ${dataDir}
  org         ${ORG_NAME} (self-hosted, MCP on, autonomous on, plan mode on)
  instance    ${INSTANCE_HOST} (verified, non-production)
  members     ${PEOPLE.length} — ${PEOPLE.map((p) => `${p.user_name}:${p.status}`).join(', ')}
  models      ${CONNECTIONS.length} connections
  files       3 outputs in "Document the incident escalation process" (one at v2)
  signed in   ${avery.name} (owner)

  cookie      sid=${sid}                 (Avery Kline, owner)
  pending     sid=${pendingSid}   (Priya Nandakumar, awaiting approval)

Start the console on it:

  ${env} npm --prefix apps/console start
`);
