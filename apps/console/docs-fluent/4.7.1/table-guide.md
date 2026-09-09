# table-guide

Tags: table, column, field, schema, relationship, related-list, data-model, sys-db-object, sys-dictionary, sys-relationship

Tables, Columns, and Relationships Guide

Guide for creating ServiceNow Tables (sys_db_object), Columns (sys_dictionary), and Relationships (sys_relationship) to define data models. Use when the user mentions tables, columns, fields, schema, extending tables, relationships, related lists, or data modeling.


When to Use

• When creating new tables to store application data
• When adding columns (fields) to new or existing tables
• When extending an existing table (e.g., extending task)
• When setting up relationships between tables or configuring related lists
• When defining choices, defaults, or dynamic values for fields

For field enforcement rules: Use column properties (mandatory, readOnly) for unconditional rules that always apply. For conditional enforcement, choose based on where the rule applies:
• Data policies — server-side enforcement on both UI and API, applies regardless of how the record is created/updated. See the data-policy-guide topic.
• UI policies — client-side enforcement in forms only, for dynamic field visibility, mandatory, and read-only rules based on form state. See the ui-policy-guide topic.
• Business rules — server-side logic for complex validation, field calculations, or enforcement that requires scripting beyond simple mandatory/read-only rules. See the business-rule-guide topic.


Key Concepts

• Tables define the data model. Columns define the fields. Relationships connect tables and display related records as lists on forms.
• Implicit vs explicit relationships: If a reference field exists between tables, the relationship is implicit (no extra record needed). If not, create an explicit sys_relationship record.
• To access the table using the Table API, allowWebServiceAccess must be enabled.


Instructions

Creating a New Table

1. Table naming: The name must start with the application scope prefix (e.g., x_acme_my_table). The exported variable name MUST match the name property exactly.
2. Choose column types carefully: Only use supported column types. Only import the types you use to avoid build errors.
3. Extending tables: Use the extends property to inherit all fields from a base table. Only extend tables marked as extensible.
4. Cross-scope access: Set accessibleFrom, callerAccess, and actions based on whether other scoped apps need access. Default to package_private unless public access is needed.
5. Enable web service access: If the table will be accessed via the Table API (/api/now/table) or any REST integration, set allowWebServiceAccess: true. This defaults to false -- without it, REST calls return 403 "User Not Authorized" even when ACLs are correctly configured.

Adding Columns to an Existing Table

6. When adding columns to a table in a different scope, set augments to the target table name on the Table definition (e.g., augments: 'incident'). Only augments and schema are configurable in this mode — name is not used. Prefix column names with your application scope. See the table-augments-guide topic for details.
7. Import only the column types you actually use -- unused imports cause build errors.

Setting Up Relationships

8. Reference field exists between tables: Use implicit relationship (no sys_relationship needed).
9. No reference field or custom query logic needed: Create explicit sys_relationship record.
10. Adding existing platform relationship (e.g., Attachments): Use known REL: ID directly.


Avoidance

1. Never mismatch the exported variable name and the name property -- they must be identical.
2. Never use unsupported column types -- only use types listed in the Column Types section.
3. Never mix basic and advanced relationship fields in the same record.
4. Never omit the wrapper in query_with scripts -- must use (function refineQuery(current, parent) { ... })(current, parent); format.
5. Never hardcode sys_id strings in record references -- use ${record.$id}.
6. Never omit allowWebServiceAccess when the table will be accessed via REST -- it defaults to false, and the Table API will return 403 even with correct ACLs.

---


Table API Reference

For the full property reference and examples, see the table-api topic.

---


Column Type Reference

Column Type Selection Guide

