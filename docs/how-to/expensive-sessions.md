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
`TURNS` counts user turns: the turns of top-level sessions, since a subagent's prompt comes from its
parent's turn. `TOK/TURN` is the top-level sessions' input, output and cache-write tokens per user
turn. Subagents' tokens are left out of it, because their turns are not counted either: dividing a
row's subagent tokens by its parents' turns made a row with heavy subagents (or a model only
subagents ran, with no turns of its own) look expensive per turn. `TOKENS` and `COST` still count
subagents. `TOK/TURN` also leaves cache reads out: every model call re-reads the whole context, so cache reads grow
with the number of calls rather than the work done (`CACHE READ` shows their share).
A `COST` column appears when at least one session in the window has a cost: `~` marks a cost that
includes an estimate, and `≥` marks a lower bound: some sessions in the row have tokens but no
cost, and the figure counts only the priced ones. A row with no priced session shows `-`. Below
the table, `usage` says how many sessions have tokens but no cost and names their models (up to
five) with the fix: a `[prices."<model>"]` table in config.toml. Subagent sessions count toward
their row.

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
[`src/core/pricing.ts`](../../packages/coding.sh/src/core/pricing.ts). Each call is priced at the
rates it actually ran at:

- **Long context.** A call whose prompt (input plus cache reads and writes) goes over the model's
  threshold is priced at its long-context rates: OpenAI above 272K tokens, Gemini Pro above 200K,
  Claude Haiku 5.5 above 100K, Claude Sonnet 4.5 and 4 (1M beta) above 200K. This is decided per
  call, so one long call doesn't reprice the rest of the session. Claude 4.6 and later have no
  long-context surcharge.
- **Batch, flex, priority and fast.** The call's service tier comes from what the agent or
  instrumentation records: Claude Code's `usage.service_tier` and `usage.speed` (fast mode), an
  OpenTelemetry span's `openai.response.service_tier` (or `gen_ai.*.service_tier`, or AI SDK provider
  metadata), and Claude Code's `api_request` log `speed`. A response's tier beats the one that was
  requested. Batch is half price at every provider. OpenAI Flex is half price, and Fast (once called
  Priority) is about 2x. Gemini Priority is 1.8x. Claude fast mode uses its own rates. Anthropic's
  Priority Tier is a commitment rather than a per-token price, so those calls keep standard rates.
- **Claude 1-hour cache writes.** Anthropic bills a write to the 5-minute cache at 1.25x input and
  a write to the 1-hour cache at 2x, at every tier. The 1-hour part comes from Claude Code's
  `usage.cache_creation.ephemeral_1h_input_tokens` (the rest, `ephemeral_5m_input_tokens`, is
  5-minute), its `api_request` log's `cache_creation_1h_tokens`, or AI SDK provider metadata, and
  the call keeps it in `payload.cacheWrite1hTokens`.
- **US-only inference.** Claude 4.6 and later bill 1.1x on every token type, on top of any tier or
  long-context rate, when the call ran with `inference_geo: "us"` (Claude Code's
  `usage.inference_geo`, kept in `payload.inferenceGeo`). Global routing, the default, is standard.

A call priced at a non-standard rate says so in `payload.priceTier` (`batch`, `flex`, `priority`,
`fast`, `ultrafast`, `long-context`, `us-only`, or a combination like `batch+long-context`), which shows next
to `pricedAs` in `show` and in the viewer's cost tooltip. Session totals break the tiered part of
the estimate out in `estimatedCostByTier`, as `usage --json` and the MCP `usage` tool do. Codex
rollouts don't record a service tier, so their calls are priced at standard rates (long context
still applies, call by call). To match your bill, set your own prices, including long-context and
tier rates (see [Configuration](../reference/config.md#prices)). Estimates refresh by themselves
when the table changes; `coding.sh usage --reprice` recomputes them now.

Claude Code keeps its own cost tally: a `cost-state` line at the end of the transcript when the
process exits. A backfill keeps it on the session's `session.end` as `payload.reportedUsage`:
`costUsd` (`totalCostUSD`), `apiDurationMs` (`totalAPIDuration`), `costUsdByModel` (each model's
`costUSD`) and `unknownModelCost: true` when Claude Code could not price a model. It is a total, so
it is never added to the session's cost. Compare it with the session's computed cost to check your
prices; a resumed session writes a new line, and the latest one wins.

## Ask your agent

With the MCP server registered (`coding.sh init` does it), an agent can call the `usage` tool to get
the same totals and top sessions, then `session_get` to read one.
