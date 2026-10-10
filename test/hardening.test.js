'use strict';
// Fixes from the 1.1.0 review: re-issue guard that cannot be stored, model allowlists,
// every managed settings source, pause budget per API response, chained status line,
// file permissions, and robustness of the forecast against incomplete data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  ROOT, makeEnv, writeJson, runHook, runHookAsync, runScript, seedSamples, linearSeries, preAgentInput, assistantLine, userLine, writeTranscript, readLog,
} = require('./helpers');
const { DEFAULTS, validate, deepMerge } = require('../scripts/lib/config');
const { analyzeWindow } = require('../scripts/lib/forecast');
const { windowWait } = require('../scripts/lib/throttle');
const { decideSpawn } = require('../scripts/lib/policy');
const { ruleMatchesAgent } = require('../scripts/lib/permissions');
const { denyReason } = require('../scripts/lib/messages');
const reissue = require('../scripts/lib/reissue');
const { toolUseModel } = require('../scripts/lib/transcript');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const cfg = JSON.parse(JSON.stringify(DEFAULTS));
// Escalation off: these tests are about the plain pause (see escalation.test.js).
const NO_ESC = { escalateLeadPct: 100, haltLeadPct: 100 };
Object.assign(cfg.throttle, NO_ESC);
const RED = () => linearSeries({ now: NOW, resetInMin: 150, startUsed: 40, rate: 0.6, minutes: 30 });

function downgradeEnv(samples = RED(), config = {}) {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(e.home, samples);
  writeJson(path.join(e.home, 'config.json'), { strategy: 'downgrade', ...config });
  return e;
}

const decision = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision;

// ---- re-issue guard ----

test('re-issue: no deny when the loop guard cannot be stored (no endless deny loop)', () => {
  const e = downgradeEnv(RED(), { concurrency: { green: null, amber: null, red: null, stop: 0 } }); // passing calls must not hit the cap
  // reissue.json is a directory: every write of the guard fails, everything else works.
  fs.mkdirSync(path.join(e.home, 'sessions', 'sess-1', 'reissue.json'), { recursive: true });
  for (let i = 0; i < 3; i++) {
    const r = runHook('pre-agent', preAgentInput({ cwd: e.project, permission_mode: 'auto', tool_use_id: `tu${i}` }), e.env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '', `call ${i} must pass unchanged`);
  }
  const log = readLog(e.home, 'pre-agent');
  assert.equal(log.length, 3);
  for (const l of log) assert.equal(l.reason, 'reissue-unpersistable');
});

test('re-issue: a call that only adds the default subagent_type is the same call', () => {
  const e = downgradeEnv();
  const first = preAgentInput({ cwd: e.project, permission_mode: 'auto', tool_input: { description: 'd', prompt: 'p' } });
  assert.equal(decision(runHook('pre-agent', first, e.env)), 'deny');
  const again = preAgentInput({ cwd: e.project, permission_mode: 'auto', tool_input: { subagent_type: 'general-purpose', description: 'd ', prompt: 'p' } });
  assert.equal(runHook('pre-agent', again, e.env).stdout.trim(), '');
  assert.equal(readLog(e.home, 'pre-agent')[1].reason, 'reissue-ignored');
  assert.equal(reissue.callKey('general-purpose', { description: 'd' }), reissue.callKey('', { subagent_type: 'x', description: ' d' }));
});

// ---- model allowlist ----

test('allowlist: no rewrite to a model outside availableModels or inside deniedModels', () => {
  const managed = downgradeEnv();
  writeJson(managed.env.QUOTA_PACER_MANAGED_SETTINGS, { availableModels: ['sonnet', 'opus'] });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: managed.project }), managed.env).stdout.trim(), '');
  const d = readLog(managed.home, 'pre-agent')[0];
  assert.equal(d.reason, 'target-not-allowed');
  assert.equal(d.detail, 'not-in-availableModels');

  const allowed = downgradeEnv();
  writeJson(allowed.env.QUOTA_PACER_MANAGED_SETTINGS, { availableModels: ['claude-haiku-4-5', 'opus'] });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: allowed.project }), allowed.env).json.hookSpecificOutput.updatedInput.model, 'haiku');

  const denied = downgradeEnv();
  writeJson(path.join(denied.project, '.claude', 'settings.json'), { deniedModels: ['haiku'] });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: denied.project }), denied.env).stdout.trim(), '');
  assert.equal(readLog(denied.home, 'pre-agent')[0].detail, 'in-deniedModels');

  const broken = downgradeEnv();
  writeJson(path.join(broken.claude, 'settings.json'), { availableModels: 'haiku' });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: broken.project }), broken.env).stdout.trim(), '');
});

