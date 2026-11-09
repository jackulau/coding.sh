# Capture every model call with the proxy

`coding.sh proxy` is a local pass-through for the Anthropic and OpenAI APIs. Point an agent at it and
each model call is logged with its full request (system prompt, tool definitions, messages) and
response (content, stop reason, usage, timings), inside the session the hooks capture. Then you can
read a single call, see why the prompt cache missed between two calls, and replay a call with another
model or system prompt.

Hooks and transcripts tell you what the agent did. The proxy tells you what it sent.

## 1. Connect

```sh
coding.sh init --proxy
```

This installs the hooks as usual, and also:

- sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4320` in the `env` block of Claude Code's `settings.json`;
- adds a `coding-sh` model provider to Codex's `config.toml` (`base_url = "http://127.0.0.1:4320/v1"`)
  and selects it;
- starts the proxy in the background (log: `~/.coding.sh/proxy.log`).

Each changed file is backed up first. `--agent claude-code --proxy` routes one agent only. When a
Claude Code or Codex session starts, the hook restarts a stopped proxy (set
`CODING_SH_NO_PROXY_AUTOSTART=1` to turn that off).

### Already using a gateway or CLIProxyAPI?

If the agent already calls another base URL, `init --proxy` puts the proxy in front of it instead of
replacing it. The calls are logged, then go on to the same URL as before. It looks for:

- Claude Code: `ANTHROPIC_BASE_URL` in `settings.json`, else in the environment `init` runs in;
- Codex: the `base_url` of your own `model_provider`, else `openai_base_url`, else `OPENAI_BASE_URL`.

The agent gets the proxy's address with that URL's path, and the URL's origin becomes the proxy's
upstream:

| Before | After | Upstream |
|---|---|---|
| `ANTHROPIC_BASE_URL=http://127.0.0.1:8317` | `http://127.0.0.1:4320` | `http://127.0.0.1:8317` |
| `ANTHROPIC_BASE_URL=https://gw.example.com/anthropic` | `http://127.0.0.1:4320/anthropic` | `https://gw.example.com` |
| `[model_providers.cliproxy]` `base_url = "http://127.0.0.1:8317/v1"` | `base_url = "http://127.0.0.1:4320/v1"` | `http://127.0.0.1:8317` |

A Codex provider of your own keeps its table and stays selected. Only its `base_url` changes, so
its `env_key`, headers and wire API still apply. `init` prints the URL it chains through, and `doctor`
shows it. `uninstall --proxy` puts the old value back, byte for byte while the file is unchanged.

Behind CLIProxyAPI, each call records `upstreamAuth`: the index of the credential CLIProxyAPI picked
for it, read from its `X-CPA-TRACE-ID` response header. It is already a hash, so calls can be grouped
by credential without the credential.

