'use strict';
// 1.1.0: strategy routing (throttle | downgrade | both), validation of the new config
// fields, the forecast warm-up (minForecastMinutes), throttle notices, the status line
// segment "Drossel Ns", `pacer.js status` and the installer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DEFAULTS, validate, deepMerge } = require('../scripts/lib/config');
const { analyzeWindow } = require('../scripts/lib/forecast');
const { windowLevel } = require('../scripts/lib/policy');
const {
  makeEnv, writeJson, runHook, runHookAsync, runScript, seedSamples, linearSeries, preAgentInput, readLog,
} = require('./helpers');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
const clone = (v) => JSON.parse(JSON.stringify(v));

const SERIES = {
  amber: () => linearSeries({ now: NOW, resetInMin: 240, startUsed: 20, rate: 0.3, minutes: 30 }),
  red: () => linearSeries({ now: NOW, resetInMin: 150, startUsed: 40, rate: 0.6, minutes: 30 }),
  stop: () => linearSeries({ now: NOW, resetInMin: 60, startUsed: 80, rate: 0.6, minutes: 30 }),
  // 60 % used at mid-window: 10 points ahead of the 50 % schedule, projected 120 % -> RED.
  redAhead: () => linearSeries({ now: NOW, resetInMin: 150, startUsed: 48, rate: 0.4, minutes: 30 }),
  // 5-h window that resets in `resetInMin`, usage `used` reached by a steady climb.
  at: (used, resetInMin) => linearSeries({ now: NOW, resetInMin, startUsed: Math.max(0, used - 3), rate: 0.1, minutes: 30 }),
  // Burst right at the start of a window: 12 min in, 10 min of samples at 1.1 %/min.
  burst: () => linearSeries({ now: NOW, resetInMin: 288, startUsed: 1, rate: 1.1, minutes: 10 }),
};

// Escalation off unless a test sets it: these tests are about the plain pause and the
// strategies (see escalation.test.js).
const NO_ESC = { escalateLeadPct: 100, haltLeadPct: 100 };
function envWith(samples, config = {}) {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(e.home, samples);
  writeJson(path.join(e.home, 'config.json'), { ...config, throttle: { ...NO_ESC, ...(config.throttle || {}) } });
  return e;
}

const toolCall = (over = {}) => ({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 't1', ...over });
const prompt = (sid = 's1') => ({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'x' });

test('config: defaults of the 1.1.0 fields', () => {
  assert.equal(DEFAULTS.strategy, 'throttle');
  assert.deepEqual(DEFAULTS.throttle, {
    bufferPct: 10, earlySlackPct: 15, releaseFraction: 0.1, maxWaitSec: 90, minWaitSec: 2, weeklyDeadbandPct: 1, weeklyRampPct: 3,
    escalateLeadPct: 5, haltLeadPct: 12, escalatedMaxWaitSec: 240, escalatedAgentCap: 1,
  });
  assert.equal(DEFAULTS.minForecastMinutes, 15);
  assert.deepEqual(validate(clone(DEFAULTS)).errors, []);
});

