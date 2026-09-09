# wfa-flow-actions-guide

Tags: wfa, workflow-automation, flow-action, OOB-action, built-in-action, action.core, approval, notification, task, attachment, sla, catalog-action, table-actions, communication-actions, control-actions

Workflow Automation Flow Actions Guide

Action types, flow logic, and patterns for ServiceNow WFA flows. Covers record operations, communication actions, approvals, tasks, attachments, control flow, and complete flow patterns.


Actions

For API signatures, parameter tables, and output fields for every action, see the Action API.

Actions Overview

| Category              | Key Actions                                                                                                                                              | Use For              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Record Operations | createRecord, updateRecord, deleteRecord, lookUpRecord, lookUpRecords, updateMultipleRecords, createOrUpdateRecord                          | CRUD operations      |
| Communication     | sendEmail, sendNotification, sendSms, associateRecordToEmail, getEmailHeader, getLatestResponseTextFromEmail                                  | Messaging            |
| Control           | log, fireEvent, waitForCondition, waitForMessage, waitForEmailReply                                                                            | Flow control / pause |
| Approvals         | askForApproval                                                                                                                                         | Approval workflows   |
| Task              | createTask                                                                                                                                             | Task creation        |
| Service Catalog   | submitCatalogItemRequest, getCatalogVariables, createCatalogTask                                                                                   | Catalog provisioning |
| SLA               | slaPercentageTimer                                                                                                                                     | SLA percentage waits |
| Attachments       | getAttachmentsOnRecord, copyAttachment, moveAttachment, moveEmailAttachmentsToRecord, deleteAttachment, lookupAttachment, lookUpEmailAttachments | File handling        |

Actions by Operation Type

| Operation                  | Action                   | Use When                                  |
| -------------------------- | ------------------------ | ----------------------------------------- |
| Create new record          | createRecord           | Creating child records, using templates   |
| Update existing record     | updateRecord           | Modifying field values on any record      |
| Find one record            | lookUpRecord           | Single result expected, lookup by key     |
| Find multiple records      | lookUpRecords          | Batch processing, iteration needed        |
| Bulk update records        | updateMultipleRecords  | Mass updates, batch processing            |
| Upsert (create or update)  | createOrUpdateRecord   | Idempotent creation, import workflows     |
| Delete a record            | deleteRecord           | Removing records (typically in forEach)   |
| Send email message         | sendEmail              | Custom email with full template control   |
| Send notification template | sendNotification       | Using predefined notification templates   |
| Send SMS message           | sendSms                | Text message notifications                |
| Request user approval      | askForApproval         | Single or multi-level approvals           |
| Create a task              | createTask             | Creating work items in task tables        |
| Manage attachments         | getAttachmentsOnRecord | File operations on records                |
| Pause until SLA milestone  | slaPercentageTimer     | Wait for SLA percentage to be reached     |
| Wait until condition met   | waitForCondition       | Wait until record reaches desired state   |
| Wait for external message  | waitForMessage         | Wait until API sends a resume message     |
| Wait for email reply       | waitForEmailReply      | Wait until a reply arrives on an email    |
| Fire a system event        | fireEvent              | Publish event for downstream handlers     |

Common Best Practices

These apply to all actions. Action-specific advice is called out per action below.

• Wrap field values in TemplateValue({...}) -- required for createRecord/updateRecord/createTask/updateMultipleRecords/createOrUpdateRecord/createCatalogTask. TemplateValue is global -- don't import it.
• Capture outputs as const to chain into downstream actions: const result = wfa.action(...) then wfa.dataPill(result.field, "type"). Watch the output field casing (some actions use lowercase record/table_name, others use uppercase Record/Records/Count/Table -- see the Action API for each).
• Use proper data pill types -- 'reference' for record fields, 'string_full_utf8' for email subject/body, 'choice' for choice fields, 'records' for record-set outputs used in forEach.
• Don't capture data pills in variables in flow bodies (const x = wfa.dataPill(...) is a footgun). Use the data pill directly inside action parameters. (Exception: inside a custom action body, const step = wfa.actionStep(...) is correct.)

Table Actions

Actions for creating, reading, updating, and deleting records in ServiceNow tables.

For API signatures, parameter tables, and output fields, see the Action API → Table Actions.

#### Shared considerations

Value-field parameter naming differs per action:

| Action(s)                          | Value-field parameter |
| ---------------------------------- | --------------------- |
| createRecord, updateRecord     | values              |
| updateMultipleRecords            | field_values        |
| createOrUpdateRecord             | fields              |

Output field casing differs per action:

| Action                                                 | Output field(s)                                |
| ------------------------------------------------------ | ---------------------------------------------- |
| createRecord, updateRecord, createOrUpdateRecord | lowercase record                             |
| lookUpRecord                                         | UPPERCASE Record, Table                |
| lookUpRecords                                        | UPPERCASE Records, Count, Table      |
| updateMultipleRecords                                | lowercase status, count, message         |

deleteRecord has no outputs.

#### action.core.createRecord

Creates a new record in any ServiceNow table.

##### When to Use

• Creating child records from a parent event (e.g., incident from inbound email)
• Creating audit/log records in custom tables
• Template-based creation (duplicate with modifications)

##### Important Notes

• Missing mandatory fields or invalid references cause the flow to fail -- there is no built-in fail-soft option

##### Example

```typescript fluent
const incident = wfa.action(
  action.core.createRecord,
  { $id: Now.ID["create_incident"] },
  {
    table_name: "incident",
    values: TemplateValue({
      short_description: wfa.dataPill(params.trigger.subject, "string_full_utf8"),
      priority: "1",
      caller_id: wfa.dataPill(params.trigger.target_record, "reference")
    })
  }
);
```

#### action.core.updateRecord

Updates an existing record in any ServiceNow table.

##### When to Use

• State/status transitions during a workflow
• Assigning records to users or groups
• Adding work notes or other field updates after a lookup/approval

##### Best Practices

• Update only changed fields -- including unchanged fields fires unnecessary business rules and engagement messaging
• Beware concurrent updates -- another process may modify the record between your lookup and update; use trigger condition or lookUpRecord results as the source of truth

