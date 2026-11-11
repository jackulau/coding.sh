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

| Column | What it counts |
| --- | --- |
| `TURNS` | User turns of top-level sessions (a subagent's prompt comes from its parent's turn) |
| `TOKENS`, `COST` | All tokens and cost, subagents included |
| `TOK/TURN` | Top-level input, output and cache-write tokens per user turn; no subagents, no cache reads |
| `CACHE READ` | Cache reads as a share of all prompt tokens |

`COST` appears when at least one session in the window has a cost. `~` marks a cost that includes
an estimate. `≥` marks a lower bound: some sessions in the row have tokens but no cost. A row with
no priced session shows `-`.

Below the table, `usage` names the models with tokens but no price, and the fix: a
`[prices."<model>"]` table in config.toml ([Configuration](../reference/config.md#prices)).

## 2. The top sessions

`usage --json` includes the five biggest sessions in the window, ranked by `costUsd` when any
session has a cost, else by `outputTokens`:

```sh
coding.sh usage --since 30d --json | jq '.topSessionsRankedBy, .topSessions'
```

For a longer list, sort `sessions --json` yourself:

```sh
coding.sh sessions --since 30d --limit 500 --json \
  | jq -r '.sessions | sort_by(-(.stats.usage.costUsd // 0), -(.stats.usage.outputTokens // 0))
           | .[:10][] | "\(.id)  \(.stats.usage.costUsd // "-")  \(.stats.usage.outputTokens // 0)  \(.title)"'
```

Add `--agent codex` to either command to narrow it, or `--repo .` to `sessions` for the current
repo. `sessions` leaves subagents out unless you pass `--subagents`.

## 3. Open one

```sh
coding.sh show <session-id>
```

The header has a `Tokens` line (input, output, cache reads, cost) and a `Latency` line with model
call and tool timings. Long sessions usually spend their tokens on re-reading context: look for a
high cache-read share, `compaction` flags, and repeated tool calls. `coding.sh ui` shows the same
session as a timeline.

## Where cost comes from

Agent transcripts carry tokens, not dollars, and so do most OpenTelemetry instrumentations. Each
model call's cost comes from the first of:

1. the bill: calls through an LLM gateway (Vercel AI Gateway, OpenRouter, LiteLLM, Cloudflare,
   Portkey, Helicone) after `coding.sh gateway enrich`;
2. a cost the agent reports: Claude Code headless runs (`total_cost_usd`), OpenCode, Pi, or an
   OpenTelemetry span with `gen_ai.usage.cost` or `cost_usd`;
3. an estimate: input, output, cache-read and cache-write tokens times the model's list price.

Estimates are marked: `~` in `usage`, `est` on a call and `(estimated)` on a session in `show`,
and `estimatedCostUsd` in `--json` and the API.

A model with no price row is
priced like its nearest sibling in the same family and major version (`gpt-6.2-sol` as
`gpt-6.1-sol`, shown in `payload.pricedAs`). A
model with no price at all keeps no cost, never $0.

The built-in table covers current Claude, OpenAI, Gemini and common open models, with each
provider's page and the date it was checked, in
[`src/core/pricing.ts`](../../packages/coding.sh/src/core/pricing.ts). Each call is priced at the
rates it actually ran at:

| Rate | Price |
| --- | --- |
| Long context | A prompt over OpenAI 272K, Gemini Pro 200K, Haiku 5.5 100K or Sonnet 4.5 and 4 (1M beta) 200K tokens |
| Batch | Half price at every provider |
| OpenAI Flex | Half price |
| OpenAI Fast (once called Priority) | About 2x |
| Gemini Priority | 1.8x |
| Claude fast mode | Its own rates |
| Anthropic Priority Tier | Standard rates: it is a commitment, not a per-token price |
| Claude cache writes | 1.25x input for the 5-minute cache, 2x for the 1-hour cache |
| US-only inference | 1.1x on every token type for Claude 4.6 and later, on top of any other rate |

Long context is decided per call, so one long call doesn't reprice the session. Claude 4.6 and
later have no long-context surcharge. Where the rate comes from:

- The service tier: Claude Code's `usage.service_tier` and `usage.speed`, its `api_request` log
  `speed`, an OpenTelemetry span's `openai.response.service_tier` (or `gen_ai.*.service_tier`), or
  AI SDK provider metadata. A response's tier beats the requested one.
- 1-hour cache writes: Claude Code's `usage.cache_creation.ephemeral_1h_input_tokens`, its
  `api_request` log's `cache_creation_1h_tokens`, or AI SDK provider metadata
  (`payload.cacheWrite1hTokens`).
- US-only: `inference_geo: "us"` in Claude Code's usage (`payload.inferenceGeo`). Global routing,
  the default, is standard.
- Codex rollouts record no tier, so their calls get standard rates; long context still applies.

A call priced at another rate says so in `payload.priceTier` (`batch`, `flex`, `priority`, `fast`,
`ultrafast`, `long-context`, `us-only`, or a mix like `batch+long-context`), shown in `show` and the
viewer's cost tooltip. Totals by tier are in `estimatedCostByTier`.

To match your bill, set your own prices, tiers included
([Configuration](../reference/config.md#prices)). Estimates refresh when the table changes;
`coding.sh usage --reprice` recomputes them now.

Claude Code also keeps its own tally, in a `cost-state` line at the end of the transcript. A
backfill keeps it on `session.end` as `payload.reportedUsage` (`costUsd`, `apiDurationMs`,
`costUsdByModel`, and `unknownModelCost` when it could not price a model). It is never added to
the session's cost: compare the two to check your prices. The latest line wins.

## Ask your agent

With the MCP server registered (`coding.sh init` does it), an agent can call the `usage` tool to get
the same totals and top sessions, then `session_get` to read one.
