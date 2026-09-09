# assignment-rule-guide

Tags: assignment rule, assignment-rule, task assignment, auto-assign, routing, assignment_group, assigned_to, pre-populate, sysrule_assignment, pre-assignment, task routing, assign

Assignment Rules

Guide for creating ServiceNow Assignment Rules using the Fluent API. Assignment rules automatically populate assignment_group or assigned_to fields on task or task-inherited tables when a record is created or updated.


When to Use

Any custom table whose parent or ancestor is task (directly or through any of the tables below) qualifies for assignment rules. If the table does NOT extend task, use a Business Rule instead.

OOB Task-Extended Tables

The following are examples of out-of-box tables that extend task. Any custom table that extends task or any of these tables can use assignment rules:

| OOB table        | Label             |
| ---------------- | ----------------- |
| task           | Task (base)       |
| incident       | Incident          |
| change_request | Change Request    |
| change_task    | Change Task       |
| problem        | Problem           |
| problem_task   | Problem Task      |
| sc_request     | Request           |
| sc_req_item    | Requested Item    |
| sc_task        | Catalog Task      |
| sn_si_incident | Security Incident |
| hr_case        | HR Case           |
| hr_task        | HR Task           |
| csm_order      | Consumer Order    |

Example: If you create a custom table u_security_task that extends sn_si_incident, it can use assignment rules because sn_si_incident extends task.

Use assignment rules when:

• Automatically assigning tasks, incidents, changes, or problems to users or groups
• Routing records to teams based on specific conditions (category, priority, location)
• Implementing workload distribution logic (round-robin, load balancing)
• Assigning records based on field values (e.g., "assign hardware incidents to hardware team")
• Setting up dynamic assignment using scripts
• User wants a team to already appear / be pre-populated in the assignment group when a form opens
• User wants to avoid manual team selection
• Custom table extends or inherits from any task-based table and needs automatic user or group assignment on form open


Assignment rules vs Business rules

Use Assignment Rules when:

• Primary goal is to assign records to users or groups when creating or updating a record
• Working with task or task-extended tables (incident, change, problem, etc.)
• Assignment logic is condition-based and relatively straightforward
• You want to use the platform's built-in assignment engine

Use Business Rules when:

• You need assignment to happen on insert, update, or other database operations (not record open) or tables not extended from tasks
• You need complex logic beyond assignment (field updates, validations, integrations)
• You need precise control over timing (before/after/async/display)
• You need to perform multiple operations beyond assignment
• You need to work with tables that don't inherit from task tables
• You need assignment logic to run in the background without user interaction


Key Concepts

Assignment rules run when you open a record and automatically set assigned_to or assignment_group fields.

Important limitations:

• Assignment rules are only applicable to task or task-extended tables (incident, change_request, problem, sc_req_item, etc.)

Static assignment vs Script-based assignment

Static Assignment (Recommended for Simple Cases):

• Set group field to a specific group sys_id
• Set user field to a specific user sys_id
• No script needed
• Fast and simple
• Example: "All hardware incidents go to Hardware group"

Script-Based Assignment (For Complex Logic):

• Use script field to write JavaScript assignment logic
• Access current record via current variable
• Use setDisplayValue() for setting groups/users by name
• Example: Round-robin assignment, load balancing, conditional logic

Static vs Script-Based:

• Static: Set group or user field to a sys_id (simple, fast)
• Script-Based: Use script field for conditional logic, round-robin, etc.


Instructions

Pre-flight: Validate group/user existence (MANDATORY)

Before writing any code, query the instance to confirm the target group or user exists.

• Skip only if: the user has explicitly provided the sys_id — use it directly.
• If the query succeeds and returns a match: Use the sys_id from the result in the group or user field for static assignment.
• If the query returns no match: Query again with a partial/case-insensitive name to find similar records. If still not found, STOP and ask the user: (a) provide the sys_id directly if they know it, (b) create the group/user, (c) use a different existing group/user, or (d) proceed with a script-based setDisplayValue() approach (with the caveat that it will only work once the group/user is created).
• If the query cannot be executed (MCP unavailable, auth failed, instance unreachable): STOP and inform the user before proceeding.

