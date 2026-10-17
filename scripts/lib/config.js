'use strict';
const fs = require('fs');
const path = require('path');
const { pacerHome, writeJsonAtomic, stripBom, nowMs } = require('./util');
const { activePause } = require('./pause');

const DEFAULTS = Object.freeze({
  enabled: true,
  language: 'de',
  // throttle: pause between steps, models unchanged (default since 1.1.0)
  // downgrade: cheaper subagent models and a concurrency cap (the 1.0.0 behaviour)
  // both: throttle first, from RED on additionally downgrade
  strategy: 'throttle',
  // Pauses must stay well below the 5-minute prompt-cache TTL. The schedule aims at
  // reserve + buffer so a late detected overrun still has room.
  // Weekly window only: the schedule rises ~0.007 points per minute, so without a dead
  // band a lead of 0.1 point (whole-percent readings) already meant the maximum pause for
  // ~14 min. The ramp makes the pause grow with the lead instead of jumping to the cap.
  // Escalation: above escalateLeadPct points ahead of the schedule the pause cap rises
  // towards escalatedMaxWaitSec and subagents are limited to escalatedAgentCap in parallel;
  // from haltLeadPct on every pause is the maximum and no new subagent starts.
  throttle: {
    bufferPct: 10, earlySlackPct: 15, releaseFraction: 0.1, maxWaitSec: 90, minWaitSec: 2,
    weeklyDeadbandPct: 1, weeklyRampPct: 3,
    escalateLeadPct: 5, haltLeadPct: 12, escalatedMaxWaitSec: 240, escalatedAgentCap: 1,
  },
  windows: {
    fiveHour: {
      reservePct: 5,
      amber: { usedPct: 70, projectedPct: 90 },
      red: { usedPct: 85, minutesToReserve: 90 },
    },
    sevenDay: {
      reservePct: 3,
      amber: { usedPct: 80, projectedPct: 90 },
      red: { usedPct: 92, minutesToReserve: null },
    },
  },
  hysteresisPct: 8,
  lookbackMinutes: 30,
  // A projection needs samples spanning this long, otherwise a burst right at the start
  // of a session would extrapolate to RED. Before that only the usage thresholds count.
  minForecastMinutes: 15,
  maxSampleAgeMinutes: 20,
  activeHours: { days: [1, 2, 3, 4, 5], start: 7, end: 19 },
  concurrency: { green: null, amber: 3, red: 1, stop: 0 },
  models: {
    amber: { routine: 'haiku', default: 'sonnet', protected: null },
    red: { routine: 'haiku', default: 'haiku', protected: 'sonnet' },
  },
  routineAgents: ['Explore', 'claude-code-guide', 'statusline-setup'],
  protectedAgents: ['Plan'],
  notify: true,
  statusSegment: true,
  chain: null,
});

