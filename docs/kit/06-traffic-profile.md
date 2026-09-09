# 06 · Traffic profile

For the platform owner, whose veto comes before the security team's. This is what your
instance will actually see.

## How to find our traffic

Every call Kaddiya makes carries these headers:

| Header | Value | Use |
|---|---|---|
| `User-Agent` | `Kaddiya/<version>` | Filter `syslog_transaction` on this and you have every call we ever made. |
| `X-Kaddiya-Org` | the deployment's configured label | Distinguishes deployments if you run more than one. Set at deployment; per-organization values arrive with multi-tenancy. |
| `X-Kaddiya-User` | the signed-in user's `sys_id` | Correlates a call to a person without a lookup. |

The transaction is already attributed to the human user by ServiceNow itself, because the call
runs on their token. The headers are for finding our traffic among everything else, not for
establishing identity — that is the platform's job.

## Shape of the load

| Property | Value |
|---|---|
| Concurrency | **Maximum 2 in-flight calls per user.** Enforced in our client, not left to chance. The Table API shares your instance's integration semaphore pool, so this is the number that keeps us off it. |
| Calls per user question | Typically 1–6. A complex investigation reaches the low teens; a hard ceiling of 12 agent iterations bounds it. |
| Query style | `sysparm_fields` and `sysparm_limit` are always set. Record limits default to 15 and are capped at 50. Schema reads cap at 250 dictionary rows. |
| Counting | "How many" questions go to the **Aggregate API** (`/api/now/stats/`), not to fetching rows and counting them. |
| Sorting | Explicit `ORDERBY` only where the user asked for an ordering. |
| Bulk / export | None. There is no crawler, no scheduled job, no nightly sync, no bulk export, and no background process of any kind — Kaddiya only runs while a human is watching. |
| Rate limiting | `429` and `Retry-After` are honored with capped backoff, at most two retries. We back off; we do not hammer. |
| Attachments | Not called at all in this release. |

## What we do not do

- **No shadow copy of your data.** No embedding index, no vector store, no warm cache of
  instance records. Every answer comes from a live query you can see on screen.
- **No background or scheduled work.** No overnight triage, no polling. When the browser tab
  is closed, Kaddiya makes no calls at all. Changing that would require a different security
  posture and a new architectural decision, not a feature flag.
- **No service account.** There is no integration user to provision, monitor or rotate.
- **No MID Server, no scoped app, no business rule, no stored script.**

## The knob you will want, and when it arrives

A **per-organization read-surface allow list** — which tables the agent may query at all — is
on the roadmap (ADR 0008 D14/D17). It is not authorization logic of ours; your ACLs still
govern inside it. It exists because an agent makes historically sloppy read ACLs visible at
machine speed, and every platform owner asks for the knob. Until it ships, your controls are
your ACLs and, if you want them, the API access policies in
[document 04](04-rest-api-access-policy.md).

## One risk we will name for you rather than wait to be asked

Encoded queries can be used as an oracle. A dot-walked condition (`caller_id.department=…`)
filters on a field whose *display* may be ACL-redacted, so a determined user could narrow down
a hidden value by watching which filters return rows. This is a property of ServiceNow's list
filtering, not something Kaddiya introduces — the same person can do it in a list view — but
an agent makes it fast.

**What is true today:** every query is on screen while it runs and is audit-logged, so the
pattern is visible in a way it is not in a list view.

**What is designed and not yet built:** a dot-walk depth limit and a sensitive-field block
list in the query tool, plus the read-surface allow list above, which will let you cut it off
entirely for tables where you care. Plan around the current state, not that list.

## Estimating volume

A rough planning figure: an active user asking questions steadily for an hour generates on the
order of a few hundred REST calls — comparable to that person using list views and forms
briskly, and bounded by two concurrent calls at any moment. Measure it yourself in a
sub-production instance with the `User-Agent` filter above before you size anything.

---

Decision record: ADR 0008 D14, D17; ADR 0009 D3 (attended-only).

## Which writes are switched on

Every write Kaddiya can make is one entry in its action catalog, in three tiers (task and
request actions; configuration records including executable code; security-sensitive
configuration). A deployment enables tiers with `KADDIYA_ACTIONS`; a proposal for a disabled
tier does not exist — the agent has no tool for it, and the endpoint refuses it. The enterprise
default is tier 1 only. Ask your vendor contact which tiers your deployment runs; the complete
list, with the instance API and tables each entry touches, is document 04's write table.
