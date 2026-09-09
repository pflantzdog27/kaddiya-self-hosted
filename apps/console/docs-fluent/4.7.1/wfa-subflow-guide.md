# wfa-subflow-guide

Tags: wfa, workflow-automation, subflow, wfa.subflow, assignSubflowOutputs, reusable subflow, flowVariables, FlowObject

Workflow Automation Subflow Guide

Guide for creating and invoking reusable Subflows using the Fluent SDK. Subflows encapsulate flow logic with typed inputs and outputs, and can be invoked from any Flow or another Subflow via wfa.subflow().

For API signatures, full config-property tables, the sys_id fallback invocation, assignSubflowOutputs, and column types, see the Subflow API.

---


When to Use

• Same logic is needed across multiple flows -- consolidate into a single callable unit
• Breaking a complex flow into composable, independently testable pieces
• A flow delegates a discrete unit of work and consumes the outputs
• Standardizing reusable building blocks (e.g., user validation, record enrichment, notification dispatch)
• Cross-application reusable logic (invoked via sys_id fallback from a different app)


Flow vs Subflow

|                          | Flow                          | Subflow                                    |
| ------------------------ | ----------------------------- | ------------------------------------------ |
| Has trigger          | Yes (exactly one)             | No                                         |
| Can be invoked       | No (event-driven only)        | Yes, from flows or other subflows          |
| Has typed I/O        | No typed inputs/outputs       | Yes (column-typed inputs and outputs)  |
| File location        | fluent/flows/               | fluent/flows/                            |
| Body                 | Required                      | Optional (stub is valid)                   |

---


Core Principles

1. No trigger -- Subflows are invoked explicitly via wfa.subflow(). Never add a trigger.
2. Typed inputs and outputs -- Define inputs / outputs using column types (StringColumn, BooleanColumn, ReferenceColumn, ...). The caller and body see them as typed pills.
3. Set outputs via assignSubflowOutputs -- This is the only supported mechanism. Pass params.outputs as the schema argument; omitted fields are undefined.
4. Export the constant -- Always export const mySubflow = Subflow(...) so other files can import and invoke it.
5. Body is optional -- Subflow(config) with no body is valid for stubs or cross-file references.
6. Full flow logic supported -- The body may use wfa.action(), all wfa.flowLogic.* constructs (if/elseIf/else, forEach, exitLoop, skipIteration, endFlow, assignSubflowOutputs, setFlowVariables, stage), and nested wfa.subflow() calls.

---


Best Practices

1. Keep scope narrow -- One clear responsibility per subflow. Wide subflows produce hard-to-debug execution graphs.
2. Always export -- export const is required for cross-file imports.
3. Assign outputs on every path -- Every branch of if/elseIf/else (or every iteration of a loop) should set outputs the caller expects. Omitted fields land as undefined.
4. Capture the return value -- wfa.subflow() returns the typed outputs; assign it to a const so downstream actions can use wfa.dataPill(result.field, 'type').
5. Use waitForCompletion: true deliberately -- Set it when downstream logic depends on subflow outputs. Omit it (or set false) for fire-and-forget invocations to keep the caller responsive.
6. Use runAs: 'system' when the subflow operates on tables the caller may not have ACL access to.
7. Use runWithRoles for least privilege -- accept string sys_ids or Role objects. Prefer narrow role grants over runAs: 'system' when full system access isn't needed.
8. Use flowVariables for internal state -- not for cross-subflow communication. Inputs and outputs are the public contract.
9. Prefer the typed import -- Import the subflow constant directly. Fall back to a sys_id string only when the definition cannot be imported (e.g., cross-application).

---


Subflow Constructor

```typescript fluent
import { Subflow, wfa, action } from "@servicenow/sdk/automation";
import { StringColumn, BooleanColumn } from "@servicenow/sdk/core";

export const mySubflow = Subflow(
  config,   // metadata + inputs + outputs + flowVariables + stages
  body      // optional (params) => { ... }
);
```

For the full config property table (including protectionPolicy, access, category, stages, etc.), see the Subflow API → Config Parameters.

---


Invoking a Subflow

Use wfa.subflow() inside a Flow or another Subflow body.

```typescript fluent
import { mySubflow } from "./my-subflow.now";

const result = wfa.subflow(
  mySubflow,
  { $id: Now.ID["instance_id"], annotation: "Description" },
  {
    inputField: wfa.dataPill(someValue, "string"),
    waitForCompletion: true        // belongs in the inputs object, NOT in instanceConfig
  }
);

// Access outputs via data pills
wfa.dataPill(result.outputField, "string");
```

Where things go:

