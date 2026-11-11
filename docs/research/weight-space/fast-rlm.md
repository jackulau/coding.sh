# fast-rlm: capture and weight-space harness

Research for the weight-space plan. Repo: https://github.com/avbiswas/fast-rlm (MIT; Deno engine in
`src/`, Python wrapper in `fast_rlm/`, pushed 2026-08-24). Paths below are in that repo unless they start
with `packages/` or `docs/` (coding.sh). Read-only research: nothing was installed, cloned or run. The
repo has no sample log and no log fixture (tests only mock the engine), so the example record is built
from the code. That is marked below.

## Q1. Capture

### What writes the log

`src/logging.ts`, class `Logger`, over Pino: `pino({level:"info", timestamp: pino.stdTimeFunctions.isoTime,
base: null}, pino.destination({dest: currentLogFile, sync: false}))`. The file is
`<logDir>/<prefix>_<ISO time with : and . as ->.jsonl`, prefix `run` unless `--log-prefix`; `logDir`
defaults to `./logs` and Python's `run(log_dir=)` overrides it (`docs/guide/log-viewer.md`: "Every run
saves a `.jsonl` log file to `logs/`"). One Pino child per record carries `run_id`, `parent_run_id`,
`depth`. Quote: `const event_type = output !== undefined ? "execution_result" : "code_generated";`.

### Record schema (the `.jsonl` on disk)

| Field | Type | On which records | Notes |
|---|---|---|---|
| `level` | number | all | Pino level, always 30 |
| `time` | ISO string | all | Pino write time. TUI: `time: string` |
| `run_id` | string | all | `${Date.now()}-${random base36}`, one per agent in the tree |
| `parent_run_id` | string | all but the root | Absent on the root (undefined is dropped) |
| `depth` | number | all | 0 for the root; `max_depth` caps it |
| `step` | number | step records | 0 is the setup probe, then 1..N |
| `event_type` | enum | all | `agent_start`, `agent_end`, `code_generated`, `execution_result`, `final_result` |
| `code` | string | step records | The ` ```repl ` block the model wrote |
| `output` | string | `execution_result` | Captured stdout, truncated by `truncateText` |
| `hasError` | bool | step records | `execThrew`, the exact signal (not a text match) |
| `reasoning` | string | step records | `message.reasoning`, when the backend returns it |
| `usage` | object | step records | `prompt_tokens`, `completion_tokens`, `total_tokens`, `cached_tokens`, `reasoning_tokens`, `cost?` (`src/usage.ts` `toUsage`). Zero for step 0 and for ACP |
| `timestamps` | object | step records | `llm_call_start/_end`, `execution_start/_end` (ISO). Step 0 has only `execution_*` |
| `result` | any JSON | `final_result` | The `FINAL(...)` value |

Not in the disk log: `maxSteps` and `totalUsage` (both are built in `logStep` but only `totalUsage` goes
to `on_step`), the model name, and the `context` or `instruction` a parent passed to a child. There is
no record for `llm_query`, `mcp_call` or tool calls. They are inside the parent's `code` and show up only
as a new `run_id`. `src/view_logs.ts` looks for a `run_start` event that `logging.ts` never writes.

Quirks an importer must handle:

- `code_generated` does not mean "not executed". Both a failed code extraction and the `FINAL` step log a
  step without `output` (`src/subagents.ts` ~946 and ~1053: `logger.logStep({ step: i + 1, code, reasoning, usage, timestamps })`
  then `logFinalResult`). The `FINAL` step is followed by a `final_result`.
- Order is not guaranteed. The TUI parser says: "final_result entries written before step entries due to
  async pino buffering" (`tui_log_viewer/src/index.tsx`). Sort by `(run_id, step)`, never by file order.
- A child's final value is the return value of the parent's `llm_query` (`subagents.ts`: `const output = await subagent(...)`).
- A run can end with `agent_end` and no `final_result` ("Did not finish the function stack before subagent died").

Example (constructed from `logging.ts` and `ui.ts` types, not from a real log; to be replaced by the
recorded fixture):

```json
{"level":30,"time":"2026-02-23T20:33:31.402Z","run_id":"1771878811000-k3j9x0a1b","depth":0,"step":1,"event_type":"execution_result","code":"parts = await llm_query(context[:100])\nprint(parts)","output":"7","hasError":false,"reasoning":"...","usage":{"prompt_tokens":812,"completion_tokens":64,"total_tokens":876,"cached_tokens":0,"reasoning_tokens":0,"cost":0.0003},"timestamps":{"llm_call_start":"2026-02-23T20:33:30.9Z","llm_call_end":"2026-02-23T20:33:31.1Z","execution_start":"2026-02-23T20:33:31.1Z","execution_end":"2026-02-23T20:33:31.4Z"}}
```

### The live stream (`on_step`)

`src/events.ts`: with `on_step`, the engine appends NDJSON to `--events-file` ("Writes are synchronous ... so
the Python side can tail the file"). `emitEvent` is called from `logStep` and `logFinalResult` only. So
the stream has the same fields plus `totalUsage` (running global total over all agents), but no `time`, no
`level`, and no `agent_start` or `agent_end`. `fast_rlm/_runner.py` tails it in a thread; callback errors
are warned, not raised. `run()` returns `{results, usage, log_file}`.

### Where the logs are

No fixed home. `./logs` under the run's cwd, or `log_dir=`, or `--log-dir`. A persistent `Session`
(`docs/guide/sessions.md`) keeps `<session_dir>/[<session_id>/]state.json` whose `queries[]` carry
`log_file` and `run_id` (`subagents.ts`: `sessionState.queries.push({query, final, log_file: getLogFile(), run_id})`).
`~/.fast_rlm/acp.json` is only the ACP install marker. So the importer needs configured directories,
the cwd `logs/` of known projects, and `state.json` links.

### OpenTelemetry

No. A search of the whole tree for `otel`, `opentelemetry`, `telemetry` and `otlp` finds nothing in source,
docs or config; `deno.lock` mentions `opentelemetry` three times, as transitive dependencies. The ACP path
calls the Vercel AI SDK's `generateText` (`src/acp.ts`) with no telemetry option. (Inference: nothing
turns on AI SDK telemetry, so no spans leave the process.)

Backends (`src/call_llm.ts`, `docs/guide/cli-agents.md`, `docs/guide/acp-agents.md`):

| Prefix or env | Backend | Usage reported |
|---|---|---|
| unprefixed | OpenAI-compatible, default base `https://openrouter.ai/api/v1` (`RLM_MODEL_BASE_URL`) | yes, incl. OpenRouter `cost` |
| `claude-*` plus `ANTHROPIC_API_KEY` | native Anthropic (`src/anthropic.ts`) | yes |
| `vertex/` or `RLM_VERTEX_AI=1` | Vertex (`src/vertex.ts`) | yes |
| `cli:claude-code`, `cli:codex`, `cli:opencode` | spawns `claude -p`, `codex exec --json`, `opencode run --format json` | yes, real cost |
| `acp:*` | ACP bridge via `generateText` | no: "ACP agents report no token usage" |

