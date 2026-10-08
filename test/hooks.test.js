'use strict';
// Runs hook.js exactly as Claude Code does: a separate process, JSON on stdin,
// at most one JSON object on stdout, exit code 0. These tests cover the 1.0.0 downgrade
// behaviour, so every config pins strategy "downgrade" (the default is "throttle").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  makeEnv, writeJson, runHook, runHookAsync, seedSamples, linearSeries, preAgentInput, assistantLine, userLine, writeTranscript, readLog,
} = require('./helpers');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

// Level presets built from realistic sample series.
const LEVELS = {
  green: () => linearSeries({ now: NOW, resetInMin: 240, startUsed: 2, rate: 0.05, minutes: 30 }),
  amber: () => linearSeries({ now: NOW, resetInMin: 240, startUsed: 20, rate: 0.3, minutes: 30 }),
  red: () => linearSeries({ now: NOW, resetInMin: 150, startUsed: 40, rate: 0.6, minutes: 30 }),
  stop: () => linearSeries({ now: NOW, resetInMin: 60, startUsed: 80, rate: 0.6, minutes: 30 }),
};

function setConfig(e, config = {}) {
  writeJson(path.join(e.home, 'config.json'), { strategy: 'downgrade', ...config });
}

function envAt(level, extra = {}) {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW), ...extra });
  if (level) seedSamples(e.home, LEVELS[level]());
  setConfig(e);
  return e;
}

