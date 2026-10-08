'use strict';
// E2E scenarios. Each one gets a fresh temp HOME, seeded samples, an explicit config.json
// and an explicit --permission-mode. `expect(r)` returns checks on what the mock recorded
// (models, timestamps, tool results) and on decisions.jsonl. The runner adds the generic
// checks (exit code, fake credentials only, no outside connection, one audit line per
// Agent call, no plugin errors).
//
// The 18 v1.0.0 scenarios run with {"strategy":"downgrade"}; their
// expectations follow what Claude Code 2.1.291 really does (see cli-facts.md).

const MAIN = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5-5';
const WAIT = 2.5; // maxWaitSec of the throttle scenarios: short runs, pause still obvious
const PAUSE_MIN_MS = WAIT * 1000 - 50; // a pause shows up as at least this gap
const NO_PAUSE_MAX_MS = 1500; // a gap without a pause stays well below WAIT

const DOWNGRADE = { strategy: 'downgrade' };
const HOOK_ERROR = /^PreToolUse:Agent hook error: /;

function eq(name, actual, expected) { return { name, pass: actual === expected, actual, expected }; }
function same(name, actual, expected) { return { name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected }; }
function truthy(name, cond, actual, expected = true) { return { name, pass: !!cond, actual: actual === undefined ? !!cond : actual, expected }; }
function atLeast(name, actual, min) { return { name, pass: Number.isFinite(actual) && actual >= min, actual, expected: `>= ${min}` }; }
function allAtLeast(name, values, min) { return { name, pass: values.length > 0 && values.every((v) => v >= min), actual: values, expected: `all >= ${min} (n>0)` }; }
function allBelow(name, values, max) { return { name, pass: values.length > 0 && values.every((v) => v < max), actual: values, expected: `all < ${max} (n>0)` }; }

const actions = (r) => r.preAgent.map((d) => d.action).join(',');
const actionReasons = (r) => r.preAgent.map((d) => `${d.action}:${d.reason}`).join(',');
const subModels = (r) => r.subs.map((s) => s.model);
const reads = (n, prefix = 'f') => Array.from({ length: n }, (_, i) => ({ tool: 'Read', file: `${prefix}${i + 1}.txt` }));

// Common checks for "the plugin left this spawn alone".
function untouched(r, n = 1) {
  return [
    eq('Gestartete Subagents', r.subs.length, n),
    truthy('Subagent-Modell = Hauptmodell', r.subs.length === n && r.subs.every((s) => s.model === r.mainModel), subModels(r), r.mainModel),
  ];
}

