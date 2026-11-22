// French (/fr). Each key is the English string exactly as the source has it; keep
// {{PLACEHOLDERS}}, <code> and <span> as they are. See src/i18n/home.ts. French typography: a
// no-break space (U+00A0) before ":", "?" and "%".
export default {
  // <title> and meta description (pages/index.astro)
  "coding.sh: open-source observability and evals for AI agents": "coding.sh : observabilité et évaluations pour agents IA",
  "Record what Claude Code, Codex, Cursor and 10 other AI agents did and what it cost, then test changes with evals. Local-first and open source.":
    "Enregistrez ce qu'ont fait Claude Code, Codex, Cursor et 10 autres agents IA, et leur coût, puis évaluez vos changements. Local-first et open source.",

  // Hero (landing/body.html)
  "The Observability Layer for&nbsp;Agents.": "La couche d'observabilité pour les&nbsp;agents.",
  "Record, measure, compare and benchmark every agent&nbsp;run.": "Enregistrez, mesurez, comparez et évaluez chaque exécution d'agent.",
  "Copy the install command: {{INSTALL}}": "Copier la commande d'installation : {{INSTALL}}",
  "Copy the setup prompt for your coding agent": "Copier le prompt d'installation pour votre agent de code",
  "Install with": "Installer avec",
  "Agent prompt": "Prompt pour l'agent",
  npx: "npx",
  Script: "Script",
  "Copy the npx command: {{NPX}}": "Copier la commande npx : {{NPX}}",
  "Paste it into your coding agent.": "Collez-le dans votre agent de code.",
  "Needs Node.js 22.16 or newer. On Windows: ": "Nécessite Node.js 22.16 ou plus récent. Sous Windows : ",
  "On Windows, run it in Git Bash. It does not work in PowerShell or cmd.":
    "Sous Windows, lancez-la dans Git Bash. Elle ne fonctionne pas dans PowerShell ni dans cmd.",
  "Free and open source. <a href=\"{{RELEASE_HREF}}\">What's new in coding.sh <code>v{{RELEASE}}</code></a>":
    "Gratuit et open source. <a href=\"{{RELEASE_HREF}}\">Nouveautés de coding.sh <code>v{{RELEASE}}</code></a>",
  "Get started": "Premiers pas",
  "Works with": "Compatible avec",

  // The flow diagram (landing/flow.html)
  "Every agent, one record": "Tous les agents, un seul historique",
  "Your agents on one side. Sessions, cost and evals on the other.": "D'un côté, vos agents. De l'autre, les sessions, le coût et les évaluations.",
  "The agents you use feed coding.sh, which keeps their sessions, cost, evals, experiments, benchmarks, gateway costs and SDK traces.":
    "Les agents que vous utilisez alimentent coding.sh, qui conserve leurs sessions, leur coût, leurs évaluations, expériences et benchmarks, le coût des gateways et les traces du SDK.",
  sessions: "sessions",
  cost: "coût",
  evals: "évaluations",
  experiments: "expériences",
  benchmarks: "benchmarks",
  gateways: "gateways",
  sdk: "sdk",

  // The three steps and the drawing (landing/body.html, landing/trace.html)
  "How to start": "Pour commencer",
  Install: "Installer",
  "Run the command above. It finds the agents you use and asks before it changes their settings.":
    "Lancez la commande ci-dessus. Elle détecte les agents que vous utilisez et vous demande votre accord avant de modifier leur configuration.",
  "Keep working": "Continuer à travailler",
  "Use your agents the way you do now. Each session is saved on your machine as it runs.": "Utilisez vos agents comme d'habitude. Chaque session est enregistrée sur votre machine pendant qu'elle s'exécute.",
  "Open the viewer": "Ouvrir le visualiseur",
  "Run <code>coding.sh ui</code> to see every session and where it broke.": "Lancez <code>coding.sh ui</code> pour voir chaque session et l'endroit où elle a échoué.",
  "A drawing of one agent's session as a level line, left to right, with the time under it. The agent hands a task to a subagent, which branches off above the line and comes back. Each model call drops to a gateway below the line, where its cost is written. Later one step fails, in red, and the last one passes, in green.":
    "Un dessin de la session d'un agent, sous forme de ligne horizontale de gauche à droite, avec le temps en dessous. L'agent confie une tâche à un sous-agent, qui part au-dessus de la ligne puis revient. Chaque appel au modèle descend vers une gateway sous la ligne, où son coût est inscrit. Plus loin, une étape échoue, en rouge, et la dernière réussit, en vert.",

  // What you can do with it (landing/body.html)
  "What you can do with it": "Ce que vous pouvez en faire",
  "Read a session, add up what it cost, test a change, and track the AI calls your own app makes.":
    "Lire une session, calculer ce qu'elle a coûté, tester un changement et suivre les appels IA de votre propre application.",
  "Find the step that broke": "Trouver l'étape qui a échoué",
  "Open any session to see each prompt, command and file edit in order. When a command fails, the lines that say why are marked red.":
    "Ouvrez n'importe quelle session pour voir, dans l'ordre, chaque prompt, commande et modification de fichier. Quand une commande échoue, les lignes qui expliquent pourquoi sont en rouge.",
  "A Claude Code session in the coding.sh viewer: its title, agent, duration and estimated cost, then its steps in order. The npm test run is red because one test failed. A few steps later the agent edits src/store/sqlite.ts to fix it.":
    "Une session Claude Code dans le visualiseur de coding.sh : son titre, son agent, sa durée et son coût estimé, puis ses étapes dans l'ordre. L'exécution de npm test est en rouge, car un test a échoué. Quelques étapes plus loin, l'agent modifie src/store/sqlite.ts pour corriger l'erreur.",
  "See what each agent costs": "Voir ce que coûte chaque agent",
  "Output of coding.sh usage": "Sortie de coding.sh usage",
  "Track cost per session": "Suivre le coût par session",
  "Test a change to AGENTS.md": "Tester un changement dans AGENTS.md",
  "what coding.sh reports": "ce qu'indique coding.sh",
  "Tasks passed went from {{BASE_RATE}}% before to {{CAND_RATE}}% after": "Le taux de réussite des tâches est passé de {{BASE_RATE}} % avant à {{CAND_RATE}} % après",
  "The same {{TASKS}} tasks, {{RUNS}} runs each, before and after.": "Les mêmes {{TASKS}} tâches, {{RUNS}} exécutions chacune, avant et après.",
  "Test an AGENTS.md or skill change": "Tester un changement dans AGENTS.md ou dans une skill",
  "Track the AI calls in your app": "Suivre les appels IA de votre application",
  "Each request shows up with its model, tokens, cost and time.": "Chaque requête apparaît avec son modèle, ses tokens, son coût et sa durée.",
  "Read the SDK guide": "Lire le guide du SDK",

  // Questions (landing/body.html, pages/index.astro)
  Questions: "Questions",
  "Short answers here. The long ones are in the docs.": "Ici, des réponses courtes. Les réponses détaillées sont dans la documentation.",
  'Read the docs FAQ <span aria-hidden="true">→</span>': 'Lire la FAQ de la documentation <span aria-hidden="true">→</span>',
  "Does anything leave my machine?": "Des données quittent-elles ma machine ?",
  "No session data. The only default request is a daily update check (off with CODING_SH_NO_UPDATE_CHECK=1). Sessions are saved in ~/.coding.sh and nothing else is sent unless you set up an export yourself.":
    "Aucune donnée de session. La seule requête par défaut est une vérification quotidienne des mises à jour (désactivable avec CODING_SH_NO_UPDATE_CHECK=1). Les sessions sont enregistrées dans ~/.coding.sh et rien d'autre n'est envoyé, sauf si vous configurez vous-même un export.",
  "Will it slow my agent down?": "Est-ce que cela ralentit mon agent ?",
  "No. The hook adds one line to a file and exits. The rest of the work happens after the session.":
    "Non. Le hook ajoute une ligne à un fichier et s'arrête. Le reste du travail se fait après la session.",
  "Does it change my agent's settings?": "Est-ce que cela modifie la configuration de mon agent ?",
  "Only after you say yes. It backs up each file first, and coding.sh uninstall takes its hooks out again.":
    "Seulement si vous acceptez. Chaque fichier est d'abord sauvegardé, et coding.sh uninstall retire ses hooks.",
  "What does it cost?": "Combien coûte coding.sh ?",
  "Nothing. Your model spend stays what your agents already cost.": "Rien. Vos dépenses en modèles restent celles de vos agents aujourd'hui.",

  // Closing (landing/body.html)
  "Try it on your next session": "Essayez-le sur votre prochaine session",

  // Footer (pages/index.astro)
  "A record of what your agents did and what it cost, kept on your machine.": "L'historique de ce qu'ont fait vos agents et de ce que cela a coûté, conservé sur votre machine.",
  status: "statut",
  early: "version préliminaire",
  Language: "Langue",
  Footer: "Pied de page",
  Start: "Démarrage",
  Use: "Utilisation",
  Project: "Projet",
  More: "Autres",
  Quickstart: "Démarrage rapide",
  Agents: "Agents",
  "All docs": "Toute la documentation",
  Cost: "Coût",
  Evals: "Évaluations",
  Experiments: "Expériences",
  SDK: "SDK",
  Changelog: "Changelog",
  Blog: "Blog",
  GitHub: "GitHub",
  License: "Licence",
  Compare: "Comparatif",
  Privacy: "Confidentialité",
  FAQ: "FAQ",
  "llms.txt": "llms.txt",

  // Nav and layout (components/Nav.astro, layouts/Layout.astro)
  Docs: "Documentation",
  Menu: "Menu",
  "Close menu": "Fermer le menu",
  Primary: "Principale",
  "coding.sh home": "Accueil de coding.sh",
  "Stars: {{N}}": "Étoiles : {{N}}",
  "Copied to clipboard": "Copié dans le presse-papiers",
  "Selected, copy it with your keyboard": "Commande sélectionnée, copiez-la avec le clavier",
  "Skip to content": "Aller au contenu",
} satisfies Record<string, string>;
