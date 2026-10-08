#!/usr/bin/env node
'use strict';
// Entry point for every hook. Usage: node hook.js <mode>  (JSON event on stdin)
// Contract: always exit 0; print at most one JSON object; any internal error means
// "no opinion" so Claude Code behaves as if the plugin were not installed.
const fs = require('fs');
const path = require('path');
const { readStdin, finish, nowMs, appendLog, logError, sessionDir, pacerHome, readJson, writeJsonAtomic, sleepMs, safeName } = require('./lib/util');
const { loadConfig, configFile } = require('./lib/config');
const { evaluate, decideSpawn, lvlRank, classify, downgradeActive, needsEffectiveModel, targetModel } = require('./lib/policy');
const { resolveEffective, setSessionModel } = require('./lib/models');
const { toolUseMessageId } = require('./lib/transcript');
const { agentRuleApplies, modelAllowed, managedHooksOnly, settingsSources } = require('./lib/permissions');
const { loadSamples } = require('./lib/samples');
const { computeWait } = require('./lib/throttle');
const registry = require('./lib/registry');
const reissue = require('./lib/reissue');
const { withLock } = require('./lib/lock');
const msg = require('./lib/messages');
const install = require('./lib/install');

const REMINDER_INTERVAL_MS = 24 * 3600 * 1000;

// Permission modes in which an Agent call runs without any further check, so
// allow + updatedInput skips nothing. In auto mode allow would also skip the classifier
// (proven end to end) and "ask" makes the call fail, so every other mode, including
// unknown future ones, gets the re-issue request instead.
const REWRITE_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']);

function projectDirOf(input) {
  return process.env.CLAUDE_PROJECT_DIR || (input && typeof input.cwd === 'string' ? input.cwd : null);
}

function forceEnv() {
  const v = process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
  return !!v && v !== '0' && v.toLowerCase() !== 'false';
}

function preToolUse(decision, reason, extra = {}) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason, ...extra } };
}

function onPreAgent(input, cfg) {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return null;
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object' || Array.isArray(ti)) return null;
  const sid = input.session_id;
  if (!sid || typeof sid !== 'string') return null;
  const now = nowMs();
  const agentType = typeof ti.subagent_type === 'string' && ti.subagent_type.trim() ? ti.subagent_type.trim() : 'general-purpose';
  const permissionMode = typeof input.permission_mode === 'string' && input.permission_mode ? input.permission_mode : null;
  const ev = evaluate(now, cfg);
  // Exactly one audit line per decision, whichever path decides.
  const log = (fields) => appendLog({
    kind: 'pre-agent', session: sid, agentType, cls: classify(agentType, cfg), level: ev.level, active: null,
    effective: null, effectiveSource: null, permissionMode, action: null, model: null, reason: null, ...fields,
  });

  if (!downgradeActive(ev.level, cfg.strategy)) {
    log({ action: 'none', reason: `strategy-${cfg.strategy}` });
    return null;
  }
  const projectDir = projectDirOf(input);
  const sources = settingsSources(projectDir);
  const rule = agentRuleApplies(agentType, projectDir, sources);
  if (rule) {
    log({ action: 'skip', reason: rule.kind === 'unreadable' ? 'settings-unreadable' : `permission-${rule.kind}-rule`, rule: rule.rule });
    return null;
  }
  // A target outside availableModels/deniedModels would make Claude Code fall back to
  // the parent model, which can be an upgrade. Checked before the lock (reads settings).
  const target = lvlRank(ev.level) >= lvlRank('amber') ? targetModel(ev.level, classify(agentType, cfg), cfg) : null;
  const targetOk = target ? modelAllowed(target, projectDir, sources) : { ok: true };

  // Resolved outside the session lock: it may wait up to 1.5 s for the transcript line,
  // and parallel spawns must not queue behind that wait. Only done when the decision
  // depends on it (GREEN and STOP never wait).
  const force = forceEnv();
  const eff = needsEffectiveModel({ level: ev.level, agentType, cfg, forceEnv: force })
    ? resolveEffective({
      toolInput: ti, agentType, sessionId: sid, cwd: input.cwd, projectDir,
      transcriptPath: input.transcript_path, toolUseId: input.tool_use_id,
    })
    : null;

  let active = 0;
  const d = withLock(registry.sessionLock(sid), () => {
    active = registry.countActive(sid, now);
    let dec = decideSpawn({ level: ev.level, agentType, eff, active, cfg, forceEnv: force });
    if (dec.action === 'rewrite' && !targetOk.ok) dec = { action: 'none', reason: 'target-not-allowed', detail: targetOk.why };
    const key = reissue.callKey(agentType, ti);
    if (dec.action === 'rewrite' && !REWRITE_MODES.has(permissionMode)) {
      if (reissue.wasRequested(sid, key, now)) {
        dec = { action: 'none', reason: 'reissue-ignored' }; // Claude kept the call as it was: no second deny
      } else if (reissue.remember(sid, key, now)) {
        dec = { ...dec, action: 'reissue' };
      } else {
        // Without a stored guard the same call would be denied again and again.
        dec = { action: 'none', reason: 'reissue-unpersistable' };
      }
    } else if (dec.action === 'none') {
      reissue.forget(sid, key, now); // request honoured; a later identical call is a new spawn
    }
    if (dec.action === 'none' || dec.action === 'rewrite') {
      try { registry.reserve(sid, input.tool_use_id, agentType, now); } catch (e) { logError('reserve', e); } // counting is best effort
    }
    return dec;
  });

  log({
    active, effective: eff ? eff.model : null, effectiveSource: eff ? eff.source : 'not-needed',
    action: d.action, model: d.model || null, reason: d.reason, ...(d.detail ? { detail: d.detail } : {}),
  });
  if (d.action === 'deny') return preToolUse('deny', msg.denyReason(d, ev, active));
  if (d.action === 'reissue') return preToolUse('deny', msg.reissueReason(d, ev));
  if (d.action === 'rewrite') return preToolUse('allow', msg.rewriteReason(d, ev), { updatedInput: { ...ti, model: d.model } });
  return null;
}

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

