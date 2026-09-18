# Kaddiya console

The Kaddiya console is a standalone web application for working with ServiceNow through an
AI agent. It runs outside ServiceNow and connects through OAuth and the platform's REST APIs.

Each person signs in on their own ServiceNow instance. Kaddiya uses that person's token for
instance calls, so ServiceNow's existing ACLs, roles, groups, and user criteria remain the
authority for what they can see and change.

See the repository's [main README](../../README.md) for the localhost setup and enterprise
deployment overview, and [docs/architecture.md](../../docs/architecture.md) for how the whole
thing fits together — the trust boundary, the write path, tenancy and keys, and the tests that
keep those claims true.

## Request flow

1. The browser starts an OAuth authorization-code flow with PKCE.
2. ServiceNow authenticates the person and returns an authorization code to Kaddiya.
3. Kaddiya keeps the resulting session server-side, encrypted and bound to the browser cookie.
4. The agent reads the instance through the signed-in person's ServiceNow token.
5. Every supported change goes through Kaddiya's fixed action catalog and is audit-recorded.

ServiceNow passwords never pass through Kaddiya.

## Capabilities

The read tools cover:

- Table queries, record details, schemas, and aggregate counts
- Work assigned to the person or their groups
- Similar resolved records and journal history
- Current update sets and captured changes
- An update set packaged as loadable XML plus a ledger of what is in it
- ServiceNow documentation matched to the instance's release family
- A governed instance notebook for team-specific conventions and gotchas

The action catalog covers:

| Action | ServiceNow operation |
|---|---|
| Draft reply | Add `comments` or `work_notes` to a record |
| Task update | Update approved task fields |
| Approval decision | Approve or reject an approval record |
| Catalog order | Order one catalog item |
| Change request | Create a supported change request |
| Configuration create | Create an allow-listed configuration artifact |
| Configuration update | Update an allow-listed configuration artifact |
| Update set | Create and select an update set |

The model cannot call these write endpoints directly. It produces a proposal first. The
server commits only through the selected task policy and only within the enabled action tier.

## The update set package

When the work in a set is done, `sn_package_update_set` turns it into the two files a person
hands over: the **loadable `<unload>` XML** the platform's own **Export to XML** produces, and
a **markdown ledger** naming every change, the source instance, and the package's SHA-256.
The card in the conversation offers both as downloads; `GET /api/update-set/:sysId/package.xml`
and `.md` serve them, to a signed-in browser or to an MCP client presenting its bearer. Over
MCP the tool returns absolute URLs for exactly that:

```bash
curl -H "Authorization: Bearer ${KADDIYA_MCP_TOKEN}" -OJ \
  https://kaddiya.example.com/api/update-set/<sys_id>/package.xml
```

The SHA-256 is in the ledger and in the audit row, where it can be checked against a file that
travelled, rather than on the card beside the button that produced it.

This is a read. Packaging calls `sys_update_set` and `sys_update_xml` on the person's own
token and writes nothing — the changes were captured by ServiceNow when they committed each
card, and this reads them back and formats them. There is no card to click because there is
no write to approve; the review the package still needs happens on the **target** instance,
where Retrieved Update Sets → Preview shows a diff the platform computed itself.

Packages are rebuilt per request rather than stored, so the console keeps no copy of anyone's
configuration, and the remote set's sys_id is derived from the source set, so re-packaging
untouched work produces the same bytes and updates the same retrieved row instead of a second
one. It refuses the Default set, an empty set, and anything over 2000 changes or 24 MB —
refuses rather than trims, because a package missing its last hundred changes previews clean
and deploys something incomplete. A set that is still in progress, part of a batch, or spread
across scopes packages with a warning on the card and in the ledger.

## Connect an MCP client

Kaddiya is also a Model Context Protocol server. An MCP host — Claude Code, Claude Desktop,
your own tooling — can present a per-user bearer token and get **the read tools and nothing
else**, running on that person's own ServiceNow OAuth token and audited like every other
call. No action-catalog entry is reachable: a `tools/call` is a model deciding, and there is
no card for anyone to click, so the write surface is absent from that surface entirely
(ADR 0014 D1; `test/write-paths.test.js` fails the build if that changes).

It is **off by default**. An org admin turns it on under **Admin → Access** and may lower the
token lifetime ceiling there. A member then connects a client from their own profile panel:
the label and lifetime they pick, a second ServiceNow consent screen, and the token is shown
once and never again.

```bash
# Claude Code — HTTP transport with a static header
claude mcp add --transport http kaddiya https://kaddiya.example.com/mcp \
  --header "Authorization: Bearer ${KADDIYA_MCP_TOKEN}"
```

```json
{ "mcpServers": { "kaddiya": {
  "type": "http",
  "url": "https://kaddiya.example.com/mcp",
  "headers": { "Authorization": "Bearer ${KADDIYA_MCP_TOKEN}" } } } }
```

Claude Desktop and Claude.ai custom connectors authenticate remote servers with OAuth only —
there is no field for a bearer — so the console serves a zero-dependency stdio shim at
`/kaddiya-mcp.mjs` that bridges them. Download it from the reveal screen and point the client
at it:

