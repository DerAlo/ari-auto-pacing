#!/usr/bin/env node
'use strict';
// Closed-loop simulation of the WEEKLY throttle with the real sensor + controller code,
// with whole-percent readings (as a real account delivered them).
// Model of one 7-day window (reset Saturday 15:00 local time, like the real data):
//   - Claude works in steps of 30 s during the profile's working hours; usage grows at
//     the profile's rate (points per hour of work).
//   - Before each step the real computeWait() decides the pause (no usage while paused).
//   - After each step the sensor records the usage rounded to whole percent (addSample).
//   - At 100 % the account is blocked until the reset (hard stop).
// Compared: no throttle, the throttle without dead band and ramp (state before the
// review), and the defaults (dead band 1 point, ramp 3 points).
// Usage: node test/sim/simulate-throttle-week.js   (takes a few minutes)
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-simw-'));
process.env.QUOTA_PACER_HOME = home;
process.env.CLAUDE_CONFIG_DIR = home;
const { addSample, loadSamples } = require('../../scripts/lib/samples');
const { computeWait } = require('../../scripts/lib/throttle');
const { loadConfig } = require('../../scripts/lib/config');

const START = new Date(2026, 9, 3, 15, 0, 0).getTime(); // Saturday 15:00 local
const RESET = START + 7 * 86400000;
const STEP_S = 30;

const weekday = (d, from, to) => d.getDay() >= from && d.getDay() <= to;
const between = (d, a, b) => d.getHours() >= a && d.getHours() < b;
const PROFILES = {
  'werktags 8–18 und Mo–Do 20–22 Uhr, 1,5 Pkt/h': (d) => ((weekday(d, 1, 5) && between(d, 8, 18)) || (weekday(d, 1, 4) && between(d, 20, 22)) ? 1.5 : 0),
  'werktags 8–18 und Mo–Do 20–22 Uhr, 2,0 Pkt/h': (d) => ((weekday(d, 1, 5) && between(d, 8, 18)) || (weekday(d, 1, 4) && between(d, 20, 22)) ? 2.0 : 0),
  'Wochenende, werktags und abends, 1,5 Pkt/h (wie die Echtdaten)': (d) => ((d.getDay() === 6 && between(d, 16, 21)) || (d.getDay() === 0 && between(d, 14, 20))
    || (weekday(d, 1, 5) && between(d, 8, 18)) || (weekday(d, 1, 4) && between(d, 20, 23)) ? 1.5 : 0),
};
const VARIANTS = {
  'ohne Drossel': null,
  'Drossel ohne Totband und Rampe (vor dem Review)': { weeklyDeadbandPct: 0, weeklyRampPct: 0 },
  'Drossel Standard (Totband 1, Rampe 3)': {},
};

function run(rateAt, throttle) {
  fs.rmSync(path.join(home, 'samples.json'), { force: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(throttle === null ? { strategy: 'downgrade' } : { throttle }));
  const cfg = loadConfig();
  let used = 0;
  let t = START;
  let workS = 0;
  let pauseS = 0;
  let maxWait = 0;
  let steps = 0;
  let pausedSteps = 0;
  let hardStop = null;
  let runStart = null;
  let longestMaxRun = 0;
  const pausePerDay = {};
  while (t < RESET) {
    const rate = rateAt(new Date(t));
    if (rate === 0) { t += 60000; continue; }
    if (throttle !== null) {
      const w = computeWait(loadSamples(), t, cfg).waitSec;
      if (w > 0) {
        const day = new Date(t).toLocaleDateString('de-DE', { weekday: 'short' });
        pausePerDay[day] = (pausePerDay[day] || 0) + w;
        pauseS += w; pausedSteps += 1; maxWait = Math.max(maxWait, w);
        // Longest stretch in which every step waited (almost) the maximum.
        if (w >= cfg.throttle.maxWaitSec * 0.9) {
          if (runStart === null) runStart = t;
          longestMaxRun = Math.max(longestMaxRun, (t - runStart) / 60000);
        } else runStart = null;
        t += w * 1000;
      } else runStart = null;
    }
    const add = rate * STEP_S / 3600;
    if (used + add >= 100) { used = 100; hardStop = new Date(t); break; }
    used += add; workS += STEP_S; t += STEP_S * 1000; steps += 1;
    addSample({ seven_day: { used_percentage: Math.round(used), resets_at: Math.round(RESET / 1000) } }, t);
  }
  return {
    finalUsed: +used.toFixed(1),
    workH: +(workS / 3600).toFixed(1),
    pauseH: +(pauseS / 3600).toFixed(1),
    maxWaitSec: maxWait,
    pausedShare: steps ? +(pausedSteps / steps).toFixed(2) : 0,
    longestMaxPauseRunMin: Math.round(longestMaxRun),
    hardStop: hardStop ? hardStop.toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null,
    pauseMinPerDay: Object.fromEntries(Object.entries(pausePerDay).map(([k, v]) => [k, Math.round(v / 60)])),
  };
}

const results = {};
for (const [name, rateAt] of Object.entries(PROFILES)) {
  results[name] = {};
  console.log(name);
  for (const [vname, v] of Object.entries(VARIANTS)) {
    const r = run(rateAt, v);
    results[name][vname] = r;
    const stop = r.hardStop ? `hartes Limit ${r.hardStop}` : 'nie blockiert';
    console.log(`  ${vname}: ${stop}; Arbeit ${r.workH} h, Pausen ${r.pauseH} h (längste ${r.maxWaitSec} s, ${Math.round(r.pausedShare * 100)} % der Schritte, längste Serie maximaler Pausen ${r.longestMaxPauseRunMin} min); Ende ${r.finalUsed} %`);
  }
  console.log('');
}
const outDir = path.join(__dirname, '..', 'e2e', 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'simulation-throttle-week.json'), JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, results }, null, 2));
fs.rmSync(home, { recursive: true, force: true });
