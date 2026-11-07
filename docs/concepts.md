# Concepts

The words coding.sh uses, in the order you meet them. Each one links to where it is used.
Site version: [coding.sh/docs/concepts](https://coding.sh/docs/concepts).

## Recording

**Session.** One run of an agent: a Claude Code conversation, a Codex thread, one
`coding.sh run -- <cmd>`, or one trace from your own agent sent over OpenTelemetry or the SDK. It has an id, an agent, a model, a
repo, start and end times, totals and flags. List them with `coding.sh sessions`; open one with
`coding.sh show <id>`.

**Event.** One thing that happened in a session, stored in the
[coding.sh/trace v0](https://coding.sh/docs/trace-format) format. Kinds include `user.message`,
`llm.call`, `tool.start`, `tool.end`, `file.change`, `test.result`, `subagent.start` and
`turn.end`. Event ids are derived from their source, so importing the same transcript twice adds
nothing.

**Turn.** One user prompt and everything the agent does until it hands control back. A turn ends with
a `turn.end` event. The `TURNS` column in `coding.sh sessions` counts them.

**Tool call.** A `tool.start` and its matching `tool.end`: a shell command, a file read or edit, a
web fetch or an MCP tool. It records the tool name, input, output, whether it failed, and how long
it took.

**Model call.** One request to a model, stored as an `llm.call` event with tokens, latency, time to
first token and, when the agent reports it, cost. OpenTelemetry and the SDKs record model calls
directly. Coding-agent hooks do not see them, so most adapters recover them from the agent's
transcript. See [Agents and OpenTelemetry](guides/agents.md).

**Subagent.** A child agent started by a session, such as Claude Code's Task tool or a nested agent
span in an OpenTelemetry trace. It is stored as
its own session with a parent id. `coding.sh sessions --subagents` lists them, and
`coding.sh show` places them on the parent's timeline.

**Flag.** A failure pattern detected on a session after each ingest:

- `premature-completion`: the agent stopped while the last test run was failing.
- `repeated-tool-failure`: the same tool failed three times in a row with similar input.
- `no-verification`: files changed, but no test, type check, lint or build ran.
- `compaction`: the agent's context was compacted.

A flag with a colon, such as `gateway:vercel`, is a tag rather than a failure. Durable workflow runs
get two notes rather than failures: `step-retried` (a step took more than one attempt) and `resumed`
(the run continued after a crash, a deploy or a restart). See
[Trace a durable workflow](how-to/trace-durable-workflow.md).

**Spool, index and blobs.** Hooks append raw events to `~/.coding.sh/spool`. Ingest moves them into
the SQLite index (`index.db`); payloads larger than `capture.maxInlineBytes` go to the
content-addressed blob store (`blobs/`). See [Storage, sinks and privacy](guides/privacy.md).

**Sink.** A remote copy of your events, sent over OTLP or HTTP. Sinks send metadata only unless you
set `mode = "full"`. See [Configuration](reference/config.md#sinks).

**Project.** A namespace on a shared `coding.sh serve` server. Each ingest key belongs to one
project. See [PRODUCTION.md](PRODUCTION.md#13-projects).

## Evaluating

**Case.** One input to test, with an optional expected answer, metadata and a split (`train`,
`dev` or `test`). A case made from a session uses the session's first prompt as input.

**Dataset.** A named list of cases. Every change makes a new version, named by a content hash, so an
experiment always records exactly what it ran on. Cases get a split from a stable hash of their id
(60/20/20) unless you set one. See `coding.sh dataset`.

**Task.** What an experiment runs for each case: a command that reads the case input on stdin and
prints an answer, or an HTTP endpoint. Not to be confused with an eval task (below).

**Experiment.** One run of a task over a dataset, graded. It stores every case's output, scores,
latency and errors. `coding.sh exp run` makes one; `coding.sh exp compare` pairs two by case.

**Grader.** Scores one output. Built in: `exact`, `contains`, `regex`, `json-schema`, `json-path`,
`numeric` and `similarity`. A `command` grader runs your script, a `module` grader loads your code,
and an `llm` grader asks a model.

**Judge.** An `llm` grader. A judge is trusted only after `coding.sh judge calibrate` measures its
agreement with your pass/fail labels (Cohen's kappa) on a held-out split. Reports mark uncalibrated
judges.

**Paired comparison.** How `exp compare` decides. It matches cases by id, reports the mean change in
pass rate with a paired bootstrap confidence interval, and runs McNemar's test on the cases that
flipped. The verdict is `better` or `worse` only when the interval excludes zero; otherwise it is
`inconclusive`.

**Eval task.** A repo-replay task drafted from a captured session: the repo at the start of the
session, an instruction, a verifier command, and the session's diff as the reference answer.
`coding.sh eval validate` checks that doing nothing fails, the reference passes k of k times, and
the hidden tests do not leak. See [Turn a session into an eval](how-to/session-to-eval.md).

**Harness bundle.** A snapshot of an agent's setup: its config files, instructions and model.
`coding.sh harness snapshot` makes one; `coding.sh compare <a> <b>` runs two on the same eval tasks.
See [Compare two agents](how-to/compare-agents.md).

**Benchmark.** A definition in `bench/<name>.toml` that samples fresh cases on every run, freezes
them as a dataset, and runs every contender on that same set. `coding.sh bench show` prints the
leaderboard; `bench history` tracks it over time.

**Tool evals.** Measures how well agents use a CLI, MCP server or HTTP API, with variants of its
descriptions. See [TOOL-EVALS.md](TOOL-EVALS.md).