---

Follow these steps to implement assignment rules:

1. Verify table eligibility (CRITICAL): Confirm the table extends task (incident, change_request, problem, sc_req_item, change_task, sc_task, or custom task-inherited table). Assignment rules do NOT work on non-task tables. Always verify the correct table name with the user.

2. Define conditions: Specify when the rule should fire when a record is opened (category, priority, status, custom fields). Use the condition field with ServiceNow's encoded query syntax. Assignment rules evaluate conditions before executing scripts.

3. Set match conditions: Set match_conditions to 'ALL' (default) to require all conditions to match, or 'ANY' to match if any condition is true.

4. Determine assignment target: Decide on group vs user assignment or both. Groups are preferred for scalability and flexibility. If the group or user name is not explicitly provided, query the sys_user_group table (for groups) or sys_user table (for users) to get the correct name or label before proceeding.

5. Write script if needed: For simple assignments (static group/user), set the group or user field directly using the sys_id obtained in the Pre-flight step. For moderately complex logic (round-robin, load balancing, conditional routing by category), use the script field with server-side JavaScript. If the logic is very complex (requires external API calls, multiple GlideRecord queries, aggregated data, or exceeds 8000 characters), use a business rule instead — assignment rules are designed for straightforward routing at record open time.

6. Single rule for multiple use cases (CRITICAL): When handling multiple assignment scenarios for the same table (e.g., hardware incidents → Hardware Team, software incidents → Software Team, network incidents → Network Team), create a single script-based assignment rule with conditional logic (if/else statements) rather than multiple separate assignment rules. This improves maintainability and avoids order-dependent conflicts.

7. Set execution order: If multiple rules exist, set appropriate order values. Lower numbers run first (e.g., order 10 runs before order 50, which runs before order 100). Default is 100. Use this to implement tiered assignment strategies:
   • High priority rules (order 1-30): VIP callers, critical incidents, emergency changes
   • Medium priority rules (order 40-70): Specialized routing based on specific conditions
   • Default/catch-all rules (order 80-100): General assignment for unassigned records

8. Configure metadata: Set active: true to enable the rule. Use clear, descriptive names that explain what the rule does (e.g., "Assign Hardware Incidents to Hardware Team"). Use Now.ID["identifier"] where the identifier is in kebab-case (lowercase with hyphens) and descriptively matches the rule's purpose. Examples: Now.ID["hardware-incident-assignment"], Now.ID["vip-caller-assignment"].


API Reference

Assignment rules use the generic Record() API with table: "sysrule_assignment". There is no dedicated AssignmentRule() Fluent API.

Table Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | String | Yes | Descriptive name for the rule (max 40 characters). |
| table | TableName | Yes | Target table (must extend task). Default: 'incident'. |
| active | Boolean | No | Whether the rule is active. Default: true. |
| condition | String | No | Encoded query defining when the rule fires (max 1000 characters). Must end with ^EQ. |
| match_conditions | String | No | How multiple conditions are evaluated: 'ALL' (all must match) or 'ANY' (any matches). Default: 'ALL'. |
| group | Reference | No | sys_id of the assignment group (sys_user_group). Prefer over user for scalability. |
| user | Reference | No | sys_id of the assigned user (sys_user). Use for individual assignment. |
| script | String | No | Server-side JavaScript (max 8000 characters). current is the opened record. Overrides group/user. |
| order | Integer | No | Execution order. Lower numbers run first. Default: 100. |
| description | String | No | Description of the rule's purpose (max 4000 characters). |

Condition Syntax

Encoded query syntax (must end with ^EQ): = (equals), != (not equal), ^ (AND), ^OR (OR), IN (list), ISEMPTY, ISNOTEMPTY

```
category=hardware^EQ                     // Single condition
category=hardware^priority=1^EQ          // AND condition
stateIN1,2^EQ                            // OR list
```

Script Patterns

Use Now.include("path/to/file.js") for external scripts or inline with backticks. Access record via current variable.

```javascript
// Simple assignment
current.assignment_group.setDisplayValue("Hardware Team");

// Conditional
if (current.priority == "1") {
  current.assignment_group.setDisplayValue("Critical Response Team");
} else {
  current.assignment_group.setDisplayValue("Standard Support");
}
```


