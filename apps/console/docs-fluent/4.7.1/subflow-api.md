# subflow-api

Tags: subflow, flow, automation, reusable, wfa.subflow, assignSubflowOutputs, FlowObject, FlowArray, flowVariables, runAs, runWithRoles

Subflow

API reference for the Subflow() constructor, the wfa.subflow() invocation helper, and the wfa.flowLogic.assignSubflowOutputs() output helper.

Subflows are reusable units of automation with typed inputs and outputs. They are invoked from inside a Flow or another Subflow via wfa.subflow() -- they have no trigger of their own.

---


Subflow()

Defines a reusable callable subflow with typed inputs, typed outputs, and an optional body.

Signature

```typescript fluent
Subflow<TInputs, TOutputs, TFlowVariables, TStages>(
  config: SubflowConfig<TInputs, TOutputs, TFlowVariables, TStages>,
  body?: (params: {
    inputs: TInputs,
    outputs: TOutputs,
    flowVariables: TFlowVariables,
    stages: TStages
  }) => void
): Subflow<TInputs, TOutputs>
```

Config Parameters

| Parameter          | Type                                | Default    | Required | Description                                                                |
| ------------------ | ----------------------------------- | ---------- | -------- | -------------------------------------------------------------------------- |
| $id              | string / Now.ID[...]            | -          | Yes      | Unique identifier                                                          |
| name             | string                            | -          | Yes      | Display name shown in Flow Designer                                        |
| description      | string                            | -          | No       | What the subflow does                                                      |
| annotation       | string                            | -          | No       | Annotation text visible on the designer canvas                             |
| runAs            | 'system' \| 'user'              | -          | No       | Execution context. 'system' bypasses ACLs                                |
| runWithRoles     | (string \| Role)[]                | []       | No       | Role sys_ids or Role objects granting temporary elevated permissions |
| flowPriority     | 'LOW' \| 'MEDIUM' \| 'HIGH'   | -          | No       | Execution queue priority                                                   |
| protectionPolicy | 'read' \| ''                    | ''       | No       | If 'read', subflow body is read-protected in the runtime                 |
| access           | 'public' \| 'package_private'   | 'public' | No       | Visibility scope                                                           |
| category         | string                            | -          | No       | Grouping category in Flow Designer                                         |
| inputs           | Record<string, Column>            | {}       | No       | Input schema; passed by the caller via wfa.subflow()                     |
| outputs          | Record<string, Column>            | {}       | No       | Output schema; set inside body via assignSubflowOutputs                  |
| flowVariables    | Record<string, Column>            | {}       | No       | Internal variables scoped to this subflow execution                        |
| stages           | Record<string, FlowStageConfig>   | {}       | No       | Named stage declarations for tracking subflow execution progress. Each key must match the value field inside the corresponding FlowStage() call |

Body Function

The body is optional. When supplied, it receives a params object exposing the typed schemas:

| params key    | Type             | Description                                                              |
| --------------- | ---------------- | ------------------------------------------------------------------------ |
| inputs        | TInputs        | Typed input pills (use wfa.dataPill(params.inputs.field, 'type'))      |
| outputs       | TOutputs       | Output schema reference. Pass this to assignSubflowOutputs         |
| flowVariables | TFlowVariables | Internal mutable variables (read via data pill, write via setFlowVariables) |
| stages        | TStages        | Named stages declared in the config. Activate via wfa.stage(params.stages.x) |

The body may contain wfa.action(), wfa.flowLogic.*, and nested wfa.subflow() calls.

Subflow(config) with no body is valid -- useful for stub definitions or cross-file references.

---


wfa.subflow()

Invokes a subflow from inside a Flow body or another Subflow body.

Signature (typed)

```typescript fluent
wfa.subflow<TInputs, TOutputs>(
  subflow: Subflow<TInputs, TOutputs>,
  instanceConfig: {
    $id: string,
    annotation?: string,
    uuid?: string,
    showSubflowStage?: boolean
  },
  inputs: TInputs & { waitForCompletion?: boolean }
): TOutputs & { type: 'subflow' }
```

Signature (sys_id fallback)

When the subflow's typed definition cannot be imported (cross-application or unresolvable), pass the subflow's sys_id string directly. The return type allows arbitrary property access for downstream data pill references.