##### Example

```typescript fluent
wfa.action(
  action.core.updateRecord,
  { $id: Now.ID["assign_incident"] },
  {
    table_name: "incident",
    record: wfa.dataPill(params.trigger.current, "reference"),
    values: TemplateValue({
      assignment_group: wfa.dataPill(group.Record, "reference"),
      state: 2,
      work_notes: "Auto-assigned to IT Support team"
    })
  }
);
```

#### action.core.deleteRecord

Permanently deletes a record from any ServiceNow table.

##### When to Use

• Removing temporary/test/expired records (e.g., scheduled cleanup)
• Cleaning up duplicates after deduplication
• Purging stale integration queue items

##### Best Practices

• Prefer inactivation (active: false via updateRecord) over delete when audit trail matters
• Inside forEach, wrap the record parameter in a template literal: ` record: ${wfa.dataPill(record, "reference")} `
• Wrap in flowLogic.if to prevent accidental deletion when conditions aren't fully validated

##### Important Notes

• Permanent and irreversible -- no rollback. Related records may become orphaned.

##### Example

```typescript fluent
// Inside a forEach loop over a record set
wfa.action(
  action.core.deleteRecord,
  { $id: Now.ID["delete_record"] },
  {
    record: `${wfa.dataPill(record, "reference")}`
  }
);
```

#### action.core.lookUpRecord

Query a single record from any ServiceNow table based on conditions.

##### When to Use

• Find a user/group by name or email
• Look up reference data before creating/updating records
• Validate record existence before processing

##### Best Practices

• Always check status -- verify status='0' before using the result; '1' indicates error/not found
• Use unique conditions -- match exactly one record (email, number, sys_id); set if_multiple_records_are_found_action to 'use_first_record' or 'error'

##### Important Notes

• Returns error_message on failure (e.g., ACL denial or no match)

##### Example

```typescript fluent
const user = wfa.action(
  action.core.lookUpRecord,
  { $id: Now.ID["find_user"] },
  {
    table: "sys_user",
    conditions: "email=john.doe@company.com",
    if_multiple_records_are_found_action: "use_first_record"
  }
);

// Guard with status, then use uppercase Record
wfa.flowLogic.if(
  { $id: Now.ID["found"], condition: `${wfa.dataPill(user.status, "string")}=0` },
  () => {
    wfa.action(
      action.core.updateRecord,
      { $id: Now.ID["deactivate"] },
      {
        table_name: "sys_user",
        record: wfa.dataPill(user.Record, "reference"),
        values: TemplateValue({ active: false })
      }
    );
  }
);
```

#### action.core.lookUpRecords

Query multiple records from any ServiceNow table based on conditions.

##### When to Use

• Bulk processing (iterate results with forEach)
• Existence/count checks before creating or updating
• Fetching data sets for aggregation

##### Best Practices

• Always set max_results -- prevents timeouts; 100-200 is typical for forEach-driven workflows
• Check Count before forEach -- guards against empty-array iteration

##### Important Notes

• max_results default is 1000; system max is typically 10,000 (configurable)
• Empty result is safe (Count: 0, Records: [])

##### Example

```typescript fluent
const results = wfa.action(
  action.core.lookUpRecords,
  { $id: Now.ID["find_p1s"] },
  {
    table: "incident",
    conditions: "active=true^priority=1",
    max_results: 100
  }
);

wfa.flowLogic.if(
  { $id: Now.ID["has_matches"], condition: `${wfa.dataPill(results.Count, "integer")}>0` },
  () => {
    wfa.flowLogic.forEach(
      wfa.dataPill(results.Records, "records"),
      { $id: Now.ID["each"] },
      record => { /* process each record */ }
    );
  }
);
```

#### action.core.updateMultipleRecords

Updates multiple records in a single operation based on query conditions.

##### When to Use

• Bulk assignment (assign all unassigned records to a group)
• Mass state transitions (close all resolved incidents older than X days)
• Batch inactivation or field cleanup across many records

##### Best Practices

• Preview with lookUpRecords first using the same conditions -- confirm what will be updated before running
• Business rules fire per record -- expect longer execution and cascade effects for >200 records; for >1000, prefer a scheduled job

##### Important Notes

• status is '0' (success) or '1' (error); count is records updated; message carries error details

##### Example

```typescript fluent
const result = wfa.action(
  action.core.updateMultipleRecords,
  { $id: Now.ID["bulk_close"] },
  {
    table_name: "incident",
    conditions: "state=6^active=true^sys_updated_on<javascript:gs.daysAgoStart(30)",
    field_values: TemplateValue({
      state: 7,
      active: false,
      close_code: "Closed/Resolved by Caller",
      close_notes: "Auto-closed after 30 days in resolved state"
    })
  }
);
```

#### action.core.createOrUpdateRecord

Creates a new record if no match is found, or updates the existing record if a match exists (upsert).

##### When to Use

• External-system data sync (create if new, update if exists)
• User/asset provisioning keyed by unique identifier (email, serial number)
• Idempotent integrations that may run repeatedly

##### Best Practices

• Include the unique-identifier field in the values -- e.g., email for sys_user, serial_number for cmdb_ci. Matching uses the table dictionary's unique-field definitions
• Check status -- returns 'created', 'updated', or 'error' -- branch on it if create vs. update behavior should differ

##### Common unique fields by table

| Table                                  | Common unique fields           |
| -------------------------------------- | ------------------------------ |
| sys_user                             | email, user_name           |
| sys_user_group, core_company, sc_cat_item, sys_properties | name |
| cmdb_ci, cmdb_ci_computer          | serial_number, asset_tag   |

##### Example

```typescript fluent
const user = wfa.action(
  action.core.createOrUpdateRecord,
  { $id: Now.ID["upsert_user"] },
  {
    table_name: "sys_user",
    fields: TemplateValue({
      email: wfa.dataPill(params.trigger.from_address, "string"),
      first_name: "John",
      last_name: "Doe",
      active: true
    })
  }
);

// Branch on whether record was created or updated
wfa.flowLogic.if(
  { $id: Now.ID["was_created"], condition: `${wfa.dataPill(user.status, "string")}=created` },
  () => { /* handle new user (e.g., send welcome email) */ }
);
```

