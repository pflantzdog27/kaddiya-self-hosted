# trigger-api

Tags: trigger, flow-trigger, wfa.trigger, sys_hub_trigger_definition, record-trigger, scheduled-trigger, application-trigger, inbound-email, service-catalog, sla-task, knowledge-management, remote-table-query

trigger

Trigger definitions for starting a Flow. Pass a trigger as the first argument to wfa.trigger().


trigger.record

Triggers that fire in response to record lifecycle events.

| Key | Description |
|-----|-------------|
| created | Fires when a record is created on the specified table. |
| createdOrUpdated | Fires when a record is created or updated on the specified table. |
| updated | Fires when a record is updated on the specified table. |

Usage Pattern

All record triggers follow this invocation shape:

```typescript fluent
wfa.trigger(
  trigger.record.<triggerType>,
  { $id: Now.ID['trigger_id'] },
  {
    table: 'table_name',
    condition: 'encoded_query',
    // ... other configuration parameters
  }
)
```

---

trigger.record.created

Activates when a new record is created in the specified table.

#### Configuration Parameters

| Parameter               | Type                                              | Default  | Required | Description                                            |
| ----------------------- | ------------------------------------------------- | -------- | -------- | ------------------------------------------------------ |
| table                 | string                                          | -        | Yes      | Table to monitor for new records                       |
| condition             | string                                          | -        | No       | Encoded query to filter which records trigger the flow |
| run_flow_in           | 'any' \| 'background' \| 'foreground'           | 'any'  | No       | Execution context for the flow                         |
| run_on_extended       | 'true' \| 'false'                               | 'false'| No       | Whether to run on child tables                         |
| run_when_setting      | 'both' \| 'interactive' \| 'non_interactive'    | 'both' | No       | Session type filter                                    |
| run_when_user_setting | 'any' \| 'one_of' \| 'not_one_of'               | 'any'  | No       | User-based filter mode                                 |
| run_when_user_list    | string[]                                        | []     | No       | List of user sys_ids for filtering                     |

#### Output Fields

| Field                 | Type              | Description                    |
| --------------------- | ----------------- | ------------------------------ |
| current             | reference       | The created record             |
| table_name          | string          | Table where record was created |
| run_start_time      | glide_date_time | Flow execution start time      |
| run_start_date_time | glide_date_time | Flow execution start date/time |

---

trigger.record.updated

Activates when an existing record is updated in the specified table.

#### Configuration Parameters

| Parameter               | Type                                                | Default  | Required | Description                                            |
| ----------------------- | --------------------------------------------------- | -------- | -------- | ------------------------------------------------------ |
| table                 | string                                            | -        | Yes      | Table to monitor for updated records                   |
| condition             | string                                            | -        | No       | Encoded query to filter which records trigger the flow |
| run_flow_in           | 'any' \| 'background' \| 'foreground'             | 'any'  | No       | Execution context for the flow                         |
| run_on_extended       | 'true' \| 'false'                                 | 'false'| No       | Whether to run on child tables                         |
| run_when_setting      | 'both' \| 'interactive' \| 'non_interactive'      | 'both' | No       | Session type filter                                    |
| run_when_user_setting | 'any' \| 'one_of' \| 'not_one_of'                 | 'any'  | No       | User-based filter mode                                 |
| run_when_user_list    | string[]                                          | []     | No       | List of user sys_ids for filtering                     |
| trigger_strategy      | 'once' \| 'unique_changes' \| 'every' \| 'always' | 'once' | No       | Controls when trigger fires for updates                |

#### trigger_strategy Values

• 'once' — Fires only the first time condition matches
• 'unique_changes' — Fires for each unique change to monitored fields
• 'every' — Fires on every update regardless of field changes
• 'always' — Fires only if flow is not currently running

#### Output Fields

