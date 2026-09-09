# wfa-flow-logic-guide

Tags: flow-logic, wfa, workflow-automation, flow-designer, conditional, loop, if-else, forEach, exit-loop, skip-iteration, end-flow, condition-syntax, doInParallel, parallel-execution, tryCatch, try-catch, error-handling, appendToFlowVariables, append-flow-variables, array-manipulation

Workflow Automation Flow Logic Guide

Flow logic constructs control how a flow executes -- branching, looping, and termination. They are invoked from inside a flow or subflow body via wfa.flowLogic.*.

For API signatures, parameter tables, and condition operator reference, see the Flow Logic API.

---


Overview

| Type            | Constructs                             | Use For          |
| --------------- | -------------------------------------- | ---------------- |
| Conditional | if, elseIf, else                 | Branching        |
| Loops       | forEach, skipIteration, exitLoop | Iteration        |
| Control     | endFlow                              | Flow termination |

Condition syntax: Encoded query format -- use = not ==, ^ for AND, ^OR for OR. See the Flow Logic API → Condition Syntax Reference for the full operator catalog.


When to Use Which Construct

| Pattern                    | Flow Logic Construct | Use When                                   |
| -------------------------- | -------------------- | ------------------------------------------ |
| Route to different actions | if/elseIf/else | Different actions for different conditions |
| Process a list of records  | forEach            | Batch processing, multiple records         |
| Stop processing early      | exitLoop           | Found target record, limit reached         |
| Skip records in processing | skipIteration      | Filtering, validation failed               |
| Stop entire flow           | endFlow            | Early termination on critical condition    |

---


Conditional: if / elseIf / else

Conditional branching allows flows to execute different actions based on dynamic conditions evaluated at runtime.

When to Use

• Route flow execution based on field values (priority, status, category)
• Implement business logic with multiple decision paths
• Handle different scenarios based on trigger data or action results
• Validate lookup results before processing

Best Practices

1. Use Template Literals -- Always wrap data pill conditions: ` ${wfa.dataPill(...)}=value `
2. Single Equals for Comparison -- Use = not == (ServiceNow encoded query format)
3. Check Empty Values -- Use ISEMPTY/ISNOTEMPTY operators for null, undefined, or empty string checks
4. Complex Conditions -- Use ^ for AND, ^OR for OR:
   • AND: ` ${wfa.dataPill(field1)}=1^${wfa.dataPill(field2)}=2 `
   • OR: ` ${wfa.dataPill(field1)}=1^OR${wfa.dataPill(field2)}=2 `
5. Reference Field Comparisons -- Compare sys_id values using .value, not display values
6. Avoid Deep Nesting -- Prefer elseIf chains over nested if statements for readability
7. Validate Lookup Results -- Check status='0' before using lookup results

Common Use Cases

• Priority-Based Routing -- Route incidents based on priority (1=critical → on-call, 2=high → senior, else → standard queue)
• State Transition Logic -- Different actions for resolved (state=6) vs closed (state=7)
• Approval Result Handling -- Check approval_state (approved, rejected, cancelled)
• Lookup Result Validation -- Check Count>0 before processing results
• Category-Based Processing -- Different workflows for hardware/software/service requests

Example

```typescript fluent
wfa.flowLogic.if(
  {
    $id: Now.ID["check_priority"],
    condition: `${wfa.dataPill(params.trigger.current.priority, "string")}=1`,
    annotation: "Check if priority is critical"
  },
  () => {
    wfa.action(
      action.core.updateRecord,
      { $id: Now.ID["escalate"] },
      {
        table_name: "incident",
        record: wfa.dataPill(params.trigger.current, "reference"),
        values: TemplateValue({ state: 2 })
      }
    );
  }
);

wfa.flowLogic.elseIf(
  {
    $id: Now.ID["check_priority_2"],
    condition: `${wfa.dataPill(params.trigger.current.priority, "string")}=2`,
    annotation: "Check if priority is high"
  },
  () => {
    // Actions for priority 2 incidents
  }
);

wfa.flowLogic.else(
  { $id: Now.ID["default_case"], annotation: "Handle all other priorities" },
  () => {
    // Default actions
  }
);
```

Important Notes

