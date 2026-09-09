# wfa-custom-action-guide

Tags: wfa, workflow-automation, custom action, Action, actionStep, wfa.actionStep, assignActionOutputs, reusable action, OOB step

Workflow Automation Custom Action Guide

Guide for creating and invoking reusable custom actions using the Fluent SDK. Custom actions encapsulate a sequence of OOB steps with typed inputs and outputs, and are invoked from any Flow or Subflow via wfa.action().

For API signatures, full config-property tables, every actionStep.* parameter list, the assignActionOutputs helper, the sys_id fallback, and the system DefaultActionOutputs, see the Custom Action API.

---


When to Use

• The same multi-step sequence is needed across multiple flows -- consolidate it as a callable action
• Standardize common operations (incident escalation, user provisioning, CMDB upserts, etc.)
• Build a domain library of reusable actions for an application
• Reduce duplication when the same OOB step sequence appears in several flows
• Cross-application reusable logic (invoked via sys_id fallback)

Important: Custom action bodies are strictly sequential OOB steps. No flow logic, no nested custom actions, no triggers. If you need branching or loops, model the logic in the calling flow (or use a subflow, which does support flow logic).


Custom Action vs Subflow vs Built-in Action

|                                  | Custom Action (Action())             | Subflow (Subflow())                       | Built-in (action.core.*)               |
| -------------------------------- | -------------------------------------- | ------------------------------------------- | ---------------------------------------- |
| Defines reusable logic       | Yes                                    | Yes                                         | No (you consume them)                    |
| Has typed I/O                | Yes                                    | Yes                                         | Yes (predefined)                         |
| Body content                 | wfa.actionStep() calls only          | Any flow logic + actions + nested subflows  | -                                        |
| Supports wfa.flowLogic.*   | No (sequential only)               | Yes                                     | -                                        |
| Invoked via                  | wfa.action()                         | wfa.subflow()                             | wfa.action()                           |
| File location                | fluent/actions/                      | fluent/flows/                             | (built into SDK)                         |
| Body required                | Recommended                            | Optional (stub allowed)                     | -                                        |

---


Core Principles

1. Single responsibility -- One clear business function per action. Use verb-phrase names (e.g., "Escalate Incident", "Provision User Account").
2. OOB steps only -- The body contains wfa.actionStep() calls and (optionally) one assignActionOutputs call. Nothing else.
3. Sequential execution -- Steps run in declaration order. There is no if/forEach/etc.
4. Capture step outputs -- Assign wfa.actionStep() return values to const to chain into downstream steps via wfa.dataPill().
5. Export the constant -- Always export const myAction = Action(...).
6. File location -- Place actions in fluent/actions/.

---


Rules

• Globals -- TemplateValue, Time, Duration are available globally. Use TemplateValue({ ... }) directly; wfa.TemplateValue is not a thing.
• Namespaces -- inside a custom action body use actionStep.; the action.core. namespace is for flows/subflows. Don't copy parameter names between the two -- they differ.
• Step output chaining -- capture step return values: const result = wfa.actionStep(...), then wfa.dataPill(result.field, "type") downstream.
• Use wfa.assignActionOutputs(params.outputs, { ... }) at the end of the body to expose declared outputs.
• Parameter prefixes are inconsistent across steps -- see the naming reference. Wrong prefix is a silent type error.
• Error handling per-step -- errorHandlingType: 'dont_stop_the_action' to continue on step error; default is 'stop_the_action'.
• access values are 'public' (default) or 'package_private'. The legacy 'private' is rejected at build time.
• Location & export -- custom actions live in fluent/actions/; always export const.
• Don't hardcode sys_ids -- resolve via lookUpRecord or pass in as action inputs.
• __action_status__ is available on every action invocation (code, message) -- use it for error branching at the call site even when the action declares no outputs.
• skip_insert: true -- handy for createRecord / createTask during development to validate field mappings without writing records.
• watermark_email: true -- required on actionStep.email if a later waitForEmailReply needs to thread back.

---


Action Constructor

```typescript fluent
import { Action, wfa, actionStep } from "@servicenow/sdk/automation";
import { StringColumn, BooleanColumn, ReferenceColumn } from "@servicenow/sdk/core";

export const myAction = Action(
  config,   // metadata + inputs + outputs (+ access, annotation, protectionPolicy)
  body      // params => { ... sequential wfa.actionStep() calls + optional assignActionOutputs ... }
);
```

