#!/usr/bin/env node
'use strict';
// Level simulation with the real sensor, forecast and policy code.
// Model of one 5-hour window, 1-minute resolution, NO intervention:
//   - usage grows at the profile's burn rate (%-points per minute);
//   - after every minute the status line sensor records the reading (addSample);
//   - evaluate() derives the level exactly as the hooks do (incl. hysteresis state
//     in level.json and the minForecastMinutes start-up rule).
// Reported per profile: first minute of GELB/ROT/STOPP, lead time before the reserve
// would be reached, how long a load change takes to show, and the level timeline.
// Usage: node test/sim/simulate.js [--integer]   (--integer: whole-percent readings only)
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate every file the code under test touches in a temp dir (never the real ~/.claude).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-sim-'));
process.env.QUOTA_PACER_HOME = home;
process.env.CLAUDE_CONFIG_DIR = home;
delete process.env.QUOTA_PACER_NOW;
const { addSample } = require('../../scripts/lib/samples');
const { evaluate, lvlRank } = require('../../scripts/lib/policy');
const { loadConfig } = require('../../scripts/lib/config');

const WINDOW_MIN = 300;
const START = Date.UTC(2026, 9, 5, 7, 0, 0);
const RESET = START + WINDOW_MIN * 60000;
const LABEL = { unknown: 'unbekannt', green: 'GRÜN', amber: 'GELB', red: 'ROT', stop: 'STOPP' };

// change: minute at which the load changes (for the detection delay).
const PROFILES = [
  { key: 'sustained-high', name: 'dauerhaft hoch, 0,40 %/min', rateAt: () => 0.4 },
  { key: 'steady-medium', name: 'gleichmäßig mittel, 0,25 %/min', rateAt: () => 0.25 },
  { key: 'start-burst', name: 'kurzer Start-Burst (1,0 %/min für 10 min), dann ruhig 0,10', rateAt: (m) => (m < 10 ? 1.0 : 0.1), change: 10, burst: true },
  { key: 'load-change', name: 'ruhig 0,10, ab Minute 120 Lastwechsel auf 0,60', rateAt: (m) => (m < 120 ? 0.1 : 0.6), change: 120 },
  { key: 'very-high', name: 'sehr hoch, 0,70 %/min', rateAt: () => 0.7 },
];

function resetState() {
  for (const f of fs.readdirSync(home)) fs.rmSync(path.join(home, f), { recursive: true, force: true });
}

function run(profile, cfg, integer) {
  resetState();
  const H = 100 - cfg.windows.fiveHour.reservePct;
  let used = 0;
  let reserveMinute = null;
  const timeline = [];
  const first = { amber: null, red: null, stop: null };
  const cause = { amber: null, red: null };
  let firstProjectionMinute = null;
  // Minute 300 is the reset itself (new window), so the last evaluated minute is 299.
  for (let m = 1; m < WINDOW_MIN; m++) {
    used = Math.min(100, used + profile.rateAt(m - 1));
    if (reserveMinute === null && used >= H) reserveMinute = m;
    const reading = integer ? Math.round(used) : +used.toFixed(3);
    const now = START + m * 60000;
    addSample({ five_hour: { used_percentage: reading, resets_at: RESET / 1000 } }, now);
    const ev = evaluate(now, cfg);
    const w = ev.windows.fiveHour || {};
    const level = w.level || ev.level;
    if (firstProjectionMinute === null && w.projected !== null && w.projected !== undefined) firstProjectionMinute = m;
    for (const l of ['amber', 'red', 'stop']) {
      if (first[l] === null && lvlRank(level) >= lvlRank(l)) {
        first[l] = m;
        if (l === 'amber') cause.amber = w.used >= cfg.windows.fiveHour.amber.usedPct ? 'Nutzung' : 'Prognose';
        if (l === 'red') cause.red = w.used >= cfg.windows.fiveHour.red.usedPct ? 'Nutzung' : 'Prognose';
      }
    }
    timeline.push({ m, used: +used.toFixed(2), projected: w.projected === null || w.projected === undefined ? null : +w.projected.toFixed(1), level });
  }
  // Level segments: [from, to, level]
  const segments = [];
  for (const p of timeline) {
    const last = segments[segments.length - 1];
    if (last && last.level === p.level) last.to = p.m;
    else segments.push({ from: p.m, to: p.m, level: p.level });
  }
  const res = {
    name: profile.name,
    finalUsed: +used.toFixed(1),
    reserveMinute,
    firstAmber: first.amber,
    firstRed: first.red,
    firstStop: first.stop,
    amberCause: cause.amber,
    redCause: cause.red,
    firstProjectionMinute,
    leadMinutes: reserveMinute !== null && first.amber !== null ? reserveMinute - first.amber : null,
    amberMinutes: timeline.filter((p) => p.level === 'amber').length,
    segments,
  };
  if (profile.change !== undefined) {
    const before = timeline.find((p) => p.m === profile.change) || { level: 'green' };
    const after = timeline.find((p) => p.m > profile.change && lvlRank(p.level) !== lvlRank(before.level));
    res.changeAt = profile.change;
    res.detectedAfter = after ? after.m - profile.change : null;
    res.detectedLevel = after ? after.level : null;
    if (profile.burst) {
      // After a burst the level must fall back on its own once the burst leaves the lookback.
      const back = timeline.find((p) => p.m > profile.change && p.level === 'green' && timeline.some((q) => q.m < p.m && lvlRank(q.level) > lvlRank('green')));
      res.greenAgainAt = back ? back.m : null;
    }
  }
  return res;
}