• Condition Syntax -- Uses ServiceNow encoded query format (same as GlideRecord filters)
• Field Types Matter -- Boolean uses true/false, choice fields use internal values (not labels)
• Runtime Evaluation -- Conditions evaluated at runtime using current data pill values
• Sequence Matters -- if/elseIf/else blocks evaluate in order. Once matched, subsequent blocks are skipped.
• elseIf/else must follow if -- Standalone elseIf or else is invalid.

Integration Notes

With Actions:

• Conditional blocks can contain any actions (create, update, lookup, send)
• Action outputs from previous steps can be used in condition evaluation

With Loops:

• Conditionals can be used inside forEach loops for per-item processing
• Combine with exitLoop/skipIteration for advanced loop control

---


Loops: forEach

Iterate over arrays of records or data, executing actions for each item in the collection.

When to Use

• Process multiple records from lookUpRecords
• Bulk operations on multiple items
• Send notifications to multiple users/groups
• Iterate over flow variable arrays

Best Practices

1. Limit Record Processing -- Use max_results in lookUpRecords to prevent timeouts. Keep iterations under 100-200 records for optimal performance.
2. Use skipIteration for Filtering -- Skip items that don't meet criteria instead of wrapping the entire loop body in conditional logic.
3. Use exitLoop for Early Exit -- Stop loop when goal is achieved (e.g., finding first match). This improves performance by avoiding unnecessary iterations.
4. Consider Batch Actions -- For simple updates without complex logic, updateMultipleRecords is more efficient than forEach + updateRecord.
5. Validate Loop Input -- Check that the array/records exist before looping to avoid flow errors on empty results.

Common Use Cases

| Scenario             | Pattern                                    | Notes                                      |
| -------------------- | ------------------------------------------ | ------------------------------------------ |
| Bulk assignment      | forEach + updateRecord                 | Consider updateMultipleRecords if simple |
| Team notifications   | forEach + sendNotification/sendEmail | Personalize message per recipient          |
| Find first available | forEach + if + exitLoop              | Stop when first match found                |
| Filter and process   | forEach + if + skipIteration         | Skip items not meeting criteria            |
| Cascading updates    | forEach + nested lookups + update        | Update related records for each item       |

Performance Considerations

forEach loop behavior:

• No hard technical limit -- forEach will process any number of records provided
• Performance recommendation -- Keep iterations under 100-200 records per flow execution for optimal performance
• Large loops can cause -- Flow execution timeouts, system resource constraints, slower processing

For large datasets:

• Always specify max_results based on expected workload
• Use skipIteration to filter early and reduce processing
• Use exitLoop when you find what you need
• For very large datasets, use batch processing with multiple scheduled flow executions

Warning signs:

• ⚠️ lookUpRecords without max_results parameter
• ⚠️ forEach loops with >200 iterations
• ⚠️ Heavy operations (API calls, complex updates) within loops
• ⚠️ Nested forEach loops with large outer datasets

Example

```typescript fluent
// Lookup records
const results = wfa.action(
  action.core.lookUpRecords,
  { $id: Now.ID["find_incidents"] },
  {
    table: "incident",
    conditions: "active=true^priority=1",
    max_results: 50
  }
);

// Iterate over results
wfa.flowLogic.forEach(
  wfa.dataPill(results.Records, "array.object"),
  { $id: Now.ID["process_incidents"], annotation: "Update each incident" },
  incident => {
    wfa.action(
      action.core.updateRecord,
      { $id: Now.ID["update_incident"] },
      {
        table_name: "incident",
        record: wfa.dataPill(incident.sys_id, "reference"),
        values: TemplateValue({ state: 2 })
      }
    );
  }
);
```

Important Notes

• Sequential Processing -- forEach processes items sequentially, not in parallel. Each iteration completes before the next begins.
• Timeout Limits -- Very large loops (>200 items) may timeout. Use batching or multiple flows for large datasets.
• Item Reference -- The loop item variable references the current iteration's data. Use wfa.dataPill with the item reference to access fields.
• Break and Continue -- Use exitLoop (like break) to stop the loop entirely; skipIteration (like continue) to skip current iteration only.
• Data Modification -- Modifying the looped array during iteration can cause unexpected behavior. Complete the loop before modifying source data.

---


exitLoop

Immediately exits the current forEach loop and continues flow execution after the loop.

When to Use

• ✅ Finding first match in search
• ✅ Goal achieved, remaining iterations unnecessary
• ✅ Critical error prevents further processing
• ❌ Filtering items (use skipIteration instead)
• ❌ Terminating entire flow (use endFlow instead)

