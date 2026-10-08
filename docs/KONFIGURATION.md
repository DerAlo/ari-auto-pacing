# Konfiguration

Ohne Konfiguration gelten die Standardwerte. Eigene Werte stehen in `~/.claude/quota-pacer/config.json` (mit `CLAUDE_CONFIG_DIR`: `$CLAUDE_CONFIG_DIR/quota-pacer/config.json`). Dort genügen die Felder, die vom Standard abweichen; verschachtelte Objekte werden mit den Standardwerten zusammengeführt. Änderungen wirken ab dem nächsten Hook-Aufruf, ohne Neustart.

Ein ungültiger Wert fällt einzeln auf seinen Standard zurück, nicht die ganze Datei. `SessionStart` meldet das höchstens einmal pro Tag, `/quota-pacer:status` zeigt es immer.

Ist die Datei kein gültiges JSON (z. B. ein Komma nach dem letzten Feld), schaltet das Plugin alle Eingriffe ab, bis die Datei wieder gültig ist. Der Sensor misst weiter. Die Statuszeile zeigt dann `pacing config.json-Fehler (Eingriffe aus)`, `SessionStart` meldet es bei jedem Start, `doctor` meldet `[FAIL] config.json`. Setup und Deinstallation schreiben eine solche Datei nie um.

Die Beispiele unten zeigen nur die Felder. Sie gehören in eine vorhandene Datei, ergänzt um die eigenen Felder.

## Felder

### Allgemein

| Feld | Standard | Erlaubt | Bedeutung |
| --- | --- | --- | --- |
| `enabled` | `true` | `true`, `false` | `false` schaltet alle Eingriffe ab, auch die Drossel. Der Sensor zeichnet weiter auf. |
| `strategy` | `"throttle"` | `"throttle"`, `"downgrade"`, `"both"` | `throttle`: nur Pausen. `downgrade`: Modellwechsel und Parallel-Limit ab GELB (Verhalten 1.0.0). `both`: Pausen, ab ROT zusätzlich Modellwechsel und Parallel-Limit. |
| `language` | `"de"` | `"de"`, `"en"` | Sprache der Hinweise im Chat und der Statuszeile. Die Ausgabe von `/quota-pacer:status` ist bis auf die Stufennamen immer Deutsch. Texte an Claude sind immer Englisch. |
| `notify` | `true` | `true`, `false` | Hinweise im Chat: Drossel an/aus, Stufenwechsel |
| `statusSegment` | `true` | `true`, `false` | Segment in der Statuszeile anzeigen. Der Sensor misst auch ohne Segment. |

Die vorherige Statusline speichert das Setup in `chain.json` im selben Ordner, nicht in `config.json`. Ein Feld `chain` in `config.json` (so hat es 1.0.0 gespeichert) wird noch gelesen und bei der Deinstallation entfernt.

### Drossel (`throttle.*`)

