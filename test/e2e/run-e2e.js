#!/usr/bin/env node
'use strict';
// Headless end-to-end proof against the real Claude Code CLI.
// For every scenario: fresh temp HOME (CLAUDE_CONFIG_DIR inside it), seeded quota samples,
// explicit config.json, a local mock of the Messages API, one `claude -p` run. The mock
// records model and arrival time of every request; the plugin's decisions.jsonl records
// what it decided. Checks assert on both.
//
// Usage: node test/e2e/run-e2e.js [--claude <path>] [--only a,b] [--rounds N] [--jobs N]
//                                 [--no-sandbox] [--keep]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createMock } = require('./mock-api');
const { FAKE_API_KEY, FAKE_OAUTH, mkHome, startBlackHole, buildEnv, runClaude, runClaudeSync, useSandbox } = require('./lib/env');
const { PRESETS, precheck } = require('./lib/samples');
const { SCENARIOS } = require('./scenarios');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'results');
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CLAUDE = argVal('--claude') || process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const ONLY = (argVal('--only') || '').split(',').filter(Boolean);
const ROUNDS = Math.max(1, Number(argVal('--rounds')) || 1);
const JOBS = Math.max(1, Number(argVal('--jobs')) || 3);
const SANDBOX = !args.includes('--no-sandbox');
const KEEP = args.includes('--keep');

function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { kind: 'unparseable-line' }; } });
  } catch { return []; }
}
const eq = (name, actual, expected) => ({ name, pass: actual === expected, actual, expected });

