// Runs (ADR 0011): the stage machine, the reviewer's verdict, and the
// plan-mode conditions — every one a pure function, so the conditions that
// let a plan commit on a person's token are pinned without an instance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newRun, nextStage, advance, parseVerdict, planModeBlocked, planCommitAllowed, TEMPLATES, STAGES,
} from '../server/runs.js';
import { checkScript, scriptProblems, committableActions } from '../server/commits.js';
import { ACTIONS } from '../server/actions.js';

test('every catalog action has a commit, and nothing else does', () => {
  assert.deepEqual(committableActions(), ACTIONS.map((a) => a.id).sort());
});

test('a script that does not parse is refused before any card is drawn (ADR 0011 D2)', () => {
  assert.equal(checkScript('(function executeRule(current, previous) { current.priority = 1; })(current, previous);'), null);
  assert.match(checkScript('var gr = new GlideReocrd(\'task\'); gr.query(\');', 'script'), /script does not parse/);
  assert.equal(scriptProblems({ name: 'x', script: 'if (current.priority == 1) { gs.info("open"); ' }).length, 1);
  assert.deepEqual(scriptProblems({ name: 'x', script: 'short' }), []);

  // A Service Portal widget: the link function is code too, and the option
  // schema must be JSON — both refused before a card is drawn.
  const widget = {
    name: 'Duck Hunt', id: 'duck_hunt', controller_as: 'c',
    template: '<div class="duck-hunt"><canvas></canvas></div>',
    client_script: 'api.controller = function($scope) { var c = this; c.score = 0; };',
    script: '(function() { data.buildtag = gs.getProperty("glide.buildtag"); })();',
    link: 'function link(scope, element) { var canvas = element.find("canvas")[0]; scope.$on("$destroy", function() {}); }',
    option_schema: '[{"name":"rounds","label":"Rounds","type":"integer","value":10}]',
  };
  assert.deepEqual(scriptProblems(widget), []);
  assert.match(scriptProblems({ ...widget, link: 'function link(scope, element) { var x = ; }' })[0], /link does not parse/);
  assert.match(scriptProblems({ ...widget, option_schema: '[{"name":"rounds",}]' })[0], /option_schema is not valid JSON/);
});

test('the stage machine: spec → review → approve → build → (cards) → test → verify → done', () => {
  const run = newRun({ goal: 'Route VPN incidents to Network Ops', template: 'build', policy: 'each' });
  assert.equal(run.stage, 'spec');
  let next = nextStage(run);
  assert.equal(next.stage, 'spec');
  assert.match(next.prompt, /SPEC STAGE/);
  advance(run, 'spec', { text: '## Goal…', after: next.after });
  assert.equal(run.stage, 'review');

  next = nextStage(run);
  assert.equal(next.stage, 'review');
  assert.ok(next.systemExtra, 'the reviewer gets its own role');
  advance(run, 'review', { text: 'VERDICT: APPROVED\n## Findings\n', after: null });
  assert.equal(run.stage, 'approve');
  assert.throws(() => nextStage(run), /waiting for your approval/);

  run.stage = 'build'; // what POST /api/runs/:id/plan does on approval
  next = nextStage(run);
  assert.equal(next.stage, 'build');
  assert.equal(next.after, 'build_pending', 'review-each pauses for the cards');
  advance(run, 'build', { text: '', after: next.after });
  assert.equal(run.stage, 'build_pending');
  next = nextStage(run);
  assert.equal(next.stage, 'test');
  advance(run, 'test', { text: '', after: next.after });
  next = nextStage(run);
  assert.equal(next.stage, 'verify');
  advance(run, 'verify', { text: '', after: next.after });
  assert.equal(run.stage, 'done');
  assert.equal(run.status, 'done');
  assert.throws(() => nextStage(run), /finished/);
});

test('a REVISE verdict sends the spec back once, then the person decides', () => {
  const run = newRun({ goal: 'x'.repeat(10), template: 'build', policy: 'each' });
  advance(run, 'spec', { text: '', after: 'review' });
  advance(run, 'review', { text: 'VERDICT: REVISE\n## Findings\n1. sys_script has no field "tabel".', after: null });
  assert.equal(run.stage, 'spec');
  assert.match(run.findings, /tabel/);
  assert.match(nextStage(run).prompt, /revision/);
  advance(run, 'spec', { text: '', after: 'review' });
  advance(run, 'review', { text: 'VERDICT: REVISE\n## Findings\n1. still', after: null });
  assert.equal(run.stage, 'approve', 'a second REVISE does not loop forever');
  assert.deepEqual(parseVerdict('nothing here'), { verdict: null, findings: '' });
});

test('a plan-approved build skips the card pause', () => {
  const run = newRun({ goal: 'x'.repeat(10), template: 'build', policy: 'plan' });
  run.stage = 'build';
  assert.equal(nextStage(run).after, 'test');
});

test('plan mode needs every condition (ADR 0011 D3)', () => {
  const run = newRun({ goal: 'x'.repeat(10), template: 'build', policy: 'plan' });
  const org = { runs_plan_mode: true, actions_tiers: '1,2' };
  const instance = { non_production: true };
  assert.match(planModeBlocked({ org, instance, run, userSysId: 'u1' }), /not approved by you/);
  run.plan_approved_by = 'u1';
  assert.equal(planModeBlocked({ org, instance, run, userSysId: 'u1' }), null);
  assert.match(planModeBlocked({ org, instance, run, userSysId: 'u2' }), /not approved by you/);
  assert.match(planModeBlocked({ org: { ...org, runs_plan_mode: false }, instance, run, userSysId: 'u1' }), /org admin/);
  assert.match(planModeBlocked({ org, instance: { non_production: false }, run, userSysId: 'u1' }), /non-production/);
  assert.match(planModeBlocked({ org, instance, run: { ...run, policy: 'each' }, userSysId: 'u1' }), /each write/);
});

test('a plan never commits a disabled tier, and never tier 3', () => {
  assert.equal(planCommitAllowed({ actions_tiers: '1,2' }, 'journal.append'), null);
  assert.match(planCommitAllowed({ actions_tiers: '1' }, 'config.create'), /not enabled/);
  assert.match(planCommitAllowed({ actions_tiers: '1,2' }, 'nope'), /unknown/);
  const tier3 = ACTIONS.find((a) => a.tier >= 3);
  if (tier3) assert.match(planCommitAllowed({ actions_tiers: '1,2,3' }, tier3.id), /tier 3/);
});

test('every template covers every model stage, and no stage prompt asks for a write outside build', () => {
  for (const tpl of Object.values(TEMPLATES)) {
    for (const fn of ['spec', 'review', 'revise', 'build', 'test', 'verify']) assert.equal(typeof tpl[fn], 'function', `${tpl.id}.${fn}`);
    for (const stage of ['spec', 'review', 'test', 'verify']) {
      const prompt = stage === 'spec' ? tpl.spec('goal') : tpl[stage]();
      assert.match(prompt, /no writes|no instance writes|not propose any write|Do not propose|read-only|reads only|read only|changes nothing/i, `${tpl.id}.${stage} must say it writes nothing`);
    }
  }
  assert.deepEqual(STAGES, ['spec', 'review', 'approve', 'build', 'test', 'verify', 'done']);
});
