#!/usr/bin/env node
'use strict';
// quota-pacer command line: install | uninstall | status [--json] | doctor | help
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { VERSION, pacerHome, claudeDir, nowMs } = require('./lib/util');
const { loadConfig, configFile } = require('./lib/config');
const { evaluate, downgradeActive } = require('./lib/policy');
const { loadSamples } = require('./lib/samples');
const { computeWait } = require('./lib/throttle');
const { fmtTime, pct, LEVEL_LABEL, WINDOW_LABEL } = require('./lib/messages');
const inst = require('./lib/install');
const { managedHooksOnly, settingsSources, rulesFrom, unreadableSources } =require('./lib/permissions');

// 2.1.251: documented order of the subagent model sources. Hooks in exec form ("args"),
// PostModelSwitch and statusLine.refreshInterval are only proven on 2.1.289 (1.0.0) and
// 2.1.291 (1.1.0), so versions in between are reported as untested, not as fine.
const MIN_CLAUDE = [2, 1, 251];
const TESTED_CLAUDE = [2, 1, 289];

// Third-party providers (static list from the 2.1.291 binary): no rate_limits, ever.
const PROVIDER_ENV = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE',
];
const envOn = (v) => !!v && v !== '0' && v.toLowerCase() !== 'false';

const STRATEGY_TEXT = {
  throttle: 'Drossel – Pausen zwischen den Schritten, Modelle bleiben unverändert',
  downgrade: 'Modellwechsel – neue Subagents auf günstigeren Modellen, Parallel-Limit',
  both: 'Drossel, ab ROT zusätzlich Modellwechsel und Parallel-Limit',
};

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}

function cmdInstall() {
  const r = inst.install({ sourceScriptsDir: __dirname });
  if (!r.ok) { console.log(`FEHLER: ${r.error}`); return 1; }
  console.log('quota-pacer: Sensor installiert.');
  console.log(`  statusLine -> ${r.command}`);
  console.log(`  Datei: ${r.settingsFile}`);
  if (r.backup) console.log(`  Backup: ${r.backup}`);
  if (r.chained) console.log(`  Bisherige Statusline wird weiter angezeigt: ${r.chained.command}`);
  console.log('  Die Anzeige erscheint nach der nächsten Antwort von Claude.');
  return 0;
}

function cmdUninstall() {
  const r = inst.uninstall();
  if (!r.ok) { console.log(`FEHLER: ${r.error}`); return 1; }
  if (r.note) { console.log(`quota-pacer: ${r.note}`); return 0; }
  console.log('quota-pacer: Sensor entfernt.');
  if (r.restored && r.fromBackup) {
    console.log(`  Vorherige Statusline aus dem Backup wiederhergestellt: ${r.restored.command}`);
    console.log(`  (aus ${r.fromBackup})`);
  } else if (r.restored) {
    console.log(`  Vorherige Statusline wiederhergestellt: ${r.restored.command}`);
  } else {
    console.log('  Keine vorherige Statusline bekannt – statusLine entfernt.');
  }
  if (r.backup) console.log(`  Backup: ${r.backup}`);
  console.log('  Plugin selbst entfernen: /plugin uninstall quota-pacer, dann /plugin marketplace remove ari-auto-pacing');
  return 0;
}

function fmtSec(v) {
  return String(Math.round(v * 10) / 10);
}

function describeWindow(name, w, cfg) {
  const label = name === 'fiveHour' ? '5-Stunden' : 'Woche';
  if (!w) return `${label}: –`;
  if (w.status === 'nodata') return `${label}: keine Daten`;
  if (w.status === 'stale') return `${label}: Daten veraltet (${Math.round(w.ageMin)} min alt)`;
  if (w.status === 'reset') return `${label}: Fenster zurückgesetzt`;
  const L = LEVEL_LABEL[cfg.language] || LEVEL_LABEL.de;
  let proj;
  if (w.projected != null) proj = `, Prognose ${pct(w.projected)} bei Reset ${fmtTime(w.resetsAt)}`;
  else if (w.rateSource === 'warmup') proj = `, noch keine Prognose (Anlaufphase: ${Math.floor(w.spanMin)} von ${cfg.minForecastMinutes} min Messdaten)`;
  else proj = ', keine Prognose (zu wenig Daten)';
  const rate = w.rate != null ? `, Rate ${w.rate.toFixed(3)} %-Pkt/min (${w.rateSource})` : '';
  const ttr = w.minutesToReserve != null && Number.isFinite(w.minutesToReserve) ? `, Reserve in ${Math.round(w.minutesToReserve)} min` : '';
  return `${label}: ${pct(w.used)} genutzt${proj}${rate}${ttr} -> ${L[w.level]}`;
}

