# 03 · Clone preserver step

**Role required:** `clone_admin`.
**Applies to:** every sub-production instance where Kaddiya is registered.
**Cost of skipping it:** Kaddiya sign-in breaks on that instance after every clone, with an
`invalid_client` error that looks like a security incident and is not one.

## The problem in one paragraph

Sub-production instances get cloned from production quarterly. A clone overwrites the target's
tables — including `oauth_entity`. So the morning after a clone, your dev instance is carrying
**production's** Kaddiya registry record: production's client ID, production's secret,
production's redirect URL pointing at your production Kaddiya host. Dev's Kaddiya
configuration still holds dev's credentials, so every sign-in fails with `invalid_client`.

## The step, and the part everyone gets wrong

> **Data preservers must be defined on the clone *source* instance. Defining them on the
> target does not preserve anything.**

The source is normally **production**. This is counter-intuitive — you are protecting data on
dev by creating a record on prod — and it is the single most common reason this step silently
does nothing.

### Create the preserver (on the clone source — production)

1. **All → Clone Admin Console → Clone Home → Definitions → Preservers → New.**
2. **Name:** `Kaddiya OAuth registry`
3. **Table:** `oauth_entity` — the table's **system name**, not its label.
4. **Condition:** narrow it to just this record, so you are not preserving every OAuth client
   on the instance:
   ```
   name=Kaddiya
   ```
   Match whatever you actually named the record in document 02.
5. Save.

### Consider also

- **`oauth_credential`** — issued tokens. Preserving them is normally **not** what you want:
  after a clone you would rather every stored token die and users sign in again. Leave it to
  be overwritten; Kaddiya handles the re-authentication cleanly.
- **`sys_user_preference`** is a commonly preserved table on many instances already. It is
  where a user's current update set lives, so if you preserve it for other reasons, Kaddiya
  users keep their selected set across the clone. Either behavior is fine.

## After the clone: the health check

Whether or not the preserver worked, run this on the cloned instance:

1. Open the `Kaddiya` Application Registry record and confirm the **Client ID** and
   **Redirect URL** are that instance's, not production's.
2. If they are production's, the preserver did not apply — recreate the record per
   [document 02](02-oauth-registry-runbook.md) with a fresh secret, and fix the preserver on
   the source before the next clone.
3. Have one user sign in.

**How to tell a clone from an attack.** `invalid_client` on a sub-production instance in the
days after a scheduled clone, where the instance identity is unchanged and only authentication
broke, is a clone artifact — not a hijacked registration. If the instance identity itself
changed, treat it as an incident and contact us.

## Why this is low-risk to grant

The preserver protects one row on one table, selected by name. It preserves no user data, no
task records and no configuration beyond the registry record itself. If you would rather not
carry a preserver at all, the alternative is a documented post-clone task: recreate the record
and issue a new secret. Both are acceptable; the preserver just means nobody has to remember.

---

**Sources (Australia release):**
[Preserving data from target instances during clones](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-administration/data-preservation.md)
("You must define data preservers on the source instance. Defining them on the target instance
does not preserve the data.")
·
[Create a clone preserver](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-administration/create-new-clone-preserver.md)
(use the table's system name; use conditions to preserve only what you need).
Decision record: ADR 0008 D13.