Best Practices

1. Add Annotations -- Explain why loop is exiting for better debugging and flow diagram readability.

   ```typescript fluent
   wfa.flowLogic.exitLoop({
     $id: Now.ID["exit"],
     annotation: "Found first available technician - stopping search"
   });
   ```

2. Use with Conditionals -- exitLoop should always be inside if/elseIf blocks. Unconditional exitLoop makes the loop pointless.
3. exitLoop vs skipIteration:
   • Use exitLoop: "Find first available technician and assign" (stop processing entirely)
   • Use skipIteration: "Process all high-priority incidents, skip low priority" (continue with next item)
4. exitLoop vs endFlow:
   • exitLoop: Exits current loop, continues flow execution after loop
   • endFlow: Terminates entire flow immediately
5. Nested Loops -- In nested loops, exitLoop only exits the innermost loop. To exit multiple levels, use flags or multiple exitLoop statements.

Example

```typescript fluent
wfa.flowLogic.forEach(
  wfa.dataPill(results.Records, "array.object"),
  { $id: Now.ID["search_loop"] },
  record => {
    // Check if we found the target record
    wfa.flowLogic.if(
      {
        $id: Now.ID["check_match"],
        condition: `${wfa.dataPill(record.number, "string")}=INC0001234`
      },
      () => {
        // Found the target -- exit loop
        wfa.flowLogic.exitLoop({ $id: Now.ID["exit_loop"] });
      }
    );
  }
);
```

Important Notes

• Scope -- exitLoop only exits the current forEach loop. In nested loops, it exits only the innermost loop.
• Flow Continues -- After exitLoop, flow execution continues with the next action after the loop.
• No Return Value -- exitLoop does not return a value. Use conditional logic or update records to track exit reason.
• Immediate Exit -- exitLoop takes effect immediately. Any code after exitLoop in the same iteration will not execute.

---


skipIteration

Skips the current forEach iteration and continues with the next item in the loop.

When to Use

• Filter items based on criteria
• Skip items that don't meet conditions
• Skip already-processed items
• Handle edge cases gracefully

Best Practices

1. Early Exit Pattern -- Place skip checks at the beginning of the loop for efficiency. This avoids executing unnecessary logic for items that will be skipped.

   ```typescript fluent
   wfa.flowLogic.forEach(items, { $id: Now.ID["loop"] }, item => {
     // Skip check first -- saves processing time
     wfa.flowLogic.if(
       {
         $id: Now.ID["check"],
         condition: ${wfa.dataPill(item.priority, "string")}=5
       },
       () => {
         wfa.flowLogic.skipIteration({
           $id: Now.ID["skip"],
           annotation: "Skipping low priority item"
         });
       }
     );

     // Main processing only runs for non-skipped items
   });
   ```

2. Add Annotations -- Explain why iteration is skipped for better debugging and flow execution history understanding.
3. Use with Conditionals -- skipIteration should always be inside if/elseIf blocks. Unconditional skipIteration makes the loop pointless.
4. Multiple Skip Conditions -- Use multiple if statements with skipIteration for different skip reasons. Each can have its own annotation for clarity.
5. skipIteration vs exitLoop:
   • skipIteration: "Skip inactive users but process active ones" (continues loop)
   • exitLoop: "Found the user we need, stop searching" (stops entire loop)
6. Performance Benefit -- skipIteration improves performance by avoiding unnecessary processing. Place checks early to maximize savings.

Example

```typescript fluent
wfa.flowLogic.forEach(
  wfa.dataPill(results.Records, 'array.object'),
  { $id: Now.ID['filter_loop'] },
  (record) => {
    // Skip if already assigned
    wfa.flowLogic.if(
      {
        $id: Now.ID['check_assigned'],
        condition: `${wfa.dataPill(record.assigned_to, 'string')}ISNOTEMPTY`
      },
      () => {
        wfa.flowLogic.skipIteration({ $id: Now.ID['skip'] });
      }
    );

    // Process unassigned records
    wfa.action(action.core.updateRecord, { $id: Now.ID['assign'] }, { /* ... */ });
  }
);
```

Important Notes

