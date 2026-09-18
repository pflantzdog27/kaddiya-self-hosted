# Build spec: read-only MCP access to a member's ServiceNow instance

**Status:** proposed · **Decision record:** ADR 0014 (proposed, see below) · **Migration:** 008 · **Date:** 2026-09-15

Kaddiya becomes a Model Context Protocol server. An external MCP host (Claude Code, Claude Desktop through a stdio shim, internal tooling) presents a per-user bearer token and gets the console's read tools, running on that person's own ServiceNow OAuth token, audited like every other call. Nothing in the action catalog is reachable.

### Proposed decision record: ADR 0014 — Read-only MCP access on per-user bearer tokens

The code cites ADR 0008 through 0013 by decision number (`ADR 0011 D3`), so the comments this feature adds cite these:

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

## Goal

Let a member query the ServiceNow instance they are already signed into, from an MCP host outside the browser, through Kaddiya, with the same eleven read tools the console agent has, under the same six constraints the console already meets: user-delegated token, ServiceNow ACLs as the only authority, tenant isolation through `withOrg()`, a write surface countable in `server/actions.js`, pinned HTTPS egress with identifying headers, and an audit row per call.

## Why read-only

Every write Kaddiya can make is one entry in `server/actions.js`, and every entry obeys the ADR 0009 D2 invariant: the agent renders a card, a human clicks it, a dedicated endpoint performs the write on the approving user's token, and the audit row says `approved_by_user: true`. That `true` is not a flag the server sets because it feels confident; it is the click, arriving at `commitRoute(actionId)` from a card that showed the exact payload. An MCP host has no card and no click: a `tools/call` is the model deciding, and a human "approve this tool call" prompt in the host (which some hosts show and some do not) is not something Kaddiya can see, log, or hold anyone to. Exposing `sn_propose_*` over MCP would therefore either write nothing (a card nobody can click) or write without the click that gives the audit trail its meaning. The nine proposal tools stay out; `sn_note_save` stays out for the same reason (it lands pending behind a keep/discard card, ADR 0008 D5). Read-only is the whole feature, and it is checkable in the same way the write surface is: by reading `server/actions.js` and one exported list.

## What I checked

| File | What it does today | Why it matters here |
|---|---|---|
| `apps/console/server/agent.js` | `toolDefinitions(actionsTiers)` (line 110) returns `proposalTools()` plus twelve read tools defined inline; `executeTool(sn, name, input, emit, ctx)` (line 295) dispatches by name and throws for `sn_propose_*` when `ctx.scope.readOnly`; `sn_record` calls `emit('focus', …)`; `sn_note_save` calls `emit('note', …)` and writes the local notebook. `runAgentTurn` audits each call as `{ tool, input, ms, summary, error }`. | MCP reuses `toolDefinitions()` for schemas and `executeTool()` for execution with a no-op `emit`. The file is not modified, so the `MUTATORS` grep in `write-paths.test.js` sees the same bytes. |
| `apps/console/server/sn.js` | `SnClient(cfg, tokens, onTokensRefreshed, identity)`; `send()` wraps every call in `withSlot(instanceUrl\|userKey)` (two in flight per user per process, unbounded FIFO queue), refreshes once on 401 via `onTokensRefreshed`, honors 429/Retry-After twice. `guardedFetch()` refuses non-HTTPS, any host but the instance's, and any 3xx. `headers()` sends `User-Agent`, `X-Kaddiya-Org`, `X-Kaddiya-User`. `revokeToken()` hits `oauth_revoke_token.do`. | The MCP path constructs an `SnClient` the same way `snFor()` does. The gate key is `${instanceUrl}\|${userKey}`, so giving MCP the same `userKey` (the member's `sys_id`) keeps the platform ceiling. The queue has no bound, which matters once a host fires calls in parallel. |
| `apps/console/server/sessions.js` | `createSession()` seals tokens under `sessionKey(sid)` with AAD `session:<hash>`; `lookupSession()` opens them, deletes on expiry or bad ciphertext, returns `{ revoked: true, tokens }` once for `revoke_on_present` rows; `saveTokens()` re-seals after a refresh; `purgeExpired()` runs every minute. Uses `system()` and is on the `db-gates` allow-list. | The MCP token row is the analog of the session row. The refresh-on-401 "no session row to write back to" problem in the brief dissolves: the row exists, and `saveTokens()` re-seals under HKDF(bearer). The bearer lookup happens before the tenant is known, so it lives here, in the one module already allowed to call `system()`. |
| `apps/console/server/index.js` | `getSession()` (line 148) resolves cookie → session → org (must be `active`) → `OrgContext` → instance (must be `verified`) → member; `requireActive()` demands `member.status === 'active'`; `snFor()` (line 223) builds the client with `userKey: session.userSysId`; `/auth/callback` (line 296) exchanges the code, calls `whoami()`, branches on `pending.purpose`; `/auth/logout` revokes both tokens at the issuer; the CSRF middleware covers `/api/*` and `/auth/logout` only; `express.json()` is global; `commitRoute()` mounts the nine catalog endpoints; `/api/admin/settings` calls `tenancy.updateOrgSettings`. | The mint flow is a third `purpose` in the existing OAuth callback. `/mcp` is mounted outside `/api/` so the cookie-oriented CSRF check does not apply, and before `express.json()` so the SDK reads its own body. Every new `app.post()` is visible to the endpoint grep. |
| `apps/console/server/db.js` | `withOrg(orgId, fn)` drops to `kaddiya_app` and pins `app.org_id`; `system(fn)` is the directory role. Tenant tables `FORCE` RLS, directory tables `ENABLE` it. | `mcp_tokens` is a directory table (the owner role must resolve a bearer before the org is known), like `sessions`. Every read after resolution is `withOrg`. |
| `apps/console/server/keys.js` | `OrgContext` (built only from an org row a session resolved to) encrypts with AAD `org_id:column`; `sessionKey(sid)` is HKDF-SHA256 with salt `kaddiya-session`, info `session-tokens`; `sealWithKey`/`openWithKey` are AES-256-GCM, versioned. | Adds `mcpTokenKey(bearer)` with a distinct salt and info so a bearer and a cookie of equal bytes derive different keys. The one-time reveal of the bearer is sealed under `sessionKey(sid)` of the minting browser. |
| `apps/console/server/tenancy.js` | `ORG_PUBLIC_COLUMNS` and `SETTABLE` enumerate org settings (`autonomous_mode` was added by migration 005 and is a boolean here); `setMember()` marks `sessions.revoke_on_present` on block; `disconnectInstance()` marks sessions by instance; `verifyInstance()` reads `oauth_entity` on the admin's token; `instanceConfig()` is the only place the client secret is decrypted; `sessionTtlFor()` clamps downward to `SESSION_CEILING_MS`. | The toggle, the TTL ceiling, the two revocation hooks and the refresh-lifespan read all land here, each next to its existing twin. |
| `apps/console/server/actions.js` | The catalog. Pure module; every write is an entry; `proposalTools()` derives the agent's proposal tools; the header comment states the ADR 0009 D2 invariant. | Untouched. The MCP surface is defined by exclusion from this file, and the test proves it. |
| `apps/console/server/audit.js` | `audit(scope, entry)`: index fields plaintext, the rest encrypted under the org key; `conversation` must be a UUID or is dropped; `action` defaults to `tool_call` when `tool` is present. Never throws. | MCP calls use it unchanged with `action: 'mcp_tool_call'`, `conversation: null`, and `token_id`/`token_label` in the encrypted payload. `admin.js` `renderAudit` shows `r.action` for anything that is not `tool_call`, so the rows read as `mcp tool call`. |
| `apps/console/test/write-paths.test.js` | Greps `agent.js` for `MUTATORS`; asserts `toolDefinitions()` equals `READ_TOOLS` ∪ catalog names; greps `index.js` for every `app.post/patch/put/delete` and asserts the set equals `CONSOLE_LOCAL_ENDPOINTS` ∪ catalog endpoints; checks `commitRoute` and `approved_by_user` counts. | The file's own comment says a new console-local endpoint is added to its restated list, on purpose. Three new `POST` routes are added there; one new assertion pins the MCP list. See Test plan. |
| `apps/console/test/db-gates.test.js` | (a) every table with `org_id` has RLS with `USING` and `WITH CHECK`; (b) two seeded orgs never cross; (c) a tenant query outside `withOrg()` errors; (e) `system(` appears only in `db.js`, `tenancy.js`, `sessions.js`, `billing.js`, `site-chat.js`. | `mcp_tokens` must carry the policy (it does, see Data model). `mcp.js` never calls `system(`. No edit to this test. |
| `apps/console/server/migrations/001_tenancy.sql`, `005_models_and_autonomy.sql` | The policy shape (`tenant_isolation … USING … WITH CHECK`), the grants block, `sessions` as a directory table; 005 adds `autonomous_mode boolean NOT NULL DEFAULT false`. | Migration 008 copies both shapes. |
| `apps/console/test/helpers/db.js`, `test/sessions.test.js`, `test/self-hosted.test.js` | `seedOrg()` builds an org through the real verification path with `fakeSn`; sessions test dumps the table and greps for plaintext; self-hosted test boots `server/index.js` as a child process on a free port and drives it over HTTP. | The three patterns the new tests copy. |
| `apps/console/server/docs.js` | `detectRelease(sn)` caches per instance host and swallows the `sys_properties` read failure. | `sn_docs_*` work over MCP with no change. |
| `apps/console/public/app.js`, `admin.js`, `admin.html` | `showProfile()` (line 662) is the per-person panel; the `focus` event opens the record in the right rail (line 1694); `renderAccess()` binds `a-autonomous` to `org.autonomous_mode` and the access form posts it. | Where the mint UI and the admin toggle go. |
| `docs/kit/02`, `04`, `06`, `07`, `README.md` | 02 recommends an 8-hour refresh-token lifespan; 06 promises "no background process of any kind — Kaddiya only runs while a human is watching" and a 12-iteration bound; 07's blast-radius row says "at most 8 hours". | Three claims this feature changes. They are corrected in the same commit, and the traffic profile gets a per-token number. |

