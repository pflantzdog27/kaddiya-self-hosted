# wfa-flow-guide

Tags: flow, wfa, workflow-automation, flow-designer, trigger, data-pill, record-trigger, scheduled, service-catalog, inbound-email, sla

Workflow Automation Flow Guide

Comprehensive guide for creating and editing ServiceNow Workflow Automation (WFA) flows using the Fluent SDK. Covers Flow Designer flows including triggers, actions, flow logic, data pills, approvals, and service catalog integration. Use this when implementing event-driven automation, scheduled tasks, approval workflows, or any WFA component.


When to Use

• Creating or editing workflow automation flows
• Implementing event-driven automation (record changes, emails, SLA events)
• Building scheduled/recurring automations
• Implementing approval workflows or notification processes

Important: Flows consist of four integrated components -- Flow Configuration (metadata), Trigger (when), Actions (what), and Flow Logic (how).

---


Temporal Requirements Analysis

Pick the trigger family based on how the requirement is phrased:

| Requirement phrasing                                            | Trigger family          | Typical types                                     |
| --------------------------------------------------------------- | ----------------------- | ------------------------------------------------- |
| "when X is created/updated/happens"                             | Record trigger      | created, updated, createdOrUpdated          |
| "every day/hour", "at 9 AM", "while active", "monitor"          | Scheduled trigger   | daily, weekly, monthly, repeat, runOnce |
| "when email arrives", "when SLA breaches", "on catalog request" | Application trigger | inboundEmail, slaTask, serviceCatalog       |

For the complete trigger reference, see the Trigger Guide.

---


Component Quick Reference

The four components of a flow, and where to find their full reference:

| Component         | Purpose                            | Reference                                                                                  |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Trigger       | When the flow runs                 | Trigger Guide / Trigger API |
| Action        | What the flow does                 | Actions Guide / Action API    |
| Flow Logic    | How the flow branches and loops    | Flow Logic Guide / Flow Logic API |
| Configuration | Metadata and execution context     | Flow API → Configuration Properties |

Reusable building blocks (called from inside a flow):

| Building block    | Use when                                                                  | Reference                                                                                       |
| ----------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Subflow       | Reusable callable unit with typed I/O; can use full flow logic            | Subflow Guide / Subflow API |
| Custom Action | Reusable sequence of OOB steps (no branching/looping)                     | Custom Action Guide / Custom Action API |

---


Flow vs Subflow

| Aspect          | Flow                                                       | Subflow                                                            |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Purpose     | Automates a business process end-to-end                    | Encapsulates reusable logic called by flows or other subflows      |
| Trigger     | Required -- record event, schedule, or application trigger | None -- invoked programmatically via wfa.subflow()               |
| Inputs      | From trigger (e.g. params.trigger.current)              | Typed inputs passed by the caller                                  |
| Outputs     | None                                                       | Typed outputs returned to the caller via assignSubflowOutputs    |
| When to use | Top-level automation triggered by an event or schedule     | Shared logic reused across multiple flows; delegated units of work |

---


Planning Your Flow

When translating requirements into a flow:

1. Identify the trigger -- what event activates the flow?
2. Plan the logic -- what conditions, branches, or loops are needed?
3. Select the actions -- what operations should the flow perform?
4. Identify reusable logic -- should any steps be extracted into a Custom Action or Subflow?

---


Core Principles

1. Keep flows focused: A flow should encapsulate a specific automation. Avoid adding side-effects (extra logging, ad-hoc notifications, defensive lookups) that aren't part of the core business logic.

2. One verb per action: Each business verb (create, update, send, notify) maps to exactly one fluent action. Multiple verbs require multiple actions.

3. Use flow logic deliberately: Add flow logic constructs (if, forEach, etc.) only when the business logic requires them. Avoid defensive conditionals, default branches, or decision paths added "just in case."

4. Activation required: Flows are created in a draft state. Activate them in Flow Designer before they execute.

---


Rules & Anti-Patterns

