# Log every model call with the proxy

Route any client through a local Anthropic or OpenAI proxy to keep every prompt, see why the prompt
cache missed, and replay a call.

`coding.sh proxy` passes each request on to the Anthropic or OpenAI API unchanged and logs the full
request and response as a model call in a session. It works for your own app, an SDK script, or a
coding agent.

## Before you start

- coding.sh is installed: `npm i -g coding.sh`.
- Your client reads `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`. The Anthropic and OpenAI SDKs do.

## 1. Start the proxy

```sh
coding.sh proxy --background
```

```text title=output
http://127.0.0.1:4320
  Started in the background (pid 8622); log: ~/.coding.sh/proxy.log
```

## 2. Point your client at it

```sh
eval "$(coding.sh proxy env)"
```

This sets two variables:

```text title=output
export ANTHROPIC_BASE_URL=http://127.0.0.1:4320
export OPENAI_BASE_URL=http://127.0.0.1:4320/v1
```

Run your app as usual. This script labels a GitHub issue. The `x-coding-sh-session` header puts
every call it makes in one session:

```js title=label.mjs
import Anthropic from "@anthropic-ai/sdk";

// Reads ANTHROPIC_BASE_URL, so every call goes through the proxy. The header puts the calls in one session.
const client = new Anthropic({ defaultHeaders: { "x-coding-sh-session": "triage-1" } });
const issue = process.argv[2] ?? "Viewer search misses tool output";
const date = process.env.TODAY ?? new Date().toISOString().slice(0, 10);
const msg = await client.messages.create({
  model: "claude-sonnet-5-5",
  max_tokens: 100,
  system: `Pick labels for this GitHub issue from the repo's label list. Answer with the labels only.\nToday's date is ${date}.`,
  messages: [{ role: "user", content: issue }],
});
console.log(msg.content[0].text);
```

Run it twice, a day apart (here `TODAY` stands in for the clock):

```sh
TODAY=2026-11-10 node label.mjs
TODAY=2026-11-11 node label.mjs
```

## 3. Read a call

```sh
coding.sh show 'triage-1#-1'       # the last model call of the session
```

```text title=output
Viewer search misses tool output
Call      9222031d912bfc31409a00794b3bb063ad43887e4d74bda3520f0d31dc88ee79
Session   triage-1 (linked by header)
Client    anthropic  JS  anthropic  messages
Model     claude-sonnet-5-5
Status    200  end_turn  4ms  first byte 4ms
Usage     in 4  out 30  cache read 0 write 42k (0% hit)  $0.1043 est
System    118 chars, 2 lines  #0aab22e09299839e
          Pick labels for this GitHub issue from the repo's label list. Answer with the labels only.
          Today's date is 2026-11-11.
Messages  1
Settings  max_tokens=100
```

`#3` is a session's third call and `#-1` its last. A call id works in full or as a prefix of 6 or
more characters, and `--all` prints the whole system prompt. In the viewer (`coding.sh ui`), a
proxy call in the timeline opens to the same view.

## 4. See why the prompt cache missed

The second call read nothing from the cache and cost about 20 times as much. `diff-calls` compares it with
the call before it, in the order the cache reads a request: model, settings, tools, system prompt,
then messages.

```sh
coding.sh diff-calls 'triage-1#-1'
```

```text title=output
a  19379f9905a0  claude-sonnet-5-5  10:42:49  in 4 out 30  cache read 41k write 380 (99% hit)  $0.0053
b  9222031d912b  claude-sonnet-5-5  10:42:51  in 4 out 30  cache read 0 write 42k (0% hit)  $0.1043

Model     same
Settings  same
Tools     same
System    changed from line 2 (2% of a's system prompt comes after the change)
            Pick labels for this GitHub issue from the repo's label list. Answer with the labels only.
          - Today's date is 2026-11-10.
          + Today's date is 2026-11-11.
Messages  1 → 1, b extends a (1 shared)
Cache     miss: b read 0 of the 41k a cached, and wrote 42k
Why       the system prompt changed (first change: - Today's date is 2026-11-10.)
```

`coding.sh diff-calls <call-a> <call-b>` compares any two calls. To rank every cache break over
the last 30 days by what it cost:

```sh
coding.sh cache doctor
```

