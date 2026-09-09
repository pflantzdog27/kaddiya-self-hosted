# wfa-trigger-guide

Tags: trigger, wfa, workflow-automation, flow-designer, record-trigger, scheduled-trigger, application-trigger, inbound-email, service-catalog, sla, knowledge-management, remote-table-query

Workflow Automation Trigger Guide

Triggers define when a Workflow Automation flow activates. They are the first argument to wfa.trigger() and fall into three categories:

• Record triggers -- activate on record events (create/update)
• Scheduled triggers -- activate on time-based schedules (daily, weekly, repeat, etc.)
• Application triggers -- activate on application events (inbound email, SLA, service catalog, knowledge management, remote table query)

Every flow requires exactly one trigger. Subflows do not have triggers.

For requirement-phrasing → trigger-family mapping, see the Flow Guide → Temporal Requirements Analysis.

---


Triggers Overview

| Type            | Key Triggers                            | Use For          |
| --------------- | --------------------------------------- | ---------------- |
| Record      | created, updated, createdOrUpdated | Data changes     |
| Scheduled   | daily, weekly, monthly, repeat, runOnce | Time-based tasks |
| Application | inboundEmail, slaTask, serviceCatalog, knowledgeManagement, remoteTableQuery | App events       |


Triggers by Use Case

| Use Case                | Trigger Type                     | Example Scenario                          |
| ----------------------- | -------------------------------- | ----------------------------------------- |
| New record automation   | trigger.record.created           | Auto-assign incidents when created        |
| Record change detection | trigger.record.updated           | Escalate priority when incident updated   |
| Either create or update | trigger.record.createdOrUpdated  | Audit logging for new or modified records |
| Daily maintenance tasks | trigger.scheduled.daily          | Cleanup old records every morning         |
| Regular interval checks | trigger.scheduled.repeat         | Check system status every 15 minutes      |
| Email-based workflows   | trigger.application.inboundEmail | Parse support emails and create tickets   |

---


Common Best Practices

These apply across all trigger families. Trigger-specific advice is called out per trigger below.

• Filter at the trigger level -- use the condition / email_conditions / target_table parameters with encoded query syntax (e.g., "priority=1^assignment_groupISEMPTY") so unneeded records never enter the flow. Use ^ (AND), ^OR (OR), ISEMPTY, ISNOTEMPTY.
• Default to background execution -- set run_flow_in: 'background' (where supported) to avoid blocking the user transaction. Use 'foreground' only for synchronous validation.
• Scheduled triggers have no trigger data -- use lookUpRecords with date-range conditions inside the body (e.g., sys_created_onRELATIVELE@dayofweek@ago@7).
• Schedule in UTC -- always pass the timezone explicitly: Time({ hours: 2, minutes: 0, seconds: 0 }, "UTC"). Off-peak hours (2-5 AM UTC) minimize system impact.
• Use max_results for batching -- prevents timeouts when scheduled flows process large datasets.
• Avoid recursive triggers and update loops -- a flow that updates the same record/field it triggered on can re-trigger itself. Add state checks or flags.

---


Record Triggers

Record triggers fire in response to record lifecycle events (create, update, or both).

For API signatures, configuration parameters, output fields, and changed_fields structure, see the Trigger API → trigger.record.

trigger.record.created

Fires when a new record is created in the specified table.

#### When to Use

• Auto-assign records on creation (e.g., assign incidents to on-call teams)
• Provision related resources (welcome email, default tasks, workspace setup)
• Kick off approval workflows for high-value records

#### Best Practices

• run_on_extended: 'false' (default) -- avoids duplicate executions when the same record matches both a base table and a child table

#### Important Notes

• Fires after the record is inserted (sys_id exists, all fields populated)
• Trigger data accessible via params.trigger.current
• Multiple flows can trigger on the same table; execution order isn't guaranteed
• Background triggers fire after the transaction commits; foreground triggers fire during the transaction

#### Example

```typescript fluent
wfa.trigger(
  trigger.record.created,
  { $id: Now.ID["incident_created_trigger"] },
  {
    table: "incident",
    condition: "priority=1^active=true",
    run_flow_in: "background"
  }
)
```

trigger.record.updated

Fires when an existing record is modified.

#### When to Use

• Notify or escalate on field changes (priority, state, assigned_to)
• React to state transitions (resolved, closed, cancelled)
• Proceed with downstream work after an approval is granted

#### Trigger Strategy Options

| Value             | Fires                                              | Use for                               |
| ----------------- | -------------------------------------------------- | ------------------------------------- |
| 'once'          | Once per transaction                               | Simple notifications                  |
| 'unique_changes' | Once per unique field-change set (⭐ recommended) | Most field-change-driven workflows    |
| 'every'         | Every time condition is met                        | Audit/event-log style flows           |
| 'always'        | Every update regardless of conditions              | Use sparingly -- can cause many runs  |