`init --proxy --force` replaces the URL instead: the calls go to the proxy's configured upstream
(the provider's own API unless you set one), and Codex switches to the `coding-sh` provider. A URL with a query string or credentials in it is never chained;
`init` stops and asks for `--force`.

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

## 2. What it forwards

| Path | Goes to |
|---|---|
| `/v1/messages`, `/v1/messages/count_tokens` | the Anthropic upstream (default `https://api.anthropic.com`) |
| `/v1/chat/completions`, `/v1/responses` | the OpenAI upstream (default `https://api.openai.com`) |
| Codex signed in with ChatGPT | the ChatGPT backend (`https://chatgpt.com/backend-api/codex`) |
| any other path | passed through untouched, not logged |

The client's own auth headers go upstream unchanged. The proxy holds no keys, never pools or rotates
accounts, and sends one upstream request per client request. Streams are passed through as they
arrive, with no buffering. If logging fails, the call still succeeds.

To send calls on to a gateway by hand, set the upstream:

```sh
coding.sh proxy --anthropic-upstream https://gateway.example.com/anthropic
```

or `anthropic_upstream` and `openai_upstream` under `[proxy]` in `~/.coding.sh/config.toml`
([config reference](../reference/config.md)). A flag wins over the config, and the config wins over
the upstream `init --proxy` chained through. Codex's remote compaction (`/v1/responses/compact`)
is forwarded and logged too.

Measured overhead on a Linux desktop (`node scripts/dogfood/bench.mjs proxy`, 60 paired calls of 20
streamed chunks each): 0.34 ms per chunk (95% CI 0.28 to 0.39 ms) and 1.96 ms to the first byte
(95% CI 1.66 to 2.49 ms). CI fails the build above 2 ms per chunk or 5 ms to first byte.

The proxy stores a call after its response has ended, so the agent never waits on the write. The
write runs on the proxy's one thread, though, so it can delay another stream or the agent's next
call. It folds only the events stored since its last write into the session row, and puts the
call's blobs in one batch, so the cost stays flat as the session grows. Over a 1,000-call session
(`node scripts/dogfood/bench.mjs proxy-session --baseline <older dist>`, Linux desktop), storing a
call in the last quarter took 8.95 ms at the median, against 26.24 ms before this change (paired
difference −17.29 ms, 95% CI −17.97 to −16.73 ms).

## 3. Read a call

Each call is an `llm.call` event with source `proxy`, inside the session it belongs to:

- **Claude Code**: the `x-claude-code-session-id` header, else `metadata.user_id`.
- **Codex**: its `session-id` header (or `thread-id`), which is the thread id.
- **Any client**: send `x-coding-sh-session: <id>` to pick the session.
- **Otherwise**: a `proxy-<hash>` session per conversation (same client, system prompt and first
  message), or, for the Responses API, the session of `previous_response_id`.

When the agent's hooks or transcript also log the call, the session stores both copies and counts
its tokens and cost once. `show`, the viewer's timeline and the MCP `session_get` and
`session_current` tools show it as one line: the proxy's copy, with its call id, timing and cache
use, plus what only the other copy has (the turn, cache counts the stream did not report). Copies
pair by the provider's id for the call (`messageId` or `responseId`). `show --json` and
`/api/sessions/{id}/events` return both.

```sh
coding.sh show latest#-1             # the last model call of the latest session
coding.sh show <session>#3           # its third call
coding.sh show <call-id> --all       # the whole system prompt
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

A call id works as a full id or a unique prefix of 6 or more characters. `<session>#n` counts the
proxy's calls when the session has any; `#-1` is the last. In the viewer (`coding.sh ui`), a proxy
call in the timeline opens to its system prompt, tools and last messages.

## 4. Why did the cache miss?

```sh
coding.sh diff-calls latest#-1                 # this call against the one before it
coding.sh diff-calls <call-a> <call-b>
```

`diff-calls` compares two requests in the order the prompt cache reads them: model, tool definitions,
system prompt (line by line), then messages. When the second call read much less from the cache than
the first one cached, `Why` names the first difference.

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

The `System` row gives the line where the prompt first changed and the share of the earlier prompt
that comes after it. The cache reads a prefix, so that share is billed again, along with every
message after it. When more than 20% comes after the change, `Why` adds a hint: move the dynamic
content (timestamps, session ids) to the end of the system prompt, so the text before it stays
cached. A date on the last line, as above, costs little; the same date on the first line costs the
whole prompt.

When nothing in the prefix changed, the cause is the gap between the calls (over five minutes), or
the cache entry was evicted.

`coding.sh cache doctor` does this for every cache break over a window and ranks the causes by
what they cost, each with a pair of calls to pass to `diff-calls`. See
[Prompt cache health](../guides/explore.md#prompt-cache-health).

The viewer has the same comparison under "Compare with the previous call". The API has
[`GET /api/calls/{id}/diff`](../reference/api.md#get-apicallsiddiff).

## 5. Replay a call with another model or prompt

```sh
coding.sh exp replay latest#-1 --vary model=claude-sonnet-4-5,claude-haiku-4-5 --n 5 --dry-run
coding.sh exp replay latest#-1 --vary model=claude-sonnet-4-5,claude-haiku-4-5 --n 5
coding.sh exp replay latest#-1 --vary system=@new-prompt.md
coding.sh exp replay --session latest --limit 10 --vary model=claude-haiku-4-5
```

`exp replay` sends the logged request again (not streamed), once per arm and trial, A and B
interleaved. One `--vary` value changes arm B only and keeps arm A as recorded; two values set A and
B. `model` and `system` are the usual keys; any other key sets that field of the request body
(`--vary temperature=0,1`, `--vary thinking.budget_tokens=1024,8192`).

Each reply is graded by whether its first action matches the one the agent took (the same tool, or
text). Add `--criterion "..."` for an LLM judge, or `--grader` for any grader from `coding.sh eval`.
The report is the paired comparison of `exp compare`:

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

Replays use your own key, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, never the agent's login (which
the proxy does not store). For Anthropic, a `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`)
works when no key is set. Without either, `exp replay` stops before calling anything. `--dry-run`
needs no key and prints the number of calls and an estimated cost (input priced as uncached);
`--max-cost` stops a run whose estimate is higher.

## 6. Fork a session at a step

```sh
coding.sh replay latest --step 7 --fork --with CLAUDE.md=fixed.md -k 3
coding.sh replay latest --step 7 --fork --with CLAUDE.md=fixed.md --run --verify "npm test"
coding.sh replay latest --step 7 --fork --with CLAUDE.md=fixed.md --save-case forks
```

`--fork` finds the model call behind a replay step, swaps the CLAUDE.md or AGENTS.md text in its
stored request, sends it again and prints the recorded next action beside the forked one. `--run`
goes on from there with Claude Code in a copy of the repo, and `--save-case` keeps the step as an
eval case. See [Fork from a step](../guides/explore.md#fork-from-a-step).

## What is stored

In capture mode `full` (the default), each call stores:

- the request body after redaction, with the system prompt and tool definitions as blobs of their own,
  so repeated ones are stored once, and its messages in blocks shared with the session's earlier
  calls;
- the response body after redaction (for a stream, the message rebuilt from its events);
- an allowlist of request headers (`anthropic-version`, `anthropic-beta`, `user-agent`, session ids)
  and response headers (`request-id`, rate limit headers, `retry-after`);
- in the event: model, status, stop reason, usage with cache reads and writes, estimated cost,
  latency, time to first byte and first token, error class, and hashes of the system prompt and tools;
- when the request or response has them: reasoning effort (`reasoning.effort`, `reasoning_effort`
  or Anthropic's `output_config.effort`), service tier, speed, the thinking budget, and
  `compaction: true` for a call that compacted the conversation (Codex's `/responses/compact`, or a
  `compaction` block or item in the reply). The session id the client sent is the event's session.
- where the call sits among sessions, when the client says: a Claude Code subagent's calls (sent with
  `x-claude-code-agent-id`) go to the subagent's own session, the one its hooks and transcript fill,
  with `parentSessionId`; Codex calls name their parent thread, the thread they were forked from and
  the subagent kind (`review`, `compact`, …); and the account the call ran on, as a 16-character
  hash (Claude Code's `account_uuid`, Codex's `chatgpt-account-id`). The account id itself is not
  stored: the request body keeps `account_uuid` as `hash:<hash>`.

Auth headers (`Authorization`, `x-api-key`, cookies) are never stored. In capture mode `metadata`,
only the event is kept: hashes, counts, tool names, usage and timings, with no prompt or response
text. `show` and `diff-calls` then compare hashes only, and `exp replay` has nothing to send. See
[Privacy](../guides/privacy.md).

Every turn sends the whole conversation again. The proxy puts the messages in content-addressed
blocks of 16 at fixed positions, so a call shares the blocks of the messages it has in common with
earlier calls, and only its newest messages (at most 19) are stored with the call itself. `show`,
`diff-calls` and `exp replay` read the body back exactly as it was sent, after redaction. On a
synthetic session of 500 calls (up to 231 KiB per request), the requests took 828 KiB instead of
4,116 KiB (`node scripts/perf/proxy-storage.mjs --synthetic`). Reading a call back reads a few
dozen small blobs; on a synthetic session of 2,000 calls that took 2.1 ms at the median on a Linux
desktop. Calls an earlier build stored with the whole body
still read. `coding.sh gc` keeps a block while any stored call uses it.

## For a team

`coding.sh serve` mounts the same proxy at `/proxy/`. Point agents at
`https://obs.example.com/proxy` and send an ingest key in `x-coding-sh-key`; the calls land in that
key's project. The agent's own API key still goes upstream unchanged. See
[Team](../guides/team.md#the-model-api-proxy).

## Undo

```sh
coding.sh uninstall --proxy          # stop routing agents through the proxy, keep the hooks
coding.sh proxy stop
```

`coding.sh uninstall` also removes the routing. Both restore each agent's config byte for byte when
nothing else changed it.
