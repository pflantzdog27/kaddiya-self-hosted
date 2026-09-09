# wfa-flow-logic-api

Tags: flow-logic, wfa, workflow-automation, flow-designer, conditional, loop, if-else, forEach, exit-loop, skip-iteration, end-flow, condition-syntax, doInParallel, parallel-execution, tryCatch, try-catch, error-handling, appendToFlowVariables, append-flow-variables, array-manipulation, setFlowVariables, set-flow-variables, flow-variables

Flow Logic

The wfa.flowLogic namespace provides control flow operators for branching, looping, and flow control within Flow and Subflow bodies.


Usage Pattern

All flow logic constructs follow this invocation shape:

```typescript fluent
wfa.flowLogic.<construct>(
  { $id: Now.ID['logic_id'], ...params },
  callback?
)
```

---


wfa.flowLogic.if

Evaluates a condition and executes the callback if true.

Signature

```typescript fluent
wfa.flowLogic.if(
  params: {
    $id: string,
    condition: string,
    label?: string,
    annotation?: string
  },
  body: () => void
)
```

Parameters

| Parameter    | Type     | Required | Default | Description                          |
| ------------ | -------- | -------- | ------- | ------------------------------------ |
| $id        | string | Yes      | -       | Unique identifier (Now.ID['value']) |
| condition  | string | Yes      | -       | Encoded query expression to evaluate |
| label      | string | No       | -       | Display label for this branch        |
| annotation | string | No       | -       | Description/comment                  |

---


wfa.flowLogic.elseIf

Evaluates a condition if previous conditions were false. Must follow if or elseIf.

Signature

```typescript fluent
wfa.flowLogic.elseIf(
  params: {
    $id: string,
    condition: string,
    label?: string,
    annotation?: string
  },
  body: () => void
)
```

Parameters

| Parameter    | Type     | Required | Default | Description                          |
| ------------ | -------- | -------- | ------- | ------------------------------------ |
| $id        | string | Yes      | -       | Unique identifier (Now.ID['value']) |
| condition  | string | Yes      | -       | Encoded query expression to evaluate |
| label      | string | No       | -       | Display label for this branch        |
| annotation | string | No       | -       | Description/comment                  |

---


wfa.flowLogic.else

Executes callback if all previous conditions were false. Must follow if or elseIf.

Signature

```typescript fluent
wfa.flowLogic.else(
  params: {
    $id: string,
    annotation?: string
  },
  body: () => void
)
```

Parameters

| Parameter    | Type     | Required | Default | Description                          |
| ------------ | -------- | -------- | ------- | ------------------------------------ |
| $id        | string | Yes      | -       | Unique identifier (Now.ID['value']) |
| annotation | string | No       | -       | Description/comment                  |

---


wfa.flowLogic.forEach

Iterates over an array, executing the callback for each item.

Signature

```typescript fluent
wfa.flowLogic.forEach<TArray>(
  items: TArray,
  config: {
    $id: string,
    annotation?: string
  },
  body?: (item: ExtractArrayElement<TArray>) => void
)
```

Parameters

| Parameter    | Type       | Required | Default | Description                                       |
| ------------ | ---------- | -------- | ------- | ------------------------------------------------- |
| items      | TArray   | Yes      | -       | Array to iterate (use data pill with array type)  |
| $id        | string   | Yes      | -       | Unique identifier (Now.ID['value'])             |
| annotation | string   | No       | -       | Description/comment                               |
| body       | function | No       | -       | Callback receiving each item                      |

Supported Data Pill Types

• 'array.object' — For lookUpRecords results and object arrays
• 'array.string' — For string arrays (no item parameter)

---


wfa.flowLogic.exitLoop

Immediately exits the enclosing forEach loop.

Signature

```typescript fluent
wfa.flowLogic.exitLoop(
  params: {
    $id: string,
    annotation?: string
  }
)
```

Parameters

| Parameter    | Type     | Required | Default | Description                          |
| ------------ | -------- | -------- | ------- | ------------------------------------ |
| $id        | string | Yes      | -       | Unique identifier (Now.ID['value']) |
| annotation | string | No       | -       | Description/comment                  |