function describeThrottle(w, cfg) {
  if (cfg._fileError) return 'aus (config.json fehlerhaft)';
  if (!cfg.enabled) return 'aus (enabled: false)';
  if (cfg.strategy === 'downgrade') return 'aus (Strategie downgrade)';
  const where = (x) => `${WINDOW_LABEL.de[x.name] || x.name} ${pct(x.used)} genutzt, Plan ${pct(x.allowed)}`;
  if (w.waitSec > 0) {
    return `aktiv – nächste Pause ${fmtSec(w.waitSec)} s (${where(w.lead)}; höchstens ${fmtSec(cfg.throttle.maxWaitSec)} s je Pause)`;
  }
  const planned = Object.values(w.windows).filter((x) => x.status === 'on-schedule' || x.status === 'ahead');
  if (!planned.length) return 'keine Pause – keine aktuellen Kontingentdaten';
  return `keine Pause – im Plan (${planned.map(where).join('; ')})`;
}

function describeCap(level, cfg) {
  if (!downgradeActive(level, cfg.strategy)) {
    return cfg.strategy === 'both' ? 'keins unter ROT (Strategie both)' : 'keins (Strategie throttle)';
  }
  const cap = cfg.concurrency[level];
  return cap === null || cap === undefined ? 'keins' : String(cap);
}

function cmdStatus(asJson) {
  const cfg = loadConfig();
  const now = nowMs();
  const samples = loadSamples();
  const ev = evaluate(now, cfg, { persist: false, samples });
  const throttle = computeWait(samples, now, cfg);
  if (cfg.strategy === 'downgrade' || !cfg.enabled) throttle.waitSec = 0; // the throttle hook never pauses then
  if (asJson) {
    console.log(JSON.stringify({ version: VERSION, strategy: cfg.strategy, ...ev, throttle, configErrors: cfg._errors, configFileError: cfg._fileError }, null, 2));
    return 0;
  }
  const L = LEVEL_LABEL[cfg.language] || LEVEL_LABEL.de;
  console.log(`quota-pacer ${VERSION} – Stufe: ${L[ev.level]}`);
  console.log(`  Strategie: ${cfg.strategy} (${STRATEGY_TEXT[cfg.strategy]})`);
  console.log(`  ${describeWindow('fiveHour', ev.windows.fiveHour, cfg)}`);
  console.log(`  ${describeWindow('sevenDay', ev.windows.sevenDay, cfg)}`);
  console.log(`  Drossel: ${describeThrottle(throttle, cfg)}`);
  console.log(`  Parallel-Limit auf dieser Stufe: ${describeCap(ev.level, cfg)}`);
  if (cfg._fileError) console.log(`  ${cfg._fileError} – alle Eingriffe aus, bis die Datei wieder gültig ist (${configFile()}). Der Sensor zeichnet weiter auf.`);
  else if (!cfg.enabled) console.log('  Eingriffe abgeschaltet (enabled: false) – der Sensor zeichnet weiter auf.');
  if (cfg._errors.length) console.log(`  config.json: ungültige Felder auf Standard gesetzt: ${cfg._errors.join(', ')}`);
  return 0;
}

function check(results, status, name, detail) {
  results.push({ status, name, detail });
}

