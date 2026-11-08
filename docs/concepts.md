# Concepts

The words coding.sh uses, in the order you meet them. Each one links to where it is used.
Site version: [coding.sh/docs/concepts](https://coding.sh/docs/concepts).

## Recording

**Session.** One run of an agent: a Claude Code conversation, a Codex thread, one
`coding.sh run -- <cmd>`, or one trace from your own agent sent over OpenTelemetry or the SDK. It has an id, an agent, a model, a
repo, start and end times, totals and flags. List them with `coding.sh sessions`; open one with
`coding.sh show <id>`. `coding.sh sessions` leaves out sessions with no turn, tool call or model call
(a hook that fired with no agent work behind it); `--empty` lists them too. A session the agent ran
without a person at the keyboard (`claude -p`, an Agent SDK, `codex exec`) has `stats.launch:
"headless"`, and a terminal or IDE session has `"interactive"`; `--where launch:headless` and
`--facets launch` use it.

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
transcript. See [Agents and OpenTelemetry](guides/agents.md). With
[the proxy](how-to/capture-with-proxy.md), a model call also keeps the full request and response:
system prompt, tool definitions, messages, cache use and timings. `coding.sh show <session>#n` reads
one, and `coding.sh diff-calls` compares two.
A session's model is the one that made most of its main-thread model calls (calls outside
subagents), not the last one seen. When more than one model made calls, `stats.models` counts the
calls per model.

**Replay.** `coding.sh exp replay` sends a logged model call again with one thing changed (the
model, the system prompt, a setting), several times per arm, and compares the arms like an
experiment.

**Fork.** `coding.sh replay <session> --step N --fork` sends the model call behind step N again
with changed context files (CLAUDE.md, AGENTS.md, a skill) or another model, and shows the recorded
next action beside the forked one. `--run` carries the fork on with the real agent, and
`--save-case` keeps the step as an eval case graded on the next action. It needs a session captured
through the proxy.