Examples

Static Group Assignment

```typescript fluent
import '@servicenow/sdk/global'
import { Record } from "@servicenow/sdk/core";

export const hardwareIncidentAssignment = Record({
  $id: Now.ID["hardware-incident-assignment"],
  table: "sysrule_assignment",
  data: {
    name: "Assign Hardware Incidents to Hardware Team",
    table: "incident",
    active: true,
    condition: "category=hardware^EQ",
    group: "<sys_id_of_hardware_group>",
    order: 100
  }
});
```

Script-Based with Now.include

Fluent Definition:

```typescript fluent
import '@servicenow/sdk/global'
import { Record } from "@servicenow/sdk/core";

export const categoryBasedAssignment = Record({
  $id: Now.ID["category-based-assignment"],
  table: "sysrule_assignment",
  data: {
    name: "Assign by Category",
    table: "incident",
    active: true,
    order: 100,
    script: Now.include("../../server/assignment-rules/category-based.js")
  }
});
```

Script File:

```javascript
if (current.category == "Hardware")
  current.assignment_group.setDisplayValue("Hardware");
else if (current.category == "Software")
  current.assignment_group.setDisplayValue("Software");
else
  current.assignment_group.setDisplayValue("Service Desk");
```

Execution Order Priority

```typescript fluent
// High priority (order 10) - runs first
import '@servicenow/sdk/global'
import { Record } from "@servicenow/sdk/core";

export const vipAssignment = Record({
  $id: Now.ID["vip-assignment"],
  table: "sysrule_assignment",
  data: {
    name: "VIP Caller Assignment",
    table: "incident",
    condition: "caller_id.vip=true^EQ",
    group: "<vip_support_group_sys_id>",
    order: 10
  }
});

// Default (order 100) - runs last
export const defaultAssignment = Record({
  $id: Now.ID["default-assignment"],
  table: "sysrule_assignment",
  data: {
    name: "Default Assignment",
    table: "incident",
    condition: "assignment_group=^EQ",
    group: "<service_desk_sys_id>",
    order: 100
  }
});
```

Round-Robin Assignment

```typescript fluent
import '@servicenow/sdk/global'
import { Record } from "@servicenow/sdk/core";

export const roundRobinAssignment = Record({
  $id: Now.ID["round-robin-assignment"],
  table: "sysrule_assignment",
  data: {
    name: "Round-Robin Assignment",
    table: "incident",
    order: 100,
    script: Now.include("../../server/assignment-rules/round-robin.js")
  }
});
```

Script:

```javascript
var gr = new GlideRecord("sys_user_grmember");
gr.addQuery("group.name", "Service Desk");
gr.addQuery("user.active", true);
gr.query();

var users = [];
while (gr.next()) users.push(gr.user.sys_id.toString());

if (users.length > 0) {
  var incidentNum = parseInt(current.number.toString().replace(/[^0-9]/g, ""));
  current.assigned_to = users[incidentNum % users.length];
  current.assignment_group.setDisplayValue("Service Desk");
}
```


Avoidance

• Never use on non-task tables — Use business rules instead
• Never expect to run on insert/update — Runs on record open only
• Never create multiple rules for same table — Use single rule with if/else logic
• When using script, avoid setting group/user — script silently overrides static assignments; setting both is confusing and the static values are ignored
• Never skip the instance query (step 5) — Always query sys_user_group or sys_user on the instance before writing the rule. Do NOT use setDisplayValue() or ask the user whether to create/use setDisplay until after a query has been attempted and returned no match. A queried sys_id used in the group/user field is the preferred outcome — this is NOT hardcoding. Exception: If the user has explicitly provided the sys_id, skip the query and use it directly.
• Never silently fall back to setDisplayValue() — setDisplayValue() is only acceptable when explicitly chosen by the user after being informed the group/user was not found on the instance (see step 5 options). It must never be used as a default or convenience shortcut.
• Avoid complex logic — If script exceeds 8000 chars, needs external APIs, or multiple GlideRecord queries, use business rule instead


Related Topics

See business-rule-guide, client-script-guide, table-guide topics
