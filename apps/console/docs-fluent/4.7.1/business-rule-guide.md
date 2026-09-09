# business-rule-guide

Tags: business rule, server script, record trigger, sys_script, data validation, cascading updates, audit logging, before, after, async

Business Rules

Guide for creating ServiceNow Business Rules using the Fluent API. Business rules are server-side scripts that run automatically when records are queried, updated, inserted, or deleted.


When to Use

• Server-side logic that runs automatically on record operations
• Auto-populating or transforming field values on insert or update
• Validating data before a record is saved
• Cascading changes to related records after an operation
• Restricting or filtering queries server-side
• Logging or auditing record changes

Note: For pre-populating assignment_group or assigned_to on task-inherited tables on record operation, use an Assignment Rule instead. See assignment-rule-guide.


Instructions

1. Timing first: Choose the correct when value before writing any logic. This is the most critical decision.
2. Scope the action: Only subscribe to the actions you need (insert, update, delete, query). Never use all four unless truly required.
3. Use modules for scripts: Write server-side logic in JavaScript module files with import/export, then import the function directly in your .now.ts file. This gives you typed Glide APIs, code reuse, and full IDE support. See the module-guide topic for details.
4. Table scoping: Always use the full scoped table name (e.g., x_myapp_tablename).
5. Order matters: Set an appropriate execution order for rules that may interact. Lower numbers run first. Default is 100.
6. Conditions over scripts: Prefer filterCondition to limit when the rule fires rather than putting guard clauses inside the script. The platform evaluates conditions before loading the script.


API Reference

See the businessrule-api topic for the full property reference.


Key Concepts

Choosing the Right Timing

• before -- Runs before the record operation. Use for modifying the current record before save or validating/aborting.
• after -- Runs after the record operation. Use when you need the final saved state or need to update related records.
• async -- Runs asynchronously after the operation completes. Use for expensive operations that shouldn't block the user.
• display -- Runs when the record is displayed. Use for calculated values shown on the form but not stored.

Before vs After

• before rules can modify current and the changes persist -- the record hasn't been written yet.
• after rules cannot modify current effectively -- the record is already saved. To change fields after save, you must do a separate GlideRecord update.
• before rules with abortAction: true prevent the record operation entirely.
• after rules cannot abort -- the operation has already completed.

Script File Pattern (Modules)

Business rule scripts should be written as JavaScript modules and imported directly in the .now.ts file. Modules provide typed Glide API imports, code reuse, and full IDE support. See the module-guide topic for details.

```typescript fluent
import { validateCategory } from '../../server/business-rules/validate-category'

BusinessRule({
    $id: Now.ID['validate-category'],
    name: 'Validate Category',
    table: 'x_myapp_item',
    when: 'before',
    action: ['insert', 'update'],
    script: validateCategory,
})
```

The module file exports a function that receives current and previous GlideRecords:

```typescript fluent
// src/server/business-rules/validate-category.ts
import { GlideRecord } from '@servicenow/glide'

export function validateCategory(current: GlideRecord<'x_myapp_item'>, previous: GlideRecord<'x_myapp_item'>) {
    const category = current.getValue('category');
    if (!category) {
        current.setValue('category', 'general');
    }
}
```

> Note: The BusinessRule API accepts both functions and strings for its script property, so modules work here. For existing non-modular scripts (IIFE-wrapped), you can also use Now.include(). Not all APIs support modules — if the compiler or build reports a type mismatch when you pass a module import to a script property, the API is string-only and you should use Now.include() instead. See the now-include-guide topic.


Examples

Before Insert -- Set Defaults and Validate

Set default field values on new records and abort if validation fails.

```typescript fluent
import { BusinessRule } from '@servicenow/sdk/core'
import { setRequestDefaults } from '../../server/business-rules/set-request-defaults'

BusinessRule({
    $id: Now.ID['set-request-defaults'],
    name: 'Set Request Defaults',
    table: 'x_myapp_request',
    when: 'before',
    action: ['insert'],
    order: 100,
    script: setRequestDefaults,
})
```

```typescript fluent
// src/server/business-rules/set-request-defaults.ts
import { gs, GlideRecord } from '@servicenow/glide'

export function setRequestDefaults(current: GlideRecord<'x_myapp_request'>, previous: GlideRecord<'x_myapp_request'>){
    current.setValue('state', 'new');
    current.setValue('priority', '4');

    const title = current.getValue('short_description');
    if (!title) {
        gs.addErrorMessage('Short description is required');
        current.setAbortAction(true);
    }
}
```

