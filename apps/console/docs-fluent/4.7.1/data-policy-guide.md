# data-policy-guide

Tags: data policy, field enforcement, mandatory, read-only, server-side validation, import sets, soap, sys_data_policy2, sys_data_policy_rule, data integrity

Data Policy

Guide for creating ServiceNow Data Policies (sys_data_policy2) using the Fluent API. Data policies enforce field mandatory and read-only rules server-side across all interfaces — forms, imports, web services, and APIs — and cannot be bypassed, unlike client-side UI Policies.


When to Use

Use Data Policy when:

• User explicitly requests "data policy" or "data policies"
• Need ONLY mandatory or read-only enforcement across ALL interfaces (forms, imports, APIs, web services)
• Need server-side enforcement that cannot be bypassed
• Protecting critical fields from modification after certain conditions (e.g., closed records)
• Ensuring data integrity from external sources (imports, API calls, integrations)
• A field must be populated / required / non-empty when a condition is true — even if the word "validate" appears in the requirement

Natural language signals — Data Policy vs UI Policy vs Business Rule

The following phrases indicate mandatory/read-only enforcement. Default to Data Policy for server-side security unless the prompt explicitly mentions client-side context:

| Prompt says… | Means… | Tool |
|---|---|---|
| "must hold a value", "must carry a value", "must have a value", "is required when", "required if" | Field mandatory under a condition | DataPolicy mandatory: true |
| "locked", "read-only when", "cannot be edited when", "fields must be locked", "prevent modification" | Field read-only under a condition | DataPolicy readOnly: true |
| "cannot be modified once", "immutable after", "freeze fields after", "all fields locked" | Read-only after a state/condition | DataPolicy readOnly: true (+ Business Rule for transition guard if needed) |
| "locked against edits", "prevent changes if [field] was [value]" | Needs comparison to previous value | BusinessRule before — Data Policy cannot access previous |

Prefer table skill for unconditional enforcement: For fields that are always mandatory or always read-only, set mandatory: true or read_only: true directly on the column definition (see the table-guide topic). Use Data Policy when enforcement is conditional, OR when you need guaranteed cross-API/import enforcement as an additional security layer.


Instructions

1. STOP if prompt mentions visibility or messages: Check if the prompt mentions ONLY visibility, messages, or value-setting — use UI Policy instead. If both mandatory/read-only AND visibility/value needs exist, create a Data Policy for the mandatory/read-only part and a UI Policy for the rest.
2. Verify Data Policy is the right tool: Confirm the requirement is ONLY for mandatory or read-only enforcement. If the user needs visibility control, field values, scripts, or complex logic, use a different skill (see "When to Use" above).
3. Use the DataPolicy API from @servicenow/sdk/core. Every Data Policy must have $id, table, and shortDescription. Every individual rule inside rules must also have a $id.
4. $id naming convention: Use descriptive snake_case names in Now.ID[] — e.g., Now.ID['scope_policy_purpose']. Good: Now.ID['hr_employee_mandatory_fields']. Bad: Now.ID['policy1'].
5. Default properties: See "Default Property Values" section below. Only specify properties when overriding defaults.
6. Never set both mandatory: true and readOnly: true on the same field: These are mutually exclusive — a read-only field cannot be mandatory. This causes a build error.
7. Conditions use encoded query syntax — e.g., "priority=1^state!=6". Empty conditions apply to all records. Use ^ for AND, ^OR for OR.
8. Always use stored values in conditions: Choice fields use stored values, not display labels. Right-click field → Show Choice List → use the "Value" column.
9. Omit 'ignore' rule properties for cleaner code: Since 'ignore' is the default, only specify mandatory or readOnly when you need to change the field's state.
10. Use dot-walk notation for cross-table rules: To enforce rules on fields of a referenced table, use 'reference_field.target_field' as the rule key (e.g., 'caller_id.email'). Multiple levels are supported (e.g., 'employee.manager.department').
11. Do not make fields mandatory for out-of-scope tables: The mandatory flag is silently disabled for tables outside the current scope. Read-only rules are not affected.
12. Competing policies — most restrictive wins: When multiple policies target the same field on the same record, ServiceNow applies the most restrictive result. There is no evaluation order. To release a constraint, tighten the condition on the restrictive policy itself rather than relying on a second policy with mandatory: false.


