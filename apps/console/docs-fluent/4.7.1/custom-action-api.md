# custom-action-api

Tags: Action, custom action, action definition, actionStep, wfa.actionStep, reusable action, sys_hub_action_type_definition, assignActionOutputs, wfa.assignActionOutputs, action outputs, output assignment, errorEvaluation, wfa.errorEvaluation, error evaluation

Custom Action

API reference for the Action() constructor, the wfa.actionStep() invocation helper for embedding OOB steps, and the wfa.assignActionOutputs() output helper.

Custom actions are reusable units of work composed of sequential OOB steps. They are invoked from a Flow or Subflow via wfa.action() -- the same helper used for built-in action.core.* actions.

---


Action()

Defines a reusable custom action with typed inputs, typed outputs, and a body of sequential wfa.actionStep() calls.

Signature

```typescript fluent
Action<TInputs, TOutputs>(
  config: ActionConfig<TInputs, TOutputs>,
  body?: (params: {
    inputs: TInputs,
    outputs: TOutputs
  }) => void
): Action<TInputs, TOutputs>
```

Config Parameters

| Parameter          | Type                              | Default    | Required | Description                                                              |
| ------------------ | --------------------------------- | ---------- | -------- | ------------------------------------------------------------------------ |
| $id              | string / Now.ID[...]          | -          | Yes      | Unique identifier                                                        |
| name             | string                          | -          | Yes      | Display name for the action                                              |
| description      | string                          | -          | No       | Detailed description visible to flow developers                          |
| annotation       | string                          | -          | No       | Default annotation text when this action is used in a flow               |
| category         | string                          | -          | No       | Grouping category (e.g., "incident_management", "provisioning")      |
| access           | 'public' \| 'package_private' | 'public' | No       | Visibility scope                                                         |
| protectionPolicy | 'read' \| ''                  | ''       | No       | If 'read', the action body is read-protected in the runtime            |
| inputs           | Record<string, Column>          | -          | Yes      | Input parameter definitions using column types                           |
| outputs          | Record<string, Column>          | -          | Yes      | Output parameter definitions using column types                          |

⚠️ access value: The valid scope-private value is 'package_private' (not 'private'). Other values fail at build time.

Body Function

The body is optional and receives a params object exposing the typed schemas:

| params key | Type       | Description                                                                       |
| ------------ | ---------- | --------------------------------------------------------------------------------- |
| inputs     | TInputs  | Typed input pills. Use wfa.dataPill(params.inputs.field, 'type')                |
| outputs    | TOutputs | Output schema reference. Pass to assignActionOutputs to set the action's outputs |

The body contains only wfa.actionStep() calls and (optionally) one assignActionOutputs call. No flow logic, no nested custom actions.

---


wfa.actionStep()

Embeds an OOB step inside a custom action body.

Signature (typed step)

```typescript fluent
wfa.actionStep<TStep>(
  step: TStep,                                            // actionStep.* namespace
  config: {
    $id: string,
    label?: string,
    annotation?: string
  },
  inputs: StepParameters<TStep> & {
    errorHandlingType?: 'stop_the_action' | 'dont_stop_the_action',
    inputVariables?: ExtendedInputConfig,    // only if step allows extended inputs
    outputVariables?: Record<string, Column> // only if step allows extended outputs
  }
): StepOutputs<TStep>
```

Signature (sys_id fallback)

When a step's typed definition isn't available (custom step from another app), pass the step's sys_id (or name) as a string. The return type allows arbitrary property access.

```typescript fluent
wfa.actionStep(
  stepSysId: string,
  config: { $id: string, label?: string },
  inputs: Record<string, unknown> & { errorHandlingType?: ... }
)
```

Config Parameters

| Field        | Type     | Default | Required | Description                          |
| ------------ | -------- | ------- | -------- | ------------------------------------ |
| $id        | string | -       | Yes      | Unique identifier for this step instance |
| label      | string | -       | No       | Display label for this step instance |
| annotation | string | -       | No       | Additional notes or description      |

Common Step Parameters

Supported by all wfa.actionStep() calls (passed alongside step-specific fields in the third argument):

