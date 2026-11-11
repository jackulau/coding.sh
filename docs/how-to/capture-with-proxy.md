# Capture every model call with the proxy

`coding.sh proxy` is a local pass-through for the Anthropic and OpenAI APIs. Hooks and transcripts
tell you what the agent did; the proxy logs what it sent: the full request and response of each
model call, inside the session the hooks capture. Use it to read one call, see why the prompt cache
missed, or replay a call with another model.

```sh
coding.sh init --proxy
coding.sh show latest#-1             # the last model call of the latest session
```

```text
Call      a4fb172f03ccdc78f519aacac03bee434cccfd4f8f117ca0fbdd3d928ef41cb9
Session   74b28a32-318c-4593-b1b9-da2fe007bee3 (linked by header)
Client    claude-code  2.1.319  anthropic  messages
Model     claude-sonnet-4-5
Status    200  end_turn  stream  4.1s  first byte 812ms  first token 1.2s
Usage     in 120  out 30  cache read 41.2k write 380 (99% hit)  $0.0181 est
System    27,146 chars, 219 lines  #414f8391e6e8126f
Tools     19  #8d0e5c2a91b7f3e4  Task, Bash, Glob, Grep, Read, Edit, Write, …
Messages  3
```

## 1. Connect

`init --proxy` installs the hooks as usual, and also:

- sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4320` in the `env` block of Claude Code's `settings.json`;
- adds a `coding-sh` model provider to Codex's `config.toml` (`base_url = "http://127.0.0.1:4320/v1"`)
  and selects it;
- starts the proxy in the background (log: `~/.coding.sh/proxy.log`).

Each changed file is backed up first. `--agent claude-code --proxy` routes one agent only. When a
Claude Code or Codex session starts, the hook restarts a stopped proxy
(`CODING_SH_NO_PROXY_AUTOSTART=1` turns that off).

Other clients, including your own scripts and SDKs, use the environment:

```sh
coding.sh proxy --background
eval "$(coding.sh proxy env)"        # ANTHROPIC_BASE_URL and OPENAI_BASE_URL
```

Check it:

```sh
coding.sh proxy status
coding.sh doctor                     # the proxy line: running or not, and which agents route through it
```

### Already using a gateway or CLIProxyAPI?

If the agent already calls another base URL, `init --proxy` puts the proxy in front of it. The
calls are logged, then go on to the same URL as before:

| Before | After | Upstream |
|---|---|---|
| `ANTHROPIC_BASE_URL=http://127.0.0.1:8317` | `http://127.0.0.1:4320` | `http://127.0.0.1:8317` |
| `ANTHROPIC_BASE_URL=https://gw.example.com/anthropic` | `http://127.0.0.1:4320/anthropic` | `https://gw.example.com` |
| `[model_providers.cliproxy]` `base_url = "http://127.0.0.1:8317/v1"` | `base_url = "http://127.0.0.1:4320/v1"` | `http://127.0.0.1:8317` |

- It reads Claude Code's `ANTHROPIC_BASE_URL` from `settings.json`, else from the environment.
- For Codex it reads your own `model_provider`'s `base_url`, else `openai_base_url`, else
  `OPENAI_BASE_URL`. Your provider stays selected; only its `base_url` changes.
- Behind CLIProxyAPI, each call records `upstreamAuth` from its `X-CPA-TRACE-ID` header: a hash that
  groups calls by credential without storing the credential.
- `init --proxy --force` replaces the URL instead of chaining. A URL with a query string or
  credentials is never chained: `init` stops and asks for `--force`.

`init` prints the URL it chains through, and `doctor` shows it. `uninstall --proxy` puts the old
value back.

## 2. What it forwards

| Path | Goes to |
|---|---|
| `/v1/messages`, `/v1/messages/count_tokens` | the Anthropic upstream (default `https://api.anthropic.com`) |
| `/v1/chat/completions`, `/v1/responses`, `/v1/responses/compact` | the OpenAI upstream (default `https://api.openai.com`) |
| Codex signed in with ChatGPT | the ChatGPT backend (`https://chatgpt.com/backend-api/codex`) |
| any other path | passed through untouched, not logged |

The client's own auth headers go upstream unchanged. The proxy holds no keys, sends one upstream
request per client request, and streams replies through without buffering. If logging fails, the
call still succeeds.

To send calls on to a gateway by hand, pass `--anthropic-upstream` or `--openai-upstream`, or set
them under `[proxy]` in the [config](../reference/config.md). A flag wins over the config, and the
config wins over the URL `init --proxy` chained through.

Measured overhead on a Linux desktop: 0.34 ms per streamed chunk (95% CI 0.28 to 0.39 ms) and
1.96 ms to the first byte (95% CI 1.66 to 2.49 ms).

## 3. Read a call

```sh
coding.sh show <session>#3           # the session's third call
coding.sh show <call-id> --all       # the whole system prompt
```

A call id works in full or as a unique prefix of 6 or more characters. `#-1` is the last call. In
the viewer (`coding.sh ui`), a proxy call in the timeline opens to its system prompt, tools and
last messages.

Each call is an `llm.call` event with source `proxy`. It joins a session this way:

| Client | Session |
|---|---|
| Claude Code | the `x-claude-code-session-id` header, else `metadata.user_id` |
| Codex | its `session-id` (or `thread-id`) header |
| Any client | `x-coding-sh-session: <id>`, when sent |
| Otherwise | a `proxy-<hash>` session per conversation, or the session of `previous_response_id` |

When the hooks also log the same call, the session counts its tokens and cost once, and `show`, the
viewer and the MCP session tools show it as one line. `show --json` and `GET /api/sessions/{id}/events` return both copies.