#### Best Practices

• Prefer trigger_strategy: 'unique_changes' to avoid duplicate executions while still reacting to field changes

#### Important Notes

• Trigger provides NEW values (post-update) on params.trigger.current -- there is no .previous field per record value, but changed_fields carries before/after
• Condition is evaluated against the new record values
• Trigger strategy applies to updates only -- creates always fire once

#### Example

```typescript fluent
wfa.trigger(
  trigger.record.updated,
  { $id: Now.ID["incident_updated_trigger"] },
  {
    table: "incident",
    condition: "priority=1",
    run_flow_in: "background",
    trigger_strategy: "unique_changes"
  }
)
```

Consuming changed_fields: iterate inside the flow body with wfa.flowLogic.forEach(wfa.dataPill(params.trigger.changed_fields, "array.object"), ...) -- each element has field_name, previous_value, current_value, etc. (see the Trigger API).

trigger.record.createdOrUpdated

Fires when a record is either created or updated.

#### When to Use

• Data synchronization where create and update logic is identical
• Compliance/validation rules applied uniformly to all writes
• Audit logging that captures both creates and updates

#### Best Practices

• Ensure the condition makes sense for both events -- a condition that only applies to creates (or updates) is a signal you want a separate trigger instead

#### Important Notes

• params.trigger.changed_fields is empty array for creates and populated for updates -- use this to branch when behavior differs
• Trigger strategy applies to updates only -- creates always fire once
• Fires more frequently than separate created/updated triggers -- tighter conditions help manage volume

#### Example

```typescript fluent
wfa.trigger(
  trigger.record.createdOrUpdated,
  { $id: Now.ID["incident_event_trigger"] },
  {
    table: "incident",
    condition: "priority=1^ORpriority=2",
    run_flow_in: "background",
    trigger_strategy: "once"
  }
)
```

Distinguishing create vs. update in the body: use params.trigger.changed_fields -- empty array → create; populated array → update. Branch with wfa.flowLogic.if({ condition: ${wfa.dataPill(params.trigger.changed_fields, "string")}ISNOTEMPTY }, ...).

---


Scheduled Triggers

Scheduled triggers fire on time-based schedules. They do not have access to record data -- use actions like lookUpRecords to query data within the flow body. Time and Duration are available globally; do not import them.

For API signatures, configuration parameters, output fields, and Time/Duration helper specifications, see the Trigger API → trigger.scheduled.

trigger.scheduled.daily

Executes once per day at a specific time.

#### When to Use

• Daily summary reports
• Nightly data cleanup (archive closed records, purge stale data)
• Batch processing (bulk updates, external system sync)

#### Important Notes

• Missed executions are skipped -- no automatic retry if the system is down at the scheduled time
• The flow must be active at the scheduled time
• Actual execution may be delayed by minutes under load

#### Example

```typescript fluent
wfa.trigger(
  trigger.scheduled.daily,
  { $id: Now.ID["daily_trigger"] },
  {
    time: Time({ hours: 2, minutes: 0, seconds: 0 }, "UTC")
  }
)
```

trigger.scheduled.weekly

Executes once per week on a specific day and time.

#### When to Use

• Weekly reports (metrics, team performance, executive summaries)
• Weekly maintenance (archive old records, cleanup stale data)
• Data warehouse / external-system sync

#### Best Practices

• day_of_week ranges 1=Mon ... 7=Sun. Pick the appropriate day for the workload -- Monday for reports covering the previous week; weekend days for off-peak processing.

#### Important Notes

• The week is computed in UTC -- day_of_week: 1 is UTC Monday regardless of caller timezone

#### Example

```typescript fluent
wfa.trigger(
  trigger.scheduled.weekly,
  { $id: Now.ID["weekly_trigger"] },
  {
    day_of_week: 1,    // 1=Mon ... 7=Sun
    time: Time({ hours: 9, minutes: 0, seconds: 0 }, "UTC")
  }
)
```

trigger.scheduled.monthly

Executes once per month on a specific day and time.

#### When to Use

• Monthly billing (generate invoices, statements)
• Compliance / audit reports
• Period-close financial processing

#### Best Practices

• day_of_month edge cases -- values >28 may not exist every month. If day_of_month exceeds the month length, the flow runs on the last day of that month (e.g., day 31 → Feb 28/29). Use 1-28 for consistent execution.

#### Important Notes

• Monthly failures have outsized business impact -- always include error notifications or escalation steps
• Use date-range conditions in lookUpRecords such as sys_created_onONLast month@javascript:gs.beginningOfLastMonth()@javascript:gs.endOfLastMonth()

#### Example