| Parameter           | Type     | Default | Description                                                                                                          |
| ------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| errorHandlingType | choice | -       | 'stop_the_action' halts on error; 'dont_stop_the_action' continues execution on error                            |
| inputVariables    | object | -       | Named input variables (only allowed when the step's allowExtendedInputs is true; e.g., actionStep.script)      |
| outputVariables   | object | -       | Named output variables (only allowed when the step's allowExtendedOutputs is true; e.g., actionStep.script)    |

Return Value

Returns the step's typed outputs. Capture as a const to chain into downstream steps via wfa.dataPill().

```typescript fluent
const created = wfa.actionStep(actionStep.createRecord, { $id: ... }, { ... });
// downstream:
wfa.actionStep(
  actionStep.log,
  { $id: ... },
  { log_message: wfa.dataPill(created.record.number, "string"), log_level: "info" }
);
```

---


wfa.assignActionOutputs()

Assigns output values inside a custom Action body, mapping declared output names to static values, datapill references, or template literals. This is the recommended way to set action outputs based on step results and input values.

```typescript fluent
wfa.assignActionOutputs(params.outputs, values)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| params.outputs | Output schema | The output schema from params.outputs in the action body function. Provides type-safe key completion. |
| values | { [K in keyof Outputs]?: Outputs[K] \| string } | Partial record mapping output names to their values. Keys are constrained to declared output names — arbitrary keys produce a TypeScript error. |

Value Types

Output values support three formats:

| Format | Example | Use Case |
|--------|---------|----------|
| Static string | 'test value' | Fixed values known at design time |
| Data pill | wfa.dataPill(step.record.field, 'string') | Dynamic reference to a step output or action input |
| Template literal | ` prefix${wfa.dataPill(step.field, 'string')} ` | Mix of static text and dynamic references |

Important notes:
• Placement: Call wfa.assignActionOutputs() after all wfa.actionStep() calls in the action body. If using wfa.errorEvaluation(), place output assignment after it.
• Type safety: Output keys are constrained to the names declared in the action's outputs configuration. TypeScript provides autocomplete (Ctrl+Space) for valid output names.
• Partial assignment: Not all outputs need to be assigned — the values parameter accepts a partial record.
• Boolean values: Use '1' for true and '0' for false when assigning boolean output values as static strings.

---


wfa.errorEvaluation()

Defines runtime error evaluation conditions for a custom Action. Conditions are evaluated in order — the first matching condition sets the action's status code and message. Use this to report conditional success or failure based on step results and input values.

```typescript fluent
wfa.errorEvaluation(conditions)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| conditions | ErrorEvaluationCondition[] | Array of conditions evaluated in order. The first matching condition's status is applied. |

ErrorEvaluationCondition

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| label | string | Yes | Display label for the condition (visible in Flow Designer). |
| condition | string | Yes | Query-style condition string. Supports datapill references via template literals. |
| status | { code, message } | Yes | The status to set when this condition matches. |
| status.code | number \| string | Yes | Status code. Can be a static number or a template expression with datapills. |
| status.message | string | Yes | Status message. Can be a static string or a template expression with datapills. |
| dontTreatAsError | boolean | No | When true, the action does not treat this condition as an error. Defaults to false. |

Condition Syntax

Condition strings use ServiceNow encoded query syntax. Operators are joined with ^ (AND) and ^OR (OR). Values can include datapill references via template literals.

```typescript fluent
// Simple equality check on step status code
condition: `${wfa.dataPill(step.__step_status__.code, 'integer')}=500` 

// OR condition
condition: `${wfa.dataPill(step.__step_status__.code, 'integer')}=500^OR${wfa.dataPill(step.__step_status__.code, 'integer')}=501` 

// ISNOTEMPTY check
condition: `${wfa.dataPill(params.inputs.incident, 'reference')}ISNOTEMPTY` 
```

Important notes:
• Evaluation order: Conditions are evaluated in the order they appear in the array. The first matching condition wins — subsequent conditions are not evaluated.
• Placement: Call wfa.errorEvaluation() after all wfa.actionStep() calls but before wfa.assignActionOutputs().
• dontTreatAsError: When true, the matching condition sets the status but the action is considered successful. When false (default), the action is treated as failed.
• No match: If no condition matches, the action completes with its default status — wfa.errorEvaluation() does not alter it.
• Step vs action error handling: errorHandlingType on individual wfa.actionStep() calls controls step-level behavior (stop or continue). wfa.errorEvaluation() sets the overall action status based on conditions evaluated after all steps complete.

---


DefaultActionOutputs

Every action invocation -- built-in (action.core.*) and custom -- exposes these system outputs in addition to the action's declared outputs:

| Field                     | Type      | Description                                                              |
| ------------------------- | --------- | ------------------------------------------------------------------------ |
| __action_status__.code  | number  | Status code of the action execution                                      |
| __action_status__.message | string | Status message describing the result                                     |
| __dont_treat_as_error__ | boolean | If true, an error result will not propagate as an error to the caller  |

Useful for inspecting an action's runtime status without modeling it in the action's declared outputs.

---


Column Types

Import from @servicenow/sdk/core for inputs and outputs schemas:

| Type              | Description                              |
| ----------------- | ---------------------------------------- |
| StringColumn    | Text values                              |
| IntegerColumn   | Whole numbers                            |
| BooleanColumn   | True/false values                        |
| DecimalColumn   | Decimal numbers (fixed precision)        |
| FloatColumn     | Floating-point numbers                   |
| DateColumn      | Date-only values                         |
| DateTimeColumn  | Date and time values                     |
| ReferenceColumn | Reference to a ServiceNow table record   |
| ChoiceColumn    | Choice list values                       |

Import from @servicenow/sdk/automation for complex types:

| Type         | Description                                         |
| ------------ | --------------------------------------------------- |
| FlowObject | Nested object with typed fields                   |
| FlowArray  | Array of typed elements (use with elementType)    |

---


actionStep namespace

OOB steps that can be embedded inside a custom action body via wfa.actionStep(). Step parameter shapes are documented per step below.

Step parameter naming inconsistencies

Different OOB steps use different parameter-naming conventions; mistyping a parameter name is a common error.

| Step                                      | Table parameter   | Record parameter | Values parameter             | Notes                                              |
| ----------------------------------------- | ----------------- | ---------------- | ---------------------------- | -------------------------------------------------- |
| actionStep.createRecord                 | create_record_table_name | -      | create_record_field_values | create_record_* prefix                           |
| actionStep.createTask                   | create_record_table_name | -      | create_record_field_values | create_record_* prefix                           |
| actionStep.createRecordForRemoteTable   | create_record_table_name | -      | create_record_field_values | create_record_* prefix + query_id              |
| actionStep.updateRecord                 | table_name      | record         | update_record_field_values | update_record_* prefix on values                 |
| actionStep.updateMultipleRecords        | table_name      | -                | field_values               | No prefix on values                                |
| actionStep.createOrUpdateRecord         | table           | -                | fields                     | Both unprefixed                                    |
| actionStep.deleteRecord                 | table_name      | record         | -                            | -                                                  |
| actionStep.deleteMultipleRecords        | table_name      | -                | -                            | Uses conditions                                  |
| actionStep.lookUpRecord                 | lookup_table_name | -              | -                            | lookup_* prefix on table                         |
| actionStep.lookUpRecords                | table_name      | -                | -                            | -                                                  |
| actionStep.fireEvent                    | table           | record         | -                            | event_name (string)                              |
| actionStep.waitForCondition             | table_name      | record         | -                            | timeout_flag + timeout_duration                |
| actionStep.askForApproval               | table           | record         | -                            | approval_conditions mandatory                    |
| actionStep.email                        | table_name      | record         | -                            | Plain to/subject/body -- NOT ah_* prefix  |
| actionStep.notification                 | table_name      | record         | -                            | notification reference                           |

---


ServiceNow Data Steps

actionStep.askForApproval

Requests approval from users, groups, or manual approvers on a given record using rule sets. Blocking -- pauses the action until the approval reaches a final state.

Parameters:

| Parameter             | Type                | Required | Description                                                                   |
| --------------------- | ------------------- | -------- | ----------------------------------------------------------------------------- |
| table               | Table Name        | No       | Table of the record being approved                                            |
| record              | Document ID       | Yes      | Record to request approval on; dependent on table                           |
| approval_conditions | Approval Rules    | Yes      | Rule set defining who must approve and under what conditions                  |
| approval_reason     | string            | No       | Reason displayed to approvers                                                 |
| due_date            | Schedule DateTime | No       | Deadline by which approval must be completed                                  |
| approval_field      | Field Name        | No       | Field on the record that stores the approval state                            |
| journal_field       | Field Name        | No       | Field on the record that stores approval comments/journal entries             |

Outputs:

| Field   | Type     | Description                                                          |
| ------- | -------- | -------------------------------------------------------------------- |
| state | choice | 'approved', 'rejected', or 'cancelled'                         |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.askForApproval,
  { $id: Now.ID["request_approval"], label: "Request manager approval" },
  {
    table: "change_request",
    record: wfa.dataPill(params.inputs.changeRecord, "reference"),
    approval_conditions: "...",                     // see wfa.approvalRules() for builder
    approval_reason: "Manager sign-off required",
    due_date: "2025-12-31 17:00:00"
  }
);
```

---

actionStep.createRecord

Creates a new record on a ServiceNow table.

Parameters:

| Parameter                    | Type            | Default | Required | Description                                                                       |
| ---------------------------- | --------------- | ------- | -------- | --------------------------------------------------------------------------------- |
| create_record_table_name   | Table Name    | -       | No       | Target table name ("incident", "task", etc.)                                  |
| create_record_field_values | TemplateValue | -       | No       | Field values as TemplateValue({...}); dependent on create_record_table_name   |
| skip_insert                | boolean       | false | No       | If true, skips the actual record insert (dry-run testing)                       |

Outputs:

| Field        | Type          | Description                                                |
| ------------ | ------------- | ---------------------------------------------------------- |
| table_name | Table Name  | The table the record was created in                        |
| record     | Document ID | Reference to the created record; dependent on table_name |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.createRecord,
  { $id: Now.ID["create_incident"], label: "Create incident" },
  {
    create_record_table_name: "incident",
    create_record_field_values: TemplateValue({
      short_description: wfa.dataPill(params.inputs.summary, "string"),
      priority: "2"
    })
  }
);
```

---

actionStep.createTask

Creates a task record. Optionally pauses the action until the task reaches a completed state.

Parameters:

| Parameter                    | Type            | Default | Required | Description                                                                       |
| ---------------------------- | --------------- | ------- | -------- | --------------------------------------------------------------------------------- |
| create_record_table_name   | string        | -       | No       | Target task table ("incident", "sc_task", "change_request", etc.)           |
| create_record_field_values | TemplateValue | -       | No       | Field values as TemplateValue({...}); dependent on create_record_table_name   |
| wait                       | boolean       | false | No       | If true, the action pauses until the task reaches a completed state             |
| skip_insert                | boolean       | false | No       | If true, skips the actual record insert (dry-run testing)                       |

Outputs:

| Field   | Type          | Description                                                |
| ------- | ------------- | ---------------------------------------------------------- |
| table | string      | The table the task was created in                          |
| task  | Document ID | Reference to the created task record; dependent on table |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.createTask,
  { $id: Now.ID["create_review_task"], label: "Create review task" },
  {
    create_record_table_name: "sc_task",
    create_record_field_values: TemplateValue({
      short_description: "Review access request",
      assignment_group: wfa.dataPill(params.inputs.fulfillment_group, "reference"),
      priority: "2"
    }),
    wait: true                                       // pause until task closes
  }
);
```

---

actionStep.createOrUpdateRecord

Creates or updates a record on a given table.

Parameters:

| Parameter | Type            | Required | Description                                                           |
| --------- | --------------- | -------- | --------------------------------------------------------------------- |
| table   | Table Name    | No       | Target table name                                                     |
| fields  | TemplateValue | No       | Field values as TemplateValue({...}); dependent on table          |

Outputs:

| Field           | Type          | Description                                                                  |
| --------------- | ------------- | ---------------------------------------------------------------------------- |
| record        | Document ID | Reference to the created or updated record; dependent on table             |
| table_name    | Table Name  | The table the record was written to                                          |
| status        | choice      | Result status indicating whether the record was created or updated           |
| error_message | string      | Error details if the operation failed due to business rules or data policies |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.createOrUpdateRecord,
  { $id: Now.ID["upsert_ci"], label: "Create or update CMDB CI" },
  {
    table: "cmdb_ci_server",
    fields: TemplateValue({
      name: "web-server-01",                         // unique-identifier field
      ip_address: "10.0.0.1",
      operational_status: "1"
    })
  }
);
```

