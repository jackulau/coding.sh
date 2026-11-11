# Track cost and tokens

See what your AI agents spend, per session, agent, model, repo and day, and open the session that
cost the most. Works for coding agents, SDK apps and OpenTelemetry apps alike.

coding.sh reads the token counts that any AI agent records, turns them into cost, and keeps both
with each session. This page gets your totals, finds the most expensive sessions, and explains
where each dollar figure comes from.

## Before you start

- coding.sh is installed and has sessions ([Quickstart](https://coding.sh/docs/quickstart)).
- To count sessions from before you installed, run `coding.sh ingest --backfill --since 30d` once.

## 1. See totals

```sh
coding.sh usage --since 7d
```

```text
AGENT             SESSIONS  TURNS  TOKENS  OUTPUT  TOK/TURN  CACHE READ  COST
claude-code       29        108    9.8M    86.9k   6899      93%         ~$6.92
codex             14        38     4.0M    52.4k   26.1k     76%         ~$2.08
opencode          5         5      1.1M    8542    26.5k     89%         ~$0.7937
coding-sh-triage  8         8      13.4k   221     1679      0%          ~$0.0095
  ~ = includes cost estimated from tokens × list price (no reported cost).
  Cache breaks: 32, 349.9k prompt tokens billed again (~$0.5240 extra). Causes per session: coding.sh show <id>.
```

`coding-sh-triage` is an SDK app; its rows sit next to the coding agents. `--since` defaults to
`30d`. `-a codex` keeps one agent, and `--where` takes any [query](https://coding.sh/docs/query).

## 2. Find the most expensive sessions

```sh
coding.sh sessions --where 'sort:-cost limit:5'
```

```text
ID                                    AGENT        STARTED       DURATION  TURNS  TOOLS  TITLE
e2ac1139-922a-46bd-8350-bcce0f43da68  claude-code  Nov 5 02:36   3m41s     4      11     Stream large blobs instead of buffering them
842f85fe-a932-4e47-8ed2-de9b968eaa72  claude-code  Nov 8 18:53   4m01s     3      11     Fix the flaky hook test on Windows
c9adf6ea-3327-47ed-8b99-62f696ca7bc7  claude-code  Nov 7 21:33   4m25s     3      11     Handle an empty spool in ingest
ea916f85-7248-4f70-8159-52d28269c6c5  claude-code  Nov 6 21:22   3m24s     5      11     Fix the N+1 query for subagents
4b3edd8a-56c9-4cb5-83d4-213c0706f973  claude-code  Nov 10 02:08  2m35s     4      6      Add a --json flag to coding.sh show
```

The list has no cost column. To see the figures, ask for JSON:

```sh
coding.sh sessions --where 'sort:-cost limit:5' --json --fields id,title,stats.usage.costUsd
```

`usage --json` also carries the five biggest sessions of the window in `topSessions`, ranked by
cost when any session has one, else by output tokens (`topSessionsRankedBy` says which).

Narrow the list with the same query: `agent:codex`, `repo:coding-sh`, `since:24h` or
`cost>$0.25`. Subagents are left out unless you pass `--subagents`.

![The session list in the viewer, newest first, with agent, tokens and cost per row](shot:docs/sessions-list "coding.sh ui: the session list")

## 3. Open one

```sh
coding.sh show e2ac1139
```

```text
Tokens       in 47 out 5.2k cache 547k $0.3823 (estimated)
Cache breaks 1: 2.9k prompt tokens billed again, $0.0100 extra (other 1)
```

The `Tokens` line holds input, output, cache reads and cost. Each model call below it shows its
own cost, with `est` when it is an estimate. Long sessions usually spend their tokens re-reading
context: look for a high cache-read share, a `compaction` flag and repeated tool calls.
`coding.sh ui` opens the same session as a timeline.

## 4. Split by agent, model, repo or day

```sh
coding.sh usage --since 7d --by model
```

```text
MODEL              SESSIONS  TURNS  TOKENS  OUTPUT  TOK/TURN  CACHE READ  COST
claude-sonnet-4-6  28        99     9.7M    84.9k   8009      93%         ~$6.51
gpt-5              14        38     4.0M    52.4k   26.1k     76%         ~$2.08
claude-opus-4-8    4         13     1.1M    9773    5796      94%         ~$1.17
claude-haiku-4-5   5         4      74.0k   932     4180      60%         ~$0.0404
gpt-5-mini         5         5      6079    109     1216      0%          ~$0.0017
```

| `--by` | One row per |
|---|---|
| `agent` | Agent or app (the default) |
| `model` | Main model |
| `agent-model` | Agent and model pair |
| `repo` | Repo root |
| `day` | Local day, newest first |

## Where cost comes from

Transcripts and most OpenTelemetry spans carry tokens, not dollars. Each model call's cost comes
from the first of these that exists:

1. **Billed.** The bill from an LLM gateway, after `coding.sh gateway enrich`
   ([LLM gateways](https://coding.sh/docs/ai-gateway)).
2. **Provider-reported.** A cost the agent or app records: Claude Code runs that coding.sh starts
   in evals and experiments (`total_cost_usd`), OpenCode, Pi, or a span with `gen_ai.usage.cost`
   or `cost_usd`.
3. **Estimate.** Each kind of token times the model's list price, marked `~`.

A model with no price keeps no cost, never $0. `usage` names it under the table, with the fix: a
`[prices."<model>"]` table in config.toml ([Configuration](https://coding.sh/docs/config#prices)).
On a flat subscription, an estimate is what the same tokens cost at API list prices, not what you
paid.

:::more Which agents record tokens
| Agent | Tokens |
|---|---|
| SDK and OpenTelemetry apps | Every model call the app traces |
| Claude Code, Codex, OpenCode, Pi, Factory Droid, Amp, T3 Code | Every session |
| Antigravity CLI, Goose, GitHub Copilot CLI | From their history files, imported by `coding.sh ingest --backfill`; their hooks carry none |
| Cursor CLI | None, so no cost either |
| `coding.sh run -- <cmd>` | None, except Aider's token and cost lines in eval runs |
:::

When prices change, estimates refresh on their own. To recompute them now:

```sh
coding.sh usage --since 7d --reprice
```

It prints `Repriced N model calls in M sessions` on stderr, then the table.

:::more Rates, tiers and Claude Code's own tally
The price table covers current Claude, OpenAI, Gemini and common open models. A model with no row
is priced like its nearest sibling in the same family and major version, shown in
`payload.pricedAs`. Each call is priced at the rate it ran at:

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

Long context is decided per call, so one long call does not reprice the session. Claude 4.6 and
later have no long-context surcharge. Codex rollouts record no tier, so their calls get standard
rates.

A call priced at another rate says so in `payload.priceTier` (`batch`, `flex`, `long-context`, or a
mix such as `batch+long-context`). Totals by tier are in `estimatedCostByTier`.

Claude Code also keeps its own tally at the end of its transcript. A backfill stores it on
`session.end` as `payload.reportedUsage`. It is never added to the session's cost; compare the two
to check your prices.
:::

## Prompt cache health

`coding.sh usage --since 7d --cache` shows cache hit rate, reads, writes, breaks and the cost of
each break per agent; `coding.sh cache doctor` grades it and lists the causes.

```text
AGENT        SESSIONS  CACHED  READ    WRITE   R:W      BREAKS  WASTE
claude-code  29        93%     9.0M    657.6k  13.71:1  13      ~$0.1808
codex        14        76%     3.0M    0       -        18      ~$0.3305
opencode     5         89%     979.4k  0       -        1       ~$0.0128
```

A break is a model call whose cached prompt prefix was gone, so the prompt was billed again. To
find the worst sessions: `coding.sh sessions --where 'cache.breaks>0 sort:-cache.cost'`.

## Read the result

| Mark | Means |
|---|---|
| `~$6.92` | Part of the figure is an estimate at list price. |
| `≥$1.20` | A lower bound: some sessions in the row have tokens but no price. |
| `-` | No session in the row has a price. |
| `est` | This model call's cost is an estimate (`show`). |
| `(estimated)` | The session's cost includes an estimate (`show`). |
| `estimatedCostUsd` | The estimated part, in `--json` and the API. |
| `TURNS` | User turns of top-level sessions. |
| `TOK/TURN` | Input, output and cache-write tokens per turn, top-level sessions only. |
| `CACHE READ` | Cache reads as a share of all prompt tokens. |

## If something goes wrong

| Symptom | Check |
|---|---|
| No `COST` column | No session in the window has a price. Look for model names under the table and add `[prices."<model>"]`. |
| An agent shows tokens but `-` for cost | Its model has no price. Add one, then run `coding.sh usage --reprice`. |
| An agent shows no tokens | Some agents record none in their hooks; see "Which agents record tokens" above. Run `coding.sh ingest --backfill` to read their history files. |
| Totals look low | Sessions from before you installed are missing. Run `coding.sh ingest --backfill --since 30d`. |
| The cost differs from your invoice | It is an estimate at list price. Route calls through a gateway and run `coding.sh gateway enrich` for billed cost. |

## Next steps

- [Find and read runs](https://coding.sh/docs/explore): read one session step by step.
- [Capture every model call with the proxy](https://coding.sh/docs/how-to/capture-with-proxy): cost
  and cache use per model call, and why a cache missed.
- [coding.sh usage](https://coding.sh/docs/cli/usage): every flag.
- The MCP `usage` tool returns the same totals to your agent
  ([MCP server](https://coding.sh/docs/mcp)).
