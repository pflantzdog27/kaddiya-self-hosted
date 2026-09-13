# Set up Kaddiya

Start with the [repository README](README.md#start-locally).

Install your company's approved Node.js LTS release (22 or newer) and Git if needed.
On Windows:

```powershell
git clone https://github.com/pflantzdog27/kaddiya-self-hosted.git
cd kaddiya-self-hosted
.\setup.cmd
```

You can also double-click `setup.cmd`. On macOS/Linux, run `npm run setup`.
Setup creates its own local storage and opens your browser; no Docker or PostgreSQL installation
is required. Keep the terminal window open. The browser guide helps you name your
workspace, optionally add organization branding, create one ServiceNow OAuth record, verify sign-in, and add your own model keys.

Press Ctrl+C to stop. Open `start.cmd` (Windows) or run `npm start` to resume.
Back up `apps/console/data/` together with `apps/console/.env` while the app is stopped.

This path runs the harness outside ServiceNow. It does not need a scoped application,
ServiceNow SDK installation, Employee Center plugins, or an AI service account on the instance.

For an existing database or an enterprise host, follow
[the manual deployment instructions](README.md#use-an-enterprise-host-or-an-existing-postgresql-server).

For a first demo and a work-computer checklist, see [the local demo guide](docs/local-demo.md).
