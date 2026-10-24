'use strict';
// Shared helpers. No dependencies outside the Node standard library (Node >= 18).
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '1.4.0';

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
}

// Data directory: <claudeDir>/quota-pacer. QUOTA_PACER_HOME exists for tests only.
function pacerHome() {
  return process.env.QUOTA_PACER_HOME
    ? path.resolve(process.env.QUOTA_PACER_HOME)
    : path.join(claudeDir(), 'quota-pacer');
}

// One path segment, never a way out of its directory: leading dots are replaced, so "."
// and ".." cannot name the parent (SessionEnd deletes sessionDir recursively).
function safeName(s) {
  const v = String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, (m) => '_'.repeat(m.length)).slice(0, 120);
  return v || 'unknown';
}

function sessionDir(sessionId) {
  return path.join(pacerHome(), 'sessions', safeName(sessionId));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Windows editors and PowerShell 5.1 write UTF-8 with a BOM, which JSON.parse rejects.
function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const JSON_MAX_BYTES = 20 * 1024 * 1024;

function readJson(file, fallback) {
  try {
    if (fs.statSync(file).size > JSON_MAX_BYTES) return fallback;
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return fallback;
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.round(ms)));
}

// Write-then-rename so readers never see a half-written file. An existing target keeps
// its permissions (settings.json often holds tokens and is 0600), and a symlinked
// target (dotfiles) is written through to the real file instead of being replaced.
function writeJsonAtomic(file, obj) {
  let target = file;
  let mode = null;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  } catch { target = file; }
  ensureDir(path.dirname(target));
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', mode === null ? undefined : { mode });
  if (mode !== null) { try { fs.chmodSync(tmp, mode); } catch { /* umask may have narrowed it; rename anyway */ } }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      // Windows: the target can be briefly locked by a concurrent reader.
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      sleepMs(15);
    }
  }
}

// Injected clock for tests only. Never set in production.
function nowMs() {
  const v = Number(process.env.QUOTA_PACER_NOW);
  return Number.isFinite(v) && v > 0 ? v : Date.now();
}

const STDIN_MAX_CHARS = 20 * 1024 * 1024;

// Resolves with '' for an oversized event: the caller then has no opinion.
function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.stdin.pause(); } catch { /* ignore */ }
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        if (done) return;
        data += chunk;
        if (data.length > STDIN_MAX_CHARS) { data = ''; finish(); }
      });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
  });
}

// Print and exit only after stdout is flushed (important for piped output on Windows).
function finish(text, code = 0) {
  if (text) {
    process.stdout.write(text, () => process.exit(code));
  } else {
    process.exit(code);
  }
}

const LOG_MAX_BYTES = 1024 * 1024;

function appendLog(entry) {
  try {
    const file = path.join(pacerHome(), 'decisions.jsonl');
    ensureDir(path.dirname(file));
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch { /* missing file is fine */ }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date(nowMs()).toISOString(), ...entry }) + '\n');
  } catch { /* logging must never break a hook */ }
}

function logError(where, err) {
  appendLog({ kind: 'error', where, message: String(err && err.stack ? err.stack : err).slice(0, 2000) });
}

function toForwardSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

module.exports = {
  VERSION,
  claudeDir,
  pacerHome,
  safeName,
  sessionDir,
  ensureDir,
  stripBom,
  readJson,
  writeJsonAtomic,
  sleepMs,
  nowMs,
  readStdin,
  finish,
  appendLog,
  logError,
  toForwardSlashes,
};