Key Concepts

Data Policy vs UI Policy

| Aspect | Data Policy | UI Policy |
|--------|-------------|-----------|
| Execution | Server-side | Client-side (browser) |
| Can be bypassed via API? | No | Yes |
| Applies to imports | Yes (default) | No |
| Applies to REST/SOAP | Yes (default) | No |
| Visibility control | No | Yes |
| Field value actions | No | Yes |
| Scripting support | No | Yes |
| Field messages | No | Yes |

Use Data Policies for data integrity and security. Use UI Policies for UX enhancements.

Use UI Policy instead when prompt includes:
• "on the form only", "in the UI only", "to the user", "for the user"
• Visibility requirements alongside mandatory/read-only ("show section and make field required")
• Messages or warnings ("make mandatory and display a message")
• Client-side only context ("prevent users from editing on the form")

Use both Data Policy + UI Policy when:
• Prompt requires server-side enforcement (API/imports) AND client-side UX (messages/visibility)
• Example: "Make vendor mandatory for high-value contracts and show a warning message" → Data Policy (mandatory) + UI Policy (message)

For detailed UI Policy usage, see the ui-policy-guide topic.

Cross-policy conflict: If a UI Policy makes a field optional but a Data Policy makes it mandatory, the field is mandatory on save. Server-side always takes precedence.

Data Policy vs Business Rule

| Scenario | Data Policy | Business Rule |
|---|---|---|
| Field must be mandatory/read-only under a condition | ✅ | — |
| Field must be mandatory across all interfaces (imports, APIs) | ✅ | — |
| Need a custom error message | — | ✅ |
| Condition requires scripting or cross-field logic | — | ✅ |
| Auto-populate or calculate a field value | — | ✅ |
| Cascade updates to related records | — | ✅ |
| Enforce on direct GlideRecord with setWorkflow(false) | — | ✅ |
| Enforcement on out-of-scope table fields (mandatory) | — | ✅ |

Use Business Rule instead when:
• Need to compare field's previous value (e.g., "prevent changes if field was X")
• Need custom error messages or validation logic
• Need to auto-populate or calculate field values (e.g., "auto-populate field from another field")
• Condition requires scripting or complex cross-field logic
• Need transition guards (e.g., additional validation when state changes)

Decision rule: If the requirement can be expressed as "when [condition] is true, field X must have a value / must be read-only" without mentioning forms, UI, or messages — that is always a Data Policy, not a Business Rule or UI Policy. Only reach for a Business Rule when the requirement needs previous, scripting, custom messaging, or value manipulation that Data Policy cannot express.

For detailed Business Rule usage, see the business-rule-guide topic.

Default Property Values

These properties default to true and should not be written in code unless overriding:

| Property | Default | Override to false when... |
|----------|---------|------------------------------|
| active | true | Deliberately disabling the policy |
| applyToImportSets | true | Policy should not apply to imports |
| applyToSOAP | true | Policy should not apply to REST/SOAP |
| useAsUiPolicyOnClient | true | Only server-side enforcement is wanted |
| reverseIfFalse | true | Rules should remain even when conditions are false |

These default to false and should not be written in code unless overriding:

| Property | Default | Override to true when... |
|----------|---------|----------------------------|
| inherit | false | Policy should apply to child tables in hierarchy |

When Policies Apply

• No conditions (omitted): Policy applies to ALL records on the table
• With conditions: Policy applies only when conditions evaluate to true
• reverseIfFalse: true (default): Rules invert when conditions are false (mandatory → optional, read-only → editable)
• reverseIfFalse: false: No action when conditions are false — rules only apply when conditions match
• Competing policies: When multiple policies match the same record and target the same field, mandatory: true from any matching policy overrides mandatory: false from another. To release a mandatory constraint for a specific case, tighten the condition on the mandatory policy itself.