---


wfa.flowLogic.skipIteration

Skips the current iteration and continues with the next item.

Signature

```typescript fluent
wfa.flowLogic.skipIteration(
  params: {
    $id: string,
    annotation?: string
  }
)
```

Parameters

| Parameter    | Type     | Required | Default | Description                          |
| ------------ | -------- | -------- | ------- | ------------------------------------ |
| $id        | string | Yes      | -       | Unique identifier (Now.ID['value']) |
| annotation | string | No       | -       | Description/comment                  |

---


wfa.flowLogic.endFlow

Immediately terminates flow execution.

Signature

```typescript fluent
wfa.flowLogic.endFlow(
  params: {
    $id: string,
    annotation?: string
  }
)
```

Parameters

| Parameter    | Type     | Required | Default | Description                          |
| ------------ | -------- | -------- | ------- | ------------------------------------ |
| $id        | string | Yes      | -       | Unique identifier (Now.ID['value']) |
| annotation | string | No       | -       | Description/comment                  |

---


wfa.flowLogic.doInParallel

Executes multiple code blocks in parallel within a flow.

Signature

```typescript fluent
wfa.flowLogic.doInParallel(
  params: {
    $id: string,
    annotation?: string
  },
  ...blocks: (() => void)[]
)
```

Parameters

| Parameter    | Type         | Required | Default | Description                                    |
| ------------ | ------------ | -------- | ------- | ---------------------------------------------- |
| $id        | string     | Yes      | -       | Unique identifier (Now.ID['value'])           |
| annotation | string     | No       | -       | Description/comment                            |
| blocks     | () => void | Yes      | -       | One or more arrow functions to execute in parallel |

Important Constraints

• No nesting — doInParallel cannot be used inside another doInParallel block
• Minimum 1 block — At least one parallel block is required
• Each block is an arrow function: () => { ... }
• Datapill scope limitation — Action output datapills captured inside a doInParallel block are not accessible outside it. To use an action output after the block, assign it to a flow variable inside the block using wfa.flowLogic.setFlowVariables, then reference the flow variable outside.

---


wfa.flowLogic.tryCatch

Creates a try-catch block for error handling in flows.

Signature

```typescript fluent
wfa.flowLogic.tryCatch(
  params: {
    $id: string,
    annotation?: string
  },
  handlers: {
    try: () => void,
    catch: () => void
  }
)
```

Parameters

| Parameter    | Type         | Required | Default | Description                                      |
| ------------ | ------------ | -------- | ------- | ------------------------------------------------ |
| $id        | string     | Yes      | -       | Unique identifier (Now.ID['value'])             |
| annotation | string     | No       | -       | Description/comment                              |
| handlers   | object     | Yes      | -       | Object with try and catch arrow functions     |

Handlers Object

| Property | Type         | Required | Description                                |
| -------- | ------------ | -------- | ------------------------------------------ |
| try    | () => void | Yes      | Arrow function containing code to attempt  |
| catch  | () => void | Yes      | Arrow function to execute if try block fails |

Important Notes

• Both try and catch must be arrow functions
• tryCatch blocks can be nested
• The catch block executes only if an error occurs in the try block
• Datapill scope limitation — Action output datapills captured inside a tryCatch block are not accessible outside it. To use an action output after the block, assign it to a flow variable inside the block using wfa.flowLogic.setFlowVariables, then reference the flow variable outside.

---


wfa.flowLogic.appendToFlowVariables

Appends element(s) to array-typed flow variables.

Signature

```typescript fluent
wfa.flowLogic.appendToFlowVariables<V>(
  params: {
    $id: string,
    annotation?: string
  },
  variables: V,
  values: Partial<{
    [K in keyof V]: V[K] extends Array<infer E> 
      ? E | E[] | unknown[] | string 
      : never
  }>
)
```

Parameters

