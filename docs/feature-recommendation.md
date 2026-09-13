# Recommended next feature: change rehearsal and evidence packs

My recommendation is to make every meaningful change reviewable as a compact evidence pack.
A team should be able to ask for a change, inspect what Kaddiya intends to do, rehearse the
supported checks, approve the proposal, and receive proof of the observed result.

For example: “Prepare a reassignment of these incidents to our new support group.” Before
writing, Kaddiya would show the exact records and field differences, relevant dependencies
it could actually inspect, missing access or uncertainty, expected results, and recovery
steps. After approval it would apply the supported changes, reread the records, and record
expected versus observed results. The pack could be attached to a change request or exported
for a reviewer.

## Why this is the best next investment

Kaddiya already has proposed before/after changes, explicit approvals, audit history, and
run verification stages. Combining these into a durable reviewer-facing artifact makes that
work easier to trust, repeat, and demonstrate. It also fits the product's self-hosted design,
customer-selected models, and calls under the signed-in user's ServiceNow permissions.

ServiceNow already provides AI-assisted change risk and conflict analysis, so the opportunity
is a small, inspectable workflow that connects evidence to the exact changes Kaddiya performs.
This is a product recommendation, not a claim that no competing product has similar features.
See [ServiceNow's agentic AI change management documentation](https://www.servicenow.com/docs/r/it-service-management/change-management/now-assist-itsm-agentic-ai-in-change.html).

## A focused first release

- Start with existing supported task-field updates. Record the target instance, records,
  original values, proposed values, checks, and human approval in one immutable version.
- Offer a read-only rehearsal that checks current values, reference targets, and discoverable
  constraints. Label untested behavior clearly; a rehearsal cannot prove every business rule,
  notification, or downstream integration will behave as expected.
- Recheck the original values immediately before applying. If records changed, require a
  refreshed proposal and approval rather than silently applying a stale plan.
- Reread after applying and show observed outcomes, partial failures, and a recovery plan.
  Offer a separately approved reversal only for actions proven reversible; do not promise
  to undo sent messages, triggered workflows, or every downstream effect.
- Export a concise report with evidence timestamps and audit references. Respect the user's
  access and let them review the content before sending it anywhere.

A good demo is one small change taken from intention through review to verified outcome.
The success measure is how quickly a reviewer can answer: “What changed, why, who approved
it, and how do we know it worked?” This feature is recommended, not implemented in the
branding change.
