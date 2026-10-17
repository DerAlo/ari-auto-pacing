#!/usr/bin/env node
'use strict';
// Status line sensor. Claude Code passes the session JSON on stdin; rate_limits is
// only delivered to status line commands, so this is the plugin's only quota source.
// It records a sample, then prints the previously configured status line (if any)
// followed by a short pacing segment. It never fails visibly.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readStdin, finish, nowMs, logError } = require('./lib/util');
const { loadConfig } = require('./lib/config');
const { addSample, loadSamples } = require('./lib/samples');
const { evaluate } = require('./lib/policy');
const { computeWait } = require('./lib/throttle');
const { setSessionModel } = require('./lib/models');
const { statusSegment, configErrorSegment, pausedSegment } = require('./lib/messages');
const { readChain } = require('./lib/chain');

// Set for a chained status line. If that command is (or calls) another copy of this
// sensor, the copy must not chain again, or every refresh would spawn processes without end.
const CHAIN_ENV = 'QUOTA_PACER_CHAINED';

function shellFor(command) {
  if (process.platform !== 'win32') return { file: '/bin/sh', args: ['-c', command] };
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
  const bash = candidates.find((p) => p && fs.existsSync(p));
  if (bash) return { file: bash, args: ['-c', command] };
  // Absolute path: a bare name could be resolved from the project directory.
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return { file: ps, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command] };
}

const CHAIN_TIMEOUT_MS = 3000;
const CHAIN_OUT_MAX = 64 * 1024;

// Ends the shell and everything it started. Killing only the shell is not enough on
// Windows: a process it started keeps the output pipes open (ours and the one Claude
// Code reads this sensor through), so a hanging command blocked for its whole runtime
// (measured: 20 s instead of 3 s).
function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 2000, windowsHide: true });
    }
  } catch { /* fall through to the plain kill */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

// NoDefaultCurrentDirectoryInExePath stops Windows from resolving commands from the
// project directory.
function runChain(command, raw) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let timer = null;
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out.replace(/\s+$/, ''));
    };
    try {
      const sh = shellFor(command);
      const env = { ...process.env, [CHAIN_ENV]: '1', NoDefaultCurrentDirectoryInExePath: '1' };
      const child = spawn(sh.file, sh.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env });
      timer = setTimeout(() => { killTree(child); end(); }, CHAIN_TIMEOUT_MS);
      child.on('error', (e) => { logError('statusline-chain', e); end(); });
      child.on('close', end);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { if (out.length < CHAIN_OUT_MAX) out += d; });
      child.stdin.on('error', () => { /* command did not read its input */ });
      child.stdin.end(raw);
    } catch (e) {
      logError('statusline-chain', e);
      end();
    }
  });
}

async function main() {
  const raw = await readStdin(2000);
  // Run as the chained status line of another copy of this sensor: that copy already
  // records the sample and prints the segment.
  if (process.env[CHAIN_ENV]) return finish('\n');
  let input = {};
  try { input = JSON.parse(raw || '{}') || {}; } catch { input = {}; }
  let cfg;
  try { cfg = loadConfig(); } catch { cfg = null; }
  let segment = '';
  try {
    const now = nowMs();
    if (input.rate_limits) addSample(input.rate_limits, now);
    if (input.session_id && input.model && typeof input.model.id === 'string') setSessionModel(input.session_id, input.model.id);
    if (cfg && cfg._fileError) {
      segment = configErrorSegment(); // interventions are off until config.json parses again
    } else if (cfg && cfg._pausedUntil) {
      if (cfg.statusSegment) segment = pausedSegment(cfg._pausedUntil, cfg.language, now);
    } else if (cfg && cfg.enabled && cfg.statusSegment) {
      const samples = loadSamples();
      // "Drossel Ns": the pause the next step would get right now.
      const waitSec = cfg.strategy === 'throttle' || cfg.strategy === 'both' ? computeWait(samples, now, cfg).waitSec : 0;
      segment = statusSegment(evaluate(now, cfg, { samples }), cfg.language, waitSec);
    }
  } catch (e) {
    logError('statusline', e);
  }
  let chain = null;
  try { chain = readChain(); } catch (e) { logError('statusline-chain-read', e); }
  const chained = chain ? await runChain(chain.chain.command, raw) : '';
  let out;
  if (chained && segment) out = chained.includes('\n') ? `${chained}\n${segment}` : `${chained}  ${segment}`;
  else out = chained || segment || '';
  finish(out ? out + '\n' : '\n');
}

main().catch((e) => { logError('statusline-main', e); finish('\n'); });
