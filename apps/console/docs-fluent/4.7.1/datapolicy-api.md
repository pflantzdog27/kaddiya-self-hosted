# datapolicy-api

Tags: DataPolicy, data policy, server side data policy, sys_data_policy2, sys_data_policy_rule, mandatory, read-only, field enforcement

Function: DataPolicy(config)

Creates a Data Policy that enforces field mandatory and read-only rules server-side across all interfaces
(forms, lists, mobile, web services, import sets, integrations). Data Policies cannot be bypassed via API,
imports, or direct database access, unlike client-side UI Policies.


Parameters

config

DataPolicy<keyof Tables>

an object containing api properties

Properties:

• $id (required): string | number | ExplicitKey<string>

• table (required): keyof Tables
  The table to which the Data Policy applies (required)

• active (optional): boolean
  Whether the Data Policy is active

• applyToImportSets (optional): boolean
  If true, enforces policy rules during import set transformations

• applyToSOAP (optional): boolean
  If true, enforces policy rules for SOAP/REST web service operations

• conditions (optional): string
  Encoded query string defining when the policy applies

• description (optional): string
  Detailed description of the Data Policy's purpose

• inherit (optional): boolean
  If true, child tables that extend this table will inherit this policy

• modelId (optional): string
  Document ID reference for model-based policies

• reverseIfFalse (optional): boolean
  If true, reverses the policy rules when condition is false

• rules (optional): Partial<Record<TableSchemaDotWalk<T>, DataPolicyRuleConfig>> & Record<string, DataPolicyRuleConfig>
  Field-level rules (mandatory, read-only) keyed by field name. Supports dot-walk notation for reference fields. Each field can only have one rule.
  
  Nested properties (DataPolicyRuleConfig):
  
  • $id (required): string | number | ExplicitKey<string>
    Unique identifier for the rule record
  
  • mandatory (optional): boolean | 'ignore'
    Whether the field is mandatory (true), optional (false), or unchanged ('ignore'). Default: 'ignore'
  
  • readOnly (optional): boolean | 'ignore'
    Whether the field is read-only (true), editable (false), or unchanged ('ignore'). Default: 'ignore'

• shortDescription (optional): string
  A brief description of the Data Policy's purpose

• useAsUiPolicyOnClient (optional): boolean
  If true, also enforces as UI Policy on client side for immediate user feedback



See

• https://docs.servicenow.com/csh?topicname=data-policy-api-now-ts.html&version=latest



Examples

Advanced Data Policy with All Features

Create a comprehensive data policy demonstrating all available options

```typescript fluent
/**
 * @title Advanced Data Policy with All Features
 * @description Create a comprehensive data policy demonstrating all available options
 */
import { DataPolicy } from '@servicenow/sdk/core'

DataPolicy({
    $id: Now.ID['advanced_data_policy'],
    table: 'incident',
    shortDescription: 'Advanced Data Policy with All Features',
    description: 'Comprehensive data policy demonstrating all configuration options',
    conditions: 'priority=1^urgency=1',
    modelId: 'incident_model',
    rules: {
        priority: {
            $id: Now.ID['advanced_data_policy_priority_rule'],
            mandatory: true,
        },
        urgency: {
            $id: Now.ID['advanced_data_policy_urgency_rule'],
            readOnly: true,
        },
        category: {
            $id: Now.ID['advanced_data_policy_category_rule'],
            mandatory: false,
            readOnly: false,
        },
        subcategory: {
            $id: Now.ID['advanced_data_policy_subcategory_rule'],
            mandatory: 'ignore',
            readOnly: 'ignore',
        },
    },
})

```

Basic Data Policy

Create a minimal data policy for a table

```typescript fluent
/**
 * @title Basic Data Policy
 * @description Create a minimal data policy for a table
 */
import { DataPolicy } from '@servicenow/sdk/core'

DataPolicy({
    $id: Now.ID['basic_data_policy'],
    table: 'incident',
    shortDescription: 'Basic Data Policy',
})

```

data-policy-dot-walk

```typescript fluent
import { DataPolicy } from '@servicenow/sdk/core'

/**
 * Data Policy with Dot-Walk Notation for Reference Fields
 *
 * This example demonstrates how to use dot-walk notation to enforce rules
 * on fields in referenced tables. This allows you to make fields mandatory
 * or read-only in related records accessed through reference fields.
 *
 * Use Cases:
 * - Enforce caller contact information when creating incidents
 * - Ensure assigned user details are protected from modification
 * - Validate related record data across table relationships
 */

DataPolicy({
    $id: Now.ID['incident_reference_validation'],
    table: 'incident',
    shortDescription: 'Incident Reference Field Validation',
    description: 'Enforces mandatory and read-only rules on fields in referenced user records',

    // Apply when incident is high priority
    conditions: 'priority=1^urgency=1',

    rules: {
        // Make caller's email mandatory when accessing through caller_id reference
        'caller_id.email': {
            $id: Now.ID['incident_reference_validation_caller_id_email_rule'],
            mandatory: true,
        },

        // Make caller's phone mandatory
        'caller_id.phone': {
            $id: Now.ID['incident_reference_validation_caller_id_phone_rule'],
            mandatory: true,
        },

        // Protect assigned user's department from being changed
        'assigned_to.department': {
            $id: Now.ID['incident_reference_validation_assigned_to_department_rule'],
            readOnly: true,
        },

        // Protect assigned user's manager from being changed
        'assigned_to.manager': {
            $id: Now.ID['incident_reference_validation_assigned_to_manager_rule'],
            readOnly: true,
        },

        // Make assignment group's manager mandatory
        'assignment_group.manager': {
            $id: Now.ID['incident_reference_validation_assignment_group_manager_rule'],
            mandatory: true,
        },
    },
})

```

