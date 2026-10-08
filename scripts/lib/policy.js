'use strict';
const path = require('path');
const { pacerHome, readJson, writeJsonAtomic } = require('./util');
const { analyzeWindow, WINDOWS } = require('./forecast');
const { loadSamples } = require('./samples');
const { rankOf } = require('./models');

const LEVELS = ['unknown', 'green', 'amber', 'red', 'stop'];
const lvlRank = (l) => Math.max(0, LEVELS.indexOf(l));

// Level of one window. Usage never falls inside a window, so hysteresis only
// applies to the forecast-based conditions (projection and time to reserve).
function windowLevel(st, wcfg, prevLevel, hysteresisPct) {
  if (!st || st.status === 'nodata' || st.status === 'stale') return 'unknown';
  if (st.status === 'reset') return 'green';
  const H = 100 - wcfg.reservePct;
  const u = st.used;
  const p = st.projected;
  if (u >= H) return 'stop';
  const holdRed = lvlRank(prevLevel) >= lvlRank('red');
  const holdAmber = lvlRank(prevLevel) >= lvlRank('amber');
  const redByUse = u >= wcfg.red.usedPct;
  let redByForecast = false;
  if (p !== null && p !== undefined) {
    const projOk = p >= H - (holdRed ? hysteresisPct : 0);
    const mtr = wcfg.red.minutesToReserve;
    const timeOk = mtr === null || mtr === undefined
      || (st.minutesToReserve !== null && st.minutesToReserve <= mtr * (holdRed ? 1.5 : 1));
    redByForecast = projOk && timeOk;
  }
  if (redByUse || redByForecast) return 'red';
  const amberByUse = u >= wcfg.amber.usedPct;
  const amberByForecast = p !== null && p !== undefined
    && p >= wcfg.amber.projectedPct - (holdAmber ? hysteresisPct : 0);
  if (amberByUse || amberByForecast) return 'amber';
  return 'green';
}

function levelFile() {
  return path.join(pacerHome(), 'level.json');
}

function evaluate(now, cfg, { persist = true, samples = loadSamples() } = {}) {
  const prev = readJson(levelFile(), {}) || {};
  const prevWin = prev.windows || {};
  const windows = {};
  let overall = 'unknown';
  for (const name of Object.keys(WINDOWS)) {
    const st = analyzeWindow(samples, name, now, cfg);
    const pw = prevWin[name] || {};
    // A new window (different reset time) starts without hysteresis memory.
    const sameWindow = pw.resetsAt && st.resetsAt && Math.abs(pw.resetsAt - st.resetsAt) <= 180000;
    const prevLevel = sameWindow ? pw.level : 'green';
    const level = windowLevel(st, cfg.windows[name], prevLevel, cfg.hysteresisPct);
    windows[name] = { ...st, level };
    if (lvlRank(level) > lvlRank(overall)) overall = level;
  }
  const changed = overall !== prev.level;
  const state = {
    level: overall,
    changedAt: changed ? now : (prev.changedAt || now),
    windows: Object.fromEntries(Object.entries(windows).map(([k, v]) => [k, { level: v.level, resetsAt: v.resetsAt || null }])),
  };
  if (persist) {
    const before = JSON.stringify({ level: prev.level, windows: prev.windows });
    const after = JSON.stringify({ level: state.level, windows: state.windows });
    if (before !== after) {
      try { writeJsonAtomic(levelFile(), state); } catch { /* read-only home: decisions still work */ }
    }
  }
  return { level: overall, windows, changed, previous: prev.level || 'unknown', now };
}

function classify(agentType, cfg) {
  if (cfg.protectedAgents.includes(agentType)) return 'protected';
  if (cfg.routineAgents.includes(agentType)) return 'routine';
  return 'default';
}

// Whether the downgrade policy (models, concurrency cap, context for Claude) acts at this
// level. "throttle" never downgrades; "both" only from RED on, below that it only pauses.
function downgradeActive(level, strategy) {
  if (strategy === 'downgrade') return true;
  if (strategy === 'both') return level === 'red' || level === 'stop';
  return false;
}

function targetModel(level, cls, cfg) {
  const byLevel = cfg.models[level];
  return byLevel ? byLevel[cls] || null : null;
}

// True when the spawn decision depends on the effective model. Only then is it worth
// resolving it (which can wait for the transcript).
function needsEffectiveModel({ level, agentType, cfg, forceEnv }) {
  if (level !== 'amber' && level !== 'red') return false;
  if (agentType === 'fork' || forceEnv) return false;
  return !!targetModel(level, classify(agentType, cfg), cfg);
}

// Decide what to do with one Agent tool call.
//   eff: { model, rank } effective model the subagent would run on without us (rank null = unknown)
//   active: subagents already running or reserved in this session
function decideSpawn({ level, agentType, eff, active, cfg, forceEnv }) {
  // No or stale data: the plugin must behave as if it were not installed, so not even
  // a configured GREEN cap applies.
  if (level === 'unknown') return { action: 'none', reason: 'unknown' };
  if (level === 'green') {
    const cap = cfg.concurrency.green;
    if (cap !== null && active >= cap) return { action: 'deny', reason: 'cap', cap };
    return { action: 'none', reason: level };
  }
  const cap = cfg.concurrency[level];
  if (cap !== null && cap !== undefined && active >= cap) return { action: 'deny', reason: level === 'stop' ? 'stop' : 'cap', cap };
  if (level === 'stop') return { action: 'deny', reason: 'stop', cap };
  if (agentType === 'fork') return { action: 'none', reason: 'fork-shares-main-model' };
  if (forceEnv) return { action: 'none', reason: 'force-env' };
  const cls = classify(agentType, cfg);
  const target = targetModel(level, cls, cfg);
  if (!target) return { action: 'none', reason: `no-target-${cls}` };
  const targetRank = rankOf(target);
  if (!eff || eff.rank === null || eff.rank === undefined) {
    // Unknown effective model: only the cheapest tier is guaranteed not to upgrade.
    if (target === 'haiku') return { action: 'rewrite', model: target, cls, reason: 'unknown-effective' };
    return { action: 'none', reason: 'unknown-effective-model' };
  }
  // A main model read from an older message may be stale (see models.js): moving to
  // anything above the cheapest tier could then be an upgrade.
  if (eff.uncertain && target !== 'haiku') return { action: 'none', reason: 'uncertain-effective-model' };
  if (targetRank < eff.rank) return { action: 'rewrite', model: target, cls, reason: 'downgrade' };
  return { action: 'none', reason: 'already-at-or-below-target' };
}

module.exports = {
  LEVELS, lvlRank, windowLevel, evaluate, decideSpawn, classify, levelFile, downgradeActive, targetModel, needsEffectiveModel,
};
