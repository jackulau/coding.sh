# coding.sh docs

The user docs live at [coding.sh/docs](https://coding.sh/docs/). This folder holds the same
material in Markdown, plus design specs and research.

## Guides

| Doc | What |
|---|---|
| [guides/install.md](guides/install.md) | installer, npm, from source, what `init` changes, updates, uninstall |
| [guides/agents.md](guides/agents.md) | supported agents with status, history import, the OpenTelemetry receiver |
| [guides/explore.md](guides/explore.md) | the CLI, the viewer and the MCP server |
| [guides/evals.md](guides/evals.md) | session to eval, datasets, experiments, judges, harness A/B |
| [guides/privacy.md](guides/privacy.md) | what is stored where, sinks, redaction and privacy |
| [guides/team.md](guides/team.md) | one self-hosted server for a team: keys per person and service, shared viewer login, agents and apps sending to it, retention |

## Production

| Doc | What |
|---|---|
| [production/README.md](production/README.md) | run `coding.sh serve` on a database, in three steps |
| [production/](production/) | deploy recipes: Compose, Fly, Railway, Render, serverless |
| [PRODUCTION.md](PRODUCTION.md) | the full serve, SDK and store contract |
| [integrations/ai-gateway.md](integrations/ai-gateway.md) | Vercel AI Gateway: routing, billed cost, experiments |
| [integrations/eve.md](integrations/eve.md) | eve agents: live spans, imports and evals |

## Reference

| Doc | What |
|---|---|
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
