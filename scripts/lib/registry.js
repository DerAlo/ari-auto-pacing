'use strict';
// Counts subagents per session. One file per running agent (SubagentStart/Stop) plus
// one reservation per approved spawn (PreToolUse). Reservations close the gap
// between PreToolUse and SubagentStart when Claude launches several agents at once.
const fs = require('fs');
const path = require('path');
const { sessionDir, safeName, writeJsonAtomic } = require('./util');
const { withLock } = require('./lock');

const AGENT_TTL_MS = 3 * 3600 * 1000; // lost SubagentStop events expire
const RESERVATION_TTL_MS = 90 * 1000;

function dirs(sessionId) {
  const base = sessionDir(sessionId);
  return { base, agents: path.join(base, 'agents'), res: path.join(base, 'reservations'), lock: path.join(base, 'registry.lock') };
}

function readEntries(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(dir, n);
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({ file, t: Number(v.t) || 0, type: v.type || null });
    } catch {
      out.push({ file, t: 0, type: null }); // unreadable: treat as expired
    }
  }
  return out;
}

function liveEntries(dir, ttl, now) {
  const live = [];
  for (const e of readEntries(dir)) {
    if (now - e.t > ttl) { try { fs.unlinkSync(e.file); } catch { /* ignore */ } } else live.push(e);
  }
  return live;
}

function countActive(sessionId, now) {
  const d = dirs(sessionId);
  return liveEntries(d.agents, AGENT_TTL_MS, now).length + liveEntries(d.res, RESERVATION_TTL_MS, now).length;
}

// Atomic, because a concurrent reader treats an unreadable entry as expired and deletes it.
function writeEntry(dir, id, data) {
  writeJsonAtomic(path.join(dir, `${safeName(id)}.json`), data);
}

function reserve(sessionId, toolUseId, type, now) {
  const id = toolUseId || `r-${now}-${Math.random().toString(36).slice(2)}`;
  writeEntry(dirs(sessionId).res, id, { t: now, type });
}

function startAgent(sessionId, agentId, type, now) {
  const d = dirs(sessionId);
  return withLock(d.lock, () => {
    writeEntry(d.agents, agentId || `a-${now}-${Math.random().toString(36).slice(2)}`, { t: now, type });
    const res = liveEntries(d.res, RESERVATION_TTL_MS, now).sort((a, b) => a.t - b.t);
    const match = res.find((r) => r.type === type) || res[0];
    if (match) { try { fs.unlinkSync(match.file); } catch { /* ignore */ } }
  });
}

function stopAgent(sessionId, agentId) {
  if (!agentId) return;
  try { fs.unlinkSync(path.join(dirs(sessionId).agents, `${safeName(agentId)}.json`)); } catch { /* ignore */ }
}

function sessionLock(sessionId) {
  return dirs(sessionId).lock;
}

module.exports = { countActive, reserve, startAgent, stopAgent, sessionLock, AGENT_TTL_MS, RESERVATION_TTL_MS };
