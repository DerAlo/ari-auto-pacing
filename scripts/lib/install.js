'use strict';
// Plugins cannot set the main statusLine, so the installer writes it into the user's
// ~/.claude/settings.json. The status line must point at a path that survives plugin
// updates (the plugin cache path changes per version), so scripts are copied to
// <pacerHome>/bin first.
const fs = require('fs');
const path = require('path');
const { VERSION, claudeDir, pacerHome, readJson, writeJsonAtomic, ensureDir, toForwardSlashes, nowMs, stripBom } = require('./util');
const { readUserConfigStrict, updateUserConfig } = require('./config');
const { readChain, writeChain, clearChain } = require('./chain');

const SCRIPT_FILES = ['statusline.js', 'hook.js', 'pacer.js'];

function binDir() {
  return path.join(pacerHome(), 'bin');
}

function installedVersion() {
  try { return fs.readFileSync(path.join(binDir(), 'VERSION'), 'utf8').trim(); } catch { return null; }
}

// Copy scripts/ (this directory's parent) to <pacerHome>/bin when missing or outdated.
function syncBin(sourceScriptsDir, { force = false } = {}) {
  const src = path.resolve(sourceScriptsDir);
  const dst = binDir();
  if (path.resolve(src) === path.resolve(dst)) return { synced: false, reason: 'same-dir' };
  if (!force && installedVersion() === VERSION && fs.existsSync(path.join(dst, 'statusline.js'))) {
    return { synced: false, reason: 'up-to-date' };
  }
  const staging = `${dst}.new-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  ensureDir(path.join(staging, 'lib'));
  for (const f of SCRIPT_FILES) fs.copyFileSync(path.join(src, f), path.join(staging, f));
  for (const f of fs.readdirSync(path.join(src, 'lib'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(src, 'lib', f), path.join(staging, 'lib', f));
  }
  fs.writeFileSync(path.join(staging, 'VERSION'), VERSION + '\n');
  const old = `${dst}.old-${process.pid}`;
  if (fs.existsSync(dst)) fs.renameSync(dst, old);
  fs.renameSync(staging, dst);
  fs.rmSync(old, { recursive: true, force: true });
  return { synced: true };
}

function settingsFile() {
  return path.join(claudeDir(), 'settings.json');
}

function statuslineCommand() {
  return `node "${toForwardSlashes(path.join(binDir(), 'statusline.js'))}"`;
}

// Ours: the command written by install(), or any copy under a quota-pacer data dir
// (e.g. written with a different CLAUDE_CONFIG_DIR).
// Also any other copy of this sensor (plugin cache .../quota-pacer/<version>/scripts/statusline.js
// or this repository): chaining one of those would run the sensor twice per refresh.
function isOurs(statusLine) {
  if (!statusLine || typeof statusLine.command !== 'string') return false;
  const c = toForwardSlashes(statusLine.command);
  return statusLine.command === statuslineCommand()
    || /quota-pacer\/+bin\/+statusline\.js/.test(c)
    || (/statusline\.js/.test(c) && (/quota-pacer/.test(c) || c.includes(toForwardSlashes(path.resolve(__dirname, '..')))));
}

function readSettingsStrict() {
  const file = settingsFile();
  if (!fs.existsSync(file)) return { ok: true, settings: {}, existed: false };
  const text = stripBom(fs.readFileSync(file, 'utf8'));
  if (!text.trim()) return { ok: true, settings: {}, existed: true };
  try {
    const s = JSON.parse(text);
    if (s === null || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'settings.json enthält kein JSON-Objekt' };
    return { ok: true, settings: s, existed: true, text };
  } catch (e) {
    return { ok: false, error: `settings.json ist kein gültiges JSON (${e.message})` };
  }
}

function backupSettings(text) {
  if (text === undefined) return null;
  const dir = path.join(pacerHome(), 'backups');
  ensureDir(dir);
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const file = path.join(dir, `settings-${new Date(nowMs()).toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, text, { mode: 0o600 }); // settings can hold tokens
  pruneBackups(dir, file);
  return file;
}

// Backups are copies of settings.json (which can hold tokens) and one is written per
// install and uninstall, so only the newest ones stay. Backups whose status line is not
// ours are kept: uninstall restores from the newest of them when chain.json is gone.
const BACKUPS_KEEP = 10;

