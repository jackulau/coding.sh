# Track Claude Code and Codex cost per session

coding.sh reads the token counts that Claude Code, Codex and other coding agents write to their
own transcripts, and turns them into tokens and cost per session, repo, agent and model. It runs
on your machine. Nothing is sent anywhere unless you add a sink.

## Get totals

Install it, import the sessions from before you installed, and ask for totals:

```sh
curl -fsSL https://coding.sh/install | sh
coding.sh ingest --backfill --since 30d
coding.sh usage --since 30d                  # by agent (the default)
coding.sh usage --since 30d --by repo
coding.sh usage --since 30d --by agent-model
coding.sh usage --since 7d --by day
```

Each row shows sessions, turns, total and output tokens, tokens per turn and the cache-read share.
A `COST` column appears when at least one session in the window has a cost. All options:
[coding.sh usage](https://coding.sh/docs/cli/usage).

## Find the sessions that cost the most

```sh
coding.sh sessions --where 'sort:-cost limit:5'
coding.sh show <session-id>
```

The `show` header has a `Tokens` line with input, output, cache reads and cost. `coding.sh ui`
opens the same session in the local viewer.

## Where the dollar figure comes from

Transcripts carry tokens, not dollars. Each model call's cost comes from the first of these that
exists:

1. the bill from an LLM gateway, after `coding.sh gateway enrich`;
2. a cost the agent reports: Claude Code headless runs (`total_cost_usd`), OpenCode, Pi, or an
   OpenTelemetry span with a cost attribute;
3. an estimate: each kind of token times the model's list price.

Estimates are always marked:

| Where | Mark |
|---|---|
| `usage` | `~` before the figure |
| a call in `show` | `est` |
| a session in `show` | `(estimated)` |
| `--json` | `estimatedCostUsd` |

The price table covers current Claude, OpenAI and Gemini models and common open models, with
long-context rates and the batch, flex, priority and fast tiers when the agent records them. A
model with no price keeps no cost, never $0. `usage` names it and the fix: a `[prices."<model>"]`
table in `~/.coding.sh/config.toml`.

## Which agents report tokens

| Agent | Tokens |
|---|---|
| Claude Code, Codex, OpenCode, Pi, Factory Droid, Amp, T3 Code | Every session |
| Antigravity CLI, Goose, GitHub Copilot CLI | From their history files, imported by `coding.sh ingest --backfill`; their hooks carry none |
| Cursor CLI | None, in its hooks or its stream output, so no cost either |
| `coding.sh run -- <cmd>` | None, except Aider's token and cost lines in eval runs |

## What it does not do

- It does not read your invoice. Unless a gateway or the agent reports a cost, the figure is an
  estimate at list price.
- It does not know your plan. On a flat subscription, the estimate is what the same tokens would
  cost at API list prices, not what you paid.
- It cannot add tokens an agent never wrote down.

## Questions

### Why does `usage` show `≥` in front of a cost?

Some sessions in that row have tokens but no price, so the figure counts only the priced ones.
Below the table, `usage` says how many sessions have no cost and names up to five of their models.

### Can I see cost from inside Claude Code?

Yes. `coding.sh init` registers an MCP server whose `usage` tool returns the same totals, with
estimates marked. It takes the same `where` filter as `--where`.

### Why are cache reads left out of tokens per turn?

Every model call re-reads the whole context, so cache reads grow with the number of calls, not the
work done. `TOK/TURN` counts input, output and cache-write tokens of top-level sessions per user
turn, leaving subagents out. The `CACHE READ` column shows the cache-read share.

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