Communication Actions

Actions for sending notifications via email, in-platform notifications, and SMS, and for working with sys_email records and headers.

For API signatures, parameter tables, and output fields, see the Action API → Communication Actions.

#### Choosing the right communication action

• sendEmail -- External recipients, rich HTML formatting, off-platform delivery
• sendNotification -- Internal ServiceNow users, pre-configured templates, in-platform (preferred for internal use)
• sendSms -- Critical alerts only (per-message cost ~$0.01-0.05; use sparingly)

#### action.core.sendEmail

Sends rich text emails to addresses, user records, or group records.

##### When to Use

• External-recipient notifications (customers, vendors)
• Detailed reports/summaries requiring HTML formatting
• Off-platform communication where recipients have no ServiceNow login

##### Best Practices

• ah_body does NOT support data pills -- use static strings only. Data pills work in ah_subject and ah_to.
• Always set record and table_name for traceability in the email record's history
• watermark_email: false for external-facing emails (removes the "Sent by ServiceNow" footer)
• Keep HTML simple -- basic tags (<h2>, <p>, <strong>, <ul>, <li>); avoid CSS/JS

##### Important Notes

• Emails are recorded in sys_email and on the linked record's history
• Sending many individual emails in a forEach can trip spam filters -- aggregate into a single summary when possible

##### Example

```typescript fluent
wfa.action(
  action.core.sendEmail,
  { $id: Now.ID["notify_user"] },
  {
    ah_to: wfa.dataPill(params.trigger.current.assigned_to.email, "string"),
    ah_subject: `Incident ${wfa.dataPill(params.trigger.current.number, "string")} assigned to you`,
    ah_body: "A new incident has been assigned to you. Please review the details in your queue.",
    record: wfa.dataPill(params.trigger.current, "reference"),
    table_name: "incident"
  }
);
```

#### action.core.sendNotification

Sends an in-platform notification using a pre-configured notification template (sysevent_email_action).

##### When to Use

• Internal ServiceNow user notifications (preferred over sendEmail)
• Multi-channel delivery (email + SMS + push) via a single template
• Centralized template management where Subject/Body live on the notification record

##### Best Practices

• Resolve the notification by name, not sys_id -- use lookUpRecord on sysevent_email_action (e.g., conditions: "name=incident.assigned") rather than hardcoding
• Always set record so the template can resolve dynamic field values

##### Important Notes

• Recipients, subject, and body are defined on the template, not the action call -- you can't override them from the flow
• Invalid notification references fail silently -- verify the template exists in System Policy → Email → Notifications

#### action.core.sendSms

Sends SMS via the email-based SMS gateway. Users must have an SMS device configured.

##### When to Use

• Critical incident alerts (P1/P0) and on-call notifications
• SLA-breach escalations needing immediate response
• Reserve for urgent / time-sensitive only (per-message cost ~$0.01-0.05)

##### Best Practices

• recipients requires template-literal wrapping when using a data pill: ` recipients: ${wfa.dataPill(user.mobile_phone, "string")} `
• E.164 phone format (e.g., +14155551234) -- strip spaces, dashes, parentheses
• 160-char limit -- lead with incident number, severity, and action required

##### Important Notes

• SMS can fail silently -- pair with email/notification for critical alerts
• Delivery status is logged in sys_email

##### Example

```typescript fluent
wfa.action(
  action.core.sendSms,
  { $id: Now.ID["alert_oncall"] },
  {
    recipients: `${wfa.dataPill(params.trigger.current.assigned_to.mobile_phone, "string")}`,
    message: `URGENT: ${wfa.dataPill(params.trigger.current.number, "string")} requires immediate attention`
  }
);
```

#### action.core.associateRecordToEmail

Associates a record with a sys_email record by updating the email's Target field.

##### When to Use

• Link an inbound email to a newly created incident/task/case
• Build an audit trail connecting email correspondence to a record
• Ensure email replies are routed back to the correct record

##### Best Practices

• Call immediately after creating the related record so downstream actions can query the linked record from the email
• Source email_record from the trigger -- in inbound-email flows that's params.trigger.inbound_email

##### Important Notes

• Both target_record and email_record are mandatory
• No output -- updates the target field on the email record; calling it again on the same email overwrites the previous target

##### Example

```typescript fluent
wfa.action(
  action.core.associateRecordToEmail,
  { $id: Now.ID["link_email"] },
  {
    target_record: wfa.dataPill(incident.record, "reference"),
    email_record: wfa.dataPill(params.trigger.inbound_email, "reference")
  }
);
```

#### action.core.getEmailHeader

Retrieves the value of a specific email header from a sys_email record (first match if duplicates).

##### When to Use

• Read the From / Reply-To headers for routing decisions
• Inspect custom headers like X-ServiceNow-Generated to detect platform-generated emails and avoid processing loops

##### Best Practices

• Guard for missing header -- if the header isn't present, header_value is an empty string; check with ISNOTEMPTY / ISEMPTY before acting
• Use standard header names -- From, Reply-To, List-Id, X-ServiceNow-Generated. Names are case-insensitive per RFC 2822 but use the canonical form.

##### Important Notes

• Returns only the first matching header value
• Output header_value is always a string

##### Example

```typescript fluent
// Skip processing emails that ServiceNow itself sent
const generated = wfa.action(
  action.core.getEmailHeader,
  { $id: Now.ID["check_origin"] },
  {
    target_header: "X-ServiceNow-Generated",
    email_record: wfa.dataPill(params.trigger.inbound_email, "reference")
  }
);

wfa.flowLogic.if(
  { $id: Now.ID["external"], condition: `${wfa.dataPill(generated.header_value, "string")}ISEMPTY` },
  () => { /* process external email */ }
);
```

#### action.core.getLatestResponseTextFromEmail

Extracts the most recent reply text from an email thread, stripping quoted prior messages.

##### When to Use

• Pull only the user's latest reply for adding as work notes / comments on a record
• Feed clean reply text into keyword detection or sentiment analysis

##### Best Practices

