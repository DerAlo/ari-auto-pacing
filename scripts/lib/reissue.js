'use strict';
// Loop guard for the re-issue request in auto mode (and unknown permission modes).
// There the plugin cannot rewrite the call (allow would skip the auto-mode classifier),
// so it denies once and asks Claude to send the same call with a cheaper model. A hash
// of the call is remembered per session: when the same call comes back WITHOUT that
// model, it passes unchanged instead of being denied again. Only the hash is stored,
// never the prompt.
const crypto = require('crypto');
const path = require('path');
const { sessionDir, readJson, writeJsonAtomic } = require('./util');

const TTL_MS = 10 * 60 * 1000;

// agentType is the normalised type (a missing subagent_type is "general-purpose"), so a
// re-issued call that only spells out the default type is still the same call.
function callKey(agentType, toolInput) {
  const ti = toolInput || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return crypto.createHash('sha256')
    .update(JSON.stringify([str(agentType) || 'general-purpose', str(ti.description), str(ti.prompt)]))
    .digest('hex')
    .slice(0, 32);
}

function file(sessionId) {
  return path.join(sessionDir(sessionId), 'reissue.json');
}

function load(sessionId, now) {
  const raw = readJson(file(sessionId), {});
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, t] of Object.entries(raw)) if (Number.isFinite(t) && Math.abs(now - t) <= TTL_MS) out[k] = t;
  }
  return out;
}

function save(sessionId, entries) {
  try { writeJsonAtomic(file(sessionId), entries); return true; } catch { return false; }
}

function wasRequested(sessionId, key, now) {
  return Object.prototype.hasOwnProperty.call(load(sessionId, now), key);
}

// True only when the hash is stored and reads back. The caller must not deny without
// it: an unstored guard would deny the same call again and again.
function remember(sessionId, key, now) {
  const entries = load(sessionId, now);
  entries[key] = now;
  return save(sessionId, entries) && wasRequested(sessionId, key, now);
}

function forget(sessionId, key, now) {
  const entries = load(sessionId, now);
  if (!Object.prototype.hasOwnProperty.call(entries, key)) return;
  delete entries[key];
  save(sessionId, entries);
}

module.exports = { callKey, wasRequested, remember, forget, TTL_MS };