| Field                 | Type              | Description                                                     |
| --------------------- | ----------------- | --------------------------------------------------------------- |
| current             | reference       | The updated record (current state)                              |
| changed_fields      | array           | Array of changed field details with previous and current values |
| table_name          | string          | Table where record was updated                                  |
| run_start_time      | glide_date_time | Flow execution start time                                       |
| run_start_date_time | glide_date_time | Flow execution start date/time                                  |

#### changed_fields Structure

Each element of the changed_fields array has this shape:

```typescript fluent
{
  field_name: string,
  previous_value: string,
  previous_display_value: string,
  current_value: string,
  current_display_value: string
}
```

---

trigger.record.createdOrUpdated

Activates when a record is either created or updated in the specified table.

#### Configuration Parameters

| Parameter               | Type                                                | Default  | Required | Description                                            |
| ----------------------- | --------------------------------------------------- | -------- | -------- | ------------------------------------------------------ |
| table                 | string                                            | -        | Yes      | Table to monitor for created or updated records        |
| condition             | string                                            | -        | No       | Encoded query to filter which records trigger the flow |
| run_flow_in           | 'any' \| 'background' \| 'foreground'             | 'any'  | No       | Execution context for the flow                         |
| run_on_extended       | 'true' \| 'false'                                 | 'false'| No       | Whether to run on child tables                         |
| run_when_setting      | 'both' \| 'interactive' \| 'non_interactive'      | 'both' | No       | Session type filter                                    |
| run_when_user_setting | 'any' \| 'one_of' \| 'not_one_of'                 | 'any'  | No       | User-based filter mode                                 |
| run_when_user_list    | string[]                                          | []     | No       | List of user sys_ids for filtering                     |
| trigger_strategy      | 'once' \| 'unique_changes' \| 'every' \| 'always' | 'once' | No       | Controls when trigger fires for updates                |

trigger_strategy only affects updates -- creates always fire once. See trigger.record.updated → trigger_strategy Values for value descriptions.

#### Output Fields

| Field                 | Type              | Description                                               |
| --------------------- | ----------------- | --------------------------------------------------------- |
| current             | reference       | The created or updated record (current state)             |
| changed_fields      | array           | Array of changed field details (only present for updates) |
| table_name          | string          | Table where record was created or updated                 |
| run_start_time      | glide_date_time | Flow execution start time                                 |
| run_start_date_time | glide_date_time | Flow execution start date/time                            |

Note: changed_fields is only populated when the trigger fires for an update. On record creation, changed_fields is empty or undefined -- check this to distinguish create from update.


trigger.scheduled

Triggers that fire on a time-based schedule.

| Key | Description |
|-----|-------------|
| daily | Fires once per day at the specified time. |
| monthly | Fires once per month at the specified day and time. |
| repeat | Fires repeatedly at a configured interval. |
| runOnce | Fires once at a specific date and time. |
| weekly | Fires once per week at the specified day and time. |

Usage Pattern

All scheduled triggers follow this invocation shape:

```typescript fluent
wfa.trigger(
  trigger.scheduled.<triggerType>,
  { $id: Now.ID['trigger_id'] },
  {
    // time-based configuration parameters
  }
)
```

Note: Time and Duration are available globally from @servicenow/sdk/global -- do NOT import them from @servicenow/sdk/core.

---

trigger.scheduled.daily

Activates once per day at a specified time.

#### Configuration Parameters

| Parameter | Type   | Default | Required | Description                                  |
| --------- | ------ | ------- | -------- | -------------------------------------------- |
| time    | Time | -       | Yes      | Time of day to run (hours, minutes, seconds) |

#### Time Constructor

```typescript fluent
Time(
  { hours: number, minutes: number, seconds: number },
  timezone: string  // e.g., 'UTC', 'America/Los_Angeles'
)
```

#### Output Fields

| Field                 | Type              | Description                    |
| --------------------- | ----------------- | ------------------------------ |
| run_start_time      | glide_date_time | Flow execution start time      |
| run_start_date_time | glide_date_time | Flow execution start date/time |

---

trigger.scheduled.weekly

Activates once per week on a specified day and time.

