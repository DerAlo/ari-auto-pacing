'use strict';
// Permission modes (fix for the auto-mode classifier bypass): allow + updatedInput only in
// modes where an Agent call is not checked anyway; in auto mode and unknown modes the call
// is denied once with a request to re-issue it with the cheaper model, guarded against
// loops. Every decision writes exactly one audit line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeEnv, writeJson, runHook, runHookAsync, seedSamples, linearSeries, preAgentInput, readLog } = require('./helpers');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MIN = 60000;

function amberEnv(extra = {}) {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW), ...extra });
  seedSamples(e.home, linearSeries({ now: NOW, resetInMin: 240, startUsed: 20, rate: 0.3, minutes: 30 }));
  writeJson(path.join(e.home, 'config.json'), { strategy: 'downgrade' });
  return e;
}

const call = (e, over = {}) => preAgentInput({ cwd: e.project, ...over });
const explore = (prompt, extra = {}) => ({ description: 'Find usages', prompt, subagent_type: 'Explore', run_in_background: false, ...extra });
const reservations = (e, sid = 'sess-1') => {
  try { return fs.readdirSync(path.join(e.home, 'sessions', sid, 'reservations')).length; } catch { return 0; }
};

test('simple permission modes: allow + updatedInput with every original field', () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']) {
    const e = amberEnv();
    const input = call(e, { permission_mode: mode });
    const r = runHook('pre-agent', input, e.env);
    const o = r.json.hookSpecificOutput;
    assert.equal(o.permissionDecision, 'allow', mode);
    assert.deepEqual(o.updatedInput, { ...input.tool_input, model: 'haiku' }, mode);
    const d = readLog(e.home, 'pre-agent');
    assert.deepEqual(d.map((l) => [l.action, l.permissionMode]), [['rewrite', mode]]);
    assert.equal(reservations(e), 1, mode);
  }
});

test('auto, unknown and missing permission modes: one re-issue deny naming the model field', () => {
  for (const mode of ['auto', 'someFutureMode', undefined]) {
    const e = amberEnv();
    const input = call(e, { permission_mode: mode });
    if (mode === undefined) delete input.permission_mode;
    const r = runHook('pre-agent', input, e.env);
    assert.equal(r.code, 0);
    const o = r.json.hookSpecificOutput;
    assert.equal(o.hookEventName, 'PreToolUse');
    assert.equal(o.permissionDecision, 'deny', String(mode));
    assert.equal(o.updatedInput, undefined, 'never rewrites outside the simple modes');
    assert.match(o.permissionDecisionReason, /"model": "haiku"/);
    assert.match(o.permissionDecisionReason, /same Agent call/);
    const d = readLog(e.home, 'pre-agent');
    assert.deepEqual(d.map((l) => [l.action, l.model, l.permissionMode]), [['reissue', 'haiku', mode === undefined ? null : mode]]);
    assert.equal(reservations(e), 0, 'a denied call reserves no slot');
  }
});

