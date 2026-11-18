// Japanese (/ja). Each key is the English string exactly as the source has it; keep
// {{PLACEHOLDERS}}, <code> and <span> as they are. See src/i18n/home.ts.
export default {
  // <title> and meta description (pages/index.astro)
  "coding.sh: open-source observability and evals for AI agents": "coding.sh：AI エージェントの可観測性と評価（オープンソース）",
  "Record what Claude Code, Codex, Cursor and 9 other AI agents did and what it cost, then test changes with evals. Local-first and open source.":
    "Claude Code、Codex、Cursor など 12 種類の AI エージェントの作業内容と費用を記録し、変更を評価でテストします。ローカルファーストのオープンソース。",

  // Hero (landing/body.html)
  "The Observability Layer for&nbsp;Agents.": "エージェントのための可観測性レイヤー。",
  "Record, measure, compare and benchmark every agent&nbsp;run.": "エージェントの実行をすべて記録し、測定し、比較し、ベンチマークする。",
  "Copy the install command: {{INSTALL}}": "インストールコマンドをコピー：{{INSTALL}}",
  "Copy the setup prompt for your coding agent": "コーディングエージェント用のセットアッププロンプトをコピー",
  "Free and open source. <a href=\"{{RELEASE_HREF}}\">What's new in coding.sh <code>v{{RELEASE}}</code></a>":
    "無料のオープンソース。<a href=\"{{RELEASE_HREF}}\">coding.sh <code>v{{RELEASE}}</code> の新機能</a>",
  "Get started": "はじめる",
  "Works with": "対応エージェント",

  // The flow diagram (landing/flow.html)
  "Every agent, one record": "すべてのエージェントを、ひとつの記録に",
  "Your agents on one side. Sessions, cost and evals on the other.": "片側にエージェント、もう片側にセッション、費用、評価。",
  "The agents you use feed coding.sh, which keeps their sessions, cost, evals, experiments, benchmarks, gateway costs and SDK traces.":
    "使っているエージェントのデータが coding.sh に集まり、セッション、費用、評価、実験、ベンチマーク、ゲートウェイの費用、SDK のトレースとして保存されます。",
  sessions: "セッション",
  cost: "費用",
  evals: "評価",
  experiments: "実験",
  benchmarks: "ベンチマーク",
  gateways: "ゲートウェイ",
  sdk: "SDK",

  // The three steps and the drawing (landing/body.html, landing/trace.html)
  "How to start": "はじめかた",
  Install: "インストール",
  "Run the command above. It finds the agents you use and asks before it changes their settings.":
    "上のコマンドを実行します。使っているエージェントを見つけ、設定を変える前に確認を求めます。",
  "Keep working": "いつも通り作業する",
  "Use your agents the way you do now. Each session is saved on your machine as it runs.":
    "エージェントはこれまで通りに使ってください。各セッションは実行中に手元のマシンへ保存されます。",
  "Open the viewer": "ビューアーを開く",
  "Run <code>coding.sh ui</code> to see every session and where it broke.": "<code>coding.sh ui</code> を実行すると、すべてのセッションと、それぞれどこで失敗したかを確認できます。",
  "A drawing of one agent's session as a level line, left to right, with the time under it. The agent hands a task to a subagent, which branches off above the line and comes back. Each model call drops to a gateway below the line, where its cost is written. Later one step fails, in red, and the last one passes, in green.":
    "あるエージェントのセッションを、左から右へ伸びる水平線として描いた図。線の下には経過時間が書かれています。エージェントはタスクをサブエージェントに渡し、サブエージェントは線の上へ分岐し、また戻ってきます。モデル呼び出しはそれぞれ線の下のゲートウェイに降り、そこに費用が書かれます。その後、あるステップが失敗して赤になり、最後のステップは成功して緑になります。",

  // What you can do with it (landing/body.html)
  "What you can do with it": "できること",
  "Read a session, add up what it cost, test a change, and track the AI calls your own app makes.":
    "セッションを読み、かかった費用を合計し、変更をテストし、自分のアプリが行う AI 呼び出しを追跡します。",
  "Find the step that broke": "失敗したステップを見つける",
  "Open any session to see each prompt, command and file edit in order. When a command fails, the lines that say why are marked red.":
    "どのセッションでも、プロンプト、コマンド、ファイル編集を順番に確認できます。コマンドが失敗すると、原因を示す行が赤で表示されます。",
  "A Claude Code session in the coding.sh viewer: its title, agent, duration and estimated cost, then its steps in order. The npm test run is red because one test failed. A few steps later the agent edits src/store/sqlite.ts to fix it.":
    "coding.sh ビューアーで開いた Claude Code のセッション：タイトル、エージェント、所要時間、推定費用と、順番に並んだステップ。テストが 1 件失敗したため、npm test の実行が赤になっています。数ステップ後、エージェントが src/store/sqlite.ts を編集して直します。",
  "See what each agent costs": "エージェントごとの費用を見る",
  "Output of coding.sh usage": "coding.sh usage の出力",
  "Track cost per session": "セッションごとの費用を追跡する",
  "Test a change to AGENTS.md": "AGENTS.md の変更をテストする",
  "what coding.sh reports": "coding.sh が報告する結果",
  "Tasks passed went from {{BASE_RATE}}% before to {{CAND_RATE}}% after": "タスクの成功率は、変更前の {{BASE_RATE}}% から変更後の {{CAND_RATE}}% になりました",
  "The same {{TASKS}} tasks, {{RUNS}} runs each, before and after.": "同じ {{TASKS}} 件のタスクを各 {{RUNS}} 回、変更前と変更後に実行。",
  "Test an AGENTS.md or skill change": "AGENTS.md やスキルの変更をテストする",
  "Track the AI calls in your app": "アプリの AI 呼び出しを追跡する",
  "Each request shows up with its model, tokens, cost and time.": "リクエストごとに、モデル、トークン数、費用、所要時間が表示されます。",
  "Read the SDK guide": "SDK ガイドを読む",

  // Questions (landing/body.html, pages/index.astro)
  Questions: "よくある質問",
  "Short answers here. The long ones are in the docs.": "ここでは手短に答えます。詳しくはドキュメントをご覧ください。",
  'Read the docs FAQ <span aria-hidden="true">→</span>': 'ドキュメントの FAQ を読む <span aria-hidden="true">→</span>',
  "Does anything leave my machine?": "データがマシンの外に出ることはありますか？",
  "No session data. The only default request is a daily update check (off with CODING_SH_NO_UPDATE_CHECK=1). Sessions are saved in ~/.coding.sh and nothing else is sent unless you set up an export yourself.":
    "セッションのデータは出ません。デフォルトで行うリクエストは 1 日 1 回の更新確認だけです（CODING_SH_NO_UPDATE_CHECK=1 で無効化できます）。セッションは ~/.coding.sh に保存され、自分でエクスポートを設定しない限り、ほかには何も送信されません。",
  "Will it slow my agent down?": "エージェントが遅くなりませんか？",
  "No. The hook adds one line to a file and exits. The rest of the work happens after the session.":
    "なりません。フックはファイルに 1 行書き込んで終了します。残りの処理はセッションの後で行われます。",
  "Does it change my agent's settings?": "エージェントの設定は変更されますか？",
  "Only after you say yes. It backs up each file first, and coding.sh uninstall takes its hooks out again.":
    "承認した場合だけです。先に各ファイルをバックアップし、coding.sh uninstall でフックを取り除けます。",
  "What does it cost?": "費用はかかりますか？",
  "Nothing. Your model spend stays what your agents already cost.": "かかりません。モデルの利用料は、今エージェントにかかっている分のままです。",

  // Closing (landing/body.html)
  "Try it on your next session": "次のセッションで試してみる",

  // Footer (pages/index.astro)
  "A record of what your agents did and what it cost, kept on your machine.": "エージェントが何をして、いくらかかったかの記録。手元のマシンに保存されます。",
  status: "ステータス",
  early: "開発初期",
  Language: "言語",
  Footer: "フッター",
  Start: "はじめに",
  Use: "使い方",
  Project: "プロジェクト",
  More: "その他",
  Quickstart: "クイックスタート",
  Agents: "エージェント",
  "All docs": "ドキュメント一覧",
  Cost: "費用",
  Evals: "評価",
  Experiments: "実験",
  SDK: "SDK",
  Changelog: "変更履歴",
  Blog: "ブログ",
  GitHub: "GitHub",
  License: "ライセンス",
  Compare: "比較",
  Privacy: "プライバシー",
  FAQ: "FAQ",
  "llms.txt": "llms.txt",

  // Nav and layout (components/Nav.astro, layouts/Layout.astro)
  Docs: "ドキュメント",
  Menu: "メニュー",
  "Close menu": "メニューを閉じる",
  Primary: "メイン",
  "coding.sh home": "coding.sh ホーム",
  "Stars: {{N}}": "スター：{{N}}",
  "Copied to clipboard": "クリップボードにコピーしました",
  "Selected, copy it with your keyboard": "選択しました。キーボードでコピーしてください",
  "Skip to content": "本文へスキップ",
} satisfies Record<string, string>;
