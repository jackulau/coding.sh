# Round 9 ecosystem notes

Scout: ecosystem. Window: 2026-11-22 00:15 UTC (the end of the round 8 notes) to 2026-11-22
06:15 UTC. It also covers older changes that round 8 missed, mostly prices. Baseline:
[round-8-ecosystem.md](round-8-ecosystem.md). Competitor gaps CG-1 to CG-13 belong to the other
scout, and no candidate here covers one of them.

## Method

- Read each agent's GitHub releases with `gh api`, and the pull requests merged since 2026-11-19.
  Read npm `dist-tags` for opencode-ai, droid, @github/copilot, @openai/codex and @ampcode/cli.
- Read the Claude Code changelog
  (https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) and its hooks page
  (https://code.claude.com/docs/en/hooks).
- Read the Copilot CLI releases (https://github.com/github/copilot-cli/releases).
- Read the OpenAI price page (https://developers.openai.com/api/docs/pricing) and the Gemini API
  price page (https://ai.google.dev/gemini-api/docs/pricing). The second one would not load in
  the web reader, so I fetched it with curl to a scratch folder outside the repo and read the
  tables there.
- Read MCP SEP-3415 from the spec repo
  (https://github.com/modelcontextprotocol/modelcontextprotocol, `seps/3415-events-extension.md`).
- Read the Codex telemetry source
  (https://github.com/openai/codex, `codex-rs/otel/src/events/session_telemetry.rs`).
- Compared each change with `docs/ADAPTERS.md` and the source under `packages/coding.sh/src`.
- Checked prices with `resolvePrice` from `packages/coding.sh/src/core/pricing.ts`, in a
  throwaway home.

## Round 8 candidates: status

- Goose `PreToolUseResult`: built. `packages/coding.sh/src/adapters/more/goose.ts` lists the
  event.
- `coding.sh run amp` with `--model`: open. `src/adapters/more/amp.ts` still accepts only the
  mode names.
- Antigravity Orchestrator prices: open.
- Claude Code `Stop` with `background_tasks`: open. `src/adapters/claude-code.ts` reads no
  `background_tasks`.
- Codex turn stopped by the rollout budget (`budget_limited`): open. `src/adapters/codex.ts` maps
  the abort reason into the turn status only.
- Older open items stay open: R7-5, R7-8, R7-9, R7-11, R7-12, R7-19 and R6-17 (the OTLP sink
  still sends schema URL 1.37.0 from `src/sinks/otlp.ts`).

## Prices

The biggest finding this round is in the price table, not in a capture format.

### OpenAI GPT-6.2

OpenAI released GPT-6.2 Astra and GPT-6.2 Sol on 2026-11-17
(https://developers.openai.com/api/docs/pricing). Per million tokens:

| Model | Input | Cached input | Output | Long context (>272K) in / cached / out |
|---|---|---|---|---|
| gpt-6.2-astra | 8 | 0.40 | 40 | 16 / 0.80 / 60 |
| gpt-6.2-sol | 2 | 0.10 | 10 | none listed |

Cache writes are priced per window: 30 minutes (Astra 10, Sol 2.50) and 12 hours (Astra 20,
Sol 5). Batch is 0.5x and Fast is 2x. Flex is not listed for 6.2. Ultrafast is 3x through
2027-02-28 and 6x from 2027-03-01. Background requests get 30% off for the 2-hour window and
40% off for the 8-hour window.

`src/core/pricing.ts` has no 6.2 rows. `resolvePrice("gpt-6.2-astra")` falls back to
`gpt-6-astra` (10 / 50 / cache read 1). That overprices input and output by 25% and cache reads
by 2.5x. `gpt-6.2-sol` falls back to `gpt-6.1-sol`, which has the same rates by chance.

Copilot CLI 1.0.115-2 (2026-11-20) added GPT-6.2 Astra to its model list
(https://github.com/github/copilot-cli/releases), so Copilot sessions will carry the id soon.

### Gemini 4

Google now lists three Gemini 4 models that the table lacks
(https://ai.google.dev/gemini-api/docs/pricing). Per million tokens, input / output / cache read:

| Model | Standard | Batch and Flex | Priority |
|---|---|---|---|
| gemini-4-neon (announced 2026-11-18) | 3 / 15 / 0.15 | 1.50 / 7.50 / 0.075 | 5.40 / 27 / 0.27 |
| gemini-4-hydrogen | 1.50 / 7.50 / 0.075 | 0.75 / 3.75 / 0.0375 | 2.70 / 13.50 / 0.135 |
| gemini-4-carbon, to 2026-11-30 | 2 / 10 / 0.10 | 1 / 5 / 0.05 | 3.60 / 18 / 0.18 |
| gemini-4-carbon, from 2026-12-01 | 4 / 20 / 0.20 | 2 / 10 / 0.10 | 7.20 / 36 / 0.36 |

All Gemini 4 models use implicit caching only. `resolvePrice` returns nothing for
`gemini-4-neon` and `gemini-4-hydrogen`: there is no lower Gemini 4 minor to fall back to, only
`gemini-4-argon`, which has a different name. Copilot CLI 1.0.115-2 added Gemini 4 Hydrogen and
MAI-Code-2-Flash. `mai-code-2-flash` and `grok-5` also return nothing; I found no official list
price for either.

### Prices that change on a date

Three rows change price inside the next six weeks:

- `gpt-5.6-sol` runs at a promotional price until 2026-11-30 (the comment above its row in
  `src/core/pricing.ts` says so).
- `gemini-4-argon` goes from 2 / 10 to 4 / 20 on 2026-12-01 (the Gemini comment in the same file).
- `gemini-4-carbon` doubles on 2026-12-01 (table above).

The table has one rate per row and no dates. `src/core/reprice.ts` reprices every stored
estimated cost when the table's stamp changes. So the day someone edits the Argon row, every
November Argon session is repriced at the December rate, and the sessions from before the
promotion end are wrong either way. The fix is an optional effective date on a row, chosen by
the event's `ts` in `priceEvent`.

## Agents

### Claude Code

Still at 2.1.330 (2026-11-20). Two notes on denied calls:

- `PermissionDenied` (added in 2.1.89) fires when auto mode refuses a tool call. Its input has
  `tool_name`, `tool_input`, `tool_use_id` and `reason`, plus `mcp_server` for an MCP tool. The
  hooks page says under `PostToolUseFailure`: "Permission denials fire `PreToolUse` but not this
  event." coding.sh registers 12 events in `CLAUDE_HOOK_EVENTS` (`src/adapters/claude-code.ts`)
  and `PermissionDenied` is not one of them. In hook capture a denied call gets a `tool.start`
  and never a `tool.end`, so it stays open until the transcript backfill or the session end.
- 2.1.328 changed managed `PostToolUse` hooks so they no longer fire for calls refused before
  they ran. That is the same gap from the other side.

### Codex

No release after rust-v0.173.0-alpha.4 (2026-11-21). npm `@openai/codex` is 0.171.0. Merged
pull requests that matter:

- `codex.turn_cost`. Codex logs a turn's estimated cost (`record_turn_cost` in
  `codex-rs/otel/src/events/session_telemetry.rs`). The log event has `turn.id`,
  `usage.estimated_usd` (a decimal string), `turn.interrupted`, `speed` and `reasoning_effort`.
  There is also a metric, `codex.turn.cost_microusd`, with the same tags plus `conversation.id`.
  It covers API key users (#39006, 2026-08-17), custom providers (#39785, 2026-08-20), ChatGPT
  sign-in (#41944, 2026-09-01) and, since #62810 (2026-11-20), native USD in the ChatGPT total
  (https://github.com/openai/codex/pull/62810). The receiver in `src/otel/map.ts` has no case for
  it, so it becomes a plain notification and the number is lost.
- #63069 (2026-11-22) adds `features.send_message_to_user_async` with settings for the root agent
  and subagents. The tool came in #42354 (2026-09-02). It emits agent message items without
  ending the turn. The Codex adapter reads agent messages by item, so no change is needed now.
- #62589 (2026-11-19) removes `mcp_attribution` from rollouts in favour of `model_search_state`.
  `src/adapters/codex.ts` does not read `mcp_attribution`.
- #62833 adds MCP tool outcomes to rollout traces (R7-8). #62709 links agent tool calls to the
  messages they delivered. #62831 lets required hooks block a continuation. #63075 changes MCP
  reply POSTs. None changes the rollout lines coding.sh reads.

### OpenCode

npm `opencode-ai` 1.19.6, GitHub v2.3.2 (2026-11-18).

- #65271 (2026-11-22) turns the MCP Events client on by default and drops the `mcp_events` flag.
  It uses push delivery on protocol 2026-07-28 only. See the MCP section.
- #65513 (2026-11-22) reorders the fields of a tool result. The names are the same.
- #65466 serves OpenCode Go under the `opencode` integration. `opencode-go/glm-5` still resolves
  in the price table.

### Copilot CLI

- 1.0.115-2 (2026-11-20): GPT-6.2 Astra, Gemini 4 Hydrogen and MAI-Code-2-Flash. When an
  allowed-model policy moves a subagent to its fallback model, the subagent's events now name the
  fallback.
- 1.0.115-5 and -6 (2026-11-21): long sessions take less space on disk (I could not check how),
  and Fusion sessions show as working.

### T3 Code

Nightly v0.1.12-nightly.20261122.5071. #40220 keeps ACP context usage that arrives late, and
#40670 covers the Cursor handoff. No storage change.

### Others

- Gemini CLI: the 20261122 nightly has the same commit as 20261121. Stable is 0.70.0.
- Droid: npm 1.17.2 (2026-11-22). The changelog still shows 1.16.0 (2026-11-20) as the latest
  entry: the metrics name prefix and a new default model.
- Amp: `@ampcode/cli` 0.0.1795320040 (2026-11-22). The news feed's latest post is from 2026-11-21.
- Cursor: the last changelog entry is still 2026-11-06.
- Pi v1.6.0 (https://github.com/earendil-works/pi, 2026-11-20), Goose v1.60.2 and Aider v0.86.0:
  no change.

## Specs

### MCP

SEP-3415, the Events extension, is Final. The pull request closed on 2026-11-19 and #3568
registered the extension on 2026-11-20. The protocol version is still 2026-07-28. In short:

- The id is `io.modelcontextprotocol/events`, advertised under `capabilities.extensions` with
  `{ listChanged }`.
- `events/list` returns `{ resultType: "complete", events: [{ name, description, delivery,
  inputSchema, payloadSchema }], nextCursor }`. `delivery` lists `poll`, `push` or `webhook`.
- `events/poll` takes `{ name, arguments, cursor, maxAgeMs?, maxEvents? }`. A null cursor means
  "from now". It returns `{ events: [{ eventId, name, timestamp, data }], cursor, truncated,
  hasMore, nextPollMs }`.
- `events/stream` is push. The server sends `notifications/events/active`, then
  `notifications/events/event` per event, and `notifications/events/error` or
  `notifications/events/terminated`. Each carries
  `_meta["io.modelcontextprotocol/subscriptionId"]`. On stdio the client stops with
  `notifications/cancelled`.
- A server without the extension answers `-32601`.

`src/mcp/protocol.ts` speaks 2026-07-28 and advertises only the skills extension. OpenCode now
asks every server for events by default (#65271), so a coding.sh MCP server that offered
"session ended" or "work needs you" could push them into an OpenCode session without polling
tools.

### OpenTelemetry GenAI

- semconv-genai v0.1.0 was released on 2026-11-21. #742 moves the schema URL to 0.2.0-unreleased.
  R6-17 (our sink's 1.37.0 URL) stays open; wait for 0.2.0 to ship.
- #736 (2026-11-20) documents that `gen_ai.usage.*` must not be summed across nested spans. The
  receiver already counts nested usage once.
- #732 moves to `rpc.status_code`. `src/otel/map.ts` already reads it.
- #696 replaces `gen_ai.prompt.variable` with `gen_ai.prompt.variables`. coding.sh reads neither.

## Competitors

- Langfuse: still v4.83.0. #20598 and #20597 (2026-11-21) are billing work. A docs changelog post
  (https://github.com/langfuse/langfuse-docs/pull/4503) announces a redesigned trace view on
  2026-11-20: a timeline and graph overview, less cluttered observation details and the same
  layout in the full page, the side peek and small screens. That is UI polish, with no gap.
- Arize Phoenix v22.0.0 (2026-11-20) adds costs for DECISION and EMBEDDING spans (covered in
  round 7). v22.0.1 is a fix.
- Magpie v0.1.4665 (2026-11-22): small fixes.
- Braintrust 3.44.0 (2026-11-11), LangSmith SDK v0.14.9 (2026-10-15), W&B Weave v0.54.1
  (2026-11-05), judgeval v1.9.3 (2026-11-19), git-ai v1.7.6 (2026-11-05), Entire nightly 0.13.5
  (2026-11-16) and Harbor v0.27.0 (2026-11-21): no change since round 8.

## Candidates

1. Price rows for gpt-6.2-astra and gpt-6.2-sol (`src/core`).
2. Price rows for gemini-4-neon, gemini-4-hydrogen and gemini-4-carbon (`src/core`).
3. Price rows with an effective date, chosen by the event time (`src/core`).
4. Claude Code `PermissionDenied`: a denied call closes as denied and keeps its reason
   (`src/adapters`).
5. Codex `codex.turn_cost` kept from OTLP logs (`src/otel`).
6. The MCP Events extension on the coding.sh MCP server (`src/mcp`).
7. Codex `budget_limited` turn abort, carried over from round 8 (`src/adapters`).
8. Claude Code `Stop` with background work, carried over from round 8 (`src/adapters`).

## Watch list

- Codex `codex.turn_cost`: once the receiver keeps it, the session fold could prefer the reported
  turn cost over the per-call estimates of the same turn.
- Copilot CLI storage changes in 1.0.115-5, once someone records a fixture.
- MAI-Code-2-Flash and Grok 5 list prices.
- OpenAI background-window discounts, if a 6.2 request ever reports its window.
- semconv-genai 0.2.0 and its schema URL (R6-17).
- Claude Code `PostToolBatch` (R5-21) and the model switch hooks.
- From round 8: OpenCode `opencode-native`, the OpenInference registry live-check (#4423) and the
  Droid metrics name prefix.
