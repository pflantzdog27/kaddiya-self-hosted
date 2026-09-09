# 02 · OAuth registry runbook

**Role required:** `oauth_admin`, `mi_admin` or `admin`.
**Time:** about ten minutes, plus one test sign-in.
**Result:** one `oauth_entity` record. Nothing else is created on the instance.

Do this on a **sub-production instance first**, verify a sign-in, then repeat as a separate
change on production. Each instance needs its own record — client IDs are per instance, and a
production secret must never be reused in dev.

## 1 · Create the record

**Australia and later:** **Machine Identity Console → Inbound integrations → New integration
→ OAuth - Authorization code grant.**
**Classic navigation:** **All → System OAuth → Application Registry → New → Create an OAuth
API endpoint for external clients.**

| Field | Value | Why |
|---|---|---|
| **Name of OAuth entity** | `Kaddiya` | What appears on the consent screen your users see. Keep it recognizable — document 08 depends on users knowing what a real Kaddiya sign-in looks like. |
| **Provider name** | `Kaddiya` | Mandatory field on this form. |
| **Redirect URL** | `https://<your-kaddiya-host>/auth/callback` | **One exact URL.** No wildcard, no second entry "just in case", no `http://` outside a local developer machine. This is the field that decides where an authorization code can be delivered. |
| **Client ID** | *(generated — record it)* | Goes into the Kaddiya configuration. Not a secret, but not worth publishing. |
| **Client Secret** | *(generate — record it)* | **Treat as a production credential.** Hand it over through your approved secret-sharing channel. Never in an email, a ticket comment, or a screenshot. |
| **This is a public client** | **unchecked** | Kaddiya is a confidential client. This matters beyond hygiene: ServiceNow issues a **refresh token only to a private client**, and without one every user would be bounced back to the login page every 30 minutes. |
| **Active** | checked | Unchecking this is your kill switch (step 5). |
| **Comments** | `Kaddiya — external user-delegated REST client. CR: <number>. Owner: <team>.` | The next admin who finds this record should not have to ask what it is. |

### Advanced options

| Field | Recommended | Why |
|---|---|---|
| **Access token lifespan** | `1800` (the default, 30 min) | Short-lived by design. Kaddiya honors the `expires_in` the token endpoint returns rather than assuming a value, so lowering this is safe. |
| **Refresh token lifespan** | `28800` (8 hours) — **not the 8,640,000-second default** | The default is 100 days. Kaddiya never keeps a token past the user's session and enforces an absolute 8-hour session ceiling, so an 8-hour refresh lifespan matches the product's real behavior and removes a 100-day credential from your risk register. Raise it only if your session policy is longer. |
| **Token Format** | `Opaque` (default) or `JWT` | Kaddiya treats the token as opaque either way. |
| **Enforce token restriction** | See [document 04](04-rest-api-access-policy.md) | Leave **unchecked** for the first sign-in. Turn it on only together with the API access policies in document 04 — on its own it will lock the client out of everything. |
| **Logo URL** | optional | Shown on the consent screen. Helps users recognize a genuine prompt. |

## 2 · PKCE

Kaddiya sends `code_challenge` with `code_challenge_method=S256` on every authorization
request, and the matching `code_verifier` on the token exchange (RFC 7636). This is not
optional in our client and there is no setting to disable it.

There is nothing to enable on the `oauth_entity` record for this — PKCE parameters travel on
the request. What your reviewer should take from it: an authorization code intercepted in
transit is useless without the verifier, which never leaves our server.

Related instance property, worth confirming rather than changing:
`glide.oauth.state.parameter.required` should be `true`. New instances default to true;
instances upgraded from older releases may be set to `optional`. Kaddiya always sends
`state`, and binds it server-side to the specific browser that started the sign-in, so a
callback URL that is pasted or emailed to someone else cannot complete.

## 3 · Verify the flow

1. Give the requester the **instance URL**, **Client ID** and **Client Secret**.
2. They sign in once at the Kaddiya URL.
3. Confirm the redirect lands on **your** login page (or your IdP), not on anything hosted by
   Kaddiya. Users authenticate on your instance, always — see document 08.
4. After consent, they should see their own name, roles and groups in Kaddiya's profile
   panel, read from `sys_user_has_role` and `sys_user_grmember`.
5. In your instance: **All → System Logs → Transactions** and filter for user agent
   `Kaddiya/`. You should see the calls attributed to that human user.

If the sign-in fails, the two failures worth telling apart:

- **`invalid_client`** — the client ID or secret does not match this instance's record. After
  a clone of production over a sub-production instance, this is the expected symptom; see
  [document 03](03-clone-preserver.md).
- **`invalid_grant`** — the user's authorization was revoked, or the account is deactivated or
  locked. This is your instance correctly refusing. In this release the user sees the error and
  signs in again; distinguishing the two cases into a tailored re-authentication prompt is a
  scheduled improvement, not shipped behavior.

## 4 · Rotating the secret

`oauth_entity` has no dual-secret overlap: there is exactly one secret, and changing it
invalidates the old one immediately. So rotation is a short, staged, *coordinated* cutover,
not a background task:

1. Schedule a brief window. Signed-in users keep working until their current access token
   expires (up to your access-token lifespan); new sign-ins fail during the gap.
2. Enter the new secret in Kaddiya's configuration first.
3. Generate the new secret on the instance record.
4. Complete one sign-in to confirm.

Rotate on your normal credential schedule, and immediately if the secret was ever handled
outside your approved channel.

## 5 · Turning it off

Set **Active** to false on this record, or delete it. Every Kaddiya call to this instance
fails from that moment, and every token already issued becomes unusable. You do not need to
contact us, and there is nothing else on the instance to clean up.

To revoke a single user rather than everyone: deactivate or revoke that user's tokens the way
you would for any OAuth client (**System OAuth → Manage Tokens**), or deactivate the
`sys_user` record.

On our side, signing out discards the session and the tokens it held; the tokens are never
written to disk and the browser never sees them. Calling your instance's
`oauth_revoke_token.do` at sign-out — so that a token copied *before* sign-out also dies — is
designed and scheduled, but is **not in this release**. Your registry record remains the
authoritative kill switch in the meantime.

---

**Sources (Australia release):**
[Configure an OAuth authorization code grant](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-security/authentication/configure-an-oauth-authorization-code-grant.md)
·
[Authorization code grant workflow](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-security/authentication/authorization-workflow.md)
(PKCE parameters, `glide.oauth.state.parameter.required`, and "a refresh token, if it's a
private client").
Decision record: ADR 0008 D2, D8, D14.
