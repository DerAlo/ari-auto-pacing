# Changelog

## 1.1.1 – 2026-10-07

Sicherheits- und Windows-Korrekturen nach einem Review. `npm test` läuft jetzt auch unter Windows 11 (Node v24.13.0, Claude Code 2.1.293); die E2E-, TUI- und Simulationsläufe wurden für 1.1.1 nicht wiederholt.

### Behoben

- **Unlesbare Settings zählen als Sperre.** Eine vorhandene Settings-Datei, die sich nicht als JSON-Objekt lesen lässt, wurde bisher übergangen; eine `deny`- oder `ask`-Regel für Agent darin griff dann nicht. Jetzt lässt das Plugin Agent-Aufrufe unverändert, solange eine Quelle unlesbar ist (Log: `settings-unreadable`), und `doctor` nennt die Datei. Die Drossel ist davon nicht betroffen.
- **UTF-8-BOM** in `settings.json`, `config.json` und den State-Dateien wird akzeptiert (PowerShell 5.1 und manche Windows-Editoren schreiben ihn).
- **Session-Namen** können nicht mehr auf das Elternverzeichnis zeigen: führende Punkte werden ersetzt. Eine `session_id` `..` hätte bei SessionEnd das ganze Datenverzeichnis gelöscht.
- **Modellwechsel nur bei gesichertem Hauptmodell.** Stammt das Hauptmodell nur aus der letzten Assistant-Zeile (kann nach `/model` veraltet sein), schreibt das Plugin höchstens auf `haiku` um; ein Ziel darüber könnte sonst ein Upgrade sein.
- **Windows: hängende verkettete Statusline** wird nach 3 s samt ihren Kindprozessen beendet (`taskkill /T`). Vorher blockierte sie die Statuszeile für ihre ganze Laufzeit.
- **Windows: Programmsuche.** Die verkettete Statusline und `claude --version` in `doctor` laufen mit `NoDefaultCurrentDirectoryInExePath=1`, der PowerShell-Fallback mit absolutem Pfad. So wird kein Programm aus dem Projektverzeichnis gestartet.
- **Backups** von `settings.json`: nur die 10 neuesten bleiben, dazu das neueste ältere mit fremder Statusline (daraus stellt `uninstall` wieder her).
- **Größenlimits**: Hook-Eingaben und JSON-Dateien über 20 MB werden nicht gelesen.
- `install` lehnt einen Sensor-Pfad mit `"`, `$` oder Backtick ab.

## 1.1.0 – 2026-10-06

Neu aufgebaut. Die Korrekturen von 1.0.0 wurden nach der 1.0.0-Doku wiederhergestellt. Getestet gegen Claude Code 2.1.291 auf macOS arm64, Node v22.23.1.

### Neu

- **Drossel als Standard** (`strategy: "throttle"`). Ein PreToolUse-Hook auf alle Tools pausiert vor dem nächsten Schritt, solange der Verbrauch einer Soll-Kurve voraus ist. Modelle, Parallelität und Prompts bleiben unverändert. Wirkt auch in Subagents.
- Einstellung `strategy`: `throttle` (Standard), `downgrade` (Verhalten 1.0.0), `both` (Drossel, ab ROT zusätzlich Modellwechsel und Parallel-Limit).
- Einstellungen `throttle.bufferPct` (10), `throttle.earlySlackPct` (15), `throttle.releaseFraction` (0,1), `throttle.maxWaitSec` (90, erlaubt 0–240), `throttle.minWaitSec` (2), `throttle.weeklyDeadbandPct` (1), `throttle.weeklyRampPct` (3), jeweils einzeln geprüft.
- Statuszeile zeigt `Drossel Ns`, solange eine Pause gilt, und die Wochenprognose, sobald die Woche die Stufe bestimmt. Hinweise „Drossel aktiv …“ und „Drossel aus …“ einmal pro Wechsel.
- `pacer.js status` zeigt Strategie und Drossel-Zustand, auch als `--json`.
- Eine Pause pro API-Antwort: Alle Tool-Aufrufe einer Antwort teilen sich ein Pausenende, damit der Prompt-Cache (5 min) warm bleibt. Parallele Aufrufe warten alle bis zu diesem Ende.
- Wochenfenster, für Drossel und Stufen-Prognose: Fortschritt = max(Uhrzeit-Anteil, Arbeitszeit-Anteil). Für die Drossel zusätzlich Totband (1 Punkt) und Rampe (volle Pause erst 3 Punkte darüber).
- Prüfung von `availableModels` und `deniedModels` vor einem Modellwechsel.
- Regeln aus allen Settings-Quellen: Managed-Settings-Datei, `managed-settings.d/`, `remote-settings.json`, macOS-MDM-Profile.
- `doctor` prüft den Login (API-Key: Warnung, Bedrock, Vertex und andere Anbieter: Fehler) und endet mit Exit-Code 1, wenn es `[FAIL]` gibt.
- Tests: Drossel, Strategien, Härtung, Review-Korrekturen (insgesamt 136 Tests); 30 statt 18 E2E-Szenarien; 4 interaktive Läufe, darunter der volle Sensorpfad mit OAuth-Headern; Installationspfad mit Skills (`npm run test:skills`); Simulationen `npm run sim`, `sim:throttle` (5 h) und `sim:throttle-week` (Woche, ganzzahlige Messwerte).

