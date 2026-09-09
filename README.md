# Kaddiya

**Your ServiceNow workspace. Your infrastructure. Your models.**

Kaddiya is a self-hosted AI harness for ServiceNow. Clone this repository, start it locally,
and finish setup in your browser. Bring your own API keys and model choices. Your model
provider bills usage directly; this installation needs no Kaddiya account, subscription,
or preview allowance.

Kaddiya runs outside ServiceNow. The connection needs one OAuth Application Registry record
per instance. People sign in through ServiceNow, and instance calls use their own permissions.

## Start locally

You need **Git**, **Node.js 20 or newer**, and **Docker with Docker Compose running**.
Have a ServiceNow administrator available, plus an API key for a model that supports streaming
and tool calling. Start with a developer or sub-production instance.

```bash
git clone https://github.com/pflantzdog27/kaddiya-self-hosted.git
cd kaddiya-self-hosted
npm run setup
```

No separate `npm install` is needed for this command. It builds the console, starts PostgreSQL,
creates persistent storage, and generates your installation secrets. The first build can take
a few minutes. The database stays inside Docker; the app is available only on your computer.

Open **[http://localhost:3000](http://localhost:3000)** and paste the setup code printed in
your terminal. This is your locally hosted workspace. The browser guide walks you through:

1. **Name your workspace.** The setup code proves you control this installation.
2. **Connect ServiceNow.** Create the one OAuth record using the exact redirect URL shown,
   paste its client ID and secret, then sign in as an administrator to verify the connection.
3. **Add your models.** Enter a connection name, provider, model ID, and API key. Kaddiya tests
   streaming and tool calling before saving. Add more connections and choose your default.

After setup, open the workspace and try **“Show my open incidents.”** Other people signing
in must be approved by a workspace administrator before they can join.

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

Run these from the repository root:

```bash
npm run stop          # stop the containers; keep your data
npm start             # resume the same workspace
npm run logs          # view console logs; Ctrl+C exits the log view
```

To update, back up your database and root `.env`, then:

```bash
git pull
npm run setup
```

Setup preserves an existing root `.env` and Docker volumes. It does not replace keys or erase
workspace data. Migrations run at startup. Review release changes before updating a shared host.

**Keep the root `.env` with your database backup.** It contains the database password,
encryption master key, and setup code. Losing the master key makes encrypted data unreadable.
Do not commit this file or remove Docker volumes that contain data you need.

## Troubleshooting

- **Docker is unavailable:** start Docker Desktop or your Docker engine, then rerun `npm run setup`.
- **Port 3000 is occupied:** in the root `.env`, set both `KADDIYA_PORT=3001` and
  `BASE_URL=http://localhost:3001`, then rerun setup and open that address. If ServiceNow is already
  connected, update the OAuth record's redirect URL to match before signing in again.
- **Lost the setup code:** run `npm run setup` again to display the saved code. Before verification,
  the same code can resume setup in another browser. After verification, sign in with ServiceNow.
- **ServiceNow verification failed:** check the instance hostname, client ID, secret, exact redirect
  URL, and administrator access. The guide keeps your saved details so you can correct them and retry.
- **Model test failed:** check the key, model ID, endpoint, and support for streaming/tool calls.
  Failed tests do not replace a working saved connection.

## Use an enterprise host or an existing PostgreSQL server

For a team, deploy the same console on your approved internal infrastructure with HTTPS.
The local Compose file binds the app to loopback by default. Configure your reverse proxy,
network access, secret manager, database backups, and approved model endpoints for that host.
Set `BASE_URL` to the exact address your users open; the guide derives the OAuth redirect URL
from it.

If you manage Node and PostgreSQL directly:

```bash
cd apps/console
npm ci
cp .env.example .env
```

In `apps/console/.env`, set `DATABASE_URL`, `BASE_URL`, `KADDIYA_EDITION=self-hosted`,
`KADDIYA_MASTER_KEY`, and `KADDIYA_SETUP_TOKEN`. Generate a separate random value for each
key/token with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Use PostgreSQL 15 or newer and a database role authorized to run the included migrations.
Then run `npm start` from `apps/console` and open your configured `BASE_URL`.
ServiceNow credentials and model keys are entered in the browser; no `SN_*` or model environment
variables are needed. Existing deployments configured with `SN_*` continue to work.

Enterprise reference material:

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
```

Database tests require a disposable database named with the `_test` suffix. The default is
`postgres://kaddiya@localhost:5433/kaddiya_test`; set `TEST_DATABASE_URL` to use another test
database. These tests erase that database's application tables.

Kaddiya is an early product. Validate its behavior on sub-production data before production use.
Kaddiya is not affiliated with or endorsed by ServiceNow.
