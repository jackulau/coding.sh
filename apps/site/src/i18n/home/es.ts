// Spanish (/es). Each key is the English string exactly as the source has it; keep
// {{PLACEHOLDERS}}, <code> and <span> as they are. See src/i18n/home.ts.
export default {
  // <title> and meta description (pages/index.astro)
  "coding.sh: open-source observability and evals for AI agents": "coding.sh: observabilidad y evaluaciones para agentes de IA",
  "Record what Claude Code, Codex, Cursor and 10 other AI agents did and what it cost, then test changes with evals. Local-first and open source.":
    "Registra qué hicieron Claude Code, Codex, Cursor y otros 10 agentes de IA y cuánto costó. Prueba cambios con evaluaciones. Local-first y de código abierto.",

  // Hero (landing/body.html)
  "The Observability Layer for&nbsp;Agents.": "La capa de observabilidad para&nbsp;agentes.",
  "Record, measure, compare and benchmark every agent&nbsp;run.": "Registra, mide, compara y evalúa cada ejecución de&nbsp;agente.",
  "Copy the install command: {{INSTALL}}": "Copiar el comando de instalación: {{INSTALL}}",
  "Copy the setup prompt for your coding agent": "Copiar el prompt de instalación para tu agente de código",
  "Install with": "Instalar con",
  "Agent prompt": "Prompt para el agente",
  npx: "npx",
  Script: "Script",
  "Copy the npx command: {{NPX}}": "Copiar el comando npx: {{NPX}}",
  "Paste it into your coding agent.": "Pégalo en tu agente de código.",
  "Needs Node.js 22.16 or newer. On Windows: ": "Necesita Node.js 22.16 o posterior. En Windows: ",
  "On Windows, run it in Git Bash. It does not work in PowerShell or cmd.":
    "En Windows, ejecútalo en Git Bash. No funciona en PowerShell ni en cmd.",
  "Free and open source. <a href=\"{{RELEASE_HREF}}\">What's new in coding.sh <code>v{{RELEASE}}</code></a>":
    "Gratis y de código abierto. <a href=\"{{RELEASE_HREF}}\">Novedades de coding.sh <code>v{{RELEASE}}</code></a>",
  "Get started": "Primeros pasos",
  "Works with": "Funciona con",

  // The flow diagram (landing/flow.html)
  "Every agent, one record": "Todos los agentes, un solo registro",
  "Your agents on one side. Sessions, cost and evals on the other.": "Tus agentes a un lado. Sesiones, costo y evaluaciones al otro.",
  "The agents you use feed coding.sh, which keeps their sessions, cost, evals, experiments, benchmarks, gateway costs and SDK traces.":
    "Los agentes que usas envían sus datos a coding.sh, que guarda sesiones, costo, evaluaciones, experimentos, benchmarks, costos de gateways y trazas del SDK.",
  sessions: "sesiones",
  cost: "costo",
  evals: "evaluaciones",
  experiments: "experimentos",
  benchmarks: "benchmarks",
  gateways: "gateways",
  sdk: "sdk",

  // The three steps and the drawing (landing/body.html, landing/trace.html)
  "How to start": "Cómo empezar",
  Install: "Instalar",
  "Run the command above. It finds the agents you use and asks before it changes their settings.":
    "Ejecuta el comando de arriba. Detecta los agentes que usas y te pregunta antes de cambiar su configuración.",
  "Keep working": "Sigue trabajando",
  "Use your agents the way you do now. Each session is saved on your machine as it runs.": "Usa tus agentes como siempre. Cada sesión se guarda en tu máquina mientras se ejecuta.",
  "Open the viewer": "Abre el visor",
  "Run <code>coding.sh ui</code> to see every session and where it broke.": "Ejecuta <code>coding.sh ui</code> para ver cada sesión y dónde falló.",
  "A drawing of one agent's session as a level line, left to right, with the time under it. The agent hands a task to a subagent, which branches off above the line and comes back. Each model call drops to a gateway below the line, where its cost is written. Later one step fails, in red, and the last one passes, in green.":
    "Un dibujo de la sesión de un agente como una línea horizontal, de izquierda a derecha, con el tiempo debajo. El agente pasa una tarea a un subagente, que se separa por encima de la línea y vuelve. Cada llamada al modelo baja hasta un gateway, debajo de la línea, donde se anota su costo. Más adelante, un paso falla, en rojo, y el último pasa, en verde.",

  // What you can do with it (landing/body.html)
  "What you can do with it": "Qué puedes hacer con coding.sh",
  "Read a session, add up what it cost, test a change, and track the AI calls your own app makes.":
    "Leer una sesión, sumar lo que costó, probar un cambio y rastrear las llamadas a IA que hace tu propia app.",
  "Find the step that broke": "Encuentra el paso que falló",
  "Open any session to see each prompt, command and file edit in order. When a command fails, the lines that say why are marked red.":
    "Abre cualquier sesión para ver cada prompt, comando y edición de archivo en orden. Cuando un comando falla, las líneas que explican por qué aparecen en rojo.",
  "A Claude Code session in the coding.sh viewer: its title, agent, duration and estimated cost, then its steps in order. The npm test run is red because one test failed. A few steps later the agent edits src/store/sqlite.ts to fix it.":
    "Una sesión de Claude Code en el visor de coding.sh: su título, agente, duración y costo estimado, y después sus pasos en orden. La ejecución de npm test está en rojo porque falló una prueba. Unos pasos después, el agente edita src/store/sqlite.ts para corregir el fallo.",
  "See what each agent costs": "Mira cuánto cuesta cada agente",
  "Output of coding.sh usage": "Salida de coding.sh usage",
  "Track cost per session": "Rastrear el costo por sesión",
  "Test a change to AGENTS.md": "Prueba un cambio en AGENTS.md",
  "what coding.sh reports": "lo que informa coding.sh",
  "Tasks passed went from {{BASE_RATE}}% before to {{CAND_RATE}}% after": "Las tareas superadas pasaron del {{BASE_RATE}}% antes al {{CAND_RATE}}% después",
  "The same {{TASKS}} tasks, {{RUNS}} runs each, before and after.": "Las mismas {{TASKS}} tareas, {{RUNS}} ejecuciones de cada una, antes y después.",
  "Test an AGENTS.md or skill change": "Probar un cambio en AGENTS.md o en una skill",
  "Track the AI calls in your app": "Rastrea las llamadas a IA de tu app",
  "Each request shows up with its model, tokens, cost and time.": "Cada solicitud aparece con su modelo, tokens, costo y tiempo.",
  "Read the SDK guide": "Leer la guía del SDK",

  // Questions (landing/body.html, pages/index.astro)
  Questions: "Preguntas",
  "Short answers here. The long ones are in the docs.": "Aquí, respuestas cortas. Las largas están en la documentación.",
  'Read the docs FAQ <span aria-hidden="true">→</span>': 'Leer las preguntas frecuentes de la documentación <span aria-hidden="true">→</span>',
  "Does anything leave my machine?": "¿Sale algo de mi máquina?",
  "No session data. The only default request is a daily update check (off with CODING_SH_NO_UPDATE_CHECK=1). Sessions are saved in ~/.coding.sh and nothing else is sent unless you set up an export yourself.":
    "Ningún dato de sesión. La única solicitud por defecto es una verificación diaria de actualizaciones (se desactiva con CODING_SH_NO_UPDATE_CHECK=1). Las sesiones se guardan en ~/.coding.sh y no se envía nada más salvo que tú mismo configures una exportación.",
  "Will it slow my agent down?": "¿Ralentiza mi agente?",
  "No. The hook adds one line to a file and exits. The rest of the work happens after the session.":
    "No. El hook agrega una línea a un archivo y termina. El resto del trabajo ocurre después de la sesión.",
  "Does it change my agent's settings?": "¿Cambia la configuración de mi agente?",
  "Only after you say yes. It backs up each file first, and coding.sh uninstall takes its hooks out again.":
    "Solo si dices que sí. Antes guarda una copia de cada archivo, y coding.sh uninstall quita sus hooks.",
  "What does it cost?": "¿Cuánto cuesta?",
  "Nothing. Your model spend stays what your agents already cost.": "Nada. Tu gasto en modelos sigue siendo lo que ya cuestan tus agentes.",

  // Closing (landing/body.html)
  "Try it on your next session": "Pruébalo en tu próxima sesión",

  // Footer (pages/index.astro)
  "A record of what your agents did and what it cost, kept on your machine.": "Un registro de lo que hicieron tus agentes y de lo que costó, guardado en tu máquina.",
  status: "estado",
  early: "versión temprana",
  Language: "Idioma",
  Footer: "Pie de página",
  Start: "Empezar",
  Use: "Usar",
  Project: "Proyecto",
  More: "Más",
  Quickstart: "Inicio rápido",
  Agents: "Agentes",
  "All docs": "Toda la documentación",
  Cost: "Costo",
  Evals: "Evaluaciones",
  Experiments: "Experimentos",
  SDK: "SDK",
  Changelog: "Registro de cambios",
  Blog: "Blog",
  GitHub: "GitHub",
  License: "Licencia",
  Compare: "Comparar",
  Privacy: "Privacidad",
  FAQ: "Preguntas frecuentes",
  "llms.txt": "llms.txt",

  // Nav and layout (components/Nav.astro, layouts/Layout.astro)
  Docs: "Documentación",
  Menu: "Menú",
  "Close menu": "Cerrar menú",
  Primary: "Principal",
  "coding.sh home": "Inicio de coding.sh",
  "Stars: {{N}}": "Estrellas: {{N}}",
  "Copied to clipboard": "Copiado al portapapeles",
  "Selected, copy it with your keyboard": "Seleccionado, cópialo con el teclado",
  "Skip to content": "Saltar al contenido",
} satisfies Record<string, string>;
