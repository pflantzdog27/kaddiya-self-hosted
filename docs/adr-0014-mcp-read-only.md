# ADR 0014 — Read-only MCP access on per-user bearer tokens

**Status:** accepted · **Date:** 2026-09-15 · **Migration:** 008 · **Supersedes in part:** ADR 0009 D3

> ADRs 0008–0013 are cited throughout `apps/console/server/` by decision number and live with
> the main product record; this repository is the self-hosted distribution and carries only
> the one it adds. The build spec this record summarizes is
> [`docs/mcp-read-only-spec.md`](mcp-read-only-spec.md).

## Context

Kaddiya's central claim is that there is no autonomous write path in the build: every write
is one entry in `server/actions.js`, the agent renders a card, a human clicks it, a dedicated
endpoint performs the write on the approving user's token, and the audit row says
`approved_by_user: true`.

Members want the same read access from outside the browser — from Claude Code, from Claude
Desktop, from their own tooling — over the Model Context Protocol. The question is what that
surface may contain, and what a credential for it looks like.

## Decision

| # | Decision |
|---|---|
| D1 | The MCP surface is the read tools and nothing else. `write-paths.test.js` pins that the exported list is a subset of `READ_TOOLS`, contains no `sn_propose_*` name, and excludes `sn_note_save`. Every exposed tool carries `annotations.readOnlyHint: true`. |
| D2 | Authentication is a per-user, per-instance bearer ("MCP token") minted in the console through a fresh PKCE authorization-code flow. The ServiceNow token pair it obtains is sealed under HKDF(bearer), exactly as session tokens are sealed under HKDF(cookie) (extends ADR 0008 D8 to a second credential kind). |
| D3 | The ADR 0008 D8 revocation matrix gains a row: user revoke, admin revoke, member block, instance disconnect and org-level disable all mark the row `revoke_on_present`; the next presentation revokes at the issuer and deletes. Silent expiry deletes. |
| D4 | Transport is Streamable HTTP at `POST /mcp` on the existing Express app, stateless, JSON responses, both protocol eras served by the pinned SDK. A zero-dependency stdio shim served from the console bridges desktop clients that cannot send a header. |
| D5 | Off by default. An org admin enables it (`orgs.mcp_enabled`) and may lower the token lifetime ceiling (`orgs.mcp_token_ttl_ms`). Disabling revokes every token. |
| D6 | Every `tools/call` lands in `audit_events` as `mcp_tool_call` with the token's id and label; mint and revoke are audited as human-approved. Instance calls carry a fourth header, `X-Kaddiya-Surface: mcp`. |
| D7 | Revises ADR 0009 D3 ("attended-only") from "only while the Kaddiya tab is open" to "only when a person is driving a client in real time; no scheduled or background work". The approval kit's traffic profile gets a stated per-token bound so the platform owner still has a number. |
| D8 | The per-user in-flight gate in `sn.js` is shared across surfaces (same key), so the documented ceiling of two in-flight calls per user holds across browser and MCP together. The MCP layer adds a per-token queue bound and a per-token rate limit above it. |
| D9 | **Amended.** One endpoint outside `POST /mcp` accepts an MCP bearer: `GET /api/update-set/:sysId/package.(xml\|md)`, the update set package. It is a read, it is subject to the same bearer resolution, revoke-on-present, org/member checks and per-token rate limit, and it writes an `mcp_update_set_package` audit row naming the token. Nothing else outside `/mcp` reads a bearer. |

## Why read-only (D1)

`approved_by_user: true` is not a flag the server sets because it feels confident; it is the
click, arriving at `commitRoute(actionId)` from a card that showed the exact payload. An MCP
host has no card and no click: a `tools/call` is the model deciding, and a human "approve this
tool call" prompt in the host — which some hosts show and some do not — is not something
Kaddiya can see, log, or hold anyone to.

Exposing `sn_propose_*` over MCP would therefore either write nothing (a card nobody can
click) or write without the click that gives the audit trail its meaning. The nine proposal
tools stay out. `sn_note_save` stays out for the same reason: it lands pending behind a
keep/discard card (ADR 0008 D5), so over MCP the note would be invisible and unkept forever.

Read-only is the whole feature, and it is checkable the same way the write surface is: by
reading `server/actions.js` and one exported list.

## Why a bearer and not an OAuth resource server (D2)

Three options were weighed.

