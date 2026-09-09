# Set up Kaddiya

Start with the [repository README](README.md#start-locally).

```bash
git clone https://github.com/pflantzdog27/kaddiya-self-hosted.git
cd kaddiya-self-hosted
npm run setup
```

Open the local address printed in your terminal. The browser guide helps you name your
workspace, create one ServiceNow OAuth record, verify sign-in, and add your own model keys.

This path runs the harness outside ServiceNow. It does not need a scoped application,
ServiceNow SDK installation, Employee Center plugins, or an AI service account on the instance.

For an existing database or an enterprise host, follow
[the manual deployment instructions](README.md#use-an-enterprise-host-or-an-existing-postgresql-server).