test('config: strategy, throttle and minForecastMinutes are validated field by field', () => {
  const check = (over) => validate(deepMerge(clone(DEFAULTS), over));
  for (const bad of ['turbo', '', null, 1]) {
    const r = check({ strategy: bad });
    assert.equal(r.config.strategy, 'throttle', String(bad));
    assert.deepEqual(r.errors, ['strategy']);
  }
  for (const s of ['throttle', 'downgrade', 'both']) assert.equal(check({ strategy: s }).config.strategy, s);
  const bad = check({ throttle: { bufferPct: 60, earlySlackPct: 'x', releaseFraction: 1.5, maxWaitSec: 241, minWaitSec: -1 } });
  assert.deepEqual(bad.config.throttle, DEFAULTS.throttle);
  assert.deepEqual(bad.errors.sort(), ['throttle.bufferPct', 'throttle.earlySlackPct', 'throttle.maxWaitSec', 'throttle.minWaitSec', 'throttle.releaseFraction']);
  // One bad field keeps the others the user set.
  const one = check({ throttle: { maxWaitSec: 1000, bufferPct: 5 } });
  assert.equal(one.config.throttle.maxWaitSec, 90);
  assert.equal(one.config.throttle.bufferPct, 5);
  assert.deepEqual(one.errors, ['throttle.maxWaitSec']);
  for (const edge of [{ maxWaitSec: 0 }, { maxWaitSec: 240 }, { minWaitSec: 0 }, { minWaitSec: 60 }, { bufferPct: 0 }, { bufferPct: 50 },
    { earlySlackPct: 0 }, { earlySlackPct: 100 }, { releaseFraction: 0 }, { releaseFraction: 1 }, { maxWaitSec: 1.5 }]) {
    assert.deepEqual(check({ throttle: edge }).errors, [], JSON.stringify(edge));
  }
  const notObject = check({ throttle: 'slow' });
  assert.deepEqual(notObject.config.throttle, DEFAULTS.throttle);
  assert.deepEqual(notObject.errors, ['throttle']);
  for (const v of [-1, 301, '15', null]) {
    const r = check({ minForecastMinutes: v });
    assert.equal(r.config.minForecastMinutes, 15, String(v));
    assert.deepEqual(r.errors, ['minForecastMinutes']);
  }
  for (const v of [0, 5, 300]) assert.equal(check({ minForecastMinutes: v }).config.minForecastMinutes, v);
});

test('config: invalid new fields are reported by SessionStart and status, and fall back to the defaults', () => {
  const e = envWith(SERIES.at(60, 150), { strategy: 'turbo', throttle: { maxWaitSec: 999 } });
  const r = runHook('session-start', { session_id: 's', source: 'startup' }, e.env);
  assert.match(r.json.systemMessage, /ungültige Felder auf Standard gesetzt: strategy, throttle\.maxWaitSec/);
  const st = runScript('pacer.js', ['status'], '', e.env);
  assert.match(st.stdout, /Strategie: throttle/);
  assert.match(st.stdout, /config\.json: ungültige Felder auf Standard gesetzt: strategy, throttle\.maxWaitSec/);
  assert.match(st.stdout, /höchstens 90 s je Pause/);
});

test('minForecastMinutes: a burst at the start of a window is judged by usage only', () => {
  const cfg = clone(DEFAULTS);
  const w = analyzeWindow(SERIES.burst(), 'fiveHour', NOW, cfg);
  assert.equal(w.status, 'ok');
  assert.equal(Math.round(w.used), 12);
  assert.equal(w.spanMin, 10);
  assert.equal(w.projected, null);
  assert.equal(w.minutesToReserve, null);
  assert.equal(w.rateSource, 'warmup');
  assert.equal(windowLevel(w, cfg.windows.fiveHour, 'green', cfg.hysteresisPct), 'green');
  // Without the warm-up the same burst projects far beyond the reserve: RED.
  const w0 = analyzeWindow(SERIES.burst(), 'fiveHour', NOW, { ...cfg, minForecastMinutes: 5 });
  assert.ok(w0.projected > 200, `projected ${w0.projected}`);
  assert.equal(windowLevel(w0, cfg.windows.fiveHour, 'green', cfg.hysteresisPct), 'red');
  // Usage thresholds still apply during the warm-up.
  const hot = analyzeWindow(linearSeries({ now: NOW, resetInMin: 288, startUsed: 80, rate: 0.5, minutes: 10 }), 'fiveHour', NOW, cfg);
  assert.equal(hot.projected, null);
  assert.equal(windowLevel(hot, cfg.windows.fiveHour, 'green', cfg.hysteresisPct), 'red');
  // Once the samples span 15 minutes the projection counts.
  const later = analyzeWindow(linearSeries({ now: NOW, resetInMin: 283, startUsed: 1, rate: 1.1, minutes: 15 }), 'fiveHour', NOW, cfg);
  assert.ok(later.projected > 200);
  // The weekly window has the same warm-up.
  const r7 = Math.round((NOW + 3 * 86400000) / 1000);
  const wk = analyzeWindow([{ t: NOW - 5 * 60000, s: { u: 50, r: r7 } }, { t: NOW, s: { u: 51, r: r7 } }], 'sevenDay', NOW, cfg);
  assert.equal(wk.rateSource, 'warmup');
  assert.equal(wk.projected, null);
});