• Validate/trim the output before writing to a record -- signature blocks and trailing whitespace may remain
• Source email_record from the trigger (params.trigger.inbound_email in inbound-email flows)

##### Important Notes

• Returns only the newest reply -- prior thread history is stripped
• Output latest_response_text is a plain string

##### Example

```typescript fluent
const reply = wfa.action(
  action.core.getLatestResponseTextFromEmail,
  { $id: Now.ID["extract_reply"] },
  { email_record: wfa.dataPill(params.trigger.inbound_email, "reference") }
);

wfa.action(
  action.core.updateRecord,
  { $id: Now.ID["add_work_note"] },
  {
    table_name: "incident",
    record: wfa.dataPill(params.trigger.current, "reference"),
    values: TemplateValue({
      work_notes: wfa.dataPill(reply.latest_response_text, "string")
    })
  }
);
```

Control Actions

Actions for flow execution control: writing log messages, firing events, and pausing flow execution until a condition is met, an email reply arrives, or a message is received.

For API signatures, parameter tables, and output fields, see the Action API → Control Actions.

#### action.core.log

Writes custom messages to the flow execution log.

##### When to Use

• Debugging complex flow logic
• Recording decision points in conditional branches
• Auditing critical operations

##### Best Practices

• Use sparingly -- avoid adding logs by default (performance impact, log clutter)
• Include context -- record numbers, status values; "Updated record" with no identifier is useless
• Never log PII / passwords / API keys / tokens
• Levels: 'info' (normal), 'warn' (non-blocking concern), 'error' (failure)

##### Important Notes

• 255-char message limit; longer values are truncated
• log_message supports data pills inside template literals

##### Example

```typescript fluent
wfa.action(
  action.core.log,
  { $id: Now.ID["log_details"] },
  {
    log_level: "info",
    log_message: `Incident ${wfa.dataPill(params.trigger.current.number, "string")} priority=${wfa.dataPill(params.trigger.current.priority, "string")}`
  }
);
```

#### action.core.fireEvent

Fires a registered ServiceNow system event, triggering any business rules / script actions / notifications subscribed to it.

##### When to Use

• Trigger downstream legacy automation already built around a system event
• Decouple flow logic from downstream processing by publishing an event others subscribe to

##### Best Practices

• Pass event_name as a plain string -- e.g., 'incident.assigned'. The platform resolves it by name against sysevent_register; no sys_id lookup needed.
• Confirm the event is registered -- firing an unregistered event silently does nothing
• Template-literal wrapping required for record, parm1, parm2 when using data pills

##### Important Notes

• Fire-and-forget -- no outputs, event handlers run asynchronously outside the flow context
• record is mandatory even if subscribers don't use it

##### Example

```typescript fluent
wfa.action(
  action.core.fireEvent,
  { $id: Now.ID["fire_event"] },
  {
    event_name: "third_party.incident.created",
    table: "incident",
    record: `${wfa.dataPill(newIncident.record, "reference")}`,
    parm1: `${wfa.dataPill(params.trigger.from_address, "string")}`,
    parm2: `${wfa.dataPill(params.trigger.subject, "string")}`
  }
);
```

#### action.core.waitForCondition

Pauses flow execution until a specified record matches a condition. Blocking.

##### When to Use

• Hold a flow until a record reaches a desired state (approval approved, task closed)
• Gate multi-step workflows on an external system updating a ServiceNow record

##### Best Practices

• Always enable a timeout in production -- timeout_flag: true with a realistic timeout_duration; handle state='1' (timeout) with an escalation branch
• Use timeout_schedule (cmn_schedule ref) for business-hours waits -- pauses the clock outside hours so weekend waits don't expire prematurely
• Template-literal wrap record when using data pills

##### Important Notes

• Output state: '0' = condition met, '1' = timeout
• Conditions use encoded query (e.g., state=6^active=false), not JavaScript
• Referenced record must already exist when the action runs

##### Example

```typescript fluent
const wait = wfa.action(
  action.core.waitForCondition,
  { $id: Now.ID["wait_resolved"] },
  {
    table_name: "task",
    record: `${wfa.dataPill(taskRecord.Record, "reference")}`,
    conditions: "state=6",
    timeout_flag: true,
    timeout_duration: Duration({ days: 7 })
  }
);

// Branch on timeout
wfa.flowLogic.if(
  { $id: Now.ID["timeout"], condition: `${wfa.dataPill(wait.state, "string")}=1` },
  () => { /* escalate */ }
);
```

#### action.core.waitForEmailReply

Pauses flow execution until an inbound email reply matches a prior outgoing sys_email. Blocking.

##### When to Use

• Email-based approvals (user replies "Approved" / "Rejected")
• Collect information from external parties via email before continuing

##### Best Practices

• Pair with a prior sendEmail -- use the sendEmail output's email as the record input here so replies match
• watermark_email: true on the preceding sendEmail -- watermarks are how replies are correlated back to the outgoing email
• Always enable timeout -- email replies may never arrive

##### Important Notes

• record must be a sys_email reference (not a generic record)
• Output state: '0' = reply received, '1' = timeout
• Output email_reply is the inbound sys_email -- use it to read the reply body/sender
• Inbound email processing must be configured on the instance

##### Example

```typescript fluent
const sent = wfa.action(
  action.core.sendEmail,
  { $id: Now.ID["send_approval_email"] },
  {
    table_name: "incident",
    record: wfa.dataPill(params.trigger.current, "reference"),
    ah_to: wfa.dataPill(params.trigger.current.assigned_to.email, "string"),
    ah_subject: `Approval required: ${wfa.dataPill(params.trigger.current.number, "string")}`,
    ah_body: "Please reply to approve or reject.",
    watermark_email: true
  }
);

const wait = wfa.action(
  action.core.waitForEmailReply,
  { $id: Now.ID["wait_reply"] },
  {
    record: wfa.dataPill(sent.email, "reference"),
    enable_timeout: true,
    timeout_duration: Duration({ days: 2 })
  }
);
```

#### action.core.waitForMessage

Pauses a flow until it receives a specific message string sent via the ServiceNow Flow API. Blocking.

##### When to Use

