# 05 · Egress pinning

**Status in v1: self-hosted only.** There are no Kaddiya SaaS cells yet, so there are no
published SaaS egress IP addresses to pin. This document tells you how to pin a self-hosted
deployment today, and what we will publish when SaaS exists. We would rather mark it **N/A**
here than give you an address that changes next month.

## Self-hosted (available now)

A self-hosted Kaddiya is a container plus a Postgres database inside your own network. It
calls exactly two destinations: your ServiceNow instance, and the model endpoint you
configured. Its egress address is one you already control.

Pin it the way you pin any internal integration:

- **Adaptive Authentication.** Create an IP filter criterion for the container's egress
  address (or NAT range) and use it in an authentication policy applied to the
  post-authentication context. Adaptive Authentication's filter criteria support IPv4 and
  IPv6, and can also filter by role or group if you want to narrow further.
- **IP Address Access Control**, if your instance already runs it — add the same address to
  your allow list.

Either way, verify with a sign-in before you close the change. A pinning rule that silently
blocks the token endpoint produces an opaque failure at OAuth time.

**What Adaptive Authentication cannot do, so you do not go looking for it:** its documented
filter criteria are IP, role, group, location, identity-provider attribute, authentication
scheme and MFA state. There is no "OAuth client" filter criterion. To scope a control to
*Kaddiya specifically* rather than to all OAuth traffic, use **Enforce token restriction**
plus REST API access policies — see [document 04](04-rest-api-access-policy.md). Pinning by IP
and scoping by client are different tools; use both, for different reasons.

## SaaS (not yet)

When Kaddiya SaaS cells exist, this document will carry:

- static NAT egress addresses per regional cell;
- 30 days' notice before any address changes;
- guidance to scope the pinning policy to the Kaddiya OAuth client rather than to your
  instance globally, so you do not accidentally block your own users.

Until then, if IP pinning is a hard requirement in your environment, the answer is the
self-hosted deployment — which is also the answer for VPN-only instances, regulated-cloud
instances, and shops running Edge Encryption.

## The failure mode worth pre-empting

If your instance is unreachable from where Kaddiya runs — a VPN-only instance, an IP access
control list, or an Adaptive Authentication policy that does not know about us — the symptom
is a sign-in that fails at the token endpoint with no useful message. Today, diagnose it by
calling your instance's `oauth_token.do` from the Kaddiya host and comparing the source
address your instance logs against your pinning rule. A boot-time preflight that tests
reachability and the token endpoint and prints the precise cause ships with the self-hosted
package; it is designed, not yet released.

---

**Sources (Australia release):**
[Adaptive authentication](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-security/authentication/adaptive-authentication.md)
·
[Filter criteria](https://raw.githubusercontent.com/ServiceNow/ServiceNowDocs/australia/markdown/platform-security/authentication/adaptive-auth-filter-criteria.md)
(the seven criteria types — note that OAuth client is not among them).
Decision record: ADR 0008 D11, D14, D15.
