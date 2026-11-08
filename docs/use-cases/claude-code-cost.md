# Track Claude Code and Codex cost per session

coding.sh reads the token counts that Claude Code, Codex and other coding agents write to their
own transcripts, and turns them into tokens and cost per session, per repo, per agent and per
model. It runs on your machine. Nothing is sent anywhere unless you add a sink.

## How it works

Install it and let it set up capture for the agents it finds:

```sh
curl -fsSL https://coding.sh/install | sh
coding.sh ingest --backfill --since 30d      # also import sessions from before you installed
```

Then ask for totals:

```sh
coding.sh usage --since 30d                  # by agent (the default)
coding.sh usage --since 30d --by repo
coding.sh usage --since 30d --by agent-model
coding.sh usage --since 7d --by day
```

Each row shows sessions, turns, total and output tokens, tokens per turn and the cache-read share.
A `COST` column appears when at least one session in the window has a cost.

To find the sessions that cost the most and open one:

```sh
coding.sh sessions --where 'sort:-cost limit:5'
coding.sh show <session-id>
```

The `show` header has a `Tokens` line with input, output, cache reads and cost. `coding.sh ui`
opens the same session in the local viewer.

## Where the dollar figure comes from

Coding agents' transcripts carry tokens, not dollars. Each model call's cost comes from the first
of these that exists:

1. the bill from an LLM gateway, after `coding.sh gateway enrich`;
2. a cost the agent reports itself: Claude Code headless runs (`total_cost_usd`), OpenCode, Pi, or
   an OpenTelemetry span with a cost attribute;
3. an estimate: input, output, cache-read and cache-write tokens times the model's list price.

Estimates are always marked: `~` in `usage`, `est` on a call and `(estimated)` on the session in
`show`, and `estimatedCostUsd` in `--json`. The price table covers current Claude, OpenAI and
Gemini models and common open models. It applies long-context rates per call, and batch, flex,
priority and fast tiers when the agent records them. A model with no price keeps no cost, never
$0, and `usage` names it with the fix: a `[prices."<model>"]` table in `~/.coding.sh/config.toml`.

## Which agents report tokens

Claude Code and Codex record tokens for every session, as do OpenCode, Pi, Factory Droid, GitHub
Copilot CLI, Goose, Amp, T3 Code and the Antigravity CLI. For Antigravity, Goose and Copilot the
hooks carry no token counts. Those come from the agent's own history files, which
`coding.sh ingest --backfill` imports.

Cursor CLI reports no token usage, in its hooks or its stream output, so Cursor sessions have no
tokens or cost. A command recorded with `coding.sh run -- <cmd>` has none either, unless the
agent is Aider, whose token and cost lines are parsed in eval runs.

## What it does not do

- It does not read your invoice. Unless a gateway or the agent reports a cost, the figure is an
  estimate at list price.
- It does not know your plan. On a flat subscription, read the estimate as what the same tokens
  would cost at API list prices, not as what you paid.
- It cannot add tokens an agent never wrote down.

## Questions

### Why does `usage` show `≥` in front of a cost?

Some sessions in that row have tokens but no price, so the figure counts only the priced ones.
Below the table, `usage` says how many sessions have no cost and names up to five of their models.

### Can I see cost from inside Claude Code?

Yes. `coding.sh init` registers an MCP server, and its `usage` tool returns the same totals as the
command, with estimates marked. It takes the same `where` filter as `--where`.

### Why are cache reads left out of tokens per turn?

Every model call re-reads the whole context, so cache reads grow with the number of calls rather
than the work done. `TOK/TURN` counts input, output and cache-write tokens of top-level sessions per
user turn; subagents' tokens are left out, like their turns. The `CACHE READ` column shows the
cache-read share on its own.

### Prices changed. Do old sessions update?

`coding.sh usage --reprice` recomputes estimated costs from the current price table first.

## Next

- [Find your most expensive sessions](../how-to/expensive-sessions.md): the full walkthrough,
  including pricing rules and `--json` output.
- [Capture every model call with the proxy](../how-to/capture-with-proxy.md): cost and cache use
  per model call, and why a cache missed.
- [LLM gateways](../integrations/ai-gateway.md): billed cost from Vercel AI Gateway, OpenRouter,
  LiteLLM and others.
- [Agents and OpenTelemetry](../guides/agents.md): what each agent records.
