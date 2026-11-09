# coding.sh docs

The user docs live at [coding.sh/docs](https://coding.sh/docs). This folder holds the same
material in Markdown, plus design specs and research.

Building your own agent? Start with [how-to/trace-your-agent.md](how-to/trace-your-agent.md).
Using a coding agent? Start with [guides/install.md](guides/install.md). [concepts.md](concepts.md)
has the terms, and [troubleshooting.md](troubleshooting.md) helps when something is wrong.

## Guides

| Doc | What |
|---|---|
| [guides/install.md](guides/install.md) | installer, npm, from source, what `init` changes, updates, uninstall |
| [guides/agents.md](guides/agents.md) | supported agents with status, history import, the OpenTelemetry receiver |
| [guides/explore.md](guides/explore.md) | the CLI, the viewer and the MCP server |
| [guides/improve.md](guides/improve.md) | improve your agent every week: what to fix first, the line that fixes it, whether it helped |
| [guides/evals.md](guides/evals.md) | session to eval, datasets, experiments, judges, harness A/B |
| [guides/terse-mode.md](guides/terse-mode.md) | does a terse mode (a be-concise rule, skill or plugin) save money on your tasks: pass rate, cost, output tokens and input overhead |
| [guides/benchmarks.md](guides/benchmarks.md) | daily benchmarks on fresh cases: sources, fairness, budget, report, schedule |
| [guides/privacy.md](guides/privacy.md) | what is stored where, sinks, redaction and privacy |
| [guides/team.md](guides/team.md) | one self-hosted server for a team: keys per person and service, shared viewer login, agents and apps sending to it, retention |

## How-to

Short recipes you can run as written.

| Doc | What |
|---|---|
| [how-to/trace-your-agent.md](how-to/trace-your-agent.md) | trace your own agent with OpenTelemetry or the SDKs, then eval and compare it |
| [how-to/capture-with-proxy.md](how-to/capture-with-proxy.md) | log every model call through a local API proxy, see why the prompt cache missed, replay a call with another model |
| [how-to/trace-durable-workflow.md](how-to/trace-durable-workflow.md) | trace a Vercel Workflow or Temporal run as one session, with attempts, waits and resumes |
| [how-to/tee-agent-runs.md](how-to/tee-agent-runs.md) | send an eve or durable-harness agent's Agent Runs spans to coding.sh too, as sessions with turns, tools and usage |
| [how-to/test-claude-md-change.md](how-to/test-claude-md-change.md) | test a CLAUDE.md change in five minutes, on your own sessions |
| [how-to/compare-agents.md](how-to/compare-agents.md) | compare two coding agents on your repo |
| [how-to/replay-llm-calls.md](how-to/replay-llm-calls.md) | record a run's model calls and replay them up to the first changed call |
| [how-to/ci-regressions.md](how-to/ci-regressions.md) | catch a regression in CI |
| [how-to/expensive-sessions.md](how-to/expensive-sessions.md) | find your most expensive sessions |
| [how-to/status-line.md](how-to/status-line.md) | put your session cost, today's cost and the worst flag in the Claude Code status line |
| [how-to/session-to-eval.md](how-to/session-to-eval.md) | turn a real session into an eval task or dataset case |
| [how-to/evaluate-a-skill.md](how-to/evaluate-a-skill.md) | test whether an Agent Skill changes what the agent does |
| [how-to/does-this-plugin-help.md](how-to/does-this-plugin-help.md) | see what a Claude Code plugin adds to your sessions, then A/B it on your own tasks |
| [how-to/attribute-commits.md](how-to/attribute-commits.md) | see which agent session wrote the lines of each commit, per line with `blame`, and export Agent Trace records |
| [how-to/self-host-team.md](how-to/self-host-team.md) | self-host for a team: run one container, connect each machine, open the viewer |

## Use cases

One page per job, each pointing on to the how-to or guide that covers it in full.

| Doc | What |
|---|---|
| [use-cases/claude-code-cost.md](use-cases/claude-code-cost.md) | track Claude Code and Codex cost per session, repo and model |
| [use-cases/replay-agent-session.md](use-cases/replay-agent-session.md) | replay a Claude Code or Codex session step by step |
| [use-cases/test-agent-instructions.md](use-cases/test-agent-instructions.md) | test a CLAUDE.md, AGENTS.md or skill change, and which method to pick |
| [use-cases/evals-from-failures.md](use-cases/evals-from-failures.md) | build an eval suite from your agent's failed sessions |
| [use-cases/self-hosted-observability.md](use-cases/self-hosted-observability.md) | open-source, self-hosted LLM observability on one machine or one server |
| [use-cases/proxy-model-calls.md](use-cases/proxy-model-calls.md) | log every model call your agent makes through a local proxy |
| [use-cases/t3-code.md](use-cases/t3-code.md) | coding.sh with T3 Code: its threads next to your other sessions, cost by model, flags and evals |
| [use-cases/pi.md](use-cases/pi.md) | coding.sh with Pi: history across tools, Pi's own cost per call, flags and evals with Pi as the agent |

## Compare

How coding.sh compares with other tools, with a feature table, where each tool is the better
choice, and sources. Checked against each tool's docs; each page says when.

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

## Production

| Doc | What |
|---|---|
| [production/README.md](production/README.md) | run `coding.sh serve` on a database, in three steps |
| [production/](production/) | deploy recipes: Compose, Fly, Railway, Render, serverless |
| [PRODUCTION.md](PRODUCTION.md) | the full serve, SDK and store contract |
| [integrations/ai-gateway.md](integrations/ai-gateway.md) | LLM gateways (Vercel, OpenRouter, LiteLLM, Cloudflare, Portkey, Helicone, ...): routing, billed cost, experiments |
| [integrations/eve.md](integrations/eve.md) | eve agents: live spans, imports and evals |

## Reference

| Doc | What |
|---|---|
| [reference/cli.md](reference/cli.md) | every command and option, generated from the CLI registry |
| [reference/sdk.md](reference/sdk.md) | the TypeScript and Python SDKs, generated from their source |
| [reference/api.md](reference/api.md) | the REST API of `coding.sh serve` |
| [reference/query.md](reference/query.md) | `coding.sh sql` and `coding.sh export`, and the index's tables and columns |
| [reference/config.md](reference/config.md) | every config key and environment variable |
| [troubleshooting.md](troubleshooting.md) | doctor checks, missing sessions, every error reason |
| [concepts.md](concepts.md) | the terms: session, event, flag, dataset, experiment, judge and more |
| [ADAPTERS.md](ADAPTERS.md) | per-agent integration matrix: hook configs, payload ids, known breakage |
| [TOOL-EVALS.md](TOOL-EVALS.md) | tool evals spec: how well agents use a CLI, MCP server or API |

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
| [RELEASE.md](RELEASE.md) | release checklist for npm, GitHub and the site |
| [ease.md](ease.md) | the ease benchmark: installer to first captured session, for a person and for an agent reading agents.md |
| [research/](research/) | landscape and competitor research |
