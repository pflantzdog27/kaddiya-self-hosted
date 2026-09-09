# slushbucketcolumn-api

Tags: SlushBucketColumn, column, table, slush bucket, multi-select

SlushBucketColumn

A Column for a slush bucket field.
Provides a dual-list selection interface for moving items between available and selected lists.


Signature

```typescript fluent
SlushBucketColumn(config)
```


Usage

```typescript fluent
const selectedItems = SlushBucketColumn({
    label: 'Selected Items',
})

// Using script method
const assignedRoles = SlushBucketColumn({
    label: 'Assigned Roles',
    script: 'getRoles()',
    mandatory: true,
})
```

Parameters

config

object

an object that can include all base Column properties

Properties:

• script (optional): string
  Script method to populate the slush bucket options.
  Example: 'getMethod()' - a server-side script that returns available options



See

• https://docs.servicenow.com/csh?topicname=table-api-now-ts.html&version=latest