// ---- managed settings sources and rule matching ----

test('rules: server-managed settings and managed-settings.d drop-ins are honoured', () => {
  const remote = downgradeEnv();
  writeJson(path.join(remote.claude, 'remote-settings.json'), { permissions: { ask: ['Agent'] } });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: remote.project }), remote.env).stdout.trim(), '');
  assert.equal(readLog(remote.home, 'pre-agent')[0].action, 'skip');

  const dropIn = downgradeEnv();
  writeJson(path.join(path.dirname(dropIn.env.QUOTA_PACER_MANAGED_SETTINGS), 'managed-settings.d', '10-team.json'), { permissions: { deny: ['Task(*)'] } });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: dropIn.project }), dropIn.env).stdout.trim(), '');
  assert.equal(readLog(dropIn.home, 'pre-agent')[0].reason, 'permission-deny-rule');

  const hooksOnly = makeEnv();
  writeJson(path.join(hooksOnly.claude, 'remote-settings.json'), { allowManagedHooksOnly: true });
  assert.match(runScript('pacer.js', ['doctor'], '', hooksOnly.env).stdout, /\[FAIL\] Managed Settings/);
});

test('rules: anything that starts with Agent/Task and is not an exact other type counts (fail safe)', () => {
  for (const r of ['Agent', 'Task', 'Agent()', 'Agent(*)', 'Agent(Explore)', 'Agent (Explore)', 'Agent(Expl*)', 'Agent(Explore', 'Agent:Explore']) {
    assert.equal(ruleMatchesAgent(r, 'Explore'), true, r);
  }
  for (const r of ['Agent(Plan)', 'Bash', 'TaskCreate', 'AgentX', 'Read(Agent)']) assert.equal(ruleMatchesAgent(r, 'Explore'), false, r);
});

// ---- no data means no intervention ----

test('unknown level: a GREEN cap never applies', () => {
  const c = { ...cfg, concurrency: { ...cfg.concurrency, green: 0 } };
  assert.deepEqual(decideSpawn({ level: 'unknown', agentType: 'Explore', eff: null, active: 5, cfg: c }), { action: 'none', reason: 'unknown' });
  assert.equal(decideSpawn({ level: 'green', agentType: 'Explore', eff: null, active: 5, cfg: c }).action, 'deny');
});

test('forecast: without resets_at only the latest reading counts', () => {
  const s = [{ t: NOW - 24 * 3600000, f: { u: 97, r: null } }, { t: NOW, f: { u: 10, r: null } }];
  const w = analyzeWindow(s, 'fiveHour', NOW, cfg);
  assert.equal(w.status, 'ok');
  assert.equal(w.used, 10);
  assert.equal(w.projected, null);
});

test('forecast: a reset further ahead than one window is ignored, so no pause', () => {
  const s = [{ t: NOW, f: { u: 50, r: 1e17 } }];
  assert.equal(analyzeWindow(s, 'fiveHour', NOW, cfg).status, 'nodata');
  assert.equal(windowWait('fiveHour', s, NOW, cfg).waitSec, 0);
  // Exactly one window ahead (fresh window) is fine.
  const fresh = [{ t: NOW, f: { u: 1, r: Math.round(NOW / 1000) + 300 * 60 } }];
  assert.equal(analyzeWindow(fresh, 'fiveHour', NOW, cfg).status, 'ok');
});

test('throttle: the rounded pause never exceeds maxWaitSec', () => {
  const c = { ...cfg, throttle: { ...cfg.throttle, maxWaitSec: 1.55 } };
  const s = linearSeries({ now: NOW, resetInMin: 150, startUsed: 57, rate: 0.1, minutes: 30 });
  const w = windowWait('fiveHour', s, NOW, c);
  assert.equal(w.status, 'ahead');
  assert.ok(w.waitSec <= 1.55, `waitSec ${w.waitSec}`);
});

test('config: reserve + buffer leaving almost no schedule falls back to the default buffer', () => {
  const r = validate(deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), { windows: { fiveHour: { reservePct: 50 } }, throttle: { bufferPct: 50 } }));
  assert.equal(r.config.throttle.bufferPct, DEFAULTS.throttle.bufferPct);
  assert.deepEqual(r.errors, ['throttle.bufferPct']);
  assert.equal(r.config.windows.fiveHour.reservePct, 50);
});

test('STOP deny reason names the window that is at STOP', () => {
  const ev = {
    level: 'stop',
    windows: { fiveHour: { status: 'ok', used: 20, level: 'green' }, sevenDay: { status: 'ok', used: 98, level: 'stop' } },
  };
  const t = denyReason({ action: 'deny', reason: 'stop' }, ev, 0);
  assert.match(t, /reserve is reached \(weekly window, 98% used\)/);
  assert.doesNotMatch(t, /20%/);
});

