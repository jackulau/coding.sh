# Log every model call your agent makes

`coding.sh proxy` is a local pass-through for the Anthropic and OpenAI APIs. Point Claude Code,
Codex or your own client at it, and every LLM call is logged with its full request (system prompt,
tool definitions, messages) and response (content, stop reason, usage, timings), inside the
session it belongs to. Then you can read one call, see why the prompt cache missed, and replay a
call with another model.

## How it works

```sh
curl -fsSL https://coding.sh/install | sh
coding.sh init --proxy
```

`init --proxy` sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4320` in Claude Code's `settings.json`,
adds a `coding-sh` model provider to Codex's `config.toml`, and starts the proxy in the background.
Each changed file is backed up first, and `coding.sh uninstall --proxy` restores it. If the agent
already calls a gateway or CLIProxyAPI, the proxy sits in front of it: calls are logged, then go to
the same URL as before.

Other clients, including your own scripts and SDKs, use the environment:

```sh
coding.sh proxy --background
eval "$(coding.sh proxy env)"        # sets ANTHROPIC_BASE_URL and OPENAI_BASE_URL
```

## What it forwards

| Path | Goes to |
|---|---|
| `/v1/messages`, `/v1/messages/count_tokens` | the Anthropic API, or the upstream you set |
| `/v1/chat/completions`, `/v1/responses` | the OpenAI API, or the upstream you set |
| Codex signed in with ChatGPT | the ChatGPT backend |
| any other path | passed through untouched, not logged |

The client's own auth headers go upstream unchanged and are never stored. The proxy holds no keys
and sends one upstream request per client request. Streams pass through as they arrive, and if
logging fails the call still succeeds.

## Read a call

```sh
coding.sh show 'latest#-1'           # the last model call of the latest session
coding.sh show '<session>#3' --all   # its third call, with the whole system prompt
```

A call shows its model, status, timings, usage with cache reads and writes, estimated cost, the
size and hash of the system prompt, and the tools. In the viewer (`coding.sh ui`), a proxy call in
the timeline opens to the same view.

## Why did the prompt cache miss?

```sh
coding.sh diff-calls 'latest#-1'            # this call against the one before it
coding.sh diff-calls <call-a> <call-b>
```

`diff-calls` compares two requests in the order the prompt cache reads them: model, settings, tool
definitions, system prompt (line by line), then messages. When the second call read much less from
the cache than the first one cached, a `Why` line names the first difference. For a system prompt
edit it also gives the share of the prompt after the change, which the cache could not read, and
when that is over 20% it says to move the dynamic content to the end. When nothing in the prefix
changed, the cause is the gap between the calls or an evicted cache entry.

## Replay a call with another model

```sh
coding.sh exp replay 'latest#-1' --vary model=claude-sonnet-4-5,claude-haiku-4-5 --n 5 --dry-run
```

`exp replay` sends the logged request again, varying the model, the system prompt or any body
field, and compares the arms. It uses your own `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, never the
agent's login. `--dry-run` needs no key and prints the number of calls and an estimated cost.

## What it does not do

- `init --proxy` routes Claude Code and Codex only. Other agents need a client that honours
  `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`.
- It speaks the Anthropic Messages and OpenAI Chat Completions and Responses shapes. Other paths
  pass through unlogged.
- In capture mode `metadata`, only hashes, counts, tool names, usage and timings are kept. `show`
  and `diff-calls` then compare hashes, and `exp replay` has nothing to send.
- Every turn sends the whole conversation again, so a long session stores its messages once per
  call.

## Questions

### How does a call find its session?

Claude Code sends `x-claude-code-session-id`, and Codex sends its thread id. Any client can send
`x-coding-sh-session: <id>`. Otherwise each conversation gets its own `proxy-<hash>` session.

### How much latency does it add?

Measured on a Linux desktop over 60 paired calls: 0.34 ms per streamed chunk and 1.96 ms to the
first byte. CI fails the build above 2 ms per chunk or 5 ms to first byte.

### Can I keep using an LLM gateway?

Yes. The proxy forwards to the gateway, or set `--anthropic-upstream` and `--openai-upstream`.
`coding.sh gateway enrich` adds the billed cost to calls it can link to a gateway record, for
Vercel AI Gateway, OpenRouter, LiteLLM and others.

### Does it work for a team?

`coding.sh serve` mounts the same proxy at `/proxy/`. Agents send an ingest key in
`x-coding-sh-key`, and their own API key still goes upstream unchanged.

## Next

- [Capture every model call with the proxy](../how-to/capture-with-proxy.md)
- [Explore sessions](../guides/explore.md#model-calls)
- [LLM gateways](../integrations/ai-gateway.md)
- [Storage, sinks and privacy](../guides/privacy.md)