### Geändert

- Marketplace heißt `ari-auto-pacing` (Installation: `quota-pacer@ari-auto-pacing`).
- `hooks/hooks.json`: 8 Hook-Einträge in exec form; Drossel-Hook mit Timeout 300 s.
- Bei `throttle` geben der Agent-Hook und der Prompt-Hook nichts aus: kein Modellwechsel, kein Parallel-Limit, kein Kontext an Claude, keine Stufen-Hinweise.
- Bei `both` pausieren Agent-Aufrufe ab ROT nicht; die entscheidet die Downgrade-Policy.
- Die vorherige Statusline speichert das Setup in `chain.json`, nicht mehr in `config.json`. Ein `chain` aus 1.0.0 in `config.json` wird weiter gelesen und bei der Deinstallation entfernt.
- `config.json`, die kein gültiges JSON ist, schaltet alle Eingriffe ab und wird überall gemeldet (Statuszeile, `SessionStart`, `status`, `doctor`). 1.0.0 nahm stillschweigend die Standardwerte.
- Die Erinnerung zu `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` erscheint nur, wenn das Plugin Modelle wechselt; `doctor` meldet sie bei `throttle` nur als Info, und `false` gilt als nicht gesetzt.
- `doctor`: Versionen unter 2.1.289 (ungetestet) als Warnung, unter 2.1.251 als Fehler.
- E2E: Umgebung aus einer Positivliste, `CLAUDE_CONFIG_DIR` im temporären `HOME`, Proxy, der alles ablehnt, `sandbox-exec` unter macOS; Szenarien setzen `--permission-mode` explizit, weil Auto-Mode in 2.1.291 auch in `-p` Standard ist.

### Behoben gegenüber 1.0.0

Verhalten, das die 1.0.0-Doku so beschreibt:

- Die vorherige Statusline stand in `config.json` (Feld `chain`). Wer die Datei durch ein Beispiel aus der Doku ersetzte, verlor sie; die Deinstallation löschte sie dann ganz. Jetzt in `chain.json`; ohne bekannte Statusline nimmt die Deinstallation die aus dem neuesten Backup vor der Installation.
- Stufen-Prognose der Woche nur über Arbeitszeit: Wer abends oder am Wochenende arbeitet, bekam überhöhte Prognosen (echte Daten: 167 % statt 109 %).
- `Explore` galt immer als Hauptmodell; mit Fable als Hauptmodell läuft es auf Opus.

### Beim Neuaufbau und im Review gefunden, vor der Auslieferung behoben

Fehler in neuen Teilen von 1.1.0 (vor allem der Drossel) waren nie in einer ausgelieferten Version. Bei den Fehlern in bestehenden Teilen ist nicht überliefert, ob die ausgelieferte 1.0.0 sie auch hatte.

Drossel und Wochenfenster:

- Wochen-Drossel nach reiner Arbeitszeit pausierte bei Arbeit abends und am Wochenende jeden Schritt das Maximum (gefunden mit echten Daten: 39 % am Dienstagmorgen).
- Wochen-Drossel ohne Totband: Schon 0,1 Punkt Vorsprung bei ganzzahligen Messwerten gab 90 s je Schritt, ein Punkt bis zu etwa 140 min maximale Pausen (echte Daten). Jetzt Totband und Rampe; mit echten Daten 20 s statt 90 s.
- Parallele Tool-Aufrufe einer Antwort: Nur der erste wartete (gefunden im E2E).
- `minWaitSec` wurde nach der Kappung geprüft; mit `maxWaitSec` < `minWaitSec` gab es nie eine Pause.
- Gerundete Pause konnte `maxWaitSec` überschreiten.
- Reserve + Puffer nahe 100 konnte Dauerpausen erzeugen.
- Drossel in Subagents fand die Nachrichten-ID nicht (Haupt- statt Subagent-Transkript).
- `status` zeigte die Drossel bei `enabled: false` als aktiv.
- Hook-Timeout der Drossel (150 s im Entwurf) lag unter der erlaubten Höchstpause von 240 s; jetzt 300 s.

Bestehende Teile:

