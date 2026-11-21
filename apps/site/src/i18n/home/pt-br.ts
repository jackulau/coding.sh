// Brazilian Portuguese (/pt-br). Each key is the English string exactly as the source has it; keep
// {{PLACEHOLDERS}}, <code> and <span> as they are. See src/i18n/home.ts.
export default {
  // <title> and meta description (pages/index.astro)
  "coding.sh: open-source observability and evals for AI agents":
    "coding.sh: observabilidade e avaliações para agentes de IA",
  "Record what Claude Code, Codex, Cursor and 10 other AI agents did and what it cost, then test changes with evals. Local-first and open source.":
    "Registre o que Claude Code, Codex, Cursor e mais 10 agentes de IA fizeram e quanto custou, e teste mudanças com avaliações. Local-first e open source.",

  // Hero (landing/body.html)
  "The Observability Layer for&nbsp;Agents.": "A camada de observabilidade para&nbsp;agentes.",
  "Record, measure, compare and benchmark every agent&nbsp;run.": "Registre, meça, compare e faça benchmark de cada execução de&nbsp;agente.",
  "Copy the install command: {{INSTALL}}": "Copiar o comando de instalação: {{INSTALL}}",
  "Copy the setup prompt for your coding agent": "Copiar o prompt de instalação para o seu agente de código",
  "Free and open source. <a href=\"{{RELEASE_HREF}}\">What's new in coding.sh <code>v{{RELEASE}}</code></a>":
    "Gratuito e de código aberto. <a href=\"{{RELEASE_HREF}}\">Novidades do coding.sh <code>v{{RELEASE}}</code></a>",
  "Get started": "Primeiros passos",
  "Works with": "Funciona com",

  // The flow diagram (landing/flow.html)
  "Every agent, one record": "Todos os agentes, um só registro",
  "Your agents on one side. Sessions, cost and evals on the other.":
    "Seus agentes de um lado. Sessões, custo e avaliações do outro.",
  "The agents you use feed coding.sh, which keeps their sessions, cost, evals, experiments, benchmarks, gateway costs and SDK traces.":
    "Os agentes que você usa enviam dados ao coding.sh, que guarda sessões, custo, avaliações, experimentos, benchmarks, custos de gateways e traces do SDK.",
  sessions: "sessões",
  cost: "custo",
  evals: "avaliações",
  experiments: "experimentos",
  benchmarks: "benchmarks",
  gateways: "gateways",
  sdk: "sdk",

  // The three steps and the drawing (landing/body.html, landing/trace.html)
  "How to start": "Como começar",
  Install: "Instalar",
  "Run the command above. It finds the agents you use and asks before it changes their settings.":
    "Execute o comando acima. Ele encontra os agentes que você usa e pergunta antes de alterar as configurações deles.",
  "Keep working": "Continue trabalhando",
  "Use your agents the way you do now. Each session is saved on your machine as it runs.":
    "Use seus agentes como você já usa hoje. Cada sessão é salva na sua máquina durante a execução.",
  "Open the viewer": "Abra o visualizador",
  "Run <code>coding.sh ui</code> to see every session and where it broke.":
    "Execute <code>coding.sh ui</code> para ver cada sessão e onde ela falhou.",
  "A drawing of one agent's session as a level line, left to right, with the time under it. The agent hands a task to a subagent, which branches off above the line and comes back. Each model call drops to a gateway below the line, where its cost is written. Later one step fails, in red, and the last one passes, in green.":
    "Um desenho da sessão de um agente como uma linha horizontal, da esquerda para a direita, com o tempo embaixo. O agente passa uma tarefa para um subagente, que se ramifica acima da linha e volta. Cada chamada ao modelo desce até um gateway abaixo da linha, onde o custo dela fica anotado. Mais adiante, um passo falha, em vermelho, e o último passa, em verde.",

  // What you can do with it (landing/body.html)
  "What you can do with it": "O que você pode fazer com o coding.sh",
  "Read a session, add up what it cost, test a change, and track the AI calls your own app makes.":
    "Ler uma sessão, somar quanto ela custou, testar uma mudança e acompanhar as chamadas de IA que o seu próprio app faz.",
  "Find the step that broke": "Encontre o passo que falhou",
  "Open any session to see each prompt, command and file edit in order. When a command fails, the lines that say why are marked red.":
    "Abra qualquer sessão para ver cada prompt, comando e edição de arquivo, em ordem. Quando um comando falha, as linhas que explicam o motivo ficam marcadas em vermelho.",
  "A Claude Code session in the coding.sh viewer: its title, agent, duration and estimated cost, then its steps in order. The npm test run is red because one test failed. A few steps later the agent edits src/store/sqlite.ts to fix it.":
    "Uma sessão do Claude Code no visualizador do coding.sh: título, agente, duração e custo estimado, seguidos dos passos em ordem. A execução do npm test está em vermelho porque um teste falhou. Alguns passos depois, o agente edita src/store/sqlite.ts para corrigir a falha.",
  "See what each agent costs": "Veja quanto custa cada agente",
  "Output of coding.sh usage": "Saída do coding.sh usage",
  "Track cost per session": "Acompanhar o custo por sessão",
  "Test a change to AGENTS.md": "Teste uma mudança no AGENTS.md",
  "what coding.sh reports": "o que o coding.sh informa",
  "Tasks passed went from {{BASE_RATE}}% before to {{CAND_RATE}}% after":
    "A taxa de tarefas aprovadas passou de {{BASE_RATE}}% antes para {{CAND_RATE}}% depois",
  "The same {{TASKS}} tasks, {{RUNS}} runs each, before and after.":
    "As mesmas {{TASKS}} tarefas, {{RUNS}} execuções de cada uma, antes e depois.",
  "Test an AGENTS.md or skill change": "Testar uma mudança no AGENTS.md ou em uma skill",
  "Track the AI calls in your app": "Acompanhe as chamadas de IA do seu app",
  "Each request shows up with its model, tokens, cost and time.":
    "Cada requisição aparece com o modelo, os tokens, o custo e o tempo.",
  "Read the SDK guide": "Ler o guia do SDK",

  // Questions (landing/body.html, pages/index.astro)
  Questions: "Perguntas",
  "Short answers here. The long ones are in the docs.": "Aqui, respostas curtas. As longas estão na documentação.",
  'Read the docs FAQ <span aria-hidden="true">→</span>':
    'Ler as perguntas frequentes da documentação <span aria-hidden="true">→</span>',
  "Does anything leave my machine?": "Algo sai da minha máquina?",
  "No session data. The only default request is a daily update check (off with CODING_SH_NO_UPDATE_CHECK=1). Sessions are saved in ~/.coding.sh and nothing else is sent unless you set up an export yourself.":
    "Nenhum dado de sessão. A única requisição padrão é uma verificação diária de atualizações (desative com CODING_SH_NO_UPDATE_CHECK=1). As sessões ficam salvas em ~/.coding.sh e nada mais é enviado, a menos que você mesmo configure uma exportação.",
  "Will it slow my agent down?": "Ele deixa meu agente mais lento?",
  "No. The hook adds one line to a file and exits. The rest of the work happens after the session.":
    "Não. O hook adiciona uma linha a um arquivo e encerra. O resto do trabalho acontece depois da sessão.",
  "Does it change my agent's settings?": "Ele altera as configurações do meu agente?",
  "Only after you say yes. It backs up each file first, and coding.sh uninstall takes its hooks out again.":
    "Só depois que você disser sim. Antes, ele faz backup de cada arquivo, e o coding.sh uninstall remove os hooks que ele instalou.",
  "What does it cost?": "Quanto custa?",
  "Nothing. Your model spend stays what your agents already cost.":
    "Nada. Seu gasto com modelos continua sendo o que seus agentes já custam.",

  // Closing (landing/body.html)
  "Try it on your next session": "Experimente na sua próxima sessão",

  // Footer (pages/index.astro)
  "A record of what your agents did and what it cost, kept on your machine.":
    "Um registro do que seus agentes fizeram e de quanto custou, guardado na sua máquina.",
  status: "status",
  early: "fase inicial",
  Language: "Idioma",
  Footer: "Rodapé",
  Start: "Começar",
  Use: "Uso",
  Project: "Projeto",
  More: "Mais",
  Quickstart: "Início rápido",
  Agents: "Agentes",
  "All docs": "Toda a documentação",
  Cost: "Custo",
  Evals: "Avaliações",
  Experiments: "Experimentos",
  SDK: "SDK",
  Changelog: "Histórico de mudanças",
  Blog: "Blog",
  GitHub: "GitHub",
  License: "Licença",
  Compare: "Comparar",
  Privacy: "Privacidade",
  FAQ: "Perguntas frequentes",
  "llms.txt": "llms.txt",

  // Nav and layout (components/Nav.astro, layouts/Layout.astro)
  Docs: "Documentação",
  Menu: "Menu",
  "Close menu": "Fechar menu",
  Primary: "Principal",
  "coding.sh home": "Página inicial do coding.sh",
  "Stars: {{N}}": "Estrelas: {{N}}",
  "Copied to clipboard": "Copiado para a área de transferência",
  "Selected, copy it with your keyboard": "Selecionado, copie com o teclado",
  "Skip to content": "Pular para o conteúdo",
} satisfies Record<string, string>;