function fmtSegments(segs) {
  return segs.map((s) => `${LABEL[s.level]} ${s.from}–${s.to}`).join(', ');
}

function main() {
  const cfg = loadConfig();
  const integerOnly = process.argv.includes('--integer');
  const out = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    config: {
      minForecastMinutes: cfg.minForecastMinutes === undefined ? null : cfg.minForecastMinutes,
      lookbackMinutes: cfg.lookbackMinutes,
      hysteresisPct: cfg.hysteresisPct,
      fiveHour: cfg.windows.fiveHour,
    },
    note: 'Messpunkt nach jeder Minute; ohne Eingriff (Verbrauch läuft unverändert weiter).',
    profiles: {},
  };
  console.log('Stufen-Simulation (5-h-Fenster, echter Prognose- und Policy-Code, ohne Eingriff)');
  console.log(`minForecastMinutes=${out.config.minForecastMinutes ?? '–'}, lookback=${cfg.lookbackMinutes} min, Hysterese=${cfg.hysteresisPct} Pkt, Reserve=${cfg.windows.fiveHour.reservePct} %\n`);
  for (const p of PROFILES) {
    const r = run(p, cfg, integerOnly);
    const ri = integerOnly ? null : run(p, cfg, true);
    out.profiles[p.key] = { ...r, integerReadings: ri ? { firstAmber: ri.firstAmber, firstRed: ri.firstRed, firstStop: ri.firstStop, detectedAfter: ri.detectedAfter, greenAgainAt: ri.greenAgainAt, segments: ri.segments } : undefined };
    const lines = [];
    lines.push(`${p.name}`);
    lines.push(`  GELB ab Minute ${r.firstAmber ?? '–'}${r.amberCause ? ` (${r.amberCause})` : ''}, ROT ab ${r.firstRed ?? '–'}${r.redCause ? ` (${r.redCause})` : ''}, STOPP ab ${r.firstStop ?? '–'}; erste Prognose ab Minute ${r.firstProjectionMinute ?? '–'}`);
    if (r.reserveMinute !== null) lines.push(`  Reserve ohne Gegensteuern bei Minute ${r.reserveMinute} – GELB ${r.leadMinutes} min vorher`);
    else lines.push(`  Reserve wird nicht erreicht (Ende ${r.finalUsed} %); ${r.amberMinutes} min GELB`);
    if (p.burst) lines.push(`  Burst-Ende bei Minute ${r.changeAt}: wieder GRÜN ab Minute ${r.greenAgainAt ?? '–'}`);
    else if (r.changeAt !== undefined) lines.push(`  Lastwechsel bei Minute ${r.changeAt}: Stufe ändert sich nach ${r.detectedAfter ?? '–'} min (auf ${r.detectedLevel ? LABEL[r.detectedLevel] : '–'})`);
    lines.push(`  Verlauf: ${fmtSegments(r.segments)}`);
    if (ri) lines.push(`  ganzzahlige Messwerte: GELB ${ri.firstAmber ?? '–'}, ROT ${ri.firstRed ?? '–'}, STOPP ${ri.firstStop ?? '–'}${ri.detectedAfter !== undefined && !p.burst ? `, Wechsel erkannt nach ${ri.detectedAfter ?? '–'} min` : ''}`);
    console.log(lines.join('\n') + '\n');
  }
  const outDir = path.join(__dirname, '..', 'e2e', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, integerOnly ? 'simulation-integer.json' : 'simulation.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Ergebnis: ${path.relative(process.cwd(), file)}`);
}

try {
  main();
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
