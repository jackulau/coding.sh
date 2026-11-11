# coding.sh docs

The user docs live at [coding.sh/docs](https://coding.sh/docs). This folder holds the same
material in Markdown, plus design specs and research. The sections below follow the groups of the
site's sidebar.

Building your own agent? Start with [how-to/trace-your-agent.md](how-to/trace-your-agent.md).
Using a coding agent? Start with [guides/install.md](guides/install.md). [concepts.md](concepts.md)
has the terms, and [troubleshooting.md](troubleshooting.md) helps when something is wrong.

## Get started

| Doc | What |
|---|---|
| [guides/install.md](guides/install.md) | the install line, npm, what `init` changes, updates, uninstall |
| [concepts.md](concepts.md) | sessions, turns, events and subagents; datasets, experiments, graders and judges |

## Record

| Doc | What |
|---|---|
| [how-to/trace-your-agent.md](how-to/trace-your-agent.md) | trace your own agent with the TypeScript or Python SDK |
| [guides/agents.md](guides/agents.md) | the coding agents coding.sh records, with status, history import and the OpenTelemetry receiver |
| [how-to/status-line.md](how-to/status-line.md) | put your session cost, today's cost and the worst flag in the Claude Code status line |
| [how-to/capture-with-proxy.md](how-to/capture-with-proxy.md) | log every model call through a local API proxy, see why the prompt cache missed, replay a call |
| [integrations/ai-gateway.md](integrations/ai-gateway.md) | LLM gateways (Vercel, OpenRouter, LiteLLM, Cloudflare, Portkey, Helicone, ...): routing, billed cost, experiments |
| [how-to/trace-durable-workflow.md](how-to/trace-durable-workflow.md) | trace a Vercel Workflow or Temporal run as one session, with attempts, waits and resumes |
| [how-to/tee-agent-runs.md](how-to/tee-agent-runs.md) | send an eve or durable-harness agent's Agent Runs spans to coding.sh too |
| [integrations/eve.md](integrations/eve.md) | eve agents: live spans, imports and evals |

## Look at runs

| Doc | What |
|---|---|
| [guides/explore.md](guides/explore.md) | find and read runs: the CLI, the viewer and the MCP server |
| [how-to/track-cost.md](how-to/track-cost.md) | tokens and cost per session, agent, model, repo and day |
| [use-cases/replay-agent-session.md](use-cases/replay-agent-session.md) | replay a session step by step |
| [how-to/attribute-commits.md](how-to/attribute-commits.md) | see which agent session wrote the lines of each commit |

## Evaluate

| Doc | What |
|---|---|
| [guides/evals.md](guides/evals.md) | cases, the task under test, graders and LLM judges |
| [how-to/session-to-eval.md](how-to/session-to-eval.md) | turn a failed run into an eval case or repo task |
| [TOOL-EVALS.md](TOOL-EVALS.md) | tool evals: how well agents use a CLI, MCP server or API |
| [guides/benchmarks.md](guides/benchmarks.md) | daily benchmarks on fresh cases: sources, fairness, budget, report, schedule |

## Experiment

| Doc | What |
|---|---|
| [how-to/compare-agents.md](how-to/compare-agents.md) | compare two coding agents on your repo |
| [how-to/replay-llm-calls.md](how-to/replay-llm-calls.md) | record a run's model calls and replay them up to the first changed call |
| [guides/workflows.md](guides/workflows.md) | capture, score and compare multi-agent workflow runs |
| [how-to/ci-regressions.md](how-to/ci-regressions.md) | catch a regression in CI |

## Improve your agent

| Doc | What |
|---|---|
| [guides/improve.md](guides/improve.md) | what to fix first, the AGENTS.md line that fixes it, and whether it helped |
| [how-to/test-agents-md-change.md](how-to/test-agents-md-change.md) | test an AGENTS.md change on your own sessions |
| [how-to/evaluate-a-skill.md](how-to/evaluate-a-skill.md) | test whether an Agent Skill changes what the agent does |
| [how-to/does-this-plugin-help.md](how-to/does-this-plugin-help.md) | see what a Claude Code plugin adds to your sessions, then A/B it on your own tasks |
| [guides/terse-mode.md](guides/terse-mode.md) | does a terse mode save money on your tasks |

## Run for a team

| Doc | What |
|---|---|
| [how-to/self-host-team.md](how-to/self-host-team.md) | run one container, connect each machine, open the team viewer |
| [guides/team.md](guides/team.md) | keys per person and service, the shared viewer login, retention |
| [production/README.md](production/README.md) | run `coding.sh serve` on a database and send traces from a deployed app |
| [production/deploy.md](production/deploy.md) | deploy serve: Compose, Fly.io, Railway, Render, serverless (one file per host in [production/](production/)) |
| [PRODUCTION.md](PRODUCTION.md) | the full serve, SDK and store contract |
| [guides/privacy.md](guides/privacy.md) | what is stored where, redaction, metadata mode, purge |

## Reference

| Doc | What |
|---|---|
| [reference/cli.md](reference/cli.md) | every command and option, generated from the CLI registry |
| [reference/sdk.md](reference/sdk.md) | the TypeScript and Python SDKs, generated from their source |
| [reference/api.md](reference/api.md) | the REST API of `coding.sh serve` |
| [reference/query.md](reference/query.md) | the query language, `coding.sh sql` and `coding.sh export`, and the index's tables |
| [reference/config.md](reference/config.md) | every config key and environment variable |
| [reference/stores.md](reference/stores.md) | the Postgres and ClickHouse stores for `coding.sh serve` |
| [reference/eval-methods.md](reference/eval-methods.md) | how evals are computed: pass@k, paired intervals, McNemar, the gate, judge calibration |
| [troubleshooting.md](troubleshooting.md) | doctor checks, missing sessions, every error reason |
| [ADAPTERS.md](ADAPTERS.md) | per-agent integration matrix: hook configs, payload ids, known breakage |

## Compare

Feature tables for tools that overlap with coding.sh, where each one is the better choice, and
sources. Checked against each tool's docs; each page says when.

| Doc | What |
|---|---|
| [compare/README.md](compare/README.md) | overview of all of them |
| [compare/langfuse.md](compare/langfuse.md) | coding.sh vs Langfuse |
| [compare/langsmith.md](compare/langsmith.md) | coding.sh vs LangSmith |
| [compare/braintrust.md](compare/braintrust.md) | coding.sh vs Braintrust |
| [compare/agentops.md](compare/agentops.md) | coding.sh vs AgentOps |
| [compare/laminar.md](compare/laminar.md) | coding.sh vs Laminar |
| [compare/ccusage.md](compare/ccusage.md) | coding.sh vs ccusage |

## Case studies

| Doc | What |
|---|---|
| [case-studies/vercel-security-audit.md](case-studies/vercel-security-audit.md) | an A/B eval of a third-party Agent Skill, with a stub CLI and two-step grading |

## Design

Specs and plans. Each one states its status at the top.

| Doc | What |
|---|---|
| [design/architecture.md](design/architecture.md) | capture, spool, ingest, store, viewer and runner |
| [design/workflows.md](design/workflows.md) | capturing and A/B-testing multi-agent workflow runs |
| [design/bench-cli.md](design/bench-cli.md) | `coding.sh bench`: benchmarks in one noun |
| [design/viewer.md](design/viewer.md) | viewer: sessions, query language, benches |
| [design/dogfood.md](design/dogfood.md) | testing coding.sh on itself: scorecard and improvement loop |
| [design/stats-audit.md](design/stats-audit.md) | audit of bootstrap intervals and shares used as decisions, and the exact tests added |

## Maintainers

| Doc | What |
|---|---|
| [RELEASE.md](RELEASE.md) | release checklist for npm, PyPI, GitHub and the site |
| [ease.md](ease.md) | the ease benchmark: installer to first captured session, for a person and for an agent reading agents.md |
| [perf.md](perf.md) | how the coding.sh site was made faster on slow phones, measured with `coding.sh exp metrics` |
| [research/](research/) | landscape and competitor research |
