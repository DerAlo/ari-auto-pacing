---
name: setup
description: Trägt den quota-pacer-Sensor als Statusline in die Claude-Code-Einstellungen ein (mit Backup); mit dem Argument "uninstall" wird er wieder entfernt und die vorherige Statusline wiederhergestellt.
argument-hint: "[uninstall]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" install) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" uninstall)
---

Argument: `$ARGUMENTS`

1. Ist das Argument genau `uninstall`, führe mit dem Bash-Tool aus:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" uninstall`
   Bei jedem anderen oder leeren Argument führe aus:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" install`
2. Führe nur diesen einen Befehl aus. Ändere keine Dateien selbst und rufe keine weiteren Befehle auf.
3. Gib die Ausgabe des Befehls unverändert in einem Codeblock wieder. Ergänze danach höchstens einen kurzen Satz auf Deutsch:
   - nach `install`: Die Anzeige erscheint nach der nächsten Antwort von Claude; prüfen mit `/quota-pacer:status`.
   - nach `uninstall`: Die Hooks entfernt `/plugin uninstall quota-pacer`, danach `/plugin marketplace remove ari-auto-pacing`.
   - Beginnt die Ausgabe mit `FEHLER:`, nenne den Fehler und schlage nichts Weiteres vor.
