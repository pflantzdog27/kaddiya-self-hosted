# ci-integration

Tags: ci, cd, integration, install, build, deploy, headless, automation, frozenKeys, frozen-keys, keys.ts, auth, basic, oauth, client-credentials, SN_SDK_NODE_ENV, SN_SDK_AUTH_TYPE, SN_SDK_INSTANCE_URL, SN_SDK_USER, SN_SDK_USER_PWD, SN_SDK_OAUTH_CLIENT_ID, SN_SDK_OAUTH_CLIENT_SECRET

CI Integration

Guide for running the Now SDK in CI/CD pipelines: non-interactive authentication for now-sdk install, validating that keys.ts is committed via now-sdk build --frozenKeys, and the conventions that keep pipeline runs reproducible.


When to Use

• CI/CD pipelines (GitHub Actions, GitLab CI, Jenkins, etc.) building or installing a Fluent app.
• Container builds, scheduled jobs, or scripted environments where interactive prompts aren't possible.
• Pre-merge checks that need to fail fast when developers forget to commit generated artifacts.

---


Builds: `--frozenKeys`

now-sdk build regenerates src/fluent/generated/keys.ts (the registry mapping Now.ID['...'] identifiers to ServiceNow sys_ids) every time it runs. When a developer adds new Fluent records, the build appends a new entry to src/fluent/generated/keys.ts. That generated file must be committed to source control along with the Fluent code that introduced the identifier — see the keys.ts guide.

--frozenKeys is the CI-side enforcement of that rule.  This will ensure that keys was not modified by the build, and if any change a build error will occur.

Usage

```bash
now-sdk build --frozenKeys
```

After building, the CLI compares keys.ts content before and after. If anything changed during the build, it fails with:

```
Keys file is out-of-date. To update it, run the build again without frozen keys.
```

This means a developer pushed Fluent code that introduces a new or modified identifier (or modifies a coalesce key) without checking in the updated keys.ts.

Why this matters

keys.ts is the source of truth for record identity. If a pipeline builds without it being committed:

• Deploys produce different sys_ids on every machine. The same Now.ID['my-rule'] resolves to a freshly-generated sys_id on each developer/CI machine, so the same logical record ends up with different IDs across environments.
• Updates become inserts. ServiceNow uses sys_id for record identity. A mismatch means the install creates a duplicate record instead of updating the existing one — corrupting the target instance.
• Subsequent merges hide the problem. Once a stale keys.ts lands in main, every later branch picks up the wrong IDs.

Running --frozenKeys in CI catches this before merge. It's the same build the developer should have run locally, with a guard that errors instead of silently rewriting the file.

Recommended placement in the pipeline

Run now-sdk build --frozenKeys as a pre-merge / pull-request check, before the install step:

```yaml
# GitHub Actions example
- name: Verify keys.ts is up to date
  run: now-sdk build --frozenKeys
```

If the keys check fails, the developer's fix is simple: run now-sdk build locally, commit the updated keys.ts, and push.

---


Authentication for `now-sdk install`

Non-interactive authentication for now-sdk install. The CLI reads credentials from environment variables instead of the local keychain, so it works in CI/CD pipelines and other headless environments. Two auth types are supported: basic (username + password) and oauth (OAuth 2.0 client_credentials grant).

When to Run `now-sdk install` from CI

Use this for a main-branch pipeline that deploys changes to the next-stage instance (typically a shared test / integration / dev instance). The pipeline installs the just-built app to that instance so QA, integration tests, and downstream environments can pick up the latest changes automatically after merge.

Do not use now-sdk install from CI to deploy to production instances. Production deploys should go through ServiceNow's standard application promotion mechanisms — the App Repo, or guided application install/upgrade — so that change management, approvals, and rollback work the way the platform expects.

Enabling CI Mode

CI mode is gated by a single env var:

```bash
export SN_SDK_NODE_ENV=SN_SDK_CI_INSTALL
```

When set, the CLI reads credentials from env vars instead of the keychain. Choose the auth type with SN_SDK_AUTH_TYPE:

| SN_SDK_AUTH_TYPE | Behavior |
|---|---|
| unset or basic | Use SN_SDK_USER + SN_SDK_USER_PWD (basic auth). Default for backward compatibility. |
| oauth | Use SN_SDK_OAUTH_CLIENT_ID + SN_SDK_OAUTH_CLIENT_SECRET (OAuth client_credentials). |

Any other value is rejected with an error before any network call.

Basic Auth

Simplest setup — username and password of an instance user.

#### Environment Variables

| Variable | Required | Value |
|---|---|---|
| SN_SDK_NODE_ENV | yes | SN_SDK_CI_INSTALL |
| SN_SDK_AUTH_TYPE | no | basic (or unset) |
| SN_SDK_INSTANCE_URL | yes | Full instance URL, e.g. https://your-instance.service-now.com |
| SN_SDK_USER | yes | Username |
| SN_SDK_USER_PWD | yes | Password |

#### Example

```bash
export SN_SDK_NODE_ENV=SN_SDK_CI_INSTALL
export SN_SDK_AUTH_TYPE=basic
export SN_SDK_INSTANCE_URL=https://your-instance.service-now.com
export SN_SDK_USER=ci-user
export SN_SDK_USER_PWD=...

now-sdk install
```

#### When to Choose Basic

• PDIs, sandbox instances, fast iteration where OAuth setup overhead isn't worth it.
• Existing pipelines already wired for username/password.

Avoid for production CI: every run sends the password to the instance, and rotating it means rotating in every pipeline secret store.

OAuth Client Credentials