const BUDGET_KEEP_MS = 3600 * 1000;

// Transcript that holds the line of this tool call: the subagent's own file for calls
// inside a subagent (transcript_path always names the main transcript).
function transcriptOfCall(input) {
  const main = typeof input.transcript_path === 'string' && input.transcript_path ? input.transcript_path : null;
  if (!main) return null;
  if (typeof input.agent_id === 'string' && /^[A-Za-z0-9_-]+$/.test(input.agent_id)) {
    return path.join(path.dirname(main), safeName(input.session_id), 'subagents', `agent-${input.agent_id}.jsonl`);
  }
  return main;
}

// Claude Code runs the non-read-only tool calls of one response one after another, and
// each would pause on its own: four edits at 90 s keep the next request waiting past
// the 5-minute prompt-cache TTL. So all tool calls of one API response share ONE pause:
// the first call opens it and stores its end (real time); every call of that response
// waits until that end. Sequential calls after the first therefore no longer pause,
// while calls that run at the same time (parallel Agent spawns) all wait for it, so the
// throttle also slows a fan-out. Without a transcript line the call pauses in full.
// Returns { untilMs, shared }: shared = the pause was opened by another call.
function pauseForCall(input, sid, waitSec, now) {
  const t0 = Date.now();
  const own = { untilMs: t0 + waitSec * 1000, shared: false };
  const msgId = toolUseMessageId(transcriptOfCall(input), input.tool_use_id, { timeoutMs: Math.min(1000, waitSec * 1000) });
  if (!msgId) return own;
  const file = path.join(sessionDir(sid), 'throttle-budget.json');
  return withLock(path.join(sessionDir(sid), 'throttle-budget.lock'), () => {
    const raw = readJson(file, {}) || {};
    const entries = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && Number.isFinite(v.until) && Number.isFinite(v.t) && Math.abs(now - v.t) <= BUDGET_KEEP_MS) entries[k] = v;
    }
    if (entries[msgId]) return { untilMs: entries[msgId].until, shared: true };
    entries[msgId] = { until: own.untilMs, t: now };
    try { writeJsonAtomic(file, entries); } catch { /* unsaved: the next call of this response pauses in full */ }
    return own;
  });
}

