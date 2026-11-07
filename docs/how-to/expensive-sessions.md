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
A `COST` column appears when at least one session in the window has a cost: `~` marks a cost that
includes an estimate, `+` a row where some sessions have none. Subagent sessions count
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

Coding agents' transcripts carry tokens, not dollars, and most OpenTelemetry instrumentations do
too. Each model call's cost comes from the first of:

1. the bill: calls through an LLM gateway (Vercel AI Gateway, OpenRouter, LiteLLM, Cloudflare, Portkey,
   Helicone) after `coding.sh gateway enrich`;
2. a cost the agent reports: Claude Code headless runs (`total_cost_usd`), OpenCode, Pi, or an
   OpenTelemetry span with `gen_ai.usage.cost` or `cost_usd`;
3. an estimate: input, output, cache-read and cache-write tokens times the model's list price.

Estimates are marked everywhere they show: `~` in `usage`, `est` on a call and `(estimated)` on the
session in `show`, `estimatedCostUsd` in `--json`, the MCP `usage` tool and the viewer API
(`stats.usage.estimatedCostUsd` on a session, `payload.costEstimated` on a call). A model with no
price row of its own is priced like its nearest sibling in the same family and major version
(`gpt-6.2-sol` as `gpt-6.1-sol`), and the call says so in `payload.pricedAs`. A model with no
price at all keeps no cost, never $0, and `usage` names it.

The built-in table covers current Claude, OpenAI, Gemini (which Antigravity runs) and common open
models, with each provider's page and the date it was checked in
[`src/core/pricing.ts`](../../packages/coding.sh/src/core/pricing.ts). Short-context list prices
only: no batch, priority or long-context rates. To match your bill, set your own prices (see
[Configuration](../reference/config.md#prices)). Estimates refresh by themselves when the table
changes; `coding.sh usage --reprice` recomputes them now.

## Ask your agent

With the MCP server registered (`coding.sh init` does it), an agent can call the `usage` tool to get
the same totals and top sessions, then `session_get` to read one.