Wirkt nur bei `strategy` `throttle` oder `both`. Formel: [ARCHITEKTUR.md](ARCHITEKTUR.md#drossel).

| Feld | Standard | Erlaubt | Bedeutung |
| --- | --- | --- | --- |
| `throttle.bufferPct` | `10` | 0–50 | Puffer in Prozentpunkten. Der Plan zielt auf 100 − Reserve − Puffer und gibt den Puffer erst am Ende frei. Mehr Puffer bremst früher. |
| `throttle.earlySlackPct` | `15` | 0–100 | Anfangsspielraum: So viel Prozent sind zu Fensterbeginn erlaubt, ohne dass gebremst wird. |
| `throttle.releaseFraction` | `0.1` | 0–1 | Anteil am Fensterende, in dem der Puffer schrittweise freigegeben wird. `0`: Freigabe erst beim Reset. |
| `throttle.maxWaitSec` | `90` | 0–240 | Längste Pause pro Schritt in Sekunden. Muss deutlich unter der Cache-Laufzeit von 5 min bleiben. `0` schaltet die Pausen ab. |
| `throttle.minWaitSec` | `2` | 0–60 | Überschüsse, die der Plan in weniger als so vielen Sekunden aufholt, lösen keine Pause aus. |
| `throttle.weeklyDeadbandPct` | `1` | 0–10 | Nur Wochenfenster: Ein Vorsprung bis zu so vielen Prozentpunkten gilt als im Plan. Die Messwerte kommen oft in ganzen Prozent; ohne Totband gab schon 0,1 Punkt Vorsprung die volle Pause. |
| `throttle.weeklyRampPct` | `3` | 0–50 | Nur Wochenfenster: Über dem Totband wächst die Pause mit dem Vorsprung und erreicht `maxWaitSec` erst bei so vielen Punkten darüber (Standard: ab 4 Punkten Vorsprung). `0`: sofort volle Pause. |

Zusatzregel: Ergibt 100 − Reserve − `bufferPct` in einem Fenster weniger als 25, fällt `bufferPct` auf den Standard zurück. Sonst läge der Plan fast bei 0, und jeder Schritt würde das ganze Fenster lang maximal warten.

### Fenster und Stufen (`windows.*`)

| Feld | Standard | Erlaubt | Bedeutung |
| --- | --- | --- | --- |
| `windows.fiveHour.reservePct` | `5` | 0–50 | Reserve des 5-h-Fensters. Bei 100 − Reserve gilt STOPP; der Plan der Drossel endet dort. |
| `windows.fiveHour.amber` | `{ "usedPct": 70, "projectedPct": 90 }` | usedPct 0–100, projectedPct 0–1000 | GELB ab dieser Nutzung oder Prognose |
| `windows.fiveHour.red` | `{ "usedPct": 85, "minutesToReserve": 90 }` | usedPct 0–100, minutesToReserve `null` oder ≥ 0 | ROT ab dieser Nutzung, oder wenn die Prognose die Reserve reißt und die Reserve in höchstens so vielen Minuten erreicht ist |
| `windows.sevenDay.reservePct` | `3` | 0–50 | Reserve des Wochenfensters |
| `windows.sevenDay.amber` | `{ "usedPct": 80, "projectedPct": 90 }` | wie oben | GELB im Wochenfenster |
| `windows.sevenDay.red` | `{ "usedPct": 92, "minutesToReserve": null }` | wie oben | ROT im Wochenfenster; `null`: die Prognose allein genügt |
| `hysteresisPct` | `8` | 0–50 | So viele Punkte muss die Prognose unter die Schwelle fallen, bevor die Stufe sinkt |

`amber` und `red` werden als Ganzes geprüft: Ist ein Teilwert ungültig, fällt das ganze Objekt auf den Standard.

### Prognose

| Feld | Standard | Erlaubt | Bedeutung |
| --- | --- | --- | --- |
| `lookbackMinutes` | `30` | 5–300 | Zeitraum für die aktuelle Burn-Rate im 5-h-Fenster |
| `minForecastMinutes` | `15` | 0–300 | Erst wenn die Messpunkte im Fenster so lange umspannen, zählt die Prognose für die Stufe. Vorher gelten nur die Nutzungsschwellen. `0` schaltet die Anlaufphase ab. |
| `maxSampleAgeMinutes` | `20` | 1–1440 | Ältere Messpunkte gelten als veraltet. Dann gibt es keine Stufe, keine Pause, keinen Eingriff. |
| `activeHours` | `{ "days": [1,2,3,4,5], "start": 7, "end": 19 }` | days 0–6 (0 = Sonntag), start/end 0–24, end > start | Arbeitszeit in lokaler Zeit. Daraus folgt der Arbeitszeit-Anteil der Woche. Prognose und Drossel nehmen jeweils den größeren von Arbeitszeit- und Uhrzeit-Anteil. Halbe Stunden als Dezimalzahl (`7.5` = 7:30). |

### Modellwechsel und Parallel-Limit

Wirkt nur bei `strategy` `downgrade` (ab GELB) oder `both` (ab ROT).

| Feld | Standard | Erlaubt | Bedeutung |
| --- | --- | --- | --- |
| `concurrency` | `{ "green": null, "amber": 3, "red": 1, "stop": 0 }` | ganze Zahl 0–100 oder `null` | Höchstzahl gleichzeitiger Subagents je Stufe (laufende plus gerade zugelassene); `null`: kein eigenes Limit |
| `models.amber` | `{ "routine": "haiku", "default": "sonnet", "protected": null }` | `"haiku"`, `"sonnet"`, `"opus"`, `null` | Zielmodell je Agent-Klasse in GELB; `null`: unverändert |
| `models.red` | `{ "routine": "haiku", "default": "haiku", "protected": "sonnet" }` | wie oben | Zielmodell je Agent-Klasse in ROT |
| `routineAgents` | `["Explore", "claude-code-guide", "statusline-setup"]` | Liste von Texten | Agent-Typen der Klasse „routine“ |
| `protectedAgents` | `["Plan"]` | Liste von Texten | Agent-Typen der Klasse „protected“ |

`concurrency`, `models` und `activeHours` werden als Ganzes geprüft: Ein ungültiger Teilwert setzt das ganze Objekt auf den Standard.

Das Plugin setzt ein Zielmodell nur, wenn es günstiger ist als das Modell, auf dem der Subagent sonst liefe. Bei `both` gelten `concurrency.amber` und `models.amber` nie, weil der Modellwechsel dort erst ab ROT handelt.

## Was das Plugin aus den Claude-Code-Einstellungen liest

Diese Werte stehen nicht in `config.json`, sondern in den normalen Settings von Claude Code. Das Plugin liest sie nur.

| Einstellung | Wirkung auf quota-pacer |
| --- | --- |
| `permissions.deny` / `permissions.ask` mit `Agent…` oder `Task…` | Das Plugin lässt betroffene Agent-Aufrufe unverändert (Log `skip`). |
| `availableModels` | Steht die Modellfamilie des Ziels in einer Quelle mit `availableModels` nicht drin, setzt das Plugin kein Modell (Grund `target-not-allowed`). Claude Code würde das Ziel sonst durch das Hauptmodell ersetzen. |
| `deniedModels` | Steht die Familie in irgendeinem `deniedModels`, ebenso. Ein unlesbarer Wert (keine Liste) zählt als „nicht erlaubt“. |
| `allowManagedHooksOnly` | Claude Code blockiert dann Plugin-Hooks und die eigene Statusline. `SessionStart` und `doctor` weisen darauf hin. |

Gelesen werden Managed Settings (Datei und `managed-settings.d/`), `~/.claude/remote-settings.json`, auf macOS die MDM-Profile unter `/Library/Managed Preferences/`, dann `~/.claude/settings.json` sowie `.claude/settings.json` und `.claude/settings.local.json` im Projekt. Details: [ARCHITEKTUR.md](ARCHITEKTUR.md#regeln-und-settings-quellen).

## Agent-Typen

Der Typ ist der `name` aus der Agent-Definition, bei eingebauten Agents `Explore`, `Plan`, `general-purpose`, `claude`, `claude-code-guide`, `statusline-setup`. Ein Aufruf ohne Typ zählt als `general-purpose`. Plugin-Agents tragen den Plugin-Namen davor (`mein-plugin:reviewer`). Für sie kennt quota-pacer das Ausgangsmodell nicht; sie werden deshalb höchstens auf Haiku gesetzt.

Für ein Team mit eigenen Agents lohnt es sich, Leser und Sucher in `routineAgents` und Reviewer in `protectedAgents` einzutragen.

## Beispiele

### Standard: Drossel (keine Datei nötig)

Gleichbedeutend mit:

```json
{
  "strategy": "throttle",
  "throttle": {
    "bufferPct": 10, "earlySlackPct": 15, "releaseFraction": 0.1, "maxWaitSec": 90, "minWaitSec": 2,
    "weeklyDeadbandPct": 1, "weeklyRampPct": 3
  }
}
```

### Drossel, sanfter und später

Kürzere Pausen, kleinerer Puffer. Bremst weniger, das Risiko eines harten Stopps steigt.

```json
{
  "throttle": { "bufferPct": 5, "maxWaitSec": 45 }
}
```

### Drossel für eigene Arbeitszeiten

Die Woche zählt Mo–Sa 8–20 Uhr als Arbeitszeit.

```json
{
  "activeHours": { "days": [1, 2, 3, 4, 5, 6], "start": 8, "end": 20 }
}
```

### Modellwechsel wie in 1.0.0

```json
{
  "strategy": "downgrade",
  "concurrency": { "amber": 2, "red": 3 },
  "protectedAgents": ["Plan", "code-reviewer"],
  "routineAgents": ["Explore", "claude-code-guide", "statusline-setup", "doc-reader"]
}
```

`red: 3` statt 1: In ROT laufen die Subagents ohnehin auf Haiku. Ein Limit von 1 verlagert sonst Arbeit in den teureren Hauptthread.

### Beides

```json
{
  "strategy": "both",
  "concurrency": { "red": 3 }
}
```

Unter ROT nur Pausen. Ab ROT zusätzlich Haiku für Routine- und übrige Agents, Sonnet für geschützte, höchstens 3 parallel.

### Nur die Pausen abschalten

```json
{ "throttle": { "maxWaitSec": 0 } }
```

Stufe, Prognose und Statuszeile bleiben. Bei `downgrade` oder `both` bleiben auch Modellwechsel und Parallel-Limit.

### Alle Eingriffe abschalten

```json
{ "enabled": false }
```

Keine Pausen, kein Modellwechsel, kein Parallel-Limit, keine Hinweise. Der Sensor misst weiter, die Statuszeile zeigt aber kein `pacing`-Segment mehr. Stand und Prognose zeigt `/quota-pacer:status`.

## Umgebungsvariablen

| Variable | Wirkung |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | wird wie von Claude Code beachtet; Datenverzeichnis ist dann `$CLAUDE_CONFIG_DIR/quota-pacer`, Settings `$CLAUDE_CONFIG_DIR/settings.json` |
| `CLAUDE_PROJECT_DIR` | Projektverzeichnis für Agent-Definitionen und Projekt-Settings (sonst `cwd` aus dem Hook-Input) |
| `CLAUDE_CODE_SUBAGENT_MODEL` | geht in die Modellauflösung ein (nicht für `Explore` und `Plan`) |
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` | gesetzt (nicht `0`/`false`): Claude Code ignoriert das Modell pro Aufruf. Das Plugin ändert dann keine Modelle mehr; bei `downgrade` bleibt nur das Parallel-Limit. Für die Drossel ohne Bedeutung. |
| `CLAUDE_CODE_GIT_BASH_PATH` | Windows: Bash für eine verkettete vorherige Statusline (sonst Git Bash im Standardpfad, sonst PowerShell) |
| `QUOTA_PACER_HOME` | eigenes Datenverzeichnis (nur für Tests) |
| `QUOTA_PACER_NOW` | feste Uhrzeit in ms (nur für Tests) |
| `QUOTA_PACER_MANAGED_SETTINGS` | Pfad zu einer Managed-Settings-Datei statt der Systempfade; schaltet das Lesen der macOS-Profile ab (nur für Tests) |
| `QUOTA_PACER_CHAINED` | intern: markiert eine verkettete Statusline, damit sich der Sensor nicht selbst aufruft |
