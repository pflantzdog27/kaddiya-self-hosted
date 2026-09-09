# action-api

Tags: Action, action, flow-action, wfa.action, action.core, built-in-action, OOB-action, sys_hub_action_type_definition

action

Built-in action steps for use inside a Flow or Subflow via wfa.action().

```typescript fluent
import { action } from '@servicenow/sdk/automation'
```


action.core

| Key | Name | Description |
|-----|------|-------------|
| addWorknoteLinkToContext | Add Worknote Link to Context | Adds a Worknote link referencing to the execution context. |
| askForApproval | Ask For Approval | Create Approvals on any record in the ServiceNow system. You can configure a rule set for an approval, rejection, or cancellation. You can add additional rule sets to further define approval rule(s) and rejection rule(s). If a Due Date is added to an approval, it automatically approves, rejects, or cancels the approvals if the approvers have not responded. |
| associateRecordToEmail | Associate Record to Email | Associate a record with an Email [sys_email] record so that you can track which record is affected by the email. This action updates the Target field on the email record. |
| copyAttachment | Copy Attachment | Copies an attachment to a target record. The source is an attachment record. You can dynamically add and configure fields for the record. Server-side validation rules are enforced (data policy, business rules, dictionary-defined mandatory fields), but UI policy does not apply. |
| createCatalogTask | Create Catalog Task | Creates a Catalog Task on a Service Catalog Request Item [sc_req_item]. The task can be configured to be blocking or non-blocking. |
| createOrUpdateRecord | Create or Update Record | Create or update a record in a ServiceNow table by determining if it already exists. Add records that do not exist, and update existing ones. Identify existing records by selecting unique fields. Set field values dynamically and enforce server-side validation rules (data policy, business rules, dictionary-defined mandatory fields). UI policy does not apply. |
| createRecord | Create Record | Creates a record on any ServiceNow table. You can dynamically add and configure fields for the record. Server-side validation rules are enforced (data policy, business rules, dictionary-defined mandatory fields), but UI policy does not apply. |
| createTask | Create Task | Creates a task on any ServiceNow task table. After you choose the task table, you can dynamically select the fields to configure the action. A Parent field associates to a Parent record (Incident Task to Incident record).  To block the flow until this task is completed, select 'Wait'. |
| deleteAttachment | Delete Attachment | Deletes one or more attachment(s) associated with the record. You could delete a single attachment by providing File Name input field .You could also delete all the attachments bound to the record by using Delete All Attachment checbox. Either File Name input field or Delete All Attachments checkbox should be used. If a record has multiple attachments with same name, all such matching  attachments will be deleted. |
| deleteRecord | Delete Record | Deletes a record on any ServiceNow table. |
| fireEvent | Fire Event | This action can be used to fire a specific system event. This action typically passes four parameters that can be used within the event. |
| getAttachmentsOnRecord | Get Attachments on Record | Returns a list and count of the attachments associated with the provided source record. Use flow logic or scripting to process individual attachments. Returns an error if server-side validation such as ACLs, business rules, or data policies prevent the look up. |
| getCatalogVariables | Get Catalog Variables | Surface Catalog Variables on the Flow and/or on a given record. |
| getEmailHeader | Get Email Header | Access an email header value as a data pill. If multiple headers have the same name, then the action gets the value of the first header that appears. |
| getLatestResponseTextFromEmail | Get Latest Response Text From Email | This action provides the latest response text from body text of the email thread |
| log | Log | Log a message |
| lookUpEmailAttachments | Look Up Email Attachments | Retrieve attachment records associated with a particular email record |
| lookUpRecord | Look Up Record | Look up a singular record on any ServiceNow table. You can configure the conditions for the record lookup. If multiple records are found, only the first record returns. |
| lookUpRecords | Look Up Records | Look up multiple records on any ServiceNow table. You can configure the conditions for the records found. The output includes a list of records and the number of records found. Note: The maximum number of records that can be returned is configured by a property and by default is 10K records. If more than 10K records are found, only the first 10K are returned. |
| lookupAttachment | Look Up Attachment | Looks up an attachment and returns the Sys ID of the attachment. If more than one attachment is present, it searches by the file name and returns the Sys ID and if there are duplicate file names then it returns the first Sys ID encountered. A JSON Object is also returned that has all the attachments returned with File name and File size properties. Server-side validation rules are enforced (data policy, business rules, dictionary-defined mandatory fields), but UI policy does not apply. |
| moveAttachment | Move Attachment | Moves an attachment to a target record. The source is an attachment record. You can dynamically add and configure fields for the record. Server-side validation rules are enforced (data policy, business rules, dictionary-defined mandatory fields), but UI policy does not apply. |
| moveEmailAttachmentsToRecord | Move Email Attachments to Record | Moves all email attachments to a record and updates the email attachments table. To prevent issues with large email messages, the system enforces configured limits on the maximum allowed email body size, total attachment file size, and number of attachments per email. |
| recordProducer | Record Producer | Creates a record on a table in the system. |
| sendEmail | Send Email | Send rich text emails to a comma separated list of email addresses, user records, and group records. If user records do not have an email address configured, the email will not be sent to that user.   Use pills to decorate the subject line and email body. Note: Commas are not required between pills, only static email addresses |
| sendNotification | Send Notification | Send a notification in one or more formats as specified by a notification record. The notification record you select determines the notification format and recipients. |
| sendSms | Send SMS | Send SMS to user records and group records using email-based SMS. If user records do not have an SMS device configured, an SMS will not be sent to that user. |
| slaPercentageTimer | SLA Percentage Timer | Timer action for SLA percentage tracking. |
| submitCatalogItemRequest | Submit Catalog Item Request | Creates a requested item [sc_req_item] on a Service Catalog Request [sc_req]. The request can be configured to be a blocking or non-blocking task. |
| updateMultipleRecords | Update Multiple Records | Update Multiple Records on a ServiceNow table. You can configure the conditions for the records to be updated. Server-side validation rules are enforced (data policy, business rules, dictionary-defined mandatory fields), but UI policy does not apply. |
| updateRecord | Update Record | Update an existing record on a ServiceNow table. You can dynamically add and configure fields for the record. Server-side validation rules are enforced (data policy, business rules, dictionary-defined mandatory fields), but UI policy does not apply. |
| waitForCondition | Wait For Condition | Wait for condition action causes the flow to wait until the record matches the specified condition. Use this activity to block the flow indefinitely until a particular condition is met. You must populate the condition field. |
| waitForEmailReply | Wait For Email Reply | Wait for email reply action causes the flow to wait until an email reply is recieved to the input email record. Use this activity to block the flow indefinitely until the inbound email is received. You must populate the record field with a sys_email record. |
| waitForMessage | Wait For Message | Pause a flow until it receives a specific message from the flow API. Specify the string message that resumes running the flow, and optionally provide a time-out value to resume the flow if no message is received after a specific amount of time. |

