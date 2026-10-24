#!/usr/bin/env node
'use strict';
// Install path as the README documents it, with the real CLI in a temp HOME:
//   claude plugin marketplace add <repo>, claude plugin install quota-pacer@ari-auto-pacing,
//   claude -p "/quota-pacer:setup", "/quota-pacer:status", "/quota-pacer:setup uninstall",
//   claude plugin uninstall, claude plugin marketplace remove.
// The skills run for real: the CLI expands SKILL.md (with ${CLAUDE_PLUGIN_ROOT} and
// $ARGUMENTS), the mock plays Claude and sends exactly the Bash command written in the
// expanded skill, and the CLI checks it against the skill's allowed-tools in default
// permission mode (in -p a command outside allowed-tools is denied, not asked).
// Sequence B removes the plugin first (the obvious wrong order) and then uses the
// documented fallback `node <data dir>/bin/pacer.js uninstall`.
//
// Usage: node test/e2e/run-skills.js [--claude <path>] [--no-sandbox] [--keep]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createMock } = require('./mock-api');
const { FAKE_API_KEY, mkHome, startBlackHole, buildEnv, runClaude, runClaudeSync, useSandbox } = require('./lib/env');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'results');
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CLAUDE = argVal('--claude') || process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const SANDBOX = !args.includes('--no-sandbox');
const KEEP = args.includes('--keep');
const PREV = { type: 'command', command: 'echo PREVLINE' };

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const eq = (name, actual, expected) => ({ name, pass: actual === expected, actual, expected });
const truthy = (name, cond, actual) => ({ name, pass: !!cond, actual });

function duBytes(dir) {
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    else total += st.size;
  };
  walk(dir);
  return total;
}

// Paths in the report relative to the temp HOME / repo, so no machine path is stored.
function rel(h, s) {
  return String(s).split(h.home).join('<tmp-home>').split(ROOT).join('<repo>');
}

async function skill(h, env, mock, prompt) {
  const before = mock.requests.length;
  const r = await runClaude(CLAUDE, ['-p', prompt, '--permission-mode', 'default', '--output-format', 'stream-json', '--verbose'],
    { cwd: h.project, env, home: h.home, sandbox: SANDBOX, timeoutMs: 120000 });
  const lines = r.out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = lines.find((l) => l.type === 'result') || {};
  const reqs = mock.requests.slice(before).filter((q) => q.role === 'skill');
  const commands = reqs.flatMap((q) => q.answered.filter((a) => a.toolUse === 'Bash').map((a) => a.input.command));
  const results = reqs.flatMap((q) => q.toolResults);
  return { prompt, exit: r.code, subtype: result.subtype || null, denials: result.permission_denials || null, commands, results, ms: r.ms };
}

function plugin(h, env, argv) {
  const r = runClaudeSync(CLAUDE, ['plugin', ...argv], { cwd: h.project, env, home: h.home, sandbox: SANDBOX });
  return { argv: argv.map((a) => rel(h, a)), exit: r.code, out: rel(h, `${r.out}${r.err}`).trim().slice(0, 400) };
}

function expectedCommand(root, cmd) {
  return `node "${root}/scripts/pacer.js" ${cmd}`;
}