For the full config property table (including annotation, protectionPolicy, access, category), see the Custom Action API → Config Parameters.

---


Invoking a Custom Action

Invoke from a Flow or Subflow with wfa.action() -- the same helper used for built-in actions.

```typescript fluent
import { escalateIncident } from "../actions/escalate-incident.now";

wfa.action(
  escalateIncident,
  { $id: Now.ID["escalate_step"], annotation: "Escalate P1 incident" },
  {
    incident: wfa.dataPill(params.trigger.current, "reference"),
    reason: "Auto-escalated: Priority 1 incident created"
  }
);
```

sys_id fallback

When the custom action's definition isn't importable (cross-application), pass its sys_id as a string. Output access becomes untyped.

```typescript fluent
const result = wfa.action(
  "abc123def4567890abc123def4567890",
  { $id: Now.ID["external_action_call"] },
  { someInput: "..." }
);

wfa.dataPill(result.someOutput, "string");
```

---


Parameter naming inconsistencies

OOB steps use different parameter-naming conventions per step (create_record_table_name vs. table_name vs. table vs. lookup_table_name; create_record_field_values vs. update_record_field_values vs. field_values vs. fields). Mistyping a parameter name is a common error.

See the canonical reference: Custom Action API → Step parameter naming inconsistencies.

---


Assigning Action Outputs

Use wfa.assignActionOutputs() to return values from the action body to the calling flow. Place it after all steps (and after wfa.errorEvaluation() if present).

```typescript fluent
export const myAction = Action(
    {
        $id: Now.ID['my-action'],
        name: 'My Action',
        inputs: {
            description: StringColumn({ label: 'Description', mandatory: true }),
        },
        outputs: {
            success: BooleanColumn({ label: 'Success' }),
            result: StringColumn({ label: 'Result' }),
        },
    },
    (params) => {
        const step = wfa.actionStep(
            actionStep.createRecord,
            { $id: Now.ID['create-step'], label: 'Create' },
            {
                create_record_table_name: 'incident',
                create_record_field_values: TemplateValue({
                    short_description: wfa.dataPill(params.inputs.description, 'string'),
                }),
            }
        )

        wfa.assignActionOutputs(params.outputs, {
            success: '1',
            result: `Created: ${wfa.dataPill(step.record.number, 'string')}`,
        })
    }
)
```

Key rules:
• Output keys must match names declared in the action's outputs — TypeScript enforces this with autocomplete
• Values can be static strings ('test'), datapill references (wfa.dataPill(...)), or template literals mixing both
• Use '1' for true and '0' for false on boolean outputs

---


Error Evaluation

Use wfa.errorEvaluation() to conditionally set the action's status based on step results. This is different from errorHandlingType on individual steps — error evaluation sets the overall action status after all steps complete.

```typescript fluent
(params) => {
    const step = wfa.actionStep(
        actionStep.createRecord,
        { $id: Now.ID['step'], label: 'Create' },
        {
            create_record_table_name: 'incident',
            create_record_field_values: TemplateValue({ active: 'true' }),
            errorHandlingType: 'stop_the_action',
        }
    )

    wfa.errorEvaluation([
        {
            label: 'Success Check',
            condition: `${wfa.dataPill(step.__step_status__.code, 'integer')}!=500`,
            status: { code: 200, message: 'OK' },
            dontTreatAsError: true,
        },
        {
            label: 'Failure Check',
            condition: `${wfa.dataPill(step.__step_status__.code, 'integer')}=500`,
            status: { code: 500, message: 'Step failed' },
        },
    ])

    wfa.assignActionOutputs(params.outputs, { success: '1' })
}
```

Key rules:
• Conditions are evaluated in order — the first matching condition wins
• dontTreatAsError: true means the action is considered successful even though a condition matched
• Condition strings use ServiceNow encoded query syntax (^ for AND, ^OR for OR)
• Status code and message can be static values or datapill template expressions
• Place after all wfa.actionStep() calls but before wfa.assignActionOutputs() 