Table Inheritance

• inherit: false (default): Policy applies only to the specified table
• inherit: true: Policy applies to all tables that extend the specified table (e.g., task → incident, problem, change)

Use inheritance when child tables should follow the same rules as their parent without defining the policy separately on each.

Condition Syntax

AND operator (^) -- all conditions must be true:

```
conditions: "priority=1^state=2"
```

OR operator (^OR) -- at least one must be true:

```
conditions: "priority=1^ORpriority=2"
```

Common operators: =, !=, >, >=, <, <=, IN, LIKE, NOT LIKE, STARTSWITH, ANYTHING, EMPTYSTRING, SAMEAS, NSAMEAS, BETWEEN

Choice field patterns:

| Pattern | Condition Example |
|---------|-------------------|
| Specific value | category=hardware |
| Multiple values (OR) | categoryINhardware,software |
| Not a value | category!=hardware |
| Any value selected | category!=NULL |
| No value selected | category=NULL |

Rules Configuration

Basic rule syntax for field enforcement:

```typescript
rules: {
  field_name: {
    $id: Now.ID['policy_name_field_name_rule'],
    mandatory?: boolean | 'ignore',  // Default: 'ignore'
    readOnly?: boolean | 'ignore'    // Default: 'ignore'
  }
}
```

• $id (required): Unique identifier for the rule record
• mandatory (optional): true = required, false = optional, 'ignore' = no change
• readOnly (optional): true = locked, false = editable, 'ignore' = no change

Important:
• Each field can have only one rule per policy
• Cannot set both mandatory: true and readOnly: true on the same field
• Omit properties set to 'ignore' for cleaner code

Cross-Table Enforcement

Use dot-walk notation in rule keys to enforce rules on fields in referenced tables:

```typescript
rules: {
  'caller_id.email': { $id: Now.ID['policy_caller_email_rule'], mandatory: true },
  'assigned_to.department': { $id: Now.ID['policy_assignee_dept_rule'], readOnly: true }
}
```

Technical note: While a table property exists in DataPolicyRuleConfig for specifying which table a rule applies to, dot-walk notation is the recommended approach for cross-table enforcement. The table property is primarily used by the plugin when transforming from ServiceNow XML and for internal scope validation. For new code, always use dot-walk notation in rule keys (e.g., 'employee.department') — it is clearer and more maintainable. Never use the table property inside rules for cross-table enforcement.


API Reference

See the datapolicy-api topic for the full property reference.


Examples

Conditional Mandatory -- Require Assignment for High Priority Records

Make fields mandatory for high-priority records. reverseIfFalse defaults to true — fields become optional automatically when conditions are not met.

```typescript fluent
import { DataPolicy } from '@servicenow/sdk/core'

export const highPriorityPolicy = DataPolicy({
    $id: Now.ID['high_priority_incident_policy'],
    table: 'incident',
    shortDescription: 'Require assignment for high priority incidents',
    conditions: 'priority=1^ORpriority=2',
    rules: {
        assigned_to: {
            $id: Now.ID['high_priority_incident_policy_assigned_to_rule'],
            mandatory: true,
        },
        assignment_group: {
            $id: Now.ID['high_priority_incident_policy_assignment_group_rule'],
            mandatory: true,
        },
    },
})
```

Conditional Read-Only -- Lock Fields After Record Closure

Lock resolution fields once an incident is resolved or closed.

