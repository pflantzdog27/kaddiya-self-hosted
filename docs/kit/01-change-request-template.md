# 01 · Change request template

Copy the block below into your change request. It is written for a CAB that has never heard of
Kaddiya and will not read a website. Fill the four bracketed values; everything else is
fixed.

The technical steps are in [02 · OAuth registry runbook](02-oauth-registry-runbook.md). Attach
that document and [06 · Traffic profile](06-traffic-profile.md) to the CR.

---

## Copy from here

**Title:** Create OAuth Application Registry record for Kaddiya (user-delegated REST client)

**Type:** Standard / Normal (per your OAuth client policy)
**Risk:** Low
**Category:** Software → Integration / Authentication
**Assignment group:** [ServiceNow Platform team]
**Requested by:** [name, role]
**Target instance(s):** [instance URL — do dev/test first, prod as a separate CR]

### Description

Create one **Application Registry** record (`oauth_entity`) so an external web application,
Kaddiya, can authenticate users through this instance using the OAuth 2.0 authorization-code
grant with PKCE.

Kaddiya is a read-and-propose assistant for ServiceNow. Staff sign in **with their own
ServiceNow credentials** through this instance's normal login (including SSO and MFA, since
the instance fronts the IdP). Kaddiya then calls the Table and Aggregate REST APIs **as
that signed-in user**. It contains no authorization logic of its own: this
instance's ACLs, roles and user criteria decide what each person can see.

### What is being installed on the instance

Nothing except the registry record itself. No scoped application, no update set, no business
rule, no MID Server, no integration/service account, no stored script. If the record is
deactivated, all Kaddiya access stops immediately.

### Scope of what the client can do

- **Reads:** whatever the signed-in user's own ACLs already permit — no more.
- **Writes:** Kaddiya's agent cannot write. It renders proposals; a human presses a button
  to commit one record at a time, on the approving user's own token, recorded in this
  instance's audit tables against that person. The complete list — our endpoint, the instance
  API it calls, and the tables it may touch — is the write table in the attached document 04,
  which is generated from the build's own catalog and checked by a test.
- Any of these writes can be blocked at this instance's edge with a REST API access
  policy (see the attached document 04), independently of anything the vendor does.

### Implementation steps

1. Navigate to **All → System OAuth → Application Registry**.
2. **New → Create an OAuth API endpoint for external clients.**
3. Set the fields per the attached runbook (document 02). Specifically:
   - **Name:** `Kaddiya`
   - **Redirect URL:** `[https://<your-kaddiya-host>/auth/callback]` — one exact URL, no
     wildcard, no trailing variations.
   - **Public Client:** **false** (a confidential client; the refresh token this grants is
     what keeps a session alive for its working day).
   - **Refresh Token Lifespan / Access Token Lifespan:** per the runbook's recommendations.
4. Record the **Client ID** and **Client Secret**. Send the secret to the requester through
   your approved secret-sharing channel — never by email or ticket comment.
5. If this instance is a **clone target**, complete the clone-preserver step in document 03 —
   on the clone **source**, which is normally production.
6. Requester completes one sign-in to verify the flow end to end.

### Validation

- The requester signs in at the Kaddiya URL and is redirected to this instance's own login
  page (or IdP).
- After consent, they land in Kaddiya and see their own name, roles and groups.
- A test query returns only records that user can already see in a list view.
- `syslog_transaction` shows the calls attributed to that user with user agent
  `Kaddiya/<version>`.

### Backout

Deactivate the Application Registry record (set **Active** to false), or delete it. All
Kaddiya access to this instance stops on the next call, and every stored token becomes
unusable. No other instance object is touched, so there is nothing else to reverse.

### Security notes for the reviewer

- Authentication is delegated entirely to this instance and therefore to our existing IdP, SSO
  and MFA. Kaddiya never sees, collects or stores a ServiceNow password.
- PKCE (S256) is used on the authorization-code exchange, and the client is confidential.
- Access is bounded by the user's own permissions; joiner/leaver lifecycle is our existing
  ServiceNow lifecycle, not a second user directory.
- Sessions expire on an absolute 8-hour ceiling; tokens are never held beyond a session.
- This instance's kill switch is the record created by this change: deactivate it and access
  ends, without involving the vendor.

## Copy to here
