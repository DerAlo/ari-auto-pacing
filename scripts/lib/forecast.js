'use strict';
// Turns raw samples into per-window statistics:
//   used            highest reading in the current window (usage never drops inside a window)
//   rate            burn rate in percentage points per minute (5h), per wall or per active
//                   minute (7d, whichever progress share is larger)
//   projected       expected usage at reset if the current rate continues
//   minutesToReserve minutes until usage reaches 100 - reserve (5h only)
//   spanMin         minutes covered by the samples of the current window
// A projection is only made once spanMin >= minForecastMinutes ("warmup" before that).
const { DEFAULTS } = require('./config');

const WINDOWS = {
  fiveHour: { key: 'f', lengthMin: 300, mode: 'linear' },
  sevenDay: { key: 's', lengthMin: 7 * 24 * 60, mode: 'active' },
};

const RESET_TOLERANCE_SEC = 180;

// Minutes inside the configured working hours between two timestamps (local time).
function activeMinutesBetween(startMs, endMs, activeHours) {
  if (!(endMs > startMs)) return 0;
  const { days, start, end } = activeHours;
  let total = 0;
  const cursor = new Date(startMs);
  cursor.setHours(0, 0, 0, 0);
  for (let guard = 0; guard < 40 && cursor.getTime() < endMs; guard++) {
    if (days.includes(cursor.getDay())) {
      const a = new Date(cursor); a.setHours(Math.floor(start), Math.round((start % 1) * 60), 0, 0);
      const b = new Date(cursor); b.setHours(Math.floor(end), Math.round((end % 1) * 60), 0, 0);
      const lo = Math.max(a.getTime(), startMs);
      const hi = Math.min(b.getTime(), endMs);
      if (hi > lo) total += (hi - lo) / 60000;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
}

// Least-squares slope (y per minute). Returns null when undefined.
function slopePerMinute(points) {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.t / 60000);
  const ys = points.map((p) => p.u);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return Math.max(0, num / den);
}

function analyzeWindow(samples, name, now, cfg) {
  const spec = WINDOWS[name];
  const reservePct = cfg.windows[name].reservePct;
  const H = 100 - reservePct;
  const nowSec = now / 1000;
  // A reset further ahead than one window length (plus tolerance) cannot be real; such a
  // reading would put the window start in the future and the throttle at its maximum.
  const maxAheadSec = spec.lengthMin * 60 + RESET_TOLERANCE_SEC;
  const pts = samples
    .filter((s) => s && s[spec.key] && Number.isFinite(s[spec.key].u))
    .map((s) => ({ t: s.t, u: s[spec.key].u, r: s[spec.key].r }))
    .filter((p) => !Number.isFinite(p.r) || p.r - p.t / 1000 <= maxAheadSec);
  if (!pts.length) return { status: 'nodata' };

  const withReset = pts.filter((p) => Number.isFinite(p.r));
  let inWin;
  let resetsAtSec = null;
  if (withReset.length) {
    const future = withReset.filter((p) => p.r > nowSec);
    if (!future.length) {
      // Every known window has ended: a fresh window starts with the next request.
      return { status: 'reset', used: 0, projected: 0, rate: 0, resetsAt: null, H };
    }
    resetsAtSec = Math.max(...future.map((p) => p.r));
    inWin = future.filter((p) => Math.abs(p.r - resetsAtSec) <= RESET_TOLERANCE_SEC);
  } else {
    // Payload without resets_at: window boundaries are unknown, so older readings may
    // belong to an earlier window. Only the latest reading counts; no projection.
    inWin = [pts.reduce((a, b) => (b.t >= a.t ? b : a))];
  }

  inWin.sort((a, b) => a.t - b.t);
  const lastT = inWin[inWin.length - 1].t;
  const ageMin = (now - lastT) / 60000;
  if (ageMin > cfg.maxSampleAgeMinutes) return { status: 'stale', ageMin };
  const spanMin = (lastT - inWin[0].t) / 60000;

  // Monotone envelope: drop readings lower than an earlier one in the same window
  // (an idle session re-reporting an older value).
  let max = -Infinity;
  const env = [];
  for (const p of inWin) {
    if (p.u >= max) { env.push(p); max = p.u; }
  }
  const used = max;
  const base = { status: 'ok', used, H, ageMin, spanMin, resetsAt: resetsAtSec ? resetsAtSec * 1000 : null };
  if (!resetsAtSec) return { ...base, rate: null, projected: null, minutesToReserve: null };

  const minutesToReset = Math.max(0, (resetsAtSec * 1000 - now) / 60000);
  const windowStart = resetsAtSec * 1000 - spec.lengthMin * 60000;
  const minSpan = Number.isFinite(cfg.minForecastMinutes) ? cfg.minForecastMinutes : DEFAULTS.minForecastMinutes;
  if (spanMin < minSpan) {
    return { ...base, rate: null, rateSource: 'warmup', minutesToReset, projected: null, minutesToReserve: null };
  }

  if (spec.mode === 'linear') {
    const elapsedMin = Math.max(0, (now - windowStart) / 60000);
    const avgRate = elapsedMin >= 10 ? used / elapsedMin : null;
    const lookbackMs = cfg.lookbackMinutes * 60000;
    const recent = env.filter((p) => p.t >= now - lookbackMs);
    const recentSpanMin = recent.length ? (recent[recent.length - 1].t - recent[0].t) / 60000 : 0;
    let recentRate = null;
    if (recent.length >= 3 && recentSpanMin >= 5) recentRate = slopePerMinute(recent);
    let rate = null;
    let rateSource = 'none';
    if (recentRate !== null && avgRate !== null) {
      const w = Math.min(1, recentSpanMin / cfg.lookbackMinutes);
      rate = w * recentRate + (1 - w) * avgRate;
      rateSource = 'blend';
    } else if (recentRate !== null) {
      rate = recentRate; rateSource = 'recent';
    } else if (avgRate !== null) {
      rate = avgRate; rateSource = 'average';
    }
    const projected = rate === null ? null : used + rate * minutesToReset;
    const minutesToReserve = rate === null ? null : (rate > 0 ? Math.max(0, (H - used) / rate) : Infinity);
    return { ...base, rate, rateSource, minutesToReset, projected, minutesToReserve };
  }

  // Weekly window: projected by the larger of two progress shares, like the throttle.
  // Working time alone over-projects anyone who also works evenings or weekends (real data:
  // 44 % on Tuesday 10:48 gave 167 %); wall clock alone under-projects a weekday-only
  // worker mid-week. The larger share gives the smaller, more realistic projection.
  const activeElapsed = activeMinutesBetween(windowStart, now, cfg.activeHours);
  const activeRemaining = activeMinutesBetween(now, resetsAtSec * 1000, cfg.activeHours);
  if (activeElapsed < 120) {
    return { ...base, rate: null, rateSource: 'none', minutesToReset, activeRemaining, projected: null, minutesToReserve: null };
  }
  const wallElapsed = Math.max(0, (now - windowStart) / 60000);
  const wallShare = wallElapsed / spec.lengthMin;
  const activeShare = activeElapsed / (activeElapsed + activeRemaining);
  if (wallShare > activeShare) {
    const rate = used / wallElapsed;
    return { ...base, rate, rateSource: 'wall-average', minutesToReset, activeRemaining, projected: used + rate * minutesToReset, minutesToReserve: null };
  }
  const rate = used / activeElapsed;
  const projected = used + rate * activeRemaining;
  return { ...base, rate, rateSource: 'active-average', minutesToReset, activeRemaining, projected, minutesToReserve: null };
}

module.exports = { WINDOWS, analyzeWindow, activeMinutesBetween, slopePerMinute };