• Continues Loop -- skipIteration skips the current iteration and immediately moves to the next item. The loop continues processing remaining items.
• Immediate Effect -- Once skipIteration executes, no further code in that iteration runs. Control jumps to the next iteration.
• No Return Value -- skipIteration does not return a value. Use counters or logs to track skipped items if needed.
• Nested Loops -- In nested loops, skipIteration only skips the current iteration of the innermost loop.

---


Flow Termination: endFlow

Immediately terminates the entire flow execution. No subsequent actions or logic will execute.

When to Use

Use endFlow when you need to terminate flow based on runtime conditions that cannot be determined at trigger time:

• Conditions depend on lookup results (not available at trigger time)
• Runtime validation needed (state can change after trigger fires)
• Complex business logic that can't be expressed in trigger conditions
• Duplicate prevention checks requiring database lookups
• Permission validation requiring role/group membership checks

Prefer trigger conditions when possible:

```typescript fluent
// Less efficient: flow fires for all incidents, then endFlow filters out
wfa.flowLogic.if(
  {
    $id: Now.ID["check"],
    condition: `${wfa.dataPill(params.trigger.current.priority, "string")}!=1`
  },
  () => {
    wfa.flowLogic.endFlow({ $id: Now.ID["end"] });
  }
);

// More efficient: filter at trigger level with condition "priority=1"
```

Best Practices

1. Use Trigger Conditions First -- Filter at trigger level when possible to avoid unnecessary flow executions. This improves system performance and reduces flow execution logs.
2. Combined Conditions -- Use AND (^) and OR (^OR) in trigger conditions instead of multiple endFlow checks.
3. Add Annotations -- Always explain why flow is ending. This helps with debugging and understanding flow execution history.

   ```typescript fluent
   wfa.flowLogic.endFlow({
     $id: Now.ID["end"],
     annotation: "Duplicate request detected - ending to prevent double processing"
   });
   ```

4. Use Conditionally -- Always use endFlow inside conditional blocks. Unconditional endFlow at start of flow makes the trigger pointless.
5. Handle Edge Cases -- Use endFlow to gracefully handle edge cases and prevent errors from invalid data or states.

Common Use Cases

• Duplicate Prevention -- Check if request/record already exists before processing
• Permission Validation -- Verify user has required role/group membership
• State Validation -- Re-check current record state (may have changed since trigger)
• Dependency Check -- Verify parent/related records exist and are valid
• Business Rules Enforcement -- Exit when business rules determine no action needed

Example

```typescript fluent
// Check for error condition
wfa.flowLogic.if(
  {
    $id: Now.ID["check_error"],
    condition: `${wfa.dataPill(result.status, "integer")}=1`
  },
  () => {
    // Log error
    wfa.action(
      action.core.log,
      { $id: Now.ID["log_error"] },
      {
        log_level: "error",
        log_message: "Critical error - terminating flow"
      }
    );

    // Terminate flow
    wfa.flowLogic.endFlow({ $id: Now.ID["end_flow"] });
  }
);
```

Important Notes

• Immediate Termination -- endFlow immediately terminates the entire flow. No subsequent actions, logic, or loops will execute.
• No Return Value -- endFlow does not return a value or set output variables. The flow simply stops.
• Execution Status -- Flows that end via endFlow show as "Completed" in execution logs. Use annotations to distinguish.
• Nested Contexts -- endFlow terminates the entire flow even when called from inside loops, conditionals, or nested logic.
• Different from exitLoop -- exitLoop exits a loop but continues flow. endFlow terminates the entire flow execution.

---


Parallel Execution: doInParallel

Executes multiple code blocks in parallel within a flow, allowing independent operations to run concurrently.

When to Use

• Execute independent actions simultaneously (notifications, logging, updates to different tables)
• Improve flow performance when operations don't depend on each other
• Send multiple notifications or emails at once
• Update multiple unrelated records in parallel

Best Practices

1. Independent Operations Only -- Only use for operations that don't depend on each other's results. Each block should be self-contained.
2. No Nesting -- doInParallel cannot be nested inside another doInParallel block. This is enforced at build time.
3. Error Handling -- If one parallel block fails, other blocks continue executing. Use tryCatch inside blocks for error handling.
4. Keep Blocks Simple -- Each parallel block should have a clear, single purpose. Complex logic makes debugging difficult.
5. Avoid Shared State -- Don't modify the same flow variables or records across multiple parallel blocks.

Common Use Cases