// ---- throttle hook ----

function throttleEnv(config = {}) {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(e.home, linearSeries({ now: NOW, resetInMin: 150, startUsed: 57, rate: 0.1, minutes: 30 })); // 60 % at half time
  writeJson(path.join(e.home, 'config.json'), { throttle: { ...DEFAULTS.throttle, ...NO_ESC, maxWaitSec: 1.5 }, ...config });
  return e;
}

const call = (over = {}) => ({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x' }, ...over });

test('throttle: the tool calls of one API response share one pause', () => {
  const e = throttleEnv();
  const file = writeTranscript(path.join(e.base, 'main.jsonl'), [
    userLine(),
    assistantLine('claude-opus-5-5', 'toolu_a', { message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Edit', input: {} }] } }),
    assistantLine('claude-opus-5-5', 'toolu_b', { message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Edit', input: {} }] } }),
    assistantLine('claude-opus-5-5', 'toolu_c', { message: { id: 'msg_2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_c', name: 'Edit', input: {} }] } }),
  ]);
  const a = runHook('throttle', call({ transcript_path: file, tool_use_id: 'toolu_a' }), e.env);
  assert.ok(a.ms >= 1450, `first call of the response took ${a.ms} ms`);
  const b = runHook('throttle', call({ transcript_path: file, tool_use_id: 'toolu_b' }), e.env);
  assert.ok(b.ms < 1200, `second call of the same response took ${b.ms} ms`);
  const c = runHook('throttle', call({ transcript_path: file, tool_use_id: 'toolu_c' }), e.env);
  assert.ok(c.ms >= 1450, `first call of the next response took ${c.ms} ms`);
  assert.equal(readLog(e.home, 'throttle').length, 2);
  const skip = readLog(e.home, 'throttle-skip');
  assert.equal(skip.length, 1);
  assert.equal(skip[0].reason, 'response-budget-used');
});

// Found by the E2E (2 parallel Agent calls, one subagent started without a pause):
// Claude Code runs parallel calls (e.g. Agent fan-out) at the same time, so every call
// of the response has to wait until the shared pause is over, not just the first one.
test('throttle: parallel calls of one response all wait for the shared pause', async () => {
  const e = throttleEnv();
  const msg = (id) => assistantLine('claude-opus-5-5', id, { message: { id: 'msg_par', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] } });
  const file = writeTranscript(path.join(e.base, 'par.jsonl'), [userLine(), msg('toolu_p1'), msg('toolu_p2'), msg('toolu_p3')]);
  const t0 = Date.now();
  const runs = await Promise.all(['toolu_p1', 'toolu_p2', 'toolu_p3'].map((id) => runHookAsync('throttle', call({ tool_name: 'Agent', transcript_path: file, tool_use_id: id }), e.env)));
  const ends = runs.map((r) => r.ms);
  assert.ok(ends.every((ms) => ms >= 1300), `parallel calls took ${ends.join(', ')} ms`);
  assert.ok(Date.now() - t0 < 2900, 'one shared pause, not one pause per call');
  const logged = readLog(e.home, 'throttle');
  assert.equal(logged.length, 3);
  assert.equal(logged.filter((l) => l.planned === undefined).length, 1, 'the call that opened the pause logs it in full');
  assert.equal(readLog(e.home, 'throttle-skip').length, 0);
});

test('throttle: calls inside a subagent use the subagent transcript for the budget', () => {
  const e = throttleEnv();
  const main = writeTranscript(path.join(e.base, 'proj', 's1.jsonl'), [userLine()]);
  const line = (id) => assistantLine('claude-haiku-4-5-20251001', id, {
    isSidechain: true, message: { id: 'msg_sub', role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
  });
  writeTranscript(path.join(e.base, 'proj', 's1', 'subagents', 'agent-abc123.jsonl'), [line('toolu_s1'), line('toolu_s2')]);
  const sub = { transcript_path: main, agent_id: 'abc123', agent_type: 'Explore', tool_name: 'Read' };
  assert.ok(runHook('throttle', call({ ...sub, tool_use_id: 'toolu_s1' }), e.env).ms >= 1450);
  assert.ok(runHook('throttle', call({ ...sub, tool_use_id: 'toolu_s2' }), e.env).ms < 1200);
});

test('throttle: strategy both does not pause Agent calls the downgrade handles (RED), but other tools', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(e.home, RED());
  writeJson(path.join(e.home, 'config.json'), { strategy: 'both', throttle: { ...DEFAULTS.throttle, ...NO_ESC, maxWaitSec: 1.5 } });
  const agent = runHook('throttle', call({ tool_name: 'Agent', tool_input: { prompt: 'p', description: 'd' } }), e.env);
  assert.ok(agent.ms < 1200, `Agent call took ${agent.ms} ms`);
  assert.equal(readLog(e.home, 'throttle-skip')[0].reason, 'agent-call-downgrade');
  assert.ok(runHook('throttle', call({ tool_name: 'Bash' }), e.env).ms >= 1450);
});

test('hooks.json: the throttle hook timeout leaves room above the largest allowed pause', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const entry = hooks.PreToolUse.find((h) => h.hooks.some((x) => x.args && x.args.includes('throttle')));
  assert.equal(entry.matcher, '*');
  const timeout = entry.hooks[0].timeout;
  const bad = validate(deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), { throttle: { maxWaitSec: 240 } }));
  assert.deepEqual(bad.errors, []);
  assert.ok(timeout >= 240 + 30, `timeout ${timeout} s vs maxWaitSec up to 240 s`);
});

