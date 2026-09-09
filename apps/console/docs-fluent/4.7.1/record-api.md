# record-api

Tags: Record, record, generic record, metadata, data, fallback, custom table, low-level, any table

Record

Create a record in any table. This is a low-level function typically used as
a fallback when the specific record type or metadata does not have its own
dedicated API. When possible, prefer using other, dedicated APIs to generate
metadata as those APIs will often have better type safety and will be easier
to use.


Signature

```typescript fluent
Record(config)
```


Parameters

config

Type: object

Properties:

• $id (required): string | number | ExplicitKey<string>
  Now.ID should be used to define the value. See the keys-file topic for more details.

• data (required): object
  Fields and their values in the table.

• table (required): string
  The name of the table to which the record belongs.

• $meta (optional): object
  • installMethod: 'first install' | 'demo' | 'once'
    Map a record to an output folder that loads only in specific circumstances. Always use "demo" for sample/demo data.
    'first install' - > 'unload',
    'demo' -> 'unload.demo'


See

• https://docs.servicenow.com/csh?topicname=record-api-now-ts.html&version=latest


Examples

Basic Example Record

Create a simple record on an example table

```typescript fluent
import { Record } from '@servicenow/sdk/core'

Record({
    $id: Now.ID['example-1'],
    table: 'sys_example_table',
    data: {
        name: 'John',
        age: 24,
        internal: true,
    },
})
```

Incident Sample Record

Create a sample/demo record on the incident table

```typescript fluent
import { Record } from '@servicenow/sdk/core'

Record({
    $id: Now.ID['incident-1'],
    $meta: { installMethod: 'demo' },
    table: 'incident',
    data: {
        number: 'INC0010001',
        active: true,
        description: 'This is a sample incident description',
        priority: 3,
    },
})

```

Cross-Record References Within the Same App

When a record references another record defined in the same app, pass the exported record variable directly in the data field.

> Warning: Do not use Now.ID["key"] inside data. Now.ID only resolves to a hashed sys_id in the $id property. Inside data, the literal key string is written to the database, causing reference fields to appear blank.

For same-app records, pass the record variable directly. For platform records not in your app, use a sys_id string.

```typescript fluent
import { Record } from '@servicenow/sdk/core'

// Parent record
export const vendorAcme = Record({
    $id: Now.ID['vendor-acme'],
    table: 'x_snc_vendor_man_vendor',
    data: {
        name: 'Acme Corp',
        status: 'active',
    },
})

// Child record — references the parent record variable
export const contractAcme = Record({
    $id: Now.ID['contract-acme-1'],
    table: 'x_snc_vendor_man_vendor_contract',
    data: {
        vendor: vendorAcme, // CORRECT: resolves to hashed sys_id
        // vendor: Now.ID["vendor-acme"],      // WRONG: writes literal "vendor-acme" to DB
        contract_name: 'Annual Support Agreement',
        start_date: '2025-01-01',
        status: 'active',
    },
})
```
