# Prepare a local Kaddiya demo

## Before the demo

On the work computer, have Git and your company-approved Node.js LTS release (22 or newer),
access to your npm registry, a ServiceNow developer/test instance, an administrator who can
create its OAuth record, and an approved model API key and model ID. No Docker or separate
database installation is needed. Model connections need streaming and tool calling.

After pushing the code changes from your development computer, on the work computer:

```powershell
git clone https://github.com/pflantzdog27/kaddiya-self-hosted.git
cd kaddiya-self-hosted
.\setup.cmd
```

If already cloned, stop the running app, back up `apps/console/data/` and `apps/console/.env`,
then run `git pull` and `.\setup.cmd`. On macOS/Linux, use `npm run setup`.
Keep the launcher's terminal open.

Open the browser guide at http://localhost:3000. The launcher fills the setup code in for you;
if necessary, copy it from the terminal. Name your workspace, expand **Organization branding**,
and try your logo, accent color, and welcome message in the preview. Branding is optional.
Use the exact OAuth redirect URL shown in step 2. Sign in as a ServiceNow administrator,
then add and test a model connection in step 3.

Each fresh clone has a separate local workspace. Pushing source code does not copy your
branding, conversations, ServiceNow client secret, or model keys to the work computer.
Enter the intended connections in its setup guide. Do not commit `.env` or `data/`.

## A five-minute walkthrough

1. Show the organization's identity alongside Kaddiya and sign in through ServiceNow.
2. Ask: **“Show my open incidents. Read only; do not change anything.”**
3. Ask: **“Summarize the highest-priority incident and explain your evidence.”**
4. If multiple models are configured, switch beside the composer and ask a follow-up.
5. Open **Admin → Workspace branding**; preview a different welcome message and save it.
6. For a write demonstration, choose a disposable record on the test instance. Ask for one
   small field update, review the proposed before/after values, then explicitly apply it.
   Show the audit entry and verify the record. Leave autonomous mode off for this walkthrough.

Run through this on the work computer before the meeting. A successful local launch proves
installation, while real sign-in and a successful read prove your ServiceNow/model connections.
If the model test fails, check the exact model ID, key, endpoint, and streaming/tool support.

To stop, press Ctrl+C in the launcher. To resume, double-click `start.cmd` on Windows or run
`npm start` on macOS/Linux. Both retain the workspace and branding.

## A demo workspace with no instance and no model key

For screenshots, a walkthrough of the screens, or a capabilities PDF, the console can be run
against a **seeded throwaway workspace**. Every screen except one reads the workspace database
rather than ServiceNow, so a seeded session renders the product as it looks in use — with an
organization, members at every status, several model connections, conversations that replay,
notebook entries, MCP tokens and audit history. What it cannot do is run a turn: streaming a
reply needs a real model and a real instance.

```bash
node scripts/seed-demo.mjs --dir /tmp/kaddiya-demo --fresh
```

It prints the session cookie and the exact command to start the console on that workspace
(port 3010 by default). It **refuses to touch `apps/console/data/workspace`** — your own
workspace, branding and conversations are never opened by it. Paste the printed `sid` cookie
into the browser for that origin to arrive signed in as the demo owner; a second cookie signs
in the member who is still awaiting approval.

To rebuild the capabilities PDF, with the console running on the demo workspace:

```bash
node scripts/demo-cards.mjs   --out output/demo/cards.html
node scripts/demo-capture.mjs --dir /tmp/kaddiya-demo --out output/demo
```

`demo-cards.mjs` writes a page that loads the console's own `app.js` and calls its own card
factories, so the approval cards — which exist only while a turn is streaming and cannot be
replayed from a saved conversation — are the product's real renderers rather than mock-ups.
`demo-capture.mjs` drives the Chrome already on the machine over the DevTools protocol (no
Puppeteer, no new dependency), screenshots each screen at 2×, and prints the result to
`output/demo/kaddiya-capabilities.pdf`. Both outputs are gitignored.

The architecture document renders the same way, and needs no demo workspace at all:

```bash
node scripts/doc-to-pdf.mjs docs/architecture.md --out output/docs
```

Two things to know when showing it. The profile panel is the one screen that reads the live
instance (`/api/profile` asks ServiceNow for the person's own user record, roles and groups),
so the capture stubs that single response; everything else on that panel is the seeded
workspace answering for itself. And the demo data is invented — no customer data, and the
instance host does not exist.
