# override-guide

Tags: $override, override, custom fields, unknown properties, x_ properties, u_ properties, extension fields, escape hatch, fluent-language

`$override` — Setting Properties Not Modeled by the API

$override is an escape hatch on Fluent API constructors. Use it to set fields that the typed API does not expose — typically customer-added columns (x_/u_ prefixed), fields added by another application, or out-of-the-box columns that simply aren't in the API surface yet.


When to Use

• A customer or scoped-application column on the underlying table (e.g. x_acme_priority, u_team) that the Fluent API doesn't know about.
• A field added by a separate application or plugin on the same table.
• An out-of-the-box column that exists on the platform but isn't surfaced by the API yet.

If the field is modeled by the API, set it directly — $override skips validation and IntelliSense, so it should be a last resort, not the default.


Usage

$override accepts a flat object of column name → value. Values may be string, boolean, or number.

```typescript fluent
import { BusinessRule, Now } from '@servicenow/sdk/core'

BusinessRule({
    $id: Now.ID['set-priority-on-incident'],
    name: 'Set priority on incident',
    collection: 'incident',
    when: 'before',
    actionInsert: true,
    script: `(function() { current.priority = 1; })()`,
    $override: {
        x_acme_priority: 'high',
        u_audit_enabled: true,
        u_retry_count: 3,
    },
})
```

The keys in $override are the database column names (snake_case), not Fluent property names. They are written to the record verbatim during build.


Notes & Gotchas

• No type checking. The API doesn't know these columns exist, so typos in column names or wrong value types won't be caught until the record is applied to an instance.
• Column must exist on the target table. If the column isn't present on the instance (in the app's own scope or a dependency), install will silently ignore it.
• Prefer the typed API when available. If the field is in the API surface, set it through the typed property — you keep IntelliSense, type checking, and refactor safety.
• Reference fields: pass the target record's sys_id as a string.


When Not to Use

• Setting fields that are modeled by the API — use the defined API property.
• Setting protected sys fields like sys_id, sys_updated_by, etc
