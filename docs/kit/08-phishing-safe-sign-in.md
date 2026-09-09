# 08 · Phishing-safe sign-in

For security awareness teams. One page, written so it can be lifted into your own training
material.

## The pattern, stated plainly

**Kaddiya never asks for your ServiceNow password.**

Signing in works like this, every time, with no exceptions:

1. You press **Sign in with ServiceNow** in Kaddiya.
2. Your browser is sent, as a **full-page redirect**, to **your own instance's** login page —
   the same page and the same address you use for ServiceNow every day, including your usual
   SSO and MFA.
3. You authenticate there, with your instance.
4. Your instance sends you back to Kaddiya. Kaddiya receives an authorization code, never
   your credentials.

There is no popup asking for a password. There is no field in Kaddiya labelled "ServiceNow
password". There is no "enter your credentials to continue" step. If you ever see one,
**it is not us** — close the tab and report it.

## What to train people to check

- **The address bar during step 2 must be your own ServiceNow host** (`your-company.service-now.com`,
  or whatever your instance's address is). If a page asking for your ServiceNow password is on
  any other domain, it is a phishing page.
- **A full page, not a popup.** We use a full-page redirect specifically so the address bar is
  visible and checkable.
- **The consent screen names `Kaddiya`.** If you are not expecting a Kaddiya sign-in and
  one appears, decline it.

## The risk we are not pretending away

As Kaddiya grows its administrative surface, sensitive actions — registering an instance,
changing model configuration, deleting an organization — are designed to require an
administrator to re-authenticate through this same redirect on your production instance. That
would make production-admin OAuth a routine action, and routine actions are what phishing
exploits. (Those administrative actions are not in this release; the pattern below is what
protects them when they arrive, and it protects ordinary sign-in today.)

We do not consider that eliminated. What we do about it:

- Kaddiya never collects credentials, so a genuine flow always ends on your own login page,
  and users can be trained on exactly that.
- Sign-in always uses a full-page redirect, never an embedded frame or popup, so the address
  bar is always available to check.
- An administrative sign-in flow that someone else started cannot land in your console: the
  OAuth state is bound server-side to the browser that began it, so a callback URL that is
  pasted or emailed to you does nothing.
- PKCE means an intercepted authorization code is useless on its own.

The residual risk is the user who believes they are in their own organization's Kaddiya and
is not. The countermeasure is the training this page supports, plus the corporate-channel
dispute path if an instance is ever claimed by someone who should not have claimed it.

## For your reporting workflow

If someone reports a page that asked for their ServiceNow password while claiming to be
Kaddiya:

1. Treat it as a phishing report against your ServiceNow credentials — that is what it is.
2. The genuine product cannot do this, so there is no "maybe it was legitimate" branch.
3. Have the user check **System OAuth → Manage Tokens** on the instance, or ask an admin to,
   and revoke anything unexpected. Deactivating the Kaddiya Application Registry record
   revokes everything at once.

## Copy for a training slide

> Kaddiya never asks for your ServiceNow password. It sends you to our own ServiceNow login
> page to sign in. If anything calling itself Kaddiya asks you to type your ServiceNow
> password into its own page, it is fake — close it and report it.

---

Decision record: ADR 0008 D2, D4, D15.