### Where the brief and the code disagree

1. **"The ten read tools" is eleven.** The brief lists eleven names. `READ_TOOLS` in `write-paths.test.js` has twelve, because it also holds `sn_note_save`, which writes the console's notebook behind a card. The MCP surface is the eleven; the test change below makes that explicit.
2. **The refresh-token lifespan the approval kit recommends caps MCP tokens at eight hours.** `docs/kit/02-oauth-registry-runbook.md` tells the instance admin to set *Refresh token lifespan* to 28,800 seconds "because Kaddiya never keeps a token past the user's session". A 30-day MCP token on such an instance stops working after eight hours, at the first refresh. The spec handles this two ways: `verifyInstance()` records the registry's `refresh_token_lifespan` when the admin's read returns it, and minting clamps the expiry to it and says so; document 02 gains a row saying that enabling MCP means raising the lifespan for this client and re-verifying. This is a customer-visible trade-off and needs a product decision, not a workaround.
3. **The "attended-only" claim (ADR 0009 D3, kit 06 and 07) is contradicted by design.** MCP calls arrive with no Kaddiya tab open. They are still human-initiated and never scheduled, but "when the browser tab is closed, Kaddiya makes no calls at all" stops being true. ADR 0014 D7 revises the claim; the kit text is rewritten, not softened.
4. **`db-gates` allow-lists `site-chat.js`, which does not exist in `server/`**, and `docs/kit/README.md` says there are "three" write endpoints where the catalog now has nine. Neither is caused by this feature. Both are drift worth fixing in passing.
5. **The MCP protocol itself changed under the brief.** The current revision is 2026-07-28: no `initialize` handshake, no sessions, per-request `_meta`, `server/discover`, and a required `resultType` on every result. Claude Code 2.1.232+ speaks it; older hosts speak the 2025 initialize-based revisions. The transport decision below is made for that dual-era world, which is the main argument for the SDK over a hand-rolled JSON-RPC loop.

## Decision: authentication

### Options considered

**(a) A workspace token minted in the Kaddiya UI, pasted into the client config, same sealing trick, longer TTL.** Fits the custody story exactly: the row stores `SHA-256(bearer)` for lookup and the ServiceNow pair sealed under `HKDF(bearer)`, so a database dump yields nothing and the server cannot open the pair without the client presenting it. Every host that can send a header can use it today (Claude Code: `--header "Authorization: Bearer …"`, with `${VAR}` expansion in `.mcp.json`). What the brief's version gets wrong is *which* ServiceNow pair goes in the row. Copying the browser session's pair shares its refresh token: `/auth/logout` revokes that refresh token at the issuer and kills the MCP token with it, the pair's remaining life dates from the sign-in rather than the mint, and revoking the MCP token at the issuer would kill the browser session. So the pick mints a **fresh** pair through a second PKCE authorization-code flow (`purpose: 'mcp'`), which the instance allows (one `oauth_credential` row per grant) and which gives the two credentials independent lifecycles.

**(b) Kaddiya as a full OAuth 2.1 resource server per the MCP authorization spec.** The spec's shape is now: RFC 9728 protected-resource metadata, an authorization server with RFC 8414 metadata, Client ID Metadata Documents (dynamic registration is deprecated), RFC 8707 resource indicators, RFC 9207 issuer checks, a consent screen, refresh tokens, and audience validation. ServiceNow cannot be that authorization server: its tokens are for its own audience and Kaddiya is a confidential client with a secret. Kaddiya would have to *be* an authorization server, which is a second product. The custody property does not improve: an access token issued by Kaddiya's own AS would still have to unseal the ServiceNow pair, so it would be sealed under HKDF(access token) and re-sealed on every rotation, for the same end result as (a) with ten times the surface. What (b) buys is hosts that only do OAuth (Claude.ai and Claude Desktop custom connectors). That is a real gap, covered for now by the stdio shim, and the `mcp_tokens` row is shaped so an AS-minted token is just another row later (`minted_via` column). Deferred to a follow-up ADR, not rejected.

**(c) Reusing the session cookie value as a bearer.** The cookie is `HttpOnly`, `__Host-` prefixed, 8-hour absolute, deleted and issuer-revoked on logout, and the only credential the browser holds. Using it as a bearer means the user has to extract it from devtools, the MCP client dies at the 8-hour ceiling and on every logout, and one leaked value now opens both the console (with its write endpoints, for a browser that can click) and MCP. It also conflates the two custody stories the tests pin separately. Rejected.

### The pick: (a), refined