function pruneBackups(dir, justWritten) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^settings-.+\.json$/.test(n)).sort().reverse(); } catch { return; }
  let foreignKept = false;
  for (const n of names.slice(BACKUPS_KEEP)) {
    const file = path.join(dir, n);
    if (file === justWritten) continue;
    if (!foreignKept) {
      const s = readJson(file, null);
      if (s && s.statusLine && !isOurs(s.statusLine)) { foreignKept = true; continue; }
    }
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  }
}

// 1.0.0 kept the chained status line in config.json; once chain.json holds it, the old key
// would only confuse. Left alone when config.json does not parse (never rewrite that).
function dropLegacyChain() {
  const r = readUserConfigStrict();
  if (!r.ok || !Object.prototype.hasOwnProperty.call(r.config, 'chain')) return;
  try { updateUserConfig({ chain: undefined }); } catch { /* left as is */ }
}

// Settings as they were before the latest install: the newest backup whose statusLine is
// not ours (backups taken by uninstall or by a re-install contain ours and are skipped).
// Used only when no chain is known, e.g. a 1.0.0 config.json that was replaced by hand.
function previousFromBackups() {
  const dir = path.join(pacerHome(), 'backups');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^settings-.+\.json$/.test(n)).sort().reverse(); } catch { return null; }
  for (const n of names) {
    const file = path.join(dir, n);
    let s;
    try {
      const text = fs.readFileSync(file, 'utf8');
      s = text.trim() ? JSON.parse(text) : {};
    } catch { continue; }
    if (s === null || typeof s !== 'object' || Array.isArray(s)) continue;
    if (s.statusLine && isOurs(s.statusLine)) continue;
    const prev = s.statusLine && typeof s.statusLine.command === 'string' ? s.statusLine : null;
    return { statusLine: prev, file };
  }
  return null;
}

function install({ sourceScriptsDir, refreshInterval = 30 } = {}) {
  const sync = sourceScriptsDir ? syncBin(sourceScriptsDir) : { synced: false, reason: 'no-source' };
  if (!fs.existsSync(path.join(binDir(), 'statusline.js'))) {
    return { ok: false, error: `Sensor-Skript fehlt in ${binDir()}` };
  }
  // The command is run by a shell and only wrapped in double quotes.
  if (/["$`]/.test(binDir())) {
    return { ok: false, error: `Der Pfad ${binDir()} enthält ", $ oder \` und kann nicht sicher als Statusline eingetragen werden – nichts geändert.` };
  }
  const r = readSettingsStrict();
  if (!r.ok) return { ok: false, error: `${r.error} – nichts geändert.` };
  const settings = r.settings;
  const backup = r.existed ? backupSettings(r.text !== undefined ? r.text : '') : null;
  let chained = null;
  if (settings.statusLine && !isOurs(settings.statusLine)) {
    chained = settings.statusLine;
    writeChain(chained); // before settings.json changes: a failure here changes nothing
    dropLegacyChain();
  }
  const prev = settings.statusLine || {};
  const next = { type: 'command', command: statuslineCommand(), refreshInterval };
  if (prev.padding !== undefined) next.padding = prev.padding;
  else if (chained && chained.padding !== undefined) next.padding = chained.padding;
  settings.statusLine = next;
  writeJsonAtomic(settingsFile(), settings);
  return { ok: true, sync, backup, chained, command: next.command, settingsFile: settingsFile() };
}

function uninstall() {
  const r = readSettingsStrict();
  if (!r.ok) return { ok: false, error: `${r.error} – nichts geändert.` };
  const settings = r.settings;
  if (!isOurs(settings.statusLine)) {
    return { ok: true, restored: null, note: 'Statusline gehört nicht zu quota-pacer – nichts geändert.' };
  }
  const backup = r.existed ? backupSettings(r.text !== undefined ? r.text : '') : null;
  let restored = null;
  let fromBackup = null;
  const known = readChain();
  if (known) {
    restored = known.chain;
  } else {
    const prev = previousFromBackups();
    if (prev && prev.statusLine) { restored = prev.statusLine; fromBackup = prev.file; }
  }
  if (restored) settings.statusLine = restored;
  else delete settings.statusLine;
  writeJsonAtomic(settingsFile(), settings);
  clearChain();
  dropLegacyChain();
  return { ok: true, restored, fromBackup, backup, settingsFile: settingsFile() };
}

function statuslineInstalled() {
  const s = readJson(settingsFile(), null);
  return !!(s && isOurs(s.statusLine));
}

module.exports = { syncBin, install, uninstall, previousFromBackups, statuslineInstalled, statuslineCommand, isOurs, binDir, installedVersion, settingsFile, readSettingsStrict };
