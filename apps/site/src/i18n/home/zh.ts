// Simplified Chinese (/zh). Each key is the English string exactly as the source has it; keep
// {{PLACEHOLDERS}}, <code> and <span> as they are. See src/i18n/home.ts.
export default {
  // <title> and meta description (pages/index.astro)
  "coding.sh: open-source observability and evals for AI agents": "coding.sh：开源的 AI 智能体可观测性与评测工具",
  "Record what Claude Code, Codex, Cursor and 9 other AI agents did and what it cost, then test changes with evals. Local-first and open source.":
    "记录 Claude Code、Codex、Cursor 等 12 种 AI 智能体做了什么、花了多少钱，再用评测检验改动。本地优先，开源。",

  // Hero (landing/body.html)
  "The Observability Layer for&nbsp;Agents.": "面向智能体的可观测性层。",
  "Record, measure, compare and benchmark every agent&nbsp;run.": "记录、度量、比较并基准测试每一次智能体运行。",
  "Copy the install command: {{INSTALL}}": "复制安装命令：{{INSTALL}}",
  "Copy the setup prompt for your coding agent": "复制给编码智能体的安装提示词",
  "Free and open source. <a href=\"{{RELEASE_HREF}}\">What's new in coding.sh <code>v{{RELEASE}}</code></a>":
    "免费且开源。<a href=\"{{RELEASE_HREF}}\">coding.sh <code>v{{RELEASE}}</code> 的新功能</a>",
  "Get started": "开始使用",
  "Works with": "支持的智能体",

  // The flow diagram (landing/flow.html)
  "Every agent, one record": "所有智能体，一份记录",
  "Your agents on one side. Sessions, cost and evals on the other.": "一边是你的智能体，另一边是会话、费用和评测。",
  "The agents you use feed coding.sh, which keeps their sessions, cost, evals, experiments, benchmarks, gateway costs and SDK traces.":
    "你在用的智能体把数据送入 coding.sh，由它保存这些智能体的会话、费用、评测、实验、基准测试、网关费用和 SDK 追踪数据。",
  sessions: "会话",
  cost: "费用",
  evals: "评测",
  experiments: "实验",
  benchmarks: "基准测试",
  gateways: "网关",
  sdk: "SDK",

  // The three steps and the drawing (landing/body.html, landing/trace.html)
  "How to start": "如何开始",
  Install: "安装",
  "Run the command above. It finds the agents you use and asks before it changes their settings.":
    "运行上面的命令。它会找到你在用的智能体，并在修改它们的设置前先询问你。",
  "Keep working": "照常工作",
  "Use your agents the way you do now. Each session is saved on your machine as it runs.": "像平时一样使用你的智能体。每个会话会在运行过程中保存到你的机器上。",
  "Open the viewer": "打开查看器",
  "Run <code>coding.sh ui</code> to see every session and where it broke.": "运行 <code>coding.sh ui</code>，查看每个会话，以及它在哪一步出了错。",
  "A drawing of one agent's session as a level line, left to right, with the time under it. The agent hands a task to a subagent, which branches off above the line and comes back. Each model call drops to a gateway below the line, where its cost is written. Later one step fails, in red, and the last one passes, in green.":
    "示意图：一个智能体的会话画成一条从左到右的水平线，线下标着时间。智能体把一项任务交给子智能体，子智能体从线的上方分出，再回到线上。每次模型调用都向下落到线下方的网关，那里标着这次调用的费用。后来有一步失败，标为红色；最后一步通过，标为绿色。",

  // What you can do with it (landing/body.html)
  "What you can do with it": "你可以用它做什么",
  "Read a session, add up what it cost, test a change, and track the AI calls your own app makes.": "查看会话、统计费用、检验改动，以及跟踪你自己的应用发出的 AI 调用。",
  "Find the step that broke": "找到出错的那一步",
  "Open any session to see each prompt, command and file edit in order. When a command fails, the lines that say why are marked red.":
    "打开任意会话，按顺序查看每条提示词、命令和文件修改。命令失败时，说明原因的那几行会标成红色。",
  "A Claude Code session in the coding.sh viewer: its title, agent, duration and estimated cost, then its steps in order. The npm test run is red because one test failed. A few steps later the agent edits src/store/sqlite.ts to fix it.":
    "coding.sh 查看器里的一个 Claude Code 会话：标题、智能体、时长和预估费用，然后按顺序列出每一步。npm test 这一步是红色的，因为有一个测试失败了。几步之后，智能体修改 src/store/sqlite.ts 来修复它。",
  "See what each agent costs": "看清每个智能体的费用",
  "Output of coding.sh usage": "coding.sh usage 的输出",
  "Track cost per session": "按会话跟踪费用",
  "Test a change to AGENTS.md": "检验对 AGENTS.md 的改动",
  "what coding.sh reports": "coding.sh 给出的结果",
  "Tasks passed went from {{BASE_RATE}}% before to {{CAND_RATE}}% after": "任务通过率从改动前的 {{BASE_RATE}}% 变为改动后的 {{CAND_RATE}}%",
  "The same {{TASKS}} tasks, {{RUNS}} runs each, before and after.": "同样的 {{TASKS}} 个任务，改动前后每个任务各运行 {{RUNS}} 次。",
  "Test an AGENTS.md or skill change": "检验 AGENTS.md 或技能的改动",
  "Track the AI calls in your app": "跟踪你的应用里的 AI 调用",
  "Each request shows up with its model, tokens, cost and time.": "每个请求都会列出模型、token 数、费用和耗时。",
  "Read the SDK guide": "阅读 SDK 指南",

  // Questions (landing/body.html, pages/index.astro)
  Questions: "常见问题",
  "Short answers here. The long ones are in the docs.": "这里是简短回答，详细解答见文档。",
  'Read the docs FAQ <span aria-hidden="true">→</span>': '阅读文档里的常见问题 <span aria-hidden="true">→</span>',
  "Does anything leave my machine?": "有数据会离开我的机器吗？",
  "No session data. The only default request is a daily update check (off with CODING_SH_NO_UPDATE_CHECK=1). Sessions are saved in ~/.coding.sh and nothing else is sent unless you set up an export yourself.":
    "会话数据不会。默认只有一个请求：每天一次的更新检查（设置 CODING_SH_NO_UPDATE_CHECK=1 即可关闭）。会话保存在 ~/.coding.sh，除非你自己设置导出，否则不会发送任何其他内容。",
  "Will it slow my agent down?": "会拖慢我的智能体吗？",
  "No. The hook adds one line to a file and exits. The rest of the work happens after the session.": "不会。钩子只往一个文件里写一行就退出，其余的工作都在会话结束后进行。",
  "Does it change my agent's settings?": "它会修改我的智能体设置吗？",
  "Only after you say yes. It backs up each file first, and coding.sh uninstall takes its hooks out again.":
    "只有在你同意之后才会。它会先备份每个文件，运行 coding.sh uninstall 就能把它的钩子移除。",
  "What does it cost?": "要花多少钱？",
  "Nothing. Your model spend stays what your agents already cost.": "免费。模型费用仍是你的智能体原本的花费。",

  // Closing (landing/body.html)
  "Try it on your next session": "在下一个会话里试试",

  // Footer (pages/index.astro)
  "A record of what your agents did and what it cost, kept on your machine.": "记录你的智能体做了什么、花了多少钱，保存在你的机器上。",
  status: "状态",
  early: "早期版本",
  Language: "语言",
  Footer: "页脚",
  Start: "入门",
  Use: "使用",
  Project: "项目",
  More: "更多",
  Quickstart: "快速上手",
  Agents: "智能体",
  "All docs": "全部文档",
  Cost: "费用",
  Evals: "评测",
  Experiments: "实验",
  SDK: "SDK",
  Changelog: "更新日志",
  Blog: "博客",
  GitHub: "GitHub",
  License: "许可证",
  Compare: "对比",
  Privacy: "隐私",
  FAQ: "常见问题",
  "llms.txt": "llms.txt",

  // Nav and layout (components/Nav.astro, layouts/Layout.astro)
  Docs: "文档",
  Menu: "菜单",
  "Close menu": "关闭菜单",
  Primary: "主要",
  "coding.sh home": "coding.sh 首页",
  "Stars: {{N}}": "星标：{{N}}",
  "Copied to clipboard": "已复制到剪贴板",
  "Selected, copy it with your keyboard": "已选中，请用键盘复制",
  "Skip to content": "跳转到正文",
} satisfies Record<string, string>;
