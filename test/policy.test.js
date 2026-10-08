'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { windowLevel, decideSpawn, evaluate } = require('../scripts/lib/policy');
const { DEFAULTS, validate, deepMerge } = require('../scripts/lib/config');
const { rankOf, resolveEffective, setSessionModel } = require('../scripts/lib/models');
const { ruleMatchesAgent } = require('../scripts/lib/permissions');
const { makeEnv, writeJson, seedSamples, linearSeries } = require('./helpers');

const cfg = JSON.parse(JSON.stringify(DEFAULTS));
const W5 = cfg.windows.fiveHour;
const W7 = cfg.windows.sevenDay;
const st = (o) => ({ status: 'ok', ...o });

test('5h levels: usage thresholds', () => {
  assert.equal(windowLevel(st({ used: 10, projected: 40, minutesToReserve: 500 }), W5, 'green', 8), 'green');
  assert.equal(windowLevel(st({ used: 70, projected: null, minutesToReserve: null }), W5, 'green', 8), 'amber');
  assert.equal(windowLevel(st({ used: 85, projected: null, minutesToReserve: null }), W5, 'green', 8), 'red');
  assert.equal(windowLevel(st({ used: 95, projected: null, minutesToReserve: null }), W5, 'green', 8), 'stop');
});

test('5h levels: forecast thresholds', () => {
  assert.equal(windowLevel(st({ used: 40, projected: 91, minutesToReserve: 300 }), W5, 'green', 8), 'amber');
  // Projected overshoot but reserve still far away: amber, not red.
  assert.equal(windowLevel(st({ used: 40, projected: 130, minutesToReserve: 110 }), W5, 'green', 8), 'amber');
  assert.equal(windowLevel(st({ used: 40, projected: 130, minutesToReserve: 80 }), W5, 'green', 8), 'red');
});

test('hysteresis: a level holds until the forecast drops by the margin', () => {
  const s = st({ used: 40, projected: 86, minutesToReserve: 400 });
  assert.equal(windowLevel(s, W5, 'green', 8), 'green');
  assert.equal(windowLevel(s, W5, 'amber', 8), 'amber');
  assert.equal(windowLevel(st({ used: 40, projected: 81, minutesToReserve: 400 }), W5, 'amber', 8), 'green');
  const r = st({ used: 50, projected: 90, minutesToReserve: 120 });
  assert.equal(windowLevel(r, W5, 'amber', 8), 'amber');
  assert.equal(windowLevel(r, W5, 'red', 8), 'red');
});

test('unknown, reset and weekly levels', () => {
  assert.equal(windowLevel({ status: 'stale' }, W5, 'red', 8), 'unknown');
  assert.equal(windowLevel({ status: 'nodata' }, W5, 'red', 8), 'unknown');
  assert.equal(windowLevel({ status: 'reset', used: 0 }, W5, 'red', 8), 'green');
  assert.equal(windowLevel(st({ used: 50, projected: 95, minutesToReserve: null }), W7, 'green', 8), 'amber');
  assert.equal(windowLevel(st({ used: 50, projected: 98, minutesToReserve: null }), W7, 'green', 8), 'red');
});

test('spawn decision: green and unknown change nothing', () => {
  const eff = { model: 'claude-opus-5-5', rank: 3 };
  assert.equal(decideSpawn({ level: 'green', agentType: 'Explore', eff, active: 10, cfg }).action, 'none');
  assert.equal(decideSpawn({ level: 'unknown', agentType: 'Explore', eff, active: 10, cfg }).action, 'none');
});

