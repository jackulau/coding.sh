# Find your most expensive sessions

Rank sessions by cost or tokens, see where the spend goes by repo, agent and model, and open the
worst one.

## 1. Totals by repo, agent and model

```sh
coding.sh usage --since 30d                  # by agent (the default)
coding.sh usage --since 30d --by repo
coding.sh usage --since 30d --by agent-model
coding.sh usage --since 7d --by day
```

Each row shows sessions, turns, total and output tokens, tokens per turn and the cache-read share.
A `COST` column appears when at least one session in the window has a cost. Subagent sessions count
toward their row.

## 2. The top sessions

`usage --json` includes the five biggest sessions in the window:

```sh
coding.sh usage --since 30d --json | jq '.topSessionsRankedBy, .topSessions'
```

`topSessionsRankedBy` is `costUsd` when any session has a cost, and `outputTokens` otherwise.

For a longer list, sort `sessions --json` yourself:

```sh
coding.sh sessions --since 30d --limit 500 --json \
  | jq -r '.sessions | sort_by(-(.stats.usage.costUsd // 0), -(.stats.usage.outputTokens // 0))
           | .[:10][] | "\(.id)  \(.stats.usage.costUsd // "-")  \(.stats.usage.outputTokens // 0)  \(.title)"'
```

Add `--agent codex` to either command to narrow it, or `--repo .` to `sessions` for the current repo.
`sessions` leaves subagents out unless you pass `--subagents`.

## 3. Open one

```sh
coding.sh show <session-id>
```

The header has a `Tokens` line (input, output, cache reads, cost) and a `Latency` line with model
call and tool timings. Long sessions usually spend their tokens on re-reading context: look for a
high cache-read share, `compaction` flags, and repeated tool calls. `coding.sh ui` shows the same
session as a timeline.

## Where cost comes from

Many sessions have tokens and no cost: coding agents' transcripts carry tokens, not dollars, and most OpenTelemetry instrumentations do too.
coding.sh shows an unknown cost as missing, never as $0. A session gets a cost when:

- the agent reports one: Claude Code headless runs (`total_cost_usd`), OpenCode and Pi do;
- an OpenTelemetry span carries `gen_ai.usage.cost` or `cost_usd`, for example Claude Code with its
  OTel export turned on (see [OpenTelemetry](https://coding.sh/docs/otel#claude-code));
- the model calls went through Vercel AI Gateway and you run `coding.sh gateway enrich`, which
  attaches the billed cost;
- events are ingested by `coding.sh serve` (the SDKs send there), which prices tokens from a built-in price list plus
  any `[pricing."<model>"]` table in your config (see [Configuration](../reference/config.md#pricing)).

Until then, compare spend by tokens: `usage --by agent-model` at a fixed model is a fair comparison
between harnesses.

## Ask your agent

With the MCP server registered (`coding.sh init` does it), an agent can call the `usage` tool to get
the same totals and top sessions, then `session_get` to read one.