| Scenario | Pattern | Notes |
| -------- | ------- | ----- |
| Multiple notifications | doInParallel + multiple sendNotification | Send to different users/groups simultaneously |
| Logging + updates | doInParallel + log + updateRecord | Log and update can happen in parallel |
| Multi-table updates | doInParallel + multiple updateRecord | Update unrelated tables at once |
| Parallel API calls | doInParallel + multiple REST actions | Execute independent API calls concurrently |

Example

```typescript fluent
wfa.flowLogic.doInParallel(
  { $id: Now.ID["parallel_notifications"], annotation: "Send notifications in parallel" },
  () => {
    // Block 1: Notify assignee
    wfa.action(
      action.core.sendNotification,
      { $id: Now.ID["notify_assignee"] },
      {
        to: wfa.dataPill(params.trigger.current.assigned_to, "reference"),
        subject: "New incident assigned",
        body: "You have been assigned a new incident"
      }
    );
  },
  () => {
    // Block 2: Notify manager
    wfa.action(
      action.core.sendNotification,
      { $id: Now.ID["notify_manager"] },
      {
        to: wfa.dataPill(params.trigger.current.assignment_group.manager, "reference"),
        subject: "Team incident notification",
        body: "New incident assigned to your team"
      }
    );
  },
  () => {
    // Block 3: Log action
    wfa.action(
      action.core.log,
      { $id: Now.ID["log_parallel"] },
      {
        log_level: "info",
        log_message: "Parallel notifications sent"
      }
    );
  }
);
```

Important Notes

• Execution Order -- Parallel blocks may complete in any order. Don't assume a specific sequence.
• No Return Values -- Parallel blocks cannot return values to each other. Use flow variables if you need to share data.
• Build-Time Validation -- Nesting is detected at build time and will cause a compilation error.
• Flow Designer Representation -- In Flow Designer, parallel blocks appear as separate branches under the parallel container.

---


Error Handling: tryCatch

Provides try-catch error handling within flows, allowing graceful handling of action failures.

When to Use

• Handle potential action failures gracefully (API calls, lookups, external integrations)
• Provide fallback logic when operations might fail
• Log errors and continue flow execution
• Implement retry logic with alternative approaches

Best Practices

1. Specific Error Handling -- Use catch blocks for specific error scenarios, not as a catch-all.
2. Log Errors -- Always log in the catch block to track failures and aid debugging.
3. Provide Fallbacks -- Catch blocks should provide meaningful fallback behavior, not just log and continue.
4. Nested Try-Catch -- Can be nested for granular error handling at different levels.
5. Don't Overuse -- Not every action needs try-catch. Use for operations with known failure modes.

Common Use Cases

| Scenario | Pattern | Notes |
| -------- | ------- | ----- |
| API call failures | tryCatch + REST action + fallback | Handle external service unavailability |
| Lookup validation | tryCatch + lookUpRecord + default | Provide default when record not found |
| Record creation | tryCatch + createRecord + log | Handle duplicate or validation errors |
| Integration errors | tryCatch + integration action + notification | Alert on integration failures |

Example

```typescript fluent
wfa.flowLogic.tryCatch(
  {
    $id: Now.ID["try_catch_lookup"],
    annotation: "Handle lookup failure gracefully"
  },
  {
    try: () => {
      // Attempt to look up a record that might not exist
      const lookup = wfa.action(
        action.core.lookUpRecord,
        { $id: Now.ID["lookup_user"] },
        {
          table_name: "sys_user",
          conditions: `sys_id=${wfa.dataPill(params.trigger.current.assigned_to, "string")}`
        }
      );
      
      wfa.action(
        action.core.log,
        { $id: Now.ID["lookup_success"] },
        {
          log_level: "info",
          log_message: `User found: ${wfa.dataPill(lookup.Record.name, "string")}`
        }
      );
    },
    catch: () => {
      // Handle lookup failure (record not found or error)
      wfa.action(
        action.core.log,
        { $id: Now.ID["lookup_failure"] },
        {
          log_level: "error",
          log_message: "User lookup failed - using system user as fallback"
        }
      );
      
      // Fallback: use system user
      wfa.flowLogic.setFlowVariables(
        { $id: Now.ID["set_fallback"] },
        params.flowVariables,
        { assignedUser: "system" }
      );
    }
  }
);
```

Nested Try-Catch Example

