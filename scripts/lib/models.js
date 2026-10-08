'use strict';
// Works out which model a subagent would run on WITHOUT the plugin, so the plugin
// only ever moves a subagent to a cheaper model, never to a more expensive one.
// Resolution order documented for Claude Code >= 2.1.251:
//   per-invocation `model`  >  definition frontmatter `model`  >  CLAUDE_CODE_SUBAGENT_MODEL  >  main model
// The main model is taken from the transcript line of this very tool call, then from the
// session state (status line, SessionStart, PostModelSwitch), then from the last assistant
// line. Settings files and ANTHROPIC_MODEL are deliberately ignored: --model and /model
// override them, and trusting them once moved the subagents of a haiku session UP to sonnet.
const fs = require('fs');
const path = require('path');
const { claudeDir, sessionDir, readJson, writeJsonAtomic } = require('./util');
const { toolUseModel, lastAssistantModel } = require('./transcript');

function rankOf(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const m = model.toLowerCase();
  if (m.includes('fable') || m === 'best') return 4;
  if (m.includes('opus') || m === 'default') return 3; // opusplan counts as opus (conservative)
  if (m.includes('sonnet')) return 2;
  if (m.includes('haiku')) return 1;
  return null;
}

const BUILTIN = {
  Explore: 'main', // ignores CLAUDE_CODE_SUBAGENT_MODEL
  Plan: 'main', // ignores CLAUDE_CODE_SUBAGENT_MODEL
  'general-purpose': 'env-or-main',
  claude: 'env-or-main',
  fork: 'main',
  'claude-code-guide': 'haiku',
  'statusline-setup': 'sonnet',
};

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function listMd(dir, depth = 0, acc = []) {
  if (depth > 4 || acc.length > 300) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listMd(p, depth + 1, acc);
    else if (e.isFile() && e.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

// Agent directories in priority order: project dirs closest to cwd first, then user.
function agentDirs(cwd, projectDir) {
  const dirs = [];
  const seen = new Set();
  const add = (d) => { const k = path.resolve(d); if (!seen.has(k)) { seen.add(k); dirs.push(k); } };
  if (cwd) {
    let cur = path.resolve(cwd);
    for (let i = 0; i < 40; i++) {
      add(path.join(cur, '.claude', 'agents'));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  if (projectDir) add(path.join(projectDir, '.claude', 'agents'));
  add(path.join(claudeDir(), 'agents'));
  return dirs;
}

// Returns { found: true, model } for a custom definition (model may be undefined), else { found: false }.
function findDefinition(agentType, cwd, projectDir) {
  if (!agentType || agentType.includes(':')) return { found: false };
  for (const dir of agentDirs(cwd, projectDir)) {
    for (const file of listMd(dir)) {
      let fm = null;
      try { fm = parseFrontmatter(fs.readFileSync(file, 'utf8')); } catch { fm = null; }
      if (fm && fm.name === agentType && fm.description) return { found: true, model: fm.model || undefined, file };
    }
  }
  return { found: false };
}

function setSessionModel(sessionId, model) {
  if (!sessionId || typeof model !== 'string' || !model.trim()) return;
  const file = path.join(sessionDir(sessionId), 'model.json');
  const cur = readJson(file, null);
  if (cur && cur.model === model) return;
  try { writeJsonAtomic(file, { model }); } catch { /* ignore */ }
}

function getSessionModel(sessionId) {
  const cur = readJson(path.join(sessionDir(sessionId), 'model.json'), null);
  return cur && typeof cur.model === 'string' ? cur.model : null;
}

// { model, source } of the main thread; model null when unknown (then only haiku is a
// safe target). waitMs bounds the wait for the asynchronously written transcript line.
function mainModel({ sessionId, transcriptPath, toolUseId, waitMs = 1500 } = {}) {
  const fromCall = toolUseModel(transcriptPath, toolUseId, { timeoutMs: waitMs });
  if (fromCall) return { model: fromCall, source: 'transcript' };
  const fromSession = sessionId ? getSessionModel(sessionId) : null;
  if (fromSession) return { model: fromSession, source: 'session' };
  const fromLast = lastAssistantModel(transcriptPath);
  if (fromLast) return { model: fromLast, source: 'last-assistant' };
  return { model: null, source: 'unknown' };
}

function envSubagentModel(env) {
  const v = env.CLAUDE_CODE_SUBAGENT_MODEL;
  if (!v || !v.trim() || v.trim() === 'inherit') return null;
  return v.trim();
}

// effectiveSource tells where the model came from; for an inherited main model it is
// "<path>/<main source>", e.g. "builtin-main/transcript".
function resolveEffective({ toolInput, agentType, sessionId, cwd, projectDir, transcriptPath, toolUseId, env = process.env, waitMs }) {
  const requested = toolInput && typeof toolInput.model === 'string' && toolInput.model.trim() ? toolInput.model.trim() : null;
  if (requested && requested !== 'inherit') return { model: requested, rank: rankOf(requested), source: 'invocation' };
  // "last-assistant" is the message BEFORE this call: after /model it still names the old
  // main model, so it only proves an upper bound when the target is the cheapest tier.
  const main = (via) => {
    const m = mainModel({ sessionId, transcriptPath, toolUseId, waitMs });
    return { model: m.model, rank: rankOf(m.model), source: `${via}/${m.source}`, ...(m.source === 'last-assistant' ? { uncertain: true } : {}) };
  };
  const def = findDefinition(agentType, cwd, projectDir);
  if (def.found) {
    if (def.model && def.model !== 'inherit') return { model: def.model, rank: rankOf(def.model), source: 'definition' };
    if (def.model === 'inherit') return main('definition-inherit');
    const e = envSubagentModel(env);
    if (e) return { model: e, rank: rankOf(e), source: 'env' };
    return main('main');
  }
  const b = BUILTIN[agentType];
  if (agentType === 'Explore') {
    // Measured on 2.1.291: with a Fable main thread, Explore runs on Opus.
    const m = main('builtin-main');
    return m.rank === 4 ? { ...m, model: 'opus', rank: 3, source: `builtin-explore-cap/${m.source.split('/').slice(1).join('/')}` } : m;
  }
  if (b === 'main') return main('builtin-main');
  if (b === 'env-or-main') {
    const e = envSubagentModel(env);
    if (e) return { model: e, rank: rankOf(e), source: 'env' };
    return main('builtin-main');
  }
  if (b) return { model: b, rank: rankOf(b), source: 'builtin-fixed' };
  return { model: null, rank: null, source: 'unknown' }; // plugin-scoped or undiscoverable agent
}

module.exports = { rankOf, resolveEffective, findDefinition, parseFrontmatter, setSessionModel, getSessionModel, mainModel, BUILTIN };
