'use strict';
// Escalation of the throttle (1.2.0): the pause cap and a parallel limit for subagents
// grow with the lead over the schedule; from haltLeadPct on no new subagent starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DEFAULTS, validate, deepMerge } = require('../scripts/lib/config');
const { computeWait, windowWait, escalation } = require('../scripts/lib/throttle');
const { makeEnv, writeJson, runHook, runScript, seedSamples, linearSeries, preAgentInput } = require('./helpers');

const clone = (v) => JSON.parse(JSON.stringify(v));
const cfg = clone(DEFAULTS);
const T = cfg.throttle;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// 5-h window at mid-window: the schedule allows 50 %, so `used - 50` is the lead.
function fiveHourAt(used, resetInMin = 150) {
  return linearSeries({ now: NOW, resetInMin, startUsed: Math.max(0, used - 3), rate: 0.1, minutes: 30 });
}

function env(used, config = {}) {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(e.home, fiveHourAt(used));
  // Short pauses so the hook tests stay fast: 0.5 s plain, 2 s at the halt.
  writeJson(path.join(e.home, 'config.json'), { ...config, throttle: { maxWaitSec: 0.5, escalatedMaxWaitSec: 2, ...(config.throttle || {}) } });
  return e;
}
const toolInput = (over = {}) => ({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 't1', ...over });
const readLog = (home, kind) => fs.readFileSync(path.join(home, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === kind);

test('escalation: stage and pause cap follow the lead', () => {
  assert.deepEqual(escalation(0, T), { stage: 0, capSec: 90 });
  assert.deepEqual(escalation(5, T), { stage: 0, capSec: 90 });
  const mid = escalation(8.5, T);
  assert.equal(mid.stage, 1);
  near(mid.capSec, 165);
  assert.ok(escalation(5.1, T).capSec < escalation(11.9, T).capSec);
  assert.deepEqual(escalation(12, T), { stage: 2, capSec: 240 });
  assert.deepEqual(escalation(40, T), { stage: 2, capSec: 240 });
});

test('escalation: maxWaitSec 0 keeps pauses off, a higher maxWaitSec is never lowered', () => {
  assert.deepEqual(escalation(8, { ...T, maxWaitSec: 0 }), { stage: 1, capSec: 0 });
  assert.deepEqual(escalation(20, { ...T, maxWaitSec: 0 }), { stage: 2, capSec: 0 });
  assert.deepEqual(escalation(20, { ...T, maxWaitSec: 200, escalatedMaxWaitSec: 120 }), { stage: 2, capSec: 200 });
  assert.equal(escalation(8, { ...T, maxWaitSec: 200, escalatedMaxWaitSec: 120 }).capSec, 200);
  // Both leads at 100: switched off.
  assert.deepEqual(escalation(60, { ...T, escalateLeadPct: 100, haltLeadPct: 100 }), { stage: 0, capSec: 90 });
});

test('escalation: 5-h window pauses longer the further usage is ahead', () => {
  const small = computeWait(fiveHourAt(53), NOW, cfg);
  assert.equal(small.stage, 0);
  assert.equal(small.agentCap, null);
  assert.equal(small.waitSec, 90);
  const mid = computeWait(fiveHourAt(58), NOW, cfg);
  assert.equal(mid.stage, 1);
  assert.equal(mid.agentCap, 1);
  assert.ok(mid.waitSec > 90 && mid.waitSec < 240, `wait ${mid.waitSec}`);
  assert.equal(mid.escalated.name, 'fiveHour');
  const halt = computeWait(fiveHourAt(64), NOW, cfg);
  assert.equal(halt.stage, 2);
  assert.equal(halt.agentCap, 0);
  assert.equal(halt.waitSec, 240);
  const onPlan = computeWait(fiveHourAt(45), NOW, cfg);
  assert.equal(onPlan.stage, 0);
  assert.equal(onPlan.agentCap, null);
  assert.equal(onPlan.escalated, null);
});

test('escalation: weekly window far ahead reaches the halt (real data: 80 % used, plan 58 %)', () => {
  // Thursday 12:00, reset Monday 00:00: 58 % of the week has passed by the wall clock.
  const now = Date.UTC(2026, 9, 8, 10, 0, 0);
  const reset = Math.round((now + 0.42 * 7 * 86400000) / 1000);
  const samples = [{ t: now, f: { u: 10, r: Math.round((now + 4 * 3600000) / 1000) }, s: { u: 80, r: reset } }];
  const week = windowWait('sevenDay', samples, now, cfg);
  assert.equal(week.status, 'ahead');
  assert.ok(week.ahead >= T.haltLeadPct, `lead ${week.ahead}`);
  assert.equal(week.stage, 2);
  assert.equal(week.waitSec, 240);
  const w = computeWait(samples, now, cfg);
  assert.equal(w.agentCap, 0);
  assert.equal(w.escalated.name, 'sevenDay');
});

test('config: escalation fields are validated', () => {
  const check = (over) => validate(deepMerge(clone(DEFAULTS), { throttle: over }));
  assert.deepEqual(check({ escalateLeadPct: 0, haltLeadPct: 100, escalatedMaxWaitSec: 0, escalatedAgentCap: 0 }).errors, []);
  assert.deepEqual(check({ escalateLeadPct: 100, haltLeadPct: 100 }).errors, []);
  const bad = check({ escalateLeadPct: -1, haltLeadPct: 101, escalatedMaxWaitSec: 241, escalatedAgentCap: 1.5 });
  assert.deepEqual(bad.errors.sort(), ['throttle.escalateLeadPct', 'throttle.escalatedAgentCap', 'throttle.escalatedMaxWaitSec', 'throttle.haltLeadPct']);
  assert.deepEqual(bad.config.throttle, DEFAULTS.throttle);
  // Halt below the start: both fall back together.
  const swapped = check({ escalateLeadPct: 20, haltLeadPct: 10 });
  assert.deepEqual(swapped.errors, ['throttle.haltLeadPct']);
  assert.equal(swapped.config.throttle.escalateLeadPct, 5);
  assert.equal(swapped.config.throttle.haltLeadPct, 12);
});

test('pre-agent, strategy throttle: no limit on a small lead', () => {
  const e = env(53);
  for (const id of ['a1', 'a2', 'a3']) {
    assert.equal(runHook('pre-agent', preAgentInput({ cwd: e.project, tool_use_id: id }), e.env).stdout.trim(), '');
  }
});

test('pre-agent, strategy throttle: stage 1 allows one subagent at a time', () => {
  const e = env(58);
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: e.project, tool_use_id: 'a1' }), e.env).stdout.trim(), '');
  const r = runHook('pre-agent', preAgentInput({ cwd: e.project, tool_use_id: 'a2' }), e.env);
  assert.equal(r.code, 0);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /8 points ahead of the schedule \(5-hour window 58% used, schedule 50%\)/);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /limit while this far ahead is 1/);
  const log = readLog(e.home, 'pre-agent');
  assert.equal(log[0].action, 'none');
  assert.equal(log[1].action, 'deny');
  assert.equal(log[1].reason, 'throttle-stage-1');
  assert.equal(log[1].cap, 1);
});

