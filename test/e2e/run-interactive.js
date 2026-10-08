#!/usr/bin/env node
'use strict';
// Interactive end-to-end proof: the real Claude Code TUI in a pseudo terminal
// (test/e2e/pty-driver.py, python3 with pty; macOS/Linux) against the local mock API.
// Every run: fresh temp HOME with CLAUDE_CONFIG_DIR inside it, env from a whitelist, fake
// credentials only, the sensor installed with `node scripts/pacer.js install` in that
// HOME, then `claude --plugin-dir <repo>` in its default configuration (auto mode,
// background agents). The runner types into the TUI, reads the emulated screen, and
// checks what the mock recorded, what the plugin wrote (samples.json, decisions.jsonl,
// session state) and what the screen shows.
//
//   R1 full sensor path: OAuth (fake token), NO seeded samples; the mock sends the
//      anthropic-ratelimit-unified-* headers, the status line gets rate_limits, the sensor
//      writes samples.json, the segment shows ROT 86 %, the hooks act on those numbers
//   R2 strategy downgrade, auto mode: re-issue with haiku, classifier verdict, subagent on haiku
//   R3 default strategy (throttle) ahead of schedule: "Drossel" segment and notice, pauses
//      between API requests, models unchanged
//   R4 /model haiku inside the TUI: PostModelSwitch updates the main model, no upgrade
//
// Usage: node test/e2e/run-interactive.js [--claude <path>] [--only R1,R3] [--rounds N]
//                                         [--no-sandbox] [--keep]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createMock } = require('./mock-api');
const { FAKE_API_KEY, FAKE_OAUTH, mkHome, startBlackHole, buildEnv, assertSafeEnv, useSandbox } = require('./lib/env');
const { PRESETS, precheck } = require('./lib/samples');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'results');
const DRIVER = path.join(__dirname, 'pty-driver.py');
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CLAUDE = argVal('--claude') || process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const ONLY = (argVal('--only') || '').split(',').filter(Boolean);
const ROUNDS = Math.max(1, Number(argVal('--rounds')) || 1);
const SANDBOX = !args.includes('--no-sandbox');
const KEEP = args.includes('--keep');
const ROWS = 50;
const COLS = 200;

const MAIN = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-4-5-20251001';
const WAIT = 2.5; // maxWaitSec of the throttle runs: short runs, pause still obvious
const PAUSE_MIN_MS = WAIT * 1000 - 50;
const HOOK_ERROR = /^PreToolUse:Agent hook error: /;
const REISSUE_TEXT = /^(?:PreToolUse:Agent hook error: )?Usage pacing level (?:AMBER|RED): this subagent should run on the cheaper model haiku/;

// Same profile as lib/env.js: every outbound connection except localhost is denied.
function sandboxProfile(home) {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    '(allow network-outbound (remote ip "localhost:*"))',
    `(allow network-outbound (remote unix-socket (subpath "${home}")))`,
    '(allow network-outbound (remote unix-socket (subpath "/private/tmp")))',
    '(allow network-outbound (remote unix-socket (subpath "/tmp")))',
  ].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { kind: 'unparseable-line' }; } });
  } catch { return []; }
}
const flat = (s) => String(s || '').replace(/\s+/g, ' ');

function eq(name, actual, expected) { return { name, pass: actual === expected, actual, expected }; }
function same(name, actual, expected) { return { name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected }; }
function truthy(name, cond, actual, expected = true) { return { name, pass: !!cond, actual: actual === undefined ? !!cond : actual, expected }; }
function atLeast(name, actual, min) { return { name, pass: Number.isFinite(actual) && actual >= min, actual, expected: `>= ${min}` }; }
function allAtLeast(name, values, min) { return { name, pass: values.length > 0 && values.every((v) => v >= min), actual: values, expected: `all >= ${min} (n>0)` }; }

// ---------------------------------------------------------------------------------------
// TUI session: talks JSON lines with pty-driver.py (screen snapshots, keystrokes).

class Tui {
  constructor(child) {
    this.child = child;
    this.t0 = Date.now();
    this.nextId = 1;
    this.waiters = new Map();
    this.timeline = [];
    this.exit = null;
    this.done = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    this.stderr = '';
    child.stderr.on('data', (d) => { this.stderr += d; });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.op === 'exit') { this.exit = m; this.mark({ exit: m.status }); }
        if (m.op === 'screen' && this.waiters.has(m.id)) { this.waiters.get(m.id)(m); this.waiters.delete(m.id); }
      }
    });
  }

  mark(entry) { this.timeline.push({ t: Math.round((Date.now() - this.t0) / 100) / 10, ...entry }); }

  write(obj) { try { this.child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* driver gone */ } }

  send(text) { this.mark({ send: text }); this.write({ op: 'send', text }); }

  async typeLine(text) {
    this.send(text);
    await sleep(700);
    this.send('\r');
  }

  screen() {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(id); resolve({ screen: '', all: '', alive: false }); }, 5000);
      this.waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.write({ op: 'screen', id });
    });
  }

  // Waits until the regex matches the visible screen (where 'screen') or scrollback plus
  // screen ('all'), whitespace collapsed so wrapped lines still match.
  async waitFor(re, timeoutMs, { where = 'all', label } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.screen();
      const m = re.exec(flat(where === 'screen' ? s.screen : s.all));
      if (m || Date.now() >= end || (!s.alive && this.exit)) {
        this.mark({ waitfor: label || String(re), ok: !!m });
        return m ? m[0] : null;
      }
      await sleep(250);
    }
  }

  async waitUntil(fn, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let v;
      try { v = await fn(); } catch { v = null; }
      if (v || Date.now() >= end) { this.mark({ waitUntil: label, ok: !!v }); return v || null; }
      await sleep(200);
    }
  }

  async quit(graceSec = 0) {
    this.write({ op: 'quit', grace: graceSec });
    try { this.child.stdin.end(); } catch { /* ignore */ }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), (graceSec + 15) * 1000);
    const code = await this.done;
    clearTimeout(timer);
    return code;
  }
}

