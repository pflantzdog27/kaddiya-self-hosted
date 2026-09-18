# 04 · REST API access policy — enforcing the write limits at your own edge

**Role required:** `api_service_admin` or `adaptive_auth_policy_admin`, plus `oauth_admin` for
the last step.
**Optional.** Kaddiya's write limits hold without it. This document is for reviewers who
want the limit enforced by *your* platform rather than by our promise.
**Test in a sub-production instance first.** Misconfigured here, this locks the client out of
everything.

## Why this document exists

The OAuth access token ServiceNow issues is **read-write**. There is no read-only
authorization-code scope in the platform, so no OAuth client can honestly tell you its token
*cannot* write. What we can tell you is what our build does — and what you can make your
instance enforce regardless.

## Exactly what Kaddiya calls

Give this list to whoever writes the policies. It is the complete set; anything outside it is
a bug on our side and should be refused on yours.

### Reads (any table the signed-in user's ACLs permit)

| API | Method | Notes |
|---|---|---|
| `/api/now/table/{table}` | GET | `sysparm_fields` and `sysparm_limit` always set |
| `/api/now/table/{table}/{sys_id}` | GET | single record |
| `/api/now/stats/{table}` | GET | Aggregate API, for counts |

Kaddiya does not call the Attachment API in this release. If your policy set is
deny-by-default, there is nothing to allow for it.

**MCP clients call these rows and no others.** When a member connects an MCP client
(document 06, "MCP clients"), it reaches your instance through the same twelve read tools the
console agent uses, so it produces exactly the GET traffic in the table above — plus the
`sys_user`, `sys_user_grmember`, `sys_dictionary`, `sys_db_object`, `sys_journal_field`,
`sys_update_xml`, `sys_update_set`, `sys_user_preference` and `sys_properties` reads those
tools already make on the console surface. **The write table below is unchanged**: no
proposal tool, and therefore no write path of any kind, is reachable from an MCP client.
Option A below covers that surface completely, and is worth considering on its own merits if
MCP is the only thing you are enabling.

### Writes — the catalog, and nothing else

Normal mode requires a click on a card displaying the exact payload. Authorized task modes
use the same commit validation and user token. Security-sensitive dynamic cards always require
a typed manual approval.

| # | API | Method | Tables | Triggered by |
|---|---|---|---|---|
| 1 | `/api/now/table/{table}/{sys_id}` | PATCH | the record being worked on; body contains **only** `comments` or `work_notes` | **Send** on a draft reply |
| 2 | `/api/now/table/{table}` | POST | `sys_script`, `sys_script_include`, `sys_script_client`, `sys_ui_policy`, `sp_widget`, `sp_page`, `sp_container`, `sp_row`, `sp_column`, `sp_instance` | **Create** on a proposed change |
| 3 | `/api/now/table/sys_update_set` | POST | `sys_update_set` | **Create** on a proposed update set |
| 3a | `/api/now/table/sys_user_preference` | POST / PATCH | `sys_user_preference` (`sys_update_set` and `apps.current_app` only) | same click as 3 — it is what makes the new set current |
| 4 | `/api/now/table/{table}/{sys_id}` | PATCH | `incident`, `problem`, `sc_request`, `sc_req_item`, `sc_task`, `change_task`, `sn_hr_core_case`; body contains **only** `state`, `assignment_group`, `assigned_to`, `priority`, `impact`, `urgency`, `hold_reason`, `close_code`, `close_notes` | **Apply** on a proposed update |
| 5 | `/api/now/table/sysapproval_approver/{sys_id}` | PATCH | `sysapproval_approver`; body contains **only** `state` and `comments` | **Approve** / **Reject** on a proposed decision |
| 6 | `/api/now/table/{table}/{sys_id}` | PATCH | `sys_script`, `sys_script_include`, `sys_script_client`, `sys_ui_policy`, `sp_widget`, `sp_page`, `sp_container`, `sp_row`, `sp_column`, `sp_instance` | **Apply** on a proposed change to an existing record |
| 7 | `/api/sn_sc/servicecatalog/items/{sys_id}/order_now` | POST | Service Catalog API; creates `sc_request` / `sc_req_item` as the signed-in user, quantity 1 | **Order** on a proposed order |
| 8 | `/api/sn_chg_rest/change/normal`, `…/change/emergency`, `…/change/standard/{template}` | POST | Change Management API; creates one `change_request` | **Create** on a proposed change request |
| 9 | `/api/now/table/{table}[/{sys_id}]` | POST / PATCH | Existing tables and inherited fields verified from live `sys_db_object` and `sys_dictionary`; includes `sc_cat_item`, `item_option_new`, and custom tables. Security-sensitive and unknown system tables require tier 3. No deletes or arbitrary REST paths. | **Create** / **Apply** on a dynamic record card (`POST /api/dynamic/apply`) |

