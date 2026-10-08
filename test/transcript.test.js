'use strict';
// Main model from the transcript (fix for the 1.0.0 upgrade bug): the line of this very
// tool call first (waiting for it, because Claude Code writes the transcript
// asynchronously), then the session state, then the last assistant line. Settings and
// ANTHROPIC_MODEL are never used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { toolUseModel, lastAssistantModel, tailReader, TAIL_BYTES } = require('../scripts/lib/transcript');
const { mainModel, setSessionModel } = require('../scripts/lib/models');
const {
  makeEnv, writeJson, runHook, runHookAsync, seedSamples, linearSeries, preAgentInput, assistantLine, userLine, writeTranscript, readLog,
} = require('./helpers');

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const AMBER = () => linearSeries({ now: NOW, resetInMin: 240, startUsed: 20, rate: 0.3, minutes: 30 });
const GREEN = () => linearSeries({ now: NOW, resetInMin: 240, startUsed: 2, rate: 0.05, minutes: 30 });

function downgradeEnv(samples = AMBER()) {
  const e = makeEnv({ QUOTA_PACER_NOW: String(NOW) });
  seedSamples(e.home, samples);
  writeJson(path.join(e.home, 'config.json'), { strategy: 'downgrade' });
  const dir = path.join(e.project, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  // A custom agent without a model runs on the main model: AMBER target is sonnet, so the
  // decision depends on whether the main model is above or below sonnet.
  fs.writeFileSync(path.join(dir, 'impl.md'), '---\nname: impl\ndescription: test agent\n---\nbody');
  return e;
}

const implInput = (e, over = {}) => preAgentInput({ cwd: e.project, tool_input: { prompt: 'x', description: 'y', subagent_type: 'impl' }, ...over });

function inProcessEnv() {
  const e = makeEnv();
  process.env.CLAUDE_CONFIG_DIR = e.claude;
  process.env.QUOTA_PACER_HOME = e.home;
  return e;
}

test('transcript: finds the model of the message that issued this tool call', () => {
  const e = inProcessEnv();
  const file = writeTranscript(path.join(e.base, 't.jsonl'), [
    userLine(),
    assistantLine('claude-sonnet-5-5', 'toolu_other'),
    '{"broken json',
    assistantLine('claude-sonnet-5-5', 'toolu_target_2'), // contains the id as a substring only
    assistantLine('<synthetic>', 'toolu_synth'),
    assistantLine('claude-opus-5-5', 'toolu_target'),
    assistantLine('claude-haiku-4-5-20251001'),
  ]);
  assert.equal(toolUseModel(file, 'toolu_target', { timeoutMs: 0 }), 'claude-opus-5-5');
  assert.equal(toolUseModel(file, 'toolu_other', { timeoutMs: 0 }), 'claude-sonnet-5-5');
  assert.equal(toolUseModel(file, 'toolu_synth', { timeoutMs: 0 }), null);
  assert.equal(toolUseModel(file, 'toolu_missing', { timeoutMs: 0 }), null);
  // The id only appearing as text (e.g. in a tool result) does not count.
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'toolu_x' }] } })}\n`);
  assert.equal(toolUseModel(file, 'toolu_x', { timeoutMs: 0 }), null);
  assert.equal(toolUseModel(path.join(e.base, 'missing.jsonl'), 'toolu_target'), null);
  assert.equal(toolUseModel(e.base, 'toolu_target', { timeoutMs: 0 }), null); // a directory
  assert.equal(toolUseModel(null, 'toolu_target'), null);
  assert.equal(toolUseModel(file, undefined), null);
});

test('transcript: last assistant line skips synthetic and sidechain messages', () => {
  const e = inProcessEnv();
  const file = writeTranscript(path.join(e.base, 't.jsonl'), [
    assistantLine('claude-sonnet-5-5'),
    userLine(),
    assistantLine('claude-haiku-4-5-20251001', null, { isSidechain: true }),
    assistantLine('<synthetic>'),
    userLine('assistant mentioned in a user line'),
  ]);
  assert.equal(lastAssistantModel(file), 'claude-sonnet-5-5');
  assert.equal(lastAssistantModel(path.join(e.base, 'missing.jsonl')), null);
  assert.equal(lastAssistantModel(undefined), null);
});

test('transcript: only the tail of a big file is read; lines split across reads stay intact', () => {
  const e = inProcessEnv();
  const file = path.join(e.base, 'big.jsonl');
  const filler = `${JSON.stringify({ type: 'user', message: { content: 'Größenänderung über ÄÖÜ '.repeat(40) } })}\n`;
  const count = Math.ceil((TAIL_BYTES * 1.3) / Buffer.byteLength(filler));
  fs.writeFileSync(file, `${assistantLine('claude-sonnet-5-5', 'toolu_head')}\n${filler.repeat(count)}${assistantLine('claude-opus-5-5', 'toolu_tail')}\n`);
  assert.ok(fs.statSync(file).size > TAIL_BYTES);
  assert.equal(toolUseModel(file, 'toolu_tail', { timeoutMs: 0 }), 'claude-opus-5-5');
  assert.equal(toolUseModel(file, 'toolu_head', { timeoutMs: 0 }), null, 'lines before the last 2 MB are not read');

  // Incremental reads: a line written in two parts, split inside a multi-byte character.
  const small = path.join(e.base, 'small.jsonl');
  fs.writeFileSync(small, `${userLine()}\n`);
  const read = tailReader(small);
  assert.equal(read().length, 1);
  const line = Buffer.from(`${assistantLine('claude-opus-5-5', 'toolu_ü')}\n`);
  const cut = line.indexOf(Buffer.from('ü')) + 1; // between the two bytes of "ü"
  fs.appendFileSync(small, line.subarray(0, cut));
  assert.deepEqual(read(), []);
  assert.equal(read.pending(), line.subarray(0, cut).toString('utf8'));
  fs.appendFileSync(small, line.subarray(cut));
  const lines = read();
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).message.content[0].id, 'toolu_ü');
  // A last line without its newline yet still counts once it is complete JSON.
  fs.appendFileSync(small, assistantLine('claude-haiku-4-5-20251001', 'toolu_nonl'));
  assert.equal(toolUseModel(small, 'toolu_nonl', { timeoutMs: 0 }), 'claude-haiku-4-5-20251001');
});

test('main model order: transcript line, then session state, then last assistant line', () => {
  const e = inProcessEnv();
  const file = writeTranscript(path.join(e.base, 't.jsonl'), [userLine(), assistantLine('claude-sonnet-5-5', 'toolu_old')]);
  fs.appendFileSync(file, `${assistantLine('claude-haiku-4-5-20251001', 'toolu_now')}\n`);
  setSessionModel('s', 'claude-opus-5-5');
  const q = { sessionId: 's', transcriptPath: file, waitMs: 0 };
  assert.deepEqual(mainModel({ ...q, toolUseId: 'toolu_now' }), { model: 'claude-haiku-4-5-20251001', source: 'transcript' });
  assert.deepEqual(mainModel({ ...q, toolUseId: 'toolu_unknown' }), { model: 'claude-opus-5-5', source: 'session' });
  assert.deepEqual(mainModel({ ...q, sessionId: 'other', toolUseId: 'toolu_unknown' }), { model: 'claude-haiku-4-5-20251001', source: 'last-assistant' });
  assert.deepEqual(mainModel({ sessionId: 'other', transcriptPath: path.join(e.base, 'none.jsonl'), toolUseId: 'x' }), { model: null, source: 'unknown' });
});

test('hook waits for the transcript line that is written after the call started', async () => {
  const e = downgradeEnv();
  // Without the transcript line the session state (opus) would decide: rewrite to sonnet.
  runHook('session-start', { session_id: 'sess-1', source: 'startup', model: 'claude-opus-5-5' }, e.env);
  const input = implInput(e);
  input.transcript_path = writeTranscript(path.join(e.base, 't.jsonl'), [userLine()]);
  const started = Date.now();
  const hook = runHookAsync('pre-agent', input, e.env);
  // Claude Code appends the assistant line asynchronously; here another process does it ~300 ms later.
  const appender = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    setTimeout(() => {
      fs.appendFileSync(${JSON.stringify(input.transcript_path)}, ${JSON.stringify(`${assistantLine('claude-haiku-4-5-20251001', input.tool_use_id)}