```typescript fluent
wfa.flowLogic.tryCatch(
  { $id: Now.ID["outer_try"], annotation: "Outer error handling" },
  {
    try: () => {
      wfa.action(
        action.core.log,
        { $id: Now.ID["outer_try_log"] },
        { log_level: "info", log_message: "Outer try block" }
      );
      
      // Nested try-catch for granular error handling
      wfa.flowLogic.tryCatch(
        { $id: Now.ID["inner_try"] },
        {
          try: () => {
            wfa.action(
              action.core.updateRecord,
              { $id: Now.ID["risky_update"] },
              {
                table_name: "incident",
                record: wfa.dataPill(params.trigger.current, "reference"),
                values: TemplateValue({ state: 2 })
              }
            );
          },
          catch: () => {
            wfa.action(
              action.core.log,
              { $id: Now.ID["inner_catch_log"] },
              { log_level: "warn", log_message: "Update failed, continuing" }
            );
          }
        }
      );
    },
    catch: () => {
      wfa.action(
        action.core.log,
        { $id: Now.ID["outer_catch_log"] },
        { log_level: "error", log_message: "Outer catch block" }
      );
    }
  }
);
```

Important Notes

• Both Handlers Required -- Both try and catch must be arrow functions.
• Catch Executes on Error -- The catch block only runs if an error occurs in the try block.
• Flow Continues -- After catch block completes, flow execution continues with subsequent logic.
• No Error Object -- Unlike JavaScript, the catch block doesn't receive an error object. Use logging to track failures.

---


Array Operations: appendToFlowVariables

Appends element(s) to array-typed flow variables, specifically Array.Object variables.

When to Use

• Build lists of items during flow execution (collecting records, accumulating data)
• Append results from loops to a collection
• Aggregate data from multiple sources
• Build dynamic arrays for downstream processing

Best Practices

1. Array.Object Only -- Only works with FlowArray({ elementType: FlowObject(...) }) variables. Other array types are not supported.
2. Declare Variables First -- Flow variables must be declared in the flow/subflow config before appending.
3. Object Elements -- When appending array literals, each element must be an object or datapill, not primitives.
4. Initialize Arrays -- Arrays start empty. No need to initialize before first append.
5. Multiple Appends -- Can append to the same variable multiple times throughout the flow.

Common Use Cases

| Scenario | Pattern | Notes |
| -------- | ------- | ----- |
| Collect loop results | forEach + appendToFlowVariables | Build array from loop iterations |
| Aggregate data | Multiple appendToFlowVariables | Collect data from different sources |
| Build notification list | Conditional + appendToFlowVariables | Dynamically build recipient list |
| Accumulate records | lookUpRecords + forEach + append | Filter and collect specific records |

Example: Single Element Append

```typescript fluent
// Flow config with Array.Object variable
Flow(
  {
    $id: Now.ID["collect_data_flow"],
    name: "Collect Data Flow",
    flowVariables: {
      collectedItems: FlowArray({
        label: "Collected Items",
        mandatory: false,
        elementType: FlowObject({
          fields: {
            name: StringColumn({ label: "Name" }),
            id: IntegerColumn({ label: "ID" })
          },
          label: "Item",
          mandatory: false
        }),
        childName: "item"
      })
    }
  },
  wfa.trigger(/* ... */),
  (params) => {
    // Append single element
    wfa.flowLogic.appendToFlowVariables(
      {
        $id: Now.ID["append_single"],
        annotation: "Add one item"
      },
      params.flowVariables,
      {
        collectedItems: { name: "Alice", id: 1 }
      }
    );
  }
);
```

Example: Array Append

```typescript fluent
// Append multiple elements at once
wfa.flowLogic.appendToFlowVariables(
  {
    $id: Now.ID["append_multiple"],
    annotation: "Add multiple items"
  },
  params.flowVariables,
  {
    collectedItems: [
      { name: "Bob", id: 2 },
      { name: "Charlie", id: 3 },
      { name: "Dana", id: 4 }
    ]
  }
);
```

Example: Append in Loop