Usage Pattern

All actions follow this invocation shape:

```typescript
const result = wfa.action(
  action.core.<actionName>,
  { $id: Now.ID['action_id'], annotation?: 'Description' },
  {
    // action-specific input parameters
  }
);

// Access outputs: result.field_name
```

---

Table Actions

Actions for creating, reading, updating, and deleting records in ServiceNow tables.

#### action.core.createRecord

Creates a new record on any ServiceNow table. Server-side validation rules are enforced (data policy, business rules, dictionary-defined mandatory fields), but UI policy does not apply.

Parameters:

| Parameter    | Type            | Default | Required | Description                     |
| ------------ | --------------- | ------- | -------- | ------------------------------- |
| table_name | string        | -       | Yes      | Target table name               |
| values     | TemplateValue | -       | Yes      | Field values for the new record |

Outputs:

| Field        | Type        | Description                    |
| ------------ | ----------- | ------------------------------ |
| record     | reference | Created record sys_id          |
| table_name | string    | Table where record was created |

---

#### action.core.updateRecord

Updates an existing record on a ServiceNow table. Server-side validation rules are enforced (data policy, business rules, dictionary-defined mandatory fields), but UI policy does not apply.

Parameters:

| Parameter    | Type            | Default | Required | Description                      |
| ------------ | --------------- | ------- | -------- | -------------------------------- |
| table_name | string        | -       | Yes      | Target table name                |
| record     | reference     | -       | Yes      | Record sys_id to update          |
| values     | TemplateValue | -       | Yes      | Fields to update with new values |

Outputs:

| Field        | Type        | Description                    |
| ------------ | ----------- | ------------------------------ |
| record     | reference | Updated record sys_id          |
| table_name | string    | Table where record was updated |

---

#### action.core.deleteRecord

Deletes a specific record from a table. This is a permanent operation that cannot be undone.

Parameters:

| Parameter | Type        | Default | Required | Description             |
| --------- | ----------- | ------- | -------- | ----------------------- |
| record  | reference | -       | Yes      | Record sys_id to delete |

Outputs: None -- action completes silently if successful.

---

#### action.core.lookUpRecord

Looks up a single record on any ServiceNow table with configurable conditions. If multiple records match, only the first record is returned based on sort order.

Parameters:

| Parameter                              | Type        | Default              | Required | Description                                       |
| -------------------------------------- | ----------- | -------------------- | -------- | ------------------------------------------------- |
| table                                | string    | -                    | No       | Table to search                                   |
| conditions                           | string    | -                    | No       | Encoded query conditions                          |
| sort_column                          | string    | -                    | No       | Field name to sort by                             |
| sort_type                            | 'sort_asc' \| 'sort_desc' | 'sort_asc' | No | 'sort_asc' (a to z) or 'sort_desc' (z to a) |
| if_multiple_records_are_found_action | 'use_first_record' \| 'error' | 'use_first_record' | No | What to do if multiple records match |
| dont_fail_flow_on_error              | boolean   | -                    | No       | If true, flow does not fail on error              |

Outputs:

| Field           | Type        | Description                                |
| --------------- | ----------- | ------------------------------------------ |
| Record        | reference | Found record sys_id (uppercase field name) |
| Table         | string    | Table name (uppercase field name)      |
| status        | '0' \| '1' | '0' (success) or '1' (error)          |
| error_message | string    | Error message if status is '1'         |

⚠️ Important: Output field names Record and Table are uppercase (unlike other actions which use lowercase record / table_name).

---