```typescript fluent
wfa.trigger(
  trigger.scheduled.monthly,
  { $id: Now.ID["monthly_trigger"] },
  {
    day_of_month: 1,    // 1-31; if > days in month, runs on last day
    time: Time({ hours: 0, minutes: 0, seconds: 0 }, "UTC")
  }
)
```

trigger.scheduled.repeat

Executes at regular intervals.

#### When to Use

• Polling external systems (check for new data, monitor status)
• Health checks (monitor service availability)
• Queue processing for async tasks

#### Best Practices

• Minimum interval ≥ 5 minutes -- shorter intervals risk system overload. Use Duration({ minutes: 15 }) or longer in production
• Idempotent design -- repeat flows fire often; guard with a lookUpRecords count check and wfa.flowLogic.endFlow() when there's nothing to do
• Keep execution fast -- a slow flow that runs every 15 minutes compounds quickly

#### Important Notes

• First execution is immediate when the flow is activated, then repeats at repeat interval
• If an execution takes longer than the interval, the next execution waits for the current to finish (no overlap)
• Interval precision is best-effort -- actual fire time may drift under load

#### Example

```typescript fluent
wfa.trigger(
  trigger.scheduled.repeat,
  { $id: Now.ID["repeat_trigger"] },
  {
    repeat: Duration({ minutes: 15 })
  }
)
```

trigger.scheduled.runOnce

Executes once at a specific future date and time.

#### When to Use

• Maintenance windows (system updates, database maintenance)
• Time-deferred actions (delayed approvals, scheduled reminders)
• One-time data migration or bulk transformation

#### Best Practices

• run_in must be in the future -- a past date causes a flow error
• You only get one shot -- include error notifications since there is no retry

#### Important Notes

• The flow auto-deactivates after execution -- to run again, clone the flow or create a new one
• If the system is down at the scheduled time, execution is skipped and the flow still deactivates (no retry)

#### Example

```typescript fluent
wfa.trigger(
  trigger.scheduled.runOnce,
  { $id: Now.ID["run_once_trigger"] },
  {
    run_in: "2026-03-15 02:00:00"   // 'YYYY-MM-DD HH:MM:SS'
  }
)
```

---


Application Triggers

Application triggers fire on application-specific events -- email arrival, SLA milestones, catalog requests, knowledge article lifecycle, remote queries.

For API signatures, configuration parameters, output fields, and type structures, see the Trigger API → trigger.application.

trigger.application.inboundEmail

Fires when an email is received and matches specified conditions.

#### When to Use

• Create incidents/cases from support emails
• Route email content to teams based on subject/body
• Parse approval replies and update approval records

#### Best Practices

• Validate the sender -- filter by domain (from_addressENDSWITH@company.com) to ignore unknown sources
• Suppress auto-replies -- filter out OOO/auto-responder messages (subjectNOT LIKEOUT OF OFFICE)
• Use LIKE (not CONTAINS) when filtering email text fields in email_conditions -- this trigger uses the v2 condition builder, which does not accept CONTAINS

#### Important Notes

• Use type 'string_full_utf8' for params.trigger.subject and params.trigger.body_text (not plain 'string') -- emails routinely contain non-ASCII characters
• JavaScript string methods (.includes(), .match(), etc.) are not supported in flow conditions -- use encoded-query operators. For email_conditions specifically, use LIKE / NOT LIKE (plus STARTSWITH, ENDSWITH); for complex parsing use a Script action
• Attachment processing requires custom actions/scripts -- it is not exposed directly on the trigger

#### Example

```typescript fluent
wfa.trigger(
  trigger.application.inboundEmail,
  { $id: Now.ID["email_trigger"] },
  {
    email_conditions: "subjectLIKEsupport^ORsubjectLIKEhelp",
    target_table: "incident"
  }
)
```

Output access: params.trigger.subject and params.trigger.body_text (use 'string_full_utf8' type), params.trigger.user (sys_user reference), params.trigger.from_address, params.trigger.inbound_email (sys_email reference), params.trigger.target_record.

trigger.application.slaTask

Fires when an SLA reaches specific stages (50%, 75%, 100% breached) or when a task_sla record is created or updated.

#### When to Use

• Progressive escalation at SLA milestones (50% / 75% / breach)
• Automated breach response (notify management, raise priority)
• SLA milestone logging for reporting and analytics

#### Best Practices

• Pick the right stage -- 50% for early warning, 75% for manager escalation, 100% (breach) for critical escalations
• Filter by task type -- e.g., condition task.sys_class_name=incident so the trigger doesn't fire for every SLA in the system
• Check SLA state before acting -- inspect params.trigger.current.active, .stage, and .paused; an SLA can pause or repair after the trigger fires

#### Important Notes

