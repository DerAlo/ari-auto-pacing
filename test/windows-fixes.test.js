'use strict';
// Fixes of 1.1.1: settings that cannot be read, UTF-8 BOM, session names with dots, a
// main model known only from an older message, backup pruning.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeEnv, writeJson, runScript } = require('./helpers');
const { safeName, readJson } = require('../scripts/lib/util');
const { settingsSources, agentRuleApplies, modelAllowed, unreadableSources } = require('../scripts/lib/permissions');
const { decideSpawn } = require('../scripts/lib/policy');
const { DEFAULTS } = require('../scripts/lib/config');

const BOM = '﻿';
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

// settingsSources reads the Claude config dir from the environment of this process.
function withEnv(env, fn) {
  const keys = ['CLAUDE_CONFIG_DIR', 'QUOTA_PACER_MANAGED_SETTINGS', 'QUOTA_PACER_HOME'];
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) process.env[k] = env[k];
  try { return fn(); } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
}

test('safeName never yields a name that leaves the sessions directory', () => {
  assert.equal(safeName('..'), '__');
  assert.equal(safeName('.'), '_');
  assert.equal(safeName('../../x'), '___.._x');
  assert.equal(safeName('.hidden'), '_hidden');
  assert.equal(safeName('abc-123.def'), 'abc-123.def');
  assert.equal(safeName(''), 'unknown');
});

test('SessionEnd with session_id ".." leaves the data directory alone', () => {
  const e = makeEnv();
  writeJson(path.join(e.home, 'samples.json'), { v: 1, samples: [] });
  const r = runScript('hook.js', ['session-end'], { session_id: '..', hook_event_name: 'SessionEnd' }, e.env);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(e.home, 'samples.json')));
});

test('readJson accepts a UTF-8 BOM', () => {
  const e = makeEnv();
  const f = path.join(e.home, 'x.json');
  fs.writeFileSync(f, `${BOM}{"a":1}`);
  assert.deepEqual(readJson(f, null), { a: 1 });
});

test('settings with a BOM are read: their deny rule applies', () => {
  const e = makeEnv();
  fs.writeFileSync(path.join(e.claude, 'settings.json'), BOM + JSON.stringify({ permissions: { deny: ['Agent(Explore)'] } }));
  withEnv(e.env, () => {
    const sources = settingsSources(e.project);
    assert.deepEqual(unreadableSources(sources), []);
    assert.equal(agentRuleApplies('Explore', e.project, sources).kind, 'deny');
  });
});

test('a settings file that does not parse blocks every Agent rewrite', () => {
  const e = makeEnv();
  const broken = path.join(e.project, '.claude', 'settings.local.json');
  fs.writeFileSync(broken, '{ "permissions": { "deny": ["Agent"] }, }');
  withEnv(e.env, () => {
    const sources = settingsSources(e.project);
    assert.deepEqual(unreadableSources(sources), [broken]);
    assert.deepEqual(agentRuleApplies('Explore', e.project, sources), { kind: 'unreadable', rule: broken, file: broken });
    const m = modelAllowed('haiku', e.project, sources);
    assert.equal(m.ok, false);
    assert.equal(m.why, 'settings-unreadable');
  });
  assert.match(runScript('pacer.js', ['doctor'], '', e.env).stdout, /\[WARN\] Settings: nicht lesbar: .*settings\.local\.json/);
});

test('missing and empty settings files are not "unreadable"', () => {
  const e = makeEnv();
  fs.writeFileSync(path.join(e.claude, 'settings.json'), '');
  withEnv(e.env, () => {
    const sources = settingsSources(e.project);
    assert.deepEqual(unreadableSources(sources), []);
    assert.equal(agentRuleApplies('Explore', e.project, sources), null);
  });
});

test('install and config work with a BOM in settings.json and config.json', () => {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  fs.writeFileSync(path.join(e.claude, 'settings.json'), BOM + JSON.stringify({ model: 'opus' }));
  fs.writeFileSync(path.join(e.home, 'config.json'), BOM + JSON.stringify({ strategy: 'both' }));
  const i = runScript('pacer.js', ['install'], '', e.env);
  assert.equal(i.code, 0, i.stdout);
  const s = JSON.parse(fs.readFileSync(path.join(e.claude, 'settings.json'), 'utf8'));
  assert.equal(s.model, 'opus');
  assert.ok(s.statusLine);
  const st = runScript('pacer.js', ['status'], '', e.env);
  assert.doesNotMatch(st.stdout, /kein gültiges JSON/);
  assert.match(st.stdout, /Strategie: both/);
});

test('a main model known only from an older message allows a rewrite to haiku only', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.strategy = 'downgrade';
  const sure = { model: 'opus', rank: 3, source: 'inherit/transcript' };
  const stale = { ...sure, source: 'inherit/last-assistant', uncertain: true };
  for (const level of ['amber', 'red', 'stop']) {
    const a = decideSpawn({ level, agentType: 'Explore', eff: sure, active: 0, cfg });
    const b = decideSpawn({ level, agentType: 'Explore', eff: stale, active: 0, cfg });
    if (a.action !== 'rewrite') { assert.deepEqual(b, a, level); continue; }
    if (a.model === 'haiku') assert.deepEqual(b, a, level);
    else assert.deepEqual(b, { action: 'none', reason: 'uncertain-effective-model' }, level);
  }
});

test('settings backups are pruned, the newest one with a foreign status line stays', () => {
  const e = makeEnv();
  const mine = { type: 'command', command: 'echo MINE' };
  writeJson(path.join(e.claude, 'settings.json'), { statusLine: mine });
  for (let i = 0; i < 14; i++) {
    e.env.QUOTA_PACER_NOW = String(NOW + i * 60000);
    assert.equal(runScript('pacer.js', ['install'], '', e.env).code, 0);
  }
  const dir = path.join(e.home, 'backups');
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.length, 11);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8')).statusLine, mine);
  fs.rmSync(path.join(e.home, 'chain.json'));
  e.env.QUOTA_PACER_NOW = String(NOW + 3600000);
  assert.match(runScript('pacer.js', ['uninstall'], '', e.env).stdout, /aus dem Backup wiederhergestellt: echo MINE/);
});