| Data | Column Type | Notes |
|------|------------|-------|
| Short text | StringColumn | maxLength < 254 renders single-line |
| Long text | MultiLineTextColumn or StringColumn | maxLength >= 255 renders multi-line |
| Dropdown/choices | ChoiceColumn or StringColumn with choices + dropdown | StringColumn allows free-text too |
| True/false | BooleanColumn | |
| Whole numbers | IntegerColumn | Supports min and max |
| Decimal numbers | DecimalColumn | |
| Floating point | FloatColumn | Use scale for decimal places |
| Foreign key | ReferenceColumn | Set referenceTable |
| Multi-value reference | ListColumn | Set referenceTable |
| Multi-select picker | SlushBucketColumn | Set script for available items |
| Date only | DateColumn | Format: yyyy-mm-dd |
| Date and time | DateTimeColumn | Format: yyyy-mm-dd HH:mm:ss |
| Duration | DurationColumn | Default: { days, hours, minutes, seconds } |
| Time of day | TimeColumn | Default: { hours, minutes, seconds } |
| HTML/rich text | HtmlColumn | Use html() helper for defaults |
| URL | UrlColumn | Must be http:// or https:// |
| Email | EmailColumn | Must be user@domain format |
| JSON | JsonColumn | Use json() helper for defaults |
| Field list | FieldListColumn | Needs dependent or attributes.table |
| Server script | ScriptColumn | |
| Radio buttons | RadioColumn | Requires choices |

All Supported Column Types

ListColumn, RadioColumn, StringColumn, MultiLineTextColumn, ApprovalRulesColumn, SlushBucketColumn, ChoiceColumn, ScriptColumn, BooleanColumn, ConditionsColumn, DecimalColumn, FloatColumn, IntegerColumn, VersionColumn, DomainIdColumn, FieldNameColumn, FieldListColumn, ReferenceColumn, RecordsColumn, TableNameColumn, UserRolesColumn, BasicImageColumn, DocumentIdColumn, DomainPathColumn, TranslatedTextColumn, SystemClassNameColumn, TranslatedFieldColumn, GenericColumn, DateColumn, DateTimeColumn, CalendarDateTimeColumn, BasicDateTimeColumn, DueDateColumn, IntegerDateColumn, ScheduleDateTimeColumn, OtherDateColumn, DurationColumn, TimeColumn, DayOfWeekColumn, DaysOfWeekColumn, JsonColumn, NameValuePairsColumn, HtmlColumn, UrlColumn, EmailColumn, TemplateValueColumn, GuidColumn.

Only import the types you use.

Common Column Properties

| Name | Type | Description |
|------|------|-------------|
| label | String or Array | Display label for the column. |
| maxLength | Number | Maximum value length. Default: 40. |
| active | Boolean | Display in lists and forms. Default: true. |
| mandatory | Boolean | Require a value to save. Default: false. |
| readOnly | Boolean | Prevent editing. Default: false. |
| default | Any | Default value when creating a record. |
| choices | Object | Choices for ChoiceColumn and compatible types. |
| dropdown | String | 'none', 'dropdown_without_none', 'dropdown_with_none', 'suggestion'. |
| attributes | Object | Dictionary attributes. |
| dynamic_value_definitions | Object | Dynamic defaults: calculated_value, dynamic_default, dependent_field, choices_from_other_table. |
| function_definition | String | Glide function definition (e.g., 'glidefunction:concat(...)'). |

ReferenceColumn Specifics

```typescript fluent
ReferenceColumn({
  label: 'Assigned To',
  referenceTable: 'sys_user',
  cascadeRule: 'none', // 'none' | 'cascade' | 'delete' | 'restrict' | 'clear'
})
```

#### Filtering reference values

Use useReferenceQualifier to control how the picker is filtered:

• 'simple' — pair with referenceQual holding an encoded query.
• 'advanced' — pair with referenceQual holding a javascript: scripted qualifier.
• 'dynamic' — pair with dynamicRefQual pointing at a sys_filter_option_dynamic record.

referenceQual and dynamicRefQual are mutually exclusive.

```typescript fluent
// Simple encoded query — only show active ITIL users
ReferenceColumn({
  label: 'Assigned To',
  referenceTable: 'sys_user',
  useReferenceQualifier: 'simple',
  referenceQual: 'active=true^roles=itil',
})

// Advanced javascript: qualifier — context-aware filter
ReferenceColumn({
  label: 'Approver',
  referenceTable: 'sys_user',
  useReferenceQualifier: 'advanced',
  referenceQual: "javascript:'department=' + current.getValue('department')",
})

// Dynamic qualifier — dynamicRefQual takes a reference to a sys_filter_option_dynamic
// record. See the `now-ref` guide for record-reference forms.
ReferenceColumn({
  label: 'Owner',
  referenceTable: 'sys_user',
  useReferenceQualifier: 'dynamic',
  dynamicRefQual: refToSysFilterOptionDynamic,
})
```

