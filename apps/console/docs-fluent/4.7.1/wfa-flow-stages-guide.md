# wfa-flow-stages-guide

Tags: FlowStage, flow stage, stage, wfa.stage, sys_hub_flow_stage, flow tracker, stage tracker, flow phases, guide

Flow Stages Guide

Comprehensive guide for declaring and activating flow stages in ServiceNow workflows. Stages track progress of a Flow execution through named phases (e.g. Triage → Approval → Investigation). Two steps are needed: declare stages in the flow config header using FlowStage(), then activate them in the flow body using wfa.stage().


When to Use

• When the flow has distinct phases that should be visually tracked (e.g. Intake → Provisioning → Verification)
• When stakeholders need visibility into which phase a flow execution is currently in
• When you want to set expected durations for each phase
• When child subflows activate stages on behalf of a parent flow

---


How Stages Work at Runtime

State Lifecycle

Each stage transitions through these states during flow execution:

pending → inProgress → complete (happy path)

• pending — Stage is declared but not yet activated.
• inProgress — wfa.stage() was called; the stage is now active.
• complete — A subsequent wfa.stage() call activated the next stage, or the flow finished successfully.
• error — The flow errored while this stage was inProgress.
• skipped — The flow completed but this stage was never activated (only visible if alwaysShow: true).

One Active Stage at a Time

Only one stage can be inProgress at any point during execution. Calling wfa.stage() for a new stage automatically marks the previous inProgress stage as complete.

```typescript fluent
wfa.stage(params.stages.triage)       // triage → inProgress
wfa.action(...)

wfa.stage(params.stages.approval)     // triage → complete, approval → inProgress
wfa.action(...)

wfa.stage(params.stages.closure)      // approval → complete, closure → inProgress
wfa.action(...)
// flow ends                          // closure → complete
```

Declaration Order = Display Order

Stages appear in the stage tracker in the order they are declared in the stages: {} object. The first declared stage is displayed first, regardless of which stage is activated first in the body.

```typescript fluent
stages: {
    intake: FlowStage({ ... }),        // Displayed first
    provisioning: FlowStage({ ... }),  // Displayed second
    verification: FlowStage({ ... }), // Displayed third
}
```

`alwaysShow` Behavior

• alwaysShow: false (default) — If the flow completes without activating this stage, the stage does not appear in the tracker.
• alwaysShow: true — The stage always appears in the tracker. If the flow completes without activating it, the stage shows in the skipped state (or the custom label for skipped if provided).

Where the Stage Tracker Appears

The stage tracker is displayed in:
• Agent Workspace — execution details panel
• Service Portal — request item (RITM) view
• Flow Designer — execution details when inspecting a flow run

---


Stages on Subflows

Subflows support the same stages pattern as Flows. Declare stages in the Subflow config header and activate them with wfa.stage() in the body.

```typescript fluent
import { FlowStage, Subflow, wfa, action } from '@servicenow/sdk/automation'
import { StringColumn } from '@servicenow/sdk/core'

export const approvalSubflow = Subflow(
    {
        $id: Now.ID['approval_subflow'],
        name: 'Approval Subflow',
        inputs: {
            incidentSysId: StringColumn({ label: 'Incident Sys ID', mandatory: true }),
        },
        stages: {
            review: FlowStage({
                label: 'Review',
                value: 'review',
                alwaysShow: true,
            }),
            outcome: FlowStage({
                label: 'Outcome',
                value: 'outcome',
                duration: Duration({ hours: 2 }),
            }),
        },
    },
    (params) => {
        wfa.stage(params.stages.review)

        wfa.action(action.core.askForApproval, { $id: Now.ID['ask_approval'] }, {
            table: 'incident',
            record: wfa.dataPill(params.inputs.incidentSysId, 'reference'),
            approval_field: 'approval',
            journal_field: 'work_notes',
            approval_conditions: wfa.approvalRules({
                conditionType: 'OR',
                ruleSets: [{
                    action: 'Approves',
                    conditionType: 'AND',
                    rules: [[{ ruleType: 'Any', users: [], groups: [], manual: true }]],
                }],
            }),
        })

        wfa.stage(params.stages.outcome)

        wfa.action(action.core.log, { $id: Now.ID['log_outcome'] }, {
            log_level: 'info',
            log_message: 'Approval outcome recorded',
        })
    }
)
```

