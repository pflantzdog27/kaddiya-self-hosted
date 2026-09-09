# templatevaluecolumn-api

Tags: TemplateValueColumn, column, table, template value

TemplateValueColumn

A Column for a template value field.
Stores template strings with support for variable substitution.
Accepts string values (use templateValue() helper for objects).


Signature

```typescript fluent
TemplateValueColumn(config)
```


Usage

```typescript fluent
const fields = TemplateValueColumn({
    label: 'Fields',
    dependent: 'referenced_table',
    default: templateValue<'sc_cat_item'>({ cost: 100, description: 'Item' }),
})
```

Parameters

config

object

Properties:

• dependent (required): string
  Field name (string) of a TableNameColumn within the same table schema.
  This is metadata indicating which field provides the table context for template variables.



See

• https://docs.servicenow.com/csh?topicname=table-api-now-ts.html&version=latest
