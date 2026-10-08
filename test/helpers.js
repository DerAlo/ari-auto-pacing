'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

// Variables that would change the plugin's decisions if inherited from the shell.
const INHERITED_OFF = [
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'ANTHROPIC_MODEL',
  'QUOTA_PACER_NOW', 'CLAUDE_PLUGIN_ROOT',
  // doctor reads the login type from these
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE',
];

const created = [];
process.on('exit', () => {
  for (const dir of created) {
    try { fs.chmodSync(path.join(dir, 'claude', 'quota-pacer'), 0o700); } catch { /* may not exist */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Fresh, isolated HOME, Claude config dir and plugin data dir for each test, so nothing
// can ever touch the real ~/.claude. Extras win; an extra set to undefined is removed.
// The directories are removed when the test process exits.
function makeEnv(extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-test-'));
  created.push(base);
  const claude = path.join(base, 'claude');
  const home = path.join(claude, 'quota-pacer');
  const project = path.join(base, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const env = { ...process.env };
  for (const k of INHERITED_OFF) delete env[k];
  Object.assign(env, {
    HOME: base,
    USERPROFILE: base,
    CLAUDE_CONFIG_DIR: claude,
    QUOTA_PACER_HOME: home,
    QUOTA_PACER_MANAGED_SETTINGS: path.join(base, 'managed-settings.json'),
    CLAUDE_PROJECT_DIR: project,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extra,
  });
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return { base, claude, home, project, env };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function parseOut(stdout) {
  const out = (stdout || '').trim();
  if (!(out.startsWith('{') && out.endsWith('}'))) return null;
  try { return JSON.parse(out); } catch { return 'PARSE_ERROR'; }
}

function runScript(script, args, input, env) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: parseOut(r.stdout), ms: Date.now() - t0 };
}

function runHook(mode, input, env) {
  return runScript('hook.js', [mode], input, env);
}

function runHookAsync(mode, input, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(SCRIPTS, 'hook.js'), mode], { env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout, json: parseOut(stdout), ms: Date.now() - t0 }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

// Seed the sample store directly (what the status line sensor would have written).
function seedSamples(home, samples) {
  writeJson(path.join(home, 'samples.json'), { v: 1, samples });
}

// Build a series of 5h-window samples: usage grows linearly at `rate` %-points/min.
function linearSeries({ now, resetInMin, startUsed, rate, minutes, stepMin = 1, week = null }) {
  const out = [];
  const r = Math.round((now + resetInMin * 60000) / 1000);
  for (let m = minutes; m >= 0; m -= stepMin) {
    const t = now - m * 60000;
    const u = Math.min(100, startUsed + rate * (minutes - m));
    out.push({ t, f: { u, r }, s: week });
  }
  return out;
}

function preAgentInput(over = {}) {
  return {
    session_id: 'sess-1',
    // Unique and absent by default: no test may depend on a file it did not create.
    transcript_path: path.join(os.tmpdir(), `qp-no-transcript-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`),
    cwd: over.cwd || process.cwd(),
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { description: 'Find usages', prompt: 'Find all usages of Foo', subagent_type: 'Explore', run_in_background: false },
    tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`,
    ...over,
  };
}

// One transcript line as Claude Code writes it for an assistant message with a tool call.
function assistantLine(model, toolUseId, extra = {}) {
  const content = toolUseId
    ? [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: 'd', prompt: 'p', subagent_type: 'Explore' } }]
    : [{ type: 'text', text: 'ok' }];
  return JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model, content }, ...extra });
}

function userLine(text = 'hello') {
  return JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
}

function writeTranscript(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

function readLog(home, kind) {
  const file = path.join(home, 'decisions.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return kind ? lines.filter((l) => l.kind === kind) : lines;
}

module.exports = {
  ROOT, SCRIPTS, makeEnv, writeJson, runScript, runHook, runHookAsync, seedSamples, linearSeries, preAgentInput,
  assistantLine, userLine, writeTranscript, readLog,
};