`)});
      process.stdout.write(String(Date.now()));
    }, 300);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  appender.stdout.on('data', (d) => { out += d; });
  await new Promise((resolve) => appender.on('close', resolve));
  const r = await hook;
  const appendedAt = Number(out);
  assert.equal(r.code, 0);
  assert.ok(appendedAt - started >= 300, 'the line was written while the hook was already running');
  assert.equal(r.stdout.trim(), '', 'main model haiku is below the sonnet target: nothing to change');
  const d = readLog(e.home, 'pre-agent');
  assert.deepEqual(d.map((l) => [l.action, l.effective, l.effectiveSource]), [['none', 'claude-haiku-4-5-20251001', 'main/transcript']]);
});

test('the transcript wait is bounded: after ~1.5 s the session state decides', () => {
  const e = downgradeEnv();
  runHook('session-start', { session_id: 'sess-1', source: 'startup', model: 'claude-opus-5-5' }, e.env);
  const input = implInput(e);
  input.transcript_path = writeTranscript(path.join(e.base, 't.jsonl'), [userLine(), assistantLine('claude-haiku-4-5-20251001', 'toolu_other')]);
  const r = runHook('pre-agent', input, e.env);
  assert.ok(r.ms >= 1400 && r.ms < 6000, `took ${r.ms} ms`);
  assert.equal(r.json.hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.equal(readLog(e.home, 'pre-agent')[0].effectiveSource, 'main/session');
});

test('no transcript wait when the decision cannot depend on the model', () => {
  // GREEN: nothing would change, so the model is not even resolved.
  const g = downgradeEnv(GREEN());
  const gi = implInput(g);
  gi.transcript_path = writeTranscript(path.join(g.base, 't.jsonl'), [userLine()]);
  const rg = runHook('pre-agent', gi, g.env);
  assert.ok(rg.ms < 1400, `GREEN took ${rg.ms} ms`);
  assert.equal(readLog(g.home, 'pre-agent')[0].effectiveSource, 'not-needed');
  // AMBER with an explicit model in the call: the call itself decides.
  const a = downgradeEnv();
  const ai = implInput(a, { tool_input: { prompt: 'x', description: 'y', subagent_type: 'impl', model: 'opus' } });
  ai.transcript_path = writeTranscript(path.join(a.base, 't.jsonl'), [userLine()]);
  const ra = runHook('pre-agent', ai, a.env);
  assert.ok(ra.ms < 1400, `explicit model took ${ra.ms} ms`);
  assert.equal(ra.json.hookSpecificOutput.updatedInput.model, 'sonnet');
  // AMBER without a transcript file (session not persisted): waiting cannot help.
  const m = downgradeEnv();
  const rm = runHook('pre-agent', implInput(m), m.env);
  assert.ok(rm.ms < 1400, `missing transcript took ${rm.ms} ms (the wait is 1500 ms)`);
  assert.equal(rm.stdout.trim(), '', 'unknown main model: sonnet could be an upgrade, so nothing changes');
  assert.equal(readLog(m.home, 'pre-agent')[0].reason, 'unknown-effective-model');
});

test('settings and ANTHROPIC_MODEL never count as the main model', () => {
  const e = downgradeEnv();
  e.env.ANTHROPIC_MODEL = 'claude-opus-5-5';
  writeJson(path.join(e.claude, 'settings.json'), { model: 'opus' });
  writeJson(path.join(e.project, '.claude', 'settings.json'), { model: 'opus' });
  const r = runHook('pre-agent', implInput(e), e.env);
  assert.equal(r.stdout.trim(), '');
  const d = readLog(e.home, 'pre-agent')[0];
  assert.equal(d.effective, null);
  assert.equal(d.effectiveSource, 'main/unknown');
  // Unknown main model: haiku is still a safe target (Explore in AMBER).
  const x = runHook('pre-agent', preAgentInput({ cwd: e.project }), e.env);
  assert.equal(x.json.hookSpecificOutput.updatedInput.model, 'haiku');
});

test('a spawn does not queue behind another spawn that waits for its transcript line', async () => {
  const e = downgradeEnv();
  const slow = implInput(e);
  slow.transcript_path = writeTranscript(path.join(e.base, 'slow.jsonl'), [userLine()]); // its line never comes
  const fast = preAgentInput({ cwd: e.project, tool_input: { prompt: 'a', description: 'b', subagent_type: 'Explore', model: 'opus' } });
  let slowEnd = 0;
  const pSlow = runHookAsync('pre-agent', slow, e.env).then((r) => { slowEnd = Date.now(); return r; });
  await new Promise((resolve) => setTimeout(resolve, 400)); // the slow hook is now waiting
  const rFast = await runHookAsync('pre-agent', fast, e.env);
  const fastEnd = Date.now();
  const rSlow = await pSlow;
  assert.ok(rSlow.ms >= 1400, `slow hook took ${rSlow.ms} ms`);
  // Holding the lock during the wait would make the fast hook finish just after the slow one.
  assert.ok(slowEnd - fastEnd >= 400, `fast hook ended only ${slowEnd - fastEnd} ms before the slow one`);
  assert.equal(rFast.json.hookSpecificOutput.updatedInput.model, 'haiku');
});