test('minForecastMinutes: hooks, status line and status follow the warm-up', () => {
  const e = envWith(SERIES.burst(), { strategy: 'downgrade' });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env).stdout.trim(), '');
  assert.equal(readLog(e.home, 'pre-agent')[0].level, 'green');
  const sl = strip(runScript('statusline.js', [], { session_id: 'x' }, e.env).stdout).trim();
  assert.equal(sl, 'pacing GRÜN 5h 12%');
  assert.match(runScript('pacer.js', ['status'], '', e.env).stdout, /noch keine Prognose \(Anlaufphase: 10 von 15 min Messdaten\)/);
  writeJson(path.join(e.home, 'config.json'), { strategy: 'downgrade', minForecastMinutes: 5 });
  fs.rmSync(path.join(e.home, 'level.json'), { force: true });
  // A new session: the first spawn still holds a reservation, and the RED cap is 1.
  const r = runHook('pre-agent', preAgentInput({ session_id: 'sess-2', cwd: e.project }), e.env);
  assert.equal(r.json.hookSpecificOutput.updatedInput.model, 'haiku');
  assert.equal(readLog(e.home, 'pre-agent')[1].level, 'red');
});

test('strategy throttle (default): no model change, no cap, no context at any level', () => {
  for (const level of ['amber', 'red', 'stop']) {
    const e = envWith(SERIES[level]());
    runHook('subagent-start', { session_id: 'sess-1', agent_id: 'a1', agent_type: 'Explore' }, e.env);
    runHook('subagent-start', { session_id: 'sess-1', agent_id: 'a2', agent_type: 'Explore' }, e.env);
    for (let i = 0; i < 3; i++) {
      const r = runHook('pre-agent', preAgentInput({ cwd: e.project, permission_mode: i === 2 ? 'auto' : 'default' }), e.env);
      assert.equal(r.code, 0);
      assert.equal(r.stdout.trim(), '', `${level} spawn ${i}`);
    }
    assert.equal(runHook('prompt', prompt('sess-1'), e.env).stdout.trim(), '', level);
    const lines = readLog(e.home, 'pre-agent');
    assert.deepEqual(lines.map((l) => `${l.level}:${l.action}:${l.reason}`), Array(3).fill(`${level}:none:strategy-throttle`));
    assert.ok(!fs.existsSync(path.join(e.home, 'sessions', 'sess-1', 'reservations')), 'no reservations: the cap does not apply');
    assert.equal(readLog(e.home, 'prompt').length, 0);
  }
});