test('spawn decision: amber routes by class', () => {
  const eff = { model: 'claude-opus-5-5', rank: 3 };
  assert.deepEqual(pick(decideSpawn({ level: 'amber', agentType: 'Explore', eff, active: 0, cfg })), { action: 'rewrite', model: 'haiku' });
  assert.deepEqual(pick(decideSpawn({ level: 'amber', agentType: 'my-impl', eff, active: 0, cfg })), { action: 'rewrite', model: 'sonnet' });
  assert.equal(decideSpawn({ level: 'amber', agentType: 'Plan', eff, active: 0, cfg }).action, 'none');
  assert.deepEqual(pick(decideSpawn({ level: 'red', agentType: 'Plan', eff, active: 0, cfg })), { action: 'rewrite', model: 'sonnet' });
  assert.deepEqual(pick(decideSpawn({ level: 'red', agentType: 'my-impl', eff, active: 0, cfg })), { action: 'rewrite', model: 'haiku' });
});

test('spawn decision: never upgrades', () => {
  const haikuEff = { model: 'haiku', rank: 1 };
  assert.equal(decideSpawn({ level: 'amber', agentType: 'my-impl', eff: haikuEff, active: 0, cfg }).action, 'none');
  const sonnetEff = { model: 'claude-sonnet-5-5', rank: 2 };
  assert.equal(decideSpawn({ level: 'amber', agentType: 'my-impl', eff: sonnetEff, active: 0, cfg }).action, 'none');
  const unknown = { model: null, rank: null };
  assert.equal(decideSpawn({ level: 'amber', agentType: 'plug:x', eff: unknown, active: 0, cfg }).action, 'none');
  assert.equal(decideSpawn({ level: 'red', agentType: 'plug:x', eff: unknown, active: 0, cfg }).model, 'haiku');
});

test('spawn decision: caps, stop, fork and force env', () => {
  const eff = { model: 'claude-opus-5-5', rank: 3 };
  assert.equal(decideSpawn({ level: 'amber', agentType: 'Explore', eff, active: 3, cfg }).action, 'deny');
  assert.equal(decideSpawn({ level: 'red', agentType: 'Explore', eff, active: 1, cfg }).action, 'deny');
  assert.equal(decideSpawn({ level: 'stop', agentType: 'Explore', eff, active: 0, cfg }).reason, 'stop');
  assert.equal(decideSpawn({ level: 'amber', agentType: 'fork', eff, active: 0, cfg }).action, 'none');
  assert.equal(decideSpawn({ level: 'amber', agentType: 'fork', eff, active: 3, cfg }).action, 'deny');
  assert.equal(decideSpawn({ level: 'amber', agentType: 'Explore', eff, active: 0, cfg, forceEnv: true }).action, 'none');
});

test('model ranks', () => {
  assert.equal(rankOf('claude-haiku-4-5-20251001'), 1);
  assert.equal(rankOf('sonnet'), 2);
  assert.equal(rankOf('claude-opus-5-5[1m]'), 3);
  assert.equal(rankOf('opusplan'), 3);
  assert.equal(rankOf('claude-fable-5-1'), 4);
  assert.equal(rankOf('default'), 3);
  assert.equal(rankOf('my-gateway-model'), null);
});

