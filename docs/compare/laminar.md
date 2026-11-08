# coding.sh vs Laminar

Laminar is an open-source observability platform for AI agents, written in Rust, with a hosted
cloud and a self-hosted option. It traces agents through an OpenTelemetry-based SDK and adds
evals, labeling queues and always-on LLM analysis of traces. coding.sh is an MIT-licensed CLI and
local viewer that records AI agents on your machine, with coding agents such as Claude Code and
Codex captured through their hooks.

Checked against Laminar's docs on 7 November 2026. Sources are at the end of the page. If
something here is out of date, open an issue.

## At a glance

| | coding.sh | Laminar |
|---|---|---|
| License | MIT | Apache-2.0; some self-hosted features need a license key |
| Hosted cloud | No | Yes, with a free tier |
| Self-host | Yes: a laptop, or one `coding.sh serve` container | Docker Compose with Postgres, ClickHouse and Quickwit |
| Coding agent capture | Hooks for Claude Code, Codex, Cursor and more ([list](https://coding.sh/docs/agents)) | Plugins for Claude Code, Codex, OpenCode and Pi |
| Sessions from before you installed it | Yes, `coding.sh ingest --backfill` | Not found in their docs |
| OpenTelemetry ingest | Yes, a local OTLP/HTTP receiver | Yes |
| Datasets, evals, LLM judges | Yes | Yes |
| Paired statistics on two runs (bootstrap interval) | Yes, `coding.sh exp compare` | Not found in their docs |
| Replay a coding session step by step, with files | Yes, `coding.sh replay` | No |
| Rerun an app agent from a cached step | Partly: `coding.sh exp replay` resends one logged model call with a change | Yes, a debugger |
| Always-on LLM analysis of traces, with alerts | No | Yes (Signals) |
| Labeling queues | No | Yes |
| SQL over traces | Yes, `coding.sh sql` (SQLite) | Yes, a SQL editor and dashboards |
| Playground | No | Yes |
| MCP server | Yes, local | Yes, hosted |

## Where Laminar is better

- **Watching production.** Signals run an LLM over incoming traces, cluster what they find and
  send alerts to Slack or email.
- **Debugging app agents.** The debugger reruns an agent from a cached step, so you can change one
  thing and see what happens next.
- **Human labels.** Labeling queues for reviewing traces.
- **A hosted UI** with SQL dashboards, shared by a team.

If you are building an agent product and want hosted tracing with production analysis, Laminar
fits better than coding.sh.

## Where coding.sh is better

- **No services to run.** One npm package and a SQLite file. Laminar's self-hosted stack needs
  Postgres, ClickHouse and Quickwit.
- **Coding agents first.** More coding agents captured with no code changes, and past sessions
  imported from the agents' own history.
- **Statistics on comparisons.** `coding.sh exp compare` reports a bootstrap interval of the
  difference between two runs and says when a change is inside the noise.
- **Coding tasks that replay** from the repository as it was before the agent ran, with a checked
  verifier. See [Evals](https://coding.sh/docs/evals).

## Questions

### Is coding.sh a Laminar alternative?

For coding agents on your own machine, yes. For a hosted production view with alerts and labeling
queues, Laminar does more.

### Both trace Claude Code. What is the difference?

Laminar sends Claude Code traces to its cloud or your Laminar server. coding.sh keeps them on
your machine by default, imports sessions recorded before it was installed, and lets you replay a
session step by step with the files each step touched.

## Sources

- [Laminar repository and license](https://github.com/lmnr-ai/lmnr)
- [Self-hosting](https://laminar.sh/docs/self-hosting/overview.md)
- [Pricing](https://laminar.sh/pricing)
- [Claude Code integration](https://laminar.sh/docs/integrations/claude-code.md)
- [Evaluations](https://laminar.sh/docs/evaluations/concepts.md)
- [Signals](https://laminar.sh/docs/signals/introduction.md)
- [Debugger](https://laminar.sh/docs/debugger/introduction.md)
- [Labeling queues](https://laminar.sh/docs/queues/quickstart.md)