test('strategy both: below RED only the throttle acts; from RED on models, caps and context', () => {
  const amber = envWith(SERIES.amber(), { strategy: 'both' });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: amber.project }), amber.env).stdout.trim(), '');
  assert.equal(readLog(amber.home, 'pre-agent')[0].reason, 'strategy-both');
  assert.equal(runHook('prompt', prompt(), amber.env).stdout.trim(), '');

  const red = envWith(SERIES.red(), { strategy: 'both' });
  const p = runHook('prompt', prompt(), red.env);
  assert.match(p.json.hookSpecificOutput.additionalContext, /^Usage pacing level RED: .*Short pauses between steps/);
  assert.match(p.json.systemMessage, /^quota-pacer: Stufe ROT .*Subagents laufen jetzt zusätzlich auf dem kleinsten Modell, einzeln/);
  const r1 = runHook('pre-agent', preAgentInput({ cwd: red.project }), red.env);
  assert.equal(r1.json.hookSpecificOutput.updatedInput.model, 'haiku');
  const r2 = runHook('pre-agent', preAgentInput({ cwd: red.project }), red.env);
  assert.equal(r2.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r2.json.hookSpecificOutput.permissionDecisionReason, /limit at this level is 1/);
  // Back below RED: the downgrade stops, which is worth one notice.
  seedSamples(red.home, SERIES.amber());
  fs.rmSync(path.join(red.home, 'level.json'));
  const back = runHook('prompt', prompt(), red.env);
  assert.match(back.json.systemMessage, /Stufe GELB .*Subagents laufen wieder normal; die Drossel bremst weiter/);
  assert.equal(back.json.hookSpecificOutput, undefined);
  assert.equal(runHook('prompt', prompt(), red.env).stdout.trim(), '');
});

test('strategy both and downgrade: the throttle hook pauses only with both', () => {
  const both = envWith(SERIES.at(60, 150), { strategy: 'both', throttle: { maxWaitSec: 0.3 } });
  const r = runHook('throttle', toolCall(), both.env);
  assert.ok(r.ms >= 300, `took ${r.ms} ms`);
  assert.match(r.json.systemMessage, /Drossel aktiv – Pausen bis 0\.3 s/);
  const down = envWith(SERIES.at(60, 150), { strategy: 'downgrade', throttle: { maxWaitSec: 0.3 } });
  assert.equal(runHook('throttle', toolCall(), down.env).stdout.trim(), '');
  assert.equal(readLog(down.home, 'throttle').length, 0);
});

test('throttle hook: any tool, never a permission decision, log without content', () => {
  const e = envWith(SERIES.at(60, 150), { throttle: { maxWaitSec: 0.3 } });
  for (const [i, tool] of ['Bash', 'Agent', 'mcp__srv__tool'].entries()) {
    const r = runHook('throttle', toolCall({ session_id: `s${i}`, tool_name: tool, tool_input: { command: 'secret-command' } }), e.env);
    assert.equal(r.code, 0);
    assert.ok(r.ms >= 300, `${tool}: ${r.ms} ms`);
    assert.deepEqual(Object.keys(r.json), ['systemMessage'], tool);
  }
  const log = readLog(e.home, 'throttle');
  assert.deepEqual(log.map((l) => l.tool), ['Bash', 'Agent', 'mcp__srv__tool']);
  assert.deepEqual(Object.keys(log[0]).sort(), ['allowed', 'kind', 'session', 'tool', 'ts', 'used', 'waitSec', 'window']);
  assert.deepEqual([log[0].waitSec, log[0].window, log[0].used, log[0].allowed], [0.3, 'fiveHour', 60, 50]);
  assert.ok(!fs.readFileSync(path.join(e.home, 'decisions.jsonl'), 'utf8').includes('secret-command'));
  // Without a session or a tool name there is nothing to pace.
  assert.equal(runHook('throttle', { tool_name: 'Read' }, e.env).stdout.trim(), '');
  assert.equal(runHook('throttle', { session_id: 's9' }, e.env).stdout.trim(), '');
});

