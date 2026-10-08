'use strict';
// Throttle controller (strategy "throttle" / "both").
//
// Instead of reacting to the measured burn rate (which lags behind any pause by the
// look-back period and would oscillate), the controller follows a usage schedule:
//
//   allowed(f) = T * f + slack * (1 - f) + buffer * release(f)
//
//   f        share of the window that has passed (5 h: wall clock, 7 d: see below)
//   T        100 - reserve - buffer          the level the schedule steers to
//   slack    early allowance, so a normal start of a window is not throttled
//   release  0 -> 1 over the last `releaseFraction` of the window, so the buffer is
//            handed back at the end instead of being wasted
//
// Weekly window: f = max(wall-clock share, working-time share). Working time alone
// pauses anyone who also works evenings or weekends (e.g. Tuesday morning with a third
// of the week already used: far ahead of the working-time schedule, yet the wall-clock
// share says the week will last). Wall clock alone lets a weekday-only worker run ahead
// mid-week. With the max, a pause only happens when usage is ahead of BOTH schedules.
// The weekly level forecast (forecast.js) uses the same max.
//
// Weekly window only: a lead below weeklyDeadbandPct counts as on schedule, and above it
// the pause grows with the lead over weeklyRampPct points. The weekly schedule rises only
// ~0.007 points per minute, so the catch-up time alone is hours for any lead: a 0.1-point
// lead from a whole-percent reading meant the full pause on every step (real data).
//
// If usage is ahead of the schedule, the next step pauses until the schedule has caught
// up, capped at maxWaitSec so the prompt cache (5 min) stays warm; hook.js shares that
// cap between all tool calls of one API response. Pausing
// never changes the model, so quality stays the same; the work only slows down.
const { analyzeWindow, activeMinutesBetween, WINDOWS } = require('./forecast');

function release(f, releaseFraction) {
  if (releaseFraction <= 0) return f >= 1 ? 1 : 0;
  return Math.max(0, Math.min(1, (f - (1 - releaseFraction)) / releaseFraction));
}

function allowedAt(f, tcfg, reservePct) {
  const target = 100 - reservePct - tcfg.bufferPct;
  const slack = Math.min(tcfg.earlySlackPct, target);
  return target * f + slack * (1 - f) + tcfg.bufferPct * release(f, tcfg.releaseFraction);
}

// Share of the window that has passed now (f) and one wall minute later (fNext); the
// difference is how fast the schedule moves, so it follows the progress measure in use.
function windowProgress(name, st, now, cfg) {
  const lengthMs = WINDOWS[name].lengthMin * 60000;
  const resetMs = st.resetsAt;
  const startMs = resetMs - lengthMs;
  const wallAt = (t) => Math.max(0, Math.min(1, (t - startMs) / lengthMs));
  const wall = { f: wallAt(now), fNext: wallAt(now + 60000) };
  if (name === 'fiveHour') return wall;
  const done = activeMinutesBetween(startMs, now, cfg.activeHours);
  const left = activeMinutesBetween(now, resetMs, cfg.activeHours);
  const total = done + left;
  // Outside working hours the working-time share does not advance, the wall clock does.
  const active = total > 0
    ? { f: done / total, fNext: Math.min(1, (done + activeMinutesBetween(now, now + 60000, cfg.activeHours)) / total) }
    : { f: 1, fNext: 1 };
  return { f: Math.max(wall.f, active.f), fNext: Math.max(wall.fNext, active.fNext) };
}

function windowWait(name, samples, now, cfg) {
  const st = analyzeWindow(samples, name, now, cfg);
  if (!st || st.status !== 'ok' || !st.resetsAt) return { name, waitSec: 0, status: st ? st.status : 'nodata' };
  const t = cfg.throttle;
  const reservePct = cfg.windows[name].reservePct;
  const { f, fNext } = windowProgress(name, st, now, cfg);
  const allowed = allowedAt(f, t, reservePct);
  const ahead = st.used - allowed;
  const weekly = name === 'sevenDay';
  const deadband = weekly && Number.isFinite(t.weeklyDeadbandPct) ? t.weeklyDeadbandPct : 0;
  const ramp = weekly && Number.isFinite(t.weeklyRampPct) ? t.weeklyRampPct : 0;
  if (ahead <= deadband) return { name, waitSec: 0, status: 'on-schedule', used: st.used, allowed, ahead };
  const excess = ahead - deadband;
  // Schedule growth per wall minute at this point (finite difference).
  const slope = allowedAt(fNext, t, reservePct) - allowed;
  const catchUpSec = slope > 0 ? (excess / slope) * 60 : Infinity;
  // minWaitSec filters overruns too small to be worth a pause; it applies to the time the
  // schedule needs to catch up, not to the capped pause (maxWaitSec may be below it).
  // Rounded before the cap, so the pause never exceeds maxWaitSec (e.g. 1.55 -> 1.6).
  const share = ramp > 0 ? Math.min(1, excess / ramp) : 1;
  const waitSec = catchUpSec < t.minWaitSec ? 0
    : Math.min(t.maxWaitSec, Math.round(Math.min(t.maxWaitSec, catchUpSec) * share * 10) / 10);
  return { name, waitSec, status: 'ahead', used: st.used, allowed, ahead, resetsAt: st.resetsAt };
}

// Wait for the next step: the stricter of both windows.
function computeWait(samples, now, cfg) {
  const five = windowWait('fiveHour', samples, now, cfg);
  const week = windowWait('sevenDay', samples, now, cfg);
  const lead = week.waitSec > five.waitSec ? week : five;
  return { waitSec: lead.waitSec, lead, windows: { fiveHour: five, sevenDay: week } };
}

module.exports = { computeWait, windowWait, allowedAt, release };
