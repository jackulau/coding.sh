# coding.sh vs Langfuse

Langfuse is an open-source platform for tracing, evaluating and managing the prompts of LLM
applications, as a hosted cloud or a self-hosted server. coding.sh is a CLI and local viewer that
records AI agents on your machine, with coding agents such as Claude Code and Codex captured
through their hooks.

Both are open source and both do evals. They differ in where the data lives, what it takes to run
them, and who they are built for.

Checked against Langfuse's docs on 7 November 2026. Sources are at the end of the page. If
something here is out of date, open an issue.

## At a glance

| | coding.sh | Langfuse |
|---|---|---|
| License | MIT | MIT, except the `ee/` folders |
| Hosted cloud | No | Yes, with a free tier |
| Runs on one laptop with no database server | Yes: SQLite and files in `~/.coding.sh` | No: Postgres, ClickHouse, Redis and S3 |
| Claude Code and Codex capture | Hooks, installed by `coding.sh init` | A plugin for each that reads the transcript |
| Other coding agents | Cursor, OpenCode, Copilot CLI, Amp, Goose and more ([list](https://coding.sh/docs/agents)) | Not found in their docs |
| Sessions from before you installed it | Yes, `coding.sh ingest --backfill` | Not found in their docs |
| OpenTelemetry ingest | Yes, a local OTLP/HTTP receiver | Yes, an OTLP endpoint |
| SDKs | TypeScript and Python | Python, JS/TS and many framework integrations |
| Cost tracking | Yes | Yes |
| Datasets, experiments, LLM judges | Yes | Yes |
| Paired statistics on two runs (bootstrap interval) | Yes, `coding.sh exp compare` | Not found in their docs |
| Replay a coding session step by step, with files | Yes, `coding.sh replay` | No |
| Online evals on live traffic | No | Yes |
| Human annotation queues | No (labels for judge calibration only) | Yes |
| Prompt management (named, versioned prompts) | No | Yes |
| Playground for a model call | Yes, in `coding.sh ui` | Yes |
| Alerts and custom dashboards | No | Yes |
| SSO and RBAC | No; per-person keys on a team server | Yes; some RBAC is in the paid edition |
| MCP server | Yes, local | Yes |

## Where Langfuse is better

- **A shared view for a team or a product.** One server holds traces from production and from many
  people, with SSO, roles and retention settings.
- **Production evals.** LLM judges can score live traffic, alerts can go to Slack or a webhook, and
  dashboards chart cost, latency and scores over time.
- **Human review.** Annotation queues let people who don't use a terminal label traces.
- **Prompts.** Versioned prompts with labels, and a playground to try them.
- **Integrations.** Many frameworks and model providers have a ready-made integration.

If you run an LLM product in production and want one hosted place for traces, prompts and scores,
Langfuse fits that better than coding.sh does.

## Where coding.sh is better

- **Nothing to run.** One npm package with zero runtime dependencies. The data is a SQLite file
  and a blob folder on your disk. No account, and nothing leaves the machine unless you add a sink.
- **Coding agents first.** Hooks for Claude Code, Codex, Cursor and other coding agents, subagents
  linked to their parent session, and past sessions imported from the agents' own history.
- **Checking a change.** `coding.sh exp compare` pairs two runs case by case and reports a
  bootstrap interval of the difference, and `--gate` gives a ship-or-hold exit code for CI. See
  [Evals](https://coding.sh/docs/evals).
- **Coding tasks that replay.** An eval task starts from the repository as it was before the agent
  ran, and a verifier that has itself been checked scores the result.
- **Session replay.** `coding.sh replay` walks a session one step at a time with the files each
  step touched. See [replay](../use-cases/replay-agent-session.md).

## Using both

coding.sh can forward what it records to any OpenTelemetry endpoint with an `otlp` sink (metadata
only unless you set `mode = "full"`; see [sinks](https://coding.sh/docs/storage#sinks)), so you can keep
local capture and evals and still send a copy to a server. We have not tested this against
Langfuse's endpoint.

## Questions

### Is coding.sh a self-hosted Langfuse alternative?

For one developer or a small team working with coding agents, yes: it stores traces and runs evals
on your machine, or on one `coding.sh serve` container for a team. It has no prompt management,
annotation queues, alerts or SSO, so it does not replace Langfuse for a production LLM product.

### Do both work with Claude Code?

Yes. Langfuse documents a Claude Code plugin that sends each turn as a trace. coding.sh installs
hooks with `coding.sh init` and also imports sessions recorded before it was installed.

### What does each need to self-host?

Langfuse runs a web and a worker container with Postgres, ClickHouse, Redis (or Valkey) and S3
compatible storage. coding.sh needs Node 22.16 or newer. A team server is one `coding.sh serve`
process on SQLite, or on Postgres or ClickHouse through a store plugin. See
[Self-host for a team](../how-to/self-host-team.md).

## Sources

- [Langfuse license](https://github.com/langfuse/langfuse/blob/main/LICENSE)
- [Self-hosting](https://langfuse.com/self-hosting) and [self-hosted editions](https://langfuse.com/pricing-self-host)
- [Claude Code integration](https://langfuse.com/integrations/developer-tools/claude-code)
- [Codex integration](https://langfuse.com/integrations/developer-tools/codex)
- [Evaluation overview](https://langfuse.com/docs/evaluation/overview)
- [Alerts](https://langfuse.com/docs/observability/features/alerts)
- [Pricing](https://langfuse.com/pricing)
