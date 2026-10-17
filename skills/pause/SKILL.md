---
name: pause
description: Schaltet quota-pacer vorübergehend ab (keine Drossel, keine Modellwechsel, kein Parallel-Limit). Argument Dauer, z. B. 30m, 2h, 1d; ohne Angabe 2 h.
disable-model-invocation: true
argument-hint: "[Dauer: 30m | 2h | 1d]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" pause) Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" pause *)
---

Führe mit dem Bash-Tool genau diesen einen Befehl aus. Setze dabei für DAUER das Argument ein, wenn es nur aus Ziffern, Komma, Punkt und einer Einheit (m, min, h, std, d, t) besteht; sonst lass DAUER weg:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/pacer.js" pause DAUER`

Argument: $ARGUMENTS

Gib die Ausgabe unverändert in einem Codeblock wieder. Führe keine weiteren Befehle aus und ergänze nichts.
