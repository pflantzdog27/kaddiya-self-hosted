# Kaddiya

**Your ServiceNow workspace. Your infrastructure. Your models.**

Kaddiya is a self-hosted AI harness for ServiceNow. Clone this repository, start it locally,
and finish setup in your browser. Bring your own API keys and model choices. Your model
provider bills usage directly; this installation needs no Kaddiya account, subscription,
or preview allowance.

Kaddiya runs outside ServiceNow. The connection needs one OAuth Application Registry record
per instance. People sign in through ServiceNow, and instance calls use their own permissions.

## Start locally

You need **Git** and **Node.js 22 or newer** (your company's approved LTS release).
No Docker, PostgreSQL installation, database account, or administrator access is needed
to run the local setup. Setup downloads the app's dependencies from your npm registry.
Have a ServiceNow administrator available, plus an API key for a model that supports streaming
and tool calling. Start with a developer or sub-production instance.

On Windows, open a terminal in the folder where you keep your projects:

```powershell
git clone https://github.com/pflantzdog27/kaddiya-self-hosted.git
cd kaddiya-self-hosted
.\setup.cmd
```

You can also double-click **setup.cmd** in the cloned folder. On macOS/Linux, or in a terminal
where npm is available, run **`npm run setup`**. No separate `npm install` is needed.
The launcher installs the app's dependencies, creates local storage and installation secrets,
starts Kaddiya, and opens your browser. Keep its terminal window open while using Kaddiya.

The browser opens **[http://localhost:3000](http://localhost:3000)** with the setup code already
filled in. If it does not open automatically, open that address and paste the code from the
terminal. This workspace is available only on your computer. The guide walks you through:

1. **Name your workspace.** The setup code proves you control this installation. Expand
   **Organization branding** to optionally add a logo, accent color, and welcome message.
2. **Connect ServiceNow.** Create the one OAuth record using the exact redirect URL shown,
   paste its client ID and secret, then sign in as an administrator to verify the connection.
3. **Add your models.** Enter a connection name, provider, model ID, and API key. Kaddiya tests
   streaming and tool calling before saving. Add more connections and choose your default.

After setup, open the workspace and try **“Show my open incidents.”** Other people signing
in must be approved by a workspace administrator before they can join.

## Make it your team's workspace

Optional **Organization branding** in the first setup step lets an admin add a logo,
accent color, and a short welcome message with a live preview. Your workspace name and
logo appear alongside Kaddiya on sign-in, membership approval, the workspace, and Admin.
The welcome message appears on sign-in and new conversations. Accent colors personalize
navigation without changing success, warning, or approval indicators; button text adjusts
for contrast. Light and dark themes remain available.

Use **Admin → Workspace branding** to update the identity later. **Remove logo** removes
just the image; **Reset to Kaddiya defaults**, followed by **Save branding**, clears the
logo, accent, and welcome message while keeping your workspace name.

Choose a PNG, JPEG, or WebP logo under 2 MB. The browser resizes it to at most 512 pixels
and stores a PNG up to 256 KB in your workspace database. Logos are never fetched from
third-party URLs. Your workspace name, logo, accent, and welcome message are visible
before sign-in, so use public-facing identity text. Only owners and admins can save changes.
Branding is included in your normal local data backup and survives updates and restarts.

For tomorrow's walkthrough, see the [local demo guide](docs/local-demo.md).

## Connect an MCP client

A member can point an MCP host — Claude Code, Claude Desktop — at their own ServiceNow
instance through Kaddiya. They get **the twelve read tools and nothing that writes**: to
change a record you come back to the console and approve the card, as always.

It is off by default. An admin turns it on under **Admin → Access**; a member then opens
their profile panel (click your name, bottom left), names the client, picks a lifetime and
authorizes on ServiceNow once more. The token is shown one time, with the config to paste:

```bash
claude mcp add --transport http kaddiya http://localhost:3000/mcp \
  --header "Authorization: Bearer ${KADDIYA_MCP_TOKEN}"
```

Claude Desktop cannot send a header, so the console serves a small stdio shim
(`/kaddiya-mcp.mjs`) that bridges it; the same screen offers the download and the JSON.

Each token belongs to one person on one instance, carries an absolute expiry that never
slides, and is revocable by that person and by any admin. Every call is audited. On a local
workspace the token travels over loopback in the clear — that is expected, and no tunnel is
needed. See [apps/console/README.md](apps/console/README.md#connect-an-mcp-client) for the
full behaviour, and [docs/kit/02](docs/kit/02-oauth-registry-runbook.md) for the one instance
setting that caps token lifetimes.

## Hand the work over

When a change is built and captured in an update set, ask for the package. Kaddiya reads the
set back and gives you two downloads: the **update set XML**, the same `<unload>` file the
platform's own Export to XML produces, and a **ledger** listing every change, the instance it
came from, and a SHA-256 of the file.

Nothing is written to build a package — it is a read of the set you already committed to. An
MCP client can fetch the same two files with its own token, so a build driven from Claude Code
ends with the package on disk. Load it on the target instance the usual way:
**Retrieved Update Sets → Import Update Set from XML**, then **Preview** and **Commit** there.
The preview is ServiceNow's own diff, so the review happens where the change is going to land,
not here.

## Choose and switch models

Use **Admin → Your models** to add, edit, remove, or set a default model connection. Each
connection has its own key, endpoint, and model ID. You can add different models from the same
provider or models from multiple providers.

The **model selector beside the message box** lists your configured connections. Switch before
any message, including within an existing conversation. Your selection is remembered in that
browser for this workspace. An in-progress task continues using the model it started with.

Supported connection types:

| Connection | What to enter |
| --- | --- |
| Anthropic | Your API key and exact model ID |
| OpenAI or compatible endpoint | Your API key and model/deployment ID; optionally a compatible base URL |
| Anthropic-compatible gateway | Your gateway URL, API key, and model ID |

Custom model IDs are accepted; the connection test checks compatibility. OpenAI-compatible
connections use Chat Completions, with Responses used for models explicitly configured for it
in the registry. This is not a guarantee that every model works. Browser-configured endpoints
must use HTTPS and a public DNS hostname; loopback, IP literals, and `.internal`/`.local` names
are currently rejected. Model tests make a small request billed by your provider.

Keys are encrypted in your database and never returned to the browser. Unknown model pricing
is not estimated; use your provider's usage records for authoritative costs.

## Stop, resume, and update

Press **Ctrl+C** in the running terminal to stop. Your saved workspace stays on disk.
To resume on Windows, double-click **start.cmd** or run:

```powershell
.\start.cmd
```

On macOS/Linux use `npm start` from the repository root. Logs appear in that window.
To update, stop Kaddiya, back up **`apps/console/data/`** and **`apps/console/.env`**, then:

```powershell
git pull
.\setup.cmd
```

On macOS/Linux rerun `npm run setup` after pulling. Setup preserves the existing configuration
and workspace data. Migrations run at startup.

**Keep `apps/console/.env` with your data backup.** It contains the encryption master key and
setup code. Losing the master key makes encrypted data unreadable. These files are ignored by Git.

Local storage is an embedded [PGlite](https://pglite.dev/docs/about) database at
`apps/console/data/workspace/`. It runs inside the app without a database server or database port.
It retains instance/workspace access controls, encrypted credentials and content, and audit history.
Use one Kaddiya process per local data folder. Keep it on the computer's local disk, outside
OneDrive, network drives, and shared folders. Stop the app before copying a backup.

## Troubleshooting

- **Node is unavailable:** install your company's approved Node.js LTS release (22 or newer),
  reopen your terminal, then run `setup.cmd` again. Kaddiya does not install system software.
- **PowerShell blocks npm.ps1:** use `setup.cmd` / `start.cmd`; they do not require changing
  PowerShell's execution policy.
- **Dependency download failed:** check access to your company's npm registry. Use your approved
  proxy/certificate configuration; setup respects npm settings. Then rerun setup.
- **Port 3000 is occupied:** in `apps/console/.env`, set both `PORT=3001` and
  `BASE_URL=http://localhost:3001`, then restart and open that address. If ServiceNow is already
  connected, update the OAuth record's redirect URL to match before signing in again.
- **Lost the setup code:** restart Kaddiya to display the saved code. Before verification,
  the same code can resume setup in another browser. After verification, sign in with ServiceNow.
- **ServiceNow verification failed:** check the instance hostname, client ID, secret, exact redirect
  URL, and administrator access. The guide keeps your saved details so you can correct them and retry.
- **Model test failed:** check the key, model ID, endpoint, and support for streaming/tool calls.
  Failed tests do not replace a working saved connection.
- **Workspace is already open:** stop the other Kaddiya process first. After a forced shutdown,
  wait two minutes for its storage lock to expire, then retry. Do not delete the data folder.
- **Earlier Docker installation:** use `npm run setup:docker` to resume it. Local setup does not
  copy Docker data; use a fresh clone for a separate local workspace.

## Use an enterprise host or an existing PostgreSQL server

For a shared team host, deploy the same console with managed PostgreSQL and HTTPS.
The local launcher is for one workstation. Configure your reverse proxy,
network access, secret manager, database backups, and approved model endpoints for that host.
Set `BASE_URL` to the exact address your users open; the guide derives the OAuth redirect URL
from it.

If you manage Node and PostgreSQL directly:

```bash
cd apps/console
npm ci
cp .env.example .env
```

In `apps/console/.env`, set `KADDIYA_STORAGE=postgres`, `DATABASE_URL`, `BASE_URL`, `KADDIYA_EDITION=self-hosted`,
`KADDIYA_MASTER_KEY`, and `KADDIYA_SETUP_TOKEN`. Generate a separate random value for each
key/token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Use PostgreSQL 15 or newer and a database role authorized to run the included migrations.
Then run `npm start` from `apps/console` and open your configured `BASE_URL`.
ServiceNow credentials and model keys are entered in the browser; no `SN_*` or model environment
variables are needed. Existing deployments configured with `SN_*` continue to work.

Docker remains optional: from a separate clone, `npm run setup:docker` starts the Compose
deployment, `npm run start:docker` resumes it, `npm run stop` stops its containers, and
`npm run logs` shows their logs. That path uses the root `.env` and Docker volumes.
The local launcher and Docker deployment keep separate data; changing launchers is not a migration.

Enterprise reference material:

- [Architecture](docs/architecture.md) — what runs where, and what makes the claims checkable
- [OAuth registry runbook](docs/kit/02-oauth-registry-runbook.md)
- [REST API access policy](docs/kit/04-rest-api-access-policy.md)
- [Egress controls](docs/kit/05-egress-pinning.md)
- [Traffic profile](docs/kit/06-traffic-profile.md)
- [Console architecture and controls](apps/console/README.md)

## Development

The application is Express and plain browser JavaScript in `apps/console`.

```bash
npm --prefix apps/console ci
npm run check
npm test
npm run test:setup
```

Tests use disposable embedded databases by default. To test the shared-host backend, set
`TEST_DATABASE_URL` to a disposable PostgreSQL database whose name ends in `_test`.
That mode erases the test database's application tables. CI runs the local tests and a fresh
setup/restart check on Windows, macOS, and Linux, plus a separate PostgreSQL suite.

Kaddiya is an early product. Validate its behavior on sub-production data before production use.
Kaddiya is not affiliated with or endorsed by ServiceNow.
