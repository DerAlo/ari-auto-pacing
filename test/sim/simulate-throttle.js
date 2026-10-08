#!/usr/bin/env node
'use strict';
// Closed-loop simulation of the throttle with the real sensor + controller code.
// Model of one 5-hour window, 1-second resolution:
//   - Claude works in steps of 30 s; during a step usage grows at the profile's raw
//     burn rate (%-points per minute of work).
//   - Before each step the real computeWait() decides the pause (no usage while paused).
//   - After each step the status line sensor records the new usage (addSample).
//   - At 100 % the account is blocked until the reset (hard stop).
// Compared: no throttle vs. throttle with default settings.
// Usage: node test/sim/simulate-throttle.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-simt-'));
process.env.QUOTA_PACER_HOME = home;
process.env.CLAUDE_CONFIG_DIR = home;
const { addSample, loadSamples } = require('../../scripts/lib/samples');
const { computeWait } = require('../../scripts/lib/throttle');
const { loadConfig } = require('../../scripts/lib/config');

const WINDOW_S = 300 * 60;
const STEP_S = 30;
const START = Date.UTC(2026, 9, 5, 7, 0, 0);
const RESET = START + WINDOW_S * 1000;

const PROFILES = {
  'gleichmäßig sehr hoch, 0,60 %/min': () => 0.6,
  'gleichmäßig hoch, 0,40 %/min': () => 0.4,
  'gleichmäßig mittel, 0,25 %/min': () => 0.25,
  'Burst 40 min (1,0), dann 0,30': (m) => (m < 40 ? 1.0 : 0.3),
  'ruhig (0,10), ab Minute 180 Vollgas (0,80)': (m) => (m < 180 ? 0.1 : 0.8),
};

function run(rateAt, throttle) {
  fs.rmSync(path.join(home, 'samples.json'), { force: true });
  const cfg = loadConfig();
  let used = 0;
  let t = 0; // seconds since window start
  let workS = 0;
  let pauseS = 0;
  let maxWait = 0;
  let throttledSteps = 0;
  let steps = 0;
  let hardStopAt = null;
  while (t < WINDOW_S) {
    const now = START + t * 1000;
    if (throttle) {
      const w = computeWait(loadSamples(), now, cfg).waitSec;
      if (w > 0) {
        const p = Math.min(w, WINDOW_S - t);
        pauseS += p; t += p; maxWait = Math.max(maxWait, w); throttledSteps += 1;
        if (t >= WINDOW_S) break;
      }
    }
    const minute = t / 60;
    const step = Math.min(STEP_S, WINDOW_S - t);
    const add = rateAt(minute) * (step / 60);
    if (used + add >= 100) {
      // The step that crosses 100 % is cut short, then the account is blocked.
      const part = ((100 - used) / add) * step;
      workS += part; t += part; used = 100; hardStopAt = t / 60;
      break;
    }
    used += add; workS += step; t += step; steps += 1;
    addSample({ five_hour: { used_percentage: used, resets_at: RESET / 1000 } }, START + t * 1000);
  }
  return {
    finalUsed: +used.toFixed(1),
    workMin: +(workS / 60).toFixed(1),
    pauseMin: +(pauseS / 60).toFixed(1),
    blockedMin: hardStopAt === null ? 0 : +(300 - hardStopAt).toFixed(1),
    hardStopAtMin: hardStopAt === null ? null : +hardStopAt.toFixed(1),
    maxWaitSec: maxWait,
    throttledShare: steps ? +(throttledSteps / (steps + (hardStopAt ? 1 : 0))).toFixed(2) : 0,
  };
}

const results = {};
for (const [name, rateAt] of Object.entries(PROFILES)) {
  const off = run(rateAt, false);
  const on = run(rateAt, true);
  results[name] = { withoutThrottle: off, withThrottle: on };
  console.log(name);
  console.log(`  ohne Drossel: ${off.hardStopAtMin ? `hartes Limit bei Minute ${off.hardStopAtMin}, danach ${off.blockedMin} min blockiert` : 'kein Limit erreicht'}; Arbeit ${off.workMin} min; Ende ${off.finalUsed} %`);
  console.log(`  mit Drossel:  ${on.hardStopAtMin ? `hartes Limit bei Minute ${on.hardStopAtMin}` : 'nie blockiert'}; Arbeit ${on.workMin} min, Pausen ${on.pauseMin} min (längste ${on.maxWaitSec} s, ${Math.round(on.throttledShare * 100)} % der Schritte); Ende ${on.finalUsed} %\n`);
}
const outDir = path.join(__dirname, '..', 'e2e', 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'simulation-throttle.json'), JSON.stringify(results, null, 2));
fs.rmSync(home, { recursive: true, force: true });