Error evaluation vs step error handling:
• errorHandlingType: 'stop_the_action' on a step controls whether the action halts when that specific step fails
• wfa.errorEvaluation() evaluates conditions after steps complete and sets the overall action status code/message

---


Combined Example: Error Evaluation + Output Assignment

The following example demonstrates both wfa.errorEvaluation() and wfa.assignActionOutputs() used together in a single action. The step status is checked via error evaluation, and outputs are assigned regardless of the outcome.

```typescript fluent
import { Action, wfa, actionStep } from '@servicenow/sdk/automation'
import { ReferenceColumn, StringColumn, BooleanColumn } from '@servicenow/sdk/core'

export const createAndValidate = Action(
    {
        $id: Now.ID['create-validate'],
        name: 'Create and Validate',
        inputs: {
            incident: ReferenceColumn({ label: 'Incident', referenceTable: 'incident', mandatory: true }),
            reason: StringColumn({ label: 'Reason' }),
        },
        outputs: {
            success: BooleanColumn({ label: 'Success' }),
            details: StringColumn({ label: 'Details' }),
        },
    },
    (params) => {
        const createStep = wfa.actionStep(
            actionStep.createRecord,
            { $id: Now.ID['create-step'], label: 'Create Record' },
            {
                create_record_table_name: 'incident',
                create_record_field_values: TemplateValue({ active: 'true' }),
                errorHandlingType: 'stop_the_action',
            }
        )

        wfa.errorEvaluation([
            {
                label: 'Created Successfully',
                condition: `${wfa.dataPill(createStep.__step_status__.code, 'integer')}!=500`,
                status: { code: 200, message: 'Record created' },
                dontTreatAsError: true,
            },
            {
                label: 'Creation Failed',
                condition: `${wfa.dataPill(createStep.__step_status__.code, 'integer')}=500`,
                status: { code: 500, message: wfa.dataPill(createStep.__step_status__.message, 'string') },
            },
        ])

        wfa.assignActionOutputs(params.outputs, {
            success: '1',
            details: wfa.dataPill(params.inputs.reason, 'string'),
        })
    }
)
```

What this shows:
• errorHandlingType: 'stop_the_action' on the step halts execution if the step itself fails
• wfa.errorEvaluation() inspects createStep.__step_status__.code to set the overall action status
• dontTreatAsError: true marks the 200 condition as a success outcome
• wfa.assignActionOutputs() always runs last — values can reference params.inputs data pills
• Status message in the failure condition is itself a data pill from the step status output

---


Anti-Patterns

Do NOT use flow logic inside a custom action

Custom action bodies are strictly sequential -- if you need if/forEach, put that logic in the calling flow or use a subflow.

```typescript fluent
// WRONG
params => {
  wfa.flowLogic.if({ ... }, () => { ... });   // NOT allowed
};

// CORRECT -- sequential steps only
params => {
  wfa.actionStep(actionStep.createRecord, { ... }, { ... });
  wfa.actionStep(actionStep.log, { ... }, { ... });
};
```

Do NOT call another custom action from inside

Custom actions cannot nest. Compose at the flow/subflow level.

```typescript fluent
// WRONG -- inside an Action() body
params => {
  wfa.action(otherCustomAction, { ... }, { ... });
};
```

Do NOT mix `action.core.*` and `actionStep.*` parameter names

```typescript fluent
// WRONG -- ah_* prefix belongs to action.core.sendEmail, NOT actionStep.email
wfa.actionStep(actionStep.email, { ... }, { ah_to: "user@x.com", ah_subject: "..." });

// CORRECT
wfa.actionStep(actionStep.email, { ... }, { to: "user@x.com", subject: "..." });
```

Do NOT assign data pills to local variables

Data pills are evaluated by the platform at runtime, not by JavaScript. Capturing one in a const and reusing the variable doesn't work.

```typescript fluent
// WRONG
const id = wfa.dataPill(params.inputs.recordId, "string");
wfa.actionStep(actionStep.lookUpRecord, { ... }, { conditions: `sys_id=${id}` });

// CORRECT
wfa.actionStep(
  actionStep.lookUpRecord,
  { ... },
  { conditions: `sys_id=${wfa.dataPill(params.inputs.recordId, "string")}` }
);
```

---


Patterns

Basic Custom Action