After Update -- Cascade Changes to Related Records

When a parent record's state changes, update all child task records.

```typescript fluent
import { BusinessRule } from '@servicenow/sdk/core'
import { cascadeProjectState } from '../../server/business-rules/cascade-project-state'

BusinessRule({
    $id: Now.ID['cascade-project-state'],
    name: 'Cascade Project State to Tasks',
    table: 'x_myapp_project',
    when: 'after',
    action: ['update'],
    filterCondition: 'stateVALCHANGES',
    script: cascadeProjectState,
})
```

```typescript fluent
// src/server/business-rules/cascade-project-state.ts
import { GlideRecord } from '@servicenow/glide'

export function cascadeProjectState(current: GlideRecord<'x_myapp_project'>, previous: GlideRecord<'x_myapp_project'>) {
    const newState = current.getValue('state');
    if (newState === 'cancelled') {
        const tasks = new GlideRecord('x_myapp_task');
        tasks.addQuery('project', current.getUniqueValue());
        tasks.addQuery('state', '!=', 'closed');
        tasks.query();
        while (tasks.next()) {
            tasks.setValue('state', 'cancelled');
            tasks.update();
        }
    }
}
```

Async -- Heavy Processing Without Blocking

Send an external notification after record creation without making the user wait.

```typescript fluent
import { BusinessRule } from '@servicenow/sdk/core'
import { notifyExternalSystem } from '../../server/business-rules/notify-external'

BusinessRule({
    $id: Now.ID['async-external-notify'],
    name: 'Notify External System',
    table: 'x_myapp_order',
    when: 'async',
    action: ['insert'],
    priority: 100,
    script: notifyExternalSystem,
})
```

```typescript fluent
// src/server/business-rules/notify-external.ts
import { gs, GlideRecord } from '@servicenow/glide'
import { RESTMessageV2 } from '@servicenow/glide/sn_ws'

export function notifyExternalSystem(current: GlideRecord<'x_myapp_order'>, previous: GlideRecord<'x_myapp_order'>): void {
    const request = new RESTMessageV2('x_myapp.OrderAPI', 'post');
    request.setStringParameterNoEscape('order_id', current.getUniqueValue());
    request.setStringParameterNoEscape('status', current.getValue('state'));
    const response = request.execute();
    if (response.getStatusCode() !== 200) {
        gs.error('External notification failed: ' + response.getBody());
    }
}
```

Display -- Add Info Messages

Show contextual information when a user views a record, without modifying stored data.

```typescript fluent
import { BusinessRule } from '@servicenow/sdk/core'
import { displayOverdueWarning } from '../../server/business-rules/display-overdue-warning'

BusinessRule({
    $id: Now.ID['display-overdue-warning'],
    name: 'Show Overdue Warning',
    table: 'x_myapp_request',
    when: 'display',
    addMessage: true,
    message: 'This request is past its due date.',
    filterCondition: 'due_date<javascript:gs.nowDateTime()',
    script: displayOverdueWarning,
})
```

```typescript fluent
// src/server/business-rules/display-overdue-warning.ts
import { gs, GlideRecord } from '@servicenow/glide'

export function displayOverdueWarning(current: GlideRecord<'x_myapp_request'>, previous: GlideRecord<'x_myapp_request'>): void {
    const daysPastDue = gs.dateDiff(
        current.getValue('due_date'),
        gs.nowDateTime(),
        true
    );
    gs.addInfoMessage('This request is ' + daysPastDue + ' day(s) overdue.');
}
```


Avoidance

• Never call current.update() in a before rule -- the record has not been saved yet. Modifying current fields directly is sufficient; calling update() causes a redundant save and can trigger infinite loops.
• Never modify current in an after rule expecting it to persist -- the record is already saved. Use a separate GlideRecord update if you need to change the same record.
• Never use display rules for data changes -- display rules run on form load and should only add messages or set scratchpad values, not modify stored fields.
• Never use query action without careful consideration -- it runs on every single query against the table, including system queries, and can severely degrade performance.
• Never use async for logic that must complete before the user sees the result -- async rules run in a separate transaction with no timing guarantee.
• Prefer filterCondition over script-based filtering -- the platform evaluates conditions before loading the script, which is more efficient and easier to maintain than guard clauses inside script.
• Avoid using a Business Rule to pre-populate assignment_group on a task-inherited table -- Use Assignment Rules (sysrule_assignment). They have built-in order, condition, match_conditions, and group/user fields better to maintain. See the assignment-rule-guide topic.
