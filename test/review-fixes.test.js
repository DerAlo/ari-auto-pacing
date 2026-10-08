'use strict';
// Fixes from the final review of 1.1.0: config.json that does not parse, the chained
// status line in its own state file, uninstall without a known chain, doctor exit code
// and login check, weekly projection by the leading progress share, weekly projection in
// the status line, Explore under a Fable main thread.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeEnv, writeJson, runScript, runHook, seedSamples, linearSeries, preAgentInput } = require('./helpers');
const { analyzeWindow } = require('../scripts/lib/forecast');
const { DEFAULTS } = require('../scripts/lib/config');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
const BROKEN = '{ "enabled": false, }'; // trailing comma, typical for a hand edit

function slPayload(over = {}) {
  return {
    session_id: 'sess-rf',
    model: { id: 'claude-opus-5-5' },
    rate_limits: {
      five_hour: { used_percentage: 60, resets_at: Math.round(NOW / 1000) + 150 * 60 },
      seven_day: { used_percentage: 18, resets_at: Math.round(NOW / 1000) + 4 * 86400 },
    },
    ...over,
  };
}

test('config.json that does not parse: interventions off, reported by status, doctor, SessionStart and status line', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  // Far ahead of the schedule: with a valid config the throttle would pause.
  seedSamples(e.home, linearSeries({ now: NOW, resetInMin: 150, startUsed: 57, rate: 0.1, minutes: 30 }));
  fs.writeFileSync(path.join(e.home, 'config.json'), BROKEN);

  const t = runHook('throttle', { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, tool_use_id: 't1' }, e.env);
  assert.equal(t.code, 0);
  assert.ok(t.ms < 1500, `no pause expected, took ${t.ms} ms`);
  assert.equal(t.stdout.trim(), '');

  const st = runScript('pacer.js', ['status'], '', e.env);
  assert.match(st.stdout, /config\.json kein gültiges JSON .* alle Eingriffe aus/);
  assert.match(st.stdout, /Drossel: aus \(config\.json fehlerhaft\)/);

  const dr = runScript('pacer.js', ['doctor'], '', e.env);
  assert.match(dr.stdout, /\[FAIL\] config\.json: config\.json kein gültiges JSON/);
  assert.doesNotMatch(dr.stdout, /\[OK  \] Konfiguration/);
  assert.equal(dr.code, 1);

  const ss = runHook('session-start', { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }, e.env);
  assert.match(ss.json.systemMessage, /config\.json kein gültiges JSON .* alle Eingriffe sind aus/);
  // Not rate-limited like the other reminders: shown again at the next start.
  const ss2 = runHook('session-start', { session_id: 's2', hook_event_name: 'SessionStart', source: 'startup' }, e.env);
  assert.match(ss2.json.systemMessage, /kein gültiges JSON/);

  const sl = runScript('statusline.js', [], slPayload(), e.env);
  assert.match(strip(sl.stdout), /pacing config\.json-Fehler \(Eingriffe aus\)/);
  // The sensor keeps recording.
  const samples = JSON.parse(fs.readFileSync(path.join(e.home, 'samples.json'), 'utf8')).samples;
  assert.equal(samples[samples.length - 1].f.u, 60);
});

test('config.json that does not parse is never rewritten by install or uninstall', () => {
  const e = makeEnv();
  const cfgFile = path.join(e.home, 'config.json');
  fs.writeFileSync(cfgFile, BROKEN);
  writeJson(path.join(e.claude, 'settings.json'), { statusLine: { type: 'command', command: 'echo MYLINE' } });
  const i = runScript('pacer.js', ['install'], '', e.env);
  assert.equal(i.code, 0, i.stdout);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), BROKEN);
  const u = runScript('pacer.js', ['uninstall'], '', e.env);
  assert.equal(u.code, 0, u.stdout);
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), BROKEN);
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8')).statusLine.command, 'echo MYLINE');
});

test('replacing config.json with a documentation example keeps the chained status line (reviewer repro)', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  const mine = { type: 'command', command: 'cat >/dev/null; echo MYLINE' };
  writeJson(path.join(e.claude, 'settings.json'), { statusLine: mine });
  assert.equal(runScript('pacer.js', ['install'], '', e.env).code, 0);
  assert.match(strip(runScript('statusline.js', [], slPayload(), e.env).stdout), /^MYLINE  pacing/);
  // KONFIGURATION.md "Modellwechsel wie in 1.0.0", pasted over the whole file.
  writeJson(path.join(e.home, 'config.json'), { strategy: 'downgrade', concurrency: { amber: 2, red: 3 } });
  assert.match(strip(runScript('statusline.js', [], slPayload(), e.env).stdout), /^MYLINE  pacing/);
  const u = runScript('pacer.js', ['uninstall'], '', e.env);
  assert.match(u.stdout, /Vorherige Statusline wiederhergestellt/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8')).statusLine, mine);
  // The user's config is left as written.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.home, 'config.json'), 'utf8')), { strategy: 'downgrade', concurrency: { amber: 2, red: 3 } });
});

