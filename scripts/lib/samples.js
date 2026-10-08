'use strict';
// Samples of the account-wide quota usage, written by the status line sensor.
// Every running Claude Code session writes here, so readings can arrive out of
// order or stale; the forecast handles that (monotone envelope per window).
const path = require('path');
const { pacerHome, readJson, writeJsonAtomic } = require('./util');
const { withLock } = require('./lock');

const MAX_SAMPLES = 1500;
const MAX_AGE_MS = 8 * 24 * 3600 * 1000;
const DEDUPE_MS = 60 * 1000;

function samplesFile() {
  return path.join(pacerHome(), 'samples.json');
}

// Accepts epoch seconds, epoch milliseconds, numeric strings or ISO dates.
function toEpochSec(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n)) return toEpochSec(n);
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : Math.round(d / 1000);
  }
  return null;
}

function normWindow(w) {
  if (!w || typeof w !== 'object') return null;
  if (w.used_percentage === null || w.used_percentage === undefined || w.used_percentage === '') return null;
  const u = Number(w.used_percentage);
  if (!Number.isFinite(u)) return null;
  return { u: Math.max(0, Math.min(100, u)), r: toEpochSec(w.resets_at) };
}

function extract(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const f = normWindow(rateLimits.five_hour);
  const s = normWindow(rateLimits.seven_day);
  if (!f && !s) return null;
  return { f, s };
}

function loadSamples() {
  const data = readJson(samplesFile(), null);
  const arr = data && Array.isArray(data.samples) ? data.samples : [];
  return arr
    .filter((x) => x && Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
}

function addSample(rateLimits, now) {
  const x = extract(rateLimits);
  if (!x) return false;
  return withLock(path.join(pacerHome(), 'samples.lock'), () => {
    const arr = loadSamples();
    const last = arr[arr.length - 1];
    if (last && now - last.t < DEDUPE_MS
      && JSON.stringify([last.f, last.s]) === JSON.stringify([x.f, x.s])) {
      return false;
    }
    arr.push({ t: now, f: x.f, s: x.s });
    const kept = arr.filter((a) => now - a.t <= MAX_AGE_MS).slice(-MAX_SAMPLES);
    writeJsonAtomic(samplesFile(), { v: 1, samples: kept });
    return true;
  });
}

module.exports = { toEpochSec, extract, loadSamples, addSample, samplesFile };