```text title=output
Prompt cache: 49% hit rate, grade F (34/100)
25 sessions in the last 30d: 1 cache breaks re-billed 41k of 171k prompt tokens (~$0.0988 extra), 41k of them avoidable (24% of all prompt tokens)

CAUSE	BREAKS	SESSIONS	RE-BILLED	EXTRA
system-volatile-line	1	1	41k	~$0.0988

1. system-volatile-line: keep changing values (dates, times, counters) out of the static system prompt; pass them in the next user or tool message
   e.g. coding.sh diff-calls 19379f9905a0740374c048a229f37996044c90cfbf838d8cc679e1edb25da89c 9222031d912bfc31409a00794b3bb063ad43887e4d74bda3520f0d31dc88ee79
```

## 5. Record Claude Code and Codex

`init --proxy` points Claude Code and Codex at the proxy and starts it, next to the usual hooks.
Each call then lands in the session the hooks record. `--dry-run` lists the edits first:

```sh
coding.sh init --proxy --agent claude-code,codex --dry-run
```

The edits it lists:

- Claude Code: `ANTHROPIC_BASE_URL=http://127.0.0.1:4320` in the `env` block of `settings.json`.
- Codex: a `coding-sh` model provider in `config.toml`, selected.
- Each file is backed up first. `coding.sh uninstall --proxy` puts it back and keeps the hooks.

When a Claude Code or Codex session starts, the hook restarts a stopped proxy.
`CODING_SH_NO_PROXY_AUTOSTART=1` turns that off. `coding.sh doctor` shows which agents route
through the proxy.

:::more Already using a gateway or CLIProxyAPI?
If the agent already calls another base URL, `init --proxy` puts the proxy in front of it. Calls are
logged, then go on to the same URL:

| Before | After | Upstream |
|---|---|---|
| `ANTHROPIC_BASE_URL=http://127.0.0.1:8317` | `http://127.0.0.1:4320` | `http://127.0.0.1:8317` |
| `ANTHROPIC_BASE_URL=https://gw.example.com/anthropic` | `http://127.0.0.1:4320/anthropic` | `https://gw.example.com` |
| `[model_providers.cliproxy]` `base_url = "http://127.0.0.1:8317/v1"` | `base_url = "http://127.0.0.1:4320/v1"` | `http://127.0.0.1:8317` |

For Codex, your own provider stays selected; only its `base_url` changes. A URL with a query
string or credentials is never chained: `init` stops and asks for `--force`, which replaces the
URL instead.

For your own client, pass `--anthropic-upstream` or `--openai-upstream`, or set them under
`[proxy]` in the [config](../reference/config.md). When the upstream is a known gateway, the
session keeps its `gateway:<name>` tag ([LLM gateways](../integrations/ai-gateway.md)).
:::

## Stop calls over a budget

```sh
coding.sh budget set day 20
coding.sh proxy --enforce-budget
```