• Coordinate with an external system/script that will signal readiness via the Flow API
• Callback-style integrations where an external acknowledgement resumes the flow

##### Best Practices

• Use unique, descriptive message strings -- include context like a record sys_id ("provisioning-complete-{sysId}") so the right flow instance resumes
• Coordinate the message contract out-of-band -- the external caller (sn_fd.FlowAPI.resumeFlow(...)) must know the exact string

##### Important Notes

• Parameter is timeout (not timeout_duration like the other two wait actions -- see the parameter-naming table below)
• Message string is case-sensitive -- must match exactly
• Output payload is always a string -- if structured data is needed, serialize to JSON
• An empty payload means timeout fired; check with ISNOTEMPTY

##### Example

```typescript fluent
const msg = wfa.action(
  action.core.waitForMessage,
  { $id: Now.ID["wait_provisioning"] },
  {
    message: "provisioning-complete",
    enable_timeout: true,
    timeout: Duration({ hours: 24 })
  }
);

wfa.flowLogic.if(
  { $id: Now.ID["got_msg"], condition: `${wfa.dataPill(msg.payload, "string")}ISNOTEMPTY` },
  () => { /* process the payload */ }
);
```

##### Wait action parameter naming differences

The three wait actions use different parameter names for the timeout pattern:

| Action               | Boolean flag       | Duration parameter   |
| -------------------- | ------------------ | -------------------- |
| waitForCondition   | timeout_flag     | timeout_duration   |
| waitForEmailReply  | enable_timeout   | timeout_duration   |
| waitForMessage     | enable_timeout   | timeout            |

Approval Actions

Actions for creating approval records on any ServiceNow record with configurable rule sets.

For API signatures, parameter tables, rule structures, and due-date builder details, see the Action API → Approval Actions.

#### action.core.askForApproval

Requests approval on a record and waits for the response. Blocking.

##### When to Use

• Change request approvals (CAB, manager, multi-level)
• Expense / purchase / access-request / contract approvals with threshold-based routing
• Service catalog fulfillment approvals

##### Best Practices

• Resolve approver sys_ids at runtime via lookUpRecord -- never hardcode user/group sys_ids
• Set due_date via wfa.approvalDueDate() -- approvals do not auto-timeout otherwise; flow can wait forever
• For >20 approvers, use groups rather than individual users in the rule
• Pick the right ruleType: 'Any' (any single), 'All' (consensus), 'Res' (all responded then any decides), 'Count' (specific N), 'Percent' (percentage)
• Sequential vs parallel: sequential approvals = multiple askForApproval calls (manager → director → VP); parallel = one call with multiple rule sets (legal + finance)

##### Important Notes

• Blocks until approval reaches a terminal state (approved, rejected, cancelled, or due-date auto-action)
• Flow continues after rejection -- handle it with flowLogic.elseIf/else
• Creates records in sysapproval_approver (state, comments, approval_date)

##### Example

```typescript fluent
const approval = wfa.action(
  action.core.askForApproval,
  { $id: Now.ID["cab_approval"] },
  {
    record: wfa.dataPill(params.trigger.current, "reference"),
    table: "change_request",
    approval_reason: "CAB approval required",
    approval_conditions: wfa.approvalRules({
      conditionType: "OR",
      ruleSets: [{
        action: "ApprovesRejects",
        conditionType: "AND",
        rules: [[{
          ruleType: "Percent",
          percent: 50,
          users: [],
          groups: ["<cab_group_sys_id>"],
          manual: false
        }]]
      }]
    }),
    due_date: wfa.approvalDueDate({
      action: "reject", dateType: "actual", date: "{}",
      duration: 5, durationType: "days", daysSchedule: ""
    })
  }
);

wfa.flowLogic.if(
  { $id: Now.ID["approved"], condition: `${wfa.dataPill(approval.approval_state, "choice")}=approved` },
  () => { /* approved path */ }
);
wfa.flowLogic.elseIf(
  { $id: Now.ID["rejected"], condition: `${wfa.dataPill(approval.approval_state, "choice")}=rejected` },
  () => { /* rejected path */ }
);
```

#### wfa.approvalRules() helper

Builder for askForApproval.approval_conditions. Models approval logic as ruleSets of rules arrays.

Common patterns:

```typescript fluent
// Any single approver from a user list
wfa.approvalRules({
  conditionType: "OR",
  ruleSets: [{ action: "Approves", conditionType: "AND",
    rules: [[{ ruleType: "Any", users: ["user_1", "user_2"], groups: [], manual: false }]]
  }]
});

// All CAB members must approve
wfa.approvalRules({
  conditionType: "OR",
  ruleSets: [{ action: "Approves", conditionType: "AND",
    rules: [[{ ruleType: "All", users: ["cab_1", "cab_2", "cab_3"], groups: [], manual: false }]]
  }]
});

// 2 of N approvers
wfa.approvalRules({
  conditionType: "OR",
  ruleSets: [{ action: "Approves", conditionType: "AND",
    rules: [[{ ruleType: "Count", count: 2, users: ["u1","u2","u3","u4","u5"], groups: [], manual: false }]]
  }]
});

// 50% of a group
wfa.approvalRules({
  conditionType: "OR",
  ruleSets: [{ action: "Approves", conditionType: "AND",
    rules: [[{ ruleType: "Percent", percent: 50, users: [], groups: ["<group_sys_id>"], manual: false }]]
  }]
});
```

#### wfa.approvalDueDate() helper

Builder for askForApproval.due_date. Configures automatic action when the due date passes.

Common patterns:

```typescript fluent
// Auto-reject after 5 calendar days
wfa.approvalDueDate({
  action: "reject", dateType: "actual", date: "{}",
  duration: 5, durationType: "days", daysSchedule: ""    // empty = calendar days
});

// No action on due date (just record it)
wfa.approvalDueDate({
  action: "none", dateType: "actual", date: "{}",
  duration: 3, durationType: "days", daysSchedule: ""
});

// Relative to a record field's due_date, using business-hours schedule
wfa.approvalDueDate({
  action: "approve", dateType: "relative",
  date: wfa.dataPill(params.trigger.current.due_date, "glide_date_time"),
  duration: 15, durationType: "days",
  daysSchedule: "<business_hours_schedule_sys_id>"
});
```