```typescript fluent
wfa.subflow(
  subflowSysId: string,
  instanceConfig: { $id: string, annotation?: string, ... },
  inputs: Record<string, any> & { waitForCompletion?: boolean }
)
```

Parameters

| Parameter             | Type                          | Default | Required | Description                                                                                    |
| --------------------- | ----------------------------- | ------- | -------- | ---------------------------------------------------------------------------------------------- |
| subflow             | Subflow \| string (sys_id) | -       | Yes      | Exported subflow constant or a string sys_id when the definition is not importable        |
| instanceConfig.$id  | string                      | -       | Yes      | Unique identifier for this invocation instance                                                 |
| annotation          | string                      | -       | No       | Description of this specific invocation                                                        |
| uuid                | string                      | -       | No       | Stable UUID for this instance (rarely set by hand; usually generated)                          |
| showSubflowStage    | boolean                     | -       | No       | If true, a dedicated sys_hub_flow_stage of type: 'subflow' is created for this instance |
| inputs              | TInputs                     | -       | Yes      | Input values matching the subflow's input schema                                               |
| waitForCompletion   | boolean                     | false | No       | If true, the caller waits for the subflow to complete before continuing. Belongs inside the inputs object, not instanceConfig |

Return Value

Returns a typed output object. Access output fields as data pills:

```typescript fluent
const result = wfa.subflow(mySubflow, { $id: Now.ID["instance"] }, { ... });
wfa.dataPill(result.outputField, "string");      // use output in downstream actions
wfa.dataPill(result.recordOutput, "reference");
```

---


wfa.flowLogic.assignSubflowOutputs()

Sets the subflow's output values. Must be called inside the subflow body for outputs to be visible to the caller.

Signature

```typescript fluent
wfa.flowLogic.assignSubflowOutputs(
  definition: { $id: string, annotation?: string },
  outputSchema: TOutputs,        // always pass params.outputs
  values: Partial<TOutputs>      // fields to assign; omitted fields are undefined
)
```

Parameters

| Parameter      | Type                | Required | Description                                                              |
| -------------- | ------------------- | -------- | ------------------------------------------------------------------------ |
| $id          | string            | Yes      | Unique identifier for this assignment node                               |
| annotation   | string            | No       | Description/comment                                                      |
| outputSchema | TOutputs          | Yes      | Always pass params.outputs -- do not construct a custom object     |
| values       | Partial<TOutputs> | Yes      | Key/value pairs to assign. Values may be literals or data pills          |

⚠️ Type-only helper. This call is erased at runtime; it exists for compile-time type safety. The actual runtime assignment happens in the underlying flow stage.

---


Column Types

Import from @servicenow/sdk/core for inputs, outputs, and flowVariables schemas:

| Type              | Description                              |
| ----------------- | ---------------------------------------- |
| StringColumn    | Text values                              |
| IntegerColumn   | Whole numbers                            |
| BooleanColumn   | True/false values                        |
| DecimalColumn   | Decimal numbers (fixed precision)        |
| FloatColumn     | Floating-point numbers                   |
| DateTimeColumn  | Date and time values                     |
| ReferenceColumn | Reference to a ServiceNow table record   |
| GenericColumn   | Flexible type via columnType property  |
| JsonColumn      | JSON string values                       |

Import from @servicenow/sdk/automation for complex types:

| Type         | Description                                              |
| ------------ | -------------------------------------------------------- |
| FlowObject | Nested object with typed fields                        |
| FlowArray  | Array of typed elements (use with elementType)         |

FlowObject example

```typescript fluent
import { FlowObject } from "@servicenow/sdk/automation";
import { StringColumn, IntegerColumn } from "@servicenow/sdk/core";

inputs: {
  requestData: FlowObject({
    label: "Request Data",
    mandatory: false,
    fields: {
      title: StringColumn({ label: "Title" }),
      priority: IntegerColumn({ label: "Priority" })
    }
  })
}

// Access a nested field inside the body:
// wfa.dataPill(params.inputs.requestData.title, "string")
```

---

For complete examples, usage patterns, best practices, and anti-patterns, see the Subflow Guide.
