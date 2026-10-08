'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeEnv, writeJson, runScript } = require('./helpers');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

// Payload shaped like the documented status line JSON (Claude Code >= 2.1.80).
function payload(over = {}) {
  return {
    session_id: 'sess-sl',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: { current_dir: '/tmp', project_dir: '/tmp' },
    version: '2.1.289',
    cost: { total_cost_usd: 0.42, total_duration_ms: 1000 },
    context_window: { used_percentage: 12 },
    rate_limits: {
      five_hour: { used_percentage: 42.5, resets_at: Math.round(NOW / 1000) + 3 * 3600 },
      seven_day: { used_percentage: 18, resets_at: Math.round(NOW / 1000) + 4 * 86400 },
    },
    ...over,
  };
}

test('sensor records a sample and the session model, prints a segment', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  const r = runScript('statusline.js', [], payload(), e.env);
  assert.equal(r.code, 0);
  assert.match(strip(r.stdout), /pacing \S+ 5h 43%/);
  const s = JSON.parse(fs.readFileSync(path.join(e.home, 'samples.json'), 'utf8')).samples;
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].f, { u: 42.5, r: Math.round(NOW / 1000) + 3 * 3600 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.home, 'sessions', 'sess-sl', 'model.json'))).model, 'claude-opus-5-5');
});

test('sensor de-duplicates identical readings within 60 s', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  runScript('statusline.js', [], payload(), e.env);
  runScript('statusline.js', [], payload(), e.env);
  e.env.QUOTA_PACER_NOW = String(NOW + 61000);
  runScript('statusline.js', [], payload(), e.env);
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.home, 'samples.json'), 'utf8')).samples.length, 2);
});

test('sensor without rate_limits (API key login) shows NO DATA and writes nothing', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  const r = runScript('statusline.js', [], payload({ rate_limits: undefined }), e.env);
  assert.equal(r.code, 0);
  assert.match(strip(r.stdout), /pacing KEINE DATEN/);
  assert.ok(!fs.existsSync(path.join(e.home, 'samples.json')));
});

test('sensor survives malformed input and broken state files', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  fs.writeFileSync(path.join(e.home, 'samples.json'), '{broken');
  fs.writeFileSync(path.join(e.home, 'level.json'), 'nope');
  for (const input of ['', 'garbage', '{"rate_limits":"x"}', '{"rate_limits":{"five_hour":{"used_percentage":"abc"}}}']) {
    const r = runScript('statusline.js', [], input, e.env);
    assert.equal(r.code, 0, input);
  }
  const r = runScript('statusline.js', [], payload(), e.env);
  assert.equal(r.code, 0);
  assert.match(strip(r.stdout), /5h 43%/);
});

test('sensor chains the previous status line with the same stdin', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  writeJson(path.join(e.home, 'config.json'), { chain: { type: 'command', command: 'cat >/dev/null; echo "MYLINE"' } });
  const r = runScript('statusline.js', [], payload(), e.env);
  assert.match(strip(r.stdout), /^MYLINE  pacing/);
  writeJson(path.join(e.home, 'config.json'), { chain: { type: 'command', command: 'cat >/dev/null; printf "L1\\nL2"' } });
  assert.match(strip(runScript('statusline.js', [], payload(), e.env).stdout), /^L1\nL2\npacing/);
  writeJson(path.join(e.home, 'config.json'), { chain: { type: 'command', command: 'exit 3' } });
  assert.match(strip(runScript('statusline.js', [], payload(), e.env).stdout), /^pacing/);
  writeJson(path.join(e.home, 'config.json'), { chain: { type: 'command', command: 'cat >/dev/null; echo ONLY' }, statusSegment: false });
  assert.equal(strip(runScript('statusline.js', [], payload(), e.env).stdout).trim(), 'ONLY');
});

test('chained status line that hangs is cut off after 3 s', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  writeJson(path.join(e.home, 'config.json'), { chain: { type: 'command', command: 'sleep 20' } });
  const r = runScript('statusline.js', [], payload(), e.env);
  assert.ok(r.ms < 6000, `took ${r.ms} ms`);
  assert.match(strip(r.stdout), /pacing/);
});