function startTui({ argv, env, cwd, home, outPrefix }) {
  assertSafeEnv(env, home);
  const specFile = path.join(home, 'tmp', 'pty-spec.json');
  writeJson(specFile, { argv, env, cwd, rows: ROWS, cols: COLS }); // the driver deletes it on start
  const py = ['/usr/bin/python3', '-I', DRIVER, specFile, outPrefix];
  const cmd = useSandbox(SANDBOX) ? ['/usr/bin/sandbox-exec', '-p', sandboxProfile(home), ...py] : py;
  // Asynchronous on purpose: the mock lives in this process, a sync spawn would block it.
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: home } });
  return new Tui(child);
}

// ---------------------------------------------------------------------------------------
// Request analysis (what the mock recorded)

function analyseRequests(mock) {
  const reqs = mock.requests;
  const msgs = reqs.filter((q) => q.role !== 'non-messages');
  // The TUI also sends side requests that quote the prompt but offer no Agent tool (e.g.
  // on claude-haiku); they are not turns of the main thread.
  const side = msgs.filter((q) => q.role === 'main' && q.action === 'no-agent-tool');
  const main = msgs.filter((q) => q.role === 'main' && q.action !== 'no-agent-tool');
  const subMap = new Map();
  for (const q of msgs.filter((x) => x.role === 'sub')) {
    if (!subMap.has(q.subKey)) subMap.set(q.subKey, { key: q.subKey, model: q.model, models: [], times: [], actions: [] });
    const s = subMap.get(q.subKey);
    s.models.push(q.model); s.times.push(q.t); s.actions.push(q.action);
  }
  const subs = [...subMap.values()];
  const spawned = main.flatMap((q) => q.spawned.map((s) => ({ ...s, t: q.t, safeguards: q.safeguardsRequested })));
  const agentIds = new Set(spawned.map((s) => s.id));
  const seen = new Map();
  for (const q of main) for (const tr of q.toolResults) if (!seen.has(tr.id)) seen.set(tr.id, tr);
  const verdicts = {};
  for (const q of msgs) if (q.safeguardResults) for (const [id, v] of Object.entries(q.safeguardResults)) verdicts[id] = v.outcome || v.type;
  const gaps = [];
  for (let i = 0; i + 1 < main.length; i++) if (main[i].action === 'tool') gaps.push(main[i + 1].t - main[i].t);
  const firstSub = subs.length ? Math.min(...subs.map((s) => s.times[0])) : null;
  const ranSpawn = spawned.find((s) => subs.some((x) => x.key && s.prompt.includes(`E2E-SUB ${x.key}:`)));
  return {
    msgs,
    main,
    subs,
    spawned,
    agentResults: spawned.map((s) => seen.get(s.id)).filter(Boolean),
    mainToolResults: [...seen.values()].filter((tr) => !agentIds.has(tr.id)),
    verdicts,
    mainToolGaps: gaps,
    agentGapMs: ranSpawn && firstSub !== null ? firstSub - ranSpawn.t : null,
    pacingContexts: main.map((q) => q.pacingContext).filter(Boolean),
    unauthenticated: msgs.filter((q) => !((q.auth.xApiKey && q.auth.xApiKey.fake) || (q.auth.authorization && q.auth.authorization.fake))).length,
    authSchemes: [...new Set(msgs.map((q) => (q.auth.authorization ? `bearer:${q.auth.authorization.scheme}` : (q.auth.xApiKey ? 'x-api-key' : 'none'))))],
    timeline: msgs.map((q) => ({ n: q.n, dt: q.t - msgs[0].t, role: q.role, action: q.action, model: q.model, sub: q.subKey || undefined, rl: q.rateLimitHeaders || undefined })),
    nonMessagePaths: reqs.filter((q) => q.role === 'non-messages').map((q) => `${q.method} ${q.path}`),
    side: side.map((q) => ({ n: q.n, model: q.model, tools: q.tools })),
  };
}

// The pacing segment as the status line prints it (last occurrence on the screen).
function segments(text) {
  return (flat(text).match(/pacing (?:GRÜN|GELB|ROT|STOPP|KEINE DATEN)(?: (?:5h|7d|Drossel) [^ ]+)*/g) || []);
}

// ---------------------------------------------------------------------------------------
// Runs

const OAUTH_NOW = () => Math.floor(Date.now() / 1000);

function rateLimitHeaders() {
  const now = OAUTH_NOW();
  const h5 = now + 3 * 3600 + 50 * 60; // window started 70 min ago
  const h7 = now + 4 * 86400 + 600;
  return {
    h5,
    h7,
    fn: () => ({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.86',
      'anthropic-ratelimit-unified-5h-reset': String(h5),
      'anthropic-ratelimit-unified-7d-utilization': '0.391',
      'anthropic-ratelimit-unified-7d-reset': String(h7),
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': String(h5),
    }),
  };
}

// Status line that the installer finds already configured and chains: an independent
// observer of what Claude Code passes to status line commands (only rate_limits and the
// model id are written, never the environment).
const SL_DUMP = `'use strict';
const fs = require('fs');
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw); } catch { j = {}; }
  fs.appendFileSync(process.argv[2], JSON.stringify({ t: Date.now(), session: j.session_id || null, model: (j.model && j.model.id) || null, rate_limits: j.rate_limits === undefined ? null : j.rate_limits }) + '\\n');
  const f = j.rate_limits && j.rate_limits.five_hour;
  process.stdout.write('SL-PROBE rl5h=' + (f ? f.used_percentage : 'none') + '\\n');
});
`;