```typescript fluent
import { DataPolicy } from '@servicenow/sdk/core'

export const closedIncidentProtection = DataPolicy({
    $id: Now.ID['closed_incident_protection'],
    table: 'incident',
    shortDescription: 'Protect closed incident fields from modification',
    conditions: 'state=6^ORstate=7',
    rules: {
        close_code: { $id: Now.ID['closed_incident_protection_close_code_rule'], readOnly: true },
        close_notes: { $id: Now.ID['closed_incident_protection_close_notes_rule'], readOnly: true },
        resolved_at: { $id: Now.ID['closed_incident_protection_resolved_at_rule'], readOnly: true },
        resolved_by: { $id: Now.ID['closed_incident_protection_resolved_by_rule'], readOnly: true },
    },
})
```

Unconditional Mandatory -- Validate All Records Including Imports and APIs

Ensure records arriving from external systems have required fields. Omitting conditions applies the policy to all records. applyToImportSets and applyToSOAP default to true — no extra config needed.

```typescript fluent
import { DataPolicy } from '@servicenow/sdk/core'

export const userImportValidation = DataPolicy({
    $id: Now.ID['user_import_validation'],
    table: 'sys_user',
    shortDescription: 'Validate user imports and API calls',
    rules: {
        user_name: { $id: Now.ID['user_import_validation_user_name_rule'], mandatory: true },
        email: { $id: Now.ID['user_import_validation_email_rule'], mandatory: true },
        first_name: { $id: Now.ID['user_import_validation_first_name_rule'], mandatory: true },
        last_name: { $id: Now.ID['user_import_validation_last_name_rule'], mandatory: true },
    },
})
```

Mixed Rules -- Different Enforcement per Field in One Policy

Apply different rule types to different fields in one policy.

```typescript fluent
import { DataPolicy } from '@servicenow/sdk/core'

export const comprehensivePolicy = DataPolicy({
    $id: Now.ID['comprehensive_policy'],
    table: 'incident',
    shortDescription: 'Comprehensive field enforcement for critical incidents',
    conditions: 'priority=1^urgency=1',
    rules: {
        short_description: { $id: Now.ID['comprehensive_policy_short_description_rule'], mandatory: true },
        state: { $id: Now.ID['comprehensive_policy_state_rule'], readOnly: true },
        priority: { $id: Now.ID['comprehensive_policy_priority_rule'], mandatory: true, readOnly: false },
        category: { $id: Now.ID['comprehensive_policy_category_rule'], readOnly: true },
        subcategory: { $id: Now.ID['comprehensive_policy_subcategory_rule'], mandatory: true },
    },
})
```

Inherited Policy -- Apply Once, Enforce Across a Table Hierarchy

Apply a policy to a parent table so all child tables automatically inherit it.

```typescript fluent
import { DataPolicy } from '@servicenow/sdk/core'

export const taskAssignmentPolicy = DataPolicy({
    $id: Now.ID['task_assignment_policy'],
    table: 'task',
    shortDescription: 'Require assignment for in-progress tasks',
    description: 'Applies to all tables extending task (incident, problem, change, etc.)',
    inherit: true,
    conditions: 'state=2',
    rules: {
        assigned_to: { $id: Now.ID['task_assignment_policy_assigned_to_rule'], mandatory: true },
        assignment_group: { $id: Now.ID['task_assignment_policy_assignment_group_rule'], mandatory: true },
    },
})
```

Cross-Table -- Enforce Rules on Referenced Fields via Dot-Walk

Enforce rules on fields in referenced tables using dot-walk notation as rule keys.

```typescript fluent
import { DataPolicy } from '@servicenow/sdk/core'

export const incidentReferenceValidation = DataPolicy({
    $id: Now.ID['incident_reference_validation'],
    table: 'incident',
    shortDescription: 'Enforce caller contact information for high priority incidents',
    conditions: 'priority=1^urgency=1',
    rules: {
        'caller_id.email': { $id: Now.ID['incident_reference_validation_caller_id_email_rule'], mandatory: true },
        'caller_id.phone': { $id: Now.ID['incident_reference_validation_caller_id_phone_rule'], mandatory: true },
        'assigned_to.department': { $id: Now.ID['incident_reference_validation_assigned_to_department_rule'], readOnly: true },
        'assignment_group.manager': { $id: Now.ID['incident_reference_validation_assignment_group_manager_rule'], mandatory: true },
    },
})
```