test('1.0.0 chain in config.json is still shown and restored; uninstall removes the old key only', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  const mine = { type: 'command', command: 'cat >/dev/null; echo OLDLINE' };
  writeJson(path.join(e.home, 'config.json'), { chain: mine, notify: false });
  assert.equal(runScript('pacer.js', ['install'], '', e.env).code, 0);
  assert.match(strip(runScript('statusline.js', [], slPayload(), e.env).stdout), /^OLDLINE  pacing/);
  runScript('pacer.js', ['uninstall'], '', e.env);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8')).statusLine, mine);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.home, 'config.json'), 'utf8')), { notify: false });
});

test('uninstall without a known chain restores the status line from the newest backup before our install', () => {
  const e = makeEnv();
  const mine = { type: 'command', command: 'echo FROM-BACKUP' };
  writeJson(path.join(e.claude, 'settings.json'), { statusLine: mine, model: 'opus' });
  e.env.QUOTA_PACER_NOW = String(NOW);
  runScript('pacer.js', ['install'], '', e.env);
  e.env.QUOTA_PACER_NOW = String(NOW + 60000);
  runScript('pacer.js', ['install'], '', e.env); // re-install: this backup holds our line
  fs.rmSync(path.join(e.home, 'chain.json')); // chain lost
  e.env.QUOTA_PACER_NOW = String(NOW + 120000);
  const u = runScript('pacer.js', ['uninstall'], '', e.env);
  assert.equal(u.code, 0);
  assert.match(u.stdout, /aus dem Backup wiederhergestellt: echo FROM-BACKUP/);
  const s = JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8'));
  assert.deepEqual(s.statusLine, mine);
  assert.equal(s.model, 'opus');
});