Data Policy for Import Sets and SOAP

Create a data policy for import set and SOAP enforcement. applyToImportSets and applyToSOAP both default to true — no extra configuration needed

```typescript fluent
/**
 * @title Data Policy for Import Sets and SOAP
 * @description Create a data policy that applies to import sets and SOAP web services
 */
import { DataPolicy } from '@servicenow/sdk/core'

DataPolicy({
    $id: Now.ID['import_soap_policy'],
    table: 'incident',
    shortDescription: 'Data Policy for Import and SOAP',
    description: 'Enforce data validation for records created via import sets or SOAP',
    useAsUiPolicyOnClient: false,
    rules: {
        short_description: {
            $id: Now.ID['import_soap_policy_short_description_rule'],
            mandatory: true,
        },
        caller_id: {
            $id: Now.ID['import_soap_policy_caller_id_rule'],
            mandatory: true,
        },
        category: {
            $id: Now.ID['import_soap_policy_category_rule'],
            mandatory: true,
        },
    },
})

```

Data Policy with Conditions

Create a data policy that applies only when specific conditions are met

```typescript fluent
/**
 * @title Data Policy with Conditions
 * @description Create a data policy that applies only when specific conditions are met
 */
import { DataPolicy } from '@servicenow/sdk/core'

DataPolicy({
    $id: Now.ID['policy_with_conditions'],
    table: 'incident',
    shortDescription: 'Conditional Data Policy',
    conditions: 'priority=1^urgency=1',
    description: 'Enforce mandatory fields for high priority, high urgency incidents',
    rules: {
        assigned_to: {
            $id: Now.ID['policy_with_conditions_assigned_to_rule'],
            mandatory: true,
        },
        assignment_group: {
            $id: Now.ID['policy_with_conditions_assignment_group_rule'],
            mandatory: true,
        },
    },
})

```

Data Policy with Ignore Values

Create a data policy using 'ignore' to leave field states unchanged

```typescript fluent
/**
 * @title Data Policy with Ignore Values
 * @description Create a data policy using 'ignore' to leave field states unchanged
 */
import { DataPolicy } from '@servicenow/sdk/core'

DataPolicy({
    $id: Now.ID['policy_with_ignore'],
    table: 'incident',
    shortDescription: 'Data Policy with Ignore Values',
    rules: {
        priority: {
            $id: Now.ID['policy_with_ignore_priority_rule'],
            mandatory: 'ignore',
            readOnly: true,
        },
        urgency: {
            $id: Now.ID['policy_with_ignore_urgency_rule'],
            mandatory: false,
            readOnly: 'ignore',
        },
    },
})

```

Data Policy with Rules

Create a data policy with mandatory and read-only field rules

```typescript fluent
/**
 * @title Data Policy with Rules
 * @description Create a data policy with mandatory and read-only field rules
 */
import { DataPolicy } from '@servicenow/sdk/core'

DataPolicy({
    $id: Now.ID['policy_with_rules'],
    table: 'incident',
    shortDescription: 'Data Policy with Field Rules',
    rules: {
        priority: {
            $id: Now.ID['policy_with_rules_priority_rule'],
            mandatory: true,
        },
        urgency: {
            $id: Now.ID['policy_with_rules_urgency_rule'],
            readOnly: true,
        },
        category: {
            $id: Now.ID['policy_with_rules_category_rule'],
            mandatory: true,
            readOnly: false,
        },
    },
})

```

Read-Only Fields for Closed Records

Lock resolution fields once an incident is resolved or closed. reverseIfFalse defaults to true — fields become editable again if the record re-opens.

```typescript fluent
/**
 * @title Read-Only Fields for Closed Records
 * @description Lock resolution fields once an incident is resolved or closed
 */
import { DataPolicy } from '@servicenow/sdk/core'

DataPolicy({
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

Data Policy with Table Inheritance

Apply a policy to a parent table so all child tables automatically inherit it. Use inherit: true when child tables (e.g., incident, problem, change) should follow the same rules without defining the policy separately on each.

```typescript fluent
/**
 * @title Data Policy with Table Inheritance
 * @description Apply a policy to a parent table so all child tables automatically inherit it
 */
import { DataPolicy } from '@servicenow/sdk/core'

DataPolicy({
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

Layered Validation with UI Policy

Use Data Policy for server-side mandatory enforcement and UI Policy for client-side visibility and messages — together for complete coverage.

```typescript fluent
/**
 * @title Layered Validation with UI Policy
 * @description Use Data Policy for server-side security and UI Policy for client-side UX
 */
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