**Per-user, per-instance.** A token is bound to `(org_id, instance_id, member_id, sn_user_sys_id)`, minted only by that person through their own OAuth consent, never by an admin on their behalf. A per-workspace token would need a service account, which `docs/kit/07` argues against and constraint 1 forbids.

**Format and entropy.** `kmcp_` + 43 base64url characters from 32 random bytes (`crypto.randomBytes(32)`), 48 characters total, 256 bits of entropy. The prefix makes a pasted value recognisable and lets secret scanners match it. The row stores `token_hash = SHA-256(bearer)` (raw 32-byte `bytea`, unique) and `token_prefix = bearer.slice(0, 12)` for display. The bearer is shown once and never stored in the clear.

**Where the ServiceNow tokens live and what unseals them.** `mcp_tokens.tokens_enc` holds `JSON.stringify({ accessToken, refreshToken, expiresAt })` sealed with AES-256-GCM under `mcpTokenKey(bearer) = HKDF-SHA256(bearer, salt 'kaddiya-mcp', info 'mcp-tokens', 32)`, AAD `mcp:<token_hash hex>`. The server can open it only while a request presenting the bearer is in flight, which is the same window `sessions.js` gives a cookie. A refresh re-seals under the same key through `saveTokens()`.

**TTL.** Absolute from mint, never sliding: the person picks 1 day, 7 days, 30 days (default) or "the workspace maximum"; the org ceiling `mcp_token_ttl_ms` moves downward only from a code ceiling of 90 days (`MCP_TOKEN_CEILING_MS`), mirroring `sessionTtlFor()`. The effective expiry is `min(requested, org ceiling, instance refresh-token lifespan when recorded)`, and the reveal screen names which bound applied. Expired rows are deleted by `purgeExpired()` and on presentation.

**Revocation.**

| Event | Mechanism | At the issuer |
|---|---|---|
| Person revokes (profile panel) | `POST /api/mcp/tokens/:id/revoke` sets `revoke_on_present` | On next presentation, both tokens are revoked at `oauth_revoke_token.do`; row deleted |
| Admin revokes (Admin → MCP access) | Same endpoint, admin allowed for any token in the org | Same |
| Admin blocks the member | `tenancy.setMember(status:'blocked')` also marks `mcp_tokens` by `member_id` | Same |
| Admin disconnects the instance | `tenancy.disconnectInstance()` also marks `mcp_tokens` by `instance_id` | Same |
| Admin turns MCP off | `updateOrgSettings({ mcp_enabled: false })` marks every token in the org; every `/mcp` request answers 403 regardless | Same |
| Member becomes `pending`, instance `needs_reverification`, org `suspended` | Checked per request; 403, row untouched | No |
| Browser logout | Nothing. Independent pair | No |
| Expiry | `purgeExpired()` deletes; a presented expired row is deleted first | No: the ciphertext is gone, the pair expires on the instance's own schedule (same posture as sessions) |

**What a stolen token gets an attacker.** Read access as that one person, on that one instance, through the eleven tools only, to whatever their ServiceNow ACLs already allow, until the earlier of expiry and revocation. Every call still carries `X-Kaddiya-User` with the victim's `sys_id` and lands in `audit_events` with the token's label, so the pattern is visible from both sides. It does not get: any instance write (the ServiceNow access token never leaves the server, and the surface has no write tool even though the underlying token is read-write); the console (no cookie, and `/mcp` ignores cookies); the ability to mint more tokens; any other member's data; any other org's data.

## Architecture

### Request path, MCP client to instance

```mermaid
sequenceDiagram
    participant H as MCP host (Claude Code / shim)
    participant X as index.js POST /mcp
    participant M as server/mcp.js
    participant S as sessions.lookupMcpToken (system())
    participant T as tenancy (withOrg)
    participant A as agent.executeTool
    participant C as sn.SnClient / guardedFetch
    participant I as ServiceNow instance
    H->>X: POST /mcp · Authorization: Bearer kmcp_… · JSON-RPC
    X->>M: Origin present and ≠ BASE_URL origin? 403. Cookies ignored.
    M->>S: SHA-256(bearer) → row; expiry; open tokens_enc under HKDF(bearer); revoke_on_present?
    S-->>M: { id, orgId, instanceId, memberId, userSysId, user, label, tokens, saveTokens }
    M->>T: getOrg (active, mcp_enabled) · contextFor · getInstance (verified) · getMember (active)
    T-->>M: org, ctx, instance, member — or 401/403
    M->>M: proactive refresh if access token expires in < 60 s (per-token lock) → saveTokens re-seals
    M->>M: SDK handler: tools/list from MCP_TOOLS · tools/call → allow-list · rate limit
    M->>A: executeTool(sn, name, args, noopEmit, { cfg, user, conversationId: null, scope })
    A->>C: sn.queryTable(…) etc.
    C->>I: GET https://<verified host>/api/now/… · User-Agent · X-Kaddiya-Org · X-Kaddiya-User · X-Kaddiya-Surface: mcp
    I-->>C: 200 / 401 (refresh once, re-seal) / 429 (Retry-After, ≤2)
    C-->>A: result
    A-->>M: result
    M->>T: audit(scope, { action: 'mcp_tool_call', tool, input, ms, summary, error, token_id, token_label })
    M-->>H: { resultType: 'complete', content: [text], structuredContent, isError? }
```

Step by step:

1. **Mount.** `app.post('/mcp', mcp.handler(cfg))` is registered in `index.js` *before* `app.use(express.json())` so the SDK reads the raw body, and it is outside `/api/`, so the cookie CSRF middleware does not run. `app.get('/mcp')` answers 405 for legacy clients probing the old standalone stream. No `DELETE /mcp` is mounted: the server never mints a session id, so no client has anything to terminate.
2. **Origin.** The 2026-07-28 spec requires it: an `Origin` header that is present and not `new URL(cfg.baseUrl).origin` is 403. Non-browser hosts send none. `/mcp` never reads cookies, so a cross-site browser POST carries no credential either way.
3. **Bearer.** `Authorization: Bearer kmcp_…`. Missing or malformed → 401 with `WWW-Authenticate: Bearer realm="kaddiya"`. The token is never accepted in a query string.
4. **Lookup** (`sessions.lookupMcpToken(bearer)`, the one directory read): hash, load, delete if expired, open `tokens_enc` (delete on failure), hand back `{ revoked: true, tokens }` once for a `revoke_on_present` row, throttle `last_used_at` writes to once a minute like `TOUCH_INTERVAL_MS`.
5. **Tenant.** `tenancy.getOrg(row.org_id)` must be `active` and `mcp_enabled`; `contextFor(org)` builds the `OrgContext` from that row and nothing the client sent; `getInstance` must be `verified`; `getMember` must be `active`. A `revoked` row revokes both ServiceNow tokens at the issuer here (best effort, as `getSession()` does) and answers 401. Any other failure is 403 with a one-line reason.
6. **Client.** `new SnClient(instanceCfg, tokens, (t) => row.saveTokens(t), { org: org.slug || org.name, userKey: row.userSysId, surface: 'mcp' })`. Same `userKey` as the browser, so `withSlot()` keys both surfaces together. `instanceCfg` comes from `tenancy.instanceConfig()`; the MCP layer never builds a URL.
7. **Proactive refresh.** If `tokens.expiresAt - Date.now() < 60_000`, refresh once under an in-process lock keyed by `token_hash` before the first call, so a parallel burst from the host refreshes once and re-seals once rather than racing through `send()`'s per-call 401 handling.
8. **Protocol.** A per-request `createMcpHandler(() => buildServer(principal), { responseMode: 'json', legacy: 'stateless' })` from `@modelcontextprotocol/server`, wrapped by `toNodeHandler` from `@modelcontextprotocol/node`. `buildServer` returns a low-level `Server({ name: 'kaddiya', version, title: 'Kaddiya · <host>' }, { capabilities: { tools: {} }, instructions })` with two handlers: `tools/list` returns `MCP_TOOLS` (deterministic order, `ttlMs: 300000`, `cacheScope: 'private'`); `tools/call` checks the name against `MCP_TOOLS` (unknown → JSON-RPC `-32602`), applies the per-token limits, and calls `executeTool`. Modern clients (`_meta` per request, `server/discover`) and legacy clients (`initialize`) are both served by the SDK from the same factory; our code does not branch on era.
9. **Execution.** `executeTool(sn, name, args, () => {}, { cfg, user: row.user, conversationId: null, scope })` where `scope = { ctx, instanceId, userSysId, readOnly: true, actionsTiers: org.actions_tiers }`. `readOnly` is a second wall behind the allow-list. The `focus` emit from `sn_record` goes nowhere; the wrapper adds `link: <instanceUrl>/<table>.do?sys_id=<sys_id>` to that tool's result instead.
10. **Result.** `content: [{ type: 'text', text: JSON.stringify(result) }]`, truncated at `MCP_MAX_RESULT_CHARS` (100,000) with the console's "(truncated — narrow the query)" note; `structuredContent` set only when not truncated. A thrown tool error becomes `isError: true` with the same message string the console model would see (a ServiceNow 403 reads as the platform refusing). `resultType: 'complete'` is added by the SDK.
11. **Audit.** `audit(scope, { user: row.user.user_name, action: 'mcp_tool_call', tool, input, table: input.table, sys_id: input.sys_id, ms, summary, error, token_id, token_label, client: clientInfo?.name })`. Index columns stay plaintext; `input` and the rest are under the org key as today.
12. **No model, no meter.** MCP calls consume no model tokens: `billing.gateTurn` is not consulted and no `usage_events` row is written.

### Mint path, browser to row

1. Profile panel (`showProfile()`), section **MCP access**, visible only when `/api/me` reports `mcp_available`. The person enters a label (≤ 40 chars, e.g. `claude-code laptop`) and picks a lifetime, then the page navigates (`location.assign`, never a form submit, per the `csp.test.js` note on `form-action`) to `GET /auth/mcp?label=…&ttl_ms=…`.
2. `GET /auth/mcp` requires an active member and `org.mcp_enabled`, then calls `beginOAuth(res, { org, ctx, instanceId: session.instanceId, purpose: 'mcp', meta: { label, ttlMs, memberId, userSysId } })`. `createOAuthState` stores `meta` in the new `oauth_states.meta` column. The browser-binding cookie and PKCE are unchanged.
3. ServiceNow shows its consent screen for the Kaddiya client again. The person authorizes.
4. `/auth/callback`, `pending.purpose === 'mcp'`: binding check as today; `exchangeCode`; `whoami()`; **the current browser session must exist, be active, and `user.sys_id` must equal `session.userSysId`** — otherwise the new pair is revoked at the issuer and the callback fails with "the account that authorized on ServiceNow is not the account signed in here". Then `sessions.createMcpToken({ orgId, instanceId, memberId, userSysId, user, label, tokens, ttlMs, revealFor: sid })` generates the bearer, seals the pair under `mcpTokenKey(bearer)`, seals the bearer itself under `sessionKey(sid)` (AAD `mcp-reveal:<id>`) into `reveal_enc` with `reveal_expires_at = now() + 5 minutes`, inserts, audits `mcp_token_mint` with `approved_by_user: true`, and redirects to `/?mcp=<id>`.
5. The app sees `?mcp=<id>`, calls `POST /api/mcp/tokens/:id/reveal` (cookie session, CSRF-protected). The server opens `reveal_enc` under the *same* cookie's key, nulls the column, and returns `{ bearer, label, expires_at, clamped_by, snippets }`. The panel shows the bearer once with copy buttons and the three config snippets below. A second call is 410.