test('uninstall without chain and without a previous status line removes the entry and says so', () => {
  const e = makeEnv();
  writeJson(path.join(e.claude, 'settings.json'), { model: 'opus' });
  runScript('pacer.js', ['install'], '', e.env);
  const u = runScript('pacer.js', ['uninstall'], '', e.env);
  assert.match(u.stdout, /Keine vorherige Statusline bekannt/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8')), { model: 'opus' });
});

test('doctor: login without quota data is reported; third-party providers are a FAIL', () => {
  const key = makeEnv({ ANTHROPIC_API_KEY: 'sk-ant-fake-for-test' });
  runScript('pacer.js', ['install'], '', key.env);
  const k = runScript('pacer.js', ['doctor'], '', key.env);
  assert.match(k.stdout, /\[WARN\] Login: ANTHROPIC_API_KEY/);
  assert.match(k.stdout, /Installation bereit, aber vermutlich ohne Kontingentdaten/);
  assert.doesNotMatch(k.stdout, /Alles bereit/);
  assert.equal(k.code, 0);
  const bed = makeEnv({ CLAUDE_CODE_USE_BEDROCK: '1' });
  runScript('pacer.js', ['install'], '', bed.env);
  const b = runScript('pacer.js', ['doctor'], '', bed.env);
  assert.match(b.stdout, /\[FAIL\] Login: CLAUDE_CODE_USE_BEDROCK/);
  assert.equal(b.code, 1);
});

test('doctor: Claude Code versions below the tested ones are a warning, below 2.1.251 a FAIL', () => {
  for (const [version, re] of [['2.1.270', /\[WARN\] Claude Code: 2\.1\.270 ungetestet/], ['2.1.200', /\[FAIL\] Claude Code: 2\.1\.200/], ['2.1.291', /\[OK  \] Claude Code: 2\.1\.291/]]) {
    const e = makeEnv();
    const bin = path.join(e.base, 'fakebin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
    // Windows does not run a script without an extension; cmd finds claude.cmd first.
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@echo ${version} (Claude Code)\r\n`);
    e.env.PATH = `${bin}${path.delimiter}${e.env.PATH}`;
    assert.match(runScript('pacer.js', ['doctor'], '', e.env).stdout, re, version);
  }
});

test('weekly projection uses the larger progress share (real data: Tuesday 10:48, 44 %)', () => {
  // Readings of a real account: seven_day 44 % at 10:19 and 10:48 CEST, resets_at
  // 1791637200 (Sat 15:00 CEST). Working time alone projected 167 %.
  const now = Date.UTC(2026, 9, 6, 8, 48, 14);
  const r = 1791637200;
  const samples = [{ t: Date.UTC(2026, 9, 6, 8, 19, 13), s: { u: 44, r } }, { t: now, s: { u: 44, r } }];
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  const w = analyzeWindow(samples, 'sevenDay', now, cfg);
  const wallShare = 1 - (r * 1000 - now) / (7 * 86400000);
  assert.equal(w.rateSource, 'wall-average');
  assert.ok(Math.abs(w.projected - 44 / wallShare) < 0.01, `projected ${w.projected}`);
  assert.ok(w.projected > 105 && w.projected < 112, `projected ${w.projected}`);
});

test('status line shows the weekly projection when the week sets the level', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  // 5 h: 10 %, GREEN. Week: 70 % two days into the window -> projection far above 100 %.
  const r5 = Math.round((NOW + 200 * 60000) / 1000);
  const r7 = Math.round((NOW + 5 * 86400000) / 1000);
  seedSamples(e.home, [
    { t: NOW - 20 * 60000, f: { u: 9, r: r5 }, s: { u: 70, r: r7 } },
    { t: NOW, f: { u: 10, r: r5 }, s: { u: 70, r: r7 } },
  ]);
  const out = strip(runScript('statusline.js', [], { session_id: 'x', model: { id: 'claude-opus-5-5' } }, e.env).stdout);
  assert.match(out, /pacing ROT 5h 10%\S* 7d 70%→\d+%/);
  // Week on GREEN: no weekly projection in the segment.
  const g = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(g.home, [{ t: NOW - 20 * 60000, f: { u: 9, r: r5 }, s: { u: 20, r: r7 } }, { t: NOW, f: { u: 10, r: r5 }, s: { u: 20, r: r7 } }]);
  assert.match(strip(runScript('statusline.js', [], { session_id: 'x', model: { id: 'claude-opus-5-5' } }, g.env).stdout), /7d 20%(\s|$)/);
});

test('Explore under a Fable main thread counts as Opus (measured on 2.1.291)', () => {
  const e = makeEnv();
  const saved = { home: process.env.QUOTA_PACER_HOME, cfg: process.env.CLAUDE_CONFIG_DIR };
  process.env.QUOTA_PACER_HOME = e.home;
  process.env.CLAUDE_CONFIG_DIR = e.claude;
  try {
    const { resolveEffective, setSessionModel } = require('../scripts/lib/models');
    setSessionModel('fable-s', 'claude-fable-5-1');
    const none = path.join(os.tmpdir(), `qp-none-${process.pid}.jsonl`);
    const q = { toolInput: { prompt: 'p' }, sessionId: 'fable-s', cwd: e.project, projectDir: e.project, transcriptPath: none, toolUseId: 'x', waitMs: 0 };
    const ex = resolveEffective({ ...q, agentType: 'Explore' });
    assert.equal(ex.model, 'opus');
    assert.equal(ex.rank, 3);
    assert.match(ex.source, /^builtin-explore-cap\//);
    assert.equal(resolveEffective({ ...q, agentType: 'Plan' }).model, 'claude-fable-5-1');
    setSessionModel('opus-s', 'claude-opus-5-5');
    assert.equal(resolveEffective({ ...q, sessionId: 'opus-s', agentType: 'Explore' }).model, 'claude-opus-5-5');
  } finally {
    if (saved.home === undefined) delete process.env.QUOTA_PACER_HOME; else process.env.QUOTA_PACER_HOME = saved.home;
    if (saved.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.cfg;
  }
});

test('strategy downgrade with a Fable main thread: a routine target of opus for Explore is no change', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(e.home, linearSeries({ now: NOW, resetInMin: 240, startUsed: 20, rate: 0.3, minutes: 30 })); // GELB
  writeJson(path.join(e.home, 'config.json'), { strategy: 'downgrade', models: { amber: { routine: 'opus', default: 'sonnet', protected: null }, red: DEFAULTS.models.red } });
  runScript('statusline.js', [], { session_id: 'sess-1', model: { id: 'claude-fable-5-1' } }, e.env);
  const r = runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '', 'no rewrite and no re-issue: Explore already runs on Opus');
});

test('level-change notice names the weekly projection when the week is the cause', () => {
  const { levelChangeMessage } = require('../scripts/lib/messages');
  const cfg = JSON.parse(JSON.stringify({ ...DEFAULTS, strategy: 'downgrade' }));
  const ev = {
    level: 'red',
    windows: {
      fiveHour: { status: 'ok', used: 12, projected: 30, resetsAt: NOW, level: 'green' },
      sevenDay: { status: 'ok', used: 44, projected: 109, level: 'red' },
    },
  };
  assert.match(levelChangeMessage(ev, cfg), /\(5h 12% → 30% bis \d\d:\d\d, 7d 44% → 109%\)/);
  ev.windows.sevenDay.level = 'green';
  assert.match(levelChangeMessage(ev, cfg), /7d 44%\)/);
});