test('pre-agent, strategy throttle: the halt starts no new subagent', () => {
  const e = env(64);
  const r = runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /New subagents are paused/);
  assert.equal(readLog(e.home, 'pre-agent')[0].reason, 'throttle-stage-2');
});

test('pre-agent: strategy downgrade and a disabled plugin ignore the escalation', () => {
  const down = env(58, { strategy: 'downgrade' });
  for (const id of ['a1', 'a2']) {
    const r = runHook('pre-agent', preAgentInput({ cwd: down.project, tool_use_id: id }), down.env);
    assert.notEqual(r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision, 'deny');
  }
  const off = env(64, { enabled: false });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: off.project }), off.env).stdout.trim(), '');
  const noEsc = env(64, { throttle: { escalateLeadPct: 100, haltLeadPct: 100 } });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: noEsc.project }), noEsc.env).stdout.trim(), '');
});

test('throttle hook: the halt pauses for the escalated maximum and announces the stage', () => {
  const e = env(64);
  const r = runHook('throttle', toolInput(), e.env);
  assert.equal(r.code, 0);
  assert.ok(r.ms >= 2000 && r.ms < 5000, `took ${r.ms} ms`);
  assert.match(r.json.systemMessage, /Drossel aktiv – Pausen bis 2 s/);
  assert.match(r.json.systemMessage, /Subagent/);
  const log = readLog(e.home, 'throttle');
  assert.equal(log[0].waitSec, 2);
  assert.equal(log[0].stage, 2);
  // Second step: same stage, no second notice.
  assert.equal(runHook('throttle', toolInput({ tool_use_id: 't2' }), e.env).stdout.trim(), '');
});

test('throttle hook: a change of the stage is announced again', () => {
  const e = env(53);
  const first = runHook('throttle', toolInput(), e.env);
  assert.match(first.json.systemMessage, /Pausen bis 0\.5 s/);
  seedSamples(e.home, fiveHourAt(64));
  const second = runHook('throttle', toolInput({ tool_use_id: 't2' }), e.env);
  assert.match(second.json.systemMessage, /Pausen bis 2 s/);
});

test('throttle hook: at the halt an Agent call is not paused, it is denied by pre-agent', () => {
  const e = env(64);
  const r = runHook('throttle', toolInput({ tool_name: 'Agent', tool_input: { prompt: 'x' } }), e.env);
  assert.ok(r.ms < 1500, `took ${r.ms} ms`);
  const skip = readLog(e.home, 'throttle-skip');
  assert.equal(skip.length, 1);
  assert.equal(skip[0].reason, 'agent-call-halt');
});

test('pacer status names the stage and the parallel limit', () => {
  const st = (e) => runScript('pacer.js', ['status'], '', e.env).stdout;
  const halt = st(env(64));
  assert.match(halt, /höchstens 2 s je Pause; Halt – Vorsprung zu groß\)/);
  assert.match(halt, /Parallel-Limit auf dieser Stufe: 0 – keine neuen Subagents \(Drossel-Halt/);
  const stage1 = st(env(58));
  assert.match(stage1, /; verschärft – Vorsprung groß\)/);
  assert.match(stage1, /Parallel-Limit auf dieser Stufe: 1 \(Drossel verschärft/);
  const small = st(env(53));
  assert.match(small, /höchstens 0\.5 s je Pause\)/);
  assert.match(small, /Parallel-Limit auf dieser Stufe: keins \(Strategie throttle\)/);
});