Config snippets the reveal shows (with the workspace's real `BASE_URL`):

```bash
# Claude Code — HTTP transport with a static header
claude mcp add --transport http kaddiya https://kaddiya.example.com/mcp \
  --header "Authorization: Bearer ${KADDIYA_MCP_TOKEN}"
```

```json
{ "mcpServers": { "kaddiya": {
  "type": "http",
  "url": "https://kaddiya.example.com/mcp",
  "headers": { "Authorization": "Bearer ${KADDIYA_MCP_TOKEN}" } } } }
```

```json
{ "mcpServers": { "kaddiya": {
  "command": "node",
  "args": ["/path/to/kaddiya-mcp.mjs"],
  "env": { "KADDIYA_MCP_URL": "https://kaddiya.example.com/mcp",
           "KADDIYA_MCP_TOKEN": "kmcp_…" } } } }
```

### Transport: Streamable HTTP on the Express app, plus a served stdio shim

**Streamable HTTP, stateless, JSON responses, on the same process.** The server already terminates TLS, holds the master key, the pool and the per-user gate; a second listener would duplicate all four and put the gate in a different process (breaking D8). Stateless is the spec's model now and the SDK's default posture for legacy clients too: no `Mcp-Session-Id`, no server-held state between POSTs, so a rolling deploy or a second replica needs nothing. JSON rather than SSE because every tool call is one bounded request and no tool emits progress; `responseMode: 'json'` also keeps the shim trivial. Dual-era support is the reason to take the SDK rather than hand-roll five JSON-RPC methods: two protocol eras with different handshakes, header-mirroring validation (`Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version` must match the body or answer `-32020`), `-32022` version negotiation, and `server/discover` are all protocol plumbing with no security content of ours in it. Dependencies: `@modelcontextprotocol/server` (pulls `@modelcontextprotocol/core` and `zod`) and `@modelcontextprotocol/node` (pulls `@hono/node-server`), both pinned to an exact version like `@electric-sql/pglite` is. `@modelcontextprotocol/express` is not used; it adds `cors`, and the mount is four lines.

**A stdio shim, because desktop clients cannot send a header.** Claude Desktop and Claude.ai custom connectors authenticate remote servers with OAuth only; there is no field for a bearer. Claude Desktop does run local stdio servers from `claude_desktop_config.json`. The shim is one zero-dependency file, `apps/console/public/kaddiya-mcp.mjs`, served by the console so a member downloads it from the workspace they already trust: it reads newline-delimited JSON-RPC from stdin, POSTs each message to `KADDIYA_MCP_URL` with the bearer, `Accept: application/json, text/event-stream`, and the mirrored headers (`MCP-Protocol-Version` from `_meta` or the version an `initialize` negotiated, `Mcp-Method`, `Mcp-Name`), writes each JSON response to stdout as one line, drops the body of a 202, aborts the matching fetch on `notifications/cancelled`, logs to stderr only, and exits on stdin EOF. It is a client adapter, not a second server: it never parses tool results and has no opinion about the protocol beyond the three headers. `mcp-remote` from npm does the same job; it is named in the README as an alternative for teams that accept `npx -y`, and not depended on.

### Tool naming for a host with many servers

Tool names do not change. `sn_query` stays `sn_query`: the name is in `READ_TOOLS`, in every audit row's `tool` field, and in the approval kit's tables, and a reviewer who counts read tools by name should count the same names on both surfaces. Namespacing is the host's job and it does it: Claude Code exposes `mcp__kaddiya__sn_query`, other hosts prefix with the server key they were configured under. The server's `serverInfo.name` is `kaddiya`, its `title` is `Kaddiya · <instance host>` so a person with two instances connected can tell them apart, and `instructions` says on whose behalf and how far the tools go. Each tool also gets a `title` (`Query records`, `Record detail`, …) for hosts that list tools to people.

### Concurrency, 429s and parallel hosts

Three layers, top down:

| Layer | Bound | On overflow |
|---|---|---|
| Per token, MCP layer (`mcp.js`) | 60 `tools/call` per rolling minute (`MCP_CALLS_PER_MINUTE`), token bucket in process | `isError: true` result: "Kaddiya allows 60 calls a minute per token; wait and retry." A tool error, not a transport error, so the host's model backs off rather than the host failing. |
| Per token, MCP layer | 8 calls in flight (`MCP_MAX_IN_FLIGHT_PER_TOKEN`) | Same shape of error, immediately, instead of joining `withSlot()`'s unbounded queue |
| Per user per instance, `sn.js` `withSlot()` | 2 in flight, shared with the browser because the key is the same | FIFO wait, unchanged |

Inside a slot, `send()` still honors `Retry-After` up to twice with a 10-second cap, holding the slot while it sleeps: a 429 storm slows that person on both surfaces, which is the documented intent ("we back off; we do not hammer"). A host that aborts a request (closes the response stream) cancels nothing downstream; the instance call completes and is audited. The bounds are per process; a deployment with N replicas has N× them, which is already true of the gate today and is stated in the kit update.

### A member who is no longer `active` mid-session

Every `/mcp` request repeats steps 4 and 5 of the request path; there is no cached principal. A member blocked between two calls: the block marked the row `revoke_on_present`, so the second call revokes the pair at the issuer, deletes the row and answers 401; the host shows an auth error and the person learns why in the console, where `pending.html` already explains their status. A member set back to `pending`: 403 with `membership is not active`, the token survives and works again if they are re-approved. Org suspended or instance `needs_reverification`: 403, token untouched. A tool call already executing when the block lands finishes (it is one instance GET) and is audited.

## New files and changed files

| Path | New or modified | What changes |
|---|---|---|
| `apps/console/server/mcp.js` | new | `MCP_TOOLS` (frozen list of the eleven names), `MCP_DESCRIPTIONS` and `MCP_TITLES` overrides, `listTools()` (derives from `toolDefinitions()`), `callTool()` (allow-list, limits, `executeTool`, result shaping, audit), `resolvePrincipal(req)` (bearer → row → org/instance/member), `handler(cfg)` (Express handler: Origin check, principal, per-request SDK handler). Imports `sessions`, `tenancy`, `audit`, `agent`, `sn`. Never `system(`. |
| `apps/console/server/migrations/008_mcp_tokens.sql` | new | See Data model. |
| `apps/console/public/kaddiya-mcp.mjs` | new | The stdio shim (served static, ~100 lines, no imports beyond `node:`). |
| `apps/console/test/mcp-tokens.test.js` | new | Custody and revocation of `mcp_tokens` (see Test plan). |
| `apps/console/test/mcp.test.js` | new | HTTP-level protocol and gating tests against a booted server; module-level `callTool` tests with a fake `sn`. |
| `apps/console/server/sessions.js` | modified | `createMcpToken()`, `lookupMcpToken()`, `revealMcpToken(id, sid)`, `listMcpTokens(ctx, memberId?)` (this one is `withOrg`), `revokeMcpToken(ctx, id)`; `createOAuthState` takes `meta`; `purgeExpired` also deletes expired tokens and clears stale reveals. Module comment gains the D2/D3 paragraph. |
| `apps/console/server/keys.js` | modified | `mcpTokenKey(bearer)` (HKDF, salt `kaddiya-mcp`, info `mcp-tokens`). |
| `apps/console/server/tenancy.js` | modified | `ORG_PUBLIC_COLUMNS` += `mcp_enabled, mcp_token_ttl_ms`; `INSTANCE_PUBLIC_COLUMNS` += `refresh_token_lifespan_s`; `SETTABLE` += both org keys (`mcp_enabled` boolean like `autonomous_mode`; `mcp_token_ttl_ms` clamped downward to `MCP_TOKEN_CEILING_MS`); `updateOrgSettings` marks all tokens `revoke_on_present` when `mcp_enabled` turns off; `mcpTokenTtlFor(org, requested, instance)`; `setMember` and `disconnectInstance` gain the `mcp_tokens` `UPDATE` beside the `sessions` one; `verifyInstance` stores `refresh_token_lifespan` from the entity read when present. |
| `apps/console/server/sn.js` | modified | `identity.surface` (default `console`) → `X-Kaddiya-Surface` header; `readOAuthEntity` adds `refresh_token_lifespan,access_token_lifespan` to `sysparm_fields`. No new method, no new verb. |
| `apps/console/server/index.js` | modified | `app.post('/mcp', …)` and `app.get('/mcp', 405)` before the body parser; `GET /auth/mcp`; the `purpose === 'mcp'` branch in `/auth/callback`; `GET /api/mcp/tokens`, `POST /api/mcp/tokens/:id/reveal`, `POST /api/mcp/tokens/:id/revoke`; `meFor()` adds `mcp_available`; `GET /api/admin` adds `mcp_tokens`. |
| `apps/console/server/agent.js` | **unchanged** | On purpose: the `MUTATORS` grep and the tool-catalog assertion see identical source. |
| `apps/console/server/actions.js` | **unchanged** | The write surface is unchanged and still countable here. |
| `apps/console/public/app.js` | modified | `showProfile()` gains the **MCP access** section (list, revoke, connect form) and the one-time reveal panel driven by `?mcp=<id>`. |
| `apps/console/public/admin.html`, `admin.js` | modified | Access section: `a-mcp` checkbox "Allow members to connect MCP clients (read-only)" with a section-note, `a-mcp-ttl` select (1/7/30/90 days); a **MCP tokens** table (member, label, prefix, created, last used, expires, Revoke). |
| `apps/console/test/write-paths.test.js` | modified | Three entries in `CONSOLE_LOCAL_ENDPOINTS`; the `MUTATORS` loop also reads `mcp.js`; one new test pinning `MCP_TOOLS` (see Test plan). |
| `apps/console/test/helpers/db.js` | modified | `TABLES` += `mcp_tokens`. |
| `apps/console/test/tenancy.test.js` | modified | The block and disconnect tests also assert `mcp_tokens.revoke_on_present`. |
| `apps/console/package.json` | modified | `@modelcontextprotocol/server` and `@modelcontextprotocol/node`, exact versions. |
| `docs/kit/02-oauth-registry-runbook.md` | modified | Refresh-token-lifespan row: the MCP caveat and the re-verify step. |
| `docs/kit/04-rest-api-access-policy.md` | modified | One paragraph: the MCP surface calls only the GET rows; the write table is unchanged; Option A covers it entirely. |
| `docs/kit/06-traffic-profile.md` | modified | Header table gains `X-Kaddiya-Surface`; "Calls per user question" gains the MCP row (60/min/token, 2 in flight); the "only while a human is watching" sentence is replaced by the D7 wording. |
| `docs/kit/07-service-account-question.md` | modified | Blast-radius row: browser 8 hours; MCP token up to the org ceiling, revocable by the person and by an admin, listed in Admin. |
| `docs/kit/README.md` | modified | Property 4 wording (queries are on screen in the host, not the console, and still audited); the "three endpoints" drift. |
| `apps/console/README.md`, `README.md` | modified | An "Connect an MCP client" section with the three snippets. |
| ADR 0014 | new, wherever 0008–0013 live | The decision record above, in the existing voice. |

## Data model

One migration, number 008. Every column is additive; nothing existing changes shape.

```sql
-- 008_mcp_tokens.sql
-- ADR 0014: read-only MCP access on per-user bearer tokens.
--
-- mcp_tokens is a directory table like sessions (ENABLE, not FORCE): the
-- owner role must resolve a bearer before the org is known, and the app role
-- is confined to its org by the same policy every tenant row carries.
-- D2: token_hash = SHA-256(bearer); tokens_enc is AES-GCM under HKDF(bearer).
-- A dump of this table yields zero usable tokens — test/mcp-tokens.test.js
-- dumps it and checks, as sessions.test.js does for sessions.

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS mcp_enabled      boolean NOT NULL DEFAULT false;  -- D5, default off
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS mcp_token_ttl_ms bigint;                          -- downward only; 90-day ceiling in code

-- Recorded from the registry read at verification when the admin's token can
-- see it; null when unknown. Minting clamps to it (D2) and the reveal says so.
ALTER TABLE instances ADD COLUMN IF NOT EXISTS refresh_token_lifespan_s integer;

-- Purpose-specific state a flow needs on the way back through /auth/callback:
-- for purpose = 'mcp', the label, TTL and member the mint was asked for.
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS meta jsonb;

CREATE TABLE mcp_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         bytea NOT NULL UNIQUE,                      -- SHA-256(bearer), the lookup key
  token_prefix       text NOT NULL,                              -- first 12 chars, for display only
  org_id             uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  instance_id        uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  member_id          uuid NOT NULL,
  sn_user_sys_id     text NOT NULL,
  user_json          jsonb,
  label              text NOT NULL,
  minted_via         text NOT NULL DEFAULT 'console',            -- console | (a later AS, ADR 0014 open question 2)
  tokens_enc         bytea NOT NULL,                             -- the ServiceNow pair, under HKDF(bearer)
  reveal_enc         bytea,                                      -- the bearer, under HKDF(minting session cookie), one showing
  reveal_expires_at  timestamptz,
  revoke_on_present  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  expires_at         timestamptz NOT NULL
);
CREATE INDEX mcp_tokens_org    ON mcp_tokens (org_id);
CREATE INDEX mcp_tokens_member ON mcp_tokens (org_id, member_id);
CREATE INDEX mcp_tokens_expiry ON mcp_tokens (expires_at);
ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_tokens TO kaddiya_app
  USING (org_id = current_setting('app.org_id')::uuid)
  WITH CHECK (org_id = current_setting('app.org_id')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_tokens TO kaddiya_app;
```

Notes for the implementer:

- `db-gates` (a) will find `mcp_tokens` by its `org_id` column and require the policy with both `USING` and `WITH CHECK`; it is there. It is not in the `FORCE` list, deliberately, for the same reason `sessions` is not.
- The two `UPDATE mcp_tokens SET revoke_on_present = true` statements in `tenancy.js` run inside `withOrg`, so they cannot touch another org's rows even without a `WHERE org_id`.
- `TRUNCATE orgs CASCADE` in the test helper reaches `mcp_tokens` through the FK, but the table is added to `TABLES` anyway so the helper reads as a complete list.
- PGlite (local workspaces) runs this migration as it runs 001; nothing here is Postgres-only.

## Tool surface

Schema source for every row is `toolDefinitions()` in `agent.js`: `input_schema` is passed through verbatim as MCP `inputSchema` (the test asserts deep equality), and `description` is passed through unless `MCP_DESCRIPTIONS` overrides it. Every tool gets `annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }` and a `title`.

| Tool | Title | Change for MCP | Instance calls |
|---|---|---|---|
| `sn_query` | Query records | none | `GET /api/now/table/{table}` |
| `sn_schema` | Table schema | none | `GET sys_dictionary`, `GET sys_db_object` |
| `sn_aggregate` | Count records | none | `GET /api/now/stats/{table}` |
| `sn_my_work` | My work queue | none | `whoami`, `sys_user_grmember`, then the table |
| `sn_record` | Record detail | Description drops "Opening a record also displays it in the side panel for the user." and says the result carries a `link`. The wrapper adds `link: <instanceUrl>/<table>.do?sys_id=<sys_id>` to the result; the `focus` emit is a no-op. | `GET …/{table}/{sys_id}` or by number, `GET sys_journal_field` |
| `sn_similar` | Similar resolved records | none | `GET` with `123TEXTQUERY321`, keyword fallback |
| `sn_list_tables` | Find tables | none | `GET sys_db_object` |
| `sn_update_set` | Current update set | Description drops "Call this BEFORE proposing any configuration change" (nothing is proposed here): "…the set new global-scope configuration changes are captured into. Read it before making configuration changes elsewhere so you know where they will land." | `whoami`, `GET sys_user_preference`, `GET sys_update_set/{id}` |
| `sn_update_set_contents` | Update set contents | Description drops "after creating an artifact": "List the captured changes (sys_update_xml entries) inside an update set — the proof of what a set contains." | `GET sys_update_xml` |
| `sn_docs_search` | Search ServiceNow docs | Description drops "and before proposing configuration changes". | `detectRelease` reads `sys_properties` once per host; the search is local (`docs-cache/`) |
| `sn_docs_get` | Read a docs topic | none | local |

Not exposed, and pinned by test:

- the nine `sn_propose_*` tools (the catalog; see Why read-only);
- `sn_note_save`: it writes the console's notebook and lands pending behind a keep/discard card; the note would be invisible and unkept forever.

`instructions` returned by `server/discover` and by the legacy `initialize`: *"Kaddiya is read-only over MCP. Every tool runs on <host> as <user_name>; ServiceNow's own access controls decide what is visible, and nothing here can change the instance. To change a record, propose it in the Kaddiya console, where a person approves it."*

`server/mcp.js`, the parts that matter:

```js
// Read-only MCP surface (ADR 0014 D1). A frozen list, not "everything that is
// not a proposal": a new read tool in agent.js is exposed here only after
// someone adds it, and write-paths.test.js pins this list ⊆ READ_TOOLS.
export const MCP_TOOLS = Object.freeze([
  'sn_query', 'sn_schema', 'sn_aggregate', 'sn_my_work', 'sn_record', 'sn_similar',
  'sn_list_tables', 'sn_update_set', 'sn_update_set_contents', 'sn_docs_search', 'sn_docs_get',
]);

export function listTools() {
  const byName = new Map(toolDefinitions().map((t) => [t.name, t]));
  return MCP_TOOLS.map((name) => {
    const t = byName.get(name);
    return {
      name, title: MCP_TITLES[name],
      description: MCP_DESCRIPTIONS[name] ?? t.description,
      inputSchema: t.input_schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    };
  });
}

export async function callTool(principal, name, args, clientInfo) {
  if (!MCP_TOOLS.includes(name)) throw invalidParams(`Unknown tool: ${name}`);   // JSON-RPC -32602
  const limited = limits.take(principal.tokenHash);                            // D8: 60/min, 8 in flight
  if (limited) return toolError(limited);
  const started = Date.now();
  try {
    let result = await executeTool(principal.sn, name, args, () => {}, { cfg: principal.cfg, user: principal.user, conversationId: null, scope: principal.scope });
    if (name === 'sn_record' && result?.record?.sys_id) result = { ...result, link: `${principal.sn.cfg.instanceUrl}/${args.table}.do?sys_id=${result.record.sys_id}` };
    await auditCall(principal, { tool: name, input: args, ms: Date.now() - started, summary: summarize(name, result), client: clientInfo?.name });
    return shape(result);
  } catch (err) {
    await auditCall(principal, { tool: name, input: args, ms: Date.now() - started, summary: 'error', error: true, client: clientInfo?.name });
    return toolError(String(err?.message || err));
  } finally { limits.release(principal.tokenHash); }
}
```

## Security analysis

| Threat | Mitigation | Residual |
|---|---|---|
| Token read from the client's config file (`~/.claude.json`, `claude_desktop_config.json`), the usual leak | Read-only surface; per-user, per-instance scope; ACLs bound what is readable; absolute TTL with a 1-day option; revocable by the person and by an admin, listed in Admin with last-used time; `kmcp_` prefix for secret scanners; snippets use `${KADDIYA_MCP_TOKEN}` so the file need not hold the value | Until revoked or expired, the attacker reads what that person can read, at machine speed. Document 04 Option B (or A) makes the instance itself refuse anything but GET for this client. |
| Database dump | `tokens_enc` opens only under HKDF(bearer), `reveal_enc` only under HKDF(cookie), `token_hash` is a SHA-256 preimage. `mcp-tokens.test.js` dumps and greps like `sessions.test.js` | None beyond metadata (labels, prefixes, who has tokens). |
| Server memory compromise during the window | Same as sessions: only the tokens of requests in flight are in memory; nothing is cached between requests except the refresh lock | The ServiceNow access token exposed that way is read-write, because the platform issues no read-only scope. Unchanged from today; the kit says so. |
| Long-lived ServiceNow refresh token at the issuer after the row is gone (expiry, or a revoked token never presented again) | Revocation on presentation covers every case where the token is used again; document 02's lifespan setting bounds the rest | A never-presented revoked token leaves a pair alive at the issuer until its own expiry. Same residual sessions have for `revoke_on_present`. |
| DNS rebinding against a local workspace (`127.0.0.1:3000`) | `Origin` validated per the spec (403 when present and foreign); the local bind is loopback already; `/mcp` never reads cookies, so a browser-origin POST is unauthenticated | None known. |
| CSRF | Bearer only; browsers cannot attach it; the cookie CSRF middleware is not on this path and is not needed | None. |
| Tenant confusion | The bearer resolves to one row that names org, instance and member; `OrgContext` is built from the org row *that resolution* returned; every later read is `withOrg`; nothing the client sends names a tenant | None beyond the existing RLS residuals. |
| Wrong identity at mint (a browser signed in as A completes the OAuth consent as B) | `whoami()` on the new pair must equal `session.userSysId`; otherwise the pair is revoked at the issuer and the mint fails | None. |
| Admin reads a member's token | No reveal path for admins; the reveal is sealed under the minting browser's cookie and lasts five minutes | None. An admin can revoke, not use. |
| Prompt injection through instance data steering the host's model into more reads | No write exists to be steered into; per-token rate limit bounds volume; every call is audited with the token label; ACLs bound what is reachable | The encoded-query oracle in kit 06 applies at machine speed on this surface too. The dot-walk depth limit and sensitive-field block list the kit calls "designed, not built" remain that. |
| Parallel host triggers concurrent refreshes | Proactive refresh under a per-token lock when the access token is within 60 s of expiry | Two in-flight 401s (a token revoked server-side mid-burst) still refresh twice; ServiceNow reuses the refresh token, so both succeed and the second re-seal wins. Verified on the PDI in the test plan. |
| Plain HTTP | Same posture as cookies: a local workspace is loopback-only; anywhere else `BASE_URL` is HTTPS and the boot warning already says so. The bearer is never accepted in a URL | A shared host configured with `http://` sends bearers in the clear, as it sends cookies today. |
| Resource exhaustion from a runaway host | 8 in flight and 60/min per token above the 2-per-user gate; `express.json` is not on the path but the SDK caps body size; unknown methods answer `-32601` without touching the database | Per process; N replicas multiply the bounds. |

**What a leaked token yields, in one line:** the eleven read tools, as one person, on one instance, within their ACLs, until revoked. **What it does not:** any instance write, the console, other people's data, other tenants, more tokens.

## Test plan

### Existing tests that must stay green, and why

| Test | Why it stays green | What changes in it |
|---|---|---|
| `write-paths.test.js` · "the agent tool loop cannot reach any instance write" | `agent.js` is byte-for-byte unchanged | The loop also reads `mcp.js`, which contains none of the `MUTATORS` (it calls `executeTool`, not `SnClient` writes). |
| `write-paths.test.js` · "the tool catalog is exactly the read tools plus the action catalog" | `toolDefinitions()` is unchanged | Nothing. |
| `write-paths.test.js` · "the mutating endpoints are exactly the console-local ones plus the catalog" | Every new route is `app.post(` in `index.js`, where the grep sees it | `CONSOLE_LOCAL_ENDPOINTS` gains `POST /mcp`, `POST /api/mcp/tokens/:id/reveal`, `POST /api/mcp/tokens/:id/revoke` under an ADR 0014 comment: the MCP endpoint's every method is a read, its `tools/call` dispatches only through `MCP_TOOLS`; the other two are rows in the workspace database. This is the procedure the file's own header prescribes, and its verdict, that the write surface is the catalog and nothing else, is unchanged. |
| `write-paths.test.js` · new test "the MCP surface is a subset of the read tools" | Imports `MCP_TOOLS` and `listTools()` from `mcp.js`: every name is in `READ_TOOLS`; none starts with `sn_propose_`; `sn_note_save` is absent; each `inputSchema` deep-equals the console tool's `input_schema`; every description is free of `side panel`, `card` and `propos`; every tool has `readOnlyHint: true`. | Added. |
| `db-gates.test.js` (a)–(e) | (a) finds `mcp_tokens` with the policy; (e) still finds `system(` only in the allowed modules because the bearer lookup is in `sessions.js` | Nothing. |
| `sessions.test.js` | Session sealing is untouched; `mcpTokenKey` uses a different salt and info | Nothing. |
| `keys.test.js` | `OrgContext` unchanged | Nothing. |
| `csp.test.js` | New UI in `app.js`/`admin.js`, no inline script or style; the mint navigates with `location.assign` | Nothing. |
| `self-hosted.test.js` | The boot path and the routes it drives are unchanged; migration 008 applies at boot like the others | Nothing. |
| `tenancy.test.js` | `updateOrgSettings` still clamps `session_ttl_ms`; the block test still returns `blocked` | Adds assertions that block and disconnect mark `mcp_tokens`. |
| `stewardship.test.js`, `provider.test.js`, adapters, `runs.test.js`, `notebook.test.js`, `dynamic-*.test.js` | Not on this path | Nothing. |

### New tests

**`test/mcp-tokens.test.js`** (database level, `helpers/db.js` first, `seedOrg`):

1. Mint → lookup round-trips the pair and the principal, and survives a pool restart.
2. A dump of `mcp_tokens` contains neither plaintext token nor the bearer (`reveal_enc` included).
3. Wrong, tampered and unknown bearers resolve to nothing; a 47-character or `kmcp_`-less value is rejected before the database is touched.
4. Expiry is absolute: an expired row is deleted on presentation and by `purgeExpired()`.
5. `revoke_on_present` hands the pair back once, then the row is gone.
6. A refreshed pair is re-sealed under the same bearer.
7. `revealMcpToken(id, sid)` returns the bearer once under the minting cookie, `null` under another cookie, `null` the second time, `null` after five minutes.
8. `setMember(blocked)`, `disconnectInstance()` and `updateOrgSettings({ mcp_enabled: false })` each mark the right rows and no other org's rows (two seeded orgs, as `db-gates` (b) does).
9. `mcpTokenTtlFor()` clamps to the org ceiling, the code ceiling, and a recorded refresh lifespan, in that order of explanation.

**`test/mcp.test.js`** (HTTP level, the `self-hosted.test.js` child-process pattern, instance host `kaddiya-test.invalid` so no network call can succeed):

1. `POST /mcp` without a bearer: 401 with `WWW-Authenticate`; with a foreign `Origin`: 403; with a valid bearer but `mcp_enabled = false`: 403; with a blocked member: 401 and the row is gone afterwards.
2. Modern-era `tools/list` (per-request `_meta`, `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method`) returns exactly `MCP_TOOLS` in that order with `readOnlyHint`; legacy-era `initialize` → `tools/list` returns the same list; `GET /mcp` is 405; `server/discover` lists the supported versions and the instructions name the host.
3. `tools/call` with `sn_propose_reply` (any of the nine) is `-32602`, and no audit row is written.
4. `tools/call sn_query` fails at the instance (unresolvable host), returns `isError: true` naming the host, and writes one `audit_events` row with `action = 'mcp_tool_call'`, the member's `user_name`, the encrypted `tool`, `token_id` and `token_label`.
5. Ten parallel `tools/call`s against one token: at most 8 reach `executeTool` at once, the rest get the rate-limit tool error; the 61st call in a minute gets it too.
6. A revoked token's next call answers 401 and the row is deleted.
7. Mint flow end to end with a stubbed `oauth_token.do`: `GET /auth/mcp` without `mcp_enabled` is 403; the callback with a `whoami` that differs from the session user fails and revokes; the happy path lands on `/?mcp=<id>`; reveal works once; the audit row `mcp_token_mint` has `approved_by_user: true`.

**Module level** (`callTool` with a fake `sn` like `fakeSn`): result shaping, `sn_record` gains `link`, truncation at `MCP_MAX_RESULT_CHARS` drops `structuredContent`, thrown errors become `isError`.

**On the PDI, before this reaches main** (the ADR 0010 D3 discipline: the list is what we claim, so it holds only what we have done):

- Two authorization-code grants for one user and one client yield two independent pairs; revoking one at `oauth_revoke_token.do` leaves the other working.
- Two parallel refreshes with the same refresh token both succeed (refresh-token reuse), and the old access token is not invalidated by a refresh.
- `X-Kaddiya-Surface: mcp` is visible on `syslog_transaction` rows for the calls, alongside the three existing headers.
- With *Refresh token lifespan* at 28,800 s, a token minted with 30 days requested shows `clamped_by: 'refresh_token_lifespan'` and expires in 8 hours; after raising the lifespan and re-verifying, the same request yields 30 days.
- Claude Code (HTTP with header) and Claude Desktop (stdio shim) both list eleven tools and run `sn_my_work`.

## Risks and open questions

1. **The kit-recommended 8-hour refresh lifespan.** Decided above (clamp and document), but it is the customer-visible cost of the feature: an org that wants 30-day MCP tokens keeps a 30-day refresh token on the instance for this client, which document 02 currently calls a risk-register item. Product should confirm the clamp-and-explain approach rather than, say, a separate application registry record for MCP with its own lifespan (cleaner on the instance, one more thing for the admin to create and one more `instances` row shape for us).
2. **Hosts that only do OAuth** (Claude.ai and Claude Desktop custom connectors) get the shim, not a native connection. If that gap matters commercially, option (b) is the follow-up ADR; the row shape already has `minted_via`.
3. **The SDK is a 2.0.0.** Pinned exactly; the surface used is `createMcpHandler` (`responseMode`, `legacy`), `toNodeHandler`, and `Server.setRequestHandler` for two methods. Confirm at build time how `toNodeHandler` exposes the raw request when the mount runs before `express.json()`, and that the `legacy: 'stateless'` posture serves 2025-03-26 clients as well as 2025-06-18. If the package proves unstable, the fallback is a hand-rolled handler for `server/discover`, `initialize`, `notifications/initialized`, `tools/list`, `tools/call` and `ping`, which is a bounded rewrite of one module.
4. **ADR 0009 D3 and the kit's "only while a human is watching."** D7 rewrites it. This is a claim customers have read; the diff to 06 and 07 should be reviewed by whoever owns the kit, not just merged.
5. **Per-process limits on multi-replica deployments.** The rate limit and the in-flight bounds, like the existing gate, are per process. Stated in the kit; a shared limiter is not in scope.
6. **Read-surface allow list** (ADR 0008 D14/D17, "designed, not built"). When it ships it applies to MCP automatically, because MCP goes through `executeTool` → `SnClient`; the spec makes no separate provision.
7. **Local workspaces** bind `127.0.0.1` and use `http://localhost:3000`; the bearer travels over loopback in the clear, which is fine and should be said in the README so nobody "fixes" it with a tunnel.
8. **Drift found in passing:** `db-gates` allow-lists `site-chat.js`, which is not in `server/`; `docs/kit/README.md` says "three" write endpoints. Fix in the same PR or a separate one, but fix.
9. **Instance choice.** A member with several verified instances mints against the instance their current session is signed into; one token per instance. The profile panel says which instance the token is for.
10. **Refresh-lifespan recording depends on re-verification.** An admin who raises the lifespan later must re-verify for the clamp to lift; the Admin MCP section shows the recorded value and says so.

## Out of scope

- The nine `sn_propose_*` tools and every catalog entry; any MCP-side approval or elicitation flow standing in for the card.
- `sn_note_save` over MCP.
- Kaddiya as an OAuth 2.1 authorization or resource server (option b); RFC 9728 metadata; Client ID Metadata Documents; dynamic client registration.
- Admin-minted tokens, service tokens, or a per-workspace token.
- Resources, prompts, `subscriptions/listen`, progress notifications, SSE responses.
- A SIEM push of MCP audit rows (the kit's "tokened pull endpoint comes first" still stands).
- A shared, cross-replica rate limiter.
- Publishing the stdio shim to npm; supporting `mcp-remote` beyond naming it.
- The read-surface allow list, dot-walk depth limit and sensitive-field block list from kit 06.