test('throttle hook: notices follow notify and language, stale data turns the throttle off', () => {
  const quiet = envWith(SERIES.at(60, 150), { notify: false, throttle: { maxWaitSec: 0.3 } });
  const q = runHook('throttle', toolCall(), quiet.env);
  assert.equal(q.stdout.trim(), '');
  assert.ok(q.ms >= 300);
  assert.equal(readLog(quiet.home, 'throttle').length, 1);

  const en = envWith(SERIES.at(60, 150), { language: 'en', throttle: { maxWaitSec: 0.3 } });
  const on = runHook('throttle', toolCall(), en.env);
  assert.match(on.json.systemMessage, /^quota-pacer: throttle on – pauses of up to 0\.3 s .*\(5-hour window 60% used, schedule 50%\)\. Models stay unchanged\.$/);
  seedSamples(en.home, SERIES.at(40, 150));
  assert.equal(runHook('throttle', toolCall(), en.env).json.systemMessage, 'quota-pacer: throttle off – usage is back on schedule.');

  const de = envWith(SERIES.at(60, 150), { throttle: { maxWaitSec: 0.3 } });
  assert.match(runHook('throttle', toolCall(), de.env).json.systemMessage, /\(5-h-Fenster 60% genutzt, Plan 50%\)\. Modelle bleiben unverändert\.$/);
  de.env.QUOTA_PACER_NOW = String(NOW + 30 * 60000); // samples now 30 min old
  assert.equal(runHook('throttle', toolCall(), de.env).json.systemMessage, 'quota-pacer: Drossel aus – keine aktuellen Kontingentdaten.');
});

test('throttle hook: parallel tool calls announce the activation only once', async () => {
  const e = envWith(SERIES.at(60, 150), { throttle: { maxWaitSec: 0.3 } });
  const runs = await Promise.all([1, 2, 3, 4].map((i) => runHookAsync('throttle', toolCall({ tool_use_id: `t${i}` }), e.env)));
  assert.ok(runs.every((r) => r.code === 0 && r.ms >= 300), runs.map((r) => r.ms).join(','));
  assert.equal(runs.filter((r) => r.json && r.json.systemMessage).length, 1);
  assert.equal(readLog(e.home, 'throttle').length, 4);
});

test('status line: "Drossel Ns" only while a pause applies', () => {
  const sl = (e) => strip(runScript('statusline.js', [], { session_id: 'x', model: { id: 'claude-opus-5-5' } }, e.env).stdout).trim();
  assert.match(sl(envWith(SERIES.redAhead(), { throttle: { maxWaitSec: 3 } })), /^pacing ROT 5h 60%→120%@\d\d:\d\d Drossel 3s$/);
  assert.match(sl(envWith(SERIES.redAhead(), { strategy: 'both', throttle: { maxWaitSec: 3 } })), /Drossel 3s$/);
  assert.match(sl(envWith(SERIES.redAhead(), { language: 'en', throttle: { maxWaitSec: 3 } })), /^pacing RED .* throttle 3s$/);
  assert.doesNotMatch(sl(envWith(SERIES.redAhead(), { strategy: 'downgrade', throttle: { maxWaitSec: 3 } })), /Drossel/);
  assert.doesNotMatch(sl(envWith(SERIES.at(40, 150))), /Drossel/);
});