// PreToolUse for every tool (also inside subagents): pause while usage is ahead of the
// schedule. Never returns a permission decision; a hook timeout only ends the pause early.
function onThrottle(input, cfg) {
  if (cfg.strategy !== 'throttle' && cfg.strategy !== 'both') return null;
  const sid = input.session_id;
  if (!sid || typeof sid !== 'string' || typeof input.tool_name !== 'string') return null;
  const now = nowMs();
  const w = computeWait(loadSamples(), now, cfg);
  const pausing = w.waitSec > 0;
  const stateFile = path.join(sessionDir(sid), 'throttle.json');
  const isActive = () => (readJson(stateFile, {}) || {}).active === true;
  // Parallel tool calls run this hook at the same time; only one may announce a change.
  // The common case (no change) needs no lock.
  const changed = isActive() !== pausing && withLock(path.join(sessionDir(sid), 'throttle.lock'), () => {
    if (isActive() === pausing) return false;
    try { writeJsonAtomic(stateFile, { active: pausing, t: now }); } catch { return false; }
    return true;
  });
  if (pausing) {
    const base = {
      session: sid, tool: input.tool_name, window: w.lead.name, used: round1(w.lead.used), allowed: round1(w.lead.allowed),
    };
    // With "both" from RED on, Agent calls belong to the downgrade policy, which may deny
    // or ask for a re-issue; pausing them as well would cost a full pause per attempt.
    if ((input.tool_name === 'Agent' || input.tool_name === 'Task') && cfg.strategy === 'both'
      && downgradeActive(evaluate(now, cfg).level, cfg.strategy)) {
      appendLog({ kind: 'throttle-skip', ...base, planned: w.waitSec, reason: 'agent-call-downgrade' });
    } else {
      const p = pauseForCall(input, sid, w.waitSec, now);
      // Capped at the computed wait, so a corrupt or foreign end time never pauses longer.
      const leftMs = Math.min(w.waitSec * 1000, p.untilMs - Date.now());
      const leftSec = round1(leftMs / 1000);
      if (leftMs > 0 && leftSec > 0) {
        appendLog({ kind: 'throttle', ...base, waitSec: p.shared ? leftSec : w.waitSec, ...(p.shared ? { planned: w.waitSec } : {}) });
        sleepMs(leftMs);
      } else {
        appendLog({ kind: 'throttle-skip', ...base, planned: w.waitSec, reason: 'response-budget-used' });
      }
    }
  }
  if (!changed || !cfg.notify) return null;
  return { systemMessage: pausing ? msg.throttleOnMessage(w, cfg) : msg.throttleOffMessage(w, cfg) };
}

function onSubagentStart(input) {
  if (!input.session_id) return null;
  registry.startAgent(input.session_id, input.agent_id, input.agent_type || null, nowMs());
  return null;
}

function onSubagentStop(input) {
  if (!input.session_id) return null;
  registry.stopAgent(input.session_id, input.agent_id);
  return null;
}

function onPrompt(input, cfg) {
  if (cfg.strategy === 'throttle') return null; // the throttle reports itself; nothing for Claude
  const sid = input.session_id;
  if (!sid) return null;
  const now = nowMs();
  const ev = evaluate(now, cfg);
  const paced = (level) => lvlRank(level) >= lvlRank('amber') && downgradeActive(level, cfg.strategy);
  const notifyFile = path.join(sessionDir(sid), 'notify.json');
  const last = readJson(notifyFile, {}) || {};
  const out = {};
  if (paced(ev.level)) {
    const active = registry.countActive(sid, now);
    out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: msg.contextForClaude(ev, cfg, active) };
  }
  const lastLevel = last.level || 'unknown';
  if (cfg.notify && ev.level !== lastLevel && (paced(ev.level) || (paced(lastLevel) && ev.level !== 'unknown'))) {
    out.systemMessage = msg.levelChangeMessage(ev, cfg);
  }
  if (ev.level !== lastLevel && ev.level !== 'unknown') {
    try { writeJsonAtomic(notifyFile, { level: ev.level, t: now }); } catch { /* ignore */ }
  }
  if (out.systemMessage || out.hookSpecificOutput) {
    appendLog({ kind: 'prompt', session: sid, level: ev.level, notified: !!out.systemMessage });
    return out;
  }
  return null;
}