#### Configuration Parameters

| Parameter     | Type      | Default | Required | Description                                                                                |
| ------------- | --------- | ------- | -------- | ------------------------------------------------------------------------------------------ |
| day_of_week | integer | -       | Yes      | Day of week (1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday, 7=Sunday) |
| time        | Time    | -       | Yes      | Time of day to run (hours, minutes, seconds)                                               |

#### day_of_week Values

• 1 -- Monday
• 2 -- Tuesday
• 3 -- Wednesday
• 4 -- Thursday
• 5 -- Friday
• 6 -- Saturday
• 7 -- Sunday

#### Output Fields

| Field                 | Type              | Description                    |
| --------------------- | ----------------- | ------------------------------ |
| run_start_time      | glide_date_time | Flow execution start time      |
| run_start_date_time | glide_date_time | Flow execution start date/time |

---

trigger.scheduled.monthly

Activates once per month on a specified day and time.

#### Configuration Parameters

| Parameter      | Type      | Default | Required | Description                                  |
| -------------- | --------- | ------- | -------- | -------------------------------------------- |
| day_of_month | integer | -       | Yes      | Day of month (1-31) to run                   |
| time         | Time    | -       | Yes      | Time of day to run (hours, minutes, seconds) |

Note: If day_of_month is greater than the number of days in the month (e.g., 31 for February), the flow runs on the last day of that month.

#### Output Fields

| Field                 | Type              | Description                    |
| --------------------- | ----------------- | ------------------------------ |
| run_start_time      | glide_date_time | Flow execution start time      |
| run_start_date_time | glide_date_time | Flow execution start date/time |

---

trigger.scheduled.repeat

Activates repeatedly at a specified interval.

#### Configuration Parameters

| Parameter | Type       | Default | Required | Description                          |
| --------- | ---------- | ------- | -------- | ------------------------------------ |
| repeat  | Duration | -       | Yes      | Interval duration between executions |

#### Duration Constructor

```typescript fluent
Duration({
  days?: number,
  hours?: number,
  minutes?: number,
  seconds?: number
})
```

#### Output Fields

| Field                 | Type              | Description                    |
| --------------------- | ----------------- | ------------------------------ |
| run_start_time      | glide_date_time | Flow execution start time      |
| run_start_date_time | glide_date_time | Flow execution start date/time |

---

trigger.scheduled.runOnce

Activates once at a specified date and time.

#### Configuration Parameters

| Parameter | Type       | Default | Required | Description                            |
| --------- | ---------- | ------- | -------- | -------------------------------------- |
| run_in  | datetime | -       | Yes      | Specific date and time to run the flow |

#### run_in Format

Use ISO 8601 format: 'YYYY-MM-DD HH:MM:SS' (e.g., '2026-03-15 14:30:00').

#### Output Fields

| Field                 | Type              | Description                    |
| --------------------- | ----------------- | ------------------------------ |
| run_start_time      | glide_date_time | Flow execution start time      |
| run_start_date_time | glide_date_time | Flow execution start date/time |


trigger.application

Application-specific event triggers.

| Key | Description |
|-----|-------------|
| inboundEmail | Fires when an inbound email is received. |
| knowledgeManagement | Fires on a Knowledge Management lifecycle event. |
| remoteTableQuery | Fires when a remote table query is executed. |
| serviceCatalog | Fires when a Service Catalog request item is submitted. |
| slaTask | Fires on an SLA task event. |

Usage Pattern

All application triggers follow this invocation shape:

```typescript fluent
wfa.trigger(
  trigger.application.<triggerType>,
  { $id: Now.ID['trigger_id'] },
  {
    // application-specific configuration parameters
  }
)
```

---

trigger.application.inboundEmail

Activates when an inbound email matches specified conditions.

#### Configuration Parameters