const MODEL_ALIASES = new Set(['haiku', 'sonnet', 'opus']);
const STRATEGIES = new Set(['throttle', 'downgrade', 'both']);
const MIN_SCHEDULE_TARGET = 25;
const THROTTLE_RANGES = {
  bufferPct: [0, 50],
  earlySlackPct: [0, 100],
  releaseFraction: [0, 1],
  maxWaitSec: [0, 240],
  minWaitSec: [0, 60],
  weeklyDeadbandPct: [0, 10],
  weeklyRampPct: [0, 50],
  escalateLeadPct: [0, 100],
  haltLeadPct: [0, 100],
  escalatedMaxWaitSec: [0, 240],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(base[k]) && isPlainObject(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function num(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

// Replace any invalid field with its default so one typo never disables the plugin.
function validate(cfg) {
  const d = DEFAULTS;
  const out = clone(cfg);
  const errors = [];
  const fix = (cond, pathStr, apply) => {
    if (!cond) { errors.push(pathStr); apply(); }
  };
  fix(typeof out.enabled === 'boolean', 'enabled', () => { out.enabled = d.enabled; });
  fix(out.language === 'de' || out.language === 'en', 'language', () => { out.language = d.language; });
  fix(STRATEGIES.has(out.strategy), 'strategy', () => { out.strategy = d.strategy; });
  if (!isPlainObject(out.throttle)) {
    errors.push('throttle');
    out.throttle = clone(d.throttle);
  } else {
    for (const [k, [min, max]] of Object.entries(THROTTLE_RANGES)) {
      fix(num(out.throttle[k], min, max), `throttle.${k}`, () => { out.throttle[k] = d.throttle[k]; });
    }
    const t = out.throttle;
    fix(Number.isInteger(t.escalatedAgentCap) && t.escalatedAgentCap >= 0 && t.escalatedAgentCap <= 100,
      'throttle.escalatedAgentCap', () => { t.escalatedAgentCap = d.throttle.escalatedAgentCap; });
    // The cap rises between the two leads, so the halt must not lie below the start
    // (both at 100 switches the escalation off).
    fix(t.haltLeadPct >= t.escalateLeadPct, 'throttle.haltLeadPct', () => {
      t.escalateLeadPct = d.throttle.escalateLeadPct;
      t.haltLeadPct = d.throttle.haltLeadPct;
    });
  }
  for (const w of ['fiveHour', 'sevenDay']) {
    const ow = out.windows && out.windows[w];
    const dw = d.windows[w];
    if (!isPlainObject(ow)) { errors.push(`windows.${w}`); out.windows = { ...(out.windows || {}), [w]: clone(dw) }; continue; }
    fix(num(ow.reservePct, 0, 50), `windows.${w}.reservePct`, () => { ow.reservePct = dw.reservePct; });
    fix(isPlainObject(ow.amber) && num(ow.amber.usedPct, 0, 100) && num(ow.amber.projectedPct, 0, 1000),
      `windows.${w}.amber`, () => { ow.amber = clone(dw.amber); });
    fix(isPlainObject(ow.red) && num(ow.red.usedPct, 0, 100)
      && (ow.red.minutesToReserve === null || num(ow.red.minutesToReserve, 0, 100000)),
      `windows.${w}.red`, () => { ow.red = clone(dw.red); });
  }
  // The schedule steers to 100 - reserve - buffer. Two in-range values can add up to a
  // target near 0 (e.g. reserve 50 + buffer 50): every step would then pause the maximum
  // for the whole window. Such a buffer falls back to its default (target >= 40 then).
  const tooLow = ['fiveHour', 'sevenDay'].some((w) => 100 - out.windows[w].reservePct - out.throttle.bufferPct < MIN_SCHEDULE_TARGET);
  fix(!tooLow, 'throttle.bufferPct', () => { out.throttle.bufferPct = d.throttle.bufferPct; });
  fix(num(out.hysteresisPct, 0, 50), 'hysteresisPct', () => { out.hysteresisPct = d.hysteresisPct; });
  fix(num(out.lookbackMinutes, 5, 300), 'lookbackMinutes', () => { out.lookbackMinutes = d.lookbackMinutes; });
  fix(num(out.minForecastMinutes, 0, 300), 'minForecastMinutes', () => { out.minForecastMinutes = d.minForecastMinutes; });
  fix(num(out.maxSampleAgeMinutes, 1, 1440), 'maxSampleAgeMinutes', () => { out.maxSampleAgeMinutes = d.maxSampleAgeMinutes; });
  const ah = out.activeHours;
  fix(isPlainObject(ah) && Array.isArray(ah.days) && ah.days.every((x) => Number.isInteger(x) && x >= 0 && x <= 6)
    && num(ah.start, 0, 24) && num(ah.end, 0, 24) && ah.end > ah.start,
  'activeHours', () => { out.activeHours = clone(d.activeHours); });
  const c = out.concurrency;
  const capOk = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 100);
  fix(isPlainObject(c) && ['green', 'amber', 'red', 'stop'].every((k) => capOk(c[k])),
    'concurrency', () => { out.concurrency = clone(d.concurrency); });
  const modelOk = (v) => v === null || MODEL_ALIASES.has(v);
  fix(isPlainObject(out.models) && ['amber', 'red'].every((l) => isPlainObject(out.models[l])
    && ['routine', 'default', 'protected'].every((k) => modelOk(out.models[l][k]))),
  'models', () => { out.models = clone(d.models); });
  const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  fix(strList(out.routineAgents), 'routineAgents', () => { out.routineAgents = clone(d.routineAgents); });
  fix(strList(out.protectedAgents), 'protectedAgents', () => { out.protectedAgents = clone(d.protectedAgents); });
  fix(typeof out.notify === 'boolean', 'notify', () => { out.notify = d.notify; });
  fix(typeof out.statusSegment === 'boolean', 'statusSegment', () => { out.statusSegment = d.statusSegment; });
  fix(out.chain === null || (isPlainObject(out.chain) && typeof out.chain.command === 'string'),
    'chain', () => { out.chain = null; });
  return { config: out, errors };
}

function configFile() {
  return path.join(pacerHome(), 'config.json');
}

// { ok, config, exists, error }. A missing or empty file is fine (defaults); a file that is
// not a JSON object is an error the caller must surface, never a silent {}.
function readUserConfigStrict() {
  let text;
  try {
    text = fs.readFileSync(configFile(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, config: {}, exists: false };
    return { ok: false, config: {}, exists: true, error: `nicht lesbar (${e.code || e.message})` };
  }
  if (!text.trim()) return { ok: true, config: {}, exists: true };
  try {
    const raw = JSON.parse(stripBom(text));
    if (!isPlainObject(raw)) return { ok: false, config: {}, exists: true, error: 'kein JSON-Objekt' };
    return { ok: true, config: raw, exists: true };
  } catch (e) {
    return { ok: false, config: {}, exists: true, error: `kein gültiges JSON (${e.message})` };
  }
}

function readUserConfig() {
  return readUserConfigStrict().config;
}

// A config.json that does not parse switches all interventions off (fail-open): what the
// user meant is unknown, and the most likely hand edit is "enabled": false. _fileError
// makes SessionStart, `status`, `doctor` and the status line report it.
function loadConfig() {
  const r = readUserConfigStrict();
  const merged = deepMerge(clone(DEFAULTS), r.config);
  const { config, errors } = validate(merged);
  config._errors = errors;
  config._fileError = r.ok ? null : `config.json ${r.error}`;
  if (!r.ok) config.enabled = false;
  // A temporary pause (pause.js) switches all interventions off until it runs out.
  config._pausedUntil = activePause(nowMs());
  if (config._pausedUntil) config.enabled = false;
  return config;
}

// Only persists keys the user (or the installer) set explicitly. Refuses to rewrite a
// file that does not parse: that would replace the user's settings with the patch alone.
function updateUserConfig(patch) {
  const r = readUserConfigStrict();
  if (!r.ok) throw new Error(`${configFile()}: ${r.error} – nicht geändert`);
  const next = { ...r.config, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
  writeJsonAtomic(configFile(), next);
  return next;
}

module.exports = {
  DEFAULTS, STRATEGIES, MIN_SCHEDULE_TARGET, loadConfig, validate, deepMerge, configFile, readUserConfig, readUserConfigStrict, updateUserConfig,
};
