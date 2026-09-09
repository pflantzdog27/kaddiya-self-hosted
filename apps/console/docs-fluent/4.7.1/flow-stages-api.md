# flow-stages-api

Tags: FlowStage, flow stage, stage, wfa.stage, sys_hub_flow_stage, flow tracker, stage tracker, flow phases

FlowStage

Declares a named stage for tracking Flow execution progress. Stages are defined in the Flow config stages property using FlowStage() and activated in the flow body using wfa.stage().


Signature

```typescript fluent
FlowStage(config)
```


Parameters

config

FlowStageConfig

Stage configuration — label, value, optional duration, visibility, and custom state labels.

Properties:

| Property     | Type               | Required | Default       | Description                                            |
|-------------|-------------------|----------|---------------|--------------------------------------------------------|
| label     | string           | Yes      | —             | Display name shown in the stage tracker                |
| value     | string           | Yes      | —             | Unique identifier (must match the property key name)   |
| duration  | Duration({...})  | No       | Zero duration | Expected stage duration                                |
| alwaysShow| boolean          | No       | false       | Whether stage appears in tracker even when not reached |
| states    | { [key]: string }| No       | {}          | Custom labels for stage states                         |


Available State Keys

pending, inProgress, complete, error, skipped — all optional, each maps to a display label string.



Activating Stages

Use wfa.stage() inside the flow body to mark the beginning of a stage. All subsequent actions belong to that stage until the next wfa.stage() call.

```typescript fluent
wfa.stage(params.stages.<key>)
```

| Parameter | Description |
|-----------|-------------|
| params.stages.<key> | Reference to a stage declared in the flow config stages object. The key must match a declared stage. |



Examples

Basic Flow with Stages

```typescript fluent
import { Flow, FlowStage, wfa, trigger, action } from '@servicenow/sdk/automation'

export const incidentHandler = Flow(
    {
        $id: Now.ID['incident_flow'],
        name: 'Incident Handler',
        stages: {
            triage: FlowStage({
                label: 'Triage',
                value: 'triage',
            }),
            resolution: FlowStage({
                label: 'Resolution',
                value: 'resolution',
            }),
        },
    },
    wfa.trigger(trigger.record.created, { $id: Now.ID['trigger_1'] }, {
        table: 'incident',
        condition: '',
        run_on_extended: 'false',
        run_flow_in: 'background',
        run_when_user_list: [],
        run_when_setting: 'both',
        run_when_user_setting: 'any',
    }),
    (params) => {
        wfa.stage(params.stages.triage)

        wfa.action(action.core.log, { $id: Now.ID['log_triage'] }, {
            log_level: 'info',
            log_message: 'Triaging incident',
        })

        wfa.stage(params.stages.resolution)

        wfa.action(action.core.log, { $id: Now.ID['log_resolve'] }, {
            log_level: 'info',
            log_message: 'Resolving incident',
        })
    }
)
```

Full Config — Duration, alwaysShow, and Custom States

```typescript fluent
import { Flow, FlowStage, wfa, trigger, action } from '@servicenow/sdk/automation'

export const approvalFlow = Flow(
    {
        $id: Now.ID['approval_flow'],
        name: 'Approval Flow',
        stages: {
            approval: FlowStage({
                label: 'Approval',
                value: 'approval',
                duration: Duration({ days: 1 }),
                alwaysShow: true,
                states: {
                    pending: 'Not Yet Requested',
                    inProgress: 'Waiting for Approval',
                    complete: 'Approved',
                    error: 'Rejected',
                    skipped: 'Approval Skipped',
                },
            }),
        },
    },
    wfa.trigger(trigger.record.created, { $id: Now.ID['trigger_1'] }, {
        table: 'incident',
        condition: '',
        run_on_extended: 'false',
        run_flow_in: 'background',
        run_when_user_list: [],
        run_when_setting: 'both',
        run_when_user_setting: 'any',
    }),
    (params) => {
        wfa.stage(params.stages.approval)

        wfa.action(action.core.log, { $id: Now.ID['log_approval'] }, {
            log_level: 'info',
            log_message: 'Approval stage active',
        })
    }
)
```

For comprehensive examples, rules, constraints, and best practices, see the Flow Stages Guide.