async function sequenceA(mock, port, proxy) {
  const h = mkHome('skills-a');
  const env = buildEnv({ home: h.home, mockPort: port, proxyPort: proxy.port, auth: 'apikey' });
  const settingsFile = path.join(h.claudeDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: PREV }, null, 2));
  const steps = {};
  steps.add = plugin(h, env, ['marketplace', 'add', ROOT]);
  steps.install = plugin(h, env, ['install', 'quota-pacer@ari-auto-pacing']);
  const cacheDir = path.join(h.claudeDir, 'plugins', 'cache', 'ari-auto-pacing', 'quota-pacer', '1.4.0');
  const cacheBytes = duBytes(cacheDir);
  steps.setup = await skill(h, env, mock, '/quota-pacer:setup');
  const afterSetup = readJson(settingsFile) || {};
  const chain = (readJson(path.join(h.pacerHome, 'chain.json')) || {}).chain || null;
  steps.status = await skill(h, env, mock, '/quota-pacer:status');
  steps.uninstallSkill = await skill(h, env, mock, '/quota-pacer:setup uninstall');
  const afterUninstall = readJson(settingsFile) || {};
  steps.pluginUninstall = plugin(h, env, ['uninstall', 'quota-pacer']);
  const afterPluginUninstall = { cache: fs.existsSync(cacheDir), marketplaceEntry: !!((readJson(settingsFile) || {}).extraKnownMarketplaces || {})['ari-auto-pacing'] };
  steps.marketplaceRemove = plugin(h, env, ['marketplace', 'remove', 'ari-auto-pacing']);
  const afterRemove = { cache: fs.existsSync(cacheDir), marketplaceEntry: !!((readJson(settingsFile) || {}).extraKnownMarketplaces || {})['ari-auto-pacing'], dataDir: fs.existsSync(h.pacerHome) };

  const root = steps.setup.commands[0] ? /^node "(.*)\/scripts\/pacer\.js"/.exec(steps.setup.commands[0]) : null;
  const pluginRoot = root ? root[1] : null;
  const ours = `node "${path.join(h.pacerHome, 'bin', 'statusline.js')}"`;
  const resultText = (s) => s.results.map((x) => x.text).join('\n');
  const checks = [
    eq('marketplace add: Exit 0', steps.add.exit, 0),
    eq('plugin install: Exit 0', steps.install.exit, 0),
    eq('/quota-pacer:setup: Exit 0, success', `${steps.setup.exit}/${steps.setup.subtype}`, '0/success'),
    truthy('/quota-pacer:setup: ${CLAUDE_PLUGIN_ROOT} im Skill-Text ersetzt (absoluter Pfad, Datei existiert)',
      pluginRoot && !pluginRoot.includes('${') && path.isAbsolute(pluginRoot) && fs.existsSync(path.join(pluginRoot, 'scripts', 'pacer.js')), steps.setup.commands.map((c) => rel(h, c))),
    eq('/quota-pacer:setup: genau der install-Befehl', steps.setup.commands.join('|'), pluginRoot ? expectedCommand(pluginRoot, 'install') : '?'),
    eq('/quota-pacer:setup: keine Ablehnung durch allowed-tools', JSON.stringify(steps.setup.denials), '[]'),
    truthy('/quota-pacer:setup: Ausgabe „Sensor installiert“, kein Fehler', /Sensor installiert/.test(resultText(steps.setup)) && steps.setup.results.every((x) => !x.isError), steps.setup.results.map((x) => rel(h, x.text))),
    eq('settings.json: statusLine zeigt auf den Sensor', afterSetup.statusLine && afterSetup.statusLine.command, ours),
    eq('chain.json: vorherige Statusline gespeichert', chain && chain.command, PREV.command),
    eq('/quota-pacer:status: Exit 0, success', `${steps.status.exit}/${steps.status.subtype}`, '0/success'),
    eq('/quota-pacer:status: status, dann doctor', steps.status.commands.join('|'), pluginRoot ? `${expectedCommand(pluginRoot, 'status')}|${expectedCommand(pluginRoot, 'doctor')}` : '?'),
    eq('/quota-pacer:status: keine Ablehnung durch allowed-tools', JSON.stringify(steps.status.denials), '[]'),
    truthy('/quota-pacer:status: status-Ausgabe', /quota-pacer 1\.1\.0 – Stufe/.test(resultText(steps.status)), steps.status.results.map((x) => rel(h, x.text))),
    truthy('/quota-pacer:status: doctor meldet den Sensor als OK', /\[OK {2}\] Sensor \(statusLine\)/.test(resultText(steps.status)), null),
    truthy('/quota-pacer:status: doctor warnt beim API-Key-Login', /\[WARN\] Login: ANTHROPIC_API_KEY/.test(resultText(steps.status)) && /Login prüfen/.test(resultText(steps.status)), null),
    eq('/quota-pacer:setup uninstall: Exit 0, success', `${steps.uninstallSkill.exit}/${steps.uninstallSkill.subtype}`, '0/success'),
    eq('/quota-pacer:setup uninstall: genau der uninstall-Befehl', steps.uninstallSkill.commands.join('|'), pluginRoot ? expectedCommand(pluginRoot, 'uninstall') : '?'),
    eq('/quota-pacer:setup uninstall: keine Ablehnung', JSON.stringify(steps.uninstallSkill.denials), '[]'),
    eq('settings.json: vorherige Statusline wiederhergestellt', afterUninstall.statusLine && afterUninstall.statusLine.command, PREV.command),
    eq('plugin uninstall: Exit 0', steps.pluginUninstall.exit, 0),
    eq('marketplace remove: Exit 0', steps.marketplaceRemove.exit, 0),
    eq('marketplace remove: Eintrag extraKnownMarketplaces entfernt', afterRemove.marketplaceEntry, false),
  ];
  const facts = {
    pluginRootInSkill: pluginRoot ? rel(h, pluginRoot) : null,
    pluginCacheBytes: cacheBytes,
    afterPluginUninstall,
    afterMarketplaceRemove: afterRemove,
  };
  return { h, steps, checks, facts };
}