---

actionStep.createRecordForRemoteTable

Creates a record on a Remote Table (IntegrationHub virtual table) within custom action execution.

Parameters:

| Parameter                    | Type            | Required | Description                                                                     |
| ---------------------------- | --------------- | -------- | ------------------------------------------------------------------------------- |
| query_id                   | string        | Yes      | Identifier for the remote table query context                                   |
| create_record_table_name   | Table Name    | No       | Target remote table name                                                        |
| create_record_field_values | TemplateValue | No       | Field values as TemplateValue({...}); dependent on create_record_table_name |

Outputs:

| Field        | Type         | Description                                |
| ------------ | ------------ | ------------------------------------------ |
| table_name | Table Name | The remote table the record was created in |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.createRecordForRemoteTable,
  { $id: Now.ID["create_remote"], label: "Create record in external system" },
  {
    query_id: "my_remote_query_id",
    create_record_table_name: "x_my_remote_table",
    create_record_field_values: TemplateValue({
      name: "New Record",
      status: "active"
    })
  }
);
```

---

actionStep.deleteRecord

Deletes a single record. No outputs.

Parameters:

| Parameter    | Type          | Required | Description                                                           |
| ------------ | ------------- | -------- | --------------------------------------------------------------------- |
| table_name | Table Name  | No       | Table containing the record to delete                                 |
| record     | Document ID | No       | Record to delete; dependent on table_name                           |

Outputs: None.

Example:

```typescript fluent
wfa.actionStep(
  actionStep.deleteRecord,
  { $id: Now.ID["delete_temp"], label: "Delete temporary record" },
  {
    table_name: "u_staging_table",
    record: wfa.dataPill(params.inputs.staging_record, "reference")
  }
);
```

---

actionStep.deleteMultipleRecords

Deletes multiple records matching specified conditions.

Parameters:

| Parameter                 | Type         | Required | Description                                                          |
| ------------------------- | ------------ | -------- | -------------------------------------------------------------------- |
| table_name              | Table Name | Yes      | Table to delete records from                                         |
| conditions              | Conditions | Yes      | Filter conditions identifying which records to delete                |
| set_workflow            | boolean    | No       | If true, runs business rules and workflows for each deleted record |
| dont_fail_flow_on_error | boolean    | No       | If true, the action continues even if the delete operation fails   |
| sort_column             | Field Name | No       | Field to order records by before deletion                            |
| sort_type               | choice     | No       | 'sort_asc' (a → z) or 'sort_desc' (z → a)                        |

Outputs:

| Field           | Type      | Description                                                                  |
| --------------- | --------- | ---------------------------------------------------------------------------- |
| status        | choice  | Result status of the delete operation                                        |
| count         | integer | Number of records successfully deleted                                       |
| error_message | string  | Error details if the operation failed due to business rules or data policies |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.deleteMultipleRecords,
  { $id: Now.ID["delete_expired"], label: "Delete expired staging records" },
  {
    table_name: "u_staging_table",
    conditions: "active=false^sys_created_on<javascript:gs.daysAgoStart(7)",
    dont_fail_flow_on_error: true,
    sort_column: "sys_created_on",
    sort_type: "sort_asc"
  }
);
```