Rules

• Globals (do not import): TemplateValue, Time, Duration, and Now.ID[...] are available globally from @servicenow/sdk/global. Use TemplateValue({ ... }) directly -- not wfa.TemplateValue.
• File locations: Flows + subflows live in fluent/flows/; custom actions live in fluent/actions/.
• Exactly one trigger per flow. Subflows have no trigger (they are invoked).
• Background execution recommended: set run_flow_in: 'background' on triggers that support it (see the Trigger Guide).
• Conditions use template literals: ` ${wfa.dataPill(..., 'type')}=value ` -- the literal is required so the data pill interpolates into the encoded query string.
• No JS in flow-logic conditions: if/elseIf/else do not support javascript:gs.daysAgoStart(30)-style expressions. JS functions are allowed only in table-action conditions (lookUpRecords, updateMultipleRecords).
• Don't hardcode sys_ids: resolve them via lookUpRecord or pass them in as flow inputs.
• Non-existent actions: there is no deleteMultipleRecords -- use lookUpRecords + forEach + deleteRecord.
• Time helpers: Time.addDays() / Time.nowDateTime() do not exist -- use data pills like wfa.dataPill(params.trigger.current.due_date, 'glide_date_time').
• Action parameter naming differs per action (values vs. field_values, table vs. table_name, etc.) -- see the Action API for the canonical names.
• Activation: flows are created in a draft state; activate them in Flow Designer before they execute.

Anti-Patterns

#### Do NOT assign data pills to variables (in flows)

WFA flows are declarative -- data pills must be used directly in action parameters, never captured in const/let/var.

```typescript fluent
// WRONG
const recordId = wfa.dataPill(result.record, 'reference');
wfa.action(action.core.updateRecord, {...}, { record: recordId });

// CORRECT
wfa.action(action.core.updateRecord, {...}, {
  record: wfa.dataPill(result.record, 'reference')
});
```

Exception: inside a custom action body, const stepResult = wfa.actionStep(...) is correct -- it's the standard way to chain step outputs into downstream steps.

#### Template literals work only in specific fields

Supported: ah_subject, log_message. NOT supported: ah_body, message (SMS), or any field inside TemplateValue({...}).

```typescript fluent
// WRONG
ah_body: `Details: ${wfa.dataPill(desc, 'string')}`,        // does not interpolate
values: TemplateValue({
  notes: `Status: ${wfa.dataPill(status, 'string')}`        // does not interpolate
});

// CORRECT
ah_subject: `Incident ${wfa.dataPill(number, 'string')}`,
ah_body: 'Please check your assignment for details.',
values: TemplateValue({
  notes: wfa.dataPill(status, 'string')                     // data pill directly, no template
});
```

#### Do NOT mix JavaScript and DSL paradigms

WFA flows are declarative -- don't try to build helper functions or generic factories.

```typescript fluent
// WRONG
const getFieldValue = field => wfa.dataPill(params.trigger.current[field], 'string');

// CORRECT
conditions: `priority=${wfa.dataPill(params.trigger.current.priority, 'string')}^active=true`;
```

---


Data Pills

wfa.dataPill() wraps expressions with type information for Flow Designer XML serialization. The function is a passthrough at runtime -- the type argument is consumed by the build plugin to emit the correct XML.

```typescript fluent
wfa.dataPill(_expression, _type: FlowDataType)
```

Usage Contexts

• Trigger data: params.trigger.current.* -- record fields from the trigger record
• Action outputs: actionResult.fieldName -- output fields of an action captured to a const
• Subflow outputs: subflowResult.fieldName -- output fields of a subflow captured to a const
• Custom action inputs: params.inputs.* -- the action's declared inputs (inside Action() body)
• Custom action step outputs: stepResult.fieldName -- output of a wfa.actionStep() captured to a const
• Dot-walking: params.trigger.current.assigned_to.manager.email -- traverse reference fields (multi-level supported)

Common FlowDataType Values