## 4. Why did the cache miss?

```sh
coding.sh diff-calls latest#-1                 # this call against the one before it
coding.sh diff-calls <call-a> <call-b>
```

`diff-calls` compares two requests in the order the prompt cache reads them: model, tools, system
prompt (line by line), then messages. `Why` names the first difference:

```text
a  3c81f0a9d2e4  claude-sonnet-4-5  16:02:11  in 4 out 212  cache read 40.8k write 380 (99% hit)  $0.0188
b  77d2e0b15a9c  claude-sonnet-4-5  16:09:40  in 4 out 96  cache read 0 write 41.6k (0% hit)  $0.1574

Model     same
Settings  same
Tools     same
System    changed from line 2 (2% of a's system prompt comes after the change)
            Use the tools available to you.
          - Today's date is 2026-11-06.
          + Today's date is 2026-11-07.
Messages  12 → 14, b extends a (12 shared)
Cache     miss: b read 0 of the 41.2k a cached, and wrote 41.6k
Why       the system prompt changed (first change: - Today's date is 2026-11-06.)
```

Everything after the first change is billed again. When more than 20% of the prompt comes after
it, `Why` suggests moving dynamic content (timestamps, session ids) to the end. When nothing in the
prefix changed, the cause is a gap of over five minutes, or an evicted cache entry.

`coding.sh cache doctor` ranks every cache break over a window by cost
([Prompt cache health](../guides/explore.md#prompt-cache-health)). The viewer has the same diff
under "Compare with the previous call", and the API has
[`GET /api/calls/{id}/diff`](../reference/api.md#get-apicallsiddiff).

## 5. Replay a call with another model or prompt

```sh
coding.sh exp replay latest#-1 --vary model=claude-sonnet-4-5,claude-haiku-4-5 --n 5 --dry-run
coding.sh exp replay latest#-1 --vary model=claude-sonnet-4-5,claude-haiku-4-5 --n 5
coding.sh exp replay latest#-1 --vary system=@new-prompt.md
coding.sh exp replay --session latest --limit 10 --vary model=claude-haiku-4-5
```

`exp replay` sends the logged request again, once per arm and trial. One `--vary` value changes
arm B only; two set A and B. Each reply passes when its first action matches the agent's:

```text
A model=claude-sonnet-4-5   B model=claude-haiku-4-5   1 call × 3
  A $0.0065/call  30 out tokens  2.1s
  B $0.0021/call  12 out tokens  0.9s

A replay-9a63788b-a exp_…  pass 100.0%
B replay-9a63788b-b exp_…  pass 0.0%
B − A   -100.0pp [-100.0pp, -100.0pp] (1 paired cases, 95% paired bootstrap)

First action per call (recorded → A | B):
  9a63788b95fd  Bash → Bash ×3 | text ×3

Full comparison: coding.sh exp compare exp_… exp_…
```

| Option | What it adds |
|---|---|
| `--vary <field>=…` | Any request body field, such as `temperature=0,1` or `thinking.budget_tokens=1024,8192` |
| `--criterion "..."` | An LLM judge on each reply |
| `--grader` | Any grader from `coding.sh eval` |
| `--dry-run` | The call count and an estimated cost; needs no key |
| `--max-cost` | Refuses a run whose estimate is higher |

Replays use your own `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, never the agent's login. For
Anthropic, a `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) also works. Without one, `exp replay` stops before calling
anything. Every flag: [coding.sh exp](https://coding.sh/docs/cli/exp).

## 6. Fork a session at a step

```sh
coding.sh replay latest --step 7 --fork --with AGENTS.md=fixed.md -k 3
coding.sh replay latest --step 7 --fork --with AGENTS.md=fixed.md --run --verify "npm test"
coding.sh replay latest --step 7 --fork --with AGENTS.md=fixed.md --save-case forks
```

`--fork` swaps the instruction-file text in the model call behind a step, sends it again, and
prints the recorded next action beside the forked one. `--run` goes on from there with Claude Code in a
copy of the repo, and `--save-case` keeps the step as an eval case. See
[Fork from a step](../guides/explore.md#fork-from-a-step).

## What is stored

In capture mode `full` (the default), after redaction:

| Part | What |
|---|---|
| Request | the body; system prompt, tools and older messages are stored once and shared between calls |
| Response | the body (for a stream, the message rebuilt from its events) |
| Headers | an allowlist: `anthropic-version`, `anthropic-beta`, `user-agent`, session ids, `request-id`, rate limits, `retry-after` |
| Event | model, status, stop reason, usage with cache, estimated cost, latency, time to first byte and token, error class, prompt and tool hashes |
| When sent | reasoning effort, service tier, speed, thinking budget, and `compaction: true` for a compacting call |
| Where it sits | a Claude Code subagent's own session, Codex parent and forked threads, and the account as a 16-character hash |

Auth headers (`Authorization`, `x-api-key`, cookies) are never stored, and neither is the account
id. In capture mode `metadata`, only the event is kept, with no prompt or response text: `show` and
`diff-calls` then compare hashes, and `exp replay` has nothing to send. See
[Privacy](../guides/privacy.md).

## For a team

`coding.sh serve` mounts the same proxy at `/proxy/`. Point agents at
`https://obs.example.com/proxy` and send an ingest key in `x-coding-sh-key`; the calls land in that
key's project. See [Team](../guides/team.md#the-model-api-proxy).

## Undo

```sh
coding.sh uninstall --proxy          # stop routing agents through the proxy, keep the hooks
coding.sh proxy stop
```

`coding.sh uninstall` also removes the routing. Both restore each agent's config byte for byte when
nothing else changed it.