async function sequenceB(mock, port, proxy) {
  const h = mkHome('skills-b');
  const env = buildEnv({ home: h.home, mockPort: port, proxyPort: proxy.port, auth: 'apikey' });
  const settingsFile = path.join(h.claudeDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: PREV }, null, 2));
  const steps = {};
  steps.add = plugin(h, env, ['marketplace', 'add', ROOT]);
  steps.install = plugin(h, env, ['install', 'quota-pacer@ari-auto-pacing']);
  steps.setup = await skill(h, env, mock, '/quota-pacer:setup');
  steps.pluginUninstallFirst = plugin(h, env, ['uninstall', 'quota-pacer']);
  const afterPlugin = readJson(settingsFile) || {};
  const sensor = path.join(h.pacerHome, 'bin', 'statusline.js');
  const sl = spawnSync(process.execPath, [sensor], { input: '{}', env: { PATH: env.PATH, HOME: h.home, CLAUDE_CONFIG_DIR: h.claudeDir }, encoding: 'utf8' });
  // Documented fallback, run like a user would in a terminal (HOME = the temp HOME).
  const fb = spawnSync(process.execPath, [path.join(h.pacerHome, 'bin', 'pacer.js'), 'uninstall'], { env: { PATH: env.PATH, HOME: h.home, CLAUDE_CONFIG_DIR: h.claudeDir }, encoding: 'utf8' });
  steps.fallback = { exit: fb.status, out: rel(h, fb.stdout).trim() };
  const afterFallback = readJson(settingsFile) || {};
  const ours = `node "${sensor}"`;
  const checks = [
    eq('B: /quota-pacer:setup: Exit 0, success', `${steps.setup.exit}/${steps.setup.subtype}`, '0/success'),
    eq('B: plugin uninstall zuerst: Exit 0', steps.pluginUninstallFirst.exit, 0),
    eq('B: Sensor bleibt danach in settings.json', afterPlugin.statusLine && afterPlugin.statusLine.command, ours),
    truthy('B: Sensor läuft weiter (vorherige Statusline + pacing)', /PREVLINE\s+pacing/.test(sl.stdout || ''), (sl.stdout || '').trim()),
    eq('B: Rückfall pacer.js uninstall aus dem Datenverzeichnis: Exit 0', steps.fallback.exit, 0),
    eq('B: vorherige Statusline wiederhergestellt', afterFallback.statusLine && afterFallback.statusLine.command, PREV.command),
  ];
  return { h, steps, checks };
}

async function main() {
  // Temp HOME for the version call too, like the other runners (never the real ~/.claude).
  const vh = mkHome('version');
  const version = (spawnSync(CLAUDE, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: vh.home, CLAUDE_CONFIG_DIR: vh.claudeDir, DISABLE_AUTOUPDATER: '1' } }).stdout || '').trim();
  fs.rmSync(vh.home, { recursive: true, force: true });
  const mock = createMock({ skillMode: true, fakeSecrets: [FAKE_API_KEY], resultChars: 4000 });
  const port = await mock.listen();
  const proxy = await startBlackHole();
  const started = new Date().toISOString();
  let a;
  let b;
  try {
    a = await sequenceA(mock, port, proxy);
    b = await sequenceB(mock, port, proxy);
  } finally {
    await mock.close();
    await proxy.close();
  }
  const msgs = mock.requests.filter((q) => q.role !== 'non-messages');
  const generic = [
    truthy('Alle API-Anfragen mit Fake-Credential', msgs.length > 0 && msgs.every((q) => q.auth.xApiKey && q.auth.xApiKey.fake), msgs.length),
    eq('Keine Verbindung nach außen (Proxy-Log)', proxy.log.length, 0),
  ];
  const checks = [...a.checks, ...b.checks, ...generic];
  const passed = checks.filter((c) => c.pass).length;
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.pass ? '' : `  -> ${JSON.stringify(c.actual)} (erwartet ${JSON.stringify(c.expected)})`}`);
  console.log(`\nPlugin-Root im Skill: ${a.facts.pluginRootInSkill}`);
  console.log(`Plugin-Cache nach install: ${(a.facts.pluginCacheBytes / 1e6).toFixed(1)} MB`);
  console.log(`Nach plugin uninstall: Cache vorhanden ${a.facts.afterPluginUninstall.cache}, Marketplace-Eintrag ${a.facts.afterPluginUninstall.marketplaceEntry}`);
  console.log(`Nach marketplace remove: Cache vorhanden ${a.facts.afterMarketplaceRemove.cache}, Marketplace-Eintrag ${a.facts.afterMarketplaceRemove.marketplaceEntry}, Datenverzeichnis ${a.facts.afterMarketplaceRemove.dataDir}`);
  console.log(`\n${passed}/${checks.length} Prüfungen bestanden – ${version}, Sandbox ${useSandbox(SANDBOX) ? 'an' : 'aus'}`);
  const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'h' ? undefined : v)));
  const report = { started, finished: new Date().toISOString(), claudeCode: version, sandbox: useSandbox(SANDBOX), passed, total: checks.length, checks, facts: a.facts, sequenceA: strip(a.steps), sequenceB: strip(b.steps) };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'skills-report.json'), JSON.stringify(report, (k, v) => (typeof v === 'string' ? v.split(a.h.home).join('<tmp-home>').split(b.h.home).join('<tmp-home>').split(ROOT).join('<repo>') : v), 2));
  console.log('Bericht: test/e2e/results/skills-report.json');
  if (!KEEP) for (const x of [a, b]) fs.rmSync(x.h.home, { recursive: true, force: true });
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