---

actionStep.fireEvent

Fires a registered ServiceNow event against a record. No outputs.

Parameters:

| Parameter    | Type          | Required | Description                                                  |
| ------------ | ------------- | -------- | ------------------------------------------------------------ |
| table      | Table Name  | No       | Table of the record the event is fired against               |
| record     | Document ID | Yes      | The record the event is fired against; dependent on table  |
| event_name | reference   | Yes      | The registered event to fire (sysevent_register)           |
| parm1      | string      | No       | First parameter passed to the event                          |
| parm2      | string      | No       | Second parameter passed to the event                         |

Outputs: None.

Example:

```typescript fluent
wfa.actionStep(
  actionStep.fireEvent,
  { $id: Now.ID["fire_escalation"], label: "Fire escalation event" },
  {
    table: "incident",
    record: wfa.dataPill(params.inputs.incident, "reference"),
    event_name: "incident.escalated",
    parm1: "manager_sys_id",
    parm2: "Escalated due to SLA breach"
  }
);
```

---

actionStep.lookUpRecord

Looks up a single record meeting a search condition.

Parameters:

| Parameter                 | Type         | Required | Description                                                                   |
| ------------------------- | ------------ | -------- | ----------------------------------------------------------------------------- |
| lookup_table_name       | Table Name | No       | Table to search                                                               |
| conditions              | Conditions | No       | Filter conditions to identify the target record                               |
| multiple_records_found  | choice     | No       | 'use_first_record' or 'error' when multiple records match                 |
| sort_column             | Field Name | No       | Field to order results by when selecting the first record                     |
| sort_type               | choice     | No       | 'sort_asc' or 'sort_desc'                                                 |
| dont_fail_flow_on_error | boolean    | No       | If true, the action continues even if no record is found or an error occurs |

