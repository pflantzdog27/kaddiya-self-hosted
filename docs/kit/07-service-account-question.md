# 07 · "Third parties must use a service account"

A written answer to the governance rule most likely to be applied to Kaddiya by reflex.

## The rule, and why it exists

Most integration standards say: *third-party systems authenticate with a dedicated,
non-interactive service account, with least-privilege roles, monitored and rotated.* It is a
good rule. It exists because a classic integration is a machine talking to a machine, with no
human in the loop — so it needs an identity of its own, and that identity must be narrow,
attributable and revocable.

## Why it does not fit here

Kaddiya is not an integration. It is a **user-delegated client** — the same shape as
ServiceNow's own mobile applications, or the Agent Workspace in a browser. A person signs in,
their session runs, they close it. The category the rule is written for is machine-to-machine
traffic; this is a human using ServiceNow through a different window.

The distinction is not rhetorical. It changes the answer to every question the rule is
actually protecting against:

| The concern behind the rule | Service-account integration | Kaddiya |
|---|---|---|
| Whose permissions apply? | The service account's — a new permission set someone has to define, justify and review | The signed-in user's existing ACLs, roles and user criteria. No new permission set exists |
| Who is in the audit trail? | The service account. Tracing back to a person needs the vendor's own logs | The person. `sys_updated_by` and `syslog_transaction` name the human, in your tables |
| What happens when someone leaves? | Nothing. The service account keeps working | They lose access with their ServiceNow account, through your existing joiner/leaver process |
| Does MFA / SSO apply? | Usually not — service accounts bypass the IdP | Yes. Sign-in goes through your instance and therefore your IdP, SSO and MFA |
| What is the blast radius of a stolen credential? | Everything the service account can reach, indefinitely | One user's own access, for at most 8 hours |
| What has to be provisioned, monitored, rotated? | An account, its roles, its password or key | Nothing. One registry record |

**A service account would make Kaddiya less safe, not more.** It would require creating a
broadly-privileged identity that can read across users, and then writing authorization logic
of our own to decide what each person may see through it. Today we write none: two users
asking the same question get different answers, and the difference is produced entirely by
your platform. That property is the whole architectural argument, and a service account
destroys it.

## What we install on the instance: nothing

No scoped application. No update set. No business rule, no script include, no UI policy of
ours. No MID Server. No integration user. The only artifact on your side is the OAuth
Application Registry record your own admin creates, using your own change process — and
deactivating it ends all access immediately, without contacting us.

A pure OAuth client with copy-paste registry instructions is the lightest thing a platform
owner can be asked to approve.

## If your standard genuinely has no category for this

Two things usually resolve it:

1. **Point at the precedent already on the instance.** Your Now Mobile users authenticate
   through an OAuth client on this same platform. So does anyone using a personal developer
   tool against your instance. The category exists; it is just not the integration category.
2. **Use [document 04](04-rest-api-access-policy.md).** If the underlying requirement is
   "third-party clients must be constrained at the platform, not by vendor promise", that
   document constrains this client at your edge, using **Enforce token restriction** plus REST
   API access policies. You get the control the rule was reaching for, without inventing a
   service identity to hang it on.

## What we are not claiming

- Not that the token is read-only. ServiceNow issues no read-only authorization-code token,
  and we will not pretend otherwise. The claim is that our build has no path that writes
  without a human click — three named endpoints, listed in document 04.
- Not that user-delegated access is risk-free. It means an agent can read, quickly and
  thoroughly, everything a given user is already permitted to read. If your read ACLs are
  looser than you believe, Kaddiya will surface that. Several customers have treated that as
  the first finding rather than an objection.

---

Decision record: ADR 0008 D12, D15; ADR 0009 D2.
