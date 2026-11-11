# coding.sh compared with other tools

How coding.sh compares with Langfuse, LangSmith, Braintrust, AgentOps, Laminar and ccusage, and
when each one is the better choice. Site version: [coding.sh/docs/compare](https://coding.sh/docs/compare).

coding.sh records what any AI agent does and runs evals on those runs. Your own agent sends its runs
with the TypeScript or Python SDK or with OpenTelemetry. Coding agents such as Claude Code, Codex
and Cursor are recorded through their hooks, with no code changes. It runs on your machine, or as
one server for a team. It is MIT licensed and has no hosted cloud.

The tools below overlap with it in different ways, and most do things coding.sh does not. Each
page has a feature table and says where the other tool is the better choice. All were checked
against each tool's own docs on 7 November 2026 and list their sources. If something is out of
date, open an issue.

## Summary

| Tool | What it is | Pick it over coding.sh when | Page |
|---|---|---|---|
| Langfuse | Open-source LLM tracing, evals and prompt management; cloud or self-hosted | You run an LLM product in production and want one shared server with prompts, annotation queues and alerts | [coding.sh vs Langfuse](langfuse.md) |
| LangSmith | LangChain's hosted tracing and eval platform | You build on LangChain or LangGraph and want a managed platform with enterprise controls | [coding.sh vs LangSmith](langsmith.md) |
| Braintrust | Hosted eval and observability platform | You want a hosted experiment UI with a playground, review queues and PR comments | [coding.sh vs Braintrust](braintrust.md) |
| AgentOps | Python SDK and hosted dashboard for agent frameworks | You build Python agents on CrewAI, AG2 or the OpenAI Agents SDK and want a hosted dashboard | [coding.sh vs AgentOps](agentops.md) |
| Laminar | Open-source agent observability with a cloud | You want hosted production analysis of agent traces with alerts and labeling queues | [coding.sh vs Laminar](laminar.md) |
| ccusage | A CLI that reports coding-agent token cost from local logs | You only want a cost report or a Claude Code status line, with nothing installed | [coding.sh vs ccusage](ccusage.md) |

## What coding.sh does that most of them don't

- **Runs with no services.** One npm package and a SQLite file on your machine. A team server is
  one `coding.sh serve` process. See [Self-host for a team](../how-to/self-host-team.md).
- **Records your own agent and coding agents in one list.** Your agent through the SDK or
  OpenTelemetry; see [Trace your agent](../how-to/trace-your-agent.md).
- **Captures coding agents from their hooks**, imports sessions recorded before it was installed,
  and links subagents to their parent session. See [Coding agents](https://coding.sh/docs/agents).
- **Reports statistics on every comparison.** Two runs are paired case by case, with a bootstrap
  interval of the difference and a verdict of better, worse or inconclusive. See
  [Evals](https://coding.sh/docs/evals).
- **Replays a coding session** one step at a time with the files each step touched. See
  [Replay a session](../use-cases/replay-agent-session.md).

## What coding.sh does not do

- No hosted cloud and no SSO or role-based access.
- No online evals on live traffic and no alerts.
- No human annotation queues; human labels are used to calibrate LLM judges.
- No prompt management: no store of named, versioned prompts. `coding.sh ui` does have a
  playground that reruns one model call.

## Questions

### What is the best open-source alternative to LangSmith or Braintrust?

It depends on what you need. Langfuse and Laminar are open-source platforms with a server and a
UI for production apps. coding.sh is open source too. It suits you when you want the traces and
evals of any agent, your own or a coding agent, on your machine or on one team server, with no
other services to run.

### Can I use coding.sh with one of these tools?

Yes. coding.sh can forward what it records to any OpenTelemetry endpoint with an `otlp` sink. See
[sinks](https://coding.sh/docs/storage#sinks).