Task Actions

Actions for creating task records in any task-extended table, with optional blocking semantics for "wait until done" workflows.

For API signatures, parameter tables, and the common task tables reference, see the Action API → Task Actions.

#### action.core.createTask

Creates a task on any task-extended table. Can optionally pause the flow until the task is completed.

##### When to Use

• Fulfillment work needing assignment to a person/group (sc_task off catalog request)
• Change implementation steps (change_task off change_request)
• Manual review / sign-off steps where the flow must wait for the assignee

##### Best Practices

• Use the most specific task table (change_task over task etc.) -- drives form layout, assignment rules, reporting
• Set parent inside field_values to link the task back to the originating record
• Provide a meaningful short_description -- assignees see only this field in their queues
• Set assigned_to or assignment_group explicitly -- table defaults often leave tasks unassigned
• wait: true blocks -- use sparingly; prefer event-driven follow-ups for long-running fulfillment

##### Important Notes

• Uses field_values (not values like createRecord/updateRecord)
• Outputs are UPPERCASE: Record, Table (unlike createRecord's lowercase record)
• Different from createRecord: use this when you want task semantics (state lifecycle, SLA hooks, assignment routing)

##### Example

```typescript fluent
const task = wfa.action(
  action.core.createTask,
  { $id: Now.ID["implementation_task"] },
  {
    task_table: "change_task",
    wait: true,
    field_values: TemplateValue({
      parent: wfa.dataPill(params.trigger.current.sys_id, "reference"),
      short_description: "Implement approved change",
      assignment_group: wfa.dataPill(params.trigger.current.assignment_group, "reference"),
      priority: 2
    })
  }
);
```

Service Catalog Actions

Actions for programmatic interaction with ServiceNow Service Catalog: submitting requests, populating template variables onto request items, and creating fulfillment tasks.

For API signatures, parameter tables, and outputs, see the Action API → Service Catalog Actions.

#### action.core.submitCatalogItemRequest

Programmatically orders a catalog item, creating a request item (sc_req_item) on a request (sc_req).

> Use only in flows triggered by trigger.application.serviceCatalog.

##### When to Use

• Auto-provisioning from upstream automation (e.g., onboarding flow ordering a laptop)
• Bulk ordering driven by a list or import
• Self-service flows that place an order on behalf of a user

##### Best Practices

• Import the CatalogItem definition and reference with template literal: ` catalog_item: ${laptopCatalogItem} `
• Always check status before using requested_item -- only valid when status='0'
• catalog_item_inputs uses ^-delimited format ("memory=16GB^storage=512GB") -- not commas or JSON
• Pair wait_for_completion: true with timeout_flag: true -- otherwise a blocking request can wait indefinitely

##### Important Notes

• Status codes: '0' = success, '1' = error (read error_message), '2' = timeout (request may still be processing)
• sysparm_quantity defaults to 1 if omitted
• _snc_dont_fail_on_error: true lets the flow continue on submission failure -- still inspect status to decide what to do next

##### Example

```typescript fluent
import { laptopCatalogItem } from "../catalogs/laptop-catalog";

const request = wfa.action(
  action.core.submitCatalogItemRequest,
  { $id: Now.ID["submit_laptop"] },
  {
    catalog_item: `${laptopCatalogItem}`,
    catalog_item_inputs: "memory=16GB^storage=512GB",
    sysparm_requested_for: wfa.dataPill(params.trigger.current.sys_id, "reference")
  }
);

wfa.flowLogic.if(
  { $id: Now.ID["ok"], condition: `${wfa.dataPill(request.status, "string")}=0` },
  () => { /* use request.requested_item */ }
);
```

#### action.core.getCatalogVariables

Populates catalog variables on a requested item from a template catalog item. Side-effect only -- no outputs.

> Use only in flows triggered by trigger.application.serviceCatalog.

##### When to Use

• Surface template variables onto a request item so downstream tasks can read them
• Apply a standard variable set (e.g., compliance template) to existing request items

##### Best Practices

• Use property references in catalog_variables -- pass catalogItem.variables.memory (an SDK reference), not a string "memory"
• Omit catalog_variables to copy all template variables; provide an array to copy a subset

##### Important Notes

• No outputs -- following actions read variables directly off the request item
• template_catalog_item references st_sys_catalog_items_and_variable_sets (accepts both catalog items and variable sets)
• Pre-existing variable values on the target request item may be overwritten

##### Example

```typescript fluent
wfa.action(
  action.core.getCatalogVariables,
  { $id: Now.ID["fill_from_template"] },
  {
    requested_item: wfa.dataPill(params.trigger.request_item, "reference"),
    template_catalog_item: `${laptopCatalogItem}`,
    catalog_variables: [
      laptopCatalogItem.variables.memory,
      laptopCatalogItem.variables.storage
    ]
  }
);
```

#### action.core.createCatalogTask

Creates a catalog task (sc_task) on a request item, with optional template-driven variable population. Blocking by default.

> Use only in flows triggered by trigger.application.serviceCatalog.

##### When to Use

• Fulfillment hand-off after a catalog request is approved
• Multi-step fulfillment where each step is its own sc_task
• Tasks that need catalog variables surfaced for the fulfiller

##### Best Practices

• All inputs use the ah_ prefix -- unique to this action; don't mix with unprefixed parameter names
• Wrap ah_fields in TemplateValue({...}) -- plain strings fail validation
• Set ah_wait explicitly -- defaults to true (blocking); set false for fire-and-forget

##### Important Notes

• Output field is "Catalog Task" with a space -- must use bracket notation: task["Catalog Task"]
• ah_table_name is always 'sc_task' (read-only)
• Different from createTask: createCatalogTask is sc_task-only and integrates with catalog variable inheritance back to the request item

##### Example

```typescript fluent
const task = wfa.action(
  action.core.createCatalogTask,
  { $id: Now.ID["fulfillment_task"] },
  {
    ah_requested_item: wfa.dataPill(params.trigger.request_item, "reference"),
    ah_short_description: "Procure and image standard laptop",
    template_catalog_item: `${laptopCatalogItem}`,
    catalog_variables: [laptopCatalogItem.variables.memory, laptopCatalogItem.variables.storage],
    ah_fields: TemplateValue({
      assignment_group: "<fulfillment_group_sys_id>",
      priority: "2"
    }),
    ah_wait: false
  }
);

// Bracket notation -- field name has a space
wfa.dataPill(task["Catalog Task"], "reference");
```

SLA Actions

Actions for SLA-aware flow timing -- pausing execution until a configurable percentage of an SLA's duration has elapsed.

For API signatures, the sla_flow_inputs object fields, and full status semantics, see the Action API → SLA Actions.

#### action.core.slaPercentageTimer

Pauses the flow until a specified percentage of an SLA's duration has elapsed. Blocking. Resumes when the percentage is reached or the SLA enters a terminal state.

> Use only in flows triggered by trigger.application.slaTask -- this action depends on the SLA trigger's outputs (sla_flow_inputs).

##### When to Use

• Progressive escalation (notify at 50% / 75% / 90% of SLA time)
• SLA-driven priority raise or breach pre-emption
• Reporting checkpoints at fixed SLA percentages

##### Best Practices

• Pair with trigger.application.slaTask -- the trigger supplies sla_flow_inputs so the action targets the right SLA without manual lookup
• Always check status -- only 'completed' means the percentage was reached; 'paused'/'cancelled'/'skipped'/'repair' indicate the SLA didn't progress normally
• Sequential timers for tiered escalation -- 50% timer → action, 75% timer → action, 90% timer → action

##### Important Notes

• percentage is mandatory and must be 0-100; out-of-range values fail at execution
• Not a wall-clock wait -- the percentage is computed against the SLA's configured duration (including business-hours schedule), not real elapsed time
• task_sla_record is optional -- when set, the timer locks to that specific SLA record; otherwise the runtime infers it from sla_flow_inputs

##### Example

```typescript fluent
// 75% milestone of an SLA -- pair with trigger.application.slaTask
const sla75 = wfa.action(
  action.core.slaPercentageTimer,
  { $id: Now.ID["wait_75"] },
  { percentage: 75 }
);

wfa.flowLogic.if(
  { $id: Now.ID["sla_active"], condition: `${wfa.dataPill(sla75.status, "string")}=completed` },
  () => { /* escalate -- raise priority, notify manager, etc. */ }
);
```

Attachment Actions

Actions for retrieving, copying, moving, deleting, and looking up attachments on records (and emails). All attachment actions enforce server-side validation (ACLs, data policy, business rules); UI policy does not apply.

For API signatures, parameter tables, and output field details, see the Action API → Attachment Actions.

#### Shared considerations

Action selection at a glance:

| Goal                                                                         | Action(s)                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| List or count attachments on any record                                      | getAttachmentsOnRecord                                                  |
| Copy attachment(s) preserving the original                                   | getAttachmentsOnRecord + forEach + copyAttachment                   |
| Move attachment(s), removing from source                                     | getAttachmentsOnRecord + forEach + moveAttachment                   |
| Find a single attachment by file name                                        | lookupAttachment + lookUpRecord (resolve to reference) + downstream   |
| Delete attachments (all or by file name)                                     | deleteAttachment                                                        |
| Move all email attachments to a record in one call                       | moveEmailAttachmentsToRecord                                            |
| List or per-attachment process email attachments                             | lookUpEmailAttachments + forEach + moveAttachment/copyAttachment  |

Action characteristics:

| Action                          | Scope        | Destructive?                       | Outputs                                                   |
| ------------------------------- | ------------ | ---------------------------------- | --------------------------------------------------------- |
| getAttachmentsOnRecord        | Any record   | No                                 | parameter (records), parameter1 (count)               |
| copyAttachment                | Any record   | No                                 | none                                                      |
| moveAttachment                | Any record   | Yes -- source removed          | none                                                      |
| deleteAttachment              | Any record   | Yes -- permanent, no undo      | none                                                      |
| lookupAttachment              | Any record   | No                                 | parameter (sys_id string), parameter1 (JSON list) |
| lookUpEmailAttachments        | Email only   | No                                 | email_attachments (records)                             |
| moveEmailAttachmentsToRecord  | Email only   | Yes -- email loses attachments | none                                                      |

Parameter naming for the attachment-reference input:

| Action            | Parameter                      |
| ----------------- | ------------------------------ |
| copyAttachment  | attachment_record            |
| moveAttachment  | source_attachment_record     |

Casing gotcha: lookupAttachment uses lowercase u; lookUpEmailAttachments uses camelCase U. Match the SDK export exactly.

#### action.core.getAttachmentsOnRecord

Returns the full list and count of attachments on a record. Pair with forEach to process each.

##### When to Use

• Iterate over each attachment on a record (e.g., copy to a related record)
• Conditionally process only when attachments exist (parameter1 > 0)
• Filter attachments by file_name when scoping to a single file

##### Best Practices

• source_record requires template-literal wrapping -- ` source_record: ${wfa.dataPill(..., "reference")} `. Plain data pills will not work.
• Guard forEach with parameter1 > 0 -- avoid empty-loop overhead
• Use type 'records' when feeding parameter into forEach
• file_name filters at the source -- cheaper than iterating + filtering inside the loop

##### Important Notes

• Empty result is safe (parameter empty, parameter1: 0)

##### Example

```typescript fluent
const attachments = wfa.action(
  action.core.getAttachmentsOnRecord,
  { $id: Now.ID["get_attachments"] },
  { source_record: `${wfa.dataPill(params.trigger.current, "reference")}` }
);

wfa.flowLogic.if(
  { $id: Now.ID["has"], condition: `${wfa.dataPill(attachments.parameter1, "integer")}>0` },
  () => {
    wfa.flowLogic.forEach(
      wfa.dataPill(attachments.parameter, "records"),
      { $id: Now.ID["each"] },
      record => {
        wfa.action(
          action.core.copyAttachment,
          { $id: Now.ID["copy"] },
          {
            table: "incident",
            target_record: wfa.dataPill(params.trigger.current.parent_incident, "reference"),
            attachment_record: wfa.dataPill(record, "reference")
          }
        );
      }
    );
  }
);
```

#### action.core.copyAttachment

Copies one attachment to a target record. The original is preserved.

##### When to Use

• Replicate attachments between related records (parent ↔ child)
• Mirror email attachments onto a created incident while keeping them on the email
• "Snapshot" records that retain evidence copied from a source

##### Best Practices

• attachment_record must be a reference -- not a string sys_id. If you have a string from lookupAttachment.parameter, resolve via lookUpRecord on sys_attachment first.
• Keep table and target_record consistent -- table must match the table of target_record

#### action.core.moveAttachment

Moves an attachment to a target record.

##### When to Use

• Promote attachments from staging to final destination
• Reassign attachments when merging two records
• Final hand-off where the source record should no longer retain the file

##### Best Practices

• Prefer copyAttachment when in doubt -- this is irreversible from the action's perspective

#### action.core.deleteAttachment

Permanently deletes attachments from a record. Supports delete-all or delete-by-name.

##### When to Use

• Cleanup on record closure (remove sensitive evidence)
• Replace prior versions of a file by name before re-upload
• Purge attachments when a record is archived

##### Best Practices

• Set delete_all_ explicitly -- defaults to true; setting it makes intent obvious
• delete_all_: false + attachment_file_name when targeting a single file -- otherwise EVERY attachment is deleted

##### Important Notes

• delete_all_ ends in an underscore -- exact SDK parameter name
• If multiple attachments share attachment_file_name, all matches are deleted

##### Example

```typescript fluent
// Delete all attachments on closure
wfa.action(
  action.core.deleteAttachment,
  { $id: Now.ID["wipe_on_close"] },
  {
    table: "incident",
    record: wfa.dataPill(params.trigger.current, "reference"),
    delete_all_: true
  }
);

// Or delete a single file by name
wfa.action(
  action.core.deleteAttachment,
  { $id: Now.ID["delete_temp_pdf"] },
  {
    table: "incident",
    record: wfa.dataPill(params.trigger.current, "reference"),
    delete_all_: false,
    attachment_file_name: "temp_report.pdf"
  }
);
```

#### action.core.lookupAttachment

Looks up an attachment by file name and returns its sys_id as a string plus a JSON listing of all attachments.

##### When to Use

• Find a specific attachment by name without iterating all attachments
• Pre-resolve a sys_id before a copyAttachment/moveAttachment call

##### Best Practices

• parameter is a STRING, not a reference -- you cannot pass it directly to copyAttachment.attachment_record. Resolve via lookUpRecord on sys_attachment first.
• Guard with ISNOTEMPTY before resolving
• Always supply file_name -- without it the action returns the first attachment encountered

##### Important Notes

• First-match semantics -- when multiple files share a name, parameter returns the first sys_id; parameter1 is a JSON listing of all matches

##### Example

```typescript fluent
const lookup = wfa.action(
  action.core.lookupAttachment,
  { $id: Now.ID["find_contract"] },
  {
    source_record: wfa.dataPill(params.trigger.current, "reference"),
    file_name: "contract.pdf"
  }
);

wfa.flowLogic.if(
  { $id: Now.ID["found"], condition: `${wfa.dataPill(lookup.parameter, "string")}ISNOTEMPTY` },
  () => {
    // Resolve the string sys_id to a sys_attachment reference
    const resolved = wfa.action(
      action.core.lookUpRecord,
      { $id: Now.ID["resolve"] },
      {
        table: "sys_attachment",
        conditions: `sys_id=${wfa.dataPill(lookup.parameter, "string")}`
      }
    );

    wfa.action(
      action.core.copyAttachment,
      { $id: Now.ID["copy"] },
      {
        table: "incident",
        target_record: wfa.dataPill(params.trigger.current.parent_incident, "reference"),
        attachment_record: wfa.dataPill(resolved.Record, "reference")
      }
    );
  }
);
```

#### action.core.lookUpEmailAttachments

Retrieves attachment records associated with a specific email record from sys_email_attachment.

##### When to Use

• Per-attachment processing of inbound email attachments (filter, transform, route)
• When moveEmailAttachmentsToRecord is too coarse (you need conditional/filtered handling)

##### Best Practices

• Use for email records only -- targets sys_email_attachment. Use getAttachmentsOnRecord for non-email records.
• Pair with forEach -- the output is a records collection

##### Important Notes

• No file_name filter -- filter inside the forEach if needed

#### action.core.moveEmailAttachmentsToRecord

Moves all email attachments to a target record in a single call. No forEach required.

##### When to Use

• Inbound-email handler that creates an incident and pulls all attachments onto it
• One-shot migrations of email payloads to a destination record

##### Best Practices

• Create the target record first -- run createRecord to get the target sys_id before the move
• Don't use for per-attachment logic -- this moves everything; use lookUpEmailAttachments + forEach + moveAttachment for filtering
• Platform enforces limits on email body size, total attachment size, and attachment count per email

##### Important Notes

• No filtering -- moves every attachment on the email; subset selection is not supported

##### Example

```typescript fluent
// Assumes an inbound-email trigger and a prior createRecord that returned `incident`
wfa.action(
  action.core.moveEmailAttachmentsToRecord,
  { $id: Now.ID["move_all_attachments"] },
  {
    target_record: wfa.dataPill(incident.record, "reference"),
    email_record: wfa.dataPill(params.trigger.inbound_email, "reference")
  }
);
```

---


Flow Logic

Flow logic constructs -- conditional branching (if/elseIf/else), loops (forEach), loop control (exitLoop/skipIteration), and flow termination (endFlow) -- are documented separately:

• Flow Logic Guide -- when to use, best practices, common use cases, and end-to-end examples
• Flow Logic API -- signatures, parameter tables, and condition syntax reference

---


End-to-End Flow Examples & Operational Rules

For complete flow examples composing these actions with triggers and flow logic (Service Catalog with Approval, Record Iteration, Subflow + Custom Action), see the Flow Guide → End-to-End Examples.

For operational rules (folder locations, single-trigger requirement, background execution, global helpers, condition template literals), see the Flow Guide → Rules & Anti-Patterns.
