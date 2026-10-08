'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeWindow, activeMinutesBetween, slopePerMinute } = require('../scripts/lib/forecast');
const { DEFAULTS } = require('../scripts/lib/config');
const { toEpochSec, extract } = require('../scripts/lib/samples');
const { linearSeries } = require('./helpers');

const cfg = JSON.parse(JSON.stringify(DEFAULTS));
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0); // Monday

test('slope of a perfect line is exact', () => {
  const pts = [0, 10, 20, 30].map((m) => ({ t: m * 60000, u: 10 + 0.5 * m }));
  assert.equal(slopePerMinute(pts), 0.5);
  assert.equal(slopePerMinute([{ t: 0, u: 1 }]), null);
});

test('5h window: linear burn projects to reset', () => {
  // 120 min into the window, 0.3 %-pts/min for the last 60 minutes, 180 min left.
  const s = linearSeries({ now: NOW, resetInMin: 180, startUsed: 18, rate: 0.3, minutes: 60 });
  const w = analyzeWindow(s, 'fiveHour', NOW, cfg);
  assert.equal(w.status, 'ok');
  assert.equal(Math.round(w.used), 36);
  assert.ok(Math.abs(w.rate - 0.3) < 0.01, `rate ${w.rate}`);
  assert.ok(Math.abs(w.projected - (36 + 0.3 * 180)) < 1.5, `projected ${w.projected}`);
  assert.ok(Math.abs(w.minutesToReserve - (95 - 36) / 0.3) < 5);
});

test('5h window: stale lower readings from an idle session are ignored', () => {
  const s = linearSeries({ now: NOW, resetInMin: 180, startUsed: 20, rate: 0.5, minutes: 30 });
  // Interleave an idle session that keeps reporting 12 %.
  const noisy = [];
  for (const p of s) { noisy.push(p); noisy.push({ t: p.t + 1000, f: { u: 12, r: p.f.r } }); }
  const w = analyzeWindow(noisy, 'fiveHour', NOW + 2000, cfg);
  assert.equal(Math.round(w.used), 35);
  assert.ok(Math.abs(w.rate - 0.5) < 0.05, `rate ${w.rate}`);
});

test('5h window: plateau after a burst lowers the forecast', () => {
  const burst = linearSeries({ now: NOW - 20 * 60000, resetInMin: 200, startUsed: 10, rate: 1.0, minutes: 20 });
  const r = burst[0].f.r;
  const idle = [];
  for (let m = 19; m >= 0; m--) idle.push({ t: NOW - m * 60000, f: { u: 30, r } });
  const w = analyzeWindow([...burst, ...idle], 'fiveHour', NOW, cfg);
  assert.equal(w.used, 30);
  assert.ok(w.rate < 0.6, `rate should drop below the burst rate, got ${w.rate}`);
});

test('window reset, stale data and no data', () => {
  const past = [{ t: NOW - 60000, f: { u: 80, r: Math.round((NOW - 1000) / 1000) } }];
  assert.equal(analyzeWindow(past, 'fiveHour', NOW, cfg).status, 'reset');
  const old = [{ t: NOW - 60 * 60000, f: { u: 50, r: Math.round((NOW + 3600000) / 1000) } }];
  assert.equal(analyzeWindow(old, 'fiveHour', NOW, cfg).status, 'stale');
  assert.equal(analyzeWindow([], 'fiveHour', NOW, cfg).status, 'nodata');
  assert.equal(analyzeWindow([{ t: NOW, s: { u: 1, r: null } }], 'fiveHour', NOW, cfg).status, 'nodata');
});

test('missing resets_at: usage known, no projection', () => {
  const w = analyzeWindow([{ t: NOW, f: { u: 40, r: null } }], 'fiveHour', NOW, cfg);
  assert.equal(w.status, 'ok');
  assert.equal(w.used, 40);
  assert.equal(w.projected, null);
});

test('resets_at formats: seconds, milliseconds, ISO, numeric string', () => {
  assert.equal(toEpochSec(1784203100), 1784203100);
  assert.equal(toEpochSec(1784203100000), 1784203100);
  assert.equal(toEpochSec('2026-03-28T15:00:00Z'), Date.UTC(2026, 2, 28, 15) / 1000);
  assert.equal(toEpochSec('1784203100'), 1784203100);
  assert.equal(toEpochSec('garbage'), null);
  assert.equal(toEpochSec(null), null);
  assert.deepEqual(extract({ five_hour: { used_percentage: 23.5, resets_at: 1738425600 } }), { f: { u: 23.5, r: 1738425600 }, s: null });
  assert.equal(extract({}), null);
  assert.equal(extract({ five_hour: { used_percentage: null } }), null);
});

test('active minutes skip weekends and nights', () => {
  const ah = { days: [1, 2, 3, 4, 5], start: 8, end: 18 };
  const mon0 = new Date(2026, 9, 5, 0, 0, 0).getTime(); // local Monday 00:00
  assert.equal(activeMinutesBetween(mon0, mon0 + 24 * 3600000, ah), 600);
  assert.equal(activeMinutesBetween(mon0, mon0 + 7 * 24 * 3600000, ah), 3000);
  const sat = new Date(2026, 9, 10, 0, 0, 0).getTime();
  assert.equal(activeMinutesBetween(sat, sat + 48 * 3600000, ah), 0);
  assert.equal(activeMinutesBetween(mon0 + 9 * 3600000, mon0 + 10 * 3600000, ah), 60);
});

test('weekly window projects over remaining working time only', () => {
  const now = new Date(2026, 9, 7, 12, 0, 0).getTime(); // Wednesday noon, local
  const resetsAt = new Date(2026, 9, 12, 12, 0, 0).getTime(); // next Monday noon
  const c = { ...cfg, activeHours: { days: [1, 2, 3, 4, 5], start: 8, end: 18 } };
  // Two readings 20 min apart: a projection needs samples spanning minForecastMinutes.
  const s = [{ t: now - 20 * 60000, s: { u: 39.5, r: resetsAt / 1000 } }, { t: now, s: { u: 40, r: resetsAt / 1000 } }];
  const w = analyzeWindow(s, 'sevenDay', now, c);
  // Window start = previous Monday noon: active elapsed Mon 12-18, Tue 8-18, Wed 8-12 = 6+10+4 = 20 h.
  // Remaining: Wed 12-18, Thu, Fri, Mon 8-12 = 6+10+10+4 = 30 h.
  assert.ok(Math.abs(w.rate - 40 / 1200) < 1e-9);
  assert.ok(Math.abs(w.projected - (40 + (40 / 1200) * 1800)) < 1e-6, `projected ${w.projected}`);
});