### Would coding.sh hooks already capture the Claude Code and Codex children?

The CLI and ACP agents are used as a one-shot text model with tools denied; fast-rlm runs the code
itself. Each call is a fresh process in a throwaway cwd (`Deno.makeTempDir({prefix:"fast_rlm_cli_"})`,
`"fast_rlm_acp_"`). The env is inherited: `env: { ...Deno.env.toObject(), ...(spec.env ?? {}), PWD: cwd }`.

| Child | Hooks fire? | Why |
|---|---|---|
| `cli:claude-code` (default) | Likely yes (inference) | Args are `-p --output-format json --strict-mcp-config --disallowedTools ...`. `--bare` is the only flag that skips hooks, and it is opt-in (`cli_minimal`): "--bare additionally skips hooks, CLAUDE.md discovery, plugins" |
| `cli:codex` | No | Args include `--ephemeral --ignore-user-config`, so the user's hooks config is not read (inference) |
| `cli:opencode` | No hooks exist for it | coding.sh imports its store instead |
| `acp:claude-code` | Likely yes (inference) | Bridge spawns Claude Code with a `.claude/settings.json` written to the temp cwd; user hooks still merge unless overridden |

Linking to the RLM tree: nothing shared. No session id crosses the boundary. Two weak keys exist: the
temp cwd prefix (`fast_rlm_cli_*`, `fast_rlm_acp_*`) and the time window (a child session's span falls
inside one step's `timestamps.llm_call_start..llm_call_end`). Env is inherited, so launching fast-rlm
with `CODING_SH_RUN_ID` (the hook records it, `src/spool/hook.ts`) or a `TRACEPARENT` (see
`adapters/_shared/traceparent.ts`) tags every child with the run, but not with the step. Step-level
linking needs the time window.

### Adapter design

Id `fast-rlm`, tier B (transcript import, no hooks), `parseVersion: 1`. It follows the T3 Code pattern
(`src/adapters/t3code.ts`: `tier: "B"`, `backfill`, `tail`, `BackfillOpts.changed`). One shared converter
`convertFastRlmRecords(records, ctx)` serves both the disk log and the `on_step` shim.

| fast-rlm record | coding.sh event |
|---|---|
| root `agent_start` (no `parent_run_id`) | `session.start`, session `fast-rlm:<run_id>`, `cwd` unknown, `model` unknown |
| child `agent_start` | child session `fast-rlm:<run_id>` with `session.start` `{parentSessionId, subagentId: run_id, depth}`; in the parent: `subagent.start` `{subagentId, childSessionId}`, `parentId` = the parent cell's `tool.start` whose `execution_start..execution_end` holds the child's `time` (parallel `batch_llm_query` children share one cell) |
| step with `timestamps.llm_call_*` | `llm.call` `{ok}`, `durationMs = end - start`, `usage {inputTokens: prompt_tokens, outputTokens: completion_tokens, cacheReadTokens: cached_tokens, costUsd: cost}`, `payload.reasoningTokens`. Step 0 has no llm timestamps: no `llm.call` |
| `reasoning` | `assistant.message` `{text, thinking: true}` |
| `code` | `tool.start` `{tool: "repl", toolUseId: "<run_id>:<step>", input: {code}}` |
| `execution_result` | `tool.end` `{ok: !hasError, output}` (truncated, full text to a blob) |
| `code_generated` then `final_result` in the same run | `tool.end` `{ok: true}` plus, for a child, `subagent.end` `{ok: true, result}`; for the root, `assistant.message` `{text: result}` |
| `code_generated`, no `final_result` | `tool.end` `{ok: false, output: "no repl block"}` and an `error` event |
| `agent_end` | child: `subagent.end` (if missing); root: `session.end` `{reason: "complete"}`. No `agent_end`: `reason: "incomplete"` |
| `totalUsage` (`on_step` only) | `payload.reportedUsage`, never `usage` (schema rule; it is a global running total) |

Notes: ids are `ctx.id("fast-rlm", run_id, step, event_type)`, so the two capture paths dedupe. `source` is
`transcript` for the file and `sdk` for the shim. Code and output go through `core/redact.ts` as for any
adapter. The child's prompt and context are not logged, so `subagent.start.prompt` is absent. Model is
absent in the log: the shim can add it (it knows the config); the importer leaves it unknown, which
coding.sh already handles for other agents. Check how `inputTokens` treats cached tokens against the
existing OpenAI-style adapters before the golden is written.

Hook story: none. Three capture routes, in order: (1) import from log dirs (`backfill` + `tail()` true when a
configured dir exists); (2) a Python `on_step` helper in `packages/sdk-python` that calls the same
converter's JSON form and posts to `POST /v1/ingest` (`docs/ADAPTERS.md` row for the Python SDK); (3) spans
to `POST /v1/traces`, only if wanted for non-coding.sh viewers, since (2) already carries everything.

### Fixtures

Record under `scripts/e2e/fast-rlm-capture.mjs`, like `claude-subagent-capture.mjs`. It starts
`startStub({decide})` from `scripts/e2e/stub-model.mjs` (OpenAI chat completions, with a `usage` override),
runs `fast-rlm` with `RLM_MODEL_BASE_URL=<stub>`, `RLM_MODEL_API_KEY=stub`, a throwaway `HOME`,
`CODING_SH_HOME` and `--log-dir` in temp dirs. The stub script: root step 1 answers a ` ```repl ` block that
calls `llm_query` (two children via `batch_llm_query`, one that ends with `FINAL`); step 2 raises an
error; step 3 calls `FINAL`; one reply has no repl block. Scrub paths to `/work/demo` and `/home/user`, and
write the log to `test/fixtures/adapters/fast-rlm/`. Needs Deno and the `fast-rlm` package, so run it on the
desk (WSL), not on the Mac: Pyodide is downloaded on first run.

## Q2. Is RLM a good harness for weights?

### The paper

arXiv 2512.24601, "Recursive Language Models", Zhang, Kraska and Khattab (MIT CSAIL), v1 2025-12-31, v3
2026-05-11. Method: the prompt becomes a variable in a Python REPL; the model reads slices in code and
calls itself on pieces. Numbers from the abstract page (https://arxiv.org/abs/2512.24601): "inputs up to two
orders of magnitude beyond model context windows"; with GPT-5 on four long-context tasks, median gains of
26% over compaction, 130% over CodeAct with sub-calls and 13% over Claude Code at comparable cost;
RLM-Qwen3-8B beats Qwen3-8B by 28.3% on average. The weight-space post
(https://rikiyat.github.io/blog/weight-space-programming/) says the work is "constrained by context length
and harness design" and used "a Python sandbox, sometimes with a limited number of forward passes".

### Fit

The pattern fits: the weights stay outside the prompt, the agent reads a manifest, pulls slices, and
recurses per layer or head. fast-rlm as shipped fits poorly:

| Question | Answer | Source |
|---|---|---|
| Does the REPL load numpy or torch? | Pyodide 0.29.3 (`deno.json`), pure Python plus what `micropip` installs. The engine installs only `requests` and `httpx`. Docs: "Python 3.13 stdlib ... but no pandas/yaml". numpy is a Pyodide-built package, so `micropip` may fetch it (inference, not tested). torch is not in Pyodide (inference); it also would hit the wasm memory cap | `src/subagents.ts` ~213, `docs/getting-started/quickstart.md` |
| Do custom tools run host-side? | No. "fast-rlm extracts each tool's source with `inspect.getsource` and re-executes it inside the root agent's Pyodide REPL". Tools must be self-contained | `docs/guide/tools.md` |
| Any host-side route? | Yes, MCP: `mcp_servers={...}` run on the host (stdio or HTTP), called as `await mcp_call(server, tool, **kwargs)`. A Python MCP server with torch is the only way to run forward passes or load a checkpoint | `README.md` "MCP servers", `subagents.ts` `__js_mcp_call__` |
| Can weights be the input context? | Only `.json`, `.yaml`, `.jsonl` as dict or list, or text. So the context is a manifest (tensor names, shapes, stats), and tensors are fetched by MCP | `quickstart.md` |
| Shared state across sub-agents? | None in the REPL: "A sub-agent ... starts with a fresh REPL". State must live in the MCP server | `tools.md` |

Verdict: good harness shape, but only with a host-side weights MCP server (torch, safetensors, a delta
log). Pyodide alone cannot hold or edit real weights. A weight task would run as: root gets a manifest
dict; its REPL calls `mcp_call("weights", "read_slice", tensor=..., rows=...)`; it spawns one child per
layer with `llm_query` (the child gets the MCP server only if granted: `inherit_mcp`); edits go through
`mcp_call("weights", "write_slice", ...)` or a sparse delta; `FINAL` returns the edit list.

### What coding.sh would record

fast-rlm's log keeps the code cells and the child tree, but not the MCP calls or their results as
records (they are text inside `code` and `output`). So:

1. The cells: `tool.start/end` with code and output (item 1 below).
2. The tree: child sessions and `subagent.*` pairs (item 1).
3. The tensors touched: only the weights MCP server knows them. It should emit its own events
   (`tensor`, op `read|write`, shape, slice, before/after hash, delta norm, forward-pass count) to coding.sh
   with a `traceparent` or `CODING_SH_RUN_ID`, so they join the RLM session by time window.

## Ranked build items

| # | Item | What the user gets | Files | Smallest version | Test | Size |
|---|---|---|---|---|---|---|
| 1 | fast-rlm importer | A fast-rlm run, with its sub-agent tree, steps, tokens and cost, in `coding.sh` and the viewer | `src/adapters/fast-rlm.ts` (or `more/`), `adapters/index.ts`, `docs/ADAPTERS.md` row, `CHANGELOG.md`, `cli/registry.ts` if a flag is added | One session per file, `subagentId` on events, no child sessions; dirs from `CODING_SH_FASTRLM_LOGS` and `./logs`; `parseVersion: 1` | Golden from the recorded fixture; re-ingest is idempotent; a truncated log and a reordered `final_result` still fold | M |
| 2 | Recorded fixture and capture script | Tests on a real log, not a guess | `scripts/e2e/fast-rlm-capture.mjs`, `test/fixtures/adapters/fast-rlm/` | One root, one child, one error, one `FINAL`; scrub paths | Capture runs on the desk; fixture has no home path or key | M |
| 3 | Child sessions and cell-level parent link | A real tree: each child is its own session under the parent's cell | Same adapter; `sessions.ts` only if the parent link needs it | Link by `parent_run_id`, `parentId` by the time window | Golden has `parentSessionId`; parallel children share one cell | S |
| 4 | Weights MCP server events | Tensors touched, slices, hashes, delta size next to the cells | New `packages/` server or `src/mcp/` tool; event `span` with `name: "weights.*"` | `read_slice` and `write_slice` emit a `span` with tensor, shape, hash before and after | Temp-dir toy safetensors file; run id joins the session | L |
| 5 | Python `on_step` helper | Live view while a run is going | `packages/sdk-python/src/coding_sh/fast_rlm.py` | `on_step=coding_sh.fast_rlm.on_step(client)` posts raw records to `/v1/ingest`, adds `model` and receive time | Mock transport; same golden as item 1 | S |
| 6 | CLI-child linking | Claude Code children from `cli:claude-code` show under the RLM step | Importer plus the claude-code adapter's cwd filter | Match cwd prefix `fast_rlm_cli_`/`fast_rlm_acp_` and time inside `llm_call_*`; show as `childSessionId` | Fixture with a `cli:claude-code` run against the stub (needs `claude` on the desk) | M |
| 7 | Redaction check | No keys or paths in imported cells | `core/redact.ts` only if a rule is missing | Run the importer over the fixture with a planted secret | Secret absent from the store | S |