function claudeVersion() {
  try {
    // Windows needs a shell for claude.cmd (npm install). cmd.exe looks in the current
    // directory first, which is the project here; NoDefaultCurrentDirectoryInExePath
    // turns that off, so only PATH decides which claude runs.
    const win = process.platform === 'win32';
    const env = win ? { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } : process.env;
    const r = win
      ? spawnSync('claude --version', { encoding: 'utf8', timeout: 15000, shell: true, windowsHide: true, env })
      : spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15000, env });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout || ''}`);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch { return null; }
}

function cmdDoctor() {
  const results = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check(results, nodeMajor >= 18 ? 'OK' : 'FAIL', 'Node.js', `v${process.versions.node} (benötigt >= 18)`);

  const cv = claudeVersion();
  const tested = TESTED_CLAUDE.join('.');
  if (!cv) check(results, 'WARN', 'Claude Code', `\`claude --version\` nicht ausführbar – Version bitte manuell prüfen (getestet ab ${tested})`);
  else if (cmpVersion(cv, MIN_CLAUDE) < 0) check(results, 'FAIL', 'Claude Code', `${cv.join('.')} (benötigt >= ${MIN_CLAUDE.join('.')}, getestet ab ${tested})`);
  else if (cmpVersion(cv, TESTED_CLAUDE) < 0) check(results, 'WARN', 'Claude Code', `${cv.join('.')} ungetestet (getestet: 2.1.289 und 2.1.291) – nach einem Update erneut prüfen`);
  else check(results, 'OK', 'Claude Code', `${cv.join('.')} (getestet ab ${tested})`);

  try {
    fs.mkdirSync(pacerHome(), { recursive: true });
    fs.accessSync(pacerHome(), fs.constants.W_OK);
    check(results, 'OK', 'Datenverzeichnis', pacerHome());
  } catch (e) {
    check(results, 'FAIL', 'Datenverzeichnis', `${pacerHome()} nicht beschreibbar: ${e.message}`);
  }

  const sRead = inst.readSettingsStrict();
  if (!sRead.ok) check(results, 'FAIL', 'settings.json', sRead.error);
  else if (inst.statuslineInstalled()) check(results, 'OK', 'Sensor (statusLine)', inst.statuslineCommand());
  else check(results, 'FAIL', 'Sensor (statusLine)', 'nicht installiert – /quota-pacer:setup ausführen');

  const v = inst.installedVersion();
  check(results, v === VERSION ? 'OK' : 'WARN', 'Sensor-Version', v ? `${v} (Plugin ${VERSION})` : `fehlt in ${inst.binDir()}`);

  const cfg = loadConfig();
  const samples = loadSamples();
  if (!samples.length) {
    check(results, 'WARN', 'Kontingentdaten', 'noch keine – erst nach der ersten Antwort einer Session; API-Key-, Bedrock- und Vertex-Logins liefern nie welche');
    // The Bash tool inherits Claude Code's environment, so the login type is visible here.
    const provider = PROVIDER_ENV.find((k) => envOn(process.env[k]));
    if (provider) check(results, 'FAIL', 'Login', `${provider} ist gesetzt – dieser Anbieter liefert keine Kontingentdaten, das Plugin greift nie ein`);
    else if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
      check(results, 'WARN', 'Login', 'ANTHROPIC_API_KEY oder ANTHROPIC_AUTH_TOKEN ist gesetzt – meldet sich Claude Code damit an, gibt es nie Kontingentdaten (/status zeigt den Login)');
    }
  } else {
    const age = (nowMs() - samples[samples.length - 1].t) / 60000;
    check(results, age <= cfg.maxSampleAgeMinutes ? 'OK' : 'WARN', 'Kontingentdaten', `${samples.length} Messpunkte, letzter vor ${Math.round(age)} min`);
  }

  // Same predicate as the hooks. Only a problem when the plugin changes models at all.
  const force = process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
  if (force && force !== '0' && force.toLowerCase() !== 'false') {
    if (cfg.strategy === 'throttle') check(results, 'INFO', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'gesetzt – ohne Wirkung bei Strategie throttle (Modelle bleiben unverändert)');
    else check(results, 'FAIL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'gesetzt – Modellwechsel pro Aufruf werden ignoriert');
  }
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) check(results, 'INFO', 'CLAUDE_CODE_SUBAGENT_MODEL', process.env.CLAUDE_CODE_SUBAGENT_MODEL);

  if (managedHooksOnly()) check(results, 'FAIL', 'Managed Settings', 'allowManagedHooksOnly aktiv – Plugin-Hooks und Statusline blockiert');

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Same sources and the same "starts with Agent/Task" test as the pre-agent hook.
  const sources = settingsSources(projectDir);
  const broken = unreadableSources(sources);
  if (broken.length) check(results, 'WARN', 'Settings', `nicht lesbar: ${broken.join(', ')} – solange lässt das Plugin Agent-Aufrufe unverändert (die Drossel läuft weiter)`);
  const agentRules = rulesFrom(sources)
    .filter((r) => /^(Agent|Task)\b/.test(r.rule))
    .map((r) => `${r.kind}: ${r.rule}`);
  if (agentRules.length) check(results, 'INFO', 'Agent-Regeln', `${agentRules.join('; ')} – betroffene Aufrufe lässt das Plugin unverändert`);

  if (cfg._fileError) check(results, 'FAIL', 'config.json', `${cfg._fileError} – alle Eingriffe aus, bis die Datei wieder gültig ist (${configFile()})`);
  else if (cfg._errors.length) check(results, 'WARN', 'config.json', `ungültig, Standard genutzt: ${cfg._errors.join(', ')} (${configFile()})`);
  else check(results, 'OK', 'Konfiguration', fs.existsSync(configFile()) ? configFile() : 'Standardwerte');

  for (const r of results) console.log(`[${r.status.padEnd(4)}] ${r.name}: ${r.detail}`);
  const fails = results.filter((r) => r.status === 'FAIL').length;
  const loginWarn = results.some((r) => r.name === 'Login' && r.status === 'WARN');
  if (fails) console.log(`\n${fails} Problem(e) gefunden.`);
  else if (loginWarn) console.log('\nInstallation bereit, aber vermutlich ohne Kontingentdaten – Login prüfen (siehe [WARN] Login).');
  else console.log('\nAlles bereit.');
  return fails ? 1 : 0;
}

function help() {
  console.log(`quota-pacer ${VERSION}
  node pacer.js install     Sensor (statusLine) in ${path.join(claudeDir(), 'settings.json')} eintragen
  node pacer.js uninstall   Sensor entfernen, vorherige Statusline wiederherstellen
  node pacer.js status      Stufe, Prognose, Strategie und Drossel (--json für Rohdaten)
  node pacer.js doctor      Installation prüfen
In Claude Code: /quota-pacer:setup (uninstall als Argument macht es rückgängig), /quota-pacer:status`);
  return 0;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'install': return cmdInstall();
    case 'uninstall': return cmdUninstall();
    case 'status': return cmdStatus(rest.includes('--json'));
    case 'doctor': return cmdDoctor();
    default: return help();
  }
}

try {
  process.exitCode = main();
} catch (e) {
  console.log(`FEHLER: ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
}
