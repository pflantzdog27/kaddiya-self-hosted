# The Kaddiya approval kit — v1

**Who this is for:** the ServiceNow platform owner, the security reviewer, and the CAB who
have to approve Kaddiya before anyone can use it. The person who wants Kaddiya is almost
never the person who can create an OAuth registry record in production, so this kit exists to
be handed over intact.

**What Kaddiya installs on your instance: nothing.** No scoped application, no widget, no
stored script, no MID Server, no standing integration user. The only artifact on your side is
one **Application Registry** record your admin creates — the same kind of record you create
for any OAuth client. Everything else runs in our application, outside your instance, as a
user-delegated OAuth client.

## The documents

| # | Document | Who acts on it | What it is |
|---|---|---|---|
| 01 | [Change request template](01-change-request-template.md) | CAB / change owner | Copy-paste CR for the registry record, with backout |
| 02 | [OAuth registry runbook](02-oauth-registry-runbook.md) | ServiceNow admin (`oauth_admin`) | The exact record, field by field: PKCE, exact redirect, lifespans, rotation |
| 03 | [Clone preserver step](03-clone-preserver.md) | `clone_admin` | Keeps sub-prod sign-in working across quarterly clones |
| 04 | [REST API access policy](04-rest-api-access-policy.md) | `api_service_admin` | Optional instance-side enforcement of the write limits, with the two-write carve-out |
| 05 | [Egress pinning](05-egress-pinning.md) | Security / network | Adaptive Authentication IP scoping. **Self-hosted only in v1** |
| 06 | [Traffic profile](06-traffic-profile.md) | Platform owner | What your instance will actually see: volumes, headers, concurrency, tables |
| 07 | [Service-account question](07-service-account-question.md) | Security governance | Why a user-delegated client is the right shape, and safer than a service account |
| 08 | [Phishing-safe sign-in](08-phishing-safe-sign-in.md) | Security awareness / training | The sign-in pattern, stated so you can train against fakes |

**The companion document.** This kit answers the platform owner's questions — what your
instance will see, and what to approve. [Architecture](../architecture.md) answers the other
half: how Kaddiya itself is built, where data lives, and what enforces the properties below.
Hand the kit to the CAB; hand the architecture document to whoever reviews the software.

## The four properties every one of these documents rests on

1. **Reads run as the signed-in user, on their own OAuth token.** Kaddiya contains no
   authorization logic. Your ACLs, roles and user criteria are the only authority. Two users
   asking the same question get different answers, and that difference comes from your
   instance, not from us.
2. **There is no autonomous write path in the build.** Anything a user can do on the instance,
   the agent can *draft*; it cannot perform any of it. Every write is a human click on a card showing the exact payload,
   through a named server endpoint from a list that fits on one page (document 04), on the
   approving user's own token, audit logged. Document 04 lets you enforce the same limit at your instance edge.
3. **Your model, your key.** Instance data goes to the model endpoint you configure, under
   your agreement with that provider.
4. **Every query is visible and logged** — on screen as it runs, in our audit log, and in your
   own `syslog_transaction` attributed to the human user. Your existing SIEM already sees
   everything Kaddiya does. Where a member has connected an MCP client (document 06), "on
   screen" means in that client rather than in the Kaddiya console — the audit row and the
   `syslog_transaction` entry are identical either way, and the row names the token.

## Precision on property 2 — read this before you quote us

The OAuth access token ServiceNow issues is **read-write**. The platform has no read-only
authorization-code scope, so no OAuth client can honestly claim its token cannot write.

The claim is narrower and checkable: *our build contains no code path that writes to your
instance without a human clicking a button on the exact payload — and you can enforce the
same limit at your own edge.* The write endpoints are enumerable, which is the point; they
are listed in document 04 and in `apps/console/README.md`, one per entry in
`apps/console/server/actions.js`, and a test fails the build if that stops being true.

## What is not in v1, and when it arrives

- **SaaS egress IP addresses** (document 05) — there are no SaaS cells yet. Self-hosted
  deployments pin their own container's egress address today. Marked N/A rather than
  promised.
- **A SIEM push connector.** A tokened pull endpoint comes first; push is later.
- **SOC 2 report, pen test report, DPIA pack.** Under way, not yet issuable. We would rather
  tell you that here than have you find out in the questionnaire.

## Known limits we would rather state than have you discover

- **One instance maps to one Kaddiya workspace.** A managed service provider reselling a
  single domain-separated instance to several end customers is unsupported in v1.
- **Instance-side enforcement (document 04) cannot restrict *which field* a PATCH writes.**
  ServiceNow's REST API access policies work at API / method / table granularity. The
  restriction to `comments` and `work_notes` is enforced in our endpoint and by your ACLs, not
  by that policy.
- **Prompts and tools are developed and tuned against Claude.** Other models are supported,
  not parity-guaranteed.

---

Decision record behind this kit: [ADR 0008](../adr/0008-enterprise-multi-tenant-architecture.md)
(D12, D13, D14, D15) and [ADR 0009](../adr/0009-north-star-adoption.md) (D2).