Surfacing Subflow Stages in the Parent Flow (`showSubflowStage`)

When a parent Flow invokes a Subflow that has its own stages, set showSubflowStage: true on the wfa.subflow() call to surface the subflow's internal stages in the parent flow's execution details panel.

The platform creates a dedicated type:'subflow' stage record whose value is the subflow instance's UUID, linking the two stage trees.

```typescript fluent
import { Flow, FlowStage, wfa, trigger, action } from '@servicenow/sdk/automation'
import { approvalSubflow } from './approval-subflow.now'

export const parentFlow = Flow(
    {
        $id: Now.ID['parent_flow'],
        name: 'Parent Flow with Subflow Stages',
        stages: {
            triage: FlowStage({ label: 'Triage', value: 'triage' }),
            approval: FlowStage({ label: 'Approval', value: 'approval', alwaysShow: true }),
            closure: FlowStage({ label: 'Closure', value: 'closure' }),
        },
    },
    wfa.trigger(trigger.record.created, { $id: Now.ID['trigger_1'] }, {
        table: 'incident',
        condition: 'priority=1',
        run_flow_in: 'background',
        run_on_extended: 'false',
        run_when_user_list: [],
        run_when_setting: 'both',
        run_when_user_setting: 'any',
    }),
    (params) => {
        wfa.stage(params.stages.triage)

        wfa.action(action.core.log, { $id: Now.ID['log_triage'] }, {
            log_level: 'info',
            log_message: 'Triage started',
        })

        // Activate approval stage, then delegate to subflow
        // showSubflowStage: true surfaces the subflow's review/outcome stages
        // inside this parent flow's stage tracker
        wfa.stage(params.stages.approval)

        const result = wfa.subflow(
            approvalSubflow,
            {
                $id: Now.ID['call_approval'],
                annotation: 'Run approval subflow',
                showSubflowStage: true,
            },
            {
                incidentSysId: wfa.dataPill(params.trigger.current.sys_id, 'reference'),
            }
        )

        wfa.stage(params.stages.closure)

        wfa.action(action.core.log, { $id: Now.ID['log_closure'] }, {
            log_level: 'info',
            log_message: 'Flow complete',
        })
    }
)
```

---


Examples

Example 1: Basic — Two Sequential Stages

A simple flow with two stages that run one after the other.

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
        // Activate the triage stage — all actions below belong to triage
        wfa.stage(params.stages.triage)

        wfa.action(action.core.log, { $id: Now.ID['log_triage'] }, {
            log_level: 'info',
            log_message: 'Triaging incident',
        })

        // Activate the resolution stage — actions below belong to resolution
        wfa.stage(params.stages.resolution)

        wfa.action(action.core.log, { $id: Now.ID['log_resolve'] }, {
            log_level: 'info',
            log_message: 'Resolving incident',
        })
    }
)
```

Example 2: Full Config — Duration, alwaysShow, and Custom States

A stage with all optional properties filled in.

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

Example 3: Minimal Config — Label and Value Only

When you don't need duration, custom states, or alwaysShow, a stage can be very concise.

```typescript fluent
import { Flow, FlowStage, wfa, trigger, action } from '@servicenow/sdk/automation'