| Parameter                   | Type      | Default | Required | Description                                                      |
| --------------------------- | --------- | ------- | -------- | ---------------------------------------------------------------- |
| email_conditions          | string  | -       | No       | Encoded query conditions to filter emails                        |
| order                     | integer | -       | No       | Priority order for this trigger (lower values = higher priority) |
| stop_condition_evaluation | boolean | true  | No       | When true, stops processing after first matching trigger         |
| target_table              | string  | -       | No       | Table associated with reply record                               |

Note: email_conditions uses LIKE (not CONTAINS) when filtering on text fields like subject or body. Email conditions follow ServiceNow encoded query format against sys_email fields.

#### Output Fields

| Field               | Type               | Description                                  |
| ------------------- | ------------------ | -------------------------------------------- |
| inbound_email     | reference        | Reference to sys_email record                |
| target_table_name | string           | Table name of the target record              |
| body_text         | string_full_utf8 | Email body content                           |
| subject           | string_full_utf8 | Email subject line                           |
| user              | reference        | User who sent the email (sys_user reference) |
| target_record     | reference        | Related target record if applicable          |
| from_address      | string_full_utf8 | Sender email address                         |

---

trigger.application.slaTask

Activates when an SLA task event occurs (e.g., SLA breach, SLA warning).

#### Configuration Parameters

This trigger has no input configuration parameters. It automatically activates for SLA task events.

#### Output Fields

| Field             | Type        | Description                  |
| ----------------- | ----------- | ---------------------------- |
| task_sla_record | reference | Reference to task_sla record |
| sla_flow_inputs | object    | SLA-specific input data      |

#### sla_flow_inputs Structure

```typescript fluent
{
  duration: string,                    // SLA duration
  relative_duration_works_on: string,  // Schedule for duration calculation
  is_repair: boolean,                  // Whether this is a repair SLA
  duration_type: string,               // Type of duration calculation
  name: string                         // SLA definition name
}
```

---

trigger.application.serviceCatalog

Activates when a Service Catalog request item workflow needs to be processed.

#### Configuration Parameters

| Parameter     | Type                                    | Default | Required | Description                  |
| ------------- | --------------------------------------- | ------- | -------- | ---------------------------- |
| run_flow_in | 'any' \| 'background' \| 'foreground' | 'any' | No       | Execution context for the flow |

#### Output Fields

| Field                 | Type        | Description                                            |
| --------------------- | ----------- | ------------------------------------------------------ |
| request_item        | reference | Reference to sc_req_item record (catalog request item) |
| table_name          | string    | Table name, always "sc_req_item"                     |
| run_start_time      | datetime  | When the trigger started execution                     |
| run_start_date_time | datetime  | Alternative field for run start time                   |

---

trigger.application.knowledgeManagement

Activates when knowledge management events occur (e.g., knowledge article published, retired).

#### Configuration Parameters

This trigger has no input configuration parameters. It automatically activates for knowledge management events.

#### Output Fields

| Field                 | Type              | Description                            |
| --------------------- | ----------------- | -------------------------------------- |
| knowledge           | reference       | Reference to kb_knowledge record       |
| table_name          | string          | Table name (default: 'kb_knowledge') |
| run_start_time      | glide_date_time | Flow execution start time              |
| run_start_date_time | glide_date_time | Flow execution start date/time         |

---

trigger.application.remoteTableQuery

Activates when a remote table is queried from an external system.

⚠️ Synchronous execution: The calling system waits for flow completion. Keep processing fast (target <2 seconds response time). Cannot run in background.

#### Configuration Parameters

| Parameter | Type     | Default | Required | Description                                |
| --------- | -------- | ------- | -------- | ------------------------------------------ |
| u_table | string | -       | No       | Remote table name (from sys_script_vtable) |

#### Output Fields

| Field              | Type     | Description                          |
| ------------------ | -------- | ------------------------------------ |
| table_name       | string | Remote table name                    |
| query_parameters | object | Name-value pairs of query parameters |
| query_id         | string | Unique identifier for this query     |

---

For when-to-use guidance, best practices, and end-to-end trigger examples, see the Trigger Guide.