test('install writes an absolute statusLine, keeps other settings, backs up', () => {
  const e = makeEnv();
  writeJson(path.join(e.claude, 'settings.json'), { model: 'opus', permissions: { allow: ['Bash(npm test)'] }, env: { FOO: '1' } });
  const r = runScript('pacer.js', ['install'], '', e.env);
  assert.equal(r.code, 0, r.stdout);
  const s = JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8'));
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(s.statusLine.type, 'command');
  assert.equal(s.statusLine.refreshInterval, 30);
  const m = /^node "(.+)"$/.exec(s.statusLine.command);
  assert.ok(m && path.isAbsolute(m[1]) && fs.existsSync(m[1]), s.statusLine.command);
  assert.equal(fs.readdirSync(path.join(e.home, 'backups')).length, 1);
  // The installed sensor runs standalone from its stable location.
  const sl = require('child_process').spawnSync('node', [m[1]], { input: JSON.stringify(payload()), env: { ...e.env, QUOTA_PACER_NOW: String(NOW) }, encoding: 'utf8' });
  assert.match(strip(sl.stdout), /5h 43%/);
});

test('install chains an existing status line, uninstall restores it, re-install is idempotent', () => {
  const e = makeEnv();
  const original = { type: 'command', command: '~/.claude/statusline.sh', padding: 1 };
  writeJson(path.join(e.claude, 'settings.json'), { statusLine: original });
  runScript('pacer.js', ['install'], '', e.env);
  runScript('pacer.js', ['install'], '', e.env); // second run must not chain itself
  // Stored in its own state file, not in the user-edited config.json.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.home, 'chain.json'), 'utf8')).chain, original);
  assert.ok(!fs.existsSync(path.join(e.home, 'config.json')));
  const s = JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8'));
  assert.equal(s.statusLine.padding, 1);
  const u = runScript('pacer.js', ['uninstall'], '', e.env);
  assert.equal(u.code, 0);
  assert.match(u.stdout, /Vorherige Statusline wiederhergestellt: ~\/\.claude\/statusline\.sh/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8')).statusLine, original);
  assert.ok(!fs.existsSync(path.join(e.home, 'chain.json')));
});

test('install into missing settings.json creates it; uninstall removes only our key', () => {
  const e = makeEnv();
  runScript('pacer.js', ['install'], '', e.env);
  assert.ok(JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8')).statusLine);
  runScript('pacer.js', ['uninstall'], '', e.env);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8')), {});
});

test('invalid settings.json is never touched', () => {
  const e = makeEnv();
  const file = path.join(e.claude, 'settings.json');
  fs.writeFileSync(file, '{ "model": "opus", // comment\n}');
  const before = fs.readFileSync(file, 'utf8');
  const r = runScript('pacer.js', ['install'], '', e.env);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /kein gültiges JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('uninstall leaves a foreign status line alone', () => {
  const e = makeEnv();
  writeJson(path.join(e.claude, 'settings.json'), { statusLine: { type: 'command', command: 'mine.sh' } });
  const r = runScript('pacer.js', ['uninstall'], '', e.env);
  assert.match(r.stdout, /nichts geändert/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8')).statusLine.command, 'mine.sh');
});

test('doctor reports missing sensor, FORCE and managed hook lock', () => {
  const e = makeEnv({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  writeJson(e.env.QUOTA_PACER_MANAGED_SETTINGS, { allowManagedHooksOnly: true });
  writeJson(path.join(e.home, 'config.json'), { strategy: 'downgrade' });
  const r = runScript('pacer.js', ['doctor'], '', e.env);
  assert.equal(r.code, 1, 'doctor exits 1 when there are [FAIL] lines');
  assert.match(r.stdout, /\[FAIL\] Sensor \(statusLine\)/);
  assert.match(r.stdout, /\[FAIL\] CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
  assert.match(r.stdout, /\[FAIL\] Managed Settings/);
  assert.match(r.stdout, /\[OK  \] Node\.js/);
});

test('doctor: FORCE is only informational for strategy throttle, and "false" counts as off', () => {
  const t = makeEnv({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  assert.match(runScript('pacer.js', ['doctor'], '', t.env).stdout, /\[INFO\] CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
  const f = makeEnv({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'false' });
  writeJson(path.join(f.home, 'config.json'), { strategy: 'downgrade' });
  assert.doesNotMatch(runScript('pacer.js', ['doctor'], '', f.env).stdout, /CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
});

test('doctor is green after install and one sample', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  runScript('pacer.js', ['install'], '', e.env);
  runScript('statusline.js', [], payload(), e.env);
  const r = runScript('pacer.js', ['doctor'], '', e.env);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Alles bereit\./);
  assert.match(r.stdout, /\[OK  \] Sensor \(statusLine\)/);
  assert.match(r.stdout, /\[OK  \] Kontingentdaten: 1 Messpunkte/);
  assert.doesNotMatch(r.stdout, /\[FAIL\] (Sensor|Kontingent|Node)/);
});