The SDK supports ~100 FlowDataType values; most flows use a small set. Common categories:

| Category          | Types                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Basic         | 'string', 'integer', 'boolean', 'decimal', 'float'                                     |
| Email content | 'string_full_utf8' -- use for email subjects/bodies, NOT plain 'string'                      |
| Date/Time     | 'datetime', 'glide_date_time', 'glide_date', 'glide_duration', 'due_date'              |
| Reference     | 'reference', 'document_id', 'table_name', 'field_name'                                   |
| Array         | 'array.object', 'array.string', 'records' (use 'records' for forEach)                  |
| Choice / Text | 'choice', 'journal_input', 'multi_line_text', 'html'                                     |
| Other         | 'json', 'email', 'phone_number', 'url', 'currency', 'approval_rules', 'conditions' |

Whole record vs. sys_id: pass params.trigger.current with type 'reference' for the whole record; use params.trigger.current.sys_id only when a parameter requires just the sys_id string.

Data Pill Examples

```typescript fluent
// Different sources
wfa.dataPill(params.trigger.current, "reference")                  // trigger record
wfa.dataPill(params.trigger.current.assigned_to.email, "string")   // dot-walking through references
wfa.dataPill(createResult.record, "reference")                     // action output
wfa.dataPill(lookupResult.Records, "records")                      // record set for forEach
wfa.dataPill(validation.isValid, "boolean")                        // subflow output
wfa.dataPill(params.inputs.description, "string")                  // custom action input (inside Action())
wfa.dataPill(stepResult.record.number, "string")                   // custom action step output (inside Action())

// In a flow-logic condition (template literal required)
condition: `${wfa.dataPill(params.trigger.current.priority, "string")}=1`

// In a supported template-literal field (ah_subject, log_message)
log_message: `Incident ${wfa.dataPill(params.trigger.current.number, "string")} created`
```

---


End-to-End Examples

Complete flow definitions showing trigger, configuration, and action body working together -- including how to chain actions by capturing their return value as const and feeding outputs into downstream calls via wfa.dataPill(). For trigger-specific reference, see the Trigger Guide; for action-specific examples, see the Flow Actions Guide.

Service Catalog with Approval & Fulfillment

Catalog request → manager approval → fulfillment task. Demonstrates trigger.application.serviceCatalog, getCatalogVariables, askForApproval with wfa.approvalRules(), and conditional task creation.

```typescript fluent
import { Flow, wfa, action, trigger } from "@servicenow/sdk/automation";
import { laptopCatalogItem } from "../catalogs/laptop-catalog.now";

Flow(
  {
    $id: Now.ID["catalog_approval_flow"],
    name: "Laptop Request - Approval & Fulfillment",
    runAs: "system"
  },
  wfa.trigger(
    trigger.application.serviceCatalog,
    { $id: Now.ID["catalog_trigger"] },
    { run_flow_in: "background" }
  ),
  params => {
    // Surface template variables onto the request item
    wfa.action(
      action.core.getCatalogVariables,
      { $id: Now.ID["fill_template_vars"] },
      {
        requested_item: wfa.dataPill(params.trigger.request_item, "reference"),
        template_catalog_item: `${laptopCatalogItem}`
      }
    );

    // Manager approval (blocking)
    const approval = wfa.action(
      action.core.askForApproval,
      { $id: Now.ID["manager_approval"] },
      {
        record: wfa.dataPill(params.trigger.request_item, "reference"),
        table: "sc_req_item",
        approval_reason: "Manager approval required for laptop request",
        approval_conditions: wfa.approvalRules({
          conditionType: "AND",
          ruleSets: [
            {
              action: "ApprovesRejects",
              conditionType: "AND",
              rules: [[{ ruleType: "Any", users: [], groups: ["<approver_group_sys_id>"], manual: false }]]
            }
          ]
        })
      }
    );

    // Create the fulfillment task only on approval
    wfa.flowLogic.if(
      {
        $id: Now.ID["if_approved"],
        condition: `${wfa.dataPill(approval.approval_state, "choice")}=approved`
      },
      () => {
        wfa.action(
          action.core.createCatalogTask,
          { $id: Now.ID["fulfillment_task"] },
          {
            ah_requested_item: wfa.dataPill(params.trigger.request_item, "reference"),
            ah_short_description: "Procure and provision laptop",
            ah_wait: false
          }
        );
      }
    );
  }
);
```