Outputs:

| Field           | Type          | Description                                                            |
| --------------- | ------------- | ---------------------------------------------------------------------- |
| status        | choice      | Result status of the lookup operation                                  |
| table_name    | Table Name  | The table the record was found in                                      |
| record        | Document ID | Reference to the found record; dependent on table_name               |
| error_message | string      | Error details if the lookup failed or no record matched                |

Example:

```typescript fluent
const lookup = wfa.actionStep(
  actionStep.lookUpRecord,
  { $id: Now.ID["lookup_p1"], label: "Look up open P1 incident" },
  {
    lookup_table_name: "incident",
    conditions: "priority=1^state=1",
    multiple_records_found: "use_first_record",
    sort_column: "sys_created_on",
    sort_type: "sort_desc",
    dont_fail_flow_on_error: true
  }
);
```

---

actionStep.lookUpRecords

Returns the count and a set of records matching a search condition.

Parameters:

| Parameter     | Type         | Required | Description                                                     |
| ------------- | ------------ | -------- | --------------------------------------------------------------- |
| table_name  | Table Name | No       | Table to search                                                 |
| conditions  | Conditions | No       | Filter conditions to narrow which records are returned          |
| limit       | integer    | No       | Maximum number of records to return                             |
| sort_column | Field Name | No       | Field to order results by                                       |
| sort_type   | choice     | No       | 'sort_asc' or 'sort_desc'                                   |

Outputs:

| Field        | Type         | Description                                            |
| ------------ | ------------ | ------------------------------------------------------ |
| records    | Records    | The set of matching records; can be iterated in a flow |
| table_name | Table Name | The table the records were retrieved from              |
| count      | integer    | Number of records returned                             |

Example:

```typescript fluent
const incidents = wfa.actionStep(
  actionStep.lookUpRecords,
  { $id: Now.ID["find_p1s"], label: "Find open high-priority incidents" },
  {
    table_name: "incident",
    conditions: "priority=1^state=1",
    limit: 50,
    sort_column: "sys_created_on",
    sort_type: "sort_asc"
  }
);
```

---

actionStep.updateRecord

Updates an existing record on a given table.

Parameters:

| Parameter                    | Type            | Required | Description                                                                |
| ---------------------------- | --------------- | -------- | -------------------------------------------------------------------------- |
| table_name                 | Table Name    | Yes      | Table containing the record to update                                      |
| record                     | Document ID   | Yes      | Reference to the record to update; dependent on table_name               |
| update_record_field_values | TemplateValue | No       | Field values as TemplateValue({...}); dependent on table_name          |

Outputs:

| Field        | Type          | Description                                                |
| ------------ | ------------- | ---------------------------------------------------------- |
| table_name | Table Name  | The table the record was updated in                        |
| record     | Document ID | Reference to the updated record; dependent on table_name |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.updateRecord,
  { $id: Now.ID["raise_priority"], label: "Update incident priority" },
  {
    table_name: "incident",
    record: wfa.dataPill(params.inputs.incident, "reference"),
    update_record_field_values: TemplateValue({
      priority: "1",
      state: "2",
      assignment_group: wfa.dataPill(params.inputs.escalation_group, "reference")
    })
  }
);
```

---

actionStep.updateMultipleRecords

Updates multiple records matching specified conditions.

Parameters:

| Parameter                 | Type            | Required | Description                                                                |
| ------------------------- | --------------- | -------- | -------------------------------------------------------------------------- |
| table_name              | Table Name    | Yes      | Table to update records in                                                 |
| conditions              | Conditions    | Yes      | Filter conditions identifying which records to update                      |
| field_values            | TemplateValue | Yes      | Field values as TemplateValue({...}); dependent on table_name          |
| set_workflow            | boolean       | No       | If true, runs business rules and workflows for each updated record       |
| set_autosysfields       | boolean       | No       | If true, updates system fields (e.g., sys_updated_on) for each record  |
| dont_fail_flow_on_error | boolean       | No       | If true, the action continues even if the update operation fails         |
| sort_column             | Field Name    | No       | Field to order records by before updating                                  |
| sort_type               | choice        | No       | 'sort_asc' or 'sort_desc'                                              |

Outputs:

| Field           | Type      | Description                                                                  |
| --------------- | --------- | ---------------------------------------------------------------------------- |
| status        | choice  | Result status of the update operation                                        |
| count         | integer | Number of records successfully updated                                       |
| error_message | string  | Error details if the operation failed due to business rules or data policies |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.updateMultipleRecords,
  { $id: Now.ID["bulk_close"], label: "Bulk close completed tasks" },
  {
    table_name: "task",
    conditions: "state=3^assignment_group=<group_sys_id>",
    field_values: TemplateValue({
      state: "7",
      close_notes: "Bulk closed by automated workflow"
    }),
    dont_fail_flow_on_error: true
  }
);
```

---

actionStep.waitForCondition

Pauses the action until a record meets the specified conditions (or a timeout expires). Blocking.

Parameters:

| Parameter          | Type          | Required | Description                                                                |
| ------------------ | ------------- | -------- | -------------------------------------------------------------------------- |
| table_name       | Table Name  | No       | Table of the record to monitor                                             |
| record           | Document ID | Yes      | Record to watch; dependent on table_name                                 |
| conditions       | Conditions  | Yes      | Conditions that must be met on the record before the action resumes        |
| timeout_flag     | boolean     | No       | If true, enables the timeout                                             |
| timeout_duration | Duration    | No       | Time to wait before timing out (used when timeout_flag is true)        |
| timeout_schedule | reference   | No       | Schedule (cmn_schedule) for business-hours timeout calculation           |

Outputs:

| Field   | Type     | Description                                                              |
| ------- | -------- | ------------------------------------------------------------------------ |
| state | choice | Result of the wait: whether the condition was met or the timeout expired |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.waitForCondition,
  { $id: Now.ID["wait_task_done"], label: "Wait for task completion" },
  {
    table_name: "task",
    record: wfa.dataPill(createdTask.task, "reference"),
    conditions: "state=7",
    timeout_flag: true,
    timeout_duration: "172800"                       // 48 hours in seconds
  }
);
```

---

actionStep.waitForEmailReply

Pauses the action until an email reply is received (or a timeout expires). Blocking.

Parameters:

| Parameter          | Type        | Required | Description                                                                     |
| ------------------ | ----------- | -------- | ------------------------------------------------------------------------------- |
| record           | reference | Yes      | The outgoing email record (sys_email) to monitor for a reply                  |
| enable_timeout   | boolean   | No       | If true, enables the timeout                                                  |
| timeout_duration | Duration  | No       | Time to wait before timing out (used when enable_timeout is true)           |
| timeout_schedule | reference | No       | Schedule (cmn_schedule) for business-hours timeout calculation                |

Outputs:

| Field         | Type        | Description                                                             |
| ------------- | ----------- | ----------------------------------------------------------------------- |
| email_reply | reference | Reference to the reply sys_email record when a reply is received      |
| state       | choice    | Result of the wait: whether a reply was received or the timeout expired |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.waitForEmailReply,
  { $id: Now.ID["wait_reply"], label: "Wait for stakeholder reply" },
  {
    record: wfa.dataPill(sentEmail.email, "reference"),
    enable_timeout: true,
    timeout_duration: "172800"                       // 48 hours
  }
);
```

---

actionStep.waitForMessage

Pauses the action until a specific message is received via the ServiceNow Flow API. Blocking.

Parameters:

| Parameter          | Type       | Required | Description                                                               |
| ------------------ | ---------- | -------- | ------------------------------------------------------------------------- |
| message          | string   | Yes      | The message identifier to wait for (sent via the Flow API)                |
| enable_timeout   | boolean  | No       | If true, enables the timeout                                            |
| timeout_duration | Duration | No       | Time to wait before timing out (used when enable_timeout is true)     |

Outputs:

| Field     | Type     | Description                                                 |
| --------- | -------- | ----------------------------------------------------------- |
| payload | string | The payload sent with the message received via the Flow API |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.waitForMessage,
  { $id: Now.ID["wait_signal"], label: "Wait for external confirmation" },
  {
    message: "provisioning_complete",
    enable_timeout: true,
    timeout_duration: "3600"                         // 1 hour
  }
);
```

---


Utility Steps

actionStep.collectActivityContext

Collects data from the flow execution source PAD activity context.

Parameters: None.

Outputs:

| Field              | Type        | Description                                                 |
| ------------------ | ----------- | ----------------------------------------------------------- |
| activity_context | reference | The PAD activity context record (sys_pd_activity_context) |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.collectActivityContext,
  { $id: Now.ID["get_activity_context"], label: "Collect PAD activity context" },
  {}                                                 // takes no inputs
);
```