const V100 = [
  {
    name: 'control-no-plugin',
    title: 'Kontrollgruppe: GELB-Daten, ohne Plugin',
    samples: 'amber', config: DOWNGRADE, plugin: false,
    steps: [{ agents: 1 }],
    expect: (r) => [...untouched(r), eq('decisions.jsonl existiert nicht', r.decisionsExists, false)],
  },
  {
    name: 'green-untouched',
    title: 'GRÜN: Plugin greift nicht ein',
    samples: 'green', config: DOWNGRADE,
    steps: [{ agents: 1 }],
    expect: (r) => [
      ...untouched(r),
      eq('Log', actionReasons(r), 'none:green'),
      eq('Stufe im Log', r.preAgent[0] && r.preAgent[0].level, 'green'),
      eq('Kein Pacing-Kontext an Claude', r.pacingContext, null),
    ],
  },
  {
    name: 'amber-explore-haiku',
    title: 'GELB: Explore wird auf Haiku umgeleitet',
    samples: 'amber', config: DOWNGRADE,
    steps: [{ agents: 1 }],
    expect: (r) => [
      eq('Gestartete Subagents', r.subs.length, 1),
      eq('Subagent-Modell', r.subs[0] && r.subs[0].model, HAIKU),
      eq('Hauptmodell unverändert', r.mainModel, MAIN),
      truthy('Subagent-Ergebnis kommt an', r.agentResults.some((x) => !x.isError && /SUB-DONE/.test(x.text)), r.agentResults.map((x) => x.text.slice(0, 80))),
      eq('Log', actionReasons(r), 'rewrite:downgrade'),
      same('Log: Modell, Stufe, effektives Modell', r.preAgent[0] && [r.preAgent[0].model, r.preAgent[0].level, r.preAgent[0].effective, r.preAgent[0].effectiveSource, r.preAgent[0].permissionMode], ['haiku', 'amber', MAIN, 'builtin-main/transcript', 'default']),
      truthy('Pacing-Kontext an Claude', /^Usage pacing level AMBER: 5-hour quota \d+% used, projected \d+%/.test(r.pacingContext || ''), r.pacingContext),
    ],
  },
  {
    name: 'amber-custom-sonnet',
    title: 'GELB: eigener Agent ohne Modellangabe → Sonnet',
    samples: 'amber', config: DOWNGRADE, agents: { impl: null },
    steps: [{ agents: 1, subagentType: 'impl' }],
    expect: (r) => [
      eq('Subagent-Modell', r.subs[0] && r.subs[0].model, SONNET),
      same('Log', r.preAgent.map((d) => [d.action, d.model, d.cls, d.effectiveSource]), [['rewrite', 'sonnet', 'default', 'main/transcript']]),
    ],
  },
  {
    name: 'amber-explicit-opus-downgraded',
    title: 'GELB: ausdrücklich angefordertes Opus → Sonnet',
    samples: 'amber', config: DOWNGRADE, agents: { impl: null },
    steps: [{ agents: 1, subagentType: 'impl', requestModel: 'opus' }],
    expect: (r) => [
      eq('Subagent-Modell', r.subs[0] && r.subs[0].model, SONNET),
      same('Log', r.preAgent.map((d) => [d.action, d.model, d.effective, d.effectiveSource]), [['rewrite', 'sonnet', 'opus', 'invocation']]),
    ],
  },
  {
    name: 'never-upgrade-pinned-haiku',
    title: 'Nie hochstufen: Agent mit model: haiku',
    samples: 'amber', config: DOWNGRADE, agents: { cheap: 'haiku' },
    steps: [{ agents: 1, subagentType: 'cheap' }],
    expect: (r) => [
      eq('Subagent-Modell', r.subs[0] && r.subs[0].model, HAIKU),
      eq('Log', actionReasons(r), 'none:already-at-or-below-target'),
      eq('Log: effektives Modell aus Definition', r.preAgent[0] && r.preAgent[0].effectiveSource, 'definition'),
    ],
  },
  {
    name: 'never-upgrade-haiku-session',
    title: 'Nie hochstufen: Hauptsitzung auf Haiku, Ziel wäre Sonnet',
    samples: 'amber', config: DOWNGRADE, agents: { impl: null }, mainModel: 'haiku',
    steps: [{ agents: 1, subagentType: 'impl' }],
    expect: (r) => [
      eq('Hauptmodell', r.mainModel, HAIKU),
      eq('Subagent-Modell', r.subs[0] && r.subs[0].model, HAIKU),
      eq('Log', actionReasons(r), 'none:already-at-or-below-target'),
      same('Log: Hauptmodell aus dem Transkript', r.preAgent[0] && [r.preAgent[0].effective, r.preAgent[0].effectiveSource], [HAIKU, 'main/transcript']),
    ],
  },
  {
    name: 'amber-burst-5-cap-3',
    title: 'GELB: 5 parallele Spawns, Limit 3',
    samples: 'amber', config: DOWNGRADE,
    steps: [{ agents: 5 }],
    expect: (r) => [
      eq('Gestartete Subagents', r.subs.length, 3),
      truthy('Alle gestarteten auf Haiku', r.subs.length && r.subs.every((s) => s.model === HAIKU), subModels(r)),
      eq('Abgelehnte Spawns (Hook-Fehler, Limit 3)', r.agentResults.filter((x) => x.isError && HOOK_ERROR.test(x.text) && /limit at this level is 3/.test(x.text)).length, 2),
      same('Log (sortiert)', r.preAgent.map((d) => d.action).sort(), ['deny', 'deny', 'rewrite', 'rewrite', 'rewrite']),
      same('Log: active bei deny', r.preAgent.filter((d) => d.action === 'deny').map((d) => d.active), [3, 3]),
    ],
  },
  {
    name: 'red-burst-2-cap-1',
    title: 'ROT: 2 parallele Spawns, Limit 1',
    samples: 'red', config: DOWNGRADE,
    steps: [{ agents: 2 }],
    expect: (r) => [
      eq('Gestartete Subagents', r.subs.length, 1),
      eq('Subagent-Modell', r.subs[0] && r.subs[0].model, HAIKU),
      eq('Abgelehnte Spawns (Hook-Fehler, Limit 1)', r.agentResults.filter((x) => x.isError && HOOK_ERROR.test(x.text) && /limit at this level is 1/.test(x.text)).length, 1),
      same('Log (sortiert)', r.preAgent.map((d) => `${d.action}/${d.level}`).sort(), ['deny/red', 'rewrite/red']),
    ],
  },
  {
    name: 'stop-denies-all',
    title: 'STOPP: neue Subagents abgelehnt',
    samples: 'stop', config: DOWNGRADE,
    steps: [{ agents: 2 }],
    expect: (r) => [
      eq('Gestartete Subagents', r.subs.length, 0),
      eq('Abgelehnte Spawns (Reserve erreicht)', r.agentResults.filter((x) => x.isError && HOOK_ERROR.test(x.text) && /reserve is reached/.test(x.text)).length, 2),
      eq('Log', actionReasons(r), 'deny:stop,deny:stop'),
    ],
  },
  {
    name: 'ask-rule-respected',
    title: 'ask-Regel für Agent(Explore): Plugin hält sich heraus',
    samples: 'amber', config: DOWNGRADE, projectSettings: { permissions: { ask: ['Agent(Explore)'] } },
    steps: [{ agents: 1 }],
    expect: (r) => [
      eq('Log', actionReasons(r), 'skip:permission-ask-rule'),
      eq('Log: Regel', r.preAgent[0] && r.preAgent[0].rule, 'Agent(Explore)'),
      // CLI 2.1.291 does not enforce an ask rule for Agent in -p (cli-facts §6): the
      // subagent runs. The plugin must not have rewritten it: it runs on the main model.
      ...untouched(r),
    ],
  },
  {
    name: 'deny-rule-respected',
    title: 'deny-Regel für Agent(Explore) bleibt wirksam',
    samples: 'amber', config: DOWNGRADE, projectSettings: { permissions: { deny: ['Agent(Explore)'] } },
    steps: [{ agents: 1 }],
    expect: (r) => [
      eq('Gestartete Subagents', r.subs.length, 0),
      truthy('Ablehnung durch die Regel', r.agentResults.some((x) => x.isError && /denied by permission rule/i.test(x.text)), r.agentResults.map((x) => x.text.slice(0, 120))),
      eq('Log', actionReasons(r), 'skip:permission-deny-rule'),
    ],
  },
  {
    name: 'force-env-limitation',
    title: 'Bekannte Grenze: CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1',
    samples: 'amber', config: DOWNGRADE, env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' },
    steps: [{ agents: 1 }],
    expect: (r) => [...untouched(r), eq('Log', actionReasons(r), 'none:force-env')],
  },
  {
    name: 'auto-no-plugin',
    title: 'Auto-Mode ohne Plugin: Klassifikator prüft',
    samples: 'amber', config: DOWNGRADE, plugin: false, permissionMode: 'auto',
    steps: [{ agents: 1 }],
    expect: (r) => [
      ...untouched(r),
      truthy('Server-Klassifikator angefragt und Urteil geliefert', r.verdictFor(r.spawned[0] && r.spawned[0].id) === 'not_flagged', r.verdictFor(r.spawned[0] && r.spawned[0].id), 'not_flagged'),
      truthy('Subagent liefert per SubagentHandback', r.subs[0] && r.subs[0].actions.includes('handback'), r.subs[0] && r.subs[0].actions),
      eq('decisions.jsonl existiert nicht', r.decisionsExists, false),
    ],
  },
  {
    name: 'auto-reissue-haiku',
    title: 'Auto-Mode: Re-Issue mit Haiku, Klassifikator prüft',
    samples: 'amber', config: DOWNGRADE, permissionMode: 'auto',
    steps: [{ agents: 1 }],
    expect: (r) => [
      eq('Log', actionReasons(r), 'reissue:downgrade,none:already-at-or-below-target'),
      eq('Log: permissionMode', r.preAgent.map((d) => d.permissionMode).join(','), 'auto,auto'),
      truthy('Ablehnung bittet um "model": "haiku"', r.agentResults[0] && r.agentResults[0].isError && HOOK_ERROR.test(r.agentResults[0].text) && /"model": "haiku"/.test(r.agentResults[0].text), r.agentResults[0] && r.agentResults[0].text.slice(0, 160)),
      same('Agent-Aufrufe (Modellfeld)', r.spawned.map((s) => s.model || null), [null, 'haiku']),
      truthy('Neuer Aufruf vom Server-Klassifikator geprüft', r.verdictFor(r.spawned[1] && r.spawned[1].id) === 'not_flagged', r.verdictFor(r.spawned[1] && r.spawned[1].id), 'not_flagged'),
      eq('Gestartete Subagents', r.subs.length, 1),
      eq('Subagent-Modell', r.subs[0] && r.subs[0].model, HAIKU),
    ],
  },
  {
    name: 'auto-classifier-block-binding',
    title: 'Auto-Mode: Blockentscheidung des Klassifikators bleibt bindend',
    samples: 'amber', config: DOWNGRADE, permissionMode: 'auto',
    mock: { serverClassifier: (b) => (b.name === 'Agent' && b.input && b.input.model ? 'flagged' : 'not_flagged') },
    steps: [{ agents: 1 }],
    expect: (r) => [
      eq('Log', actionReasons(r), 'reissue:downgrade,none:already-at-or-below-target'),
      eq('Gestartete Subagents', r.subs.length, 0),
      truthy('Klassifikator lehnt den neuen Aufruf ab', r.agentResults.some((x) => x.isError && /denied by the Claude Code auto mode classifier/.test(x.text)), r.agentResults.map((x) => x.text.slice(0, 120))),
    ],
  },
  {
    name: 'auto-reissue-local-classifier',
    title: 'Auto-Mode, lokaler Klassifikator (kein Server-Urteil): Re-Issue mit Haiku',
    samples: 'amber', config: DOWNGRADE, permissionMode: 'auto', mock: { serverClassifier: 'none', localClassifier: 'allow' },
    steps: [{ agents: 1 }],
    expect: (r) => [
      eq('Log', actionReasons(r), 'reissue:downgrade,none:already-at-or-below-target'),
      atLeast('Lokale Klassifikator-Anfragen', r.classifier.length, 1),
      eq('Gestartete Subagents', r.subs.length, 1),
      eq('Subagent-Modell', r.subs[0] && r.subs[0].model, HAIKU),
    ],
  },
  {
    name: 'auto-local-classifier-block',
    title: 'Auto-Mode, lokaler Klassifikator blockiert: bleibt bindend',
    samples: 'amber', config: DOWNGRADE, permissionMode: 'auto', mock: { serverClassifier: 'none', localClassifier: 'block' },
    steps: [{ agents: 1 }],
    expect: (r) => [
      eq('Log', actionReasons(r), 'reissue:downgrade,none:already-at-or-below-target'),
      truthy('Lokaler Klassifikator: Stufe 1 und 2 gefragt', r.classifier.some((c) => c.action === 'stage1') && r.classifier.some((c) => c.action === 'stage2'), r.classifier.map((c) => c.action)),
      eq('Gestartete Subagents', r.subs.length, 0),
      truthy('Klassifikator lehnt ab', r.agentResults.some((x) => x.isError && /auto mode classifier/.test(x.text)), r.agentResults.map((x) => x.text.slice(0, 120))),
    ],
  },
  {
    name: 'auto-burst-5-cap-3',
    title: 'Auto-Mode: 5 parallele Spawns, Re-Issue, Limit 3',
    samples: 'amber', config: DOWNGRADE, permissionMode: 'auto',
    steps: [{ agents: 5 }],
    expect: (r) => [
      same('Log (sortiert)', r.preAgent.map((d) => d.action).sort(), ['deny', 'deny', 'none', 'none', 'none', 'reissue', 'reissue', 'reissue', 'reissue', 'reissue']),
      eq('Gestartete Subagents', r.subs.length, 3),
      truthy('Alle gestarteten auf Haiku', r.subs.length && r.subs.every((s) => s.model === HAIKU), subModels(r)),
      eq('Abgelehnte Spawns (Limit 3)', r.agentResults.filter((x) => x.isError && /limit at this level is 3/.test(x.text)).length, 2),
    ],
  },
  {
    name: 'installed-via-marketplace',
    title: 'Installation über Marketplace (quota-pacer@ari-auto-pacing) statt --plugin-dir',
    samples: 'amber', config: DOWNGRADE, plugin: 'marketplace',
    steps: [{ agents: 1 }],
    expect: (r) => [
      eq('marketplace add + install', r.installOk, true),
      eq('installed_plugins.json kennt quota-pacer@ari-auto-pacing', r.installedKeys.includes('quota-pacer@ari-auto-pacing'), true),
      eq('Subagent-Modell', r.subs[0] && r.subs[0].model, HAIKU),
      eq('Log', actionReasons(r), 'rewrite:downgrade'),
    ],
  },
];

