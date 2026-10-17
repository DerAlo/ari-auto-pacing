'use strict';
// Temporary pause (`pacer.js pause`, /quota-pacer:pause): all interventions off until it
// runs out or `resume`; the sensor keeps recording.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseDuration } = require('../scripts/lib/pause');
const { makeEnv, writeJson, runHook, runHookAsync, runScript, seedSamples, linearSeries, preAgentInput } = require('./helpers');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

// 5-h window 14 points ahead of the schedule: halt stage, pre-agent denies, long pause.
function env(config = { throttle: { maxWaitSec: 0.5, escalatedMaxWaitSec: 5 } }) {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(e.home, linearSeries({ now: NOW, resetInMin: 150, startUsed: 61, rate: 0.1, minutes: 30 }));
  writeJson(path.join(e.home, 'config.json'), config);
  return e;
}
const pause = (e, ...args) => runScript('pacer.js', ['pause', ...args], '', e.env);
const toolInput = (over = {}) => ({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 't1', ...over });
const throttleLog = (e) => {
  const f = path.join(e.home, 'decisions.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === 'throttle') : [];
};

test('pause: durations', () => {
  assert.equal(parseDuration(undefined), 120);
  assert.equal(parseDuration(''), 120);
  assert.equal(parseDuration('30m'), 30);
  assert.equal(parseDuration('45'), 45);
  assert.equal(parseDuration('2h'), 120);
  assert.equal(parseDuration('1,5h'), 90);
  assert.equal(parseDuration('1.5 Std'), 90);
  assert.equal(parseDuration('1d'), 1440);
  assert.equal(parseDuration('7d'), 10080);
  for (const bad of ['0', '0.5m', '8d', 'x', '2h; rm', '-1h', '1w']) assert.equal(parseDuration(bad), null, bad);
});

test('pause: the command sets it, status and doctor report it, resume ends it', () => {
  const e = env();
  const r = pause(e, '90m');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /quota-pacer pausiert bis \d\d:\d\d \(1,5 h\)/);
  const p = JSON.parse(fs.readFileSync(path.join(e.home, 'pause.json'), 'utf8'));
  assert.equal(p.until, NOW + 90 * 60000);
  const st = runScript('pacer.js', ['status'], '', e.env).stdout;
  assert.match(st, /Drossel: aus \(pausiert bis \d\d:\d\d\)/);
  assert.match(st, /Parallel-Limit auf dieser Stufe: keins \(pausiert\)/);
  assert.match(st, /Pausiert bis \d\d:\d\d – keine Eingriffe/);
  assert.equal(JSON.parse(runScript('pacer.js', ['status', '--json'], '', e.env).stdout).pausedUntil, NOW + 90 * 60000);
  assert.match(runScript('pacer.js', ['doctor'], '', e.env).stdout, /\[WARN\] Pause: alle Eingriffe aus bis/);
  assert.match(runScript('pacer.js', ['resume'], '', e.env).stdout, /wieder aktiv/);
  assert.equal(fs.existsSync(path.join(e.home, 'pause.json')), false);
  assert.match(runScript('pacer.js', ['resume'], '', e.env).stdout, /war nicht pausiert/);
  assert.match(runScript('pacer.js', ['status'], '', e.env).stdout, /Drossel: aktiv/);
});

test('pause: an unreadable duration changes nothing', () => {
  const e = env();
  const r = pause(e, '3', 'Wochen');
  assert.equal(r.code, 1);
  assert.match(r.stdout, /nicht lesbar/);
  assert.equal(fs.existsSync(path.join(e.home, 'pause.json')), false);
});

test('pause: no throttle pause and no subagent limit while paused, both back afterwards', () => {
  const e = env();
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env).json.hookSpecificOutput.permissionDecision, 'deny');
  pause(e, '30m');
  const t = runHook('throttle', toolInput(), e.env);
  assert.ok(t.ms < 1500, `took ${t.ms} ms`);
  assert.equal(t.stdout.trim(), '');
  assert.equal(throttleLog(e).length, 0);
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: e.project, tool_use_id: 'a2' }), e.env).stdout.trim(), '');
  // 31 minutes later the pause has run out.
  const later = { ...e.env, QUOTA_PACER_NOW: String(NOW + 31 * 60000) };
  seedSamples(e.home, linearSeries({ now: NOW + 31 * 60000, resetInMin: 119, startUsed: 70, rate: 0.1, minutes: 30 }));
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: e.project, tool_use_id: 'a3' }), later).json.hookSpecificOutput.permissionDecision, 'deny');
});

test('pause: a throttle pause already running ends within a second', async () => {
  const e = env();
  const running = runHookAsync('throttle', toolInput(), e.env);
  await new Promise((r) => setTimeout(r, 1200));
  pause(e, '10m');
  const r = await running;
  assert.equal(r.code, 0);
  assert.ok(r.ms < 4000, `took ${r.ms} ms (full pause 5 s)`);
});

test('pause: the pause and resume commands themselves are never throttled', () => {
  const e = env({ throttle: { maxWaitSec: 3, escalatedMaxWaitSec: 3 } });
  for (const [tool, command] of [['Bash', 'node "/p/scripts/pacer.js" pause 2h'], ['Bash', 'node /p/scripts/pacer.js resume'], ['PowerShell', "node 'C:/p/scripts/pacer.js' pause"]]) {
    const r = runHook('throttle', toolInput({ tool_name: tool, tool_input: { command } }), e.env);
    assert.ok(r.ms < 1500, `${command}: ${r.ms} ms`);
  }
  const other = runHook('throttle', toolInput({ tool_name: 'Bash', tool_input: { command: 'node pacer.js status' }, tool_use_id: 't9' }), e.env);
  assert.ok(other.ms >= 3000, `status: ${other.ms} ms`);
});

test('pause: SessionStart and the status line show it', () => {
  const e = env();
  pause(e, '2h');
  const s = runHook('session-start', { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }, e.env);
  assert.match(s.json.systemMessage, /quota-pacer: pausiert bis \d\d:\d\d – keine Drossel/);
  const line = strip(runScript('statusline.js', [], { session_id: 'x', model: { id: 'claude-opus-5-5' } }, e.env).stdout);
  assert.match(line, /pacing Pause bis \d\d:\d\d/);
  const en = env({ language: 'en' });
  pause(en, '1d');
  assert.match(strip(runScript('statusline.js', [], { session_id: 'x' }, en.env).stdout), /pacing paused until \d\d\.\d\d\. \d\d:\d\d/);
  const quiet = env({ notify: false });
  pause(quiet);
  assert.equal(runHook('session-start', { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }, quiet.env).stdout.trim(), '');
});

test('pause: an end far beyond the maximum is capped at 7 days', () => {
  const e = env();
  writeJson(path.join(e.home, 'pause.json'), { until: NOW + 365 * 86400000, t: NOW - 8 * 86400000 });
  assert.match(runScript('pacer.js', ['status'], '', e.env).stdout, /Drossel: aktiv/);
  writeJson(path.join(e.home, 'pause.json'), { until: 'bald' });
  assert.match(runScript('pacer.js', ['status'], '', e.env).stdout, /Drossel: aktiv/);
});
