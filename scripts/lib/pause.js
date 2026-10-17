'use strict';
// Temporary pause of all interventions (`pacer.js pause [duration]`, `/quota-pacer:pause`).
// Stored apart from config.json, so a pause never touches the user's settings and ends on
// its own. While a pause is active loadConfig() reports enabled: false; the sensor keeps
// recording. A pause that has run out counts as absent.
const fs = require('fs');
const path = require('path');
const { pacerHome, readJson, writeJsonAtomic } = require('./util');

const DEFAULT_PAUSE_MIN = 120;
const MAX_PAUSE_MIN = 7 * 24 * 60;
const UNIT_MIN = { m: 1, min: 1, h: 60, std: 60, d: 1440, t: 1440 };

function pauseFile() {
  return path.join(pacerHome(), 'pause.json');
}

// "30m", "2h", "1,5h", "1d", "45" (minutes). Returns minutes, or null if not readable or
// outside 1 min – 7 days.
function parseDuration(text) {
  if (text === undefined || text === null || String(text).trim() === '') return DEFAULT_PAUSE_MIN;
  const m = /^(\d+(?:[.,]\d+)?)\s*(m|min|h|std|d|t)?$/i.exec(String(text).trim());
  if (!m) return null;
  const minutes = Number(m[1].replace(',', '.')) * UNIT_MIN[(m[2] || 'm').toLowerCase()];
  return minutes >= 1 && minutes <= MAX_PAUSE_MIN ? minutes : null;
}

// End of the active pause in ms, or null.
function activePause(now) {
  const p = readJson(pauseFile(), null);
  if (!p || typeof p !== 'object' || !Number.isFinite(p.until)) return null;
  // A file with an end beyond the maximum (clock jump, hand edit) is capped, never endless.
  const until = Number.isFinite(p.t) ? Math.min(p.until, p.t + MAX_PAUSE_MIN * 60000) : p.until;
  return until > now ? until : null;
}

function setPause(minutes, now) {
  const until = Math.round(now + minutes * 60000);
  writeJsonAtomic(pauseFile(), { until, t: now });
  return until;
}

// true if a pause file was removed.
function clearPause() {
  try {
    fs.unlinkSync(pauseFile());
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

module.exports = { activePause, setPause, clearPause, parseDuration, pauseFile, DEFAULT_PAUSE_MIN, MAX_PAUSE_MIN };