function setupHome(sc, now) {
  const h = mkHome(sc.name);
  if (sc.samples) writeJson(path.join(h.pacerHome, 'samples.json'), { v: 1, samples: PRESETS[sc.samples](now) });
  if (sc.config) writeJson(path.join(h.pacerHome, 'config.json'), sc.config);
  for (const [name, model] of Object.entries(sc.agents || {})) {
    const fm = [`name: ${name}`, `description: E2E test agent ${name}`];
    if (model) fm.push(`model: ${model}`);
    fs.mkdirSync(path.join(h.project, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(h.project, '.claude', 'agents', `${name}.md`), `---\n${fm.join('\n')}\n---\nAnswer briefly.\n`);
  }
  if (sc.projectSettings) writeJson(path.join(h.project, '.claude', 'settings.json'), sc.projectSettings);
  for (const spec of [...sc.steps, ...(sc.subTools || [])]) {
    if (spec.file) fs.writeFileSync(path.join(h.project, spec.file), `content of ${spec.file}\n`);
  }
  return h;
}

function toolSpec(spec, project) {
  return { tool: spec.tool, input: { file_path: path.join(project, spec.file) } };
}

// Gaps (ms) between a request that answered with a tool call and the next request of
// the same thread: that is where a PreToolUse pause shows up.
function gapsAfterTools(list) {
  const out = [];
  for (let i = 0; i + 1 < list.length; i++) if (list[i].action === 'tool') out.push(list[i + 1].t - list[i].t);
  return out;
}

function analyse({ sc, mock, run, h, proxy, installOk, installedKeys }) {
  const lines = run.out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = lines.find((l) => l.type === 'result') || {};
  const systemMessages = lines.filter((l) => l.type === 'system' && l.subtype === 'informational' && typeof l.content === 'string').map((l) => l.content);
  const reqs = mock.requests;
  const msgs = reqs.filter((q) => q.role !== 'non-messages');
  const main = msgs.filter((q) => q.role === 'main');
  const subMap = new Map();
  for (const q of msgs.filter((x) => x.role === 'sub')) {
    if (!subMap.has(q.subKey)) subMap.set(q.subKey, { key: q.subKey, model: q.model, models: [], times: [], actions: [], list: [] });
    const s = subMap.get(q.subKey);
    s.models.push(q.model); s.times.push(q.t); s.actions.push(q.action); s.list.push(q);
  }
  const subs = [...subMap.values()];
  const spawned = main.flatMap((q) => q.spawned);
  const agentIds = new Set(spawned.map((s) => s.id));
  const seen = new Map();
  for (const q of main) for (const tr of q.toolResults) if (!seen.has(tr.id)) seen.set(tr.id, tr);
  const agentResults = spawned.map((s) => seen.get(s.id)).filter(Boolean);
  const mainToolResults = [...seen.values()].filter((tr) => !agentIds.has(tr.id));
  const verdicts = {};
  for (const q of msgs) if (q.safeguardResults) for (const [id, v] of Object.entries(q.safeguardResults)) verdicts[id] = v.outcome || v.type;
  const decisionsFile = path.join(h.pacerHome, 'decisions.jsonl');
  const decisions = readJsonl(decisionsFile);
  const firstSpawn = main.find((q) => q.action === 'spawn');
  const firstSub = subs.length ? Math.min(...subs.map((s) => s.times[0])) : null;
  return {
    exitCode: run.code,
    signal: run.signal,
    durationMs: run.ms,
    resultSubtype: result.subtype || null,
    mainModel: main[0] ? main[0].model : null,
    pacingContext: main[0] ? main[0].pacingContext : null,
    subs: subs.map((s) => ({ key: s.key, model: s.model, models: s.models, actions: s.actions, times: s.times })),
    spawned,
    agentResults,
    mainToolResults,
    classifier: msgs.filter((q) => q.role === 'classifier').map((q) => ({ model: q.model, action: q.action, verdict: q.verdict })),
    verdictFor: (id) => (id ? verdicts[id] || null : null),
    mainToolGaps: gapsAfterTools(main),
    subToolGaps: subs.flatMap((s) => gapsAfterTools(s.list)),
    agentGapMs: firstSpawn && firstSub !== null ? firstSub - firstSpawn.t : null,
    timeline: msgs.map((q) => ({ n: q.n, dt: q.t - msgs[0].t, role: q.role, action: q.action, model: q.model, sub: q.subKey || undefined })),
    systemMessages,
    decisionsExists: fs.existsSync(decisionsFile),
    decisions,
    preAgent: decisions.filter((d) => d.kind === 'pre-agent'),
    throttle: decisions.filter((d) => d.kind === 'throttle'),
    throttleSkip: decisions.filter((d) => d.kind === 'throttle-skip'),
    errors: decisions.filter((d) => d.kind === 'error' || d.kind === 'unparseable-line'),
    apiRequests: msgs.length,
    headerNames: [...new Set(reqs.flatMap((q) => q.headerNames))].sort(),
    toolsOffered: { main: main[0] ? main[0].tools : null, sub: subs[0] ? subs[0].list[0].tools : null },
    unauthenticated: msgs.filter((q) => !((q.auth.xApiKey && q.auth.xApiKey.fake) || (q.auth.authorization && q.auth.authorization.fake))).length,
    nonMessagePaths: reqs.filter((q) => q.role === 'non-messages').map((q) => `${q.method} ${q.path}`),
    unknownRoles: msgs.filter((q) => q.role === 'other' || q.role === 'mock-error').map((q) => `${q.role}:${q.action}:${q.model}`),
    outsideConnections: proxy.log.slice(),
    installOk,
    installedKeys,
    stderrTail: run.err.slice(-1500),
  };
}

function genericChecks(sc, r) {
  const checks = [
    eq('Claude Code Exit-Code', r.exitCode, 0),
    eq('Lauf abgeschlossen (result.subtype)', r.resultSubtype, 'success'),
    eq('Alle API-Anfragen mit Fake-Credential', r.unauthenticated, 0),
    eq('Keine Verbindung nach außen (Proxy-Log)', r.outsideConnections.length, 0),
  ];
  if (sc.plugin !== false) {
    checks.push(eq('Genau eine pre-agent-Zeile pro Agent-Aufruf', r.preAgent.length, r.spawned.length));
    checks.push({ name: 'Keine Fehler im Plugin-Log', pass: r.errors.length === 0, actual: r.errors.map((e) => `${e.where}: ${String(e.message).split('\n')[0]}`), expected: [] });
    const strategy = (sc.config && sc.config.strategy) || 'throttle';
    if (strategy === 'downgrade') checks.push(eq('downgrade: keine Drossel-Pause', r.throttle.length, 0));
  }
  return checks;
}

async function runScenario(sc) {
  const t0 = Date.now();
  const now = Date.now();
  const h = setupHome(sc, now);
  const pre = sc.samples ? precheck(PRESETS[sc.samples](now), sc.config, now) : { level: 'unknown', waitSec: 0 };
  const mock = createMock({
    mainSteps: sc.steps.map((s) => (s.tool ? toolSpec(s, h.project) : s)),
    subTools: (sc.subTools || []).map((s) => toolSpec(s, h.project)),
    fakeSecrets: [FAKE_API_KEY, FAKE_OAUTH],
    ...(sc.mock || {}),
  });
  const port = await mock.listen();
  const proxy = await startBlackHole();
  const env = buildEnv({ home: h.home, mockPort: port, proxyPort: proxy.port, extra: sc.env || {} });
  const opts = { cwd: h.project, env, home: h.home, sandbox: SANDBOX };
  let installOk = null;
  let installedKeys = [];
  let installLog = null;
  try {
    const argv = ['-p', 'E2E-MAIN: run the task.', '--output-format', 'stream-json', '--verbose',
      '--model', sc.mainModel || 'opus', '--permission-mode', sc.permissionMode || 'default'];
    if (sc.plugin === 'marketplace') {
      const a = runClaudeSync(CLAUDE, ['plugin', 'marketplace', 'add', ROOT], opts);
      const b = runClaudeSync(CLAUDE, ['plugin', 'install', 'quota-pacer@ari-auto-pacing'], opts);
      installOk = a.code === 0 && b.code === 0;
      installLog = `${a.out}${a.err}\n${b.out}${b.err}`.trim().slice(0, 1000);
      try { installedKeys = Object.keys(JSON.parse(fs.readFileSync(path.join(h.claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}); } catch { installedKeys = []; }
    } else if (sc.plugin !== false) {
      argv.push('--plugin-dir', ROOT);
    }
    const run = await runClaude(CLAUDE, argv, opts);
    await mock.close();
    await proxy.close();
    const r = analyse({ sc, mock, run, h, proxy, installOk, installedKeys });
    const preChecks = [];
    if (sc.expectPre) {
      for (const [k, v] of Object.entries(sc.expectPre)) preChecks.push(eq(`Vorbedingung (Plugin-Code): ${k}`, pre[k], v));
    }
    let checks;
    try {
      checks = [...preChecks, ...genericChecks(sc, r), ...sc.expect(r)];
    } catch (e) {
      checks = [{ name: 'expect() ohne Ausnahme', pass: false, actual: String(e && e.stack), expected: 'no exception' }];
    }
    const pass = checks.every((c) => c.pass);
    const evidence = { ...r };
    delete evidence.verdictFor;
    if (pass) { delete evidence.decisions; delete evidence.stderrTail; }
    return {
      name: sc.name, title: sc.title, group: sc.group, samples: sc.samples, config: sc.config, permissionMode: sc.permissionMode || 'default',
      precondition: pre, pass, durationMs: Date.now() - t0, checks, evidence, installLog,
    };
  } finally {
    if (KEEP) console.log(`   (kept ${h.home})`);
    else fs.rmSync(h.home, { recursive: true, force: true });
  }
}

async function runPool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  return out;
}

async function main() {
  if (!fs.existsSync(CLAUDE)) throw new Error(`Claude Code CLI not found: ${CLAUDE}`);
  const vh = mkHome('version');
  const version = (spawnSync(CLAUDE, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: vh.home, CLAUDE_CONFIG_DIR: vh.claudeDir, DISABLE_AUTOUPDATER: '1' } }).stdout || '').trim();
  fs.rmSync(vh.home, { recursive: true, force: true });
  const selected = SCENARIOS.filter((s) => !ONLY.length || ONLY.includes(s.name));
  const unknown = ONLY.filter((n) => !SCENARIOS.some((s) => s.name === n));
  if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(', ')}`);
  console.log(`quota-pacer E2E – Claude Code ${version}, Node ${process.version}, ${process.platform}-${process.arch}, sandbox ${useSandbox(SANDBOX) ? 'an' : 'aus'}, ${selected.length} Szenarien × ${ROUNDS} Runde(n), ${JOBS} parallel`);
  const started = new Date().toISOString();
  const rounds = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const t0 = Date.now();
    const results = await runPool(selected, JOBS, async (sc) => {
      const res = await runScenario(sc);
      console.log(`[${round}] ${res.pass ? 'PASS' : 'FAIL'} ${sc.name} (${(res.durationMs / 1000).toFixed(1)} s)`);
      if (!res.pass) {
        for (const c of res.checks.filter((x) => !x.pass)) console.log(`      - ${c.name}: erwartet ${JSON.stringify(c.expected)}, erhalten ${JSON.stringify(c.actual)}`);
      }
      return res;
    });
    rounds.push({ round, durationMs: Date.now() - t0, passed: results.filter((x) => x.pass).length, total: results.length, results });
    console.log(`Runde ${round}: ${rounds[round - 1].passed}/${results.length} bestanden (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  const perScenario = selected.map((sc) => {
    const rs = rounds.map((r) => r.results.find((x) => x.name === sc.name));
    return { name: sc.name, title: sc.title, group: sc.group, passed: rs.filter((x) => x.pass).length, rounds: rs.length, durationsMs: rs.map((x) => x.durationMs) };
  });
  const passed = rounds.reduce((a, r) => a + r.passed, 0);
  const total = rounds.reduce((a, r) => a + r.total, 0);
  const report = {
    plugin: 'quota-pacer 1.1.0', claudeCode: version, claudePath: CLAUDE, node: process.version, platform: `${process.platform}-${process.arch}`,
    sandbox: useSandbox(SANDBOX), started, finished: new Date().toISOString(), rounds: ROUNDS, scenarios: selected.length,
    passed, total, summary: perScenario, runs: rounds,
  };
  writeJson(path.join(OUT_DIR, 'e2e-report.json'), report);
  console.log('\nSzenario                              bestanden');
  for (const s of perScenario) console.log(`  ${s.name.padEnd(36)} ${s.passed}/${s.rounds}`);
  console.log(`\n${passed}/${total} Läufe bestanden (${selected.length} Szenarien × ${ROUNDS} Runden) – Claude Code ${version}`);
  console.log(`Bericht: ${path.relative(process.cwd(), path.join(OUT_DIR, 'e2e-report.json'))}`);
  process.exitCode = passed === total ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
