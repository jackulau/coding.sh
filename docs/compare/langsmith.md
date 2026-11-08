# coding.sh vs LangSmith

LangSmith is LangChain's hosted platform for tracing, evaluating and monitoring LLM applications
and agents. Its SDKs are open source; the platform is not, and self-hosting it is an Enterprise
add-on. coding.sh is an MIT-licensed CLI and local viewer that records AI agents on your machine,
with coding agents such as Claude Code and Codex captured through their hooks.

Checked against LangSmith's docs on 7 November 2026. Sources are at the end of the page. If
something here is out of date, open an issue.

## At a glance

| | coding.sh | LangSmith |
|---|---|---|
| License | MIT, all of it | SDKs MIT; the platform is closed |
| Hosted cloud | No | Yes, with a free Developer plan |
| Self-host | Yes: a laptop, or one `coding.sh serve` container | Enterprise add-on on Kubernetes |
| Claude Code and Codex capture | Hooks, installed by `coding.sh init` | Hook plugins |
| Other coding agents | Cursor, OpenCode, Copilot CLI, Amp, Goose and more ([list](https://coding.sh/docs/agents)) | Cursor, Copilot and OpenCode |
| Sessions from before you installed it | Yes, `coding.sh ingest --backfill` | Not found in their docs |
| OpenTelemetry ingest | Yes, a local OTLP/HTTP receiver | Yes |
| Cost tracking | Yes | Yes |
| Datasets, experiments, LLM judges | Yes | Yes |
| Paired statistics on two runs (bootstrap interval) | Yes, `coding.sh exp compare` | Not found in their docs |
| Replay a coding session step by step, with files | Yes, `coding.sh replay` | No |
| Online evals on live traffic | No | Yes |
| Human annotation queues, including pairwise | No | Yes |
| Failure clustering across traces | No | Yes (Insights, on paid plans) |
| Alerts | No | Yes: Slack, PagerDuty, webhooks |
| SSO, SCIM, RBAC, audit logs | No | Enterprise |
| Test runner integration | `exp compare --gate` exit code in CI | pytest, Vitest and Jest |
| MCP server | Yes, local | Yes, hosted |

## Where LangSmith is better

- **A hosted team workspace.** Nothing to run, traces from production and from every developer in
  one place, and enterprise controls when you need them.
- **Production monitoring.** Online evaluators, alerts to Slack or PagerDuty, and clustering that
  groups similar failures across many traces.
- **Human review.** Annotation queues, including pairwise comparison of two outputs.
- **LangChain and LangGraph.** Tracing for those frameworks needs almost no setup.
- **Test frameworks.** Evals can run inside pytest, Vitest or Jest.

If your team builds on LangChain or LangGraph and wants a managed platform, LangSmith fits better
than coding.sh.

## Where coding.sh is better

- **Open source and local.** The whole tool is MIT licensed. Traces stay in `~/.coding.sh` on your
  machine, there is no account, and nothing is sent anywhere unless you add a sink.
- **Self-hosting without an Enterprise plan.** A team server is one `coding.sh serve` process on
  SQLite, or on Postgres or ClickHouse through a store plugin. See
  [Self-host for a team](../how-to/self-host-team.md).
- **Coding agents first.** Hooks for more than ten coding agents, subagents linked to their parent
  session, and past sessions imported from the agents' own history.
- **Checking a change.** `coding.sh exp compare` pairs two runs case by case and reports a
  bootstrap interval of the difference, so you can tell a real improvement from noise. See
  [Evals](https://coding.sh/docs/evals).
- **Session replay.** `coding.sh replay` walks a session one step at a time with the files each
  step touched. See [replay](../use-cases/replay-agent-session.md).

## Questions

### Is there an open-source LangSmith alternative I can self-host?

coding.sh is one, for agents and coding agents: MIT licensed, local by default, and one container
for a team. It does not have LangSmith's annotation queues, alerts, failure clustering or SSO.

### Does LangSmith work with Claude Code?

Yes. LangSmith documents a Claude Code plugin built on hooks, and Codex tracing as well. coding.sh
also uses hooks, keeps the data on your machine, and imports sessions from before it was
installed.

### Can I keep LangSmith for production and use coding.sh locally?

Yes. They don't conflict. coding.sh records the coding agents on your machine; your production
app can keep sending traces to LangSmith.

## Sources

- [Self-hosted LangSmith](https://docs.langchain.com/langsmith/self-hosted)
- [Pricing](https://www.langchain.com/pricing)
- [Trace Claude Code](https://docs.langchain.com/langsmith/trace-claude-code) and [trace Codex](https://docs.langchain.com/langsmith/trace-with-codex)
- [OpenTelemetry](https://docs.langchain.com/langsmith/trace-with-opentelemetry)
- [Evaluation](https://docs.langchain.com/langsmith/evaluation)
- [Insights](https://docs.langchain.com/langsmith/insights)
- [Alerts](https://docs.langchain.com/langsmith/alerts)
- [RBAC](https://docs.langchain.com/langsmith/rbac)
