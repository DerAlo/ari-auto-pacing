#!/usr/bin/env node
'use strict';
// Measures wall-clock time per hook process (spawn to exit), as Claude Code sees it.
// Every row also checks the output of each run, so a path that silently fails open
// (and would therefore be fast for the wrong reason) shows up as ok < n.
// Usage: node test/bench/bench-hooks.js [runs]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeEnv, writeJson, seedSamples, linearSeries, preAgentInput, SCRIPTS } = require('../helpers');

const RUNS = Number(process.argv[2]) || 40;
const NOW = Date.now();

function timeIt(fn) {
  const t = process.hrtime.bigint();
  const r = fn();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, r };
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
}

function parse(stdout) {
  const t = (stdout || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return t; }
}

function bench(label, script, args, inputFn, env, check) {
  const xs = [];
  let ok = 0;
  let sample = null;
  for (let i = 0; i < RUNS; i++) {
    const input = JSON.stringify(inputFn(i));
    const { ms, r } = timeIt(() => spawnSync(process.execPath, [path.resolve(SCRIPTS, script), ...args], { input, env, encoding: 'utf8' }));
    xs.push(ms);
    const out = parse(r.stdout);
    if (r.status === 0 && check(out)) ok++;
    if (i === 0) sample = out;
  }
  return { label, ...stats(xs), ok, sample };
}

function transcriptFor(dir, toolUseId) {
  const f = path.join(dir, `t-${toolUseId}.jsonl`);
  fs.writeFileSync(f, `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: toolUseId }] } })}\n`);
  return f;
}

const decision = (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision;
const rows = [];

rows.push(bench('Node-Start (Referenz: leeres Skript)', '../test/bench/noop.js', [], () => ({}), process.env, (o) => o === null));

// GREEN, strategy downgrade: the full pre-agent path (settings rules, lock, reservation), no change.
const green = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
writeJson(path.join(green.home, 'config.json'), { strategy: 'downgrade' });
seedSamples(green.home, linearSeries({ now: NOW, resetInMin: 240, startUsed: 2, rate: 0.05, minutes: 30 }));
rows.push(bench('PreToolUse GRÜN (downgrade, kein Eingriff)', 'hook.js', ['pre-agent'],
  (i) => preAgentInput({ session_id: `g${i}`, cwd: green.project }), green.env, (o) => o === null));

// AMBER, strategy downgrade: used 29 %, 0.3 %-points/min, reset in 240 min => projection ~101 %.
const amber = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
writeJson(path.join(amber.home, 'config.json'), { strategy: 'downgrade' });
seedSamples(amber.home, linearSeries({ now: NOW, resetInMin: 240, startUsed: 20, rate: 0.3, minutes: 30 }));
rows.push(bench('PreToolUse GELB, Modellwechsel (allow)', 'hook.js', ['pre-agent'], (i) => {
  const id = `toolu_b${i}`;
  return preAgentInput({ session_id: `a${i}`, cwd: amber.project, tool_use_id: id, transcript_path: transcriptFor(amber.base, id), tool_input: { prompt: 'x', description: 'y', subagent_type: 'Explore' } });
}, amber.env, (o) => decision(o) === 'allow' && o.hookSpecificOutput.updatedInput.model === 'haiku'));
rows.push(bench('PreToolUse GELB, Auto-Mode (Re-Issue)', 'hook.js', ['pre-agent'], (i) => {
  const id = `toolu_r${i}`;
  return preAgentInput({ session_id: `r${i}`, permission_mode: 'auto', cwd: amber.project, tool_use_id: id, transcript_path: transcriptFor(amber.base, id) });
}, amber.env, (o) => decision(o) === 'deny' && /"model": "haiku"/.test(o.hookSpecificOutput.permissionDecisionReason)));
rows.push(bench('UserPromptSubmit GELB (downgrade)', 'hook.js', ['prompt'], (i) => ({ session_id: `p${i}`, prompt: 'x' }), amber.env,
  (o) => !!(o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext)));
rows.push(bench('SubagentStart', 'hook.js', ['subagent-start'], (i) => ({ session_id: 's', agent_id: `x${i}`, agent_type: 'Explore' }), amber.env, (o) => o === null));

// Default strategy (throttle), usage on schedule: every tool call runs this hook.
const sched = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
seedSamples(sched.home, linearSeries({ now: NOW, resetInMin: 240, startUsed: 2, rate: 0.05, minutes: 30 }));
rows.push(bench('Drossel-Hook, Standard, im Plan (keine Pause)', 'hook.js', ['throttle'],
  (i) => ({ session_id: 'th', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: `toolu_t${i}` }),
  sched.env, (o) => o === null));

// Sensor in its own data dir, so its samples do not change the rows above.
const sensor = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
rows.push(bench('Statusline-Sensor', 'statusline.js', [], (i) => ({
  session_id: 'sl', model: { id: 'claude-opus-5-5' },
  rate_limits: { five_hour: { used_percentage: 20 + i, resets_at: Math.round(NOW / 1000) + 3600 }, seven_day: { used_percentage: 39, resets_at: Math.round(NOW / 1000) + 5 * 86400 } },
}), sensor.env, (o) => typeof o === 'string' && o.startsWith('pacing')));

const out = { runs: RUNS, node: process.version, platform: `${process.platform}-${process.arch}`, date: new Date(NOW).toISOString(), rows };
fs.mkdirSync(path.join(__dirname, '..', 'e2e', 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'e2e', 'results', 'bench-report.json'), JSON.stringify(out, null, 2));
console.log(`Hook-Latenz, ${RUNS} Läufe je Pfad (ms, Prozessstart bis Ende; ok = Ausgabe wie erwartet)`);
for (const r of rows) console.log(`${r.label.padEnd(46)} p50 ${String(r.p50).padStart(6)}  p95 ${String(r.p95).padStart(6)}  max ${String(r.max).padStart(6)}  ok ${r.ok}/${r.n}`);
if (rows.some((r) => r.ok !== r.n)) process.exitCode = 1;