function defineAgent(e, name, model) {
  const dir = path.join(e.project, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: test agent\n${model ? `model: ${model}\n` : ''}---\nbody`);
}

// Input whose transcript already holds the line of this tool call, issued by `mainModel`.
function withMainModel(e, mainModel, over = {}) {
  const input = preAgentInput({ cwd: e.project, ...over });
  input.transcript_path = writeTranscript(path.join(e.base, `t-${input.tool_use_id}.jsonl`), [userLine(), assistantLine(mainModel, input.tool_use_id)]);
  return input;
}

function assertSchema(json, eventName) {
  assert.ok(json && typeof json === 'object', 'stdout must be one JSON object');
  if (json.hookSpecificOutput) assert.equal(json.hookSpecificOutput.hookEventName, eventName);
}

test('presets produce the intended level', () => {
  for (const level of Object.keys(LEVELS)) {
    const e = envAt(level);
    const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pacer.js'), 'status', '--json'], { env: e.env, encoding: 'utf8' });
    assert.equal(JSON.parse(r.stdout).level, level, `preset ${level}`);
  }
});

test('GREEN: Agent call passes untouched, reservation recorded', () => {
  const e = envAt('green');
  const r = runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
  assert.equal(fs.readdirSync(path.join(e.home, 'sessions', 'sess-1', 'reservations')).length, 1);
});

test('AMBER: Explore is rewritten to haiku with all original fields kept', () => {
  const e = envAt('amber');
  const input = preAgentInput({ cwd: e.project });
  const r = runHook('pre-agent', input, e.env);
  assert.equal(r.code, 0);
  assertSchema(r.json, 'PreToolUse');
  const o = r.json.hookSpecificOutput;
  assert.equal(o.permissionDecision, 'allow');
  assert.deepEqual(o.updatedInput, { ...input.tool_input, model: 'haiku' });
  assert.match(o.permissionDecisionReason, /AMBER/);
});

test('AMBER: custom agent goes to sonnet; explicit opus request is downgraded', () => {
  const e = envAt('amber');
  defineAgent(e, 'impl');
  const r1 = runHook('pre-agent', withMainModel(e, 'claude-opus-5-5', { tool_input: { prompt: 'x', description: 'y', subagent_type: 'impl' } }), e.env);
  assert.equal(r1.json.hookSpecificOutput.updatedInput.model, 'sonnet');
  const r2 = runHook('pre-agent', preAgentInput({ cwd: e.project, tool_input: { prompt: 'x', description: 'y', subagent_type: 'impl', model: 'opus' } }), e.env);
  assert.equal(r2.json.hookSpecificOutput.updatedInput.model, 'sonnet');
});

test('AMBER: never upgrades a haiku-pinned agent or a session already on haiku', () => {
  const e = envAt('amber');
  defineAgent(e, 'cheap', 'haiku');
  defineAgent(e, 'impl');
  const r1 = runHook('pre-agent', withMainModel(e, 'claude-opus-5-5', { tool_input: { prompt: 'x', description: 'y', subagent_type: 'cheap' } }), e.env);
  assert.equal(r1.stdout.trim(), '');
  runHook('model-switch', { session_id: 'sess-2', hook_event_name: 'PostModelSwitch', from_model: 'claude-opus-5-5', to_model: 'claude-haiku-4-5-20251001' }, e.env);
  const r2 = runHook('pre-agent', preAgentInput({ session_id: 'sess-2', cwd: e.project, tool_input: { prompt: 'x', description: 'y', subagent_type: 'impl' } }), e.env);
  assert.equal(r2.stdout.trim(), '');
  const d = readLog(e.home, 'pre-agent').filter((l) => l.session === 'sess-2');
  assert.deepEqual(d.map((l) => [l.action, l.effective, l.effectiveSource]), [['none', 'claude-haiku-4-5-20251001', 'main/session']]);
});

test('RED: one running subagent blocks the next spawn with a reason', () => {
  const e = envAt('red');
  runHook('subagent-start', { session_id: 'sess-1', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, e.env);
  const r = runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  assertSchema(r.json, 'PreToolUse');
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /limit at this level is 1/);
  runHook('subagent-stop', { session_id: 'sess-1', hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore' }, e.env);
  const r2 = runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  assert.equal(r2.json.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(r2.json.hookSpecificOutput.updatedInput.model, 'haiku');
});

test('STOP: every new spawn is denied, including forks', () => {
  const e = envAt('stop');
  for (const t of ['Explore', 'fork', 'impl']) {
    const r = runHook('pre-agent', preAgentInput({ cwd: e.project, tool_input: { prompt: 'x', description: 'y', subagent_type: t } }), e.env);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny', t);
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /reserve is reached/);
  }
});

test('AMBER: a burst of 5 parallel spawns admits exactly 3', async () => {
  const e = envAt('amber');
  const runs = await Promise.all(Array.from({ length: 5 }, () => runHookAsync('pre-agent', preAgentInput({ cwd: e.project }), e.env)));
  const decisions = runs.map((r) => (r.json ? r.json.hookSpecificOutput.permissionDecision : 'none'));
  assert.equal(decisions.filter((d) => d === 'allow').length, 3, decisions.join(','));
  assert.equal(decisions.filter((d) => d === 'deny').length, 2, decisions.join(','));
});

test('reservations are consumed by SubagentStart and do not double count', () => {
  const e = envAt('amber');
  for (let i = 0; i < 2; i++) runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  runHook('subagent-start', { session_id: 'sess-1', agent_id: 'a1', agent_type: 'Explore' }, e.env);
  runHook('subagent-start', { session_id: 'sess-1', agent_id: 'a2', agent_type: 'Explore' }, e.env);
  const dir = path.join(e.home, 'sessions', 'sess-1');
  assert.equal(fs.readdirSync(path.join(dir, 'reservations')).length, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'agents')).length, 2);
  const r = runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'allow'); // 2 running < 3
});

test('deny or ask rules for the Agent tool are never overridden', () => {
  for (const [file, rule] of [['user', 'Agent(Explore)'], ['project', 'Agent'], ['managed', 'Task(Explore)']]) {
    const e = envAt('amber');
    const target = { user: path.join(e.claude, 'settings.json'), project: path.join(e.project, '.claude', 'settings.json'), managed: e.env.QUOTA_PACER_MANAGED_SETTINGS }[file];
    writeJson(target, { permissions: { [file === 'project' ? 'ask' : 'deny']: [rule] } });
    const r = runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
    assert.equal(r.stdout.trim(), '', `${file} ${rule}`);
  }
  const e = envAt('amber');
  writeJson(path.join(e.claude, 'settings.json'), { permissions: { deny: ['Agent(Plan)', 'Bash(rm *)'] } });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env).json.hookSpecificOutput.updatedInput.model, 'haiku');
});

test('CLAUDE_CODE_SUBAGENT_MODEL_FORCE disables model changes but keeps the cap', async () => {
  const e = envAt('amber', { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  const r = runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  assert.equal(r.stdout.trim(), '');
  for (let i = 0; i < 3; i++) runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env).json.hookSpecificOutput.permissionDecision, 'deny');
});

test('fail-open: garbage, empty, wrong tool, missing fields, stale data, disabled', () => {
  const e = envAt('amber');
  for (const input of ['', 'not json', '[]', 'null', '{"tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"s"}',
    '{"tool_name":"Agent","session_id":"s"}', '{"tool_name":"Agent","tool_input":"x","session_id":"s"}']) {
    const r = runHook('pre-agent', input, e.env);
    assert.equal(r.code, 0, input);
    assert.equal(r.stdout.trim(), '', input);
  }
  const unknownMode = runHook('nope', preAgentInput(), e.env);
  assert.equal(unknownMode.code, 0);
  // Stale: still inside the RED window (reset at +150 min), but the newest sample is
  // 25 min old (> maxSampleAgeMinutes 20). Even a GREEN cap of 0 must not apply then.
  const stale = makeEnv({ QUOTA_PACER_NOW: String(NOW + 25 * 60000) });
  seedSamples(stale.home, LEVELS.red());
  setConfig(stale, { concurrency: { green: 0, amber: 3, red: 1, stop: 0 } });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: stale.project }), stale.env).stdout.trim(), '');
  const staleLog = readLog(stale.home, 'pre-agent');
  assert.equal(staleLog.length, 1);
  assert.equal(staleLog[0].level, 'unknown');
  assert.equal(staleLog[0].action, 'none');
  assert.equal(staleLog[0].reason, 'unknown');
  const off = envAt('red');
  setConfig(off, { enabled: false });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: off.project }), off.env).stdout.trim(), '');
});

test('fail-open: unwritable data directory still exits 0', { skip: process.getuid && process.getuid() === 0 ? 'root ignores permissions' : false }, () => {
  const e = envAt('amber');
  fs.chmodSync(e.home, 0o500);
  const r = runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  fs.chmodSync(e.home, 0o700);
  assert.equal(r.code, 0);
});

test('UserPromptSubmit: context every turn, notice only on level change', () => {
  const e = envAt('amber');
  const p = { session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: e.project };
  const r1 = runHook('prompt', p, e.env);
  assertSchema(r1.json, 'UserPromptSubmit');
  assert.match(r1.json.hookSpecificOutput.additionalContext, /Usage pacing level AMBER/);
  assert.match(r1.json.systemMessage, /Stufe GELB/);
  const r2 = runHook('prompt', p, e.env);
  assert.ok(r2.json.hookSpecificOutput.additionalContext);
  assert.equal(r2.json.systemMessage, undefined);
  seedSamples(e.home, LEVELS.green());
  fs.rmSync(path.join(e.home, 'level.json'));
  const r3 = runHook('prompt', p, e.env);
  assert.match(r3.json.systemMessage, /Stufe GRÜN/);
  assert.equal(r3.json.hookSpecificOutput, undefined);
  assert.equal(runHook('prompt', p, e.env).stdout.trim(), '');
});

test('UserPromptSubmit: english texts on request, nothing in GREEN', () => {
  const e = envAt('red');
  setConfig(e, { language: 'en' });
  const r = runHook('prompt', { session_id: 's', prompt: 'x' }, e.env);
  assert.match(r.json.systemMessage, /level RED/);
  assert.equal(runHook('prompt', { session_id: 's', prompt: 'x' }, envAt('green').env).stdout.trim(), '');
});

test('SessionStart: records model, reminds once per day, syncs scripts', () => {
  const e = envAt('green', { CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') });
  const r1 = runHook('session-start', { session_id: 'sess-9', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' }, e.env);
  assert.match(r1.json.systemMessage, /quota-pacer:setup/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.home, 'sessions', 'sess-9', 'model.json'))).model, 'claude-opus-5-5');
  assert.ok(fs.existsSync(path.join(e.home, 'bin', 'statusline.js')));
  assert.equal(fs.readFileSync(path.join(e.home, 'bin', 'VERSION'), 'utf8').trim(), require('../package.json').version);
  const r2 = runHook('session-start', { session_id: 'sess-9', source: 'startup' }, e.env);
  assert.equal(r2.stdout.trim(), '');
});

test('SessionStart: warns about FORCE and broken config', () => {
  const e = envAt('green', { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  setConfig(e, { hysteresisPct: 'viel' });
  const r = runHook('session-start', { session_id: 's', source: 'startup' }, e.env);
  assert.match(r.json.systemMessage, /SUBAGENT_MODEL_FORCE/);
  assert.match(r.json.systemMessage, /hysteresisPct/);
});

test('SessionEnd removes the session state', () => {
  const e = envAt('amber');
  runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  assert.ok(fs.existsSync(path.join(e.home, 'sessions', 'sess-1')));
  runHook('session-end', { session_id: 'sess-1', hook_event_name: 'SessionEnd', reason: 'other' }, e.env);
  assert.ok(!fs.existsSync(path.join(e.home, 'sessions', 'sess-1')));
});

test('every decision is written to the audit log', () => {
  const e = envAt('amber');
  runHook('pre-agent', withMainModel(e, 'claude-opus-5-5'), e.env);
  const lines = readLog(e.home, 'pre-agent');
  assert.equal(lines.length, 1);
  const d = lines[0];
  assert.equal(d.action, 'rewrite');
  assert.equal(d.model, 'haiku');
  assert.equal(d.level, 'amber');
  assert.equal(d.permissionMode, 'default');
  assert.equal(d.effective, 'claude-opus-5-5');
  assert.equal(d.effectiveSource, 'builtin-main/transcript');
  for (const k of ['ts', 'kind', 'session', 'agentType', 'cls', 'level', 'active', 'effective', 'effectiveSource', 'permissionMode', 'action', 'model', 'reason']) {
    assert.ok(k in d, `missing ${k}`);
  }
  assert.ok(!JSON.stringify(lines).includes('Find all usages'), 'prompts are never logged');
});