test('re-issued call with the requested model passes, then the guard is cleared', () => {
  const e = amberEnv();
  const first = call(e, { permission_mode: 'auto', tool_input: explore('Find Foo') });
  assert.equal(runHook('pre-agent', first, e.env).json.hookSpecificOutput.permissionDecision, 'deny');
  const again = call(e, { permission_mode: 'auto', tool_input: explore('Find Foo', { model: 'haiku' }) });
  const r = runHook('pre-agent', again, e.env);
  assert.equal(r.stdout.trim(), '', 'the cheap call passes unchanged and goes to the classifier');
  assert.equal(reservations(e), 1);
  // A later identical spawn without a model is a new spawn: it is asked again.
  const later = runHook('pre-agent', call(e, { permission_mode: 'auto', tool_input: explore('Find Foo') }), e.env);
  assert.equal(later.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(readLog(e.home, 'pre-agent').map((l) => [l.action, l.reason, l.effective]), [
    ['reissue', 'unknown-effective', null],
    ['none', 'already-at-or-below-target', 'haiku'],
    ['reissue', 'unknown-effective', null],
  ]);
});

test('a call that comes back without the model passes unchanged: no loop', () => {
  const e = amberEnv();
  const same = () => call(e, { permission_mode: 'auto', tool_input: explore('Find Bar') });
  assert.equal(runHook('pre-agent', same(), e.env).json.hookSpecificOutput.permissionDecision, 'deny');
  for (let i = 0; i < 2; i++) assert.equal(runHook('pre-agent', same(), e.env).stdout.trim(), '', `repeat ${i}`);
  // The guard is per call and per session.
  const other = runHook('pre-agent', call(e, { permission_mode: 'auto', tool_input: explore('Find Baz') }), e.env);
  assert.equal(other.json.hookSpecificOutput.permissionDecision, 'deny');
  const otherSession = runHook('pre-agent', call(e, { session_id: 'sess-2', permission_mode: 'auto', tool_input: explore('Find Bar') }), e.env);
  assert.equal(otherSession.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(readLog(e.home, 'pre-agent').map((l) => `${l.action}:${l.reason}`), [
    'reissue:unknown-effective', 'none:reissue-ignored', 'none:reissue-ignored', 'reissue:unknown-effective', 'reissue:unknown-effective',
  ]);
  assert.equal(reservations(e), 2, 'calls passing unchanged still count against the cap');
  const stored = fs.readFileSync(path.join(e.home, 'sessions', 'sess-1', 'reissue.json'), 'utf8');
  assert.ok(!stored.includes('Find Bar'), 'only a hash of the call is stored');
});

test('the loop guard expires after 10 minutes', () => {
  const e = amberEnv();
  const same = () => call(e, { permission_mode: 'auto', tool_input: explore('Find Qux') });
  assert.equal(runHook('pre-agent', same(), e.env).json.hookSpecificOutput.permissionDecision, 'deny');
  e.env.QUOTA_PACER_NOW = String(NOW + 9 * MIN);
  assert.equal(runHook('pre-agent', same(), e.env).stdout.trim(), '');
  e.env.QUOTA_PACER_NOW = String(NOW + 11 * MIN); // samples are still fresh (< 20 min)
  assert.equal(runHook('pre-agent', same(), e.env).json.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(readLog(e.home, 'pre-agent').map((l) => `${l.level}:${l.action}`), ['amber:reissue', 'amber:none', 'amber:reissue']);
});

test('exactly one audit line per decision, whatever the outcome', () => {
  const e = amberEnv();
  const outcomes = [
    runHook('pre-agent', call(e, { tool_input: explore('a') }), e.env), // rewrite
    runHook('pre-agent', call(e, { permission_mode: 'auto', tool_input: explore('b') }), e.env), // reissue
    runHook('pre-agent', call(e, { permission_mode: 'auto', tool_input: explore('b') }), e.env), // none (ignored)
    runHook('pre-agent', call(e, { permission_mode: 'plan', tool_input: explore('c') }), e.env), // rewrite: 3rd slot
    runHook('pre-agent', call(e, { permission_mode: 'acceptEdits', tool_input: explore('d') }), e.env), // deny: cap 3
  ];
  writeJson(path.join(e.project, '.claude', 'settings.local.json'), { permissions: { ask: ['Agent(Plan)'] } });
  outcomes.push(runHook('pre-agent', call(e, { tool_input: { description: 'p', prompt: 'p', subagent_type: 'Plan' } }), e.env)); // skip
  assert.deepEqual(outcomes.map((r) => (r.json ? r.json.hookSpecificOutput.permissionDecision : '-')), ['allow', 'deny', '-', 'allow', 'deny', '-']);
  const lines = readLog(e.home, 'pre-agent');
  assert.deepEqual(lines.map((l) => l.action), ['rewrite', 'reissue', 'none', 'rewrite', 'deny', 'skip']);
  assert.deepEqual(lines.map((l) => l.permissionMode), ['default', 'auto', 'auto', 'plan', 'acceptEdits', 'default']);
  assert.deepEqual(lines.map((l) => l.active), [0, 1, 1, 2, 3, null]);
  for (const l of lines) {
    for (const k of ['ts', 'session', 'agentType', 'cls', 'level', 'effective', 'effectiveSource', 'model', 'reason']) assert.ok(k in l, `${l.action}: ${k}`);
  }
  assert.equal(lines[5].reason, 'permission-ask-rule');
  assert.equal(readLog(e.home).filter((l) => l.kind === 'error').length, 0);
});

test('auto mode burst: 5 parallel calls are all asked to re-issue, the re-issued ones are capped at 3', async () => {
  const e = amberEnv();
  const prompts = [1, 2, 3, 4, 5].map((i) => `E2E-SUB #${i}`);
  const round1 = await Promise.all(prompts.map((p) => runHookAsync('pre-agent', call(e, { permission_mode: 'auto', tool_input: explore(p) }), e.env)));
  assert.deepEqual(round1.map((r) => r.json && r.json.hookSpecificOutput.permissionDecision), Array(5).fill('deny'));
  assert.ok(round1.every((r) => /"model": "haiku"/.test(r.json.hookSpecificOutput.permissionDecisionReason)));
  const round2 = await Promise.all(prompts.map((p) => runHookAsync('pre-agent', call(e, { permission_mode: 'auto', tool_input: explore(p, { model: 'haiku' }) }), e.env)));
  const decisions = round2.map((r) => (r.json ? r.json.hookSpecificOutput.permissionDecision : 'none'));
  assert.equal(decisions.filter((d) => d === 'none').length, 3, decisions.join(','));
  assert.equal(decisions.filter((d) => d === 'deny').length, 2, decisions.join(','));
  const actions = readLog(e.home, 'pre-agent').map((l) => l.action);
  assert.equal(actions.length, 10);
  assert.deepEqual(actions.slice(0, 5), Array(5).fill('reissue'));
  assert.deepEqual([...actions.slice(5)].sort(), ['deny', 'deny', 'none', 'none', 'none']);
});
