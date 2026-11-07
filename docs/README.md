# coding.sh docs

The user docs live at [coding.sh/docs](https://coding.sh/docs/). This folder holds the same
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
| [guides/evals.md](guides/evals.md) | session to eval, datasets, experiments, judges, harness A/B |
| [guides/benchmarks.md](guides/benchmarks.md) | daily benchmarks on fresh cases: sources, fairness, budget, report, schedule |
| [guides/privacy.md](guides/privacy.md) | what is stored where, sinks, redaction and privacy |
| [guides/team.md](guides/team.md) | one self-hosted server for a team: keys per person and service, shared viewer login, agents and apps sending to it, retention |

## How-to

Short recipes you can run as written.

| Doc | What |
|---|---|
| [how-to/trace-your-agent.md](how-to/trace-your-agent.md) | trace your own agent with OpenTelemetry or the SDKs, then eval and compare it |
| [how-to/trace-durable-workflow.md](how-to/trace-durable-workflow.md) | trace a Vercel Workflow or Temporal run as one session, with attempts, waits and resumes |
| [how-to/test-claude-md-change.md](how-to/test-claude-md-change.md) | test a CLAUDE.md change in five minutes, on your own sessions |
| [how-to/compare-agents.md](how-to/compare-agents.md) | compare two coding agents on your repo |
| [how-to/ci-regressions.md](how-to/ci-regressions.md) | catch a regression in CI |
| [how-to/expensive-sessions.md](how-to/expensive-sessions.md) | find your most expensive sessions |
| [how-to/session-to-eval.md](how-to/session-to-eval.md) | turn a real session into an eval task or dataset case |
| [how-to/evaluate-a-skill.md](how-to/evaluate-a-skill.md) | test whether an Agent Skill changes what the agent does |
| [how-to/self-host-team.md](how-to/self-host-team.md) | self-host for a team, the short path |

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

## Maintainers

| Doc | What |
|---|---|
| [RELEASE.md](RELEASE.md) | release checklist for npm, GitHub and the site |
| [research/](research/) | landscape and competitor research |
