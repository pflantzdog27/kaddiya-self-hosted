# table-augments-guide

Tags: augments, sys_db_object, sys_dictionary, table, cross-scope

Adding Columns to an Out-of-Scope Table

Guide for adding custom columns to a platform or cross-scope table using augments. Use this when your application needs to attach fields to a table defined in another scope.


When to Use

• Your app needs to store custom data on a platform table (e.g., adding a field to incident)
• The target table is defined in another scope and you cannot modify it directly
• You want to extend a global or vendor table without creating a child table


Instructions

1. Export a Table with augments: 'table_name': Set augments to the full name of the target table (e.g., 'incident'). The exported variable name must match this value.
2. Use the target table's name as-is: Provide the full table name (e.g., 'incident'), not a scoped variant. Do not include a name property — augments replaces it.
3. Prefix all column names with your scope: Column names must begin with your application scope prefix (e.g., x_acme_) to avoid collisions with existing or future platform fields.
4. Only configure augments and schema: All other Table properties (extends, label, display, audit, etc.) are not available when augments is set — the TypeScript compiler will flag them.


Key Concepts

What `augments` Does

Setting augments to a table name tells the Fluent SDK that this Table definition adds columns to an existing table rather than creating a new one. The build produces sys_dictionary records for each column in schema but does not create a sys_db_object record, since the table already exists on the platform.

Column Naming

Columns added to out-of-scope tables must be prefixed with your application scope to prevent naming conflicts. A column named status on incident could clash with the platform's own state or future fields; x_acme_status is unambiguous and tied to your scope.


Avoidance

• Never omit the scope prefix from column names — unprefixed columns risk collisions with platform fields, both now and after upgrades.
• Never set other table properties alongside augments — properties like label, extends, and audit describe table ownership, which does not apply here. The TypeScript compiler enforces this.
• Do not use augments to create a new table — if the target table does not already exist on the platform, use a standard Table definition with name instead.


API Reference

For the full property reference, see the table-api topic.


Examples

Add a Custom Field to the Incident Table

```typescript fluent
import { Table, StringColumn } from '@servicenow/sdk/core'

export const incident = Table({
    augments: 'incident',
    schema: {
        x_acme_escalation_reason: StringColumn({
            label: 'Escalation Reason',
            maxLength: 500,
        }),
    },
})
```

Add Multiple Fields to the Task Table

```typescript fluent
import { Table, StringColumn, BooleanColumn } from '@servicenow/sdk/core'

export const task = Table({
    augments: 'task',
    schema: {
        x_acme_reviewed: BooleanColumn({ label: 'Reviewed' }),
        x_acme_reviewer_notes: StringColumn({ label: 'Reviewer Notes' }),
    },
})
```
