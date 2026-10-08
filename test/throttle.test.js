'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { allowedAt, release, windowWait, computeWait } = require('../scripts/lib/throttle');
const { DEFAULTS } = require('../scripts/lib/config');
const { makeEnv, writeJson, runHook, runScript, seedSamples, linearSeries, preAgentInput } = require('./helpers');

const cfg = JSON.parse(JSON.stringify(DEFAULTS));
const T = cfg.throttle;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// 5-h window that resets in `resetInMin`, usage `used` reached by a steady climb.
function fiveHourAt(used, resetInMin) {
  return linearSeries({ now: NOW, resetInMin, startUsed: Math.max(0, used - 3), rate: 0.1, minutes: 30 });
}

test('schedule: early slack, target, buffer released at the end', () => {
  near(allowedAt(0, T, 5), 15);
  near(allowedAt(0.5, T, 5), 50);
  near(allowedAt(0.9, T, 5), 78);
  near(allowedAt(0.95, T, 5), 86.5);
  near(allowedAt(1, T, 5), 95);
  near(release(0.85, 0.1), 0);
  near(release(0.95, 0.1), 0.5);
  near(release(1, 0), 1);
});

test('on or below schedule: no wait', () => {
  // reset in 150 min -> half the window has passed -> schedule 50 %
  const w = windowWait('fiveHour', fiveHourAt(49, 150), NOW, cfg);
  assert.equal(w.status, 'on-schedule');
  assert.equal(w.waitSec, 0);
});

test('ahead of schedule: wait until the schedule catches up, capped per step', () => {
  // schedule grows (85 - 15) / 300 = 0.2333 %-pts per minute in mid window
  const big = windowWait('fiveHour', fiveHourAt(55, 150), NOW, cfg);
  assert.equal(big.status, 'ahead');
  assert.equal(big.waitSec, T.maxWaitSec);
  const c = { ...cfg, throttle: { ...T, maxWaitSec: 240 } };
  const small = windowWait('fiveHour', fiveHourAt(50.2, 150), NOW, c);
  near(small.waitSec, Math.round(((50.2 - 50) / (70 / 300)) * 60 * 10) / 10, 0.2);
  // Below minWaitSec is not worth a pause.
  assert.equal(windowWait('fiveHour', fiveHourAt(50.005, 150), NOW, cfg).waitSec, 0);
});

test('no data, stale data or a finished window: never wait', () => {
  assert.equal(windowWait('fiveHour', [], NOW, cfg).waitSec, 0);
  assert.equal(windowWait('fiveHour', fiveHourAt(90, 150), NOW + 3 * 3600000, cfg).waitSec, 0);
  const ended = [{ t: NOW - 60000, f: { u: 99, r: Math.round((NOW - 1000) / 1000) } }];
  assert.equal(windowWait('fiveHour', ended, NOW, cfg).waitSec, 0);
});

test('weekly window: weekday-only worker mid-week is judged by working time', () => {
  const wed = new Date(2026, 9, 7, 12, 0, 0).getTime(); // Wednesday noon local
  const resetsAt = new Date(2026, 9, 12, 12, 0, 0).getTime();
  const c = { ...cfg, activeHours: { days: [1, 2, 3, 4, 5], start: 8, end: 18 } };
  // Done 20 h of 50 working hours -> f = 0.4 (wall clock only 2/7 = 0.29, so working
  // time is the stricter, larger share) -> schedule 87*0.4 + 15*0.6 = 43.8 %
  const on = windowWait('sevenDay', [{ t: wed, s: { u: 43, r: resetsAt / 1000 } }], wed, c);
  assert.equal(on.waitSec, 0);
  near(on.allowed, 43.8);
  const ahead = windowWait('sevenDay', [{ t: wed, s: { u: 60, r: resetsAt / 1000 } }], wed, c);
  assert.equal(ahead.waitSec, T.maxWaitSec);
});

test('weekly window: evening/weekend worker is judged by wall clock', () => {
  // Window from Friday 19:00 to the next Friday 19:00; Sunday 19:00 no working hour has
  // passed yet (working-time share 0 -> schedule 15 %), but 2 of 7 days have.
  const sun = new Date(2026, 9, 11, 19, 0, 0).getTime();
  const resetsAt = new Date(2026, 9, 16, 19, 0, 0).getTime();
  // Dead band and ramp off: this test is about the schedule and its slope on a weekend.
  const c = { ...cfg, activeHours: { days: [1, 2, 3, 4, 5], start: 8, end: 18 }, throttle: { ...T, weeklyDeadbandPct: 0, weeklyRampPct: 0 } };
  const fWall = 2 / 7;
  const on = windowWait('sevenDay', [{ t: sun, s: { u: 30, r: resetsAt / 1000 } }], sun, c);
  assert.equal(on.status, 'on-schedule');
  near(on.allowed, allowedAt(fWall, T, 3), 1e-3);
  // Ahead of both schedules: pauses; the catch-up follows the wall clock (the schedule
  // moves on the weekend), here far longer than the cap.
  const over = windowWait('sevenDay', [{ t: sun, s: { u: 50, r: resetsAt / 1000 } }], sun, c);
  assert.equal(over.status, 'ahead');
  assert.equal(over.waitSec, T.maxWaitSec);
  // A small overrun catches up within one capped pause, at the wall-clock pace
  // (72 %-pts per 7 days): proves the slope is not zero outside working hours.
  const c2 = { ...c, throttle: { ...c.throttle, maxWaitSec: 600 } };
  const small = windowWait('sevenDay', [{ t: sun, s: { u: on.allowed + 0.002, r: resetsAt / 1000 } }], sun, c2);
  assert.equal(small.status, 'ahead');
  near(small.waitSec, (0.002 / (72 / (7 * 24 * 60))) * 60, 0.2);
});