#### action.core.lookUpRecords

Looks up multiple records on any ServiceNow table with configurable conditions. Returns an array of records and the count of records found. Maximum 10,000 records can be returned (configurable by system property).

Parameters:

| Parameter     | Type        | Default      | Required | Description                                       |
| ------------- | ----------- | ------------ | -------- | ------------------------------------------------- |
| table       | string    | -            | No       | Table to search                                   |
| conditions  | string    | -            | No       | Encoded query conditions                          |
| max_results | integer   | 1000       | No       | Maximum number of records to return               |
| sort_column | string    | -            | No       | Field name to sort by                             |
| sort_type   | 'sort_asc' \| 'sort_desc' | 'sort_asc' | No | 'sort_asc' (a to z) or 'sort_desc' (z to a) |

Outputs:

| Field     | Type        | Description                                            |
| --------- | ----------- | ------------------------------------------------------ |
| Records | array     | Array of found record sys_ids (uppercase field name) |
| Count   | integer   | Number of records found (uppercase field name)     |
| Table   | string    | Table name (uppercase field name)                  |

⚠️ Important: Output field names Records, Count, and Table are uppercase unlike other actions.

---

#### action.core.updateMultipleRecords

Updates multiple records on a ServiceNow table based on conditions. All matching records receive the same field values. Server-side validation rules are enforced (data policy, business rules), but UI policy does not apply.

Parameters:

| Parameter                  | Type            | Default      | Required | Description                                       |
| -------------------------- | --------------- | ------------ | -------- | ------------------------------------------------- |
| table_name               | string        | -            | Yes      | Target table name                                 |
| conditions               | string        | -            | Yes      | Encoded query to filter records                   |
| field_values             | TemplateValue | -            | Yes      | Fields to update with new values                  |
| sort_column              | string        | -            | No       | Field name to sort by                             |
| sort_type                | 'sort_asc' \| 'sort_desc' | 'sort_asc' | No | 'sort_asc' (a to z) or 'sort_desc' (z to a) |
| dont_fail_flow_on_error  | boolean       | -            | No       | If true, flow does not fail on error              |

⚠️ Parameter naming: Uses field_values (not values like createRecord/updateRecord).

Outputs:

| Field     | Type        | Description                          |
| --------- | ----------- | ------------------------------------ |
| count   | integer   | Number of records updated            |
| status  | '0' \| '1' | '0' (success) or '1' (error)    |
| message | string    | Status or error message              |

---

#### action.core.createOrUpdateRecord

Creates or updates a record in a ServiceNow table by determining if it already exists. Identifies existing records using unique fields defined in the table dictionary. Server-side validation rules are enforced.

Parameters:

| Parameter    | Type            | Default | Required | Description                                           |
| ------------ | --------------- | ------- | -------- | ----------------------------------------------------- |
| table_name | string        | -       | Yes      | Target table name                                     |
| fields     | TemplateValue | -       | Yes      | Fields including unique identifiers and values to set |

⚠️ Parameter naming: Uses fields (not values like createRecord/updateRecord, or field_values like updateMultipleRecords).

Outputs:

| Field           | Type                            | Description                              |
| --------------- | ------------------------------- | ---------------------------------------- |
| record        | reference                     | Record sys_id (created or updated)       |
| status        | 'created' \| 'updated' \| 'error' | Operation result                     |
| table_name    | string                        | Table name                               |
| error_message | string                        | Error message if status is 'error'   |

Matching logic: The table must have unique fields defined for matching to work. Include the unique identifier field(s) in the fields object.

---

Communication Actions

Actions for sending notifications via email, in-platform notifications, and SMS, and for working with sys_email records and headers.

#### action.core.sendEmail

Sends rich text emails to a comma-separated list of email addresses, user records, and group records.

Parameters:

| Parameter         | Type        | Default | Required | Description                                                  |
| ----------------- | ----------- | ------- | -------- | ------------------------------------------------------------ |
| ah_to           | string    | -       | Yes      | Email recipient(s) -- comma-separated list                   |
| ah_subject      | string    | -       | Yes      | Email subject line                                           |
| ah_body         | html      | -       | No       | Email body content (supports HTML formatting; see note below)|
| record          | reference | -       | No       | Related record sys_id for tracking and association           |
| table_name      | string    | -       | No       | Table name of the related record                             |
| ah_cc           | string    | -       | No       | CC recipients -- comma-separated list                        |
| ah_bcc          | string    | -       | No       | BCC recipients -- comma-separated list                       |
| watermark_email | boolean   | true  | No       | Include "Sent by ServiceNow" watermark footer                |

⚠️ Important: ah_body does NOT support data pills -- it only accepts static strings. ah_subject and ah_to DO support data pills via template literals.

Outputs:

| Field   | Type        | Description                                          |
| ------- | ----------- | ---------------------------------------------------- |
| email | reference | sys_id of the sent email record in sys_email table |

---

#### action.core.sendNotification

Sends a notification in one or more formats as specified by a notification record.

Parameters:

| Parameter      | Type        | Default | Required | Description                                                                                |
| -------------- | ----------- | ------- | -------- | ------------------------------------------------------------------------------------------ |
| notification | reference | -       | Yes      | The notification template to trigger (sys_id or name from sysevent_email_action table)   |
| record       | reference | -       | No       | The record to associate with the notification for context                                  |
| table_name   | string    | -       | No       | The table name of the associated record                                                    |

