# Competitive gap analysis: coding.sh vs the agent observability + evals market

Compiled 2026-11-06. Our side was checked against the tree in `packages/coding.sh/src`. Market
facts come from official docs, pricing pages, changelogs and `gh api`, gathered by five research
passes; each claim cites its URL. **[U]** marks a point a pass could not confirm on an official
page. Star counts are as of 2026-11-06.

The user's goal: "figure out what we are missing, we should be the best on the whole market for open
source." The short answer:

- coding.sh is already **ahead of every open-source tool** on eval validity for coding agents:
  - replay from the pre-agent repo snapshot
  - verifier validation and test-tamper detection
  - paired statistics with power warnings
  - judge calibration gates
  - harness A/B
  - tool-surface evals
  - capture of 13 agents, including history backfill
- It is **behind on the production-observability layer** that Langfuse, Opik, MLflow and LangSmith treat
  as table stakes:
  - a scores API
  - online evals on captured traces
  - annotation queues
  - time-series dashboards and alerts
  - a query/export surface
  - native SDKs
  - a CI action
  - computed cost for agents that do not report it
  - user/tag/environment attributes
- None of those conflicts with local-first. They are SQLite queries, a viewer page and a small runner.
  Closing them, while not building the team/cloud layer, is the path to "best OSS".

---

## 1. What coding.sh has today (honest inventory)

Source: `src/cli/registry.ts`, `src/schema/index.ts`, `src/otel/map.ts`, `src/viewer/*`, `src/{eval,datasets,graders,judge,experiments,toolevals,workflows,integrations,stats,runner,sinks,store}`,
`CHANGELOG.md`, `docs/*.md`.

### Capture and tracing

- **Agents (13):** claude-code, codex, opencode, cursor, gemini-cli, antigravity, copilot-cli, amp, pi,
  droid, goose, aider, plus a generic `run -- <cmd>` wrapper.
  - Hooks append to a spool and never block the agent.
  - `ingest --backfill` imports each agent's existing local history.
  - Every adapter has fixture tests.
- **Trace format:** an open format, `coding.sh/trace` v0.
  - 16 event kinds: session, messages, `llm.call`, tool start/end, subagent start/end,
    `file.change`, `test.result`, `context.compact`, span, error.
  - Deterministic ids give idempotent re-ingest.
  - Raw payloads are kept as blobs, so events can be re-normalized later.
- **Repo state is first-class.** Shadow-git snapshots of the full working tree are taken at session
  start, turn end and session end, without touching user refs.
- **Subagents** are linked to their child sessions through `Session.parent`.
- **Latency:**
  - `LatencyStats` holds wall time, LLM p50/p95, TTFT p50 and tool p95.
  - Each `llm.call` carries model, usage, duration and TTFT.
- **Session flags:** `premature-completion`, `repeated-tool-failure`, `no-verification`, `compaction`.
- **OTLP/HTTP receiver** (`coding.sh collector`, 127.0.0.1:4318, JSON or protobuf). It maps:
  - OTel GenAI semconv (current and legacy names)
  - OpenInference
  - Vercel AI SDK `ai.*`
  - Claude Code, Codex and Gemini CLI log events
  - conversation ids (`gen_ai.conversation.id`, `session.id`, LangSmith thread ids)

  It also has an enrichment hook for framework integrations (eve).
  - **Not mapped:** `/v1/metrics` is accepted and dropped. `user.id`/`enduser.id`, tags,
    environment, release, and the `langfuse.*`, `mlflow.*` and `traceloop.*` attribute namespaces
    are not mapped.
- **Sinks:** OTLP/HTTP export with GenAI names (schema 1.37) and a generic HTTP sink. Both are
  metadata-only by default.
- **Storage:**
  - One `node:sqlite` index (WAL, FTS5) plus a content-addressed, zstd-compressed blob store.
  - The pluggable `IndexStore`/`BlobStore` interface has `sqlite://`, `memory://` and `file://`
    built-ins and third-party schemes by package.
  - `gc` handles retention and compaction.
  - Zero runtime dependencies; Node ≥ 22.15.
- **Privacy:**
  - Secret redaction (vendor-prefix rules) runs before anything is written.
  - Nothing leaves the machine unless you configure a sink.

### Explore

- **CLI commands:** `sessions`, `show` (timeline with subagents and latency), `search` (FTS over
  prompts, replies and tool calls).
- **Local viewer** (`coding.sh ui`, vanilla JS, `src/viewer/ui/index.html`):
  - Pages: session list with filters, session timeline with panes, full-text search, an
    Experiments page, and pass/fail outcome labels.
  - The JSON API is read-only except for labels: `/api/sessions`, `/api/sessions/:id/events`,
    `/api/blobs`, `/api/search`, `/api/tasks`, `/api/runs`, `/api/bundles`, `/api/labels` (GET/POST),
    `/api/stats`.
  - `/api/stats` returns only totals, broken down by agent, flag and repo.

### Evaluate

- **Eval tasks:** `eval new <session>` turns a captured session into a task. The task is the
  pre-agent snapshot + instruction + setup + verifier + hidden tests.
- **`eval validate`** checks that:
  - the no-op attempt fails
  - the reference passes k/k
  - near-misses fail
  - no leakage
  - impossible variants fail (an ImpossibleBench-style gameability check)
  - pass-to-pass holds
- **Export:** coding.sh and Harbor formats.
- **Datasets:** immutable content-hashed versions, a latest pointer, train/dev/test splits, and
  JSONL/JSON/CSV import. Cases can come from sessions.
- **Graders:**
  - exact, contains, regex, numeric, similarity, json-path, json-schema
  - command, function, module
  - LLM judge (Anthropic, OpenAI-compatible, OpenRouter, Ollama)
  - checklist judge with critical gates
  - deterministic trace predicates
  - judge cache and rate limiter
- **Judge calibration:**
  - A judge counts only at Cohen's κ ≥ 0.6 on ≥ 20 held-out human labels.
  - In-sample κ is never reported as calibrated.
  - Rogan–Gladen bias correction.
  - Checklist diagnostics.
- **Experiments** (`exp run|compare|list`). Tasks are command or HTTP.
  - Statistics: paired bootstrap CI, exact McNemar, Wilson intervals, MDE/power warnings, pass^k.
- **Harness lab:**
  - `harness snapshot` content-hashes CLAUDE.md, AGENTS.md, skills, hooks, MCP, flags and model
    into a bundle.
  - `compare A B` runs paired A/B across tasks with k runs, the first step where the arms'
    traces diverge, and a test-tamper rate.
- **Tool evals** (`toolevals init|surface|validate|run|compare|compress|show`):
  - Surface bytes and tokens per tool, for CLI, MCP and HTTP targets.
  - Tap proxies record what the tool actually received.
  - Agent and raw-model drivers.
  - MCP description compression under a non-inferiority margin.