// ---- transcript ----

test('transcript: a file that appears shortly after the hook started is still read', () => {
  const e = makeEnv();
  const file = path.join(e.base, 'late.jsonl');
  const lines = `${userLine()}\n${assistantLine('claude-sonnet-5-5', 'toolu_late')}\n`;
  const child = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(lines)}), 120)`]);
  try {
    assert.equal(toolUseModel(file, 'toolu_late', { timeoutMs: 1500 }), 'claude-sonnet-5-5');
  } finally {
    child.kill();
  }
  const t0 = Date.now();
  assert.equal(toolUseModel(path.join(e.base, 'never.jsonl'), 'toolu_x', { timeoutMs: 1500 }), null);
  assert.ok(Date.now() - t0 < 1000, 'a file that never appears is not awaited for the whole budget');
});

// ---- status, install, status line ----

test('status: enabled false shows the throttle as off', () => {
  const e = throttleEnv({ enabled: false });
  const r = runScript('pacer.js', ['status'], '', e.env);
  assert.match(r.stdout, /Drossel: aus \(enabled: false\)/);
  const j = JSON.parse(runScript('pacer.js', ['status', '--json'], '', e.env).stdout);
  assert.equal(j.throttle.waitSec, 0);
});

test('install keeps the mode of settings.json, writes backups 0600 and writes through a symlink', { skip: process.platform === 'win32' }, () => {
  const e = makeEnv();
  const settings = path.join(e.claude, 'settings.json');
  writeJson(settings, { env: { ANTHROPIC_AUTH_TOKEN: 'fake' } });
  fs.chmodSync(settings, 0o600);
  assert.equal(runScript('pacer.js', ['install'], '', e.env).code, 0);
  assert.equal(fs.statSync(settings).mode & 0o777, 0o600);
  for (const b of fs.readdirSync(path.join(e.home, 'backups'))) assert.equal(fs.statSync(path.join(e.home, 'backups', b)).mode & 0o777, 0o600);

  const l = makeEnv();
  const real = path.join(l.base, 'dotfiles', 'settings.json');
  writeJson(real, {});
  fs.symlinkSync(real, path.join(l.claude, 'settings.json'));
  assert.equal(runScript('pacer.js', ['install'], '', l.env).code, 0);
  assert.ok(fs.lstatSync(path.join(l.claude, 'settings.json')).isSymbolicLink());
  assert.match(JSON.parse(fs.readFileSync(real, 'utf8')).statusLine.command, /statusline\.js/);
});

test('status line: chaining another copy of the sensor does not recurse', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  const self = `node "${path.join(ROOT, 'scripts', 'statusline.js')}"`;
  writeJson(path.join(e.home, 'config.json'), { chain: { type: 'command', command: self } });
  const payload = { session_id: 'x', model: { id: 'claude-opus-5-5' }, rate_limits: { five_hour: { used_percentage: 10, resets_at: Math.round(NOW / 1000) + 3600 } } };
  const r = runScript('statusline.js', [], payload, e.env);
  assert.equal(r.code, 0);
  assert.ok(r.ms < 3000, `took ${r.ms} ms`);
  assert.equal((r.stdout.match(/pacing /g) || []).length, 1, r.stdout);
  // Plugin-cache and repository copies count as ours, so install does not chain them.
  const { isOurs } = require('../scripts/lib/install');
  assert.equal(isOurs({ command: 'node "/Users/u/.claude/plugins/cache/ari-auto-pacing/quota-pacer/1.1.0/scripts/statusline.js"' }), true);
  assert.equal(isOurs({ command: self }), true);
  assert.equal(isOurs({ command: 'bash ~/bin/my-statusline.sh' }), false);
});