---

actionStep.createAppFromPayload

Creates a ServiceNow application from a template payload.

Parameters:

| Parameter              | Type     | Required | Description                                            |
| ---------------------- | -------- | -------- | ------------------------------------------------------ |
| template_instance_id | string | Yes      | ID of the application template instance to create from |
| scan_id              | string | No       | Scan configuration ID for template variants            |

Outputs:

| Field        | Type     | Description                                 |
| ------------ | -------- | ------------------------------------------- |
| sys_app_id | string | The sys_id of the newly created application |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.createAppFromPayload,
  { $id: Now.ID["create_app"], label: "Create application from template" },
  {
    template_instance_id: wfa.dataPill(params.inputs.template_id, "string")
  }
);
```

---

actionStep.email

Sends an email from within a custom action. *Uses plain to/subject/body -- not ah_ prefixed parameters (those belong to action.core.sendEmail).**

Parameters:

| Parameter         | Type          | Default | Required | Description                                                |
| ----------------- | ------------- | ------- | -------- | ---------------------------------------------------------- |
| to              | string      | -       | Yes      | Recipient email address(es); comma-separated for multiple  |
| subject         | string      | -       | Yes      | Email subject line                                         |
| body            | HTML        | -       | No       | Email body in HTML format                                  |
| cc              | string      | -       | No       | CC recipient address(es); comma-separated                  |
| bcc             | string      | -       | No       | BCC recipient address(es); comma-separated                 |
| watermark_email | boolean     | false | No       | Include watermark for reply tracking/threading             |
| table_name      | Table Name  | -       | No       | Table of the target record to associate with the email     |
| record          | Document ID | -       | No       | Target record reference; dependent on table_name         |

Outputs:

| Field   | Type        | Description                                      |
| ------- | ----------- | ------------------------------------------------ |
| email | reference | Reference to the sent email record (sys_email) |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.email,
  { $id: Now.ID["send_escalation"], label: "Send escalation notification" },
  {
    to: "manager@example.com",
    subject: "Incident Escalation Required",
    body: "<p>An incident requires your attention.</p>",
    watermark_email: true                            // needed for waitForEmailReply later
  }
);
```

---

actionStep.getLatestResponseTextFromEmail

Extracts the latest response text from an email thread (strips quoted prior content).

Parameters:

| Parameter      | Type        | Required | Description                                                  |
| -------------- | ----------- | -------- | ------------------------------------------------------------ |
| email_record | reference | Yes      | The email record (sys_email) to extract the reply text from |

Outputs:

| Field                  | Type     | Description                                           |
| ---------------------- | -------- | ----------------------------------------------------- |
| latest_response_text | string | The latest reply text extracted from the email thread |

Example:

```typescript fluent
const reply = wfa.actionStep(
  actionStep.getLatestResponseTextFromEmail,
  { $id: Now.ID["extract_reply"], label: "Extract latest email reply" },
  {
    email_record: wfa.dataPill(waitResult.email_reply, "reference")
  }
);
```

---

actionStep.log

Writes a message to the flow execution log.

Parameters:

| Parameter     | Type     | Required | Description                                  |
| ------------- | -------- | -------- | -------------------------------------------- |
| log_message | string | No       | The message to write to the log              |
| log_level   | choice | No       | 'info', 'warn', or 'error'             |

Outputs: None.

Example:

```typescript fluent
wfa.actionStep(
  actionStep.log,
  { $id: Now.ID["log_op"], label: "Log operation status" },
  {
    log_message: `Processing escalation for ${wfa.dataPill(params.inputs.incident_number, "string")}`,
    log_level: "info"
  }
);
```

---

actionStep.notification

Triggers a pre-configured ServiceNow notification (sysevent_email_action).

Parameters:

| Parameter      | Type          | Required | Description                                                                |
| -------------- | ------------- | -------- | -------------------------------------------------------------------------- |
| notification | reference   | Yes      | The notification record to trigger (sysevent_email_action)               |
| table_name   | Table Name  | No       | Table of the target record providing context to the notification template  |
| record       | Document ID | No       | Target record reference; dependent on table_name                         |

Outputs: None.

Example:

```typescript fluent
wfa.actionStep(
  actionStep.notification,
  { $id: Now.ID["send_notification"], label: "Trigger escalation notification" },
  {
    notification: wfa.dataPill(params.inputs.notification_record, "reference"),
    table_name: "incident",
    record: wfa.dataPill(params.inputs.incident, "reference")
  }
);
```

---

actionStep.script

Executes custom JavaScript on the instance, a MID Server, or in a vanilla JavaScript sandbox.

Parameters:

