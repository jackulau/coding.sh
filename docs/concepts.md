# Concepts

The words coding.sh uses, in the order you meet them, with a link to where each one is used.
Site version: [coding.sh/docs/concepts](https://coding.sh/docs/concepts).

## Recording

| Term | What it is |
|---|---|
| **Session** | One run of an agent: a Claude Code conversation, a Codex thread, one `coding.sh run -- <cmd>`, or one trace from your own agent. `coding.sh show <id>` opens one. |
| **Headless session** | A session the agent ran without a person at the keyboard (`claude -p`, the Claude Agent SDK, `codex exec`). Its `stats.launch` is `"headless"`, and `--where launch:headless` finds them. |
| **Event** | One thing that happened in a session, in the [coding.sh/trace v0](https://coding.sh/docs/trace-format) format, such as `llm.call` or `tool.end`. |
| **Turn** | One user prompt and everything the agent does until it hands control back. It ends with a `turn.end` event. |
| **Tool call** | A `tool.start` and its `tool.end`: a shell command, a file read or edit, a fetch or an MCP tool, with input, output and duration. |
| **Model call** | One request to a model, stored as an `llm.call` with tokens, latency and cost. Hooks do not see them, so most adapters read them from the transcript. See [Agents and OpenTelemetry](guides/agents.md). |
| **Replay** | `coding.sh exp replay` sends a logged model call again with one thing changed, several times per arm, and compares the arms. |
| **Fork** | `coding.sh replay <session> --step N --fork` sends the call behind step N again with changed context files or another model. Needs [the proxy](how-to/capture-with-proxy.md). |
| **Subagent** | A child agent a session started, such as Claude Code's Task tool, stored as its own session with a parent id. |
| **Harness child** | An agent started by another agent's shell tool, such as `codex exec` from Claude Code's Bash tool. Its `parent.type` is `"harness"`. An id a hook names links the child only when that session is in the store and was open when the child started, so a shell that outlived its agent starts top-level sessions. |
| **Run** | A top-level agent and every subagent under it, as one tree. [`coding.sh tree <session>`](https://coding.sh/docs/cli/tree) shows it with per-node cost, tokens and flags. |
| **Spool, index and blobs** | Hooks append raw events to `~/.coding.sh/spool`. Ingest moves them into `index.db` and large payloads into `blobs/`. See [Storage, sinks and privacy](guides/privacy.md). |
| **Sink** | A remote copy of your events over OTLP or HTTP, metadata only unless you set `mode = "full"`. See [Configuration](reference/config.md#sinks). |
| **Project** | A namespace on a shared `coding.sh serve` server. See [PRODUCTION.md](PRODUCTION.md#13-projects). |

## Flags

A flag is a failure pattern found on a session at each ingest.
`coding.sh sessions --flag <name>` lists the sessions that have it.

| Flag | The session |
|---|---|
| `premature-completion` | stopped while the last test run was failing, and the agent's last words did not say so. Saying "2 tests still fail" is not flagged. |
| `repeated-tool-failure` | had the same tool fail three times in a row with similar input. A search that found nothing is not a failure. |
| `no-verification` | changed files, but no test, type check, lint or build ran. |
| `compaction` | had its context compacted. |
| `test-tamper` | edited a test or test-runner config to hide failures: a skip marker, a test file deleted while tests failed, or an assertion change that alone turned a run green. |
| `duplicate-fetch` | repeated three or more read-only calls in one context with the same result and no edit in between. |
| `skill-copy-conflict` | used two copies of one skill, such as the project's and a personal one. |
| `refusal` | had a model call stop on a refusal (`refusal`, `content_filter` or `safety`). |
| `text-tool-call` | had the model write a tool call out as text, so it never ran. Usual cause in Claude Code: a subagent whose `tools:` frontmatter is a map, not a list. List the tool names, or deny some with `disallowedTools: Edit, Write`. |
| `unapproved-action` | ran a destructive or paid command the user's turn did not approve, such as `rm -rf` outside temp and build dirs, `git reset --hard`, `git push --force` or dropping a database. |
| `looping`, `failure-streak`, `churn`, `no-progress`, `stalled`, `context-thrash` | went off the rails in a long run. These are derails. See [Derails](guides/explore.md#derails). |
| `step-retried`, `resumed` | is a durable workflow run that retried a step, or continued after a crash or restart. Notes, not failures. See [Trace a durable workflow](how-to/trace-durable-workflow.md). |

For `unapproved-action`, a turn approves a command when it asks for it, says yes to the agent, or
gives leave in advance ("you don't need to ask"). A Claude Code permission prompt counts too. Codex
approval prompts are not seen. Dry runs, read-only commands and a package manager's own `-y` are
never flagged.

`unapproved-action` and `premature-completion` read word patterns, not a model. The full rules,
including what each flag leaves alone, are in
[src/core/sessions.ts](../packages/coding.sh/src/core/sessions.ts) and the files its `FLAGS` list
names.

## Tags

A flag with a colon, such as `gateway:vercel`, is a tag rather than a failure.

| Tag | Added when |
|---|---|
| `skill:<name>` | the session used a skill, through the Skill tool or a file in the skill's folder. |
| `hook:<source>` | another hook added text to the context, such as `hook:plugin:terse`. `stats.hookContext` counts its tokens. |
| `secret:exposed` | redaction replaced a vendor token. The agent and its provider saw it, so rotate it. A made-up example key adds no tag. |
| `model:switch` | the model changed mid-session. `stats.modelSwitch` names both models and the cost difference. A helper model, such as Claude Code's title calls, is not a switch. |
| `model:fallback` | the agent recorded a fallback, such as Claude Code's `--fallback-model` when the main model is overloaded. |
| `cache:low` | a session of three or more turns wrote a prompt cache of at least 4,096 tokens but read back fewer than it wrote. `coding.sh usage --cache` shows the ratio. |
| `fold:error` | coding.sh could not fold the session's events into stats (a coding.sh bug). `coding.sh ingest` tries again. |

What each tag's stat holds is in the [API reference](reference/api.md#get-apisessionsid).

## Evaluating

| Term | What it is |
|---|---|
| **Case** | One input to test, with an optional expected answer, metadata and a split (`train`, `dev` or `test`). |
| **Dataset** | A named list of cases. Each change makes a new version named by a content hash, so an experiment records what it ran on. |
| **Task** | What an experiment runs for each case: a command that reads the input on stdin and prints an answer, or an HTTP endpoint. |
| **Experiment** | One graded run of a task over a dataset. `coding.sh exp run` makes one and `coding.sh exp compare` pairs two by case. |
| **Grader** | Scores one output: built-in ones such as `exact`, `regex` or `json-schema`, your own script (`command`) or code (`module`), or a model (`llm`). |
| **Judge** | An `llm` grader. It is trusted only after `coding.sh judge calibrate` measures its agreement with your labels. Reports mark uncalibrated judges. |
| **Score** | One typed value on a session, event, case or eval run. Labels are human pass or fail scores. See [Scores](guides/evals.md#scores). |
| **Eval task** | A repo-replay task drafted from a session: the starting repo, an instruction, a verifier and the session's diff as the reference. See [Turn a session into an eval](how-to/session-to-eval.md). |
| **Eval suite** | A folder `evals/<name>/` with a `suite.json`. `eval run` never fails on a **capability** suite, and exits 1 when a **regression** suite's task fails most trials. See [Your first eval](guides/evals.md#your-first-eval-in-5-minutes). |
| **Harness bundle** | A snapshot of an agent's setup: config files, instructions and model. `coding.sh harness snapshot` makes one and `coding.sh compare <a> <b>` runs two on the same tasks. See [Compare two agents](how-to/compare-agents.md). |
| **Benchmark** | A `bench/<name>.toml` that samples fresh cases each run and runs every contender on them. `coding.sh bench show` prints the leaderboard. |
| **Tool evals** | How well agents use a CLI, MCP server or HTTP API, across variants of its descriptions. See [TOOL-EVALS.md](TOOL-EVALS.md). |

## Reading results

| Term | What it is |
|---|---|
| **Paired comparison** | How `exp compare` decides. It is `better` or `worse` only when the paired bootstrap interval excludes zero and an exact sign-flip test has p below 0.05, which needs at least 6 changed cases or clusters. Otherwise it is `inconclusive`. |
| **Minimum detectable effect (MDE)** | The smallest true gap a comparison finds 80% of the time. A small suite may have none: `no 80% power at this n`. |
| **pass@k and pass^k** | Over k trials, the chance that at least one passes, and that all k pass. A task that passes some trials and fails others is **flaky**. |
| **Seq@k** | With `exp run --seq K`, a failed trial is tried again with feedback. Seq@k is the share solved by attempt k. See [Sequential attempts](guides/evals.md#sequential-attempts-with-feedback). |
| **Regression to the mean** | A change run only on the cases a baseline failed looks better even when it does nothing. `exp compare` marks such a pair inconclusive. See [Running a subset](guides/evals.md#running-a-subset-failures-samples-the-first-n). |
| **Judge-corrected delta** | Human labels on a sample of each arm correct an LLM judge's B − A for the judge's own errors. See [Correcting a judge's delta](guides/evals.md#correcting-a-judges-delta-with-human-labels). |
| **Signal validity** | Whether a flag or tool errors predict failure beyond task difficulty. `compare --signals` prints it. See [Do the flags predict failure?](guides/evals.md#do-the-flags-predict-failure). |
| **Plausibly best set** | With three or more configs, the ones not significantly worse than the best. `exp sweep` prints it. |
| **Item difficulty** | A per-task difficulty from an item response model fit on stored runs. `compare --pick N --pick-by irt` runs the most informative tasks first. See [Picking tasks](guides/evals.md#picking-tasks-and-a-budget). |
| **Forgetting guard** | `exp sweep --guard` keeps the start config when the winner breaks what it solved on earlier suites. |
| **Repair round** | With `compare --repair N`, a run whose verifier fails goes back to the agent, up to N times. A round that edits, deletes or skips tests does not count. See [Repair rounds](guides/evals.md#repair-rounds). |
| **Agent release** | The agent version a compare run started on. When the two arms ran on different releases, compare says so and `--promote` holds. |
| **Protected line** | A harness line an edit may not delete or relax, such as "Never run `git push --force`". `refine check` and `exp ab` reject an edit that drops one. See [Protected safety lines](guides/evals.md#protected-safety-lines). |
| **Memory audit** | `coding.sh harness audit` counts the sessions that loaded, read and wrote each memory and instruction file, and flags files never read. Each session keeps the files its events name in `stats.memoryUse`. See [Memory and instruction files](guides/explore.md#memory-and-instruction-files). |