Token-based, no user password ever leaves your secret store. The CLI fetches a fresh access token at the start of each run.

#### Environment Variables

| Variable | Required | Value |
|---|---|---|
| SN_SDK_NODE_ENV | yes | SN_SDK_CI_INSTALL |
| SN_SDK_AUTH_TYPE | yes | oauth |
| SN_SDK_INSTANCE_URL | yes | Full instance URL |
| SN_SDK_OAUTH_CLIENT_ID | yes | OAuth Application Registry client_id |
| SN_SDK_OAUTH_CLIENT_SECRET | yes | OAuth Application Registry client_secret |

#### Example

```bash
export SN_SDK_NODE_ENV=SN_SDK_CI_INSTALL
export SN_SDK_AUTH_TYPE=oauth
export SN_SDK_INSTANCE_URL=https://your-instance.service-now.com
export SN_SDK_OAUTH_CLIENT_ID=...
export SN_SDK_OAUTH_CLIENT_SECRET=...

now-sdk install
```

The CLI calls ${SN_SDK_INSTANCE_URL}/oauth_token.do once at startup with grant_type=client_credentials, then uses the returned access token for all subsequent requests. There is no refresh token in this grant — each invocation fetches a fresh token.

#### ServiceNow Instance Configuration

OAuth requires one-time setup on the instance. Complete all four steps or the token endpoint will reject the request.

##### 1. Create or open the OAuth Application Registry

System OAuth → Application Registry → New → Create an OAuth API endpoint for external clients. Do not use OIDC providers — they don't issue tokens for this grant.
• Set "Public Client" to false
• Set "OAuth Application User" to a sys_user in step 3

Note the Client ID and Client Secret — these become SN_SDK_OAUTH_CLIENT_ID and SN_SDK_OAUTH_CLIENT_SECRET.

##### 2. Enable the client_credentials grant

Two things must be in place:

• On the Application Registry record, Grant type must include Client Credentials.
• System property glide.oauth.inbound.client.credential.grant_type.enabled must exist and be set to true. If the property does not already exist on the instance, create it in sys_properties with:
  • Name: glide.oauth.inbound.client.credential.grant_type.enabled
  • Type: true | false
  • Value: true

  See ServiceNow KB1645212 for details: <https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB1645212>

Without the system property set to true, the token endpoint will reject grant_type=client_credentials regardless of how the OAuth app is configured.

##### 3. Configure the Service User

The user mapped in step 1 must:

• Have roles sufficient to install your app — typically admin.
• Have Identity Type = Human on the sys_user record. The SDK's OAuth flow performs a CSRF dance against /angular.do?sysparm_type=get_user to obtain a UI session token; AngularProcessor blocks machine identities with User <name> is not allowed to access com.glide.ui.ng.AngularProcessor, even when the user has admin.

#### When to Choose OAuth

• Production CI/CD where credential rotation, audit, and least-privilege matter.
• Multi-pipeline environments where a single shared service account beats one password per pipeline.
• Compliance regimes that prohibit storing user passwords in CI secret stores.

Choosing an Auth Type

| | Basic | OAuth Client Credentials |
|---|---|---|
| Setup effort | None — uses existing user | One-time OAuth app + entity profile + service user setup |
| Credential rotation | Rotate user password | Rotate client secret (no password change) |
| Audit trail | User attribution | Service-account attribution (via mapped Default User) |
| Network surface | Password sent on every request | Password never sent; token fetched once per run |
| Best for | PDIs, sandbox, fast iteration | Production CI, regulated environments |

---


Troubleshooting

| Symptom | Likely Cause |
|---|---|
| Keys file is out-of-date. To update it, run the build again without frozen keys. | Developer added or changed an identifier without committing the regenerated keys.ts. Run now-sdk build locally, commit the file, push. |
| Unsupported value for SN_SDK_AUTH_TYPE | Typo. Must be exactly basic or oauth. |
| CI basic auth is missing required environment variables: ... | One of SN_SDK_INSTANCE_URL / SN_SDK_USER / SN_SDK_USER_PWD is unset. |
| CI OAuth client_credentials is missing required environment variables: ... | One of SN_SDK_INSTANCE_URL / SN_SDK_OAUTH_CLIENT_ID / SN_SDK_OAUTH_CLIENT_SECRET is unset. |
| 401 {"error":"server_error","error_description":"access_denied"} from /oauth_token.do | Missing Entity Profile + Default User on the OAuth app, client_credentials grant not enabled, or glide.oauth.inbound.client.credential.grant_type.enabled not set to true. |
| User <name> is not allowed to access com.glide.ui.ng.AngularProcessor after token is issued | Mapped service user has Identity Type = Machine. Change to Human on the sys_user record. |
| 401 invalid_client | Client ID or secret typo. Re-copy from the Application Registry record. |
| 401 Unauthorized on basic auth | Username/password incorrect, or the user lacks roles for the operation. |

Check System Logs → All filtered to Source = OAuth (for OAuth) or Source = Transaction (for basic) for the precise platform-side error — response bodies are deliberately vague but the logs name the actual cause.


Security Notes

• Never commit credentials to source control. Use your CI provider's secret store (GitHub Actions secrets, GitLab CI variables, Jenkins Credentials, etc.).
• Use a dedicated service user rather than reusing a person's account — auditing, rotation, and role narrowing are all easier.
• For OAuth, rotate the client secret regularly. The client_credentials grant has no refresh token, so each CLI run fetches a fresh access token from the secret.
• For basic, rotate the password regularly and prefer a service account with the minimum roles required for the operations performed.