```typescript fluent
const results = wfa.action(
  action.core.lookUpRecords,
  { $id: Now.ID["lookup"] },
  {
    table: "sys_user",
    conditions: "active=true",
    max_results: 50
  }
);

wfa.flowLogic.forEach(
  wfa.dataPill(results.Records, "array.object"),
  { $id: Now.ID["process_users"] },
  (user) => {
    // Filter: only append users with specific role
    wfa.flowLogic.if(
      {
        $id: Now.ID["check_role"],
        condition: `${wfa.dataPill(user.roles, "string")}CONTAINS admin`
      },
      () => {
        wfa.flowLogic.appendToFlowVariables(
          { $id: Now.ID["append_admin"] },
          params.flowVariables,
          {
            collectedItems: {
              name: wfa.dataPill(user.name, "string"),
              id: wfa.dataPill(user.sys_id, "string")
            }
          }
        );
      }
    );
  }
);
```

Example: Multi-Target Append

```typescript fluent
// Append to multiple array variables in one call
wfa.flowLogic.appendToFlowVariables(
  {
    $id: Now.ID["append_multi_target"],
    annotation: "Append to two arrays"
  },
  params.flowVariables,
  {
    collectedItems: [{ name: "Eve", id: 5 }],
    otherArray: [{ field1: "value1", field2: 123 }]
  }
);
```

Important Notes

• Type Safety -- TypeScript enforces that target variables are arrays at compile time.
• Runtime Validation -- Build-time checks ensure array elements are objects or datapills, not primitives.
• Array.Object Requirement -- Only FlowArray({ elementType: FlowObject(...) }) is supported. Primitive arrays (string[], integer[]) are not supported.
• Empty Arrays -- Arrays start empty and grow with each append. No initialization needed.
• Performance -- Appending in loops is efficient. No need to batch appends.

---


⚠️ JavaScript NOT Supported in Conditions

Flow logic conditions (if, elseIf, else) do NOT support JavaScript functions like javascript:gs.daysAgoStart(30) or javascript:gs.beginningOfThisWeek().

Only use:

• Data pill comparisons with static values
• Data pills from trigger outputs
• Data pills from action outputs
• Encoded query operators (=, !=, <, >, ISEMPTY, etc.)

```typescript fluent
// ❌ WRONG - JavaScript function not supported in if
wfa.flowLogic.if(
  { $id: Now.ID["wrong"], condition: `${wfa.dataPill(params.trigger.current.sys_updated_on, "glide_date_time")}<javascript:gs.daysAgoStart(30)` },
  () => { /* ... */ }
);

// ❌ WRONG - JavaScript function not supported in elseIf
wfa.flowLogic.if({ $id: Now.ID["a"], condition: "..." }, () => { /* ... */ });
wfa.flowLogic.elseIf(
  { $id: Now.ID["wrong_elseif"], condition: `${wfa.dataPill(params.trigger.current.due_date, "glide_date_time")}<javascript:gs.beginningOfThisWeek()` },
  () => { /* ... */ }
);

// ✅ CORRECT - Data pill comparison in if/elseIf
wfa.flowLogic.if(
  { $id: Now.ID["check_p1"], condition: `${wfa.dataPill(params.trigger.current.priority, "string")}=1` },
  () => { /* ... */ }
);
wfa.flowLogic.elseIf(
  { $id: Now.ID["check_p2"], condition: `${wfa.dataPill(params.trigger.current.priority, "string")}=2` },
  () => { /* ... */ }
);

// ✅ CORRECT - Comparing data pills from action outputs
const lookup = wfa.action(action.core.lookUpRecords, { $id: Now.ID["lookup"] }, { /* ... */ });
wfa.flowLogic.if(
  { $id: Now.ID["check_count"], condition: `${wfa.dataPill(lookup.Count, "integer")}>0` },
  () => { /* ... */ }
);
```

Note: JavaScript functions work in table action conditions (lookUpRecords, updateMultipleRecords), but NOT in flow logic conditions.

---


Using Data Pills in Conditions

Template Literal Pattern:

```typescript fluent
// ✅ Use data pills directly in template literal
condition: `${wfa.dataPill(params.trigger.current.priority, "string")}=1`
```

Comparison Between Data Pills:

```typescript fluent
// ✅ Compare two data pills
condition: `${wfa.dataPill(params.trigger.current.assigned_to, "string")}=${wfa.dataPill(params.trigger.sys_updated_by, "string")}`
```

Complex Conditions:

```typescript fluent
// ✅ Multiple data pills in one condition
condition: `${wfa.dataPill(params.trigger.current.priority, "string")}=1^${wfa.dataPill(params.trigger.current.active, "string")}=true`
```