• $id, annotation, uuid, showSubflowStage → second argument (instanceConfig)
• waitForCompletion and all schema inputs → third argument (inputs)

sys_id fallback

When the subflow definition cannot be imported (cross-application or unresolvable), pass the sys_id string instead. Output access becomes untyped (use data pills directly).

```typescript fluent
const result = wfa.subflow(
  "abc123def4567890abc123def4567890",
  { $id: Now.ID["external_subflow_call"] },
  { userId: "...", waitForCompletion: true }
);

wfa.dataPill(result.someOutput, "string");
```

---


Setting Outputs

Always pass params.outputs as the second argument to assignSubflowOutputs. Never construct a custom object.

```typescript fluent
wfa.flowLogic.assignSubflowOutputs(
  { $id: Now.ID["set_outputs"], annotation: "Return results" },
  params.outputs,
  { success: true, record: wfa.dataPill(lookup.Record, "reference") }
);
```

Important:

• Every output path should call assignSubflowOutputs -- if a branch is taken that doesn't assign, the caller sees undefined for unassigned fields.
• Values can be literals (true, "text", 42) or data pills.

---


Anti-Patterns

Do NOT forget `assignSubflowOutputs`

If your subflow declares outputs, you must call assignSubflowOutputs on every reachable path. Without it, the caller receives undefined.

Do NOT add a trigger

Subflows are invoked, not triggered. Adding trigger-like logic is incorrect -- promote the logic to a regular Flow instead.

Do NOT construct a custom outputs object

assignSubflowOutputs(..., params.outputs, ...) -- always pass params.outputs. Building a literal object breaks the type binding and the runtime expects the schema reference.

Do NOT put `waitForCompletion` in `instanceConfig`

waitForCompletion belongs in the inputs object (third argument), not the instance config (second argument). Misplacing it causes a silent type error.

Do NOT assign data pills to const variables

Same rule as flows -- data pills are evaluated at runtime by the platform. Capturing them in a local const and reusing the variable does not work the way it does in JavaScript.

---


Patterns

Basic Subflow

```typescript fluent
import { Subflow, wfa, action } from "@servicenow/sdk/automation";
import { StringColumn, BooleanColumn } from "@servicenow/sdk/core";

export const checkRecordExists = Subflow(
  {
    $id: Now.ID["check_record_exists"],
    name: "Check Record Exists",
    runAs: "system",
    inputs: {
      table: StringColumn({ label: "Table Name", mandatory: true }),
      sysId: StringColumn({ label: "Record Sys ID", mandatory: true })
    },
    outputs: {
      exists: BooleanColumn({ label: "Record Exists", mandatory: true })
    }
  },
  params => {
    const lookup = wfa.action(
      action.core.lookUpRecord,
      { $id: Now.ID["lookup"] },
      {
        table_name: wfa.dataPill(params.inputs.table, "string"),
        conditions: `sys_id=${wfa.dataPill(params.inputs.sysId, "string")}`
      }
    );

    wfa.flowLogic.if(
      {
        $id: Now.ID["found"],
        condition: `${wfa.dataPill(lookup.Record.sys_id, "string")}ISNOTEMPTY`
      },
      () => {
        wfa.flowLogic.assignSubflowOutputs(
          { $id: Now.ID["set_true"] },
          params.outputs,
          { exists: true }
        );
      }
    );

    wfa.flowLogic.else({ $id: Now.ID["not_found"] }, () => {
      wfa.flowLogic.assignSubflowOutputs(
        { $id: Now.ID["set_false"] },
        params.outputs,
        { exists: false }
      );
    });
  }
);
```

Invoking from a Flow

```typescript fluent
import { Flow, wfa, trigger, action } from "@servicenow/sdk/automation";
import { checkRecordExists } from "./check-record-exists.now";

Flow(
  { $id: Now.ID["safe_update_flow"], name: "Safe Update Flow", runAs: "system" },
  wfa.trigger(
    trigger.record.updated,
    { $id: Now.ID["trigger"] },
    {
      table: "incident",
      condition: "active=true",
      run_flow_in: "background",
      trigger_strategy: "unique_changes"
    }
  ),
  params => {
    const check = wfa.subflow(
      checkRecordExists,
      { $id: Now.ID["check_instance"] },
      {
        table: "sys_user",
        sysId: wfa.dataPill(params.trigger.current.assigned_to, "string"),
        waitForCompletion: true
      }
    );

    wfa.flowLogic.if(
      {
        $id: Now.ID["if_exists"],
        condition: `${wfa.dataPill(check.exists, "boolean")}=true`
      },
      () => {
        wfa.action(
          action.core.log,
          { $id: Now.ID["log_ok"] },
          { log_level: "info", log_message: "Assigned user verified -- proceeding with update" }
        );
      }
    );
  }
);
```