• params.trigger.current is the task_sla record; params.trigger.current.task is the related task -- use dot-walking instead of extra lookups
• Multiple SLAs may attach to the same task -- target a specific one with sla.definition.name=Resolution Time
• Common stage values: in_progress, paused, completed, breached
• Performance: prefer dot-walking on params.trigger.current.task.* over extra lookUpRecords calls, and batch related updates into a single action where possible

#### Example

```typescript fluent
wfa.trigger(
  trigger.application.slaTask,
  { $id: Now.ID["sla_trigger"] },
  {}
)
```

Output access: params.trigger.task_sla_record (reference to task_sla), and the nested SLA configuration via params.trigger.sla_flow_inputs.name / .duration / .duration_type / .is_repair / .relative_duration_works_on.

For progressive SLA monitoring (acting at 50% / 75% / 100% milestones), use this trigger with action.core.slaPercentageTimer -- see the Action Guide → SLA Actions.

trigger.application.serviceCatalog

Fires when a Service Catalog request item workflow needs to be processed.

#### When to Use

• Approval workflows for high-value catalog items
• Automated fulfillment (create tasks, provision resources)
• Variable-based routing to different fulfillment teams

#### Best Practices

• Retrieve catalog variables with getCatalogVariables -- define a CatalogItem with typed variables and pass it as template_catalog_item to access user selections
• Check request_item.state before acting -- common states: pending, approved, rejected, cancelled, closed
• Use related catalog actions in the body: createCatalogTask for fulfillment, submitCatalogItemRequest for chained requests, askForApproval for approvals

#### Important Notes

• params.trigger.request_item is a reference to sc_req_item; dot-walk for .request (parent), .cat_item (definition), .requested_for (user), .opened_by
• params.trigger.table_name is always "sc_req_item"
• Performance: never use run_flow_in: 'foreground' for long-running operations -- it blocks the user's catalog submission. Group related record writes into a single updateMultipleRecords call where possible.

#### Example

```typescript fluent
wfa.trigger(
  trigger.application.serviceCatalog,
  { $id: Now.ID["catalog_trigger"] },
  { run_flow_in: "background" }
)
```

Output access: params.trigger.request_item (reference to sc_req_item), params.trigger.table_name (always "sc_req_item"). Dot-walk for request details: params.trigger.request_item.request, .cat_item, .requested_for.

For an end-to-end approval + fulfillment example using getCatalogVariables, askForApproval, and createCatalogTask, see Flow Guide → Service Catalog with Approval & Fulfillment.

trigger.application.knowledgeManagement

Fires when a knowledge article is created, updated, or changes state.

#### When to Use

• Article review/approval workflow (filter on workflow_state=pending_approval)
• Publication notifications (filter on workflow_state=published)
• Article-expiration monitoring (alert owners as retirement date approaches)

#### Best Practices

• Filter by workflow_state at the trigger level -- draft, pending_approval, published, scheduled, retired
• Integrate with askForApproval for multi-level article review

#### Important Notes

• Fires for kb_knowledge record operations after the article write completes
• params.trigger.knowledge is the article reference; dot-walk for fields (e.g., .short_description, .workflow_state)
• Rich-text parsing and complex category logic require a Script action

#### Example

```typescript fluent
wfa.trigger(
  trigger.application.knowledgeManagement,
  { $id: Now.ID["knowledge_trigger"] },
  {}
)
```

Output access: params.trigger.knowledge (reference to kb_knowledge), params.trigger.table_name (default 'kb_knowledge').

trigger.application.remoteTableQuery

Fires when a remote table is queried from an external system. Enables custom logic for remote table data access and transformation.

⚠️ Synchronous execution. The calling system waits for flow completion. Keep processing VERY fast (target <2 seconds). Cannot run in background -- poor performance directly impacts user experience.

#### When to Use

• Logging or auditing remote-table access patterns
• Caching frequently accessed remote data to reduce external API calls
• Data transformation between external formats and ServiceNow structure (via Script actions)

#### Best Practices

• Specify u_table -- without it, the trigger fires for every remote-table query in the instance
• Errors propagate to the caller -- a flow error fails the external query; always include error handling

#### Important Notes

• Synchronous only -- there is no background option; the calling system blocks on flow completion
• The flow must return data in the expected ServiceNow remote-table response format
• External API calls, dynamic URL construction, or rich transformations belong in a Script action or Integration Hub step -- not the flow shell itself

#### Example

```typescript fluent
wfa.trigger(
  trigger.application.remoteTableQuery,
  { $id: Now.ID["remote_query_trigger"] },
  {
    u_table: "x_custom_remote_table"
  }
)
```

Output access: params.trigger.table_name (remote table name), params.trigger.query_id, params.trigger.query_parameters (name-value pairs of the incoming query).