| Parameter            | Type          | Default      | Required | Description                                                                                              |
| -------------------- | ------------- | ------------ | -------- | -------------------------------------------------------------------------------------------------------- |
| required_run_time  | choice      | 'instance' | No       | 'instance' (Glide APIs available), 'mid' (MID Server), or 'vanilla' (sandboxed JS)                 |
| script             | Script      | -            | No       | The JavaScript to execute (use Now.include('./path.js') for external files)                            |
| mid_selection_type | choice      | 'any'      | No       | 'any', 'use_connection_alias', or 'define_connection_inline'                                       |
| connection_alias   | reference   | -            | No       | Connection alias (sys_alias) when mid_selection_type is 'use_connection_alias'                     |
| host               | string      | -            | No       | Host value; depends on connection_alias                                                                |
| mid_selection      | choice      | 'auto_select' | No    | 'auto_select', 'specific_mid_server', or 'specific_mid_cluster'                                    |
| application        | reference   | (all apps)   | No       | MID Application filter (ecc_agent_application)                                                         |
| capabilities       | reference   | -            | No       | MID Server capabilities filter (ecc_agent_capability)                                                  |
| mid_cluster        | Document ID | -            | No       | Specific MID Cluster (when mid_selection is 'specific_mid_cluster')                                  |
| mid_server         | Document ID | -            | No       | Specific MID Server (when mid_selection is 'specific_mid_server')                                    |
| inputVariables     | object      | -            | No       | Named input variables (label + value + optional mandatory). Allowed because script has allowExtendedInputs: true |
| outputVariables    | object      | -            | No       | Named output variables (each is a Column type). Allowed because script has allowExtendedOutputs: true |

Outputs: No fixed outputs. Use outputVariables to declare custom outputs that downstream steps can consume as data pills.

Example:

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
      score:   IntegerColumn({ label: "Score", default: "0" }),
      verdict: StringColumn({ label: "Verdict", maxLength: 64 })
    }
  }
);
```

---

actionStep.sms

Sends an SMS message from within a custom action.

Parameters:

| Parameter    | Type     | Required | Description                                  |
| ------------ | -------- | -------- | -------------------------------------------- |
| message    | string | Yes      | The SMS message text to send                 |
| recipients | string | Yes      | Recipient phone number(s) or user references |

Outputs:

| Field   | Type        | Description                                                |
| ------- | ----------- | ---------------------------------------------------------- |
| email | reference | Reference to the SMS delivery record (stored as sys_email) |

Example:

```typescript fluent
wfa.actionStep(
  actionStep.sms,
  { $id: Now.ID["alert_oncall"], label: "Send SMS alert" },
  {
    message: "URGENT: P1 incident requires immediate attention.",
    recipients: "+15555550100"
  }
);
```

---


Complete Example

```typescript fluent
// File: fluent/actions/escalate-incident.now.ts
import { Action, wfa, actionStep } from "@servicenow/sdk/automation";
import { StringColumn, BooleanColumn, ReferenceColumn } from "@servicenow/sdk/core";

export const escalateIncident = Action(
  {
    $id: Now.ID["escalate_incident_action"],
    name: "Escalate Incident",
    description: "Escalates an incident by raising priority, logging the reason, and notifying the assignee",
    category: "incident_management",
    inputs: {
      incident: ReferenceColumn({ label: "Incident", referenceTable: "incident", mandatory: true }),
      reason: StringColumn({ label: "Escalation Reason", mandatory: true })
    },
    outputs: {
      escalated: BooleanColumn({ label: "Escalated", mandatory: true })
    }
  },
  params => {
    wfa.actionStep(
      actionStep.updateRecord,
      { $id: Now.ID["raise_priority"], label: "Raise priority to P1" },
      {
        table_name: "incident",
        record: wfa.dataPill(params.inputs.incident, "reference"),
        update_record_field_values: TemplateValue({
          priority: "1",
          work_notes: wfa.dataPill(params.inputs.reason, "string")
        })
      }
    );

    wfa.actionStep(
      actionStep.log,
      { $id: Now.ID["log_escalation"], label: "Log escalation" },
      {
        log_level: "info",
        log_message: `Incident escalated: ${wfa.dataPill(params.inputs.reason, "string")}`
      }
    );

    wfa.assignActionOutputs(params.outputs, { escalated: true });
  }
);
```

```typescript fluent
// File: fluent/flows/auto-escalate.now.ts
import { Flow, wfa, trigger } from "@servicenow/sdk/automation";
import { escalateIncident } from "../actions/escalate-incident.now";

Flow(
  { $id: Now.ID["auto_escalate_flow"], name: "Auto Escalate Critical Incidents" },
  wfa.trigger(
    trigger.record.created,
    { $id: Now.ID["trg_critical_incident"] },
    { table: "incident", condition: "priority=1", run_flow_in: "background" }
  ),
  params => {
    wfa.action(
      escalateIncident,
      { $id: Now.ID["escalate_step"] },
      {
        incident: wfa.dataPill(params.trigger.current, "reference"),
        reason: "Auto-escalated: Priority 1 incident created"
      }
    );
  }
);
```

---

For when-to-use guidance, best practices, anti-patterns, and end-to-end patterns, see the Custom Action Guide.
