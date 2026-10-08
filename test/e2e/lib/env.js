'use strict';
// Isolated environment for runs of the real Claude Code CLI:
//   - fresh temp HOME with CLAUDE_CONFIG_DIR=<home>/.claude (two independent barriers
//     against the real ~/.claude, ~/.claude.json and the login keychain entry)
//   - env built from a whitelist; nothing of this process's env (CLAUDECODE,
//     CLAUDE_CODE_*, ANTHROPIC_*, QUOTA_PACER_*) can leak into the child
//   - fake credentials only, API base URL = local mock
//   - HTTP(S)_PROXY = a local proxy that refuses and logs everything else, and on macOS
//     sandbox-exec, which denies every outbound connection except localhost
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const FAKE_API_KEY = 'sk-ant-api03-FAKE-e2e-key-00000000000000000000000000000000000000000000';
const FAKE_OAUTH = 'sk-ant-oat01-FAKE-e2e-oauth-0000000000000000000000000000000000000000';
const NODE_DIR = path.dirname(process.execPath);

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

function useSandbox(enabled) {
  return enabled && process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
}

function mkHome(name) {
  const base = fs.realpathSync(os.tmpdir());
  const home = fs.realpathSync(fs.mkdtempSync(path.join(base, `qp-e2e-${name}-`)));
  for (const d of ['.claude', 'tmp', 'project']) fs.mkdirSync(path.join(home, d), { recursive: true });
  return { home, claudeDir: path.join(home, '.claude'), project: path.join(home, 'project'), pacerHome: path.join(home, '.claude', 'quota-pacer') };
}

// A proxy that refuses every request and CONNECT, and logs only method and target host.
function startBlackHole() {
  const log = [];
  const server = http.createServer((req, res) => {
    log.push({ kind: 'http', method: req.method, host: String(req.headers.host || '') });
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('blocked by e2e proxy');
  });
  server.on('connection', (sock) => sock.on('error', () => {}));
  server.on('clientError', (err, sock) => { try { sock.destroy(); } catch { /* ignore */ } });
  server.on('connect', (req, socket) => {
    socket.on('error', () => {});
    log.push({ kind: 'connect', target: String(req.url) });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    log,
    close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => r()); }),
  })));
}

function buildEnv({ home, mockPort, proxyPort, auth = 'apikey', extra = {} }) {
  const env = {
    PATH: `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    USER: process.env.USER || os.userInfo().username,
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: `${path.join(home, 'tmp')}/`,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  if (proxyPort) {
    env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    env.HTTP_PROXY = env.HTTPS_PROXY;
    env.NO_PROXY = '127.0.0.1,localhost';
  }
  if (auth === 'apikey') env.ANTHROPIC_API_KEY = FAKE_API_KEY;
  if (auth === 'oauth') env.CLAUDE_CODE_OAUTH_TOKEN = FAKE_OAUTH;
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === undefined) delete env[k]; else env[k] = String(v);
  }
  return env;
}

// Last line of defence: refuse to start the CLI with anything that could reach the real
// account or the real config.
function assertSafeEnv(env, home) {
  const bad = [];
  if (!env.HOME || !env.HOME.startsWith(home)) bad.push('HOME');
  if (!env.CLAUDE_CONFIG_DIR || !env.CLAUDE_CONFIG_DIR.startsWith(home)) bad.push('CLAUDE_CONFIG_DIR');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(env.ANTHROPIC_BASE_URL || '')) bad.push('ANTHROPIC_BASE_URL');
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY !== FAKE_API_KEY) bad.push('ANTHROPIC_API_KEY');
  if (env.CLAUDE_CODE_OAUTH_TOKEN && env.CLAUDE_CODE_OAUTH_TOKEN !== FAKE_OAUTH) bad.push('CLAUDE_CODE_OAUTH_TOKEN');
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k === 'ANTHROPIC_AUTH_TOKEN' || k.startsWith('QUOTA_PACER_') || /^CLAUDE_CODE_(SESSION|MESSAGING|CHILD|ENTRYPOINT)/.test(k)) bad.push(k);
  }
  if (bad.length) throw new Error(`unsafe e2e env: ${bad.join(', ')}`);
}

function command(claude, argv, home, sandbox) {
  return useSandbox(sandbox)
    ? { cmd: '/usr/bin/sandbox-exec', args: ['-p', sandboxProfile(home), claude, ...argv] }
    : { cmd: claude, args: argv };
}

function runClaude(claude, argv, { cwd, env, home, sandbox = true, timeoutMs = 180000 }) {
  assertSafeEnv(env, home);
  const c = command(claude, argv, home, sandbox);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(c.cmd, c.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err, ms: Date.now() - t0 }); });
  });
}

function runClaudeSync(claude, argv, { cwd, env, home, sandbox = true, timeoutMs = 90000 }) {
  assertSafeEnv(env, home);
  const c = command(claude, argv, home, sandbox);
  const r = spawnSync(c.cmd, c.args, { cwd, env, encoding: 'utf8', timeout: timeoutMs });
  return { code: r.status, signal: r.signal, out: r.stdout || '', err: r.stderr || '' };
}

module.exports = { FAKE_API_KEY, FAKE_OAUTH, mkHome, startBlackHole, buildEnv, assertSafeEnv, runClaude, runClaudeSync, useSandbox };