```typescript fluent
import { Action, wfa, actionStep } from "@servicenow/sdk/automation";
import { StringColumn, BooleanColumn } from "@servicenow/sdk/core";

export const logAndCreate = Action(
  {
    $id: Now.ID["log_and_create"],
    name: "Log and Create Incident",
    description: "Logs the request and creates an incident with the given description and priority",
    inputs: {
      description: StringColumn({ label: "Description", mandatory: true }),
      priority: StringColumn({ label: "Priority", mandatory: true })
    },
    outputs: {
      created: BooleanColumn({ label: "Created" })
    }
  },
  params => {
    wfa.actionStep(
      actionStep.log,
      { $id: Now.ID["log_start"], label: "Log start" },
      {
        log_message: `Creating incident: ${wfa.dataPill(params.inputs.description, "string")}`,
        log_level: "info"
      }
    );

    wfa.actionStep(
      actionStep.createRecord,
      { $id: Now.ID["create_incident"], label: "Create incident" },
      {
        create_record_table_name: "incident",
        create_record_field_values: TemplateValue({
          short_description: wfa.dataPill(params.inputs.description, "string"),
          priority: wfa.dataPill(params.inputs.priority, "string")
        })
      }
    );

    wfa.assignActionOutputs(params.outputs, { created: true });
  }
);
```

Chaining Step Outputs

```typescript fluent
import { Action, wfa, actionStep } from "@servicenow/sdk/automation";
import { ReferenceColumn, StringColumn } from "@servicenow/sdk/core";

export const createAndLog = Action(
  {
    $id: Now.ID["create_and_log"],
    name: "Create Incident and Log Number",
    inputs: {
      assignee: ReferenceColumn({ label: "Assignee", referenceTable: "sys_user", mandatory: true }),
      description: StringColumn({ label: "Description", mandatory: true })
    },
    outputs: {
      incidentNumber: StringColumn({ label: "Incident Number" })
    }
  },
  params => {
    const created = wfa.actionStep(
      actionStep.createRecord,
      { $id: Now.ID["create_step"], label: "Create incident" },
      {
        create_record_table_name: "incident",
        create_record_field_values: TemplateValue({
          short_description: wfa.dataPill(params.inputs.description, "string"),
          assigned_to: wfa.dataPill(params.inputs.assignee, "reference")
        })
      }
    );

    wfa.actionStep(
      actionStep.log,
      { $id: Now.ID["log_number"], label: "Log incident number" },
      {
        log_message: wfa.dataPill(created.record.number, "string"),
        log_level: "info"
      }
    );

    wfa.assignActionOutputs(params.outputs, {
      incidentNumber: wfa.dataPill(created.record.number, "string")
    });
  }
);
```

Continue-on-Error with `errorHandlingType`

```typescript fluent
params => {
  // First step continues even if it errors
  wfa.actionStep(
    actionStep.updateRecord,
    { $id: Now.ID["try_update"] },
    {
      table_name: "incident",
      record: wfa.dataPill(params.inputs.incident, "reference"),
      update_record_field_values: TemplateValue({ priority: "1" }),
      errorHandlingType: "dont_stop_the_action"
    }
  );

  // This still runs even if the update above failed
  wfa.actionStep(
    actionStep.log,
    { $id: Now.ID["log_after"] },
    { log_message: "Update attempted", log_level: "info" }
  );
};
```

Script Step with Extended Inputs/Outputs

The actionStep.script step has allowExtendedInputs: true and allowExtendedOutputs: true, so it accepts inputVariables and outputVariables.

```typescript fluent
import { StringColumn, IntegerColumn } from "@servicenow/sdk/core";

wfa.actionStep(
  actionStep.script,
  { $id: Now.ID["calc_metrics"], label: "Calculate metrics" },
  {
    required_run_time: "instance",
    script: Now.include("./scripts/calc-metrics.js"),
    inputVariables: {
      threshold: { label: "Threshold", value: "100" }
    },
    outputVariables: {
      score:    IntegerColumn({ label: "Score", default: "0" }),
      verdict:  StringColumn({ label: "Verdict", maxLength: 64 })
    }
  }
);
```

The score and verdict outputs become available on the step's return value for downstream wfa.dataPill() references.

---
