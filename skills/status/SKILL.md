---
name: status
description: Zeigt Kontingentstand, Prognose, Stufe, Strategie und Drossel von quota-pacer und prüft die Installation (doctor).
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" status) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" doctor)
---

Führe mit dem Bash-Tool nacheinander aus:

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" status`
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" doctor`

Ein Exit-Code ungleich 0 bei `doctor` bedeutet nur, dass es Befunde gibt; führe trotzdem beide Befehle aus.
Gib beide Ausgaben unverändert in je einem Codeblock wieder. Ändere nichts und führe keine weiteren Befehle aus.
Ergänze danach höchstens zwei kurze Sätze auf Deutsch: ob alles bereit ist, und falls nicht, den Hinweis aus der doctor-Ausgabe (z. B. `/quota-pacer:setup`).