**(a) A bearer minted in the console, same sealing trick as the session cookie.** Fits the
custody story exactly: the row stores `SHA-256(bearer)` and the ServiceNow pair sealed under
`HKDF(bearer)`, so a database dump yields nothing and the server cannot open the pair without
the client presenting it. Every host that can send a header works today.

The refinement that matters is *which* ServiceNow pair goes in the row. Copying the browser
session's pair would share its refresh token: `/auth/logout` would kill the MCP token with
it, the pair's remaining life would date from the sign-in rather than the mint, and revoking
the MCP token at the issuer would sign the browser out. So the mint runs a **fresh** PKCE
authorization-code flow (`purpose: 'mcp'`), which the instance allows — one `oauth_credential`
row per grant — giving the two credentials independent lifecycles.

**(b) Kaddiya as a full OAuth 2.1 resource server** per the MCP authorization spec. ServiceNow
cannot be the authorization server: its tokens are for its own audience and Kaddiya is a
confidential client with a secret. Kaddiya would have to *be* an authorization server, which
is a second product — and the custody property does not improve, because an access token
issued by our own AS would still have to unseal the ServiceNow pair. What (b) buys is hosts
that only do OAuth. That gap is covered for now by the stdio shim, and the `mcp_tokens` row
carries a `minted_via` column so an AS-minted token is just another row later. **Deferred to a
follow-up ADR, not rejected.**

**(c) Reusing the session cookie as a bearer.** The user would have to extract it from
devtools, the client would die at the 8-hour ceiling and on every logout, and one leaked value
would open both the console (with its write endpoints, for a browser that can click) and MCP.
**Rejected.**

## Consequences

**A stolen token gets an attacker** read access as that one person, on that one instance,
through the twelve tools and the package download (D9), within their ServiceNow ACLs, until
the earlier of expiry and revocation. The download is not a widening: a package is
`sys_update_xml` rows formatted, and `sn_query` already selects `payload` from that table, so
the same bytes were reachable through the tool surface before it existed. Every call carries `X-Kaddiya-User` with the victim's `sys_id` and lands in
`audit_events` with the token's label, so the pattern is visible from both sides. It does not
get any instance write, the console, the ability to mint more tokens, any other member's data,
or any other org's data.

**The approval kit's recommended refresh-token lifespan now has a cost.**
`docs/kit/02-oauth-registry-runbook.md` tells the instance admin to set *Refresh token
lifespan* to 28,800 seconds. A 30-day MCP token on such an instance stops working after eight
hours, at its first refresh. Rather than paper over this, `verifyInstance()` records the
registry's value, minting clamps to it, the clamp is stored with the row, and the reveal
screen names it. Document 02 gains the trade-off and the re-verify step. **This is a
customer-visible decision, not a workaround**, and it is the item most worth a second look
before this reaches a customer.

**"Attended-only" is rewritten, not softened (D7).** MCP calls arrive with no Kaddiya tab
open. They are still human-initiated and never scheduled, but "when the browser tab is closed,
Kaddiya makes no calls at all" stops being true. `docs/kit/06` and `07` say the honest thing
instead, and the diff to those two files should be read by whoever owns the kit rather than
merged on sight.

**The bounds are per process.** The rate limit and the in-flight bound, like the existing
per-user gate, live in one process; a deployment with N replicas has N times them. Stated in
kit 06. A shared limiter is out of scope.

## Open questions

1. **The clamp-and-explain approach to refresh lifespans.** Product should confirm it rather
   than, say, a separate application registry record for MCP with its own lifespan — cleaner
   on the instance, one more thing for the admin to create and one more `instances` shape for
   us.
2. **Hosts that only do OAuth** (Claude.ai and Claude Desktop custom connectors) get the shim,
   not a native connection. If that gap matters commercially, option (b) is the follow-up ADR.
3. **The read-surface allow list** (ADR 0008 D14/D17, "designed, not built"). When it ships it
   applies to MCP automatically, because MCP goes through `executeTool` → `SnClient`. No
   separate provision is made here.
4. **A member with several verified instances** mints against the instance their current
   session is signed into; one token per instance.

## Out of scope

The nine `sn_propose_*` tools and every catalog entry; any MCP-side approval or elicitation
flow standing in for the card; `sn_note_save` over MCP; Kaddiya as an OAuth authorization or
resource server; admin-minted, service or per-workspace tokens; MCP resources, prompts,
subscriptions, progress notifications and SSE responses (D9 hands a host a URL and lets it
fetch, rather than introducing the resource machinery to carry one file); a SIEM push of MCP audit rows; a
shared cross-replica rate limiter; publishing the stdio shim to npm.