Record Iteration with Flow Logic

Covers record trigger + bulk lookup + forEach + flowLogic.if + conditional record update. Shows how flow logic constructs compose around action chaining.

```typescript fluent
import { action, Flow, wfa, trigger } from "@servicenow/sdk/automation";

Flow(
  {
    $id: Now.ID["cmdb_critical_ci_flag_flow"],
    name: "Flag Critical CIs During Change Implementation",
    runAs: "system"
  },
  wfa.trigger(
    trigger.record.updated,
    { $id: Now.ID["change_implementing"] },
    {
      table: "change_request",
      condition: "state=-1^approval=approved",
      run_flow_in: "background"
    }
  ),
  params => {
    // Find all CIs related to the change
    const cis = wfa.action(
      action.core.lookUpRecords,
      { $id: Now.ID["find_related_cis"] },
      {
        table: "cmdb_ci",
        conditions: `cmdb_ci=${wfa.dataPill(params.trigger.current.cmdb_ci, "string")}^operational_status=1`,
        max_results: 50
      }
    );

    // For each CI, flag the critical ones as "under change"
    wfa.flowLogic.forEach(
      wfa.dataPill(cis.Records, "records"),
      { $id: Now.ID["each_ci"] },
      ci => {
        wfa.flowLogic.if(
          {
            $id: Now.ID["ci_is_critical"],
            condition: `${wfa.dataPill(ci.business_criticality, "string")}=1`
          },
          () => {
            wfa.action(
              action.core.updateRecord,
              { $id: Now.ID["mark_under_change"] },
              {
                table_name: "cmdb_ci",
                record: wfa.dataPill(ci.sys_id, "reference"),
                values: TemplateValue({
                  install_status: "3",
                  work_notes: "Critical CI affected by approved change"
                })
              }
            );
          }
        );
      }
    );
  }
);
```

Subflow + Custom Action Composition

A flow that invokes both reusable building blocks: a subflow (for branching validation logic) and a custom action (for a packaged escalation sequence). Shows how to compose flows from imported pieces.

```typescript fluent
import { action, Flow, wfa, trigger } from "@servicenow/sdk/automation";
import { validateUserSubflow } from "../flows/validate-user-subflow.now";
import { escalateIncident } from "../actions/escalate-incident.now";

Flow(
  {
    $id: Now.ID["p1_incident_workflow"],
    name: "P1 Incident - Validate Caller and Escalate",
    runAs: "system"
  },
  wfa.trigger(
    trigger.record.created,
    { $id: Now.ID["p1_created"] },
    { table: "incident", condition: "priority=1", run_flow_in: "background" }
  ),
  params => {
    // Subflow - typed I/O, full flow logic inside
    const validation = wfa.subflow(
      validateUserSubflow,
      { $id: Now.ID["validate_caller"] },
      {
        userId: wfa.dataPill(params.trigger.current.caller_id.sys_id, "string"),
        waitForCompletion: true
      }
    );

    // Branch on subflow output; invoke a custom action on the happy path
    wfa.flowLogic.if(
      {
        $id: Now.ID["caller_valid"],
        condition: `${wfa.dataPill(validation.isValid, "boolean")}=true`
      },
      () => {
        wfa.action(
          escalateIncident,
          { $id: Now.ID["run_escalate"] },
          {
            incident: wfa.dataPill(params.trigger.current, "reference"),
            reason: "P1 incident from validated caller -- auto-escalated"
          }
        );
      }
    );
  }
);
```