- `config.json` mit Syntaxfehler galt stillschweigend als leer, und das Setup überschrieb sie dann mit nur einem Feld.
- `doctor` endete immer mit Exit-Code 0, obwohl der Skill Exit-Code 1 bei Befunden beschreibt.
- Hinweis zum Stufenwechsel ignorierte `language: "en"`.
- Registry-Einträge nicht atomar geschrieben; ein gleichzeitiger Leser konnte sie löschen.
- Re-Issue: endlose Ablehnung, wenn der Schutz-Hash nicht gespeichert werden konnte; ein Aufruf mit ergänztem Standard-Typ galt als neuer Aufruf.
- Ein `resets_at` weit in der Zukunft oder fehlendes `resets_at` konnten falsche Werte erzeugen.
- Bei Stufe „unbekannt“ konnte ein GRÜN-Limit greifen.
- STOPP-Begründung nannte immer das 5-h-Fenster.
- Transkriptdatei, die erst nach dem Hook-Start entsteht, wurde nicht gelesen.
- Setup änderte Dateirechte von `settings.json` und ersetzte Symlinks; Backups jetzt 0600.
- Verkettung einer Statusline, die selbst eine Kopie des Sensors ist, rief sich endlos auf.

### Wiederhergestellt aus 1.0.0

- Hauptmodell aus der Transkript-Zeile des Aufrufs (bis 1,5 s Wartezeit), dann Session-Zustand, dann letzte Assistant-Zeile; nie Settings oder `ANTHROPIC_MODEL`.
- Re-Issue im Auto-Mode und in unbekannten Modi statt `allow`, mit Schleifenschutz (10 min).
- Genau eine Log-Zeile pro Agent-Entscheidung.
- Modellauflösung vor dem Session-Lock.
- Anlaufphase der Prognose (`minForecastMinutes`, 15 min).

### Tests

Testlauf mit dem ausgelieferten Code, 10 Runden je Ebene: 1360/1360 Unit- und Vertragstests (136 × 10), 300/300 E2E-Läufe mit 3680/3680 Prüfungen (30 × 10), 40/40 interaktive Läufe mit 1040/1040 Prüfungen (4 × 10), Installationspfad mit Skills 90/90 Prüfungen (3 Läufe), `claude plugin validate --strict` bestanden, frische Installation 10/10 Schritte mit Exit-Code 0, Coverage Zeilen/Branches/Funktionen 97,58 % / 81,36 % / 91,05 %, echte Kontingentdaten (17 Zeilen) nachgespielt.

## 1.0.0 – 2026-10-05

Erste Version. Getestet gegen Claude Code 2.1.289 unter Linux x86_64, Node 22.22.2.

### Neu

- Statusline-Sensor für `rate_limits` mit Verkettung einer vorhandenen Statusline; Setup per `/quota-pacer:setup` mit Backup der `settings.json`.
- Prognose je Fenster: 5 h über die Burn-Rate der letzten 30 min, Woche über Arbeitszeit (Mo–Fr 7–19 Uhr); monotone Hüllkurve gegen veraltete Werte anderer Sessions; Messpunkte älter als 20 min zählen nicht.
- Stufen GRÜN, GELB, ROT, STOPP mit Hysterese (8 Punkte, Zeitgrenze × 1,5).
- PreToolUse-Hook auf `Agent|Task`: Ab GELB laufen neue Subagents auf Haiku oder Sonnet, nie teurer als ohne Plugin; Parallel-Limit 3 (GELB), 1 (ROT), 0 (STOPP) mit Reservierungen unter Session-Lock.
- Im Auto-Mode: einmal ablehnen mit Bitte, den Aufruf mit `"model"` neu abzusetzen, statt `allow` (das den Klassifikator übersprungen hätte).
- Plugin hält sich aus Agent-Aufrufen mit `deny`- oder `ask`-Regel heraus.
- UserPromptSubmit: ein Satz Kontext für Claude ab GELB; Hinweis bei Stufenwechsel.
- `pacer.js`: `install`, `uninstall`, `status`, `doctor`; Skills `/quota-pacer:setup` und `/quota-pacer:status`.
- Audit-Log `decisions.jsonl`, rotiert bei 1 MB.

### Behoben vor der Auslieferung

- Hochstufung bei `--model haiku` (Hauptmodell jetzt aus dem Transkript).
- Klassifikator im Auto-Mode übersprungen (jetzt Re-Issue).
- Doppelte Log-Zeilen beim Re-Issue.
- Parallele Spawns warteten auf den Session-Lock.

### Tests (Original)

590/590 Unit- und Vertragstests (59 × 10), 180/180 E2E-Läufe (18 × 10), 60/60 interaktive Prüfungen (6 × 10), `claude plugin validate` bestanden, Coverage Zeilen/Branches 97,4 % / 77,6 %.
