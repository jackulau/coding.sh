// German (/de). Each key is the English string exactly as the source has it; keep
// {{PLACEHOLDERS}}, <code> and <span> as they are. See src/i18n/home.ts.
export default {
  // <title> and meta description (pages/index.astro)
  "coding.sh: open-source observability and evals for AI agents": "coding.sh: Observability und Evals für KI-Agenten",
  "Record what Claude Code, Codex, Cursor and 10 other AI agents did and what it cost, then test changes with evals. Local-first and open source.":
    "Zeichne auf, was Claude Code, Codex, Cursor und 10 weitere KI-Agenten getan und gekostet haben. Teste Änderungen mit Evals. Local-first und Open Source.",

  // Hero (landing/body.html)
  "The Observability Layer for&nbsp;Agents.": "Die Observability-Schicht für&nbsp;Agenten.",
  "Record, measure, compare and benchmark every agent&nbsp;run.": "Jeden Agentenlauf aufzeichnen, messen, vergleichen und&nbsp;benchmarken.",
  "Copy the install command: {{INSTALL}}": "Installationsbefehl kopieren: {{INSTALL}}",
  "Copy the setup prompt for your coding agent": "Setup-Prompt für deinen Coding-Agent kopieren",
  "Install with": "Installieren mit",
  "Agent prompt": "Agent-Prompt",
  npx: "npx",
  Script: "Skript",
  "Copy the npx command: {{NPX}}": "npx-Befehl kopieren: {{NPX}}",
  "Paste it into your coding agent.": "Füge ihn in deinen Coding-Agent ein.",
  "Needs Node.js 22.16 or newer. It does not work on Windows.": "Benötigt Node.js 22.16 oder neuer. Unter Windows funktioniert es nicht.",
  "On Windows, run it in Git Bash. It does not work in PowerShell or cmd.":
    "Unter Windows in Git Bash ausführen. In PowerShell und cmd funktioniert es nicht.",
  "Free and open source. <a href=\"{{RELEASE_HREF}}\">What's new in coding.sh <code>v{{RELEASE}}</code></a>":
    "Kostenlos und Open Source. <a href=\"{{RELEASE_HREF}}\">Neu in coding.sh <code>v{{RELEASE}}</code></a>",
  "Get started": "Erste Schritte",
  "Works with": "Funktioniert mit",

  // The flow diagram (landing/flow.html)
  "Every agent, one record": "Alle Agenten, eine Aufzeichnung",
  "Your agents on one side. Sessions, cost and evals on the other.": "Auf der einen Seite deine Agenten. Auf der anderen Sessions, Kosten und Evals.",
  "The agents you use feed coding.sh, which keeps their sessions, cost, evals, experiments, benchmarks, gateway costs and SDK traces.":
    "Die Agenten, die du nutzt, liefern ihre Daten an coding.sh. Dort liegen ihre Sessions, Kosten, Evals, Experimente, Benchmarks, Gateway-Kosten und SDK-Traces.",
  sessions: "Sessions",
  cost: "Kosten",
  evals: "Evals",
  experiments: "Experimente",
  benchmarks: "Benchmarks",
  gateways: "Gateways",
  sdk: "SDK",

  // The three steps and the drawing (landing/body.html, landing/trace.html)
  "How to start": "So fängst du an",
  Install: "Installieren",
  "Run the command above. It finds the agents you use and asks before it changes their settings.":
    "Führe den Befehl oben aus. Er findet die Agenten, die du nutzt, und fragt nach, bevor er ihre Einstellungen ändert.",
  "Keep working": "Weiterarbeiten",
  "Use your agents the way you do now. Each session is saved on your machine as it runs.": "Nutze deine Agenten wie bisher. Jede Session wird auf deinem Rechner gespeichert, während sie läuft.",
  "Open the viewer": "Viewer öffnen",
  "Run <code>coding.sh ui</code> to see every session and where it broke.": "Mit <code>coding.sh ui</code> siehst du jede Session und wo sie fehlgeschlagen ist.",
  "A drawing of one agent's session as a level line, left to right, with the time under it. The agent hands a task to a subagent, which branches off above the line and comes back. Each model call drops to a gateway below the line, where its cost is written. Later one step fails, in red, and the last one passes, in green.":
    "Eine Zeichnung der Session eines Agenten als waagerechte Linie von links nach rechts, darunter die Zeit. Der Agent gibt eine Aufgabe an einen Subagenten ab, der oberhalb der Linie abzweigt und zurückkehrt. Jeder Modellaufruf führt nach unten zu einem Gateway unterhalb der Linie, wo seine Kosten stehen. Später schlägt ein Schritt fehl und ist rot, der letzte gelingt und ist grün.",

  // What you can do with it (landing/body.html)
  "What you can do with it": "Was du damit machen kannst",
  "Read a session, add up what it cost, test a change, and track the AI calls your own app makes.":
    "Eine Session nachlesen, ihre Kosten zusammenrechnen, eine Änderung testen und die KI-Aufrufe deiner eigenen App verfolgen.",
  "Find the step that broke": "Finde den fehlgeschlagenen Schritt",
  "Open any session to see each prompt, command and file edit in order. When a command fails, the lines that say why are marked red.":
    "Öffne eine beliebige Session und sieh jeden Prompt, jeden Befehl und jede Dateiänderung der Reihe nach. Schlägt ein Befehl fehl, sind die Zeilen, die den Grund nennen, rot markiert.",
  "A Claude Code session in the coding.sh viewer: its title, agent, duration and estimated cost, then its steps in order. The npm test run is red because one test failed. A few steps later the agent edits src/store/sqlite.ts to fix it.":
    "Eine Session von Claude Code im Viewer von coding.sh: Titel, Agent, Dauer und geschätzte Kosten, darunter die Schritte der Reihe nach. Der Lauf von npm test ist rot, weil ein Test fehlgeschlagen ist. Ein paar Schritte später bearbeitet der Agent src/store/sqlite.ts, um den Fehler zu beheben.",
  "See what each agent costs": "Sieh, was jeder Agent kostet",
  "Output of coding.sh usage": "Ausgabe von coding.sh usage",
  "Track cost per session": "Kosten pro Session verfolgen",
  "Test a change to AGENTS.md": "Teste eine Änderung an AGENTS.md",
  "what coding.sh reports": "was coding.sh meldet",
  "Tasks passed went from {{BASE_RATE}}% before to {{CAND_RATE}}% after": "Bestandene Aufgaben: vorher {{BASE_RATE}} %, nachher {{CAND_RATE}} %",
  "The same {{TASKS}} tasks, {{RUNS}} runs each, before and after.": "Dieselben {{TASKS}} Aufgaben, je {{RUNS}} Läufe, vorher und nachher.",
  "Test an AGENTS.md or skill change": "Änderungen an AGENTS.md oder Skills testen",
  "Track the AI calls in your app": "Verfolge die KI-Aufrufe in deiner App",
  "Each request shows up with its model, tokens, cost and time.": "Jede Anfrage erscheint mit Modell, Tokens, Kosten und Dauer.",
  "Read the SDK guide": "SDK-Anleitung lesen",

  // Questions (landing/body.html, pages/index.astro)
  Questions: "Fragen",
  "Short answers here. The long ones are in the docs.": "Hier die kurzen Antworten. Die ausführlichen stehen in den Docs.",
  'Read the docs FAQ <span aria-hidden="true">→</span>': 'FAQ in den Docs lesen <span aria-hidden="true">→</span>',
  "Does anything leave my machine?": "Verlässt irgendetwas meinen Rechner?",
  "No session data. The only default request is a daily update check (off with CODING_SH_NO_UPDATE_CHECK=1). Sessions are saved in ~/.coding.sh and nothing else is sent unless you set up an export yourself.":
    "Keine Session-Daten. Die einzige Anfrage, die standardmäßig rausgeht, ist eine tägliche Update-Prüfung (abschaltbar mit CODING_SH_NO_UPDATE_CHECK=1). Sessions werden in ~/.coding.sh gespeichert, und sonst wird nichts gesendet, außer du richtest selbst einen Export ein.",
  "Will it slow my agent down?": "Wird mein Agent dadurch langsamer?",
  "No. The hook adds one line to a file and exits. The rest of the work happens after the session.":
    "Nein. Der Hook hängt eine Zeile an eine Datei an und beendet sich. Die restliche Arbeit passiert nach der Session.",
  "Does it change my agent's settings?": "Ändert es die Einstellungen meines Agenten?",
  "Only after you say yes. It backs up each file first, and coding.sh uninstall takes its hooks out again.":
    "Nur wenn du zustimmst. Vorher sichert es jede Datei, und coding.sh uninstall entfernt seine Hooks wieder.",
  "What does it cost?": "Was kostet es?",
  "Nothing. Your model spend stays what your agents already cost.": "Nichts. Deine Ausgaben für Modelle bleiben bei dem, was deine Agenten ohnehin kosten.",

  // Closing (landing/body.html)
  "Try it on your next session": "Probier es bei deiner nächsten Session aus",

  // Footer (pages/index.astro)
  "A record of what your agents did and what it cost, kept on your machine.": "Eine Aufzeichnung dessen, was deine Agenten getan haben und was es gekostet hat, gespeichert auf deinem Rechner.",
  status: "Status",
  early: "frühe Phase",
  Language: "Sprache",
  Footer: "Fußzeile",
  Start: "Einstieg",
  Use: "Nutzung",
  Project: "Projekt",
  More: "Weiteres",
  Quickstart: "Schnellstart",
  Agents: "Agenten",
  "All docs": "Alle Docs",
  Cost: "Kosten",
  Evals: "Evals",
  Experiments: "Experimente",
  SDK: "SDK",
  Changelog: "Changelog",
  Blog: "Blog",
  GitHub: "GitHub",
  License: "Lizenz",
  Compare: "Vergleich",
  Privacy: "Datenschutz",
  FAQ: "FAQ",
  "llms.txt": "llms.txt",

  // Nav and layout (components/Nav.astro, layouts/Layout.astro)
  Docs: "Docs",
  Menu: "Menü",
  "Close menu": "Menü schließen",
  Primary: "Hauptmenü",
  "coding.sh home": "Startseite von coding.sh",
  "Stars: {{N}}": "Sterne: {{N}}",
  "Copied to clipboard": "In die Zwischenablage kopiert",
  "Selected, copy it with your keyboard": "Markiert, kopiere es mit der Tastatur",
  "Skip to content": "Zum Inhalt springen",
} satisfies Record<string, string>;
