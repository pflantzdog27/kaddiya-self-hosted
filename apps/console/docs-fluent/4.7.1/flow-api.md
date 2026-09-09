# flow-api

Tags: Flow, flow, Flow(), wfa, workflow-automation, flow-designer, automation, sys_hub_flow, process-automation

Flow

Creates a Flow record (sys_hub_flow) that defines a series of actions to execute when triggered.


Signature

```typescript fluent
Flow(
  config: FlowConfig,
  trigger: Trigger,
  callback: (params: FlowParams) => void
)
```

Parameters

| Position | Name       | Type                              | Description                                        |
| -------- | ---------- | --------------------------------- | -------------------------------------------------- |
| 1        | config   | FlowConfig                      | Flow metadata and execution context                |
| 2        | trigger  | Trigger                         | Flow activation point -- created via wfa.trigger() |
| 3        | callback | (params: FlowParams) => void    | Flow body containing actions and flow logic        |

Import

```typescript fluent
import { Flow, wfa, trigger, action } from "@servicenow/sdk/automation";
```

TemplateValue, Time, and Duration are available globally from @servicenow/sdk/global -- do not import them.

---


Flow Configuration Properties

| Property        | Type                              | Required | Default    | Description                                                       |
| --------------- | --------------------------------- | -------- | ---------- | ----------------------------------------------------------------- |
| $id           | string / Now.ID[...]          | Yes      | -          | Unique identifier for the flow                                    |
| name          | string                          | Yes      | -          | Display name shown in the ServiceNow UI                           |
| description   | string                          | No       | -          | Flow purpose and behavior                                         |
| runAs         | 'system' \| 'user'            | No       | 'user'   | Execution security context                                        |
| runWithRoles  | string[]                        | No       | []       | Required role sys_ids granting temporary elevated permissions     |
| flowPriority  | 'LOW' \| 'MEDIUM' \| 'HIGH' | No       | 'MEDIUM' | Execution queue priority                                          |
| protection    | 'read' \| ''                  | No       | ''       | If 'read', the flow is read-only in the UI                      |
| flowVariables | Record<string, Column>          | No       | {}       | Flow-scoped typed variables, used with wfa.flowLogic.setFlowVariables |
| stages        | Record<string, FlowStageConfig> | No       | {}       | Named stage declarations for tracking flow execution progress. Each key must match the value field inside the corresponding FlowStage() call |

---


Trigger Parameter

The second argument is a Trigger produced by wfa.trigger(). A flow must declare exactly one trigger.

```typescript fluent
wfa.trigger(
  triggerType,             // trigger.record.created, trigger.scheduled.daily, etc.
  config:    { $id: string, annotation?: string },
  parameters: { /* trigger-type-specific */ }
)
```

For all trigger types, parameter tables, and outputs, see the Trigger API.

---


Body Callback

The third argument is a function that receives a params object and contains the flow body.

Signature

```typescript fluent
(params: FlowParams) => void
```

FlowParams Structure

The shape of params depends on the trigger type. Common members:

```typescript fluent
{
  trigger: {
    current: Record,              // Current record (record triggers)
    previous?: Record,            // Previous state (record-update trigger)
    run_start_date_time: DateTime,
    // ... trigger-specific outputs (subject/body for inboundEmail, etc.)
  },
  stages: Record<string, FlowStageRef>  // References to declared stages, used with wfa.stage()
}
```

Access dynamic data via wfa.dataPill(source, type) -- see the Flow Guide → Data Pills section.

Body Contents

The body may contain:

• wfa.action(...) -- built-in (action.core.*) or custom action invocations -- see the Action API (built-ins) and Custom Action API
• wfa.subflow(...) -- subflow invocations -- see the Subflow API
• wfa.flowLogic.* -- conditional branching (if/elseIf/else), loops (forEach), loop control (exitLoop/skipIteration), flow control (endFlow) -- see the Flow Logic API
• wfa.flowLogic.setFlowVariables(...) -- assigning flow-scoped variables

---

For when to pick which configuration values, end-to-end examples, anti-patterns, and best practices, see the Workflow Automation Flow Guide.
