# Replay recorded model calls

An agent that makes 30 model calls per case is slow and costly to re-run. When you change something
late in the run (a tool, a prompt step, a parser), the first calls come back the same every time.
`exp run --record` saves each case-trial's model calls. `exp run --replay` serves them again, up to
the first call your change touches, and runs the rest live.

It works with any task that calls the Anthropic or OpenAI API through an SDK that reads
`ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`.

## 1. Record

```sh
coding.sh exp run spec.json --record
```

The run starts a local proxy on `127.0.0.1` and gives each case-trial its own base URL:

- a command task gets `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` in its environment;
- a function task gets `ctx.llm.anthropicBaseUrl`, `ctx.llm.openaiBaseUrl` and `ctx.llm.env`.

Each call goes to the real API with the task's own key, and the reply streams back unchanged.
The experiment view counts them:

```
LLM calls: 412 (0 cached, 412 live)
```

## 2. Replay

```sh
coding.sh exp run cand.json --replay exp_01J…
```

For each model call, the proxy looks for a recorded call from the same case and trial with the same
request. If it finds one, it sends back the recorded reply and the real API is not called. The first
call with no match runs live, and so does every call after it in that case-trial:

```
LLM calls: 412 (318 cached, 94 live)
```

Each case-trial keeps its counts in `runs[].llm`: `calls`, `hits`, `live`, and `firstLiveOrdinal`
(the first call that ran live). If you change message 2 of a 3-call run, `firstLiveOrdinal` is 2.

`--replay-until N` serves only calls 1 to N from the recording. Call N+1 onward runs live, even when
it would match.

### What counts as the same request

The key is a sha256 of the request body after these steps:

- the system prompt is dropped: Anthropic `system`, OpenAI `system` and `developer` messages, and
  Responses `instructions`. A system-prompt edit still replays every call;
- `stream`, `stream_options`, `metadata`, `user` and every `cache_control` are dropped. Moving a cache
  breakpoint still replays every call;
- the run id, the working directory, the temp dir and `HOME` become placeholders;
- `"content": "hi"` and `[{"type": "text", "text": "hi"}]` count as the same message;
- object keys are sorted.

The spec can also leave tools or the model out of the key:

```json
{ "llm": { "replay": "exp_01J…", "excludeTools": true, "excludeModel": true } }
```

Calls made in parallel can arrive in another order. A replay takes the first unused recorded call
with the same key, so the order does not matter.

Only `POST /v1/messages`, `/v1/chat/completions` and `/v1/responses` are recorded. Other paths, such
as `/v1/messages/count_tokens`, go to the API and are not counted. Only 2xx replies are served from a
recording; a recorded 500 is sent live again.

## 3. Read the result against a control arm

A replay shares every recorded reply with the run it came from. Two replayed arms are correlated,
so the difference between them looks smaller and steadier than two live runs would show.

So `--replay` with one task runs two arms, interleaved case by case:

- A (`control`): the task spec the recording stored, replayed at the same `--replay-until`;
- B (`candidate`): your task.

The compare compares B with A, never with the recording. It also measures how far the control
alone drifts from the recording (outputs and verdicts that differ, and the spread of
`firstLiveOrdinal`) and prints that as the noise floor:

```
llm replay noise floor 4% (n=50) [1%, 14%]; control vs exp_01J…: 9 output(s) differ; first live call 3–12 (median 7)
! Replayed arms are correlated: …. Confirm with a fresh live run before you ship
```

The stored spec covers command and http tasks. A function task cannot be stored, so give the arms
yourself (`--arm control=recorded.json --arm cand=cand.json --replay exp_01J…`) or pass
`--no-control` to replay one task alone. With `--no-control`, compare warns that there is no noise
floor.

A case-trial whose replay cannot get past the boundary is not scored: when the recording has no
entry for it (it runs fully live, with a warning), or when a live call fails. The view shows these
as `unscored`.

## In the spec

```json
{
  "dataset": "smoke",
  "task": { "kind": "command", "command": "node agent.mjs" },
  "graders": [{ "kind": "exact" }],
  "llm": { "record": true, "upstream": { "anthropic": "https://api.anthropic.com" } }
}
```

`llm` takes `record`, `replay`, `until`, `upstream` (`anthropic`, `openai`), `excludeTools` and
`excludeModel`. The flags win over the spec.

## What is stored

Recordings live in `~/.coding.sh/llm-cache/<experiment>/<case hash>-t<trial>.jsonl.gz`, one line per
call: the ordinal, provider, path, key, model, status, content type, response body, start time,
latency and token usage. A replay records too, so it can be the source of the next replay.

- Request headers are never stored, so API keys and OAuth tokens are not written.
- Response bodies go through the secret redactor, and the job's own credentials are replaced with
  `[redacted:api-key]` if a reply echoes them. A line that was changed this way has
  `"redacted": true`; a replay serves the redacted text.
- The recorded task spec keeps environment variables except those whose names look like secrets
  (`KEY`, `TOKEN`, `SECRET`, …).

`coding.sh gc` keeps the cache under 1 GB, dropping the least recently used recordings first. To clear
it, delete `~/.coding.sh/llm-cache`.

## Limits

- The proxy adds under 50 ms per call (measured against a local stub API).
- WebSocket model APIs are not proxied.
- A task that sets its own base URL, or calls another provider, is not recorded.