// Probe plugin (second --plugin-dir) that records the PostModelSwitch event itself.
function writeProbePlugin(dir, logFile) {
  writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name: 'e2e-probe', version: '0.0.1', description: 'E2E observer' });
  writeJson(path.join(dir, 'hooks', 'hooks.json'), {
    hooks: { PostModelSwitch: [{ hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/probe.js', logFile], timeout: 5 }] }] },
  });
  fs.writeFileSync(path.join(dir, 'probe.js'), `'use strict';
const fs = require('fs');
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw); } catch { j = {}; }
  const keep = ['hook_event_name', 'session_id', 'from_model', 'to_model', 'requested_model', 'source'];
  fs.appendFileSync(process.argv[2], JSON.stringify({ t: Date.now(), ...Object.fromEntries(keep.map((k) => [k, j[k] === undefined ? null : j[k]])) }) + '\\n');
});
`);
}

const RUNS = [
  {
    id: 'R1',
    name: 'sensor-oauth-full-path',
    title: 'Voller Sensorpfad: OAuth, Ratelimit-Header → rate_limits → samples.json → Segment ROT 86 % → Hooks',
    auth: 'oauth',
    env: { CLAUDE_CODE_SUBSCRIPTION_TYPE: 'team' },
    samples: null,
    config: { strategy: 'both', throttle: { maxWaitSec: WAIT } },
    chainDump: true,
    rateLimits: true,
    steps: (p) => [{ say: 'MAIN-READY' }, { agents: 1 }, { tool: 'Read', input: { file_path: path.join(p, 'f1.txt') } }],
    files: ['f1.txt'],
    async flow(c) {
      c.ev.startScreen = await c.tui.waitFor(/pacing KEINE DATEN/, 40000, { label: 'segment before the first response' });
      c.ev.samplesBefore = fs.existsSync(path.join(c.h.pacerHome, 'samples.json'));
      await c.tui.typeLine('E2E-MAIN: first turn.');
      await c.tui.waitFor(/MAIN-READY/, 40000);
      c.ev.segmentAfterFirst = await c.tui.waitFor(/pacing ROT 5h 86%[^|]*?Drossel \d+s/, 45000, { where: 'screen', label: 'segment ROT 86% from the sensor' });
      c.ev.samplesAfterFirst = (readJson(path.join(c.h.pacerHome, 'samples.json')) || { samples: [] }).samples.length;
      await c.tui.typeLine('E2E-NEXT: run the task.');
      await c.tui.waitFor(/MAIN-DONE/, 60000);
      await c.tui.waitUntil(() => c.mock.requests.some((q) => q.role === 'sub' && q.action === 'handback'), 30000, 'subagent handback');
      await sleep(4000);
    },
    checks(r) {
      const rl = r.rl;
      const dump = r.slDump.filter((x) => x.rate_limits);
      const fiveOk = (x) => x.rate_limits.five_hour && x.rate_limits.five_hour.used_percentage === 86 && x.rate_limits.five_hour.resets_at === rl.h5;
      const sevenOk = (x) => x.rate_limits.seven_day && x.rate_limits.seven_day.used_percentage === 39.1 && x.rate_limits.seven_day.resets_at === rl.h7;
      const samples = r.samples;
      const thr = r.decisions.filter((d) => d.kind === 'throttle');
      return [
        eq('Keine vorab gesäten Messpunkte (samples.json fehlt beim Start)', r.ev.samplesBefore, false),
        truthy('Segment vor der ersten Antwort: "pacing KEINE DATEN"', r.ev.startScreen, r.ev.startScreen),
        same('Nur OAuth (Bearer, Fake-Token), kein x-api-key', r.req.authSchemes, ['bearer:Bearer']),
        truthy('Mock sendet anthropic-ratelimit-unified-* auf jeder Messages-Antwort', r.req.msgs.length > 0 && r.req.msgs.every((q) => q.rateLimitHeaders === 7), r.req.msgs.map((q) => q.rateLimitHeaders)),
        truthy('Statuszeile erhält rate_limits (5h 86 = 0.86×100, resets_at = Header)', dump.length > 0 && dump.every(fiveOk), dump.slice(-1).map((x) => x.rate_limits)),
        truthy('Statuszeile erhält rate_limits (7d 39.1 = 0.391×100)', dump.length > 0 && dump.every(sevenOk), dump.slice(-1).map((x) => x.rate_limits && x.rate_limits.seven_day)),
        truthy('Vor der ersten API-Antwort kein rate_limits', r.slDump.length > 0 && r.slDump[0].rate_limits === null, r.slDump.slice(0, 1)),
        truthy('Sensor hat samples.json aus rate_limits geschrieben', samples.length > 0 && samples.every((s) => s.f && s.f.u === 86 && s.f.r === rl.h5 && s.s && s.s.u === 39.1 && s.s.r === rl.h7), samples.map((s) => ({ t: s.t, f: s.f, s: s.s }))),
        truthy('Messpunkte stammen aus dieser Sitzung', samples.length > 0 && samples.every((s) => s.t >= r.startedAt && s.t <= r.endedAt), samples.map((s) => s.t - r.startedAt)),
        truthy('Segment auf dem Bildschirm: ROT, 5h 86%, 7d 39%, Drossel', /^pacing ROT 5h 86% 7d 39% Drossel 3s$/.test(r.ev.segmentAfterFirst || ''), r.ev.segmentAfterFirst),
        truthy('Verkettete Statuszeile bleibt sichtbar (SL-PROBE rl5h=86)', /SL-PROBE rl5h=86 +pacing ROT/.test(r.screenFlat), (/SL-PROBE rl5h=\S+ +pacing \S+/.exec(r.screenFlat) || [null])[0]),
        truthy('Prompt-Hook: Kontext mit den Sensordaten an Claude', r.req.pacingContexts.some((t) => /^Usage pacing level RED: 5-hour quota 86% used; weekly quota 39% used\./.test(t)), r.req.pacingContexts[0] || null),
        truthy('Meldung "Stufe ROT (5h 86%, 7d 39%)" auf dem Bildschirm', /quota-pacer: Stufe ROT \(5h 86%, 7d 39%\)/.test(r.screenFlat), (/quota-pacer: Stufe [^.]*\./.exec(r.screenFlat) || [null])[0]),
        eq('pre-agent: Re-Issue mit Haiku, dann durchgelassen', r.preAgent.map((d) => `${d.action}:${d.reason}`).join(','), 'reissue:downgrade,none:already-at-or-below-target'),
        same('pre-agent: Stufe aus den Sensordaten, Auto-Mode', r.preAgent.map((d) => [d.level, d.permissionMode]), [['red', 'auto'], ['red', 'auto']]),
        truthy('Ablehnung (is_error) bittet um "model": "haiku"', r.req.agentResults[0] && r.req.agentResults[0].isError && REISSUE_TEXT.test(r.req.agentResults[0].text), r.req.agentResults[0] && r.req.agentResults[0].text.slice(0, 160)),
        same('Agent-Aufrufe (Modellfeld)', r.req.spawned.map((s) => s.model || null), [null, 'haiku']),
        truthy('Server-Klassifikator urteilt über den neuen Aufruf', r.req.spawned[1] && r.req.verdicts[r.req.spawned[1].id] === 'not_flagged', r.req.spawned[1] ? r.req.verdicts[r.req.spawned[1].id] : null),
        eq('Subagent auf Haiku', r.req.subs.length === 1 ? r.req.subs[0].model : r.req.subs.map((s) => s.model).join(','), HAIKU),
        truthy('Drossel nutzt die Sensordaten (used 86, 5h, waitSec 2.5)', thr.length > 0 && thr.every((d) => d.used === 86 && d.window === 'fiveHour' && d.waitSec === WAIT), thr.map((d) => [d.tool, d.waitSec, d.used, d.allowed])),
        truthy('Drossel pausiert den Read-Aufruf', thr.some((d) => d.tool === 'Read'), thr.map((d) => d.tool)),
        allAtLeast('Abstand nach Read zwischen Haupt-Anfragen (ms)', r.req.mainToolGaps, PAUSE_MIN_MS),
      ];
    },
  },
  {
    id: 'R2',
    name: 'downgrade-auto-reissue-haiku',
    title: 'Strategie downgrade, Auto-Mode (TUI-Standard): Re-Issue → Klassifikator → Subagent auf Haiku',
    auth: 'apikey',
    samples: 'amber',
    config: { strategy: 'downgrade' },
    steps: () => [{ agents: 1 }],
    async flow(c) {
      c.ev.segment = await c.tui.waitFor(/pacing GELB 5h \d+%→\d+%@\d\d:\d\d/, 40000, { where: 'screen', label: 'segment GELB' });
      await c.tui.typeLine('E2E-MAIN: run the task.');
      await c.tui.waitFor(/MAIN-DONE/, 60000);
      await c.tui.waitUntil(() => c.mock.requests.some((q) => q.role === 'sub' && q.action === 'handback'), 30000, 'subagent handback');
      await sleep(4000);
    },
    checks(r) {
      const second = r.req.spawned[1];
      const first = r.req.agentResults[0];
      return [
        truthy(`Segment "pacing GELB 5h ${r.pre.usedPct}%→…"`, new RegExp(`^pacing GELB 5h ${r.pre.usedPct}%→\\d+%@\\d\\d:\\d\\d$`).test(r.ev.segment || ''), r.ev.segment),
        truthy('Pacing-Kontext erreicht Claude (AMBER)', r.req.pacingContexts.some((t) => /^Usage pacing level AMBER: 5-hour quota \d+% used, projected \d+%/.test(t)), r.req.pacingContexts[0] || null),
        truthy('Meldung "quota-pacer: Stufe GELB" auf dem Bildschirm', /quota-pacer: Stufe GELB/.test(r.screenFlat), (/quota-pacer: Stufe [^.]*\./.exec(r.screenFlat) || [null])[0]),
        eq('pre-agent: Re-Issue, dann durchgelassen', r.preAgent.map((d) => `${d.action}:${d.reason}`).join(','), 'reissue:downgrade,none:already-at-or-below-target'),
        eq('pre-agent: permissionMode', r.preAgent.map((d) => d.permissionMode).join(','), 'auto,auto'),
        // The TUI hands the bare deny reason to Claude; -p prefixes it with "PreToolUse:Agent hook error: ".
        truthy('Ablehnung (is_error) bittet um "model": "haiku"', first && first.isError && REISSUE_TEXT.test(first.text) && /"model": "haiku" and all other fields unchanged/.test(first.text),
          first && { isError: first.isError, cliPrefix: HOOK_ERROR.test(first.text), text: first.text.slice(0, 400) }),
        same('Agent-Aufrufe (Modellfeld)', r.req.spawned.map((s) => s.model || null), [null, 'haiku']),
        truthy('Klassifikator befragt: Anfrage mit safeguards, Urteil für den neuen Aufruf', second && (second.safeguards || []).includes('dangerous_tool_use') && r.req.verdicts[second.id] === 'not_flagged', second ? { safeguards: second.safeguards, verdict: r.req.verdicts[second.id] } : null),
        eq('Gestartete Subagents', r.req.subs.length, 1),
        eq('Subagent-Modell', r.req.subs[0] && r.req.subs[0].model, HAIKU),
        eq('Hauptmodell unverändert', r.req.main[0] && r.req.main[0].model, MAIN),
      ];
    },
  },
  {
    id: 'R3',
    name: 'throttle-default-ahead',
    title: 'Standard-Strategie (Drossel) vor dem Plan: Segment und Meldung "Drossel", Pausen, Modelle unverändert',
    auth: 'apikey',
    samples: 'aheadGreen',
    config: { throttle: { maxWaitSec: WAIT } },
    steps: (p) => [{ agents: 1 }, ...['f1.txt', 'f2.txt', 'f3.txt'].map((f) => ({ tool: 'Read', input: { file_path: path.join(p, f) } }))],
    files: ['f1.txt', 'f2.txt', 'f3.txt'],
    async flow(c) {
      c.ev.segment = await c.tui.waitFor(/pacing GRÜN 5h \d+%→\d+%@\d\d:\d\d Drossel \d+s/, 40000, { where: 'screen', label: 'segment with Drossel' });
      await c.tui.typeLine('E2E-MAIN: run the task.');
      await c.tui.waitFor(/MAIN-DONE/, 90000);
      await c.tui.waitUntil(() => c.mock.requests.some((q) => q.role === 'sub' && q.action === 'handback'), 30000, 'subagent handback');
      await sleep(4000);
    },
    checks(r) {
      const thr = r.decisions.filter((d) => d.kind === 'throttle');
      const tools = thr.map((d) => d.tool);
      return [
        eq('Vorbedingung (Plugin-Code): Strategie', r.pre.strategy, 'throttle'),
        eq('Vorbedingung (Plugin-Code): waitSec', r.pre.waitSec, WAIT),
        truthy(`Segment "pacing GRÜN 5h ${r.pre.usedPct}%→… Drossel 3s"`, new RegExp(`^pacing GRÜN 5h ${r.pre.usedPct}%→\\d+%@\\d\\d:\\d\\d Drossel 3s$`).test(r.ev.segment || ''), r.ev.segment),
        truthy('Meldung "Drossel aktiv – Pausen bis 2.5 s … Modelle bleiben unverändert" auf dem Bildschirm', /quota-pacer: Drossel aktiv – Pausen bis 2\.5 s [^]*?Modelle bleiben unverändert\./.test(r.screenFlat), (/quota-pacer: Drossel aktiv[^]*?unverändert\./.exec(r.screenFlat) || [null])[0]),
        eq('pre-agent', r.preAgent.map((d) => `${d.action}:${d.reason}`).join(','), 'none:strategy-throttle'),
        truthy('Drossel-Log: Agent und 3× Read pausiert', tools.filter((t) => t === 'Agent').length === 1 && tools.filter((t) => t === 'Read').length === 3, tools),
        truthy(`Drossel-Log: waitSec ${WAIT}, 5h, vor dem Plan`, thr.length > 0 && thr.every((d) => d.waitSec === WAIT && d.window === 'fiveHour' && d.used > d.allowed), thr.map((d) => [d.tool, d.waitSec, d.used, d.allowed])),
        atLeast('Abstand Agent-Aufruf → erste Subagent-Anfrage (ms)', r.req.agentGapMs, PAUSE_MIN_MS),
        allAtLeast('Abstände nach Read zwischen Haupt-Anfragen (ms)', r.req.mainToolGaps, PAUSE_MIN_MS),
        same('Agent-Aufrufe unverändert (kein Modellfeld)', r.req.spawned.map((s) => s.model || null), [null]),
        eq('Subagent-Modell = Hauptmodell', r.req.subs.length === 1 && r.req.subs[0].model, MAIN),
        eq('Hauptmodell unverändert', r.req.main[0] && r.req.main[0].model, MAIN),
        eq('Kein Pacing-Kontext an Claude', r.req.pacingContexts.length, 0),
        truthy('Alle Read-Ergebnisse ohne Fehler', r.req.mainToolResults.length === 3 && r.req.mainToolResults.every((x) => !x.isError), r.req.mainToolResults.map((x) => x.isError)),
      ];
    },
  },
  {
    id: 'R4',
    name: 'model-switch-no-upgrade',
    title: '/model haiku in der TUI: PostModelSwitch setzt das Hauptmodell, kein Upgrade auf Sonnet',
    auth: 'apikey',
    samples: 'amber',
    config: { strategy: 'downgrade' },
    agents: { impl: null },
    probePlugin: true,
    steps: () => [{ say: 'MAIN-READY' }, { agents: 1, subagentType: 'impl' }],
    async flow(c) {
      c.ev.segment = await c.tui.waitFor(/pacing GELB 5h \d+%→\d+%@\d\d:\d\d/, 40000, { where: 'screen', label: 'segment GELB' });
      await c.tui.typeLine('E2E-MAIN: first turn.');
      await c.tui.waitFor(/MAIN-READY/, 40000);
      c.ev.modelBefore = c.sessionModel();
      await c.tui.typeLine('/model haiku');
      const seen = await c.tui.waitFor(/Switch model\?|Set model to Haiku/, 20000, { where: 'screen', label: 'model switch dialog or confirmation' });
      c.ev.switchDialog = !!seen && /Switch model/.test(seen);
      if (c.ev.switchDialog) { await sleep(500); c.tui.send('\r'); }
      c.ev.switchConfirmed = await c.tui.waitFor(/Set model to Haiku[^ ]* ?[^ ]*/, 20000, { label: 'Set model to Haiku' });
      c.ev.probeSwitch = await c.tui.waitUntil(() => readJsonl(c.probeLog).find((x) => x.hook_event_name === 'PostModelSwitch'), 15000, 'PostModelSwitch fired');
      c.ev.modelAfterSwitch = await c.tui.waitUntil(() => (c.sessionModel() === HAIKU ? HAIKU : null), 15000, 'session model = haiku') || c.sessionModel();
      await c.tui.typeLine('E2E-NEXT: run the task.');
      await c.tui.waitFor(/MAIN-DONE/, 60000);
      // Auto mode is unavailable on Haiku 4.5: the subagent ends with plain text, no SubagentHandback.
      await c.tui.waitUntil(() => c.mock.requests.some((q) => q.role === 'sub' && (q.action === 'handback' || q.action === 'final')), 30000, 'subagent finished');
      c.ev.modelAtEnd = c.sessionModel();
      await sleep(4000);
    },
    checks(r) {
      const sw = r.ev.probeSwitch || {};
      const spawnIdx = r.req.main.findIndex((q) => q.action === 'spawn');
      const afterSwitch = spawnIdx >= 0 ? r.req.main.slice(spawnIdx).map((q) => q.model) : [];
      return [
        eq('Erste Antwort auf dem Startmodell', r.req.main[0] && r.req.main[0].model, MAIN),
        eq('Sitzungsmodell vor /model (SessionStart/Statuszeile)', r.ev.modelBefore, MAIN),
        truthy('/model haiku bestätigt ("Set model to Haiku")', r.ev.switchConfirmed, r.ev.switchConfirmed),
        same('PostModelSwitch gefeuert (Beobachter-Plugin)', [sw.from_model, sw.to_model, sw.source], [MAIN, HAIKU, 'command']),
        eq('Plugin-Sitzungszustand nach /model: neues Hauptmodell', r.ev.modelAfterSwitch, HAIKU),
        truthy('Haupt-Anfragen nach dem Wechsel auf Haiku', afterSwitch.length > 0 && afterSwitch.every((m) => m === HAIKU), afterSwitch),
        // CLI 2.1.291: "/model haiku" turns auto mode off ("auto mode unavailable for this model").
        truthy('TUI: Auto-Mode mit Haiku 4.5 nicht verfügbar → manueller Modus', /auto mode unavailable for this model/.test(r.screenFlat) && /⏸ manual mode on/.test(r.screenFlat), (/auto mode unavailable for this model|⏸ manual mode on/.exec(r.screenFlat) || [null])[0]),
        eq('pre-agent: permissionMode nach dem Wechsel', r.preAgent.map((d) => d.permissionMode).join(','), 'default'),
        eq('pre-agent: kein Eingriff (Haiku liegt unter dem Ziel Sonnet)', r.preAgent.map((d) => `${d.action}:${d.reason}`).join(','), 'none:already-at-or-below-target'),
        same('pre-agent: effektives Modell = Haiku-Hauptmodell, Ziel wäre Sonnet', r.preAgent.map((d) => [d.agentType, d.cls, d.level, d.effective, d.effectiveSource]), [['impl', 'default', 'amber', HAIKU, 'main/transcript']]),
        same('Agent-Aufruf ohne Modellfeld (kein Re-Issue)', r.req.spawned.map((s) => s.model || null), [null]),
        eq('Subagent auf Haiku, kein Upgrade auf Sonnet', r.req.subs.length === 1 && r.req.subs[0].model, HAIKU),
      ];
    },
  },
];

// ---------------------------------------------------------------------------------------

async function runOne(run, round) {
  const t0 = Date.now();
  const h = mkHome(`tui-${run.id}`);
  const now = Date.now();
  const outPrefix = path.join(h.home, 'screen');
  const ev = {};
  let tui = null;
  let mock = null;
  let proxy = null;
  try {
    // Onboarding as an earlier session would have left it (no first-run dialogs).
    const onboarding = {
      hasCompletedOnboarding: true,
      theme: 'dark',
      projects: { [h.project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    };
    if (run.auth === 'apikey') onboarding.customApiKeyResponses = { approved: [FAKE_API_KEY.slice(-20)], rejected: [] };
    writeJson(path.join(h.claudeDir, '.claude.json'), onboarding);
    if (run.samples) writeJson(path.join(h.pacerHome, 'samples.json'), { v: 1, samples: PRESETS[run.samples](now) });
    if (run.config) writeJson(path.join(h.pacerHome, 'config.json'), run.config);
    for (const f of run.files || []) fs.writeFileSync(path.join(h.project, f), `content of ${f}\n`);
    for (const [name, model] of Object.entries(run.agents || {})) {
      const fm = [`name: ${name}`, `description: E2E test agent ${name}`];
      if (model) fm.push(`model: ${model}`);
      fs.mkdirSync(path.join(h.project, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(h.project, '.claude', 'agents', `${name}.md`), `---\n${fm.join('\n')}\n---\nAnswer briefly.\n`);
    }
    const slDumpLog = path.join(h.home, 'statusline-dump.jsonl');
    if (run.chainDump) {
      const script = path.join(h.home, 'sl-dump.js');
      fs.writeFileSync(script, SL_DUMP);
      writeJson(path.join(h.claudeDir, 'settings.json'), { statusLine: { type: 'command', command: `node "${script}" "${slDumpLog}"` } });
    }
    const probeLog = path.join(h.home, 'probe.jsonl');
    const probeDir = path.join(h.home, 'probe-plugin');
    if (run.probePlugin) writeProbePlugin(probeDir, probeLog);

    const rl = run.rateLimits ? rateLimitHeaders() : null;
    mock = createMock({ mainSteps: run.steps(h.project), fakeSecrets: [FAKE_API_KEY, FAKE_OAUTH], serverClassifier: 'not_flagged', rateLimitHeaders: rl ? rl.fn : null });
    const port = await mock.listen();
    proxy = await startBlackHole();
    const env = buildEnv({ home: h.home, mockPort: port, proxyPort: proxy.port, auth: run.auth, extra: run.env || {} });
    assertSafeEnv(env, h.home);

    // Sensor installation exactly as a user would run it, with this HOME/CLAUDE_CONFIG_DIR.
    const inst = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'pacer.js'), 'install'], { cwd: h.project, env, encoding: 'utf8', timeout: 30000 });
    const settings = readJson(path.join(h.claudeDir, 'settings.json')) || {};
    const pacerChain = (readJson(path.join(h.pacerHome, 'chain.json')) || {}).chain || null;

    const pre = run.samples ? precheck(PRESETS[run.samples](now), run.config, now) : null;
    if (pre) {
      // The segment rounds the 5-hour usage like messages.pct().
      const { evaluate } = require(path.join(ROOT, 'scripts', 'lib', 'policy'));
      const { DEFAULTS, deepMerge, validate } = require(path.join(ROOT, 'scripts', 'lib', 'config'));
      const cfg = validate(deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), run.config || {})).config;
      const saved = process.env.QUOTA_PACER_HOME;
      process.env.QUOTA_PACER_HOME = path.join(h.home, 'precheck-none');
      try { pre.usedPct = Math.round(evaluate(now, cfg, { persist: false, samples: PRESETS[run.samples](now) }).windows.fiveHour.used); } finally {
        if (saved === undefined) delete process.env.QUOTA_PACER_HOME; else process.env.QUOTA_PACER_HOME = saved;
      }
    }

    const argv = [CLAUDE, '--plugin-dir', ROOT, ...(run.probePlugin ? ['--plugin-dir', probeDir] : [])];
    const startedAt = Date.now();
    tui = startTui({ argv, env, cwd: h.project, home: h.home, outPrefix });
    const ctx = {
      tui, mock, h, ev, probeLog,
      sessionModel: () => {
        const base = path.join(h.pacerHome, 'sessions');
        let names = [];
        try { names = fs.readdirSync(base); } catch { return null; }
        const models = names.map((n) => readJson(path.join(base, n, 'model.json'))).filter(Boolean).map((x) => x.model);
        return models.length === 1 ? models[0] : (models.length ? models.join(',') : null);
      },
    };
    ev.ready = await tui.waitFor(/auto mode on/, 40000, { where: 'screen', label: 'TUI ready (auto mode)' });
    let flowError = null;
    try { await run.flow(ctx); } catch (e) { flowError = String(e && e.stack); }
    const before = await tui.screen();
    await tui.typeLine('/exit');
    await tui.waitUntil(() => tui.exit, 20000, 'claude exited after /exit');
    const exited = tui.exit;
    await tui.quit(0);
    const endedAt = Date.now();
    await sleep(200);
    await mock.close();
    await proxy.close();

    const screenTxt = fs.existsSync(`${outPrefix}.txt`) ? fs.readFileSync(`${outPrefix}.txt`, 'utf8') : (before.screen || '');
    const history = fs.existsSync(`${outPrefix}.history.txt`) ? fs.readFileSync(`${outPrefix}.history.txt`, 'utf8') : (before.all || '');
    const decisions = readJsonl(path.join(h.pacerHome, 'decisions.jsonl'));
    const r = {
      ev, pre, rl, startedAt, endedAt,
      req: analyseRequests(mock),
      decisions,
      preAgent: decisions.filter((d) => d.kind === 'pre-agent'),
      samples: ((readJson(path.join(h.pacerHome, 'samples.json')) || {}).samples || []),
      slDump: readJsonl(slDumpLog),
      screenFlat: flat(`${screenTxt}\n${history}`),
    };
    const errors = decisions.filter((d) => d.kind === 'error' || d.kind === 'unparseable-line');
    const generic = [
      eq('Sensor installiert (pacer.js install, Exit-Code)', inst.status, 0),
      truthy('statusLine zeigt auf den Sensor in <CLAUDE_CONFIG_DIR>/quota-pacer/bin', settings.statusLine && settings.statusLine.command === `node "${path.join(h.pacerHome, 'bin', 'statusline.js')}"`, settings.statusLine || null),
      ...(run.chainDump ? [truthy('Vorherige Statuszeile verkettet (chain.json)', pacerChain && /sl-dump\.js/.test(pacerChain.command), pacerChain)] : []),
      truthy('TUI bereit (Auto-Mode ist Standard)', ev.ready, ev.ready),
      eq('Ablauf ohne Ausnahme', flowError, null),
      truthy('Pacing-Segment auf dem Bildschirm', segments(screenTxt).length > 0, segments(screenTxt).slice(-1)[0] || null),
      truthy('Alle API-Anfragen mit Fake-Credential', r.req.msgs.length > 0 && r.req.unauthenticated === 0, { requests: r.req.msgs.length, unauthenticated: r.req.unauthenticated }),
      eq('Keine Verbindung nach außen (Proxy-Log)', proxy.log.length, 0),
      eq('Keine unerwarteten Mock-Antworten', r.req.msgs.filter((q) => q.role === 'mock-error').length, 0),
      eq('Genau eine pre-agent-Zeile pro Agent-Aufruf', r.preAgent.length, r.req.spawned.length),
      truthy('Keine Fehler im Plugin-Log', errors.length === 0, errors.map((e) => `${e.where}: ${String(e.message).split('\n')[0]}`)),
      eq('Claude Code nach /exit beendet (Exit-Code)', exited && exited.status, 0),
    ];
    let specific;
    try { specific = run.checks(r); } catch (e) { specific = [{ name: 'checks() ohne Ausnahme', pass: false, actual: String(e && e.stack) }]; }
    const checks = [...generic, ...specific];
    const pass = checks.every((c) => c.pass);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    // With several rounds every round keeps its own capture; one round keeps the old name.
    const capture = path.join(OUT_DIR, `interactive-${run.id}-${run.name}${ROUNDS > 1 ? `.round-${String(round).padStart(2, '0')}` : ''}.screen.txt`);
    fs.writeFileSync(capture, screenTxt.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n'));
    return {
      id: run.id, name: run.name, title: run.title, round, pass, durationMs: Date.now() - t0, checks,
      evidence: {
        install: (inst.stdout || '').trim().split('\n'),
        precondition: pre,
        segments: [...new Set(segments(screenTxt))],
        tuiTimeline: tui.timeline,
        requests: r.req.timeline,
        nonMessagePaths: r.req.nonMessagePaths,
        sideRequests: r.req.side,
        decisions: decisions.map((d) => { const x = { ...d }; delete x.session; return x; }),
        samples: run.samples ? `${PRESETS[run.samples](now).length} gesät (${run.samples})` : r.samples,
        statuslineDump: r.slDump.length ? { calls: r.slDump.length, first: r.slDump[0], last: r.slDump[r.slDump.length - 1] } : undefined,
        events: ev,
        screenCapture: path.relative(ROOT, capture),
        driverStderr: tui.stderr.slice(-1000) || undefined,
      },
    };
  } finally {
    if (tui && !tui.exit) { try { await tui.quit(0); } catch { /* ignore */ } }
    if (mock) { try { await mock.close(); } catch { /* ignore */ } }
    if (proxy) { try { await proxy.close(); } catch { /* ignore */ } }
    if (KEEP) console.log(`   (kept ${h.home})`);
    else fs.rmSync(h.home, { recursive: true, force: true });
  }
}

async function main() {
  if (!fs.existsSync(CLAUDE)) throw new Error(`Claude Code CLI not found: ${CLAUDE}`);
  if (!fs.existsSync('/usr/bin/python3')) throw new Error('python3 (with pty) is required at /usr/bin/python3');
  const vh = mkHome('version');
  const version = (spawnSync(CLAUDE, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: vh.home, CLAUDE_CONFIG_DIR: vh.claudeDir, DISABLE_AUTOUPDATER: '1' } }).stdout || '').trim();
  fs.rmSync(vh.home, { recursive: true, force: true });
  const selected = RUNS.filter((r) => !ONLY.length || ONLY.includes(r.id) || ONLY.includes(r.name));
  if (!selected.length) throw new Error(`no run matches --only ${ONLY.join(',')}`);
  console.log(`quota-pacer interaktiv (TUI im pty) – Claude Code ${version}, Node ${process.version}, ${process.platform}-${process.arch}, sandbox ${useSandbox(SANDBOX) ? 'an' : 'aus'}, ${selected.length} Läufe × ${ROUNDS} Runde(n)`);
  const started = new Date().toISOString();
  const rounds = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const results = [];
    for (const run of selected) {
      const res = await runOne(run, round);
      results.push(res);
      const ok = res.checks.filter((c) => c.pass).length;
      console.log(`[${round}] ${res.pass ? 'PASS' : 'FAIL'} ${run.id} ${run.name}: ${ok}/${res.checks.length} Prüfungen (${(res.durationMs / 1000).toFixed(1)} s)`);
      for (const c of res.checks.filter((x) => !x.pass)) console.log(`      - ${c.name}: erwartet ${JSON.stringify(c.expected)}, erhalten ${JSON.stringify(c.actual)}`);
    }
    rounds.push({ round, results, passed: results.reduce((a, x) => a + x.checks.filter((c) => c.pass).length, 0), total: results.reduce((a, x) => a + x.checks.length, 0) });
  }
  const passed = rounds.reduce((a, r) => a + r.passed, 0);
  const total = rounds.reduce((a, r) => a + r.total, 0);
  const runsPassed = rounds.reduce((a, r) => a + r.results.filter((x) => x.pass).length, 0);
  const report = {
    plugin: 'quota-pacer 1.1.0', claudeCode: version, claudePath: CLAUDE, mode: 'interactive (pty, TUI)', node: process.version,
    platform: `${process.platform}-${process.arch}`, sandbox: useSandbox(SANDBOX), terminal: `${COLS}x${ROWS}`, started, finished: new Date().toISOString(),
    rounds: ROUNDS, runs: selected.length, checksPerRound: rounds[0].total, passed, total, runsPassed, runsTotal: ROUNDS * selected.length,
    summary: selected.map((run) => {
      const rs = rounds.map((r) => r.results.find((x) => x.id === run.id));
      return { id: run.id, name: run.name, title: run.title, passedRounds: rs.filter((x) => x.pass).length, rounds: rs.length, checks: rs[0].checks.length, durationsMs: rs.map((x) => x.durationMs) };
    }),
    roundsDetail: rounds,
  };
  writeJson(path.join(OUT_DIR, 'interactive-report.json'), report);
  console.log(`\n${passed}/${total} Prüfungen bestanden (${runsPassed}/${ROUNDS * selected.length} Läufe, ${selected.length} Läufe × ${ROUNDS} Runden) – Claude Code ${version}`);
  console.log(`Bericht: ${path.relative(process.cwd(), path.join(OUT_DIR, 'interactive-report.json'))}`);
  process.exitCode = passed === total ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