> Note: catalog variables (ReferenceVariable, ListCollectorVariable) support reference qualifiers but use different property names — see the ReferenceVariable and ListCollectorVariable topics. For an inherited column on an extended table, use OverrideColumn and its referenceQualifier property instead — see the OverrideColumn topic for details.

Cross-Scope Column Pattern

Use augments to add columns to a table owned by another scope. See the table-augments-guide topic for full instructions.

```typescript fluent
export const incident = Table({
    augments: 'incident',
    schema: {
        x_acme_my_column: StringColumn({ label: 'My Custom Field' }),
    },
})
```

---


Relationship and Related List Reference

Determine the Relationship Path

1. Reference field exists between tables: Implicit relationship (no sys_relationship needed).
2. No reference field or custom query: Explicit relationship (create sys_relationship record).
3. Existing platform relationship: Use known REL: ID.

Common Platform Relationship IDs

• Attachments: REL:b9edf0ca0a0a0b010035de2d6b579a03
• Applications with Role: REL:66c422fac0a80a880012fadcb8c2480e
• Approval History: REL:247c6f15670303003b4687cb5685ef32

Implicit Relationship Example

```typescript fluent
// Table A has a ReferenceColumn pointing to Table B
// Only need sys_ui_related_list + sys_ui_related_list_entry

const listRecord = Record({
  $id: Now.ID['department_related_list'],
  table: 'sys_ui_related_list',
  data: { name: 'department', view: 'Default view' },
});

Record({
  $id: Now.ID['department_related_list_entry'],
  table: 'sys_ui_related_list_entry',
  data: {
    list_id: listRecord.$id,
    position: '0',
    related_list: 'custom_task.department', // table.reference_field format
  },
});
```

Explicit Relationship Example

```typescript fluent
// No reference field -- need sys_relationship + sys_ui_related_list + sys_ui_related_list_entry

export const departmentRel = Record({
  $id: Now.ID['department_rel_id'],
  table: 'sys_relationship',
  data: {
    advanced: false,
    basic_apply_to: 'sn_foo_department',
    basic_query_from: 'sn_foo_student',
    name: 'Department Allocation Relationship',
    query_with: `(function refineQuery(current, parent) {
    current.addQuery('department', parent.id);
})(current, parent);`,
    simple_reference: false,
  },
});

const listRecord = Record({
  $id: Now.ID['department_related_list_id'],
  table: 'sys_ui_related_list',
  data: {
    name: 'sn_foo_department',
    view: 'Default view',
  },
});

Record({
  $id: Now.ID['department_related_list_entry_id'],
  table: 'sys_ui_related_list_entry',
  data: {
    list_id: listRecord.$id,
    position: '0',
    related_list: `REL:${departmentRel.$id}`,
  },
});
```

Relationship Properties (`sys_relationship`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | No | Descriptive name |
| basic_apply_to | TableName | No | Parent table (basic mode) |
| basic_query_from | TableName | No | Child table (basic mode) |
| reference_field | FieldName | No | Reference field for the relationship |
| query_with | Script | No | Script to refine the query |
| advanced | Boolean | No | Whether advanced mode (default: false) |
| simple_reference | Boolean | No | Whether simple reference relationship |

Multiple Related Lists Pattern

One sys_ui_related_list per table, multiple sys_ui_related_list_entry records for different relationships:

```typescript fluent
const productContainer = Record({
  $id: 'products_related_lists',
  table: 'sys_ui_related_list',
  data: { name: 'sn_product_life_products', view: 'Default view' },
});

Record({
  $id: 'feature_requests_entry',
  table: 'sys_ui_related_list_entry',
  data: { list_id: productContainer.$id, position: 0, related_list: 'feature_requests.product' },
});

Record({
  $id: 'testing_reports_entry',
  table: 'sys_ui_related_list_entry',
  data: { list_id: productContainer.$id, position: 1, related_list: 'testing_reports.product' },
});
```

query_with Script Format

```javascript
(function refineQuery(current, parent) {
    current.addQuery('field', parent.field);
})(current, parent);
```

The current variable represents the child table query. The parent variable represents the record on the form where the related list appears.