> **3a is easy to miss and will break the feature if you omit it.** Selecting a user's current
> update set *is* a `sys_user_preference` write; ServiceNow has no other mechanism for it.

**The limitation you should know about before you rely on this:** a REST API access policy
works at API / path / method / version / resource / **table** granularity. It cannot express
"PATCH, but only the `comments` field". The restriction to journal fields is enforced in our
endpoint (which rejects any other field name) and by your ACLs — not by the policy. If your
control requirement is field-level, the honest answer is ACLs, not this policy.

Dynamic cards require tier 2 and readable table metadata. Dedicated workflow paths remain
required for change requests, approval records, update sets/preferences, and catalog request
creation. Dynamic cards cannot write system-managed fields or secrets. Update cards re-read
reviewed fields immediately before writing and reject a changed value; this is a preflight
check, not an atomic database compare-and-swap. Table discovery does not prove write access:
ServiceNow ACLs and business rules still decide whether the actual write succeeds.

## Option A — the read-only variant (strictest)

Choose this if you want an evaluation with no write path at all — for a proof of value where
nobody needs to send a reply or create a change yet.

Allow GET on the Table and Aggregate APIs. Deny every other method for this client. Drafts and
proposals still render — the human's click simply fails with a 403 from your instance, which
is the platform refusing, exactly as intended.

This option also makes the MCP surface's read-only guarantee yours rather than ours: Kaddiya
exposes no write over MCP, and under Option A your instance would refuse one even if it did.

## Option B — GET plus the catalog's write paths (recommended)

This is the configuration that leaves Kaddiya fully functional while making the limit yours.

1. **Create the policies.** **All → System Web Services → REST API Access Policies → New.**
   Create one policy per row below, mapping your OAuth inbound authentication profile to each:

   | REST API | Method | Table | Apply to all tables |
   |---|---|---|---|
   | Table API | GET | — | yes |
   | Aggregate API | GET | — | yes |
   | Table API | PATCH | the task tables your team works — `incident`, `problem`, `sc_request`, `sc_req_item`, `sc_task`, `change_task`, `sn_hr_core_case` — and `sysapproval_approver` | no |
   | Table API | POST, PATCH | `sys_script`, `sys_script_include`, `sys_script_client`, `sys_ui_policy`, `sp_widget`, `sp_page`, `sp_container`, `sp_row`, `sp_column`, `sp_instance` | no |
   | Service Catalog API | POST | — (`order_now`) | yes |
   | Change Management API | POST | — (`change/normal`, `change/emergency`, `change/standard`) | yes |
   | Table API | POST | `sys_update_set` | no |
   | Table API | POST, PATCH | `sys_user_preference` | no |

   Note from the platform docs: a **non-global** policy always overrides a global one, and
   method + resource + version is the highest-priority match. Write the specific policies you
   want honored and let the global blocking policy catch the rest.

2. **Scope it to Kaddiya and nothing else.** On the `Kaddiya` Application Registry record
   (document 02), tick **Enforce token restriction**. Per the platform documentation this
   "limits the client to accessing only the APIs specified in the REST API Access Policies" —
   with it off, the client can reach other REST APIs subject only to user ACLs.

   This is the step that makes the policy *about Kaddiya* rather than about every OAuth
   client on your instance. Do not skip it, and do not enable it before the policies exist.

3. **Optionally, narrow further with a REST API Auth Scope.** Create an auth scope, link it to
   the APIs you want protected, then link that scope to the Kaddiya OAuth entity. Two
   cautions from the docs: until an auth scope record exists, a REST API is reachable by any
   valid OAuth entity; and the special `useraccount` scope defeats the restriction — an entity
   holding it can reach any API regardless.

4. **Verify.** Sign in, run a query (expect success), then have a user press **Send** on a
   draft (expect success) and confirm the write appears in the record's audit history against
   that person. Then temporarily remove one write policy and confirm the click now fails with
   a 403.

## What you should expect to see afterwards

Nothing about the user experience changes while the policies match the list above. If a policy
is too tight, the failure is visible and honest: the card shows `failed · ServiceNow 403 …`
and the user is told the platform refused. Kaddiya does not retry, work around it, or fall
back to another path.

---

**Sources (Australia release):**
[REST API access policies](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-security/authentication/inbound-authentication-profile.md)
·
[Create REST API access policy](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-security/authentication/create-api-access-policy.md)
(the REST API / Method / Table / Version / Resource fields)
·
[API access policy prioritization](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-security/authentication/api-access-policy-prioritization.md)
·
[Configure an OAuth authorization code grant](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-security/authentication/configure-an-oauth-authorization-code-grant.md)
(**Enforce token restriction**)
·
[REST API Auth Scope](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-security/authentication/rest-api-auth-scope.md).
Decision record: ADR 0008 D12; ADR 0009 D2.