| Parameter    | Type     | Required | Default | Description                                           |
| ------------ | -------- | -------- | ------- | ----------------------------------------------------- |
| $id        | string | Yes      | -       | Unique identifier (Now.ID['value'])                  |
| annotation | string | No       | -       | Description/comment                                   |
| variables  | V      | Yes      | -       | Flow variables schema (pass params.flowVariables)    |
| values     | object | Yes      | -       | Key/value pairs where keys are array variable names    |

Value Types

For each array variable, you can append:
• Single element — { arrayVar: singleElement }
• Array of elements — { arrayVar: [elem1, elem2, elem3] }
• Data pill — { arrayVar: wfa.dataPill(...) }
• Template string — { arrayVar: 'template expression' }

Important Constraints

• Array.Object only — Only supports FlowArray({ elementType: FlowObject(...) }) variables
• Array elements must be objects or datapill expressions — When appending an array literal, each element must be an object or a datapill expression
• Compile-time safety — TypeScript enforces that target variables are arrays

---


wfa.flowLogic.setFlowVariables

Assigns values to flow-scoped variables declared in the Flow or Subflow config flowVariables property. This is a type-only helper — it is erased at runtime and only influences the TypeScript type-checker.

Signature

```typescript fluent
wfa.flowLogic.setFlowVariables(
  definition: { $id: string, annotation?: string },
  variables: FlowSchemaType<S>,
  values: { [K in keyof FlowSchemaType<S>]?: FlowSchemaType<S>[K] | string }
)
```

Parameters

| Parameter    | Type                   | Required | Description                                                               |
| ------------ | ---------------------- | -------- | ------------------------------------------------------------------------- |
| $id        | string               | Yes      | Unique identifier (Now.ID['value'])                                     |
| annotation | string               | No       | Description/comment                                                       |
| variables  | FlowSchemaType<S>    | Yes      | Flow variables schema — always pass params.flowVariables            |
| values     | Partial record       | Yes      | Key/value pairs of variables to set. Omitted keys are unchanged.          |

Value Types

For each variable entry in values, you can supply:
• Typed literal — { myVar: 'hello' }, { count: 42 }
• Data pill — { myVar: wfa.dataPill(params.trigger.current.short_description, 'string') }
• Template string — { myVar: 'template expression' }

null and undefined are not valid — omit the key instead of setting it to null.

Important Notes

• Always pass params.flowVariables as the variables argument — never construct a custom object.
• Only the keys listed in values are updated; other flow variables retain their current values.
• Flow variables are scoped to the current flow or subflow execution — they are not visible to called subflows.

---


Condition Syntax Reference

Flow logic conditions use ServiceNow encoded query format.

Comparison Operators

| Operator | Description      | Example       |
| -------- | ---------------- | ------------- |
| =      | Equals           | priority=1  |
| !=     | Not equals       | state!=6    |
| <      | Less than        | priority<3  |
| <=     | Less or equal    | priority<=2 |
| >      | Greater than     | priority>3  |
| >=     | Greater or equal | priority>=2 |

Empty/Not Empty Operators

| Operator     | Description     | Example                      |
| ------------ | --------------- | ---------------------------- |
| ISEMPTY    | Field is empty  | assigned_toISEMPTY         |
| ISNOTEMPTY | Field has value | assignment_groupISNOTEMPTY |

List Operators

| Operator | Description | Example          |
| -------- | ----------- | ---------------- |
| IN     | In list     | stateIN1,2,3   |
| NOT IN | Not in list | stateNOT IN6,7 |

String Operators

| Operator     | Description | Example                           |
| ------------ | ----------- | --------------------------------- |
| STARTSWITH | Starts with | numberSTARTSWITHINC             |
| ENDSWITH   | Ends with   | emailENDSWITH@company.com       |
| CONTAINS   | Contains    | short_descriptionCONTAINSfailed |

Logical Operators

| Operator      | Description          | Example                   |
| ------------- | -------------------- | ------------------------- |
| ^ or ^AND | Logical AND          | priority=1^active=true  |
| ^OR         | Logical OR           | priority=1^ORpriority=2 |
| ^NQ         | New query (OR group) | priority=1^NQstate=2    |

---

For usage patterns, examples, best practices, and end-to-end flow logic examples, see the Flow Logic Guide.