Multi-Condition -- Strict Validation Using IN and AND Operators

Combine multiple condition operators to enforce strict requirements for a specific record type and state. The IN operator matches multiple states, ^ joins conditions with AND.

```typescript fluent
import { DataPolicy } from '@servicenow/sdk/core'

export const emergencyChangeValidation = DataPolicy({
    $id: Now.ID['emergency_change_validation'],
    table: 'change_request',
    shortDescription: 'Strict validation for emergency changes',
    description: 'Emergency changes require CAB approval, detailed justification, and rollback plan',
    conditions: 'type=emergency^stateIN1,2,3',
    rules: {
        cab_delegate: { $id: Now.ID['emergency_change_validation_cab_delegate_rule'], mandatory: true },
        justification: { $id: Now.ID['emergency_change_validation_justification_rule'], mandatory: true },
        backout_plan: { $id: Now.ID['emergency_change_validation_backout_plan_rule'], mandatory: true },
        risk_impact_analysis: { $id: Now.ID['emergency_change_validation_risk_impact_analysis_rule'], mandatory: true },
        emergency_contact: { $id: Now.ID['emergency_change_validation_emergency_contact_rule'], mandatory: true },
    },
})
```

Layered Validation -- Data Policy for Security, UI Policy for UX

Use Data Policy for server-side security and UI Policy for client-side UX — together for complete coverage.

```typescript fluent
import { DataPolicy, UiPolicy } from '@servicenow/sdk/core'

// Data Policy: server-side enforcement (cannot be bypassed)
export const contractDataPolicy = DataPolicy({
    $id: Now.ID['contract_approval_data_policy'],
    table: 'ast_contract',
    shortDescription: 'Enforce contract approval requirements',
    conditions: 'value>100000',
    rules: {
        vendor: { $id: Now.ID['contract_approval_data_policy_vendor_rule'], mandatory: true },
        approver: { $id: Now.ID['contract_approval_data_policy_approver_rule'], mandatory: true },
        legal_review: { $id: Now.ID['contract_approval_data_policy_legal_review_rule'], mandatory: true },
    },
})

// UI Policy: client-side visibility and messages
export const contractUiPolicy = UiPolicy({
    $id: Now.ID['contract_approval_ui_policy'],
    table: 'ast_contract',
    shortDescription: 'Show approval section for high-value contracts',
    onLoad: true,
    conditions: 'value>100000',
    actions: [
        { field: 'approval_section', visible: true },
        { field: 'approval_notes', visible: true, mandatory: true },
        { field: 'vendor', fieldMessage: 'Vendor approval required for contracts over $100,000', fieldMessageType: 'warning' },
    ],
})
```


Avoidance

• Never include default value properties in code — do NOT write active: true, applyToImportSets: true, applyToSOAP: true, useAsUiPolicyOnClient: true, reverseIfFalse: true, inherit: false, or conditions: ''
• Never set both mandatory: true and readOnly: true on the same field — mutually exclusive; causes a build error
• Never use display labels in conditions — always use stored values for choice fields (right-click field → Show Choice List → "Value" column)
• Never make fields mandatory for out-of-scope tables — the mandatory flag is silently disabled; use a Business Rule as an alternative (see the business-rule-guide topic)
• Never use a table property inside rules for cross-table enforcement — use dot-walk notation as the rule key ('employee.department') instead
• Never create conflicting Data Policies — overlapping conditions with opposing rules cause unpredictable results; most restrictive wins
• Never use Data Policies for visibility control — use UI Policies instead (see the ui-policy-guide topic)
• Never rely on UI Policies alone for critical validation — they can be bypassed via API, imports, or browser manipulation (see the ui-policy-guide topic)
• Never create policies with empty conditions unintentionally — omitting conditions applies the policy to ALL records on the table; be deliberate