test('weekly window: weekend overrun ahead of both schedules still pauses the maximum', () => {
  const resetsAt = new Date(2026, 9, 12, 12, 0, 0).getTime();
  // Dead band and ramp off (tested separately): this is about the stalled schedule.
  const c = { ...cfg, activeHours: { days: [1, 2, 3, 4, 5], start: 8, end: 18 }, throttle: { ...T, weeklyDeadbandPct: 0, weeklyRampPct: 0 } };
  // Saturday noon: 46 of 50 working hours done -> f = 0.92 (wall clock 5/7 = 0.71) ->
  // schedule 87*0.92 + 15*0.08 + 10*release(0.92) = 83.24 %. 80 % is therefore on
  // schedule; 85 % is ahead of both. The working-time schedule does not advance on the
  // weekend and the wall clock stays below it, so the overrun can only wait the maximum.
  const sat = new Date(2026, 9, 10, 12, 0, 0).getTime();
  near(allowedAt(46 / 50, T, 3), 83.24);
  assert.equal(windowWait('sevenDay', [{ t: sat, s: { u: 80, r: resetsAt / 1000 } }], sat, c).waitSec, 0);
  const weekend = windowWait('sevenDay', [{ t: sat, s: { u: 85, r: resetsAt / 1000 } }], sat, c);
  assert.equal(weekend.status, 'ahead');
  near(weekend.allowed, 83.24);
  assert.equal(weekend.waitSec, T.maxWaitSec);
});

test('weekly window regression (real data): 39 % on Tuesday morning, reset in 4.3 days, no pause', () => {
  // Status line reading: seven_day used 39 %, resets_at 1791637200 (Sat 15:00 CEST),
  // now 1791267128 (Tue 08:12 CEST). Working time alone (Mon-Fri 7-19, ~22 % done) put
  // the schedule near 31 % and
  // paused the maximum on every step. Wall clock: 2.72 of 7 days -> f = 0.39 -> ~42.9 %.
  const now = 1791267128 * 1000;
  const samples = [{ t: now, s: { u: 39, r: 1791637200 } }];
  const w = windowWait('sevenDay', samples, now, cfg);
  const fWall = 1 - (1791637200 * 1000 - now) / (7 * 86400000);
  assert.ok(w.allowed >= allowedAt(fWall, T, cfg.windows.sevenDay.reservePct) - 1e-9);
  assert.equal(w.status, 'on-schedule');
  assert.equal(w.waitSec, 0);
  assert.equal(computeWait(samples, now, cfg).waitSec, 0);
  // Same moment with a clear overrun: ahead of both schedules -> pauses.
  const over = windowWait('sevenDay', [{ t: now, s: { u: 70, r: 1791637200 } }], now, cfg);
  assert.equal(over.status, 'ahead');
  assert.equal(over.waitSec, T.maxWaitSec);
});

test('weekly window: a lead below the dead band is on schedule (real data 10:26, 44 % vs plan 43.9 %)', () => {
  // Real readings: seven_day 44 % at 2026-10-06 08:26:48 UTC, resets_at 1791637200.
  // Before the dead band this was 90 s on every step for ~14 min (0.1 point lead).
  const now = Date.UTC(2026, 9, 6, 8, 26, 48);
  const samples = [{ t: now, s: { u: 44, r: 1791637200 } }];
  const w = windowWait('sevenDay', samples, now, cfg);
  assert.ok(w.ahead > 0 && w.ahead < 1, `ahead ${w.ahead}`);
  assert.equal(w.status, 'on-schedule');
  assert.equal(w.waitSec, 0);
  const off = { ...cfg, throttle: { ...T, weeklyDeadbandPct: 0, weeklyRampPct: 0 } };
  assert.equal(windowWait('sevenDay', samples, now, off).waitSec, T.maxWaitSec, 'without dead band: the old full pause');
});

