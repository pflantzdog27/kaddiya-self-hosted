# Kaddiya console

The Kaddiya console is a standalone web application for working with ServiceNow through an
AI agent. It runs outside ServiceNow and connects through OAuth and the platform's REST APIs.

Each person signs in on their own ServiceNow instance. Kaddiya uses that person's token for
instance calls, so ServiceNow's existing ACLs, roles, groups, and user criteria remain the
authority for what they can see and change.

See the repository's [main README](../../README.md) for the localhost setup and enterprise
deployment overview.

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
- `public/` — console UI and guided setup
- `test/` — security, tenancy, provider, action-catalog, and console contracts
- `../../scripts/` — local and optional Docker launchers
- `../../docs/kit/` — enterprise review and deployment material

## Status

Kaddiya is an early product. Start with a developer or sub-production ServiceNow instance and
review the enterprise kit before using production data.

Kaddiya is not affiliated with or endorsed by ServiceNow.