export const cleanupFlow = Flow(
    {
        $id: Now.ID['cleanup_flow'],
        name: 'Cleanup Flow',
        stages: {
            cleanup: FlowStage({
                label: 'Cleanup',
                value: 'cleanup',
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
        wfa.stage(params.stages.cleanup)

        wfa.action(action.core.log, { $id: Now.ID['log_cleanup'] }, {
            log_level: 'info',
            log_message: 'Cleanup stage active',
        })
    }
)
```

Example 4: Stages Inside Conditional Logic

The same stage can be activated inside different branches. This is useful when the same logical phase applies regardless of which condition is met.

```typescript fluent
import { Flow, FlowStage, wfa, trigger, action } from '@servicenow/sdk/automation'

export const priorityRouter = Flow(
    {
        $id: Now.ID['priority_flow'],
        name: 'Priority Router',
        stages: {
            triage: FlowStage({ label: 'Triage', value: 'triage' }),
            investigation: FlowStage({
                label: 'Investigation',
                value: 'investigation',
                duration: Duration({ hours: 2 }),
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

        wfa.action(action.core.log, { $id: Now.ID['log_start'] }, {
            log_level: 'info',
            log_message: 'Triage started',
        })

        // Same stage activated in both branches
        wfa.flowLogic.if(
            { $id: Now.ID['if_p1'], condition: 'priority=1', annotation: '' },
            () => {
                wfa.stage(params.stages.investigation)

                wfa.action(action.core.log, { $id: Now.ID['log_p1'] }, {
                    log_level: 'warn',
                    log_message: 'P1 investigation',
                })
            }
        )

        wfa.flowLogic.elseIf(
            { $id: Now.ID['elseif_p2'], condition: 'priority=2', annotation: '' },
            () => {
                wfa.stage(params.stages.investigation)

                wfa.action(action.core.log, { $id: Now.ID['log_p2'] }, {
                    log_level: 'info',
                    log_message: 'P2 investigation',
                })
            }
        )
    }
)
```

Example 5: Declared-but-Never-Activated Stage

A stage can be declared in the header without a corresponding wfa.stage() call in the body. This is useful when the stage is only activated by a child subflow, or when you want the stage tracker to display a phase that the flow itself doesn't control.

```typescript fluent
import { Flow, FlowStage, wfa, trigger, action } from '@servicenow/sdk/automation'

export const myFlow = Flow(
    {
        $id: Now.ID['my_flow'],
        name: 'My Flow',
        stages: {
            main: FlowStage({ label: 'Main', value: 'main' }),
            external: FlowStage({ label: 'External Processing', value: 'external' }),
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
        wfa.stage(params.stages.main)

        wfa.action(action.core.log, { $id: Now.ID['log_1'] }, {
            log_level: 'info',
            log_message: 'Doing main work',
        })

        // "external" is declared but never activated via wfa.stage() here.
        // It might be activated by a subflow or exist for tracker display only.
    }
)
```

Example 6: Multiple Stages with Mixed Activation

A realistic flow combining top-level stages with stages inside conditional branches.

```typescript fluent
import { Flow, FlowStage, wfa, trigger, action } from '@servicenow/sdk/automation'

export const employeeOnboarding = Flow(
    {
        $id: Now.ID['onboarding_flow'],
        name: 'Employee Onboarding',
        stages: {
            intake: FlowStage({
                label: 'Intake',
                value: 'intake',
                duration: Duration({ hours: 4 }),
                states: {
                    pending: 'Awaiting Intake',
                    inProgress: 'Processing',
                    complete: 'Intake Done',
                    error: 'Intake Failed',
                },
            }),
            provisioning: FlowStage({
                label: 'Provisioning',
                value: 'provisioning',
                duration: Duration({ days: 1 }),
                alwaysShow: true,
            }),
            verification: FlowStage({
                label: 'Verification',
                value: 'verification',
            }),
        },
    },
    wfa.trigger(trigger.record.created, { $id: Now.ID['trigger_1'] }, {
        table: 'hr_case',
        condition: '',
        run_on_extended: 'false',
        run_flow_in: 'background',
        run_when_user_list: [],
        run_when_setting: 'both',
        run_when_user_setting: 'any',
    }),
    (params) => {
        // Stage 1: Intake (top-level)
        wfa.stage(params.stages.intake)

        wfa.action(action.core.log, { $id: Now.ID['log_intake'] }, {
            log_level: 'info',
            log_message: 'Starting intake',
        })

        // Stage 2: Provisioning (top-level)
        wfa.stage(params.stages.provisioning)

        wfa.action(action.core.log, { $id: Now.ID['log_provision'] }, {
            log_level: 'info',
            log_message: 'Provisioning resources',
        })

        // Stage 3: Verification (inside conditional)
        wfa.flowLogic.if(
            { $id: Now.ID['if_needs_review'], condition: 'needs_review=true', annotation: '' },
            () => {
                wfa.stage(params.stages.verification)

                wfa.action(action.core.log, { $id: Now.ID['log_verify'] }, {
                    log_level: 'info',
                    log_message: 'Running verification',
                })
            }
        )

        wfa.action(action.core.log, { $id: Now.ID['log_done'] }, {
            log_level: 'info',
            log_message: 'Onboarding complete',
        })
    }
)
```

Example 7: Stages Inside tryCatch

Stages can be activated inside tryCatch try and catch bodies. This is useful when success and failure paths should be tracked as different stages.

```typescript fluent
import { Flow, FlowStage, wfa, trigger, action } from '@servicenow/sdk/automation'

export const tryCatchStages = Flow(
    {
        $id: Now.ID['try_catch_flow'],
        name: 'TryCatch Stages',
        stages: {
            resolution: FlowStage({ label: 'Resolution', value: 'resolution' }),
            errorHandling: FlowStage({ label: 'Error Handling', value: 'errorHandling' }),
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
        wfa.action(action.core.log, { $id: Now.ID['log_start'] }, {
            log_level: 'info',
            log_message: 'Starting processing',
        })

        wfa.flowLogic.tryCatch(
            { $id: Now.ID['tc_1'] },
            {
                try: () => {
                    wfa.stage(params.stages.resolution)

                    wfa.action(action.core.updateRecord, { $id: Now.ID['update_1'] }, {
                        table_name: 'incident',
                        record: wfa.dataPill(params.trigger.current.sys_id, 'reference'),
                        values: TemplateValue({ work_notes: 'Resolved' }),
                    })
                },
                catch: () => {
                    wfa.stage(params.stages.errorHandling)

                    wfa.action(action.core.log, { $id: Now.ID['log_err'] }, {
                        log_level: 'error',
                        log_message: 'Update failed',
                    })
                },
            }
        )
    }
)
```

---


Rules and Constraints

Property key must match `value`

The stage property key in the stages: {} object must equal the value field inside FlowStage().

```typescript fluent
// ✅ Correct — key matches value
stages: {
    triage: FlowStage({ label: 'Triage', value: 'triage' }),
}

// ❌ Wrong — key "myKey" differs from value "triage"
stages: {
    myKey: FlowStage({ label: 'Triage', value: 'triage' }),
}
```

`wfa.stage()` must reference a declared stage

Every wfa.stage(params.stages.<key>) call must reference a key that exists in the stages: {} config. Referencing an undeclared key produces a build error.

```typescript fluent
// ❌ Build error — "cleanup" is not declared in stages config
wfa.stage(params.stages.cleanup)
```

Stages cannot be activated inside `forEach`

wfa.stage() inside a forEach body is not supported by the platform and produces a build error.

```typescript fluent
// ❌ Build error
wfa.flowLogic.forEach({ $id: Now.ID['loop'] }, (item) => {
    wfa.stage(params.stages.processing)  // Not allowed
    wfa.action(...)
})
```

Stages cannot be activated inside `DoInParallel`

wfa.stage() inside a DoInParallel block is not a supported pattern.

```typescript fluent
// ❌ Not supported
// DoInParallel is imported from '@servicenow/sdk/automation'
DoInParallel({ $id: Now.ID['parallel'] },
    () => {
        wfa.stage(params.stages.step1)  // Not allowed
        wfa.action(...)
    },
)
```

Place `wfa.stage()` before the first action of that stage

wfa.stage() marks the beginning of a stage. Place it directly before the action(s) that belong to it.

```typescript fluent
// ✅ Correct ordering
wfa.stage(params.stages.triage)        // Stage begins here
wfa.action(action.core.log, ...)       // This action belongs to "triage"
wfa.action(action.core.log, ...)       // This also belongs to "triage"

wfa.stage(params.stages.approval)      // New stage begins
wfa.action(action.core.log, ...)       // This belongs to "approval"
```

Omitting `duration` defaults to zero

If duration is not specified in FlowStage(), it defaults to zero duration. Use Duration({...}) to set an expected time.

```typescript fluent
// Zero duration (default)
FlowStage({ label: 'Quick Step', value: 'quick_step' })

// Explicit duration
FlowStage({ label: 'Long Step', value: 'long_step', duration: Duration({ hours: 8 }) })
```

`duration` must use the `Duration()` helper

If you provide a duration, it must use the Duration() helper function. Plain objects are not supported and produce a build error.

```typescript fluent
// ❌ Build error — plain object not allowed
FlowStage({ label: 'Step', value: 'step', duration: { hours: 4 } })

// ✅ Correct — use Duration() helper
FlowStage({ label: 'Step', value: 'step', duration: Duration({ hours: 4 }) })
```

Stages are allowed in `if`, `elseIf`, `else`, and `tryCatch` bodies

Conditional and error-handling flow logic blocks are valid nesting contexts for wfa.stage(), as long as the stage is followed by at least one action or flow logic step.

```typescript fluent
// ✅ Valid — stage inside if/elseIf/else
wfa.flowLogic.if({ $id: Now.ID['cond'], condition: '...', annotation: '' }, () => {
    wfa.stage(params.stages.investigation)
    wfa.action(...)
})

wfa.flowLogic.else({ $id: Now.ID['else_cond'] }, () => {
    wfa.stage(params.stages.investigation)
    wfa.action(...)
})

// ✅ Valid — stage inside tryCatch try/catch bodies
wfa.flowLogic.tryCatch({ $id: Now.ID['tc'] }, {
    try: () => {
        wfa.stage(params.stages.resolution)
        wfa.action(...)
    },
    catch: () => {
        wfa.stage(params.stages.errorHandling)
        wfa.action(...)
    },
})
```

Stages cannot be the last statement in a branching logic block

wfa.stage() must be followed by at least one action or flow logic step inside if, elseIf, else, or tryCatch bodies. A trailing stage with nothing after it has no effect and produces a build error.

```typescript fluent
// ❌ Build error — stage is the last statement in the if body
wfa.flowLogic.if({ $id: Now.ID['cond'], condition: '...' }, () => {
    wfa.stage(params.stages.triage)
})

// ❌ Build error — stage is the last statement in the catch body
wfa.flowLogic.tryCatch({ $id: Now.ID['tc'] }, {
    try: () => { wfa.action(...) },
    catch: () => {
        wfa.stage(params.stages.errorHandling)  // Not allowed
    },
})

// ✅ Correct — stage is followed by an action
wfa.flowLogic.if({ $id: Now.ID['cond'], condition: '...' }, () => {
    wfa.stage(params.stages.triage)
    wfa.action(...)
})
```

Stages cannot be the last statement in the flow body

wfa.stage() must be followed by at least one action or flow logic step in the top-level flow body. A stage at the very end of the flow has no effect and produces a build error.

```typescript fluent
// ❌ Build error — stage is the last statement in the flow body
(params) => {
    wfa.action(...)
    wfa.stage(params.stages.cleanup)  // Not allowed
}

// ✅ Correct — stage is followed by an action
(params) => {
    wfa.stage(params.stages.cleanup)
    wfa.action(...)
}
```

---


Best Practices

1. Keep stage names descriptive — Use labels that clearly communicate the phase to stakeholders viewing the stage tracker.

2. Match key and value — Always ensure the property key in stages: {} matches the value inside FlowStage().

3. Use alwaysShow for visibility — Set alwaysShow: true when stakeholders should see the stage in the tracker even if the flow hasn't reached it yet.

4. Set realistic durations — Use Duration({...}) to communicate expected time for each phase. This helps with SLA tracking and stakeholder expectations.

5. Use custom state labels — Override default state labels via states when the generic labels (pending, in progress, etc.) don't fit the business context.

6. Declare before activate — Every wfa.stage() call in the body must reference a stage declared in the config header.

7. Always follow a stage with an action — Never place wfa.stage() as the last statement in a block or the flow body. A stage must always be followed by at least one action or flow logic step.

Duration() and TemplateValue() are global helpers — no import needed. See the data-helpers-guide topic for full documentation.


Next Steps

For complete API signatures, all FlowStage() config properties, wfa.stage() usage, and end-to-end examples, see the Flow Stages API.