- **Workflows** (`workflows list|import|show|stats|score|run|compare|replay`): multi-agent run trees,
  critical path, gantt, and stage-level replay.
  - `docs/WORKFLOWS.md` and `docs/TOOL-EVALS.md` still say "not implemented"; the code exists.
- **Integrations:** eve (span enrichment, trace importer, stream mapper, experiment task).

### In flight / queued (not counted as gaps below)

- **Being built now:** MCP server, update alerts (version notices, *not* observability alerts),
  zero-setup init.
- **Queued in `tasks/research-queue.md`:**
  - **round 1:**
    - judge injection hardening
    - OTel cached-token fix and reasoning/skill/compaction attributes (#9)
    - runner auto-OTel (#13)
    - top-level session list and subagent tree in the viewer (#16)
    - tool-failure classes (#11)
    - new session flags (#12)
    - ATIF export (#24)
  - **round 2:**
    - `refine mine/propose/test/apply/watch` (R2-5..9)
    - sequential experiments (R2-10)
    - Holm–Bonferroni and non-inferiority helpers (R2-3)

### Real gaps found in our own tree while checking

- `README.md` still describes the old NeetCode walkthrough site. Fix it before any positioning
  claim ships.
- No model price table exists. `costUsd` is set only when the agent reports it
  (`adapters/_shared/normalize.ts:100`). Interactive Claude Code, Codex hook and transcript sessions
  therefore usually have tokens but **no cost**. Every competitor, and ccusage, computes cost from
  tokens.
- `Label` is pass/fail/skip only. It has no numeric, categorical or text value and no source type
  (human, judge, code, api), so it cannot act as a scores API.

---

## 2. The market (Nov 2026)

### 2.1 Langfuse, the reference OSS competitor

- **Company and repo:**
  - ClickHouse acquired Langfuse on 2026-01-16 alongside its $400M Series D. Core stays MIT.
    <https://langfuse.com/blog/joining-clickhouse>
  - Repo: 37.1k stars, MIT except the `ee/` directories. <https://github.com/langfuse/langfuse>,
    <https://github.com/langfuse/langfuse/blob/main/LICENSE>
- **v4** (GA 2026-08-17) moved to an observations-first data model.
  <https://langfuse.com/changelog/2026-08-17-langfuse-v4>
  - On Cloud, from 2026-11-16, `/api/public/ingestion` accepts only scores. Everything else must
    arrive through OTel. <https://langfuse.com/docs/observability/sdk/overview>
- **SDKs:** Python v5 and JS v6, both OTel-based, with `@observe()`/`observe()`.
  <https://langfuse.com/changelog/2026-10-14-python-sdk-v5-js-sdk-v6>
- **OTel endpoint:** `/api/public/otel`, HTTP only (no gRPC). It maps GenAI semconv, OpenInference,
  MLflow and `langfuse.*` attributes. <https://langfuse.com/integrations/native/opentelemetry>
- **Integrations:** 135 integration pages ("100+").
  <https://github.com/langfuse/langfuse-docs/tree/main/content/integrations>
- **Features:**
  - **Tracing:** sessions, users, environments, tags, agent graphs (aggregated and as-run).
    <https://langfuse.com/changelog/2026-07-13-graph-view-modes>
  - **Prompts:** prompt management with labels, a playground (open a traced generation in it), and
    prompt webhooks. <https://langfuse.com/docs/prompt-management/features/playground>
    - Skill Management beta (versioned SKILL.md folders linked to traces, 2026-11-03).
      <https://langfuse.com/docs/skill-management/overview>
  - **Datasets, experiments and CI:** datasets (multimodal) and experiments via SDK/UI.
    - CI/CD gates in GitHub Actions (2026-05-25). <https://langfuse.com/changelog/2026-05-25-experiment-ci-cd-gates>
    - Experiment comparison redesign (2026-10-19). <https://langfuse.com/changelog/2026-10-19-experiments>
  - **Evaluation:** online LLM-as-judge and code evaluators with filters, sampling, backfills and
    a template gallery that includes coding agents. <https://langfuse.com/docs/evaluation/get-started/online>,
    <https://langfuse.com/changelog/2026-08-24-evaluator-template-gallery>
    - Annotation queues. <https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues>
    - Scores API v3. <https://langfuse.com/changelog/2026-06-10-scores-v3-api>
  - **Dashboards and alerts:** custom dashboards and Metrics API v2.
    <https://langfuse.com/docs/metrics/features/custom-dashboards>
    - Monitors and alerts to Slack, webhooks and PagerDuty. <https://langfuse.com/docs/observability/features/alerts>
  - **Exports:** blob exports (Parquet) and PostHog/Mixpanel.
    <https://langfuse.com/changelog/2026-07-08-parquet-blob-storage-exports>
  - **Agent tooling:**
    - Authenticated MCP server (read and write). <https://langfuse.com/docs/api-and-data-platform/features/mcp-server>
    - CLI v1. <https://langfuse.com/changelog/2026-08-21-langfuse-cli-v1>
    - Agent Skill. <https://langfuse.com/docs/api-and-data-platform/features/agent-skill>
    - Halo, an in-app assistant. <https://langfuse.com/changelog/2026-09-03-langfuse-assistant>
  - **AI Gateway** beta (2026-11-04). <https://langfuse.com/docs/gateway/overview>
- **Coding agents:** plugins or hooks for Claude Code, Codex (with skill tags), Cursor, Copilot,
  OpenCode, Kiro, Augment and Pi, plus a gateway mode.
  <https://langfuse.com/integrations/developer-tools/claude-code>,
  <https://langfuse.com/integrations/developer-tools/codex>
  - Langfuse's own write-up admits it cannot see the assembled CLAUDE.md or skills context.
    <https://langfuse.com/resources/engineering/coding-agent-tracing>
- **License split:**
  - **Enterprise only (EE):** project RBAC, protected prompt labels, data retention policies, audit
    logs, server-side masking, SCIM/org API, S3 IAM auth. <https://langfuse.com/self-hosting/license-key>
  - **MIT:** enterprise SSO and org RBAC. <https://langfuse.com/pricing-self-host>
- **Cloud pricing:** Hobby is free (50k units, 30 days, 2 users); Core $29; Pro $199; Teams add-on
  +$300; Enterprise $2,499/mo. <https://langfuse.com/pricing>
- **Weaknesses:**
  - **Self-hosting needs** Postgres + ClickHouse (≥ 25.12) + Redis + S3.
    <https://langfuse.com/self-hosting>
  - **Compose needs** ≥ 4 cores and 16 GiB, with no HA or backups.
    <https://langfuse.com/self-hosting/deployment/docker-compose>
  - **Disk use:** a terabyte of ClickHouse after months on a laptop.
    <https://news.ycombinator.com/item?id=49661637>
  - **Upgrade pain:**
    - v3→v4 migration failures. <https://github.com/langfuse/langfuse/issues/19840>
    - Forced SDK and ingestion churn.
  - **No embedded or offline mode** (inferred from the docs tree).

**Langfuse changelog, May–Nov 2026 (highlights).** Each entry is at
`https://langfuse.com/changelog/<date-slug>`.

| Month | Releases |
|---|---|
| May | SSO self-service, experiment CI/CD gates, code evaluators, MCP expansion |
| Jun | Scores v3, export-stage masking, web callouts, Halo beta, monitors and alerts, multimodal datasets |
| Jul | experiments API/MCP, Parquet exports, tool-call evaluation, Home dashboard, graph modes, dashboards via API/CLI/MCP, Pulse |
| Aug | deterministic sampling, prompt bulk I/O, **v4 GA**, CLI 1.0, reusable evaluators, evaluator template gallery |
| Sep | multimodal judge prompts, evaluator alerts, Halo sandbox, backfills |
| Oct | API-key expiry/scopes, session view redesign, **SDK v5/v6**, experiments redesign, FIPS |
| Nov | PagerDuty, Skill Management beta, **AI Gateway beta**, tokenization retired |

Source: <https://github.com/langfuse/langfuse-docs/tree/main/content/changelog>

### 2.2 Open-source and self-hostable field

| Product | Stars / license | Self-host weight | Notes (2026) |
|---|---|---|---|
| **Arize Phoenix** | 12.2k, Elastic 2.0 (not OSI) | `pip install`, SQLite single process; Postgres for production | See below the table |
| **Comet Opik** | 23.2k, Apache-2.0 (user management paid) | Heavy: MySQL, ClickHouse, Redis, ZooKeeper, MinIO, Java+Python, about 10 services | See below the table |
| **MLflow GenAI 3.x** | 28.7k, Apache-2.0 | Python server, SQLite default; telemetry on by default | See below the table |
| **Laminar** (lmnr.ai → laminar.sh) | 3.5k, Apache-2.0 + license-key features | Postgres, ClickHouse, Quickwit, Rust | See below the table |
| **OpenLIT** | 3.0k, Apache-2.0 → open-core | ClickHouse required; no cloud | See below the table |
| **Pydantic Logfire** | 4.5k (SDK MIT); platform closed | Enterprise k8s only | See below the table |
| **Helicone** | 6.3k, Apache-2.0 | Postgres, ClickHouse, Kafka… | **Maintenance mode** after the Mintlify acquisition (2026-03-03); ownership unclear since. <https://www.mintlify.com/blog/mintlify-acquires-helicone>, <https://www.helicone.ai/> |
| **Lunary** | repo private since Nov 2025 | Enterprise-only self-host | No free tier for new signups. <https://lunary.ai/pricing>, <https://docs.lunary.ai/more/self-hosting/docker.md> |
| **Agenta** | 4.9k, MIT + ee/ | Compose | **Pivoted** to an "agent workspace" on 2026-07-18; LLMOps docs frozen at v1.0. <https://github.com/Agenta-AI/agenta/commit/9a4c9458380311b5285a27d097165830f1763384> |
| **Langtrace** | 1.2k, AGPL-3.0 | Postgres, ClickHouse | **Dormant**: last release 2025-04, site returns 404. <https://github.com/Scale3-Labs/langtrace> |
| **W&B Weave** | 1.1k, Apache-2.0 SDK | Licensed W&B Server + ClickHouse | Being folded into CoreWeave "Agent Lens". <https://docs.coreweave.com/weave/> |

More detail on the active products:

- **Arize Phoenix**
  - **Ingest:** OpenInference native; converts GenAI semconv at ingest.
    <https://arize.com/docs/phoenix/release-notes/05-2026/05-15-2026-otel-semconv-conversion>
  - **CI:** pytest/Vitest gates. <https://arize.com/docs/phoenix/release-notes/06-2026/06-26-2026-eval-ci-pytest-vitest-jest>
  - **Tooling:** `px` CLI, remote MCP, PXI agent.
  - **Coding agents:** coding-harness-tracing for 7 coding agents.
    <https://github.com/arize-ai/coding-harness-tracing>
  - **AX-only (paid tier):** online evals and annotation queues.
- **Comet Opik**
  - Online rules and annotation queues that fill themselves.
  - Guardrails.
  - SimulatedUser for multi-turn simulation.
  - Agent optimizer (GEPA, and tunes MCP schemas).
  - Claude Code plugin.
  - "Ollie" coding agent.
  - <https://www.comet.com/docs/opik/changelog>
- **MLflow GenAI 3.x** — the closest direct threat.
  - **Tracing:** OTLP `/v1/traces` with GenAI semconv; sessions; graph view.
  - **Evals:** online judges, review queues, conversation simulation, `@mlflow.test` pytest gates,
    issue detection.
  - **Tooling:** `mlflow mcp`.
  - **Coding agents:** `mlflow autolog claude`, plus Codex, Gemini, Qwen, OpenCode and Hermes.
  - <https://mlflow.org/docs/latest/genai/tracing/integrations/listing/claude_code>,
    <https://mlflow.org/docs/latest/genai/eval-monitor/regression-testing>
- **Laminar**
  - **Signals:** online evals and clustering, Enterprise only.
  - **Debugger:** reruns the agent from cache.
  - SQL editor and MCP.
  - **Coding agents:** Claude Code, Codex, OpenCode, Pi.
  - **Agent versions** keyed to a git SHA. <https://laminar.sh/docs/tracing/agent-versions>
  - <https://laminar.sh/docs/debugger/introduction>
- **OpenLIT**
  - OTel-native.
  - Guardrails and governance packs.
  - Hook capture for 5 coding agents.
  - **Enterprise only:** alerts and RBAC.
  - <https://docs.openlit.io/latest/openlit/coding-agents/overview.md>, <https://openlit.io/pricing>
- **Pydantic Logfire**
  - SQL everywhere.
  - SQL alerts.
  - Remote MCP with arbitrary SQL.
  - Claude Code plugin.
  - Live evals.
  - Self-hosting is Enterprise only.
  - <https://pydantic.dev/docs/logfire/guides/mcp-server/>,
    <https://github.com/pydantic/claude-code-logfire-plugin>

What the field shows:

- **Coding-agent tracing is now expected.** Phoenix, Opik, Laminar, OpenLIT, MLflow, Logfire and Langfuse
  all shipped Claude Code and Codex capture in 2026.
- **None of them** links a trace to repo snapshots, diffs and test results, or replays from the
  pre-agent tree.
- **Only Phoenix, MLflow and Raindrop Workshop** run on SQLite without Docker.
- **Users without a home:** Helicone, Lunary, Agenta and Langtrace users have lost their OSS option.

### 2.3 Closed leaders (where the bar is set)

Every leader shipped the same 2026 loop: production traces are clustered into ranked issues, then
diagnosed, then handed to a coding agent through MCP or a PR.

- **LangSmith**
  - **Tracing and evals:** threads; OTel (GenAI, OpenInference, Traceloop, Logfire); online
    evaluators (LLM, code, multi-turn, decision models); pairwise annotation queues; multi-turn
    simulation.
  - **CI and alerts:** pytest/Vitest; alerts to Slack, PagerDuty and webhooks.
  - **Tooling:** MCP and CLI.
  - **Assistants and issue detection:** Insights clustering; Polly/Chat; Engine opens fix PRs.
  - **Coding agents:** a Claude Code plugin and a "coding-agent-v1" metadata contract (repo,
    branch, commit, subagent).
  - **Hosting and pricing:** self-host is Enterprise only. Developer is $0 for 5k traces; Plus is
    $39/seat.
  - Sources: <https://docs.langchain.com/langsmith/coding-agent-metadata-contract.md>,
    <https://docs.langchain.com/langsmith/engine.md>, <https://www.langchain.com/pricing>
- **Braintrust**
  - **SDKs:** 6 languages.
  - **Evals and CI:** experiments with diff mode and pairwise win rates. **eval-action** posts
    score deltas as a PR comment. <https://github.com/braintrustdata/eval-action>
  - **Assistants and issue detection:** Loop (an agent with approved writes); Topics and Patterns
    clustering.
  - **Coding agents:** `bt trace enable claude` plus `bt trace import` for past sessions.
    <https://docs.braintrust.dev/integrations/developer-tools/claude-code.md>
  - **Hosting:** self-host is Enterprise-only hybrid.
  - **Pricing:** $0 or $249/mo. <https://www.braintrust.dev/pricing>
- **Judgment Labs**
  - **SDK:** judgeval (Apache-2.0); the platform is closed.
  - **Judges:** code, agent and decision-model judges; judge-to-human alignment.
  - **Issues:** root-cause groups with "Fix with Claude Code/Codex".
  - Deprecated its CLI and prompt management (Oct 2026).
  - **Hosting:** BYOC.
  - Sources: <https://docs.judgmentlabs.ai/documentation/issues/overview>,
    <https://www.judgmentlabs.ai/pricing>
- **Galileo**
  - **Acquired** by Cisco (closed 2026-05-22).
  - **Now** "Splunk Agent Observability".
  - **Evaluators:** Luna-2 small evaluator models.
  - **Issue detection:** Signals.
  - Deprecated the Protect guardrails (Jun 2026) in favour of open-source Agent Control.
  - Sources: <https://www.splunk.com/en_us/about-splunk/acquisitions/galileo.html>,
    <https://docs.galileo.ai/concepts/protect/overview.md>
- **Raindrop**
  - **Signals:** natural-language classifiers with a 90-day backfill.
  - **Issues:** Stumbles → Issues.
  - **Triage:** a triage agent.
  - **Simulations** (beta, 2026-11-05): replay production events against PR code in a sandbox and
    post results as a PR comment. <https://raindrop.ai/docs/platform/simulations.md>
  - **Workshop** (MIT, local on SQLite) is the closest local analog to coding.sh.
    <https://github.com/raindrop-ai/workshop>
  - **Pricing:** $0 for 1k events, or $299/mo.

### 2.4 Coding-agent-specific tools

- **git-ai** (Apache-2.0, about 2.9k stars) records line-level AI attribution in Git Notes.
  <https://github.com/git-ai-project/git-ai>
  - **Agent Trace** (an RFC from Cursor and partners) is a shared attribution format.
    <https://agent-trace.dev/>
- **Entire CLI:** checkpoints tied to commits, with rewind and resume. <https://docs.entire.io/cli/overview>
- **Claude Code built-ins:**
  - **`/usage`:** per-skill, MCP and subagent cost, plus "trim CLAUDE.md" advice.
    <https://code.claude.com/docs/en/costs>
  - **`/insights`:** LLM report over 200 sessions. Same page.
  - **OTel metrics:** lines of code, commits, PRs, edit decisions; `vcs.ref.head.revision` on
    commits. <https://code.claude.com/docs/en/monitoring-usage>
  - **Analytics API:** <https://platform.claude.com/docs/en/api/claude-code-analytics-api>
  - **`claude plugin eval`:** evals with a no-plugin baseline and CI gating.
    <https://code.claude.com/docs/en/plugin-evals>
- **Codex:** OTel events and an enterprise dashboard. <https://developers.openai.com/codex/enterprise/governance>
- **Cursor:** AI Code Tracking API. Users are asking for a native trace viewer.
  <https://forum.cursor.com/t/native-agent-observability-sessions-mcp-tool-spans-export-hooks-are-not-enough/170626>
- **Copilot:** metrics API. <https://docs.github.com/en/copilot/concepts/billing-and-usage/copilot-usage-metrics/copilot-metrics>
- **ccusage** (MIT, about 19.3k stars): local token and cost accounting for 18 agents.
  <https://github.com/ryoppippi/ccusage>
- **Session archives:** SpecStory and others. <https://github.com/specstoryai/getspecstory>
- **Harbor** (about 6.9k stars): Terminal-Bench harness. <https://github.com/harbor-framework/harbor>
- **Inspect SWE.** <https://meridianlabs-ai.github.io/inspect_swe>
- **promptfoo Claude Agent SDK provider:** A/B across CLAUDE.md configs.
  <https://www.promptfoo.dev/docs/providers/claude-agent-sdk/>
- **AgentOps** (MIT): framework SDKs only, no coding-agent support.
  <https://github.com/AgentOps-AI/agentops>
- **Sentry:** monitors your own agents and MCP servers, not coding agents. <https://docs.sentry.io/ai/monitoring>
- **Datadog AI Agents Console:** Claude Code over OTLP (preview). <https://docs.datadoghq.com/ai_agents_console>

**What nobody ships:**
- Repo snapshots, trace spans and test results joined in one local store.
- Harness A/B tests with real statistics that link back to the captured sessions.
- Cross-agent session→commit attribution together with eval replay.

That is the core wedge for coding.sh.

---

## 3. Feature matrix

**Legend:**
- **Y** = yes. **P** = partial. **N** = no. **–** = not documented / [U].
- **$** = paid tier or Enterprise only. **EE** = source-available enterprise code.
- **(ip)** = in progress in our tree.

**Columns:**
- **cs** = coding.sh
- **LF** = Langfuse
- **Phx** = Phoenix
- **Opik**
- **MLf** = MLflow
- **Lam** = Laminar
- **OLIT** = OpenLIT
- **Logf** = Logfire
- **LS** = LangSmith
- **BT** = Braintrust
- **RD** = Raindrop (W = Workshop)

| Capability | cs | LF | Phx | Opik | MLf | Lam | OLIT | Logf | LS | BT | RD |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Tracing: sessions/threads** | Y | Y | Y | Y | Y | Y | Y | P | Y | Y | Y |
| Users / tags / environments | **N** | Y | P | Y | Y | Y | Y | P | Y | Y | Y |
| Agent graph view | P (CLI tree/gantt) | Y | $ | Y | Y | P | Y | – | – | – | P |
| Multi-agent / subagent linking | Y | Y | Y | Y | Y | Y | Y | P | Y | Y | Y |
| OTLP ingest (HTTP) | Y | Y | Y | Y | Y | Y (+gRPC) | Y | Y | Y | Y | Y |
| Semconv coverage | GenAI, OI, Vercel AI, CC/Codex/Gemini logs | GenAI, OI, MLflow, own | OI, GenAI | GenAI, OI | GenAI | own + GenAI | GenAI | GenAI | GenAI, OI, Traceloop, Logfire | GenAI, OI | – |
| OTel metrics ingest | **N** (dropped) | – | – | – | Y | – | Y | Y | – | – | – |
| Native SDKs | **N** (OTel + schema types) | Py, JS | Py, TS, Java, Go, .NET | Py, TS, Java, .NET | Py, TS, Java | Py, TS | Py, TS, Go | Py, JS, Rust | Py, JS, Java, Go | 6 langs | 8 langs |
| Framework integrations | ~5 dialects + eve | 100+ | ~100 | ~82 | ~76 | ~35 | ~63 | ~52 | many | many | ~10 |
| **Prompt management / versions** | **N** (harness bundles only) | Y (+skills) | Y | Y | Y | N | Y | Y | Y | Y | N |
| Playground / replay one LLM call | **N** | Y | Y | Y | Y | Y | Y | Y | Y | Y | N |
| **Datasets (versioned)** | Y | Y | Y | Y | Y | Y | – | Y | Y | Y | Y |
| Experiments + comparison | Y | Y | Y | Y | Y | Y | P | Y | Y | Y | P |
| Statistical rigor (CI, power, McNemar) | **Y** | P | – | – | – | – | – | – | – | P (win rates) | – |
| Online evals on captured traces | **N** | Y | $ | Y | Y | $ | Y | Y | Y | Y | Y |
| Judge calibration vs human labels | **Y** (κ gate) | – | – | – | P | – | – | – | P | – | P |
| Human annotation queues | **P** (outcome labels) | Y | $ | Y | Y | Y | P | Y | Y | Y | N |
| Scores / feedback API | **N** | Y | Y | Y | Y | – | – | – | Y | Y | Y |
| **Cost/latency dashboards** | **P** (per session, totals) | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Cost computed from tokens | **N** | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Custom dashboards / SQL | **N** | Y | P | Y | P | Y (SQL) | Y | Y (SQL) | Y | Y (SQL) | Y (RQL) |
| Alerts | **N** | Y | – | Y | P | $ | EE | Y | Y | Y | Y |
| Metrics API / export | P (local JSON, OTLP sink, `--json`) | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Webhooks | **N** | Y | – | Y | – | – | EE | Y | Y | Y | – |
| **Self-host weight** | **npm, SQLite, 0 deps** | PG+CH+Redis+S3 | pip, SQLite | ~10 services | py, SQLite | PG+CH+QW | CH | $ k8s | $ | $ hybrid | W: SQLite |
| Auth / RBAC / SSO | N/A (local, origin check) | Y / EE | Y / $ | $ | Y | Y | EE | $ | $ | $ | $ |
| Data retention | Y (gc) | EE | Y | plan | Y | plan | – | plan | plan | $ | plan |
| PII masking | P (secrets) | client / EE | client | Y | Y | Y | P | Y | Y | Y | Y |
| **CI gate / GitHub Action** | **P** (CLI only) | Y (GHA) | Y (pytest) | Y (pytest) | Y (pytest) | Y | P | P | Y | Y (Action, PR comment) | Y (PR sims) |
| Replay from trace | **Y** (repo snapshot) | P | P | P | P | Y (cached rerun) | P | P | P | P | Y |
| Comparisons / diffs | Y (paired, divergence step) | Y | Y | Y | Y | Y | – | Y | Y | Y | P |
| Guardrails | N (by design) | N | P | Y | P | N | Y | N | – | N | P (detect) |
| Agent simulation | N | N | N | Y | Y | N | N | N | Y | – | Y (beta) |
| Issue clustering / insights | P (flags; refine queued) | P | P | – | Y | $ | – | – | $ | Y | Y |
| **MCP server** | (ip) | Y | Y | Y | Y | Y | N | Y | Y | Y | Y |
| CLI | Y (primary UI) | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |
| Local-first / offline by default | **Y** | N | Y | P | Y (telemetry on) | P | P | N | N | N | W: Y |
| **Coding agents captured** | **13** + backfill | ~8 | 7 | 2 | 6 | 4 | 5 | 2 | 7 | 5 + import | 1 |
| Repo snapshots / diffs | **Y** | P | N | N | N | P (SHA) | N | N | P (metadata) | N | N |
| Test results in trace | **Y** | N | N | N | N | N | N | N | N | N | N |
| Session→commit attribution | **N** | N | N | N | N | N | N | N | P | N | P (change reports) |
| Harness A/B with stats | **Y** | N | N | N | N | N | N | N | N | P (`bt`) | N |
| Verifier validation / reward-hack checks | **Y** | N | N | N | N | N | N | N | N | N | N |
| Tool-use / tool-surface evals | **Y** | P | N | P (optimizer) | N | N | N | N | N | N | N |
| **License** | MIT (all) | MIT + ee/ | ELv2 | Apache | Apache | Apache + key | Apache → open-core | closed (SDK MIT) | closed | closed | closed (W: MIT) |
| Price | free | $0–2,499/mo | free / $50 | free / $19 | free | $0–150 | free | $0–249 | $0 / $39 seat | $0 / $249 | $0 / $299 |

Reading the matrix:
- We lead every coding-agent and eval-validity row.
- We trail on 12 rows: users/tags, OTel metrics, SDKs, prompts, playground, online evals, scores,
  cost computation, dashboards/SQL, alerts, webhooks and CI action.

---

## 4. Gaps, ranked

Scoring follows `tasks/research-queue.md`: (user value + scorecard gain) / effort, with S=1, M=2,
L=3. Items already queued (OTel cache fix, viewer subagent tree, refine, sequential experiments) are
**not** repeated here. Each item lists its dependencies.

### (a) Table stakes we lack: must build

| # | Item | Module | Effort | V+G | Score |
|---|---|---|---|---|---|
| C-1 | Model price table → computed `costUsd` for every `llm.call` that lacks one | src/core | S | 8 | 8.0 |
| C-2 | `coding.sh sql` (read-only SQL over the index) + `coding.sh export` (JSONL/CSV) | src/query | S | 6 | 6.0 |
| C-3 | Scores: typed scores replace pass/fail-only labels; scores API (`/api/scores`, CLI, OTel) | src/scores | M | 10 | 5.0 |
| C-4 | Online evals ("monitors"): judges/checklists/predicates run on newly ingested sessions with filter + sampling | src/monitors | M | 10 | 5.0 |
| C-5 | Local alerts: threshold rules on metrics/monitor scores → desktop, webhook, Slack | src/monitors | S | 5 | 5.0 |
| C-6 | Metrics view + `/api/metrics` (time series by agent/model/repo/tool, cost, latency, error and flag rates, score trends) | src/viewer | M | 9 | 4.5 |
| C-7 | CI gate + GitHub Action (`--gate`, step summary, PR comment, baseline from main) | src/ci | M | 9 | 4.5 |
| C-8 | Session attributes + more dialects: user/tags/env/release/metadata; `langfuse.*`/`mlflow.*`/`traceloop.*`; OTel metrics ingest; Langfuse-compatible OTLP path | src/otel | M | 8 | 4.0 |
| C-9 | Annotation queues in the viewer (queue from filter/flag/judge disagreement, keyboard review, score configs, feeds `judge calibrate`) | src/viewer | M | 8 | 4.0 |
| C-10 | PII redaction pack (email, phone, IP, card, custom regex) + `redact test` | src/core | S | 4 | 4.0 |
| C-11 | TypeScript SDK `coding.sh/sdk`: `observe`, `score`, `dataset`, `evaluate`, emitting GenAI semconv OTLP | src/sdk | M | 7 | 3.5 |
| C-12 | Python SDK (stdlib only): the same four verbs | packages/python | M | 7 | 3.5 |
| C-13 | Git-native prompt/instruction versions linked to traces, with per-version metrics | src/prompts | M | 6 | 3.0 |
| C-14 | LLM-call playground: re-run one `llm.call` with an edited prompt or model from the viewer | src/viewer | M | 6 | 3.0 |

### (b) Differentiators: where we clearly win

| # | Item | Module | Effort | V+G | Score |
|---|---|---|---|---|---|
| D-1 | Session→commit attribution + Agent Trace export (`coding.sh blame <file>:<line>`, `attribution export`) | src/attribution | M | 8 | 4.0 |
| D-2 | Harness cost attribution: tokens and cost per instruction file, skill, MCP server and subagent, across agents (a local, cross-agent `/usage`) | src/core | M | 7 | 3.5 |
| D-3 | Production→CI loop: `exp run --from-sessions <filter>` builds a dataset from flagged sessions, and the CI gate replays them against the PR (the local answer to Raindrop Simulations) | src/ci | M | 7 | 3.5 |

**Already ours; finish and market them:**
- zero-setup local install (ip)
- MCP server (ip)
- harness A/B with paired stats
- repo-snapshot replay with validated verifiers
- judge calibration gates
- tool-surface evals
- `refine` (queued)

Two adjustments to work already in flight:
- The MCP server should expose scores (C-3), SQL (C-2) and the monitors (C-4) once they land.
- `refine mine` (R2-5) should read monitor scores as findings.

### (c) Do NOT build

| Feature | Why not |
|---|---|
| Multi-tenant orgs, project RBAC, SCIM, audit logs, SSO | Single-user local tool. Teams get these by pointing the OTLP/HTTP sink at Langfuse/LangSmith/Datadog. Langfuse itself keeps most of these EE, so we would be rebuilding its paid tier. |
| Hosted cloud, billing, usage units | Conflicts with "nothing leaves the machine." Big ops burden, and no OSS advantage. |
| AI gateway / proxy in the request path | Violates principle 1 ("never slow the agent down"). LiteLLM and the Langfuse Gateway own this. |
| Runtime guardrails that block calls | Same latency and in-path problem. The market is moving away from it: Galileo deprecated Protect, and Langfuse only links out to recipes. Detection-only belongs in monitors (C-4). |
| In-product chat assistant (Halo/Loop/Polly clones) | The user already runs Claude Code or Codex. MCP + SQL + a skill make *their* agent the assistant, at zero cost and with no model lock-in. |
| ClickHouse/Postgres scale-out backend in core | The storage interface already allows a plugin package. Shipping it in core would break zero-deps and the single-file story. |
| Drag-and-drop custom dashboard builder | High UI cost. Saved SQL views (C-2) plus fixed metric panels (C-6) cover the need. |
| Parquet, BigQuery or Snowflake exporters | Need native dependencies. JSONL/CSV + OTLP + an SQLite file cover export. |
| Live-traffic A/B with feature flags (Raindrop Experiments) | Needs a production service. Offline paired A/B is our stronger, statistically honest version. |
| Fine-tuned classifier models (Luna, rd-signal) | Model-training ops. Calibrated judges plus deterministic predicates are our answer. |
| Multimodal media in traces | Low value for coding agents. Blobs already store anything. |
| Hosted prompt serving with an SDK cache | Coding-agent prompts live in git. C-13 links versions to traces without a serving tier. |
| Simulated-user multi-turn agent simulation | Coding tasks are single-instruction plus repo state. Replay from snapshot is the right simulator. Revisit only if chat-agent users ask. |

### Must-build specs (module, effort, acceptance, tests, dependencies)

The research queue carries these in its own entry format. Summary:

- **C-1 Pricing (src/core, S)**
  - **Build:**
    - `src/core/pricing.ts` with a bundled snapshot of per-model prices (input, output, cache read,
      cache write per 1M tokens).
    - The snapshot is generated by a script from LiteLLM's MIT `model_prices_and_context_window.json`.
    - Users can override prices with `[pricing."<model>"]` in config.
    - Ingest fills `usage.costUsd` only when it is absent and sets `payload.costSource =
      "computed"`. Reported costs win.
  - **Acceptance:**
    - A Claude Code transcript fixture with tokens and no cost gets a cost within 0.1% of a hand
      calculation.
    - A reported cost is never overwritten.
    - An unknown model leaves the cost unset and adds the model to a `doctor` warning.
  - **Tests:** a table test over 6 models; override precedence; cache-token pricing; session totals
    sum per event.
  - **Deps:** none (pairs with round-1 #9 so that cached-token splits are correct first).
- **C-2 SQL and export (src/query, S)**
  - **Build:**
    - `coding.sh sql "<SELECT…>"` opens the index read-only (`?mode=ro`) and rejects anything but
      SELECT/WITH. Prints a table or `--json`/`--csv`.
    - A `views` doc describes the stable tables.
    - `coding.sh export sessions|events|scores --format jsonl|csv --since`.
  - **Acceptance:**
    - Any write statement is rejected.
    - Output matches the `sessions --json` totals.
    - Exporting 100k events streams in constant memory.
  - **Tests:** read-only enforcement; CSV quoting; schema doc check (every documented column exists).
  - **Deps:** none.
- **C-3 Scores (src/scores, M)**
  - **Build:**
    - An additive `Score {id, target: session|event|case|run, targetId, name, value: number|string|boolean,
      dataType: numeric|categorical|boolean|text, source: human|judge|code|api|monitor, configId?,
      judgeVersion?, comment?, by, ts}`.
    - A `ScoreConfig` (name, type, range or categories).
    - Store methods.
    - `Label` becomes a view over boolean `outcome` scores, with a migration.
    - `POST/GET /api/scores` on the viewer server, with an origin check and optional token.
    - CLI `coding.sh score add|list`.
    - OTel ingest of `coding_sh.score.*` and Langfuse `langfuse.score` span events.
  - **Acceptance:**
    - Existing labels round-trip as scores.
    - `judge calibrate` reads scores.
    - Duplicate ids are idempotent.
  - **Tests:** store conformance for both backends; API validation (bad type or range gives 400);
    label migration; calibrate parity.
  - **Deps:** none; it is the foundation for C-4, C-5, C-6, C-7 and C-9.
- **C-4 Monitors (src/monitors, M)**
  - **Build:**
    - `coding.sh monitor add <name> --grader <spec> --filter 'agent=codex,flag=no-verification'
      --sample 0.2`.
    - It runs after each ingest batch, from a lazy hook at CLI/viewer start, and through
      `monitor run --backfill --since`.
    - It writes `source: monitor` scores carrying the judge version and calibration status.
    - A per-day token budget acts as a hard stop.
    - Deterministic sampling uses a hash of session id + monitor id.
  - **Acceptance:**
    - Re-running is idempotent.
    - An uncalibrated judge's scores are flagged in every view.
    - The budget stops the run.
    - Sampling is reproducible.
  - **Tests:** a fake provider; sampling determinism; filter grammar; budget cutoff; backfill window.
  - **Deps:** C-3.
- **C-5 Alerts (src/monitors, S)**
  - **Build:**
    - Rules over metrics or monitor scores (`cost.daily > 20`,
      `score.no-premature-completion.rate < 0.8 over 7d`).
    - Channels: macOS/Linux desktop notification, webhook, Slack incoming webhook.
    - Evaluated after ingest.
    - A cooldown suppresses repeats.
  - **Acceptance:**
    - A breach fires once per cooldown.
    - A webhook payload validates against its JSON schema.
    - With no channel configured, nothing leaves the machine.
  - **Tests:** a fake clock; a stub HTTP server; cooldown.
  - **Deps:** C-3, C-6 (metrics query).
- **C-6 Metrics view (src/viewer, M)**
  - **Build:**
    - `/api/metrics?measure=cost|tokens|sessions|toolErrors|flagRate|llmP95|score:<name>&groupBy=agent|model|repo|tool|mcpServer&bucket=day|week&since=`.
    - A viewer "Metrics" page with fixed panels: cost per day by agent, tokens by model, p95 LLM
      latency, tool error rate by tool, flag rate, score trends.
    - CLI `coding.sh stats --by model --since 30d`.
  - **Acceptance:**
    - Totals reconcile with `/api/stats`.
    - Empty ranges render as empty, not as an error.
    - Works in light and dark mode at 390px.
  - **Tests:** query golden over a fixture index; API bounds; a UI smoke test.
  - **Deps:** C-1 (cost), C-3 (score trends are optional until it lands).
- **C-7 CI gate and Action (src/ci, M)**
  - **Build:**
    - `exp run|compare --gate "pass_rate.delta.ci_low >= -0.02" --baseline <exp|branch:main>`
      exits with code 1 on failure.
    - `--summary-md` writes `$GITHUB_STEP_SUMMARY`.
    - `action.yml` (composite) installs, restores the baseline from the actions cache or artifacts,
      runs the experiment, and upserts one PR comment with deltas, CI, MDE warning and flipped cases.
  - **Acceptance:**
    - A regression fixture fails the gate.
    - A non-significant change with an underpowered MDE warns but does not fail by default.
    - The comment is updated, not duplicated.
  - **Tests:** gate expression parser; exit codes; markdown golden; the action runs in this repo's CI
    against `evals/cli`.
  - **Deps:** existing experiments; D-3 builds on it.
- **C-8 OTel attributes and dialects (src/otel, M)**
  - **Build:**
    - Additive `Session.attrs {userId?, tags?, environment?, release?, metadata?}` from `user.id`,
      `enduser.id`, `langfuse.user.id`, `langfuse.trace.tags`, `deployment.environment(.name)`,
      `service.version`.
    - `langfuse.observation.*` input, output and type.
    - `mlflow.spanInputs` and `mlflow.spanOutputs`.
    - `traceloop.entity.*`.
    - `/v1/metrics` maps the Claude Code, Codex and Gemini counters (cost, tokens, lines of code,
      commits, PRs, edit decisions) into session-level stats.
    - Alias `/api/public/otel/v1/traces` so that Langfuse SDK v5/v6 can target coding.sh locally
      with no code change.
    - Viewer filters for user, tag and environment.
  - **Acceptance:**
    - A Langfuse SDK v5 fixture trace and an MLflow fixture trace map to sessions with correct
      input, output, usage and user.
    - Metrics ingest no longer drops Claude Code counters.
  - **Tests:** fixture-driven golden events per dialect; idempotent re-post.
  - **Deps:** sequence after round-1 #9 (same files).
- **C-9 Annotation queues (src/viewer, M)**
  - **Build:**
    - `coding.sh queue create <name> --filter … --sample N --config <scoreConfig>`, plus queues from
      monitor/human disagreement.
    - A viewer queue page with keyboard shortcuts (j/k, 1–9, p/f, n for a note).
    - Progress and per-reviewer counts.
    - Completed items become human scores that feed `judge calibrate` on a held-out split.
  - **Acceptance:**
    - Reviewing 20 items with the keyboard alone is possible.
    - Calibrate picks them up.
    - A queue survives viewer restarts.
  - **Tests:** queue store; API; split assignment; UI smoke.
  - **Deps:** C-3; C-4 for the disagreement source.
- **C-10 PII pack (src/core, S)**
  - **Build:**
    - Opt-in rule sets in `redact.pii = ["email","phone","ip","card"]` (Luhn-checked), plus custom
      regex rules in config.
    - `coding.sh redact test <file>` previews what would be redacted.
  - **Acceptance:** precision fixtures: code, paths and hashes untouched; a card number passes Luhn
    before it is redacted.
  - **Tests:** a table test with ≥ 30 positives and ≥ 30 negatives.
  - **Deps:** none.
- **C-11 TS SDK (src/sdk, M)**
  - **Build:**
    - A `coding.sh/sdk` export with `observe(fn, {name, kind})` (spans with GenAI attributes,
      AsyncLocalStorage context) and `score()` (HTTP to the local viewer, or as a span event).
    - `dataset.get(id)`.
    - `evaluate({dataset, task, graders})` reuses the experiments engine in-process.
    - Zero dependencies. Exports OTLP/JSON to `CODING_SH_OTLP` or 127.0.0.1:4318.
  - **Acceptance:** a fixture app produces a session with nested `llm.call` and tool events; scores
    attach; `evaluate` matches `exp run` results.
  - **Tests:** an in-process receiver; context propagation across `await`.
  - **Deps:** C-3 for `score`.
- **C-12 Python SDK (packages/python, M)**
  - **Build:** the same four verbs, standard library only (`urllib`, `contextvars`), with a pytest
    plugin that records an experiment and honours `--gate`.
  - **Acceptance:** the same as C-11, against the same receiver.
  - **Tests:** pytest in CI on 3.10 and 3.13.
  - **Deps:** C-3, C-7 for the gate.
- **C-13 Git-native prompts (src/prompts, M)**
  - **Build:**
    - A prompt is a file in the repo. Its version is the content hash.
    - Traces link through `coding_sh.prompt.{name,version}` or `langfuse.observation.prompt.*`
      attributes.
    - Harness bundle ids are attached to organic sessions by hashing the live instruction files at
      session start (CLAUDE.md, AGENTS.md, skills).
    - The viewer shows versions with per-version cost, flags and scores.
    - `coding.sh prompts diff a b`.
  - **Acceptance:** two CLAUDE.md versions in a fixture produce two versions with separate metrics.
  - **Tests:** hash stability; linking; a diff golden.
  - **Deps:** C-6; overlaps with R2-2 (instruction surface), so share `INSTRUCTION_GLOBS`.
- **C-14 LLM-call playground (src/viewer, M)**
  - **Build:**
    - "Open in playground" on any `llm.call` that has stored request messages.
    - Edit the system prompt, messages, model and temperature, then run through the judge
      providers.
    - Side-by-side with the original.
    - Save the result as a dataset case.
  - **Acceptance:** works offline against Ollama; never sends anything without an explicit click and
    a configured provider.
  - **Tests:** a fake provider; request rebuild from a blob.
  - **Deps:** stored request bodies (opt-in capture).
- **D-1 Attribution (src/attribution, M)**
  - **Build:**
    - Map each session's `file.change` events and end snapshot to the commits that later contain
      those hunks: patch-id plus a line-hash match, inside a time window, in the shadow repo.
    - `coding.sh blame <path>[:line]` returns session, agent, model and prompt.
    - `attribution export --format agent-trace` emits RFC 0.1.0 records.
    - Optionally read git-ai notes.
  - **Acceptance:** on a fixture repo with 3 sessions and 4 commits, every agent-written line maps to
    its session, human lines map to none, and rebased commits still map through patch-id.
  - **Tests:** a fixture repo builder; Agent Trace JSON schema validation.
  - **Deps:** existing snapshots.
- **D-2 Harness cost attribution (src/core, M)**
  - **Build:**
    - Per session, attribute input tokens to instruction files (bytes → tokens from the bundle
      surface), skills (`payload.skill`, round-1 #20), MCP servers (`tool.start.payload.server`)
      and subagents.
    - `coding.sh stats --by mcpServer|skill|subagent`.
  - **Acceptance:** a fixture with 2 MCP servers and 1 subagent splits cost so that the parts sum to
    the session total.
  - **Deps:** C-1, R2-2, round-1 #20.
- **D-3 Production→CI loop (src/ci, M)**
  - **Build:** `dataset add --from-sessions '<filter>'` and `exp run --replay-sessions` drive
    eval-task replay from pre-agent snapshots inside the CI action.
  - **Acceptance:** a flagged fixture session becomes a validated task that fails on the regressed
    branch and passes on main.
  - **Deps:** C-7, the existing `eval new` and validate.

---

## 5. Positioning

**Honest positioning versus Langfuse.**
- **Where Langfuse is ahead:** it is the best general-purpose open-source LLM observability
  platform. It has an MIT core, about 37k stars and 100+ integrations, and a complete
  production loop (prompts, online evals, annotation queues, dashboards, alerts). Teams that want
  a shared server get it from Langfuse.
- **What Langfuse costs:** Postgres + ClickHouse + Redis + S3 and a 16 GiB box to self-host. Its
  coding-agent support is trace capture: it cannot see the repo state, the diff or the test
  results. Nothing in it replays a task or proves an eval measures what it claims.
- **What coding.sh is:** a lab for people who build *with* and *on* agents. One `npm install`, one
  SQLite file, nothing leaves the machine. It captures 13 coding agents, including their existing
  history.
  - Every session is anchored to a repo snapshot, so it can become a replayable eval with a
    validated verifier.
  - Harness changes are A/B-tested with paired statistics, not eyeballed.
- **The gap today, and what closes it:** the production layer is missing (scores, online evals,
  annotation queues, dashboards, alerts, SDKs, CI). Closing items C-1 to C-9 removes the only
  reasons a solo developer or small team would need Langfuse in addition to coding.sh.
- **Teams:** the OTLP sink still lets them forward everything to Langfuse.

**Three claims we can make truthfully once the gaps are closed.** The README must first be rewritten;
it still describes the old site.

1. **"Full agent observability and evals with no Docker and no database server. One npm install,
   one SQLite file, zero runtime dependencies, and nothing leaves your machine. It still has
   online evals, annotation queues, dashboards, alerts and a scores API."**
   - True after C-3 to C-6 and C-9.
   - Phoenix and MLflow also run on SQLite, but both need a Python server, and MLflow sends
     telemetry by default. So say "zero dependencies", not "only".
2. **"Turn any captured coding-agent session into a replayable eval that starts from the exact
   repo state before the agent ran. Its verifier is proven: the no-op attempt fails, the
   reference passes k of k, and impossible variants fail. Then gate every PR on it."**
   - True today, except the last sentence, which needs C-7 and D-3.
   - No competitor in §2 replays from the pre-agent tree or validates verifiers.
3. **"A/B your harness (CLAUDE.md, skills, MCP servers, model) across 13 coding agents. Every
   result comes with a confidence interval, a power warning and a tamper check, and judges only
   count once they agree with your labels (κ ≥ 0.6 on held-out data)."**
   - True today for the stats and calibration parts.
   - "Across 13 agents" holds for capture. Every named adapter defines `run` and `overlay` (the
     generic wrapper defines only `run`). Before publishing, confirm each headless path on a real
     install; DOGFOOD has exercised only some of them.
