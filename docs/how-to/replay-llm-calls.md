# Replay recorded model calls

Record a run's model calls, then re-run your change with the calls before it served from the
recording and the rest live, against a control arm.

An agent that makes 30 model calls per case is slow and costly to re-run. When you change something
late in the run (a tool, a prompt step, a parser), the early calls come back the same every time.
`exp run --record` saves each case-trial's model calls, and `exp run --replay` serves them again up
to the first call your change touches.

## Before you start

- An [experiment](https://coding.sh/docs/experiments) spec whose task calls the Anthropic or OpenAI
  API through an SDK that reads `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`.
- The task's own API key. The proxy forwards each call to the real API with it.

## 1. Record

```sh
coding.sh exp run spec.json --record
```

The run starts a local proxy on `127.0.0.1` and gives each case-trial its own base URL. A command
task gets `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` in its environment; a function task gets
`ctx.llm.anthropicBaseUrl`, `ctx.llm.openaiBaseUrl` and `ctx.llm.env`. Replies stream back
unchanged. The experiment view counts the calls:

```text
LLM calls: 412 (0 cached, 412 live)
```

## 2. Replay your change

```sh
coding.sh exp run cand.json --replay exp_01J…
```

For each call, the proxy looks for a recorded call from the same case and trial with the same
request. A match gets the recorded reply and the API is not called. The first call with no match
runs live, and so does every call after it in that case-trial:

```text
LLM calls: 412 (318 cached, 94 live)
```

| Flag | Default | What it does |
|---|---|---|
| `--record` | off | Records the task's model calls through the local proxy. |
| `--replay EXP` | none | Serves that recorded experiment's calls, up to each case-trial's first changed call. |
| `--replay-until N` | none | Serves only calls 1 to N. Call N+1 onward runs live, even when it would match. |
| `--no-control` | control on | Replays your task alone, without the control arm. |

## 3. Read the result

Two replayed arms share every recorded reply, so their difference looks smaller and steadier than
two live runs would. So `--replay` runs two arms, interleaved case by case: A (`control`) is the
task spec the recording stored, replayed the same way, and B is your task. The compare is B against
A, never against the recording.

```text
llm replay noise floor 4% (n=50) [1%, 14%]; control vs exp_01J…: 9 output(s) differ; first live call 3–12 (median 7)
! Replayed arms are correlated: …. Confirm with a fresh live run before you ship
```

| You see | It means |
|---|---|
| `noise floor 4%` | The control alone differs from the recording in 4% of outputs. A smaller B − A may be noise. |
| `first live call 3–12` | Where replay stopped in each case-trial. Each run keeps it as `runs[].llm.firstLiveOrdinal`. |
| `unscored` | The recording had no entry for that case-trial, or a live call failed. It is left out. |
| `Replayed arms are correlated` | Confirm a win with a fresh live run before you ship it. |

:::more What counts as the same request
The key is a sha256 of the request body after these steps:

- The system prompt is dropped (Anthropic `system`, OpenAI `system` and `developer` messages,
  Responses `instructions`), so a system-prompt edit still replays every call.
- `stream`, `stream_options`, `metadata`, `user` and every `cache_control` are dropped.
- The run id, the working directory, the temp dir and `HOME` become placeholders.
- `"content": "hi"` and `[{"type": "text", "text": "hi"}]` count as the same message.
- Object keys are sorted.

Calls made in parallel can arrive in another order: a replay takes the first unused recorded call
with the same key. Only `POST /v1/messages`, `/v1/chat/completions` and `/v1/responses` are
recorded, and only 2xx replies are served from a recording.
:::

## Set it in the spec

```json
{
  "dataset": "triage",
  "task": { "kind": "command", "command": "node triage.mjs" },
  "graders": [{ "kind": "exact" }],
  "llm": { "record": true, "upstream": { "anthropic": "https://api.anthropic.com" } }
}
```

| Field | Default | What it does |
|---|---|---|
| `record` | false | Records the calls. |
| `replay` | none | The experiment to replay. |
| `until` | none | Same as `--replay-until`. |
| `upstream` | the provider's API | Base URLs for `anthropic` and `openai`. |
| `excludeTools` | false | Leaves the tool list out of the key. |
| `excludeModel` | false | Leaves the model out of the key. |

The flags win over the spec.

## What is stored

Recordings live in `~/.coding.sh/llm-cache/<experiment>/`, one gzipped line per call. A replay
records too, so it can be the source of the next replay. `coding.sh gc` keeps the cache under 1 GB,
dropping the least recently used recordings first.

- Request headers are never stored, so API keys and OAuth tokens are not written.
- Response bodies go through the secret redactor, and the job's own credentials are replaced with
  `[redacted:api-key]` if a reply echoes them. A replay serves the redacted text.
- The stored task spec drops environment variables whose names look like secrets (`KEY`, `TOKEN`,
  `SECRET`, …).

## If something goes wrong

| Symptom | Check |
|---|---|
| `0 cached` on a replay | The task sets its own base URL, or calls another provider. It must read `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`. |
| Everything runs live from call 1 | The first request changed. A change to the system prompt alone still replays; check the tools and the model, or set `excludeTools` / `excludeModel`. |
| A function task with `--replay` fails | A function task cannot be stored as the control. Give both arms: `--arm control=recorded.json --arm cand=cand.json`, or pass `--no-control`. |
| Calls missing from the count | Paths other than messages, chat completions and responses, such as `count_tokens`, go straight to the API. WebSocket APIs are not proxied. |

The proxy adds under 50 ms per call, measured against a local stub API.

## Next steps

- [Experiments](https://coding.sh/docs/experiments): compare the replayed run with others.
- [Capture model calls with the proxy](capture-with-proxy.md): log an agent's calls outside an
  experiment, then replay one with `exp replay`.