test('effective model follows Claude Code precedence', () => {
  const e = makeEnv();
  process.env.CLAUDE_CONFIG_DIR = e.claude;
  process.env.QUOTA_PACER_HOME = e.home;
  const agents = path.join(e.project, '.claude', 'agents');
  require('fs').mkdirSync(agents, { recursive: true });
  require('fs').writeFileSync(path.join(agents, 'cheap.md'), '---\nname: cheap\ndescription: x\nmodel: haiku\n---\nbody');
  require('fs').writeFileSync(path.join(agents, 'inh.md'), '---\nname: inh\ndescription: x\nmodel: inherit\n---\nbody');
  require('fs').writeFileSync(path.join(agents, 'plain.md'), '---\nname: plain\ndescription: x\n---\nbody');
  setSessionModel('s', 'claude-opus-5-5');
  const base = { sessionId: 's', cwd: e.project, projectDir: e.project };
  assert.equal(resolveEffective({ ...base, toolInput: { model: 'opus' }, agentType: 'cheap', env: {} }).source, 'invocation');
  assert.equal(resolveEffective({ ...base, toolInput: {}, agentType: 'cheap', env: {} }).model, 'haiku');
  assert.deepEqual(resolveEffective({ ...base, toolInput: {}, agentType: 'inh', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }),
    { model: 'claude-opus-5-5', rank: 3, source: 'definition-inherit/session' });
  assert.equal(resolveEffective({ ...base, toolInput: {}, agentType: 'plain', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } }).model, 'sonnet');
  assert.equal(resolveEffective({ ...base, toolInput: {}, agentType: 'plain', env: {} }).source, 'main/session');
  assert.equal(resolveEffective({ ...base, toolInput: {}, agentType: 'Explore', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }).model, 'claude-opus-5-5');
  assert.equal(resolveEffective({ ...base, toolInput: {}, agentType: 'general-purpose', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }).model, 'haiku');
  assert.equal(resolveEffective({ ...base, toolInput: {}, agentType: 'claude-code-guide', env: {} }).rank, 1);
  assert.equal(resolveEffective({ ...base, toolInput: {}, agentType: 'plug:rev', env: {} }).rank, null);
  assert.equal(resolveEffective({ ...base, toolInput: {}, agentType: 'undefined-custom', env: {} }).source, 'unknown');
  // Settings and ANTHROPIC_MODEL are ignored on purpose (--model and /model override them):
  // a session without any model evidence stays unknown, so only haiku is a safe target.
  writeJson(path.join(e.project, '.claude', 'settings.json'), { model: 'haiku' });
  writeJson(path.join(e.claude, 'settings.json'), { model: 'haiku' });
  const fresh = { ...base, sessionId: 'fresh' };
  assert.deepEqual(resolveEffective({ ...fresh, toolInput: {}, agentType: 'Explore', env: { ANTHROPIC_MODEL: 'haiku' } }),
    { model: null, rank: null, source: 'builtin-main/unknown' });
  assert.equal(resolveEffective({ ...base, toolInput: {}, agentType: 'Explore', env: { ANTHROPIC_MODEL: 'haiku' } }).model, 'claude-opus-5-5');
});

test('permission rules matching the Agent tool', () => {
  assert.equal(ruleMatchesAgent('Agent', 'Explore'), true);
  assert.equal(ruleMatchesAgent('Agent(Explore)', 'Explore'), true);
  assert.equal(ruleMatchesAgent('Task(Explore)', 'Explore'), true);
  assert.equal(ruleMatchesAgent('Agent(*)', 'x'), true);
  assert.equal(ruleMatchesAgent('Agent(Plan)', 'Explore'), false);
  assert.equal(ruleMatchesAgent('Bash(rm *)', 'Explore'), false);
  assert.equal(ruleMatchesAgent('AgentX', 'Explore'), false);
});

test('config validation replaces only invalid fields', () => {
  const merged = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), { hysteresisPct: 'x', concurrency: { amber: 2 }, models: { amber: { default: 'gpt' } } });
  const { config, errors } = validate(merged);
  assert.equal(config.hysteresisPct, DEFAULTS.hysteresisPct);
  assert.equal(config.concurrency.amber, 2);
  assert.equal(config.models.amber.default, 'sonnet');
  assert.deepEqual(errors.sort(), ['hysteresisPct', 'models']);
});

test('evaluate persists level and resets memory on a new window', () => {
  const e = makeEnv();
  process.env.CLAUDE_CONFIG_DIR = e.claude;
  process.env.QUOTA_PACER_HOME = e.home;
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  seedSamples(e.home, linearSeries({ now, resetInMin: 150, startUsed: 40, rate: 0.6, minutes: 30 }));
  const a = evaluate(now, cfg);
  assert.equal(a.level, 'red');
  assert.equal(a.changed, true);
  const b = evaluate(now, cfg);
  assert.equal(b.changed, false);
  // New window: low usage, so the old red must not linger.
  seedSamples(e.home, linearSeries({ now: now + 6 * 3600000, resetInMin: 290, startUsed: 1, rate: 0.05, minutes: 10 }));
  assert.equal(evaluate(now + 6 * 3600000, cfg).level, 'green');
});

function pick(d) {
  return { action: d.action, model: d.model };
}