---


Complete Example

End-to-end flow combining if, forEach, skipIteration, exitLoop, and else:

```typescript fluent
import { Flow, wfa, trigger, action } from "@servicenow/sdk/automation";

Flow(
  {
    $id: Now.ID["process_high_priority_incidents"],
    name: "Process High Priority Incidents"
  },

  wfa.trigger(
    trigger.record.created,
    { $id: Now.ID["incident_created"] },
    {
      table: "incident",
      condition: "priority=1^active=true",
      run_flow_in: "background"
    }
  ),

  params => {
    // Lookup related problems
    const problems = wfa.action(
      action.core.lookUpRecords,
      { $id: Now.ID["find_problems"] },
      {
        table: "problem",
        conditions: "active=true",
        max_results: 50
      }
    );

    // Check if any problems found
    wfa.flowLogic.if(
      {
        $id: Now.ID["check_problems_found"],
        condition: `${wfa.dataPill(problems.Count, "integer")}>0`
      },
      () => {
        // Process each problem
        wfa.flowLogic.forEach(
          wfa.dataPill(problems.Records, "array.object"),
          { $id: Now.ID["process_problems"] },
          problem => {
            // Skip resolved problems
            wfa.flowLogic.if(
              {
                $id: Now.ID["check_resolved"],
                condition: `${wfa.dataPill(problem.state, "string")}=6`
              },
              () => {
                wfa.flowLogic.skipIteration({ $id: Now.ID["skip_resolved"] });
              }
            );

            // Link problem to incident
            wfa.action(
              action.core.updateRecord,
              { $id: Now.ID["link_problem"] },
              {
                table_name: "incident",
                record: wfa.dataPill(params.trigger.current, "reference"),
                values: TemplateValue({
                  problem_id: wfa.dataPill(problem.sys_id, "reference")
                })
              }
            );

            // Exit loop after first match
            wfa.flowLogic.exitLoop({ $id: Now.ID["exit_loop"] });
          }
        );
      }
    );

    // If no problems, escalate
    wfa.flowLogic.else({ $id: Now.ID["no_problems_found"] }, () => {
      wfa.action(
        action.core.updateRecord,
        { $id: Now.ID["escalate"] },
        {
          table_name: "incident",
          record: wfa.dataPill(params.trigger.current, "reference"),
          values: TemplateValue({ state: 3 })
        }
      );
    });

    // Log completion
    wfa.action(
      action.core.log,
      { $id: Now.ID["log_completion"] },
      {
        log_level: "info",
        log_message: "Flow completed successfully"
      }
    );
  }
);
```

---


Advanced Patterns

Nested If Statements

if statements can be nested within other if blocks for complex conditional logic:

```typescript fluent
wfa.flowLogic.if(
  {
    $id: Now.ID["check_active"],
    condition: `${wfa.dataPill(params.trigger.current.active, "boolean")}=true`,
    annotation: "Check if record is active"
  },
  () => {
    // Nested if within outer if
    wfa.flowLogic.if(
      {
        $id: Now.ID["check_priority"],
        condition: `${wfa.dataPill(params.trigger.current.priority, "string")}=1`,
        annotation: "Check if priority is critical"
      },
      () => {
        wfa.action(
          action.core.log,
          { $id: Now.ID["log"] },
          {
            log_level: "info",
            log_message: "Active and critical priority incident detected"
          }
        );
      }
    );
  }
);
```

Nested ForEach Loops

forEach loops can be nested to process multi-dimensional data:

```typescript fluent
// Outer loop: process each incident
wfa.flowLogic.forEach(
  wfa.dataPill(incidents.Records, "array.object"),
  { $id: Now.ID["process_incidents"], annotation: "Process each incident" },
  incident => {
    // Inner loop: process related problems for each incident
    wfa.flowLogic.forEach(
      wfa.dataPill(incident.related_problems, "array.object"),
      {
        $id: Now.ID["process_problems"],
        annotation: "Process related problems"
      },
      problem => {
        wfa.action(
          action.core.log,
          { $id: Now.ID["log_problem"] },
          {
            log_level: "info",
            log_message: `Processing problem ${wfa.dataPill(problem.number, "string")} for incident ${wfa.dataPill(incident.number, "string")}`
          }
        );
      }
    );
  }
);
```
