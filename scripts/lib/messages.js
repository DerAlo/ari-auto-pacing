'use strict';
// Texts for Claude (additionalContext, deny reasons) are factual statements in English,
// as the hooks documentation recommends, so they read as project information and not
// as injected commands. Texts for the user (systemMessage, status line) follow `language`.

const LEVEL_LABEL = {
  de: { unknown: 'KEINE DATEN', green: 'GRÜN', amber: 'GELB', red: 'ROT', stop: 'STOPP' },
  en: { unknown: 'NO DATA', green: 'GREEN', amber: 'AMBER', red: 'RED', stop: 'STOP' },
};

const WINDOW_LABEL = {
  de: { fiveHour: '5-h-Fenster', sevenDay: 'Wochenfenster' },
  en: { fiveHour: '5-hour window', sevenDay: 'weekly window' },
};

const RANK = { unknown: 0, green: 1, amber: 2, red: 3, stop: 4 };

function fmtTime(ms) {
  if (!ms) return '?';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function pct(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? '?' : `${Math.round(v)}%`;
}

function windowPhrase(name, w) {
  const label = name === 'fiveHour' ? '5-hour' : 'weekly';
  if (!w || w.status !== 'ok') return null;
  const proj = w.projected !== null && w.projected !== undefined ? `, projected ${pct(w.projected)} at reset ${fmtTime(w.resetsAt)}` : '';
  return `${label} quota ${pct(w.used)} used${proj}`;
}

function contextForClaude(ev, cfg, active) {
  const parts = ['fiveHour', 'sevenDay'].map((n) => windowPhrase(n, ev.windows[n])).filter(Boolean);
  const cap = cfg.concurrency[ev.level];
  const capText = cap === null || cap === undefined ? 'no subagent limit' : `subagent limit ${cap} concurrent (currently ${active})`;
  const policy = {
    amber: 'Routine subagents run on smaller models. Targeted, sequential work uses the remaining quota better than broad parallel exploration.',
    red: 'Subagents run on the smallest model. Work in the main thread and in sequence keeps the session going until the reset.',
    stop: 'New subagents are paused. Finishing the current step and leaving a short handover note keeps the work recoverable.',
  }[ev.level] || '';
  const pauses = cfg.strategy === 'both' ? ' Short pauses between steps also slow the usage down.' : '';
  return `Usage pacing level ${ev.level.toUpperCase()}: ${parts.join('; ')}. ${capText}. ${policy}${pauses}`.trim();
}

function denyReason(decision, ev, active) {
  if (decision.reason === 'stop') {
    // Name the window that is at STOP; the weekly window can be the cause while the 5-hour one is fine.
    const name = ['fiveHour', 'sevenDay'].find((n) => ev.windows[n] && ev.windows[n].level === 'stop')
      || (ev.windows.sevenDay && ev.windows.sevenDay.status === 'ok' && !(ev.windows.fiveHour && ev.windows.fiveHour.status === 'ok') ? 'sevenDay' : 'fiveHour');
    const w = ev.windows[name] || {};
    const label = name === 'sevenDay' ? 'weekly window' : '5-hour window';
    const used = w.status === 'ok' ? `, ${pct(w.used)} used` : '';
    return `Usage pacing: the plan quota reserve is reached (${label}${used}). `
      + 'New subagents are paused until that window resets. This step can continue in the main thread.';
  }
  return `Usage pacing level ${ev.level.toUpperCase()}: ${active} subagent(s) are already running and the limit at this level is ${decision.cap}. `
    + 'This spawn was not started. The task can run in the main thread, or after a running subagent finishes.';
}

function rewriteReason(decision, ev) {
  return `Usage pacing level ${ev.level.toUpperCase()}: subagent model set to ${decision.model} to stretch the plan quota.`;
}

// Auto mode (or an unknown mode): the call is denied once and Claude is asked to send it
// again with the cheaper model, so the re-issued call still goes through the classifier.
function reissueReason(decision, ev) {
  return `Usage pacing level ${ev.level.toUpperCase()}: this subagent should run on the cheaper model ${decision.model} to stretch the plan quota, `
    + 'and the model cannot be changed automatically in the current permission mode. The call was not started. '
    + `The same Agent call with the added field "model": "${decision.model}" and all other fields unchanged will start normally.`;
}

function capPhrase(cap, lang) {
  if (lang === 'en') {
    if (cap === null || cap === undefined) return 'without a parallel limit';
    return cap === 1 ? 'one at a time' : `at most ${cap} in parallel`;
  }
  if (cap === null || cap === undefined) return 'ohne eigenes Parallel-Limit';
  return cap === 1 ? 'einzeln' : `höchstens ${cap} parallel`;
}

// Notice for the user when the level changes. With strategy "both" the downgrade only acts
// from RED on, so falling back below RED means subagents run normally again.
function levelChangeMessage(ev, cfg) {
  const lang = cfg.language === 'en' ? 'en' : 'de';
  const L = LEVEL_LABEL[lang];
  const f = ev.windows.fiveHour;
  const s = ev.windows.sevenDay;
  const until = lang === 'en' ? 'by' : 'bis';
  const fiveTxt = f && f.status === 'ok' ? `5h ${pct(f.used)}${f.projected != null ? ` → ${pct(f.projected)} ${until} ${fmtTime(f.resetsAt)}` : ''}` : null;
  const weekLeads = s && (RANK[s.level] || 0) >= RANK.amber && s.projected != null;
  const weekTxt = s && s.status === 'ok' ? `7d ${pct(s.used)}${weekLeads ? ` → ${pct(s.projected)}` : ''}` : null;
  const detail = [fiveTxt, weekTxt].filter(Boolean).join(', ');
  const both = cfg.strategy === 'both';
  const amberCap = capPhrase(cfg.concurrency.amber, lang);
  const redCap = capPhrase(cfg.concurrency.red, lang);
  const action = lang === 'en' ? {
    green: 'Subagents run normally again.',
    amber: both ? 'Subagents run normally again; the throttle keeps pacing the work.' : `Routine subagents now run on smaller models, ${amberCap}.`,
    red: `Subagents now ${both ? 'also ' : ''}run on the smallest model, ${redCap}. Consider /model sonnet at the next task boundary.`,
    stop: 'New subagents are paused until the reset.',
  }[ev.level] : {
    green: 'Subagents laufen wieder normal.',
    amber: both ? 'Subagents laufen wieder normal; die Drossel bremst weiter.' : `Routine-Subagents laufen jetzt auf kleineren Modellen, ${amberCap}.`,
    red: `Subagents laufen jetzt ${both ? 'zusätzlich ' : ''}auf dem kleinsten Modell, ${redCap}. An der nächsten Task-Grenze /model sonnet erwägen.`,
    stop: 'Neue Subagents sind bis zum Reset pausiert.',
  }[ev.level];
  const head = lang === 'en' ? `quota-pacer: level ${L[ev.level]}` : `quota-pacer: Stufe ${L[ev.level]}`;
  return `${head}${detail ? ` (${detail})` : ''}. ${action || ''}`.trim();
}

function fmtSec(v) {
  return String(Math.round(v * 10) / 10);
}

function throttleOnMessage(w, cfg) {
  const lang = cfg.language === 'en' ? 'en' : 'de';
  const lead = w.lead || {};
  const label = WINDOW_LABEL[lang][lead.name] || WINDOW_LABEL[lang].fiveHour;
  const max = fmtSec(cfg.throttle.maxWaitSec);
  if (lang === 'en') {
    return `quota-pacer: throttle on – pauses of up to ${max} s before the next steps, because usage is ahead of schedule `
      + `(${label} ${pct(lead.used)} used, schedule ${pct(lead.allowed)}). Models stay unchanged.`;
  }
  return `quota-pacer: Drossel aktiv – Pausen bis ${max} s vor den nächsten Schritten, weil der Verbrauch dem Plan voraus ist `
    + `(${label} ${pct(lead.used)} genutzt, Plan ${pct(lead.allowed)}). Modelle bleiben unverändert.`;
}

function throttleOffMessage(w, cfg) {
  const lang = cfg.language === 'en' ? 'en' : 'de';
  const statuses = Object.values((w && w.windows) || {}).map((x) => x.status);
  let why = 'plan';
  if (!statuses.some((s) => s === 'on-schedule' || s === 'ahead')) why = statuses.includes('reset') ? 'reset' : 'nodata';
  const text = {
    de: { plan: 'der Verbrauch liegt wieder im Plan.', reset: 'das Kontingentfenster wurde zurückgesetzt.', nodata: 'keine aktuellen Kontingentdaten.' },
    en: { plan: 'usage is back on schedule.', reset: 'the quota window has been reset.', nodata: 'no current quota data.' },
  }[lang][why];
  return lang === 'en' ? `quota-pacer: throttle off – ${text}` : `quota-pacer: Drossel aus – ${text}`;
}

// e.g. "pacing ROT 5h 60%→120%@07:32 7d 41% Drossel 3s". The weekly projection is shown
// only when the week sets the level (GELB or worse); otherwise a ROT next to a low 5-h
// value would have no visible reason.
function statusSegment(ev, lang, throttleWaitSec = 0) {
  const L = LEVEL_LABEL[lang] || LEVEL_LABEL.de;
  const color = { unknown: '2', green: '32', amber: '33', red: '31', stop: '1;31' }[ev.level] || '0';
  const f = ev.windows.fiveHour;
  const s = ev.windows.sevenDay;
  const bits = [];
  if (f && f.status === 'ok') bits.push(`5h ${pct(f.used)}${f.projected != null ? `→${pct(f.projected)}@${fmtTime(f.resetsAt)}` : ''}`);
  if (s && s.status === 'ok') {
    const weekLeads = (RANK[s.level] || 0) >= RANK.amber && (RANK[s.level] || 0) >= (RANK[f && f.level] || 0);
    bits.push(`7d ${pct(s.used)}${weekLeads && s.projected != null ? `→${pct(s.projected)}` : ''}`);
  }
  if (throttleWaitSec > 0) bits.push(`${lang === 'en' ? 'throttle' : 'Drossel'} ${Math.max(1, Math.round(throttleWaitSec))}s`);
  const label = `\u001b[${color}m${L[ev.level]}\u001b[0m`;
  return bits.length ? `pacing ${label} ${bits.join(' ')}` : `pacing ${label}`;
}

// Shown instead of the level while config.json does not parse (all interventions off).
function configErrorSegment() {
  return 'pacing \u001b[1;31mconfig.json-Fehler\u001b[0m (Eingriffe aus)';
}

module.exports = {
  configErrorSegment,
  contextForClaude,
  denyReason,
  rewriteReason,
  reissueReason,
  levelChangeMessage,
  throttleOnMessage,
  throttleOffMessage,
  statusSegment,
  fmtTime,
  pct,
  LEVEL_LABEL,
  WINDOW_LABEL,
};
