'use strict';
// A PreToolUse rewrite has to return permissionDecision "allow", which skips the
// permission prompt. To never weaken a team's rules, the plugin leaves any Agent
// call alone that a deny or ask rule could apply to. It reads every settings source
// Claude Code 2.1.291 reads for policy: the managed file, its managed-settings.d
// drop-ins, server-managed settings (remote-settings.json), the macOS managed
// preferences, then user, project and local settings.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { claudeDir, stripBom } = require('./util');

const MODEL_FAMILIES = ['haiku', 'sonnet', 'opus'];

function managedSettingsFiles() {
  if (process.env.QUOTA_PACER_MANAGED_SETTINGS) return [process.env.QUOTA_PACER_MANAGED_SETTINGS]; // tests
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (process.platform === 'win32') {
    return ['C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\ProgramData\\ClaudeCode\\managed-settings.json'];
  }
  return ['/etc/claude-code/managed-settings.json'];
}

function dropInFiles(baseFile) {
  const dir = path.join(path.dirname(baseFile), 'managed-settings.d');
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => path.join(dir, n));
  } catch { return []; }
}

// MDM profiles land here; plutil turns the plist into JSON. Only spawned when such a
// file exists, so machines without MDM pay a stat call and nothing else.
function managedPreferenceFiles() {
  if (process.platform !== 'darwin' || process.env.QUOTA_PACER_MANAGED_SETTINGS) return [];
  let user = '';
  try { user = os.userInfo().username; } catch { /* ignore */ }
  const base = '/Library/Managed Preferences';
  return [path.join(base, 'com.anthropic.claudecode.plist'), ...(user ? [path.join(base, user, 'com.anthropic.claudecode.plist')] : [])];
}

const UNREADABLE = (file) => ({ file, data: {}, unreadable: true });

// { file, data } of one settings file, null when it does not exist or is empty. A file
// that exists but cannot be read as a JSON object comes back as { unreadable: true }:
// its rules are unknown, so the plugin must not touch any Agent call (see agentRuleApplies).
function readSource(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? null : UNREADABLE(file);
  }
  text = stripBom(text);
  if (!text.trim()) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? { file, data } : UNREADABLE(file);
  } catch { return UNREADABLE(file); }
}

function readPlist(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const r = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', timeout: 2000 });
    const data = r.status === 0 ? JSON.parse(r.stdout) : null;
    return data && typeof data === 'object' && !Array.isArray(data) ? { file, data } : UNREADABLE(file);
  } catch { return UNREADABLE(file); }
}

// [{ file, data, unreadable? }] of every policy source that exists.
function managedSources() {
  const out = [];
  for (const f of managedSettingsFiles()) {
    out.push(readSource(f));
    for (const d of dropInFiles(f)) out.push(readSource(d));
  }
  out.push(readSource(path.join(claudeDir(), 'remote-settings.json')));
  for (const p of managedPreferenceFiles()) out.push(readPlist(p));
  return out.filter(Boolean);
}

function settingsSources(projectDir) {
  const files = [path.join(claudeDir(), 'settings.json')];
  if (projectDir) {
    files.push(path.join(projectDir, '.claude', 'settings.json'));
    files.push(path.join(projectDir, '.claude', 'settings.local.json'));
  }
  return [...managedSources(), ...files.map(readSource).filter(Boolean)];
}

function unreadableSources(sources) {
  return sources.filter((s) => s.unreadable).map((s) => s.file);
}

// Kept for callers that only need the paths (doctor).
function settingsFiles(projectDir) {
  return settingsSources(projectDir).map((s) => s.file);
}

function rulesFrom(sources) {
  const rules = [];
  for (const { file, data } of sources) {
    const p = data.permissions;
    if (!p || typeof p !== 'object') continue;
    for (const kind of ['deny', 'ask']) {
      if (Array.isArray(p[kind])) for (const r of p[kind]) if (typeof r === 'string') rules.push({ kind, rule: r.trim(), file });
    }
  }
  return rules;
}

// Fail safe: a rule that starts with Agent/Task but cannot be read exactly (spacing,
// wildcards, unusual syntax) counts as applying, so the plugin rather does nothing.
function ruleMatchesAgent(rule, agentType) {
  const m = /^(Agent|Task)\b\s*(.*)$/.exec(rule);
  if (!m) return false;
  const rest = m[2].trim();
  if (rest === '') return true;
  const inner = /^\((.*)\)$/.exec(rest);
  if (!inner) return true;
  const content = inner[1].trim();
  if (content === '' || /[*?[\]{}]/.test(content)) return true;
  return content === agentType;
}

// A settings file that exists but cannot be read may hold a deny or ask rule, so it
// counts as one: { kind: 'unreadable', rule: <file> }.
function agentRuleApplies(agentType, projectDir, sources = settingsSources(projectDir)) {
  const broken = sources.find((s) => s.unreadable);
  if (broken) return { kind: 'unreadable', rule: broken.file, file: broken.file };
  return rulesFrom(sources).find((r) => ruleMatchesAgent(r.rule, agentType)) || null;
}

function inFamily(entry, alias) {
  return typeof entry === 'string' && entry.toLowerCase().includes(alias);
}

// Whether Claude Code would run a subagent on `alias`. If availableModels does not
// allow it, Claude Code replaces it with the parent model, which can be an upgrade.
// Every source that sets availableModels must allow the family, none may deny it;
// anything unreadable counts as "not allowed".
function modelAllowed(alias, projectDir, sources = settingsSources(projectDir)) {
  if (!MODEL_FAMILIES.includes(alias)) return { ok: false, why: 'unknown-alias' };
  for (const { file, data, unreadable } of sources) {
    if (unreadable) return { ok: false, why: 'settings-unreadable', file };
    if (data.availableModels !== undefined) {
      if (!Array.isArray(data.availableModels)) return { ok: false, why: 'availableModels-unreadable', file };
      if (!data.availableModels.some((e) => inFamily(e, alias))) return { ok: false, why: 'not-in-availableModels', file };
    }
    if (data.deniedModels !== undefined) {
      if (!Array.isArray(data.deniedModels)) return { ok: false, why: 'deniedModels-unreadable', file };
      if (data.deniedModels.some((e) => inFamily(e, alias))) return { ok: false, why: 'in-deniedModels', file };
    }
  }
  return { ok: true };
}

function managedHooksOnly() {
  return managedSources().some((s) => s.data.allowManagedHooksOnly === true);
}

module.exports = {
  agentRuleApplies, ruleMatchesAgent, modelAllowed, managedSettingsFiles, managedSources, managedHooksOnly, settingsFiles, settingsSources, rulesFrom, unreadableSources,
};