Outputs: None.

---

#### action.core.sendSms

Sends SMS to user records and group records via email-based SMS gateway. Only works if users have an SMS device configured.

Parameters:

| Parameter    | Type     | Default | Required | Description                                                                            |
| ------------ | -------- | ------- | -------- | -------------------------------------------------------------------------------------- |
| recipients | string | -       | Yes      | The recipient's phone number(s) (E.164 format recommended: +[country code][number])  |
| message    | string | -       | Yes      | The SMS message content (plain text)                                                   |

⚠️ Template literal wrapping: recipients requires template literal wrapping when sourced from a data pill: ` recipients: ${wfa.dataPill(user.phone, "string")} `.

Outputs:

| Field   | Type        | Description                                                       |
| ------- | ----------- | ----------------------------------------------------------------- |
| email | reference | sys_id of the sent email record (SMS is sent via email gateway)   |

---

#### action.core.associateRecordToEmail

Associates a record with an sys_email record so that you can track which record is affected by the email. Updates the Target field on the email record.

Parameters:

| Parameter       | Type        | Default | Required | Description                                                                              |
| --------------- | ----------- | ------- | -------- | ---------------------------------------------------------------------------------------- |
| target_record | reference | -       | Yes      | The record to associate with the email. Updates the Target field on the sys_email record. |
| email_record  | reference | -       | Yes      | The email record from the sys_email table to associate with the target record.         |

Outputs: None.

---

#### action.core.getEmailHeader

Retrieves the value of a specific email header from a sys_email record. If multiple headers share the same name, returns the value of the first matching header.

Parameters:

| Parameter       | Type        | Default | Required | Description                                                                                  |
| --------------- | ----------- | ------- | -------- | -------------------------------------------------------------------------------------------- |
| target_header | string    | -       | Yes      | The name of the header to retrieve (e.g., From, X-ServiceNow-Generated). Case-insensitive. |
| email_record  | reference | -       | Yes      | A record from the sys_email table.                                                         |

Outputs:

| Field          | Type     | Description                                                                                |
| -------------- | -------- | ------------------------------------------------------------------------------------------ |
| header_value | string | The value of the specified email header. Returns empty string if the header is not found.  |

---

#### action.core.getLatestResponseTextFromEmail

Extracts the latest response text from the body of an email thread, stripping quoted prior messages.

Parameters:

| Parameter      | Type        | Default | Required | Description                          |
| -------------- | ----------- | ------- | -------- | ------------------------------------ |
| email_record | reference | -       | Yes      | A record from the sys_email table. |

Outputs:

| Field                  | Type     | Description                                                                                  |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------- |
| latest_response_text | string | The latest response text extracted from the email body, with quoted prior messages stripped. |

---

Control Actions

Actions for flow execution control: writing log messages, firing events, and pausing flow execution until a condition is met, an email reply arrives, or a message is received.

#### action.core.log

Writes custom messages to the flow execution log.

Parameters:

| Parameter     | Type                          | Default  | Required | Description                                |
| ------------- | ----------------------------- | -------- | -------- | ------------------------------------------ |
| log_level   | 'info' \| 'warn' \| 'error' | 'info' | No       | Log level                                  |
| log_message | string                      | -        | No       | Message to log (max 255 characters)        |

Note: Both parameters are type-optional per the SDK. However, you should always provide log_message for meaningful logging.

Outputs: None.

---

#### action.core.fireEvent

Fires a registered ServiceNow system event from within a flow, triggering downstream business rules, script actions, or notification rules that subscribe to that event. Fire-and-forget (asynchronous).

Parameters:

| Parameter    | Type        | Default | Required | Description                                                                                                                                         |
| ------------ | ----------- | ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| event_name | reference | -       | Yes      | Reference to sysevent_register; pass the registered event name as a plain string (e.g., 'incident.assigned') -- ServiceNow resolves it by name |
| record     | reference | -       | Yes      | The record associated with the event (used by event handlers)                                                                                       |
| table      | string    | -       | No       | Table name of the associated record                                                                                                                 |
| parm1      | string    | -       | No       | First string parameter passed to event handlers (max 8000 chars)                                                                                    |
| parm2      | string    | -       | No       | Second string parameter passed to event handlers (max 8000 chars)                                                                                   |

⚠️ Template literal wrapping: record, parm1, and parm2 require template literal wrapping when sourced from a data pill: ` ${wfa.dataPill(...)} `.

Outputs: None.

---

#### action.core.waitForCondition

Pauses flow execution until a specified record matches a condition. Supports optional timeout with schedule-aware countdown.

Parameters:

| Parameter          | Type        | Default | Required | Description                                                                  |
| ------------------ | ----------- | ------- | -------- | ---------------------------------------------------------------------------- |
| record           | reference | -       | Yes      | The record to monitor; must already exist                                    |
| conditions       | string    | -       | Yes      | Encoded query condition to wait for (e.g., state=6)                        |
| table_name       | string    | -       | No       | Table name of the monitored record                                           |
| timeout_flag     | boolean   | -       | No       | Set true to enable timeout; flow resumes after duration if condition unmet |
| timeout_duration | Duration  | -       | No       | How long to wait before timing out; use Duration({ ... })                  |
| timeout_schedule | reference | -       | No       | Reference to cmn_schedule; timeout clock only ticks during schedule hours  |

