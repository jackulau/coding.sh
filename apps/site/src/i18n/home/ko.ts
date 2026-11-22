// Korean (/ko). Each key is the English string exactly as the source has it; keep
// {{PLACEHOLDERS}}, <code> and <span> as they are. See src/i18n/home.ts.
export default {
  // <title> and meta description (pages/index.astro)
  "coding.sh: open-source observability and evals for AI agents": "coding.sh: AI 에이전트를 위한 오픈소스 관측성과 평가",
  "Record what Claude Code, Codex, Cursor and 10 other AI agents did and what it cost, then test changes with evals. Local-first and open source.":
    "Claude Code, Codex, Cursor 외 10개 AI 에이전트가 한 일과 든 비용을 기록하고, 평가로 변경 사항을 테스트합니다. 로컬 우선, 오픈소스입니다.",

  // Hero (landing/body.html)
  "The Observability Layer for&nbsp;Agents.": "에이전트를 위한 관측성&nbsp;레이어.",
  "Record, measure, compare and benchmark every agent&nbsp;run.": "모든 에이전트 실행을 기록하고, 측정하고, 비교하고, 벤치마크합니다.",
  "Copy the install command: {{INSTALL}}": "설치 명령어 복사: {{INSTALL}}",
  "Copy the setup prompt for your coding agent": "코딩 에이전트용 설정 프롬프트 복사",
  "Install with": "설치 방법",
  "Agent prompt": "에이전트 프롬프트",
  npx: "npx",
  Script: "스크립트",
  "Copy the npx command: {{NPX}}": "npx 명령어 복사: {{NPX}}",
  "Paste it into your coding agent.": "코딩 에이전트에 붙여 넣으세요.",
  "Needs Node.js 22.16 or newer. On Windows: ": "Node.js 22.16 이상이 필요합니다. Windows에서는: ",
  "On Windows, run it in Git Bash. It does not work in PowerShell or cmd.":
    "Windows에서는 Git Bash에서 실행하세요. PowerShell이나 cmd에서는 동작하지 않습니다.",
  "Free and open source. <a href=\"{{RELEASE_HREF}}\">What's new in coding.sh <code>v{{RELEASE}}</code></a>":
    "무료 오픈 소스입니다. <a href=\"{{RELEASE_HREF}}\">coding.sh <code>v{{RELEASE}}</code>의 새로운 기능</a>",
  "Get started": "빠른 시작 가이드",
  "Works with": "지원 에이전트",

  // The flow diagram (landing/flow.html)
  "Every agent, one record": "모든 에이전트를 하나의 기록으로",
  "Your agents on one side. Sessions, cost and evals on the other.": "한쪽에는 에이전트, 다른 쪽에는 세션, 비용, 평가.",
  "The agents you use feed coding.sh, which keeps their sessions, cost, evals, experiments, benchmarks, gateway costs and SDK traces.":
    "사용 중인 에이전트의 데이터가 coding.sh로 들어오고, coding.sh는 세션, 비용, 평가, 실험, 벤치마크, 게이트웨이 비용, SDK 트레이스를 보관합니다.",
  sessions: "세션",
  cost: "비용",
  evals: "평가",
  experiments: "실험",
  benchmarks: "벤치마크",
  gateways: "게이트웨이",
  sdk: "SDK",

  // The three steps and the drawing (landing/body.html, landing/trace.html)
  "How to start": "시작하는 방법",
  Install: "설치",
  "Run the command above. It finds the agents you use and asks before it changes their settings.":
    "위 명령어를 실행하면 사용 중인 에이전트를 찾고, 설정을 바꾸기 전에 먼저 묻습니다.",
  "Keep working": "평소처럼 작업하기",
  "Use your agents the way you do now. Each session is saved on your machine as it runs.": "에이전트를 지금처럼 쓰세요. 각 세션은 실행되는 동안 내 컴퓨터에 저장됩니다.",
  "Open the viewer": "뷰어 열기",
  "Run <code>coding.sh ui</code> to see every session and where it broke.": "<code>coding.sh ui</code>를 실행하면 모든 세션과 각 세션이 어디서 실패했는지 볼 수 있습니다.",
  "A drawing of one agent's session as a level line, left to right, with the time under it. The agent hands a task to a subagent, which branches off above the line and comes back. Each model call drops to a gateway below the line, where its cost is written. Later one step fails, in red, and the last one passes, in green.":
    "에이전트 하나의 세션을 왼쪽에서 오른쪽으로 이어지는 수평선으로 그린 그림으로, 선 아래에 시간이 표시됩니다. 에이전트가 서브에이전트에게 작업을 넘기면, 서브에이전트는 선 위로 갈라져 나갔다가 다시 돌아옵니다. 모델 호출은 각각 선 아래의 게이트웨이로 내려가고, 그곳에 비용이 적힙니다. 이후 한 단계가 실패해 빨간색으로 표시되고, 마지막 단계는 통과해 초록색으로 표시됩니다.",

  // What you can do with it (landing/body.html)
  "What you can do with it": "coding.sh로 할 수 있는 일",
  "Read a session, add up what it cost, test a change, and track the AI calls your own app makes.":
    "세션을 살펴보고, 세션에 든 비용을 합산하고, 변경 사항을 테스트하고, 내 앱이 보내는 AI 호출을 추적합니다.",
  "Find the step that broke": "실패한 단계 찾기",
  "Open any session to see each prompt, command and file edit in order. When a command fails, the lines that say why are marked red.":
    "어떤 세션이든 열면 프롬프트, 명령어, 파일 수정을 순서대로 볼 수 있습니다. 명령어가 실패하면 원인을 알려 주는 줄이 빨간색으로 표시됩니다.",
  "A Claude Code session in the coding.sh viewer: its title, agent, duration and estimated cost, then its steps in order. The npm test run is red because one test failed. A few steps later the agent edits src/store/sqlite.ts to fix it.":
    "coding.sh 뷰어에서 연 Claude Code 세션: 제목, 에이전트, 소요 시간, 추정 비용이 나오고, 이어서 단계가 순서대로 나옵니다. 테스트 하나가 실패해서 npm test 실행이 빨간색입니다. 몇 단계 뒤 에이전트가 src/store/sqlite.ts를 수정해 이를 고칩니다.",
  "See what each agent costs": "에이전트별 비용 보기",
  "Output of coding.sh usage": "coding.sh usage 출력",
  "Track cost per session": "세션별 비용 추적하기",
  "Test a change to AGENTS.md": "AGENTS.md 변경 테스트하기",
  "what coding.sh reports": "coding.sh가 보고한 결과",
  "Tasks passed went from {{BASE_RATE}}% before to {{CAND_RATE}}% after": "통과한 작업 비율이 변경 전 {{BASE_RATE}}%에서 변경 후 {{CAND_RATE}}%가 되었습니다",
  "The same {{TASKS}} tasks, {{RUNS}} runs each, before and after.": "같은 작업 {{TASKS}}개를 작업마다 {{RUNS}}번씩, 변경 전과 후에 실행했습니다.",
  "Test an AGENTS.md or skill change": "AGENTS.md나 스킬 변경 테스트하기",
  "Track the AI calls in your app": "앱의 AI 호출 추적하기",
  "Each request shows up with its model, tokens, cost and time.": "요청마다 모델, 토큰 수, 비용, 소요 시간이 표시됩니다.",
  "Read the SDK guide": "SDK 가이드 읽기",

  // Questions (landing/body.html, pages/index.astro)
  Questions: "자주 묻는 질문",
  "Short answers here. The long ones are in the docs.": "여기서는 짧게 답합니다. 자세한 답은 문서에 있습니다.",
  'Read the docs FAQ <span aria-hidden="true">→</span>': '문서의 자주 묻는 질문 읽기 <span aria-hidden="true">→</span>',
  "Does anything leave my machine?": "내 컴퓨터 밖으로 나가는 데이터가 있나요?",
  "No session data. The only default request is a daily update check (off with CODING_SH_NO_UPDATE_CHECK=1). Sessions are saved in ~/.coding.sh and nothing else is sent unless you set up an export yourself.":
    "세션 데이터는 나가지 않습니다. 기본으로 보내는 요청은 하루 한 번 하는 업데이트 확인뿐입니다(CODING_SH_NO_UPDATE_CHECK=1로 끌 수 있습니다). 세션은 ~/.coding.sh에 저장되며, 직접 내보내기를 설정하지 않는 한 그 밖에는 아무것도 보내지 않습니다.",
  "Will it slow my agent down?": "에이전트가 느려지나요?",
  "No. The hook adds one line to a file and exits. The rest of the work happens after the session.":
    "아니요. 훅은 파일에 한 줄을 추가하고 종료합니다. 나머지 처리는 세션이 끝난 뒤에 합니다.",
  "Does it change my agent's settings?": "에이전트 설정을 바꾸나요?",
  "Only after you say yes. It backs up each file first, and coding.sh uninstall takes its hooks out again.":
    "동의한 경우에만 바꿉니다. 먼저 각 파일을 백업하며, coding.sh uninstall을 실행하면 추가한 훅을 다시 제거합니다.",
  "What does it cost?": "비용이 드나요?",
  "Nothing. Your model spend stays what your agents already cost.": "들지 않습니다. 모델 비용은 지금 에이전트에 드는 만큼 그대로입니다.",

  // Closing (landing/body.html)
  "Try it on your next session": "다음 세션에서 써 보세요",

  // Footer (pages/index.astro)
  "A record of what your agents did and what it cost, kept on your machine.": "에이전트가 무엇을 했고 비용이 얼마였는지, 내 컴퓨터에 보관하는 기록.",
  status: "상태",
  early: "초기 버전",
  Language: "언어",
  Footer: "푸터",
  Start: "시작하기",
  Use: "사용하기",
  Project: "프로젝트",
  More: "기타",
  Quickstart: "빠른 시작",
  Agents: "에이전트",
  "All docs": "전체 문서",
  Cost: "비용",
  Evals: "평가",
  Experiments: "실험",
  SDK: "SDK",
  Changelog: "변경 내역",
  Blog: "블로그",
  GitHub: "GitHub",
  License: "라이선스",
  Compare: "비교",
  Privacy: "개인정보 보호",
  FAQ: "자주 묻는 질문",
  "llms.txt": "llms.txt",

  // Nav and layout (components/Nav.astro, layouts/Layout.astro)
  Docs: "문서",
  Menu: "메뉴",
  "Close menu": "메뉴 닫기",
  Primary: "메인 메뉴",
  "coding.sh home": "coding.sh 홈",
  "Stars: {{N}}": "스타: {{N}}",
  "Copied to clipboard": "클립보드에 복사했습니다",
  "Selected, copy it with your keyboard": "선택했습니다. 키보드로 복사하세요",
  "Skip to content": "본문으로 건너뛰기",
} satisfies Record<string, string>;