Subflow with Complex Branching

A subflow that validates a record and returns both a flag and an error message.

```typescript fluent
import { Subflow, wfa, action } from "@servicenow/sdk/automation";
import { StringColumn, BooleanColumn } from "@servicenow/sdk/core";

export const validateRecordSubflow = Subflow(
  {
    $id: Now.ID["validate_record_subflow"],
    name: "Validate Record Subflow",
    runAs: "system",
    inputs: {
      table: StringColumn({ label: "Table Name", mandatory: true }),
      recordSysId: StringColumn({ label: "Record Sys ID", mandatory: true })
    },
    outputs: {
      isValid: BooleanColumn({ label: "Is Valid", mandatory: true }),
      errorMessage: StringColumn({ label: "Error Message" })
    }
  },
  params => {
    const lookup = wfa.action(
      action.core.lookUpRecord,
      { $id: Now.ID["lookup_record"] },
      {
        table_name: wfa.dataPill(params.inputs.table, "string"),
        conditions: `sys_id=${wfa.dataPill(params.inputs.recordSysId, "string")}`
      }
    );

    wfa.flowLogic.if(
      {
        $id: Now.ID["check_found"],
        condition: `${wfa.dataPill(lookup.Record.sys_id, "string")}ISNOTEMPTY`
      },
      () => {
        wfa.flowLogic.assignSubflowOutputs(
          { $id: Now.ID["assign_valid"] },
          params.outputs,
          { isValid: true, errorMessage: "" }
        );
      }
    );

    wfa.flowLogic.else({ $id: Now.ID["record_not_found"] }, () => {
      wfa.flowLogic.assignSubflowOutputs(
        { $id: Now.ID["assign_invalid"] },
        params.outputs,
        { isValid: false, errorMessage: "Record not found" }
      );
    });
  }
);
```

Minimal Subflow (No Body)

Valid for stub definitions, or when the body is defined elsewhere.

```typescript fluent
import { Subflow } from "@servicenow/sdk/automation";
import { StringColumn, BooleanColumn } from "@servicenow/sdk/core";

export const placeholderSubflow = Subflow({
  $id: Now.ID["placeholder"],
  name: "Placeholder Subflow",
  inputs: {
    recordId: StringColumn({ label: "Record ID", mandatory: true })
  },
  outputs: {
    success: BooleanColumn({ label: "Success" })
  }
});
```

Nested Object Inputs (FlowObject)

When inputs contain structured data, use FlowObject so nested fields remain typed at the call site and inside the body.

```typescript fluent
import { Subflow, wfa, FlowObject } from "@servicenow/sdk/automation";
import { StringColumn, IntegerColumn, BooleanColumn } from "@servicenow/sdk/core";

export const processRequestSubflow = Subflow(
  {
    $id: Now.ID["process_request_subflow"],
    name: "Process Request Subflow",
    runAs: "system",
    inputs: {
      request: FlowObject({
        label: "Request",
        mandatory: true,
        fields: {
          title: StringColumn({ label: "Title", mandatory: true }),
          priority: IntegerColumn({ label: "Priority" })
        }
      })
    },
    outputs: {
      accepted: BooleanColumn({ label: "Accepted", mandatory: true })
    }
  },
  params => {
    wfa.flowLogic.if(
      {
        $id: Now.ID["high_priority"],
        condition: `${wfa.dataPill(params.inputs.request.priority, "integer")}<=2`
      },
      () => {
        wfa.flowLogic.assignSubflowOutputs(
          { $id: Now.ID["accept"] },
          params.outputs,
          { accepted: true }
        );
      }
    );

    wfa.flowLogic.else({ $id: Now.ID["reject"] }, () => {
      wfa.flowLogic.assignSubflowOutputs(
        { $id: Now.ID["set_false"] },
        params.outputs,
        { accepted: false }
      );
    });
  }
);
```

---


Important Notes

• Subflows live in the fluent/flows/ directory (same as flows).
• Always export as export const for cross-file use.
• Subflows support full flow logic: wfa.action(), all wfa.flowLogic.* constructs, nested wfa.subflow().
• assignSubflowOutputs is the only way to set output values; pass params.outputs as the second argument.
• waitForCompletion goes in the inputs object (third argument), not the instanceConfig.
• For cross-application invocation where the subflow definition is not importable, pass the sys_id string as the first argument to wfa.subflow() (untyped fallback).
• TemplateValue, Time, and Duration are available globally -- do not import.
• For when to use named stages inside a subflow body, see the Flow Logic Guide.
