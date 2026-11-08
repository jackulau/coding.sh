# coding.sh vs AgentOps

AgentOps is a Python SDK and a hosted dashboard for monitoring agents built with frameworks such
as CrewAI, AG2 and the OpenAI Agents SDK. coding.sh is an MIT-licensed CLI and local viewer that
records AI agents on your machine and runs evals on them, with coding agents such as Claude Code
and Codex captured through their hooks.

Checked against AgentOps' docs and repository on 7 November 2026. Sources are at the end of the
page. If something here is out of date, open an issue.

## At a glance

| | coding.sh | AgentOps |
|---|---|---|
| License | MIT | SDK MIT; the `app/` folder's license file is Elastic License 2.0 |
| Hosted cloud | No | Yes, with a free tier |
| Self-host | Yes: a laptop, or one `coding.sh serve` container | Docker Compose with Supabase, ClickHouse and an OTel collector |
| Instrumenting your own Python agent | Python SDK or OpenTelemetry | Python SDK with automatic framework instrumentation |
| Coding agent capture (Claude Code, Codex, Cursor) | Yes, through hooks ([list](https://coding.sh/docs/agents)) | Not found in their docs |
| OpenTelemetry ingest | Yes, a local OTLP/HTTP receiver | The SDK is built on OpenTelemetry |
| Cost tracking | Yes | Yes |
| Datasets, experiments, LLM judges | Yes | No; an eval builder is on their roadmap |
| Replay a coding session step by step, with files | Yes, `coding.sh replay` | No |
| Hosted dashboard to share with a team | No; a team server with a shared viewer | Yes |
| MCP server | Yes, local | Yes |

## Where AgentOps is better

- **Python multi-agent frameworks.** One `agentops.init()` call instruments CrewAI, AG2, the
  OpenAI Agents SDK and other frameworks, with session replays in a hosted dashboard.
- **Nothing to host.** The hosted dashboard is ready to share with teammates.

If you build Python agents on one of those frameworks and want a hosted dashboard with no setup,
AgentOps is the shorter path.

## Where coding.sh is better

- **Evals.** Datasets, deterministic and command graders, calibrated LLM judges, and paired
  comparisons of two versions with a bootstrap interval. AgentOps has no evals today.
- **Coding agents.** Hooks for Claude Code, Codex, Cursor and other coding agents, with no code
  changes, and past sessions imported from the agents' own history.
- **Open source and local.** MIT licensed end to end, data on your disk, no account.
- **Active development.** The coding.sh repository is updated daily. The AgentOps repository's most
  recent commits we found were from June 2026.

## Questions

### What is a good AgentOps alternative for coding agents?

AgentOps instruments Python agent frameworks; it does not capture Claude Code, Codex or Cursor.
coding.sh does, through their hooks, and adds evals on top.

### Can coding.sh trace a CrewAI or OpenAI Agents SDK app?

Yes, through OpenTelemetry: point the framework's OpenInference or OTLP exporter at `coding.sh
collector`. See [OpenTelemetry](https://coding.sh/docs/otel).

## Sources

- [AgentOps repository](https://github.com/AgentOps-AI/agentops)
- [Self-hosting overview](https://docs.agentops.ai/v2/self-hosting/overview.md)
- [MCP server](https://docs.agentops.ai/v2/usage/mcp-server.md)
- [Pricing](https://www.agentops.ai/#pricing)
