'use strict';
// Reads the session transcript (JSONL) only to find model names; no content is kept or
// logged. Claude Code appends to the transcript asynchronously, so the line with the
// current tool call can show up a moment after PreToolUse has started.
const fs = require('fs');
const { sleepMs } = require('./util');

const TAIL_BYTES = 2 * 1024 * 1024; // transcripts grow large; the lines we need are at the end
const NEWLINE = 0x0a;

// Returns a function that yields the complete lines appended since its previous call.
// The first call reads only the last TAIL_BYTES. Splitting happens on bytes, so a
// multi-byte character cut by a read boundary is never decoded half.
function tailReader(file) {
  let pos = null;
  let carry = Buffer.alloc(0);
  let dropFirst = false;
  const next = () => {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (pos === null || size < pos) { // first read, or the file was replaced
        pos = Math.max(0, size - TAIL_BYTES);
        dropFirst = pos > 0; // the tail most likely starts inside a line
        carry = Buffer.alloc(0);
      }
      if (size === pos) return [];
      const buf = Buffer.alloc(size - pos);
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const lines = [];
      let start = 0;
      for (let i = data.indexOf(NEWLINE); i !== -1; i = data.indexOf(NEWLINE, start)) {
        lines.push(data.subarray(start, i).toString('utf8'));
        start = i + 1;
      }
      carry = Buffer.from(data.subarray(start));
      if (dropFirst && lines.length) { lines.shift(); dropFirst = false; }
      return lines;
    } catch {
      return [];
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
  };
  // A last line without its newline yet; callers may try it as complete JSON.
  next.pending = () => (dropFirst || !carry.length ? '' : carry.toString('utf8'));
  return next;
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function usableModel(m) {
  // Claude Code writes "<synthetic>" for messages it generated itself (errors, interrupts).
  return typeof m === 'string' && m.trim() && m !== '<synthetic>' ? m.trim() : null;
}

// The assistant message (parsed) whose content has the tool_use block with this id.
function messageOfToolUse(line, toolUseId) {
  if (!line || !line.includes(toolUseId)) return null;
  const o = parse(line);
  const msg = o && o.message;
  if (!msg || !Array.isArray(msg.content)) return null;
  return msg.content.some((b) => b && b.type === 'tool_use' && b.id === toolUseId) ? msg : null;
}

// Polls until the line of this tool call is written or the deadline passes; `pick`
// maps the message to the wanted value (null keeps polling). In the first turn of a
// session the file itself appears only after the hook has started (observed 50-70 ms),
// so a missing file is awaited briefly; it never appears without session persistence,
// which is why that wait is capped at FILE_WAIT_MS instead of the whole budget.
const FILE_WAIT_MS = 300;

function pollToolUse(file, toolUseId, pick, { timeoutMs = 1500, pollMs = 50 } = {}) {
  if (typeof file !== 'string' || !file || typeof toolUseId !== 'string' || !toolUseId) return null;
  const start = Date.now(); // real time: QUOTA_PACER_NOW must not stretch the wait
  const deadline = start + timeoutMs;
  const fileDeadline = start + Math.min(timeoutMs, FILE_WAIT_MS);
  for (;;) {
    let isFile = false;
    try { isFile = fs.statSync(file).isFile(); } catch { isFile = false; }
    if (isFile) break;
    const left = fileDeadline - Date.now();
    if (left <= 0) return null;
    sleepMs(Math.min(pollMs, left));
  }
  const read = tailReader(file);
  for (;;) {
    for (const line of read()) {
      const v = pick(messageOfToolUse(line, toolUseId));
      if (v) return v;
    }
    const v = pick(messageOfToolUse(read.pending(), toolUseId));
    if (v) return v;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    sleepMs(Math.min(pollMs, left));
  }
}

// Model of the assistant message that issued this tool call.
function toolUseModel(file, toolUseId, opts) {
  return pollToolUse(file, toolUseId, (msg) => (msg ? usableModel(msg.model) : null), opts);
}

// API message id of the assistant message that issued this tool call. All tool calls
// of one response share it (one transcript line per content block).
function toolUseMessageId(file, toolUseId, opts) {
  return pollToolUse(file, toolUseId, (msg) => (msg && typeof msg.id === 'string' && msg.id ? msg.id : null), opts);
}

// Model of the most recent main-thread assistant message in the transcript tail.
function lastAssistantModel(file) {
  if (typeof file !== 'string' || !file) return null;
  const read = tailReader(file);
  const lines = read();
  const pending = read.pending();
  if (pending) lines.push(pending);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    const o = parse(lines[i]);
    if (!o || o.type !== 'assistant' || o.isSidechain === true || !o.message) continue;
    const m = usableModel(o.message.model);
    if (m) return m;
  }
  return null;
}

module.exports = { toolUseModel, toolUseMessageId, lastAssistantModel, tailReader, TAIL_BYTES, FILE_WAIT_MS };