test('weekly window: above the dead band the pause grows with the lead (ramp), capped at maxWaitSec', () => {
  const now = Date.UTC(2026, 9, 6, 8, 26, 48);
  const r = 1791637200;
  const plan = windowWait('sevenDay', [{ t: now, s: { u: 0, r } }], now, cfg).allowed;
  const at = (lead) => windowWait('sevenDay', [{ t: now, s: { u: plan + lead, r } }], now, cfg);
  // excess over the dead band 0.5 -> 90 s * 0.5 / 3 = 15 s; 1.5 -> 45 s; >= 3 -> 90 s
  near(at(1.5).waitSec, 15, 0.11);
  near(at(2.5).waitSec, 45, 0.11);
  assert.equal(at(4).waitSec, T.maxWaitSec);
  assert.equal(at(20).waitSec, T.maxWaitSec);
  assert.ok(at(1.5).waitSec < at(2).waitSec && at(2).waitSec < at(3).waitSec, 'monotone in the lead');
  // The 5-hour window has no dead band: a 0.2 point lead still pauses (see the 5-h test above).
  assert.equal(windowWait('fiveHour', fiveHourAt(50.5, 150), NOW, cfg).waitSec, T.maxWaitSec);
});

test('the stricter window decides', () => {
  const r = Math.round((NOW + 150 * 60000) / 1000);
  const samples = [{ t: NOW, f: { u: 40, r }, s: { u: 99, r: Math.round((NOW + 3 * 86400000) / 1000) } }];
  const w = computeWait(samples, NOW, cfg);
  assert.equal(w.lead.name, 'sevenDay');
  assert.ok(w.waitSec > 0);
});

// ---- hook processes ----

function env(used, resetInMin, config = {}) {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(e.home, fiveHourAt(used, resetInMin));
  writeJson(path.join(e.home, 'config.json'), { throttle: { ...T, maxWaitSec: 1.5 }, ...config });
  return e;
}
const toolInput = (over = {}) => ({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 't1', ...over });

test('hook: ahead of schedule pauses for the computed time and reports once', () => {
  const e = env(60, 150);
  const r1 = runHook('throttle', toolInput(), e.env);
  assert.equal(r1.code, 0);
  assert.ok(r1.ms >= 1500 && r1.ms < 4000, `took ${r1.ms} ms`);
  assert.match(r1.json.systemMessage, /Drossel aktiv – Pausen bis 1.5 s/);
  assert.match(r1.json.systemMessage, /Modelle bleiben unverändert/);
  const r2 = runHook('throttle', toolInput({ tool_use_id: 't2' }), e.env);
  assert.ok(r2.ms >= 1500, `took ${r2.ms} ms`);
  assert.equal(r2.stdout.trim(), '');
  const log = fs.readFileSync(path.join(e.home, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.kind === 'throttle');
  assert.equal(log.length, 2);
  assert.equal(log[0].waitSec, 1.5);
  assert.equal(log[0].window, 'fiveHour');
});

test('hook: on schedule returns immediately; back on schedule reports "off"', () => {
  const e = env(60, 150);
  runHook('throttle', toolInput(), e.env);
  seedSamples(e.home, fiveHourAt(40, 150));
  const r = runHook('throttle', toolInput({ tool_use_id: 't3' }), e.env);
  assert.ok(r.ms < 1000, `took ${r.ms} ms`);
  assert.match(r.json.systemMessage, /Drossel aus/);
  assert.equal(runHook('throttle', toolInput({ tool_use_id: 't4' }), e.env).stdout.trim(), '');
});

test('hook: strategy downgrade never pauses; fail-open on bad input', () => {
  const e = env(60, 150, { strategy: 'downgrade' });
  const r = runHook('throttle', toolInput(), e.env);
  assert.ok(r.ms < 1000, `took ${r.ms} ms`);
  assert.equal(r.stdout.trim(), '');
  for (const input of ['', 'nope', '{}', '[]']) {
    const g = runHook('throttle', input, env(60, 150).env);
    assert.equal(g.code, 0);
    assert.ok(g.ms < 1000, `${input}: ${g.ms} ms`);
  }
});

test('strategy throttle: models and spawns stay untouched even in RED and STOP', () => {
  for (const [used, reset] of [[88, 100], [96, 60]]) {
    const e = env(used, reset);
    assert.equal(runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env).stdout.trim(), '');
    assert.equal(runHook('prompt', { session_id: 's', prompt: 'x' }, e.env).stdout.trim(), '');
  }
});

test('strategy both: GELB only throttles, ROT also downgrades', () => {
  const amber = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(amber.home, linearSeries({ now: NOW, resetInMin: 240, startUsed: 20, rate: 0.3, minutes: 30 }));
  writeJson(path.join(amber.home, 'config.json'), { strategy: 'both' });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: amber.project }), amber.env).stdout.trim(), '');
  const red = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(red.home, linearSeries({ now: NOW, resetInMin: 150, startUsed: 40, rate: 0.6, minutes: 30 }));
  writeJson(path.join(red.home, 'config.json'), { strategy: 'both' });
  assert.equal(runHook('pre-agent', preAgentInput({ cwd: red.project }), red.env).json.hookSpecificOutput.updatedInput.model, 'haiku');
});

test('status line shows the throttle', () => {
  const e = env(60, 150);
  const r = runScript('statusline.js', [], { session_id: 'x', model: { id: 'claude-opus-5-5' } }, e.env);
  assert.match(r.stdout.replace(/\u001b\[[0-9;]*m/g, ''), /Drossel 2s/);
});