⚠️ Template literal wrapping: record requires template literal wrapping when sourced from a data pill: ` ${wfa.dataPill(..., 'reference')} `.

Outputs:

| Field   | Type            | Description                                                       |
| ------- | --------------- | ----------------------------------------------------------------- |
| state | '0' \| '1'    | '0' = condition met (Complete); '1' = Timeout                 |

---

#### action.core.waitForEmailReply

Pauses flow execution until an inbound email reply is received for a specific outgoing sys_email record. Supports optional timeout with schedule-aware countdown.

Parameters:

| Parameter          | Type        | Default | Required | Description                                                                  |
| ------------------ | ----------- | ------- | -------- | ---------------------------------------------------------------------------- |
| record           | reference | -       | Yes      | Reference to the outgoing sys_email record to wait for a reply to          |
| enable_timeout   | boolean   | -       | No       | Set true to resume flow after timeout_duration if no reply arrives       |
| timeout_duration | Duration  | -       | No       | How long to wait before timing out; use Duration({ ... })                  |
| timeout_schedule | reference | -       | No       | Reference to cmn_schedule; timeout clock only ticks during schedule hours  |

Outputs:

| Field         | Type            | Description                                                                  |
| ------------- | --------------- | ---------------------------------------------------------------------------- |
| state       | '0' \| '1'    | '0' = reply received (Complete); '1' = Timeout                           |
| email_reply | reference     | The inbound sys_email record of the reply; empty on timeout                |

---

#### action.core.waitForMessage

Pauses a flow until it receives a specific message string sent via the ServiceNow Flow API. Supports optional timeout.

Parameters:

| Parameter        | Type       | Default | Required | Description                                                                    |
| ---------------- | ---------- | ------- | -------- | ------------------------------------------------------------------------------ |
| message        | string   | -       | Yes      | The exact string message that resumes the flow (max 255 chars, UTF-8)          |
| enable_timeout | boolean  | -       | No       | Set true to resume flow after timeout duration if no message received      |
| timeout        | Duration | -       | No       | Duration to wait before resuming on timeout; use Duration({ ... })           |

⚠️ Parameter naming: Uses timeout (NOT timeout_duration like waitForCondition / waitForEmailReply).

Outputs:

| Field     | Type     | Description                                                          |
| --------- | -------- | -------------------------------------------------------------------- |
| payload | string | Data string passed by the caller when resuming; empty on timeout     |

---

#### Wait action naming inconsistencies

The three wait actions use different parameter names for the same conceptual pattern:

| Action               | Boolean flag       | Duration parameter   |
| -------------------- | ------------------ | -------------------- |
| waitForCondition   | timeout_flag     | timeout_duration   |
| waitForEmailReply  | enable_timeout   | timeout_duration   |
| waitForMessage     | enable_timeout   | timeout            |

---

Approval Actions

Actions for creating approval records on any ServiceNow record with configurable rule sets.

#### action.core.askForApproval

Creates approval records on a ServiceNow record with configurable rule sets. Blocking action -- flow pauses until approval is approved, rejected, or cancelled.

Parameters:

| Parameter             | Type        | Default | Required | Description                                                          |
| --------------------- | ----------- | ------- | -------- | -------------------------------------------------------------------- |
| record              | reference | -       | Yes      | Record sys_id requiring approval                                     |
| table               | string    | -       | No       | Table name of the record                                             |
| approval_conditions | object    | -       | Yes      | Approval rules configuration (build with wfa.approvalRules())      |
| approval_reason     | string    | -       | No       | Reason for the approval request (max 160 characters)                 |
| approval_field      | string    | -       | No       | Field name on the record to store approval state                     |
| journal_field       | string    | -       | No       | Field name on the record to store approval history and comments     |
| due_date            | datetime  | -       | No       | Due date configuration (build with wfa.approvalDueDate())          |

Outputs:

| Field            | Type     | Description                                                                                                              |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| approval_state | choice | One of: 'approved', 'rejected', 'requested', 'not_required', 'not requested', 'cancelled', 'skipped'        |

---

#### wfa.approvalRules()

Builder for the approval_conditions parameter of askForApproval.

Signature:

```typescript fluent
wfa.approvalRules(approvalRules: ApprovalRulesType): string
```

ApprovalRulesType structure:

```typescript fluent
{
  conditionType?: 'OR',          // Rule sets connected by OR logic
  ruleSets?: Array<{
    action: 'Approves' | 'Rejects' | 'ApprovesRejects',
    conditionType?: 'AND',       // Rules within set connected by AND logic
    rules?: Array<Array<{
      ruleType: 'Any' | 'All' | 'Res' | 'Count' | 'Percent',
      users?: Array<unknown>,    // User sys_ids (supports data pills)
      groups?: Array<unknown>,   // Group sys_ids (supports data pills)
      count?: number,            // Required for 'Count' ruleType
      percent?: number,          // Required for 'Percent' ruleType
      manual?: boolean
    }>>
  }>
}
```