**Subagent.** A child agent started by a session, such as Claude Code's Task tool or a nested agent
span in an OpenTelemetry trace. It is stored as
its own session with a parent id. Its prompt counts as its turn, and its title is the task
description the parent gave it (Claude Code's `description`), else the first line of its prompt.
`coding.sh sessions --subagents` lists them, and `coding.sh show` places them on the parent's
timeline. Through the proxy, a Claude Code subagent's model calls land in its session too.

**Run.** A whole multi-agent run: a top-level agent, the subagents it spawned, and their
subagents, as one tree. `coding.sh tree <session>` shows it from any session in it (following the
parent ids up to the top-level agent, then back down), with per-node model, cost, tokens, duration
and tool calls, the run's rolled-up totals and the worst flag across the loop. A fan-out of
separate agent processes — the way large runs are launched — is one logical run when the orchestrator
sets `CODING_SH_RUN_ID` on each; pass that id to `coding.sh tree`. The relationships are derived
from the parent ids already stored, so nothing extra is recorded.

**Flag.** A failure pattern detected on a session after each ingest:

- `premature-completion`: the agent stopped while the last test run was failing, and its last
  words did not say so: it said it was done, fixed or passing, or said nothing about the failure.
  An agent that says plainly that tests still fail ("2 tests still fail", "I couldn't get test_x
  to pass", "not done yet") or asks how to go on about a failing test is not flagged. The check
  reads the agent's text after its last tool call in the turn, with a few word patterns, not a
  model.
- `repeated-tool-failure`: the same tool failed three times in a row with similar input.
- `no-verification`: files changed, but no test, type check, lint or build ran.
- `compaction`: the agent's context was compacted.
- `test-tamper`: the agent edited a test or test-runner config in a way that hides failures: it
  added a skip marker, deleted a test file while tests were failing, or changed an assertion and that
  edit alone turned a failing run green. New tests and edits to files the agent created stay
  unflagged, and so do these: a guard such as `t.skip("needs git")` inside a test the same edit
  adds; a fix to lines the agent added earlier in the session; an expectation updated after the
  agent's own source edit broke a test that passed earlier in the session; a green run of fewer tests
  than passed in the failing one; a skip marker inside a string literal, such as a diff or a `sed`
  command a test holds as data. A file that a shell command's diff reports but the command never
  names (a test run, or another agent writing to the same checkout) is never flagged, and files a git
  pull, merge, rebase, reset or checkout brought in are not counted as edits at all.
- `duplicate-fetch`: three or more read-only calls (Read, Grep, `cat`, `git diff`, …) in one context
  returned the same result as an earlier call, with no edit or compaction in between.
- `skill-copy-conflict`: the session used two copies of one skill, for example the project's and a
  personal one.
- `refusal`: a model call stopped on a refusal (`refusal`, `content_filter` or `safety`).
- `text-tool-call`: the model wrote a tool call out as text (a line that opens with
  `<invoke name="…">` and a parameter or the close), so the call never ran. A model does this when
  the tool it reaches for was not given to it. In Claude Code the usual cause is a subagent whose
  `tools:` frontmatter is a map such as `edit: false`: Claude Code reads `tools:` as a list of tool
  names, so the subagent gets none. List the tools, or deny some with `disallowedTools: Edit, Write`.
  Markup inside a fenced code block or in the middle of a sentence does not count.

A flag with a colon, such as `gateway:vercel`, is a tag rather than a failure. Each skill a session
used (through the Skill tool, or by reading or running a file in the skill's folder) adds a
`skill:<name>` tag. A skill's folder is `skills/<name>/` under an agent's dot folder (`.claude`,
`.agents`, `.codex`, `.config/opencode`, …) or inside a plugin; a `skills/` folder in source code,
text inside a heredoc and a write to a skill file do not count. A plugin named for its one skill
tags it once (`skill:frontend-design`, not `skill:frontend-design:frontend-design`).
`coding.sh sessions --flag skill:pdf` lists the sessions that used the pdf skill. Text that other
hooks added to the context (a plugin's SessionStart notes, a UserPromptSubmit reminder) adds a
`hook:<source>` tag: `hook:plugin:<name>`, `hook:settings`, `hook:plugin` or `hook:unknown`, and
`stats.hookContext` counts its tokens. `coding.sh sessions --where hook:plugin:caveman` lists the
sessions the caveman plugin's hooks added context to, and `--facets hook` counts sessions per source.
A session
in which redaction replaced a vendor token (an Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google,
Stripe, npm, coding.sh or AI Gateway key, a Slack webhook or a private key) gets the `secret:exposed`
tag: the stored copy is redacted, but the agent and its model provider saw the credential, so rotate it.
A key whose value is plainly made up, as in docs and test fixtures (`AKIAIOSFODNN7EXAMPLE`, the
word EXAMPLE or test after the vendor prefix, eight of one character, a chunk repeated three times,
`abcdefgh`), is redacted too but counts as `placeholder-key` and does not add the tag.
`coding.sh sessions --flag secret:exposed` lists them, and `stats.redactions` counts what was replaced
by kind. A session whose model changed mid-session gets the `model:switch` tag, and
`stats.modelSwitch` names both models, the trigger, how many switches there were and what the calls
on the other model cost over the first model's list prices. A change counts when the agent recorded
a fallback for it (Claude Code falls back to `--fallback-model` when the main model is overloaded,
and to another model after a refusal; that also adds the `model:fallback` tag), when it happened
inside a subagent, or when the main thread handed over for good: every main-thread call on the first
model came before the first call on the second. A switch and back counts once. A helper model that
runs beside the main one, such as the Haiku calls Claude Code makes for titles, is not a switch. A session of at least three
turns that wrote a prompt cache of at least one block (4,096 tokens) but read back fewer tokens than
it wrote gets the `cache:low` tag: it paid to create a cache it barely reused. Short sessions and
ones that never wrote a cache are left alone, since that is the agent's behaviour, not a setup to
change. `coding.sh usage --cache` shows the read-to-write ratio behind the tag, and
`coding.sh sessions --flag cache:low` lists the sessions. Durable workflow runs
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
`numeric`, `similarity` and `progress` (how long a run stayed on track, from its trace). A `command` grader runs your script, a `module` grader loads your code,
and an `llm` grader asks a model.

**Judge.** An `llm` grader. A judge is trusted only after `coding.sh judge calibrate` measures its
agreement with your pass/fail labels (Cohen's kappa) on a held-out split. Reports mark uncalibrated
judges.

**Paired comparison.** How `exp compare` decides. It matches cases by id, reports the mean change in
pass rate with a paired bootstrap confidence interval, and runs McNemar's test on the cases that
flipped. The verdict is `better` or `worse` only when the interval excludes zero; otherwise it is
`inconclusive`.

**Minimum detectable effect (MDE).** The smallest true gap a comparison finds 80% of the time. The
`power` line gives a normal approximation and the exact McNemar one, from the share of cases that
flipped. The exact test cannot reject with fewer than 6 flipped cases (α 0.05), so a small suite
has a power ceiling and may have no MDE at all: `no 80% power at this n`.

**Eval task.** A repo-replay task drafted from a captured session: the repo at the start of the
session, an instruction, a verifier command, and the session's diff as the reference answer.
`coding.sh eval validate` checks that doing nothing fails, the reference passes k of k times, and
the hidden tests do not leak. See [Turn a session into an eval](how-to/session-to-eval.md).

**Eval suite.** A folder, `evals/<name>/`, with a `suite.json` and what it runs: repo tasks from
failed sessions, a skill's `should` and `should_not` prompts, or cases for an app. `coding.sh eval
init` writes one and `coding.sh eval run` runs it k times per task. A **capability** suite holds
tasks the agent can't do reliably yet, and `eval run` never fails on its score. A **regression**
suite should pass nearly every time, and `eval run` exits 1 when a task fails most of its trials.
See [Your first eval](guides/evals.md#your-first-eval-in-5-minutes).

**pass@k and pass^k.** Over k trials of a task, pass@k is the chance that at least one passes and
pass^k the chance that all k pass. Both are estimated from n trials as C(n−c, k) and C(c, k) over
C(n, k), with c passes. A task that passes some trials and fails others is **flaky**: it counts for
pass@k and against pass^k.

**Harness bundle.** A snapshot of an agent's setup: its config files, instructions and model, and
for Claude Code any plugins named with `--plugin`.
`coding.sh harness snapshot` makes one; `coding.sh compare <a> <b>` runs two on the same eval tasks.
See [Compare two agents](how-to/compare-agents.md).

**Memory audit.** `coding.sh harness audit` counts, per memory and instruction file (auto-memory,
CLAUDE.md, AGENTS.md, rules, skills), the sessions that loaded it, read it with a tool and wrote
it, and flags files never read, written but never read back, and skills listed but never used.
See [Memory and instruction files](guides/explore.md#memory-and-instruction-files).

**Repair round.** With `compare --repair N`, a run whose verifier fails goes back to the agent in
its own session with "Verification failed." (and, with `--repair-signal names`, the failing test
names), up to N times. The hidden tests are out of the work tree while the agent works. A round
whose diff edits, deletes or skips tests does not count as a repair. The report gives Seq@k, the
share of tasks solved by the k-th attempt (the first, then each round), with where the gain lands,
rounds that changed nothing, cost to solve, and a cost front against k independent attempts
(pass@k). See [Repair rounds](guides/evals.md#repair-rounds).

**Agent release.** The agent version a compare run started on, stored on the run as `agentVersion`.
The agent's own prompt and tools change between releases, so when the two arms ran on different
releases, compare says the difference mixes the change with the release and `--promote` holds.

**Protected line.** A harness line an edit may not delete, reword or relax: inside a
`<!-- coding.sh:protect -->` block, matching a `[refine] protect` regex, or pairing a gate word with
a safety topic ("Never run `git push --force`"). `coding.sh refine check` and `exp ab` reject an
edit that drops one, since a pass-rate A/B can't see that harm. See
[Protected safety lines](guides/evals.md#protected-safety-lines).

**Benchmark.** A definition in `bench/<name>.toml` that samples fresh cases on every run, freezes
them as a dataset, and runs every contender on that same set. `coding.sh bench show` prints the
leaderboard; `bench history` tracks it over time.

**Tool evals.** Measures how well agents use a CLI, MCP server or HTTP API, with variants of its
descriptions. See [TOOL-EVALS.md](TOOL-EVALS.md).