With `--enforce-budget`, a model call that a [budget](https://coding.sh/docs/cost#set-a-budget)
over its limit applies to gets a 429 and never goes upstream. The body uses the vendor's error
shape (`rate_limit_error` for Anthropic, `insufficient_quota` for OpenAI) and names the budget,
its limit, its estimated spend and when it resets. `Retry-After` gives the seconds until the
reset.

Which budgets the proxy can match:

- A budget with no `--agent` and no `--repo` applies to every call.
- A budget with `--agent claude-code` or `--agent codex` applies to that agent's calls, known from
  their headers. Every other client's calls count as agent `proxy`.
- A budget with `--repo` never blocks a call: the proxy does not know a call's repo.

Only `/v1/messages`, `/v1/chat/completions` and `/v1/responses` calls are blocked;
`count_tokens` and other paths go through. The proxy reads spend from the store at most every
30 s, so a call can go through for up to 30 s after a budget passes its limit. If spend can't be
read, the call goes through. Without the flag nothing is blocked. A proxy the hook restarts (step
5) runs without the flag.

## Catch a tool description that changed

```sh
coding.sh harness tools --changed
coding.sh harness tools pin
```

`harness tools` lists every tool the proxy saw in the last 30 days (`--since`), one row per MCP
server and tool, with a short hash of its description and of its input schema, the sessions that
were offered it and how many versions it had. A name `mcp__<server>__<tool>` belongs to that MCP
server; every other tool is `builtin`.

It reads the tools the proxy stores with each call, so it needs capture mode `full`. Calls logged
in mode `metadata` are counted in a note and left out.

`--changed` keeps a tool that had more than one description or schema in the window, and exits 1
when any remain. `harness tools pin` saves the latest hashes of every tool to `tool-pins.json`
in the coding.sh data directory.

After a pin, `--changed` also keeps these rows, named by `changed` (`variants` for the rest):

- `pin`: a pinned tool whose latest version, or one seen since the pin, differs from the pin.
- `new`: a tool with no pin, first seen after the newest pin.
- `removed`: a pinned tool that the latest tools array of every session since its pin leaves out,
  with `sessions` 0 when no call in the window offered it. Pinning again drops its pin.

In `--json`, each changed row other than `removed` has `sessionIds`: up to 20 sessions that offered
a definition other than the pinned one, other than the first one seen, or, for a new tool, any, the
latest call first. Only hashes are printed, never the descriptions. Every flag:
[coding.sh harness](https://coding.sh/docs/cli/harness).

## Read the result

| `Why` says | Do |
|---|---|
| the system prompt changed | Keep dates, ids and counters out of the system prompt. Pass them in a user or tool message. |
| the tool definitions changed | Keep the tool list and its order the same between calls. |
| the model changed | Each model has its own cache. Expect a miss on a switch. |
| the history was rewritten | A compaction or an edit to older messages. Expect one miss after it. |
| N min passed between the calls | The default cache lasts 5 minutes. |
| same prefix and within 5 min | The cache entry was evicted, or the cache breakpoints moved. |

## If something goes wrong

| Symptom | Check |
|---|---|
| Each call is its own `proxy-<hash>` session | Send `x-coding-sh-session: <id>`. Claude Code and Codex send their session id themselves. |
| `diff-calls` says "is the first model call of its session; name two calls" | The call has no earlier call in its session. Pass two call ids. |
| Nothing is logged | `coding.sh proxy status`, then check that the client reads the base URL from step 2. |
| Port 4320 is in use | `coding.sh proxy --port 0` picks a free port; `proxy env` prints it. |

:::more What the proxy forwards and stores
| Path | Goes to |
|---|---|
| `/v1/messages`, `/v1/messages/count_tokens` | the Anthropic API, or the upstream you set |
| `/v1/chat/completions`, `/v1/responses` | the OpenAI API, or the upstream you set |
| Codex signed in with ChatGPT | the ChatGPT backend |
| any other path | passed through, not logged |

The proxy holds no keys. Your auth headers go upstream unchanged and are never stored. Streams pass
through as they arrive, and a logging failure never fails the call. Measured overhead on a Linux
desktop: 0.34 ms per streamed chunk and 1.96 ms to the first byte.

In capture mode `full` (the default) each call keeps its request and response bodies after
[redaction](../guides/privacy.md). The system prompt, tools and older messages are stored once and
shared between calls. In mode `metadata` only hashes, usage and timings are kept, so `show` and
`diff-calls` compare hashes.
:::

:::more Replay a call with another model
```sh
coding.sh exp replay 'triage-1#-1' --vary model=claude-sonnet-5-5,claude-haiku-4-5 --n 5 --dry-run
```

`exp replay` sends the logged request again, once per arm and trial, varying the model, the system
prompt (`--vary system=@new-prompt.md`) or any body field. It uses your own `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`, never the agent's login. `--dry-run` needs no key and prints the call count and an
estimated cost. Every flag: [coding.sh exp](https://coding.sh/docs/cli/exp).
:::

:::more For a team
`coding.sh serve` mounts the same proxy at `/proxy/`. Point clients at
`https://obs.example.com/proxy` and send an ingest key in `x-coding-sh-key`; the calls land in that
key's project. See [Self-host for a team](https://coding.sh/docs/how-to/self-host-team).
:::

## Undo

```sh
coding.sh uninstall --proxy        # stop routing agents through the proxy, keep the hooks
coding.sh proxy stop
```

## Next steps

- [Find and read runs](https://coding.sh/docs/explore): search and open the calls you logged.
- [Track cost](https://coding.sh/docs/cost): where each cost figure comes from.
- [Record coding agents](https://coding.sh/docs/agents): hooks for each agent.