ruleType values:

• 'Any' -- Approved when ANY single approver approves
• 'All' -- Approved when ALL approvers approve
• 'Res' -- All approvers responded and anyone approves or rejects
• 'Count' -- Specific number of approvals required (set count)
• 'Percent' -- Percentage of approvals required (set percent)

action values:

• 'Approves' -- This rule set can approve only
• 'Rejects' -- This rule set can reject only
• 'ApprovesRejects' -- This rule set can both approve and reject

---

#### wfa.approvalDueDate()

Builder for the due_date parameter of askForApproval. Configures automatic action (approve/reject/cancel) when the due date is reached.

Signature:

```typescript fluent
wfa.approvalDueDate(approvalDueDate: ApprovalDueDateType): string
```

ApprovalDueDateType structure:

```typescript fluent
{
  action: 'none' | 'approve' | 'reject' | 'cancel',
  dateType?: 'actual' | 'relative',
  date?: string,                    // For 'actual': '{}'; for 'relative': data pill or date string
  duration?: number,
  durationType?: 'years' | 'quarters' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds',
  daysSchedule?: string             // Schedule sys_id for business hours; empty string for calendar days
}
```

action values:

• 'none' -- No automatic action on due date
• 'approve' -- Auto-approve on due date
• 'reject' -- Auto-reject on due date
• 'cancel' -- Cancel approval on due date

dateType values:

• 'actual' -- Use date: '{}' with duration for relative time from now
• 'relative' -- Use date field with a data pill or specific date string

daysSchedule: Schedule sys_id (references cmn_schedule) for business-hours calculation. Empty string "" uses calendar days.

---

Task Actions

Actions for creating task records in any task-extended table.

#### action.core.createTask

Creates a task on any ServiceNow task table with dynamically configured fields. Optionally blocks the flow until the task is completed.

Parameters:

| Parameter      | Type            | Default | Required | Description                                                              |
| -------------- | --------------- | ------- | -------- | ------------------------------------------------------------------------ |
| task_table   | string        | -       | Yes      | Task table name (task, sc_task, change_task, etc.)                 |
| field_values | TemplateValue | -       | No       | Field values for the new task                                            |
| wait         | boolean       | -       | No       | If true, the flow blocks until the task is completed before continuing |

⚠️ Parameter naming: Uses field_values (not values like createRecord/updateRecord).

Outputs:

| Field    | Type        | Description                                            |
| -------- | ----------- | ------------------------------------------------------ |
| Record | reference | sys_id of the created task record (uppercase field name) |
| Table  | string    | Table name where task was created (uppercase field name) |

⚠️ Important: Output field names Record and Table are uppercase (unlike createRecord which uses lowercase record).

#### Common task tables

| Table                  | Purpose                     | Key Fields                                                 |
| ---------------------- | --------------------------- | ---------------------------------------------------------- |
| task                 | Generic tasks               | short_description, assigned_to, priority, due_date, parent |
| sc_task              | Service catalog tasks       | request_item, assignment_group, short_description    |
| sysapproval_approver | Approval tasks              | approver, source_table, sysapproval, state, due_date |
| change_task          | Change implementation tasks | change_request, planned_start_date, planned_end_date |
| incident_task        | Incident response tasks     | parent (incident), assigned_to, priority             |
| problem_task         | Problem investigation tasks | problem, assigned_to, work_notes                     |
| rm_task              | Release management tasks    | release, planned_start_date, planned_end_date        |

---

Service Catalog Actions

Actions for programmatic interaction with ServiceNow Service Catalog -- submitting requests, populating template variables, and creating fulfillment tasks.

#### action.core.submitCatalogItemRequest

Creates a requested item (sc_req_item) on a Service Catalog Request (sc_req).

Parameters:

| Parameter                 | Type        | Default                 | Required | Description                                                          |
| ------------------------- | ----------- | ----------------------- | -------- | -------------------------------------------------------------------- |
| catalog_item            | reference | -                       | Yes      | sys_id of catalog item (sc_cat_item) to order                      |
| catalog_item_inputs     | string    | -                       | No       | Variable assignments in ^-delimited format (max 32,000,000 chars)  |
| sysparm_quantity        | integer   | 1                     | No       | Number of items to order                                             |
| wait_for_completion     | boolean   | -                       | No       | If true, flow blocks until request is fulfilled                    |
| timeout_flag            | boolean   | -                       | No       | If true, enables timeout for blocking requests                     |
| sysparm_requested_for   | reference | -                       | No       | User to request for (sys_user); defaults to current user           |
| delivery_address        | string    | -                       | No       | Delivery address for physical items (max 4,000 chars)                |
| special_instructions    | string    | -                       | No       | Special fulfillment instructions (max 4,000 chars)                   |
| schedule                | reference | -                       | No       | Schedule for work duration (cmn_schedule)                          |
| duration                | duration  | '1970-01-01 00:00:00' | No       | Duration for scheduled work                                          |
| _snc_dont_fail_on_error | boolean   | -                       | No       | If true, flow continues on error (suppresses failures)             |

Outputs:

| Field            | Type        | Description                                                       |
| ---------------- | ----------- | ----------------------------------------------------------------- |
| requested_item | reference | sys_id of the created request item (sc_req_item)                |
| status         | choice    | Status code: 0=success, 1=error, 2=timeout (default '0')  |
| error_message  | string    | Error description if status ≠ 0 (max 10,000 chars)            |

⚠️ Variable format: catalog_item_inputs uses encoded query syntax: variable1=value1^variable2=value2.

---

#### action.core.getCatalogVariables

Populates catalog variables on a requested item from a template catalog item. No outputs -- this is a side-effect action.

Parameters:

| Parameter               | Type          | Default | Required | Description                                                                       |
| ----------------------- | ------------- | ------- | -------- | --------------------------------------------------------------------------------- |
| requested_item        | reference   | -       | Yes      | sys_id of request item to populate (sc_req_item)                                |
| template_catalog_item | reference   | -       | Yes      | Template (st_sys_catalog_items_and_variable_sets -- accepts items or var sets)  |
| catalog_variables     | slushbucket | -       | No       | Specific variables to copy from template (max 12,000 chars)                       |

Outputs: None.

⚠️ Variable references: catalog_variables accepts an array of variable property references: [catalogItem.variables.varName] (not string names).

---

#### action.core.createCatalogTask

Creates a catalog task (sc_task) on a request item with optional blocking semantics and variable population.

⚠️ Unique parameter prefix: All input parameters use the ah_ prefix (unlike other actions). The output field name "Catalog Task" contains a space.

Parameters:

| Parameter               | Type            | Default     | Required | Description                                                              |
| ----------------------- | --------------- | ----------- | -------- | ------------------------------------------------------------------------ |
| ah_requested_item     | reference     | -           | Yes      | sys_id of request item (sc_req_item)                                   |
| ah_short_description  | string        | -           | No       | Task description (max 12,000 chars)                                      |
| ah_fields             | TemplateValue | -           | No       | Additional field values (max 65,000 chars). Dependent on ah_table_name |
| ah_wait               | boolean       | true      | No       | If true, flow blocks until task completes (default is blocking)        |
| ah_table_name         | string        | 'sc_task' | No       | Table name -- read-only, always 'sc_task'                              |
| template_catalog_item | reference     | -           | No       | Template catalog item (sc_cat_item) for variable population            |
| catalog_variables     | slushbucket   | -           | No       | Catalog variables to apply to task (max 12,000 chars)                    |

Outputs:

| Field            | Type        | Description                              |
| ---------------- | ----------- | ---------------------------------------- |
| "Catalog Task" | reference | sys_id of created catalog task (sc_task) |

⚠️ Output access: Field name contains a space. Must use bracket notation: task["Catalog Task"] -- dot notation fails.

⚠️ ah_fields format: Requires TemplateValue({...}) wrapper, not plain string format.

---

SLA Actions

Actions for SLA-based timing within a flow.

#### action.core.slaPercentageTimer

Pauses the flow until a specified percentage of an SLA's duration has elapsed.

Parameters:

| Parameter         | Type        | Default | Required | Description                                                                |
| ----------------- | ----------- | ------- | -------- | -------------------------------------------------------------------------- |
| percentage      | integer   | -       | Yes      | Percentage of SLA duration to wait (0-100)                             |
| task_sla_record | reference | -       | No       | Task SLA record (task_sla)                                               |
| sla_flow_inputs | object    | -       | No       | SLA configuration object (see fields below). Usually supplied by SLA trigger |

sla_flow_inputs object fields (each string unless noted):

| Field                        | Type      | Description                          |
| ---------------------------- | --------- | ------------------------------------ |
| duration                   | string  | SLA duration                         |
| relative_duration_works_on | string  | Field the duration is computed against |
| is_repair                  | boolean | Whether the SLA is in repair mode    |
| duration_type              | string  | Duration type identifier             |
| name                       | string  | SLA definition name                  |

Outputs:

| Field                     | Type       | Description                                                                                          |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| status                  | choice   | 'completed' (default), 'paused', 'repair', 'skipped', 'cancelled'                          |
| scheduled_end_date_time | datetime | Scheduled end date/time for the SLA                                                                  |
| total_duration          | duration | Total SLA duration                                                                                   |

Status meanings:

• 'completed' -- timer reached the configured percentage successfully
• 'paused' -- SLA timer is paused
• 'repair' -- SLA is in repair mode
• 'skipped' -- timer was skipped
• 'cancelled' -- timer was cancelled

---

Attachment Actions

Actions for retrieving, copying, moving, deleting, and looking up attachments on any record (and on email records specifically). All attachment actions enforce server-side validation (ACLs, data policy, business rules); UI policy does not apply.

#### action.core.getAttachmentsOnRecord

Returns the full list and count of attachments associated with a record.

Parameters:

| Parameter       | Type        | Default | Required | Description                                                                  |
| --------------- | ----------- | ------- | -------- | ---------------------------------------------------------------------------- |
| source_record | reference | -       | Yes      | Reference to the record. Wrap in template literal (see note below)       |
| file_name     | string    | -       | No       | Optional file-name filter (max 8,000 chars)                                  |

⚠️ source_record template-literal wrapping: This action requires the reference wrapped in a template literal:

```typescript fluent
source_record: `${wfa.dataPill(params.trigger.current, "reference")}`
```

Outputs:

| Field        | Type      | Description                                       |
| ------------ | --------- | ------------------------------------------------- |
| parameter  | records | List of sys_attachment records                  |
| parameter1 | integer | Total count of attachments on the source record   |

---

#### action.core.copyAttachment

Copies an attachment to a target record, preserving the original in place.

Parameters:

| Parameter           | Type        | Default | Required | Description                                                              |
| ------------------- | ----------- | ------- | -------- | ------------------------------------------------------------------------ |
| table             | string    | -       | Yes      | Target table name (must match target_record)                           |
| target_record     | reference | -       | Yes      | Record that will receive the copy                                        |
| attachment_record | reference | -       | Yes      | sys_attachment record to copy (must be a record reference, not a sys_id string) |

Outputs: None.

⚠️ attachment_record must be a reference, not a sys_id string. If you have a string sys_id (e.g., from lookupAttachment.parameter), resolve it first via action.core.lookUpRecord on sys_attachment.

---

#### action.core.moveAttachment

Moves an attachment to a target record, removing it from the original location. Destructive.

Parameters:

| Parameter                  | Type        | Default | Required | Description                                                      |
| -------------------------- | ----------- | ------- | -------- | ---------------------------------------------------------------- |
| table                    | string    | -       | Yes      | Target table name (must match target_record)                   |
| target_record            | reference | -       | Yes      | Record that will receive the attachment                          |
| source_attachment_record | reference | -       | Yes      | sys_attachment record to move                                  |

Outputs: None.

⚠️ Destructive. Use copyAttachment if the source record must retain the file.

---

#### action.core.deleteAttachment

Deletes one or more attachments associated with a record.

Parameters:

| Parameter              | Type        | Default | Required | Description                                                              |
| ---------------------- | ----------- | ------- | -------- | ------------------------------------------------------------------------ |
| table                | string    | -       | Yes      | Table name (must match record)                                         |
| record               | reference | -       | Yes      | Record whose attachments to delete                                       |
| delete_all_          | boolean   | true  | No       | If true, deletes all attachments. If false, uses attachment_file_name |
| attachment_file_name | string    | -       | No       | File name to match when delete_all_ is false (max 8,000 chars). Deletes all matches |

Outputs: None.

⚠️ Parameter name: Trailing underscore on delete_all_ is intentional (SDK column name).

Deletion modes:

| delete_all_ | attachment_file_name | Result                                          |
| ------------- | ---------------------- | ----------------------------------------------- |
| true        | (ignored)              | All attachments on record are deleted (default) |
| false       | 'filename.ext'       | All attachments matching the name are deleted   |

---

#### action.core.lookupAttachment

Looks up an attachment on a record and returns its sys_id as a string (not a reference), plus a JSON listing of all attachments.

Parameters:

| Parameter       | Type        | Default | Required | Description                                                                  |
| --------------- | ----------- | ------- | -------- | ---------------------------------------------------------------------------- |
| source_record | reference | -       | Yes      | Record to look up attachments on                                             |
| file_name     | string    | -       | No       | Optional file-name filter (max 8,000 chars). Returns first matching sys_id   |

Outputs:

| Field        | Type     | Description                                                              |
| ------------ | -------- | ------------------------------------------------------------------------ |
| parameter  | string | sys_id of the found attachment as a plain string (first match)           |
| parameter1 | string | JSON listing of all attachments with file_name and file_size (max 4,000 chars) |

⚠️ parameter is a string sys_id, NOT a reference. It cannot be passed directly to copyAttachment.attachment_record. Resolve via action.core.lookUpRecord on sys_attachment first.

⚠️ Action name casing: lookupAttachment uses lowercase u (unlike lookUpRecord, lookUpRecords, lookUpEmailAttachments which use camelCase U). This matches the SDK export name exactly.

---

#### action.core.lookUpEmailAttachments

Retrieves attachment records associated with a specific email record from sys_email_attachment.

Parameters:

| Parameter      | Type        | Default | Required | Description                                                |
| -------------- | ----------- | ------- | -------- | ---------------------------------------------------------- |
| email_record | reference | -       | Yes      | sys_email record whose attachments to fetch              |

Outputs:

| Field               | Type      | Description                                                       |
| ------------------- | --------- | ----------------------------------------------------------------- |
| email_attachments | records | Collection of sys_email_attachment records for the given email  |

Note: Targets sys_email_attachment specifically. For attachments on non-email records, use getAttachmentsOnRecord.

---

#### action.core.moveEmailAttachmentsToRecord

Moves all attachments from an email record to a target record in a single call. No forEach required.

Parameters:

| Parameter       | Type        | Default | Required | Description                                                |
| --------------- | ----------- | ------- | -------- | ---------------------------------------------------------- |
| target_record | reference | -       | Yes      | Record that will receive all email attachments             |
| email_record  | reference | -       | Yes      | sys_email record whose attachments to move               |

Outputs: None.

⚠️ No filtering. Moves all attachments. To move specific ones, use lookUpEmailAttachments + forEach + moveAttachment instead.

---

For when-to-use guidance, best practices, anti-patterns, and end-to-end action examples, see the Action Guide.
