'use strict';
// Quota sample presets for the E2E scenarios (what the status line sensor would have
// written). Only the 5-hour window is seeded; the weekly window has no data, so it never
// decides. `precheck` evaluates a preset with the plugin's own forecast, policy and
// throttle code (read-only: nothing is persisted), so a scenario fails loudly if its
// seeded data no longer represent the intended level or schedule state.
const path = require('path');

const LIB = path.resolve(__dirname, '..', '..', '..', 'scripts', 'lib');

function series({ now, resetInMin, startUsed, rate, minutes, endAgoMin = 0 }) {
  const r = Math.round((now + resetInMin * 60000) / 1000);
  const out = [];
  for (let m = minutes; m >= 0; m -= 1) {
    out.push({ t: now - (m + endAgoMin) * 60000, f: { u: Math.min(100, startUsed + rate * (minutes - m)), r }, s: null });
  }
  return out;
}

// Comments: 5-hour usage now, projection at reset, schedule allowance (defaults:
// reserve 5, buffer 10, early slack 15).
const PRESETS = {
  // 3.5 %, projection ~16 %, schedule 29 %: GREEN, on schedule
  green: (now) => series({ now, resetInMin: 240, startUsed: 2, rate: 0.05, minutes: 30 }),
  // 29 %, projection ~101 %: AMBER (the v1.0.0 preset), about on schedule
  amber: (now) => series({ now, resetInMin: 240, startUsed: 20, rate: 0.3, minutes: 30 }),
  // 45 %, projection ~117 %, 167 min to reserve: AMBER and well ahead of the schedule (29 %)
  amberAhead: (now) => series({ now, resetInMin: 240, startUsed: 36, rate: 0.3, minutes: 30 }),
  // 58 %, projection ~148 %, 62 min to reserve: RED, ahead of the schedule (50 %)
  red: (now) => series({ now, resetInMin: 150, startUsed: 40, rate: 0.6, minutes: 30 }),
  // 98 %: STOP (reserve reached)
  stop: (now) => series({ now, resetInMin: 60, startUsed: 80, rate: 0.6, minutes: 30 }),
  // 30 %, projection ~57 %: GREEN, but ahead of the schedule (22 % at 10 % of the window)
  aheadGreen: (now) => series({ now, resetInMin: 270, startUsed: 27, rate: 0.1, minutes: 30 }),
  // 16 %, projection ~64 %: GREEN, below the schedule (29 %)
  onSchedule: (now) => series({ now, resetInMin: 240, startUsed: 10, rate: 0.2, minutes: 30 }),
  // RED-like data whose newest reading is 25 min old (> maxSampleAgeMinutes 20)
  staleRed: (now) => series({ now, resetInMin: 150, startUsed: 40, rate: 0.6, minutes: 30, endAgoMin: 25 }),
};

function precheck(samples, userConfig, now) {
  const { DEFAULTS, deepMerge, validate } = require(path.join(LIB, 'config'));
  const { evaluate } = require(path.join(LIB, 'policy'));
  const { computeWait } = require(path.join(LIB, 'throttle'));
  const { config } = validate(deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), userConfig || {}));
  // evaluate() reads a previous level.json for hysteresis; point it at a path that does
  // not exist so nothing real is read and (persist: false) nothing is written.
  const saved = process.env.QUOTA_PACER_HOME;
  process.env.QUOTA_PACER_HOME = path.join(require('os').tmpdir(), `qp-e2e-precheck-none-${process.pid}`);
  try {
    const ev = evaluate(now, config, { persist: false, samples });
    const w = computeWait(samples, now, config);
    return { level: ev.level, waitSec: w.waitSec, strategy: config.strategy, maxWaitSec: config.throttle.maxWaitSec };
  } finally {
    if (saved === undefined) delete process.env.QUOTA_PACER_HOME; else process.env.QUOTA_PACER_HOME = saved;
  }
}

module.exports = { PRESETS, series, precheck };