function pruneSessions(now) {
  const base = path.join(pacerHome(), 'sessions');
  let names = [];
  try { names = fs.readdirSync(base); } catch { return; }
  for (const n of names) {
    const p = path.join(base, n);
    try {
      if (now - fs.statSync(p).mtimeMs > 3 * 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

function modelId(v) {
  if (typeof v === 'string') return v;
  return v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null;
}

function onSessionStart(input, cfg) {
  const now = nowMs();
  const model = modelId(input.model);
  if (input.session_id && model) setSessionModel(input.session_id, model);
  const notes = [];
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    try { install.syncBin(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts')); } catch (e) { logError('sync-bin', e); }
  }
  const remindersFile = path.join(pacerHome(), 'reminders.json');
  const reminders = readJson(remindersFile, {}) || {};
  const due = (key) => !reminders[key] || now - reminders[key] > REMINDER_INTERVAL_MS;
  const de = cfg.language !== 'en';
  if (!install.statuslineInstalled() && due('statusline')) {
    notes.push(de
      ? 'quota-pacer: Der Kontingent-Sensor ist noch nicht aktiv. Einmalig /quota-pacer:setup ausführen.'
      : 'quota-pacer: the quota sensor is not active yet. Run /quota-pacer:setup once.');
    reminders.statusline = now;
  }
  // Only relevant when the plugin changes models; the throttle works regardless.
  if (cfg.strategy !== 'throttle' && forceEnv() && due('force')) {
    notes.push(de
      ? 'quota-pacer: CLAUDE_CODE_SUBAGENT_MODEL_FORCE ist gesetzt – Modellwechsel für Subagents sind damit wirkungslos, nur das Parallel-Limit greift.'
      : 'quota-pacer: CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set – subagent model changes have no effect; only the parallel limit applies.');
    reminders.force = now;
  }
  // Not rate-limited: while config.json does not parse, every intervention is off.
  if (cfg._fileError) {
    notes.push(de
      ? `quota-pacer: ${cfg._fileError} – alle Eingriffe sind aus, bis die Datei wieder gültig ist (${configFile()}).`
      : `quota-pacer: ${cfg._fileError} – all interventions are off until the file is valid again (${configFile()}).`);
  }
  if (cfg._errors && cfg._errors.length && due('config')) {
    notes.push(de
      ? `quota-pacer: config.json – ungültige Felder auf Standard gesetzt: ${cfg._errors.join(', ')}`
      : `quota-pacer: config.json – invalid fields replaced by defaults: ${cfg._errors.join(', ')}`);
    reminders.config = now;
  }
  if (managedHooksOnly() && due('managed')) {
    notes.push(de
      ? 'quota-pacer: allowManagedHooksOnly ist aktiv – Plugin-Hooks und die eigene Statusline werden blockiert.'
      : 'quota-pacer: allowManagedHooksOnly is active – plugin hooks and the status line are blocked.');
    reminders.managed = now;
  }
  if (notes.length) { try { writeJsonAtomic(remindersFile, reminders); } catch { /* ignore */ } }
  pruneSessions(now);
  return notes.length ? { systemMessage: notes.join('\n') } : null;
}

function onModelSwitch(input) {
  const model = modelId(input.to_model);
  if (input.session_id && model) setSessionModel(input.session_id, model);
  return null;
}

function onSessionEnd(input) {
  if (!input.session_id) return null;
  try { fs.rmSync(sessionDir(input.session_id), { recursive: true, force: true }); } catch { /* ignore */ }
  return null;
}

const HANDLERS = {
  'pre-agent': onPreAgent,
  throttle: onThrottle,
  'subagent-start': onSubagentStart,
  'subagent-stop': onSubagentStop,
  prompt: onPrompt,
  'session-start': onSessionStart,
  'model-switch': onModelSwitch,
  'session-end': onSessionEnd,
};

async function main() {
  const mode = process.argv[2];
  const handler = HANDLERS[mode];
  const raw = await readStdin(3000);
  if (!handler) return finish('');
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return finish(''); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return finish('');
  let out = null;
  try {
    const cfg = loadConfig();
    // SessionStart still runs for a config.json that does not parse, to report it.
    if (!cfg.enabled && mode !== 'session-end' && !(mode === 'session-start' && cfg._fileError)) return finish('');
    out = handler(input, cfg);
  } catch (e) {
    logError(mode, e);
    out = null;
  }
  return finish(out ? JSON.stringify(out) : '');
}

main().catch((e) => { logError('main', e); finish(''); });