// 1.1.0: throttle and strategy routing.
const THROTTLE_CFG = { throttle: { maxWaitSec: WAIT } };

function throttleOn(r) {
  return r.systemMessages.filter((m) => /Drossel aktiv/.test(m));
}

const V110 = [
  {
    name: 'throttle-default-ahead',
    title: 'Standard-Strategie (Drossel) vor dem Plan: Pausen, Modelle unverändert',
    samples: 'aheadGreen', config: THROTTLE_CFG, expectPre: { strategy: 'throttle', waitSec: WAIT },
    steps: [{ agents: 1 }, ...reads(3)],
    expect: (r) => [
      ...untouched(r),
      eq('Log pre-agent', actionReasons(r), 'none:strategy-throttle'),
      same('Log Drossel: Werkzeuge', r.throttle.map((d) => d.tool), ['Agent', 'Read', 'Read', 'Read']),
      truthy(`Log Drossel: waitSec = ${WAIT}, Fenster 5h`, r.throttle.length && r.throttle.every((d) => d.waitSec === WAIT && d.window === 'fiveHour' && d.used > d.allowed), r.throttle.map((d) => [d.waitSec, d.window, d.used, d.allowed])),
      atLeast('Abstand Agent-Aufruf → Subagent-Anfrage (ms)', r.agentGapMs, PAUSE_MIN_MS),
      allAtLeast('Abstände nach Read zwischen Haupt-Anfragen (ms)', r.mainToolGaps, PAUSE_MIN_MS),
      eq('Eine Meldung "Drossel aktiv"', throttleOn(r).length, 1),
      truthy('Meldungstext', /Drossel aktiv – Pausen bis 2\.5 s/.test(throttleOn(r)[0] || '') && /Modelle bleiben unverändert/.test(throttleOn(r)[0] || ''), throttleOn(r)[0]),
      eq('Kein Pacing-Kontext an Claude', r.pacingContext, null),
      truthy('Alle Read-Ergebnisse ohne Fehler', r.mainToolResults.length === 3 && r.mainToolResults.every((x) => !x.isError), r.mainToolResults.map((x) => x.isError)),
    ],
  },
  {
    name: 'throttle-on-schedule',
    title: 'Drossel, Verbrauch im Plan: keine Pause',
    samples: 'onSchedule', config: THROTTLE_CFG, expectPre: { strategy: 'throttle', waitSec: 0 },
    steps: [{ agents: 1 }, ...reads(3)],
    expect: (r) => [
      ...untouched(r),
      eq('Log pre-agent', actionReasons(r), 'none:strategy-throttle'),
      eq('Keine Drossel-Einträge', r.throttle.length + r.throttleSkip.length, 0),
      truthy('Abstand Agent-Aufruf → Subagent-Anfrage ohne Pause', r.agentGapMs < NO_PAUSE_MAX_MS, r.agentGapMs, `< ${NO_PAUSE_MAX_MS}`),
      allBelow('Abstände nach Read (ms)', r.mainToolGaps, NO_PAUSE_MAX_MS),
      eq('Keine Drossel-Meldung', throttleOn(r).length, 0),
    ],
  },
  {
    name: 'throttle-red-no-downgrade',
    title: 'Strategie throttle in ROT: kein Deny, kein Modellwechsel',
    samples: 'red', config: { strategy: 'throttle', throttle: { maxWaitSec: WAIT } }, expectPre: { level: 'red', waitSec: WAIT },
    steps: [{ agents: 2 }, ...reads(1)],
    expect: (r) => [
      ...untouched(r, 2),
      eq('Keine abgelehnten Spawns', r.agentResults.filter((x) => x.isError).length, 0),
      eq('Log pre-agent', actionReasons(r), 'none:strategy-throttle,none:strategy-throttle'),
      same('Log: Stufe', r.preAgent.map((d) => d.level), ['red', 'red']),
      same('Log Drossel: beide parallelen Agent-Aufrufe + Read pausieren', r.throttle.map((d) => d.tool).sort(), ['Agent', 'Agent', 'Read']),
      atLeast('Abstand Agent-Aufrufe → erste Subagent-Anfrage (ms)', r.agentGapMs, PAUSE_MIN_MS),
      allAtLeast('Abstand nach Read (ms)', r.mainToolGaps, PAUSE_MIN_MS),
      eq('Kein Pacing-Kontext an Claude', r.pacingContext, null),
    ],
  },
  {
    name: 'throttle-stop-no-deny',
    title: 'Strategie throttle in STOPP: kein Deny, kein Modellwechsel',
    samples: 'stop', config: { strategy: 'throttle', throttle: { maxWaitSec: WAIT } }, expectPre: { level: 'stop', waitSec: WAIT },
    steps: [{ agents: 2 }],
    expect: (r) => [
      ...untouched(r, 2),
      eq('Keine abgelehnten Spawns', r.agentResults.filter((x) => x.isError).length, 0),
      eq('Log pre-agent', actionReasons(r), 'none:strategy-throttle,none:strategy-throttle'),
      same('Log: Stufe', r.preAgent.map((d) => d.level), ['stop', 'stop']),
      same('Log Drossel: beide parallelen Agent-Aufrufe pausieren', r.throttle.map((d) => d.tool), ['Agent', 'Agent']),
      atLeast('Abstand Agent-Aufrufe → erste Subagent-Anfrage (ms)', r.agentGapMs, PAUSE_MIN_MS),
    ],
  },
  {
    name: 'both-amber-throttle-only',
    title: 'Strategie both in GELB: nur Drossel',
    samples: 'amberAhead', config: { strategy: 'both', throttle: { maxWaitSec: WAIT } }, expectPre: { level: 'amber', waitSec: WAIT },
    steps: [{ agents: 1 }, ...reads(2)],
    expect: (r) => [
      ...untouched(r),
      eq('Log pre-agent', actionReasons(r), 'none:strategy-both'),
      eq('Log: Stufe', r.preAgent[0] && r.preAgent[0].level, 'amber'),
      same('Log Drossel: Werkzeuge', r.throttle.map((d) => d.tool), ['Agent', 'Read', 'Read']),
      atLeast('Abstand Agent-Aufruf → Subagent-Anfrage (ms)', r.agentGapMs, PAUSE_MIN_MS),
      allAtLeast('Abstände nach Read (ms)', r.mainToolGaps, PAUSE_MIN_MS),
      eq('Kein Pacing-Kontext an Claude (GELB)', r.pacingContext, null),
    ],
  },
  {
    name: 'both-red-throttle-and-haiku',
    title: 'Strategie both in ROT: Drossel + Haiku',
    samples: 'red', config: { strategy: 'both', throttle: { maxWaitSec: WAIT } }, expectPre: { level: 'red', waitSec: WAIT },
    steps: [{ agents: 1 }, ...reads(2)],
    expect: (r) => [
      eq('Subagent-Modell', r.subs[0] && r.subs[0].model, HAIKU),
      eq('Log pre-agent', actionReasons(r), 'rewrite:downgrade'),
      same('Log pre-agent: Modell/Stufe', r.preAgent.map((d) => [d.model, d.level]), [['haiku', 'red']]),
      same('Agent-Aufruf nicht gedrosselt (Downgrade entscheidet)', r.throttleSkip.map((d) => [d.tool, d.reason]), [['Agent', 'agent-call-downgrade']]),
      same('Log Drossel: Werkzeuge', r.throttle.map((d) => d.tool), ['Read', 'Read']),
      allAtLeast('Abstände nach Read (ms)', r.mainToolGaps, PAUSE_MIN_MS),
      truthy('Pacing-Kontext ROT mit Pausen-Hinweis', /^Usage pacing level RED:/.test(r.pacingContext || '') && /Short pauses between steps/.test(r.pacingContext || ''), r.pacingContext),
    ],
  },
  {
    name: 'throttle-in-subagent',
    title: 'Drossel greift in den Tool-Aufrufen eines Subagents',
    samples: 'aheadGreen', config: THROTTLE_CFG, expectPre: { strategy: 'throttle', waitSec: WAIT },
    steps: [{ agents: 1 }], subTools: reads(3, 's'),
    expect: (r) => [
      ...untouched(r),
      eq('Subagent-Anfragen', r.subs[0] && r.subs[0].times.length, 4),
      allAtLeast('Abstände zwischen Subagent-Anfragen nach Read (ms)', r.subToolGaps, PAUSE_MIN_MS),
      same('Log Drossel: Werkzeuge', r.throttle.map((d) => d.tool), ['Agent', 'Read', 'Read', 'Read']),
    ],
  },
  {
    name: 'auto-reissue-ignored',
    title: 'Auto-Mode + downgrade: Claude ignoriert die Re-Issue-Bitte → zweiter Aufruf läuft unverändert',
    samples: 'amber', config: DOWNGRADE, permissionMode: 'auto', mock: { reissue: 'ignore' },
    steps: [{ agents: 1 }],
    expect: (r) => [
      eq('Log', actionReasons(r), 'reissue:downgrade,none:reissue-ignored'),
      same('Agent-Aufrufe (Modellfeld)', r.spawned.map((s) => s.model || null), [null, null]),
      eq('Keine Schleife: genau 2 Agent-Aufrufe', r.spawned.length, 2),
      ...untouched(r),
    ],
  },
  {
    name: 'stale-no-intervention',
    title: 'Veraltete Messpunkte (> 20 min): kein Eingriff',
    samples: 'staleRed', config: { strategy: 'both', throttle: { maxWaitSec: WAIT } }, expectPre: { level: 'unknown', waitSec: 0 },
    steps: [{ agents: 1 }, ...reads(2)],
    expect: (r) => [
      ...untouched(r),
      eq('Log pre-agent', actionReasons(r), 'none:strategy-both'),
      eq('Log: Stufe unknown', r.preAgent[0] && r.preAgent[0].level, 'unknown'),
      eq('Keine Drossel-Einträge', r.throttle.length + r.throttleSkip.length, 0),
      truthy('Abstand Agent-Aufruf → Subagent-Anfrage ohne Pause', r.agentGapMs < NO_PAUSE_MAX_MS, r.agentGapMs, `< ${NO_PAUSE_MAX_MS}`),
      allBelow('Abstände nach Read (ms)', r.mainToolGaps, NO_PAUSE_MAX_MS),
      eq('Kein Pacing-Kontext an Claude', r.pacingContext, null),
      eq('Keine Drossel-Meldung', throttleOn(r).length, 0),
    ],
  },
  {
    name: 'no-samples-no-intervention',
    title: 'Keine Messpunkte (API-Key-Nutzer): kein Eingriff, keine Pause',
    samples: null, config: THROTTLE_CFG, expectPre: { level: 'unknown', waitSec: 0 },
    steps: [{ agents: 1 }, ...reads(2)],
    expect: (r) => [
      ...untouched(r),
      eq('Log pre-agent', actionReasons(r), 'none:strategy-throttle'),
      eq('Log: Stufe unknown', r.preAgent[0] && r.preAgent[0].level, 'unknown'),
      eq('Keine Drossel-Einträge', r.throttle.length + r.throttleSkip.length, 0),
      truthy('Abstand Agent-Aufruf → Subagent-Anfrage ohne Pause', r.agentGapMs < NO_PAUSE_MAX_MS, r.agentGapMs, `< ${NO_PAUSE_MAX_MS}`),
      allBelow('Abstände nach Read (ms)', r.mainToolGaps, NO_PAUSE_MAX_MS),
      eq('Keine Drossel-Meldung', throttleOn(r).length, 0),
    ],
  },
];

for (const s of V100) s.group = '1.0.0';
for (const s of V110) s.group = '1.1.0';

module.exports = { SCENARIOS: [...V100, ...V110], MAIN, HAIKU, SONNET, WAIT, actions };