test('pacer status shows strategy and throttle state', () => {
  const ahead = envWith(SERIES.at(60, 150), { throttle: { maxWaitSec: 1.5 } });
  const s = runScript('pacer.js', ['status'], '', ahead.env).stdout;
  assert.match(s, /^quota-pacer 1.2.0 – Stufe: GRÜN/);
  assert.match(s, /Strategie: throttle \(Drossel – Pausen zwischen den Schritten, Modelle bleiben unverändert\)/);
  assert.match(s, /Drossel: aktiv – nächste Pause 1\.5 s \(5-h-Fenster 60% genutzt, Plan 50%; höchstens 1\.5 s je Pause\)/);
  assert.match(s, /Parallel-Limit auf dieser Stufe: keins \(Strategie throttle\)/);
  const j = JSON.parse(runScript('pacer.js', ['status', '--json'], '', ahead.env).stdout);
  assert.equal(j.version, '1.2.0');
  assert.equal(j.strategy, 'throttle');
  assert.equal(j.throttle.waitSec, 1.5);
  assert.equal(j.throttle.lead.name, 'fiveHour');
  assert.equal(j.level, 'green');

  const onPlan = runScript('pacer.js', ['status'], '', envWith(SERIES.at(40, 150)).env).stdout;
  assert.match(onPlan, /Drossel: keine Pause – im Plan \(5-h-Fenster 40% genutzt, Plan 50%\)/);
  const noData = runScript('pacer.js', ['status'], '', makeEnv({ QUOTA_PACER_NOW: String(NOW) }).env).stdout;
  assert.match(noData, /Stufe: KEINE DATEN/);
  assert.match(noData, /Drossel: keine Pause – keine aktuellen Kontingentdaten/);

  const down = envWith(SERIES.at(60, 150), { strategy: 'downgrade' });
  assert.match(runScript('pacer.js', ['status'], '', down.env).stdout, /Drossel: aus \(Strategie downgrade\)/);
  assert.equal(JSON.parse(runScript('pacer.js', ['status', '--json'], '', down.env).stdout).throttle.waitSec, 0);
  const both = runScript('pacer.js', ['status'], '', envWith(SERIES.amber(), { strategy: 'both' }).env).stdout;
  assert.match(both, /Strategie: both/);
  assert.match(both, /Parallel-Limit auf dieser Stufe: keins unter ROT \(Strategie both\)/);
  const redDown = runScript('pacer.js', ['status'], '', envWith(SERIES.red(), { strategy: 'downgrade' }).env).stdout;
  assert.match(redDown, /Parallel-Limit auf dieser Stufe: 1/);
});

test('SessionStart: the FORCE reminder only appears when the plugin changes models', () => {
  const t = envWith(SERIES.amber());
  t.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
  const r = runHook('session-start', { session_id: 's', source: 'startup' }, t.env);
  assert.doesNotMatch(r.json.systemMessage, /SUBAGENT_MODEL_FORCE/);
  assert.match(r.json.systemMessage, /^quota-pacer: Der Kontingent-Sensor ist noch nicht aktiv\. Einmalig \/quota-pacer:setup ausführen\.$/);
  const b = envWith(SERIES.amber(), { strategy: 'both' });
  b.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
  assert.match(runHook('session-start', { session_id: 's', source: 'startup' }, b.env).json.systemMessage, /SUBAGENT_MODEL_FORCE/);
});

test('installer: copies pacer.js and all lib modules, recognises only its own status line', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  assert.equal(runScript('pacer.js', ['install'], '', e.env).code, 0);
  const bin = path.join(e.home, 'bin');
  for (const f of ['pacer.js', 'hook.js', 'statusline.js', 'lib/transcript.js', 'lib/reissue.js', 'lib/throttle.js']) {
    assert.ok(fs.existsSync(path.join(bin, f)), f);
  }
  assert.equal(fs.readFileSync(path.join(bin, 'VERSION'), 'utf8').trim(), '1.2.0');
  // The copy works on its own (the status line points at it).
  const st = require('child_process').spawnSync(process.execPath, [path.join(bin, 'pacer.js'), 'status'], { env: e.env, encoding: 'utf8' });
  assert.match(st.stdout, /^quota-pacer 1.2.0/);
  process.env.CLAUDE_CONFIG_DIR = e.claude;
  process.env.QUOTA_PACER_HOME = e.home;
  const { isOurs, statuslineCommand } = require('../scripts/lib/install');
  assert.equal(isOurs({ command: statuslineCommand() }), true);
  assert.equal(isOurs({ command: 'node "/Users/x/.claude/quota-pacer/bin/statusline.js"' }), true);
  assert.equal(isOurs({ command: 'node "C:\\Users\\x\\.claude\\quota-pacer\\bin\\statusline.js"' }), true);
  assert.equal(isOurs({ command: 'node "/Users/x/.claude/pacing/bin/statusline.js"' }), false);
  assert.equal(isOurs({ command: '~/.claude/statusline.sh' }), false);
  assert.equal(isOurs(null), false);
});
