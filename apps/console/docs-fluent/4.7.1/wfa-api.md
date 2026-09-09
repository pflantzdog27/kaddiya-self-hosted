# wfa-api

Tags: wfa, workflow, workflow automation, flow, automation, action, trigger, dataPill, subflow, doInParallel, tryCatch, appendToFlowVariables

wfa

The wfa (Workflow Automation) namespace provides the core building blocks for defining Flows and Subflows. Use wfa.trigger() to start a flow, wfa.action() to execute built-in actions, and wfa.flowLogic for control flow (if/elseIf/else, forEach, doInParallel, tryCatch, appendToFlowVariables).

```typescript fluent
import { wfa } from '@servicenow/sdk/automation'
```


Members

| Member | Description |
|--------|-------------|
| flowLogic | Control flow operators for branching, looping, and flow control (if, elseIf, else, forEach, setFlowVariables, assignSubflowOutputs, endFlow, exitLoop, skipIteration, doInParallel, tryCatch, appendToFlowVariables). |
| action | Execute a built-in action step and capture its typed outputs. Pass an action definition from the action built-ins. |
| approvalDueDate | Define a due-date policy for an action.core.askForApproval step. |
| approvalRules | Build a structured approval rules configuration for action.core.askForApproval. |
| dataPill | Create a typed data pill reference to a prior step's output or trigger data. |
| inlineScript | Define a server-side script inline as an action or subflow input. |
| subflow | Invoke a defined Subflow from inside a Flow or another Subflow. Pass an exported subflow constant and its inputs. |
| actionStep | Embed an OOB step inside a custom Action body. Pass a step definition from the actionStep built-ins. |
| assignActionOutputs | Assign output values inside a custom action body. Maps declared outputs to actual values or datapill references. |
| errorEvaluation | Define error evaluation conditions for a custom action. Conditions are evaluated in order; the first match sets the action's status. |
| stage | Activate a declared stage in the flow body. Pass a stage from params.stages.<key>. See FlowStage for stage declaration. |
| trigger | Register the trigger that starts the flow. Pass a trigger definition from the trigger built-ins. |


Examples

Basic Flow

```typescript fluent
import { Flow, wfa, trigger, action } from '@servicenow/sdk/automation'

export default Flow(
    { $id: Now.ID['my-flow'], name: 'My Flow' },
    wfa.trigger(
        trigger.record.created,
        { $id: Now.ID['my-flow-trigger'] },
        { table: 'incident' }
    ),
    (params) => [
        wfa.action(
            action.core.log,
            { $id: Now.ID['my-flow-log'] },
            { log_level: 'info', log_message: 'New incident created' }
        ),
    ]
);
```