```json
{ "mcpServers": { "kaddiya": {
  "command": "node",
  "args": ["/path/to/kaddiya-mcp.mjs"],
  "env": { "KADDIYA_MCP_URL": "https://kaddiya.example.com/mcp",
           "KADDIYA_MCP_TOKEN": "kmcp_…" } } } }
```

What holds on this surface:

- **Per user, per instance.** A token names one person and one instance, is minted only by
  that person through their own consent, and carries their `sys_id` on every instance call.
  An admin cannot mint one on someone's behalf, and cannot read one back.
- **Custody, as for cookies.** The row stores `SHA-256(bearer)`; the ServiceNow pair is
  sealed under `HKDF(bearer)`. A database dump yields nothing, and the server cannot open the
  pair unless a request is presenting the bearer.
- **Absolute lifetime.** Never sliding. The person picks 1, 7 or 30 days or the workspace
  maximum; the effective expiry is the tightest of that, the org ceiling, a 90-day code
  ceiling, and the instance's own OAuth *refresh token lifespan* — and the reveal screen says
  which one applied. See `docs/kit/02-oauth-registry-runbook.md`.
- **Revocable from both sides.** The person revokes theirs in the profile panel; an admin
  revokes any under **Admin → MCP tokens**. Blocking a member, disconnecting their instance,
  or turning the surface off revokes tokens too. Revocation takes effect on the token's next
  call, which also expires the ServiceNow token at the issuer.
- **Bounded.** 60 calls a minute and 8 in flight per token, above the existing ceiling of two
  in-flight instance calls per user, which the browser and MCP share.
- **One endpoint beyond `/mcp`.** `GET /api/update-set/:sysId/package.(xml|md)` accepts the
  same bearer, because that deliverable is a file and a tool result cannot carry one
  (ADR 0014 D9). Same locks: revoke-on-present, the org and member checks, the rate limit, an
  audit row naming the token. It reaches no data the tools could not — a package is
  `sys_update_xml` formatted, and `sn_query` already reads that table.
- **Audited.** Every call is an `mcp_tool_call` row with the token's label and the name of the
  client that made it. MCP consumes no model tokens and writes no usage row.

Over a local workspace (`http://localhost:3000`) the bearer travels over loopback in the
clear, which is fine and needs no tunnel. Anywhere else, `BASE_URL` is HTTPS.

## Task policies

- **Review each change:** the person approves each proposed write.
- **Approve the plan:** the person approves a reviewed plan before eligible actions proceed.
- **Autonomous task:** an administrator enables the option and the person explicitly
  authorizes that task. Authorization is bound to the person, browser session, and instance.

No mode grants additional ServiceNow permissions or expands the action catalog. Autonomous
work stops when its authorization is cancelled or expires, and it does not continue after the
browser tab is closed.

## Storage

Local installs use an embedded PGlite database stored in `data/workspace/`. It runs inside
Node without a database server. Shared hosts can set `KADDIYA_STORAGE=postgres` and
`DATABASE_URL` to use managed PostgreSQL. Both modes store organizations, instances,
memberships, sessions, conversations, notebook entries, audit events, and usage.
Migrations and row-level access controls apply to both modes. Local transactions are
serialized for the embedded connection and the data folder is locked against double opens.

Tenant-owned content and credentials are encrypted using `KADDIYA_MASTER_KEY`. A generated
development key is acceptable only for local evaluation; deployed environments should inject
the key through their approved secret manager.

## Model providers

Self-hosted deployments can use:

- Anthropic with your own API key
- An Anthropic Messages-compatible gateway
- OpenAI or a compatible endpoint

Use the browser guide for your first connection, then **Admin → Your models** to add more
connections and choose a default. Members can switch models beside the message box before
each message. Keys remain encrypted in your database. The selected endpoint must pass the
application's HTTPS and egress checks. See the main README for compatibility limits.

Set `KADDIYA_EDITION=self-hosted` to use the browser guide without preview or billing gates.
The root `npm run setup` command configures this automatically. `SN_*` and `ANTHROPIC_*`
environment variables remain available for existing operator-configured deployments.

## Chat effort

The composer offers **Effort** beside the model selector.
The available levels depend on the model. **Default** uses the configured connection
setting or the provider default. Higher effort can take longer and use more tokens.
The browser remembers each user's choice per workspace and connection. Unknown model
aliases and models without effort support show “Not available.” Guided and autonomous
tasks retain their starting model and effort through all stages; composer changes apply
to the next message or new task.

## Local commands

Run these from the repository root:

```bash
npm run setup
npm start
```

The default address is [http://localhost:3000](http://localhost:3000).

Validation:

```bash
npm run check
npm test
```

## Important paths

- `server/` — web server, OAuth, agent, providers, tenancy, storage, and action controls
- `server/mcp.js` — the read-only MCP surface: the tool allow-list, the bearer, the bounds
- `server/update-set-package.js` — the `<unload>` writer and the ledger, and the caps on both
- `public/kaddiya-mcp.mjs` — the stdio shim, served to clients that cannot send a header
- `public/` — console UI and guided setup
- `test/` — security, tenancy, provider, action-catalog, and console contracts
- `../../scripts/` — local and optional Docker launchers
- `../../docs/kit/` — enterprise review and deployment material

## Status

Kaddiya is an early product. Start with a developer or sub-production ServiceNow instance and
review the enterprise kit before using production data.

Kaddiya is not affiliated with or endorsed by ServiceNow.
