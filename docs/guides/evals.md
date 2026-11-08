# Evals and comparisons

Eval runs that drive a real agent or an LLM judge call that agent or provider, with your
credentials and at your cost.

## Your first eval in 5 minutes

`coding.sh eval init` writes a suite to `evals/<name>/` in your repo and prints the command that
runs it. `coding.sh eval run` runs every suite there, or the ones you name, and prints a report.
Run `eval init` with no flags in a terminal and it asks what you want to test. Pick the case below
that matches what you have.

### Your agent's failed sessions

```sh
coding.sh eval init --sessions --verifier 'npm test'
coding.sh eval run failures --yes
```

`eval init --sessions` takes up to 10 sessions from this repo in the last 14 days that coding.sh
flagged (a failed tool call, an unverified claim, a loop, …) and makes one repo task from each: the
repo as it was before the session, the session's first prompt as the instruction, and your
verifier. Each task's row names the session it came from. It ingests first, and waits up to 30
seconds for an ingest already running, so a session that just ended is included. `--session <id>`
(or `latest`, or an id prefix) picks sessions yourself; `--since` and `--limit` change the window.
`--repo <DIR>` takes sessions under another directory instead (a second checkout, or the
worktrees a loop of agents runs in), and `--repo all` from any repo. The suite is called
`failures` unless you name it (`coding.sh eval init mine --session latest`), and a name that
exists needs `--force` to replace it. `--force` stops when the suite holds a file `eval init` did
not write or that you changed since (a `reference.patch` you added, a prompt you fixed) and lists
them; `--force-all` deletes those too. `evals/<name>/.eval-init.json` records what `eval init`
wrote.

The session failed, so its diff is not a correct answer. It is saved as a near miss
(`near-misses/001.patch`) that the verifier must fail. Add a correct fix as `reference.patch` in
the task dir, load it with `coding.sh eval import evals/failures/tasks/<task>`, and `coding.sh eval
validate <task>` checks the verifier both ways. The verifier must pass with this task's fix alone:
a whole test suite that also covers other bugs never passes. Until there is a reference, `eval run`
lists the task as having no reference solution.

This is a **capability** suite: tasks the agent can't do yet. `eval run` runs the agent (the one the
sessions used) 3 times per task, from a snapshot of your current setup, and exits 0 whatever the
score. The tasks start from snapshots on this machine, so they run here, not in CI. To test a
change to your setup on them, use `coding.sh compare <before> <after> --tag suite:failures`.

### A skill

```sh
coding.sh eval init --skill .claude/skills/pdf --draft
coding.sh eval run pdf --yes
```

This writes `evals/pdf/triggers.toml` with prompts where the agent should load the skill and
prompts where it should not. `--draft` has a model write them (Anthropic by default, with
`ANTHROPIC_API_KEY`; `--draft openai` or a provider JSON picks another). The file says DRAFT at the
top: read it and fix what is wrong before you trust a score. Without `--draft` you get TODO
prompts to fill in, or pass your own with `--should` and `--should-not`. `eval run` refuses to run
a file that still has TODO prompts. When the skill dir already has a `triggers.toml` (the file
`coding.sh eval trigger <skill>` reads) and you give no prompts and no `--draft`, the suite points
at that file instead of writing its own.

`eval run` runs each prompt 3 times in Claude Code with the skill and its sibling skills installed,
reads from each captured session whether the skill loaded, and reports precision, recall and F1
next to pass@k. It is a **regression** suite, so it exits 1 when a prompt is wrong in most of its
trials. To test whether a skill or CLAUDE.md helps on real work rather than whether it loads, see
[Evaluate an Agent Skill](../how-to/evaluate-a-skill.md) and
[Test a CLAUDE.md change](../how-to/test-claude-md-change.md).

### An app or a prompt

```sh
coding.sh eval init triage --cases cases.jsonl --command 'node triage.mjs'
coding.sh eval run triage
```

`cases.jsonl` holds one `{"input": …, "expected": …}` per line. The command gets each input as JSON
on stdin and prints its answer; `--url` posts it to an HTTP endpoint instead. No cases yet? Describe
the app and have a model draft some:

```sh
coding.sh eval init triage --describe 'Labels a support ticket billing, bug or other' \
  --command 'node triage.mjs' --draft
```

Drafted cases carry `"metadata": {"draft": true}` until you edit them. `eval init` picks the
graders from the cases: an `exact` grader (case and whitespace ignored) when every expected answer
is short, an LLM judge that compares the output with the expected answer when they are long, and a
judge on your description when there are none. A judge needs `ANTHROPIC_API_KEY`; check it against
your own labels with `coding.sh judge calibrate` before you trust it (see [Judges](#judges)).

This is a **regression** suite. `eval init` also prints a GitHub Actions workflow that runs it on
every pull request, and `eval run` exits 1 when a case fails most of its trials. The run is an
ordinary experiment, so `coding.sh exp show <id>` and `exp compare` work on it.

### The report

```
$ coding.sh eval run failures -k 2 --yes

failures  capability suite · 1 task · 2 trials each
pass@1  50.0% [9.5%, 90.5%]  (1/2 trials, 95% Wilson)
pass@2  100.0%  a task counts when any of 2 trials passes
pass^2  0.0%  a task counts only when all 2 trials pass

task                     passed         first failure
-----------------------  ------  -----  ---------------------------
make-sum-js-add-its-two     1/2  flaky  coding.sh show 4fd72079-09a

flaky: make-sum-js-add-its-two. These pass some trials and fail others; pass^2 counts them as failures.
1 task: a suite this small only shows large changes; grow it toward 20 to 50 tasks from real failures
1 task without a reference solution (make-sum-js-add-its-two): add reference.patch to the task dir, then coding.sh eval validate <task>
harness claude-code-project (3 files) · experiment exp_01M6WGQF2R1GZWABGSSJY7BR87
```

This is real output from `scripts/e2e/eval-init-capture.mjs`, where Claude Code runs against a
stub model that writes the right fix in one trial and a wrong one in the other. `pass@1` is the
share of all trials that passed.

- **pass@k** is the chance that at least one of k trials passes, **pass^k** that all k pass. They
  are estimated per task from all its trials and averaged. A product that must work every time
  wants pass^k; a tool where one good answer is enough can use pass@k.
- A **flaky** task passed some trials and failed others. It counts for pass@k and against pass^k.
- **first failure** links the session of a failed trial (`coding.sh show <id>`, or the viewer), or
  gives the grader's reason. Read failed transcripts before you change a prompt or a grader: a
  task no trial ever passes is more often a broken task than a hard one.
- Under the table, **Verifier output of failed runs** shows the last 8 lines that the verifier
  printed for up to 5 failed trials of a repo task suite. See
  [Verifier output](#verifier-output).
- A capability suite where 90% of tasks pass every trial is saturated: it no longer shows
  progress, so add harder tasks or move it to regression.
- Under 20 tasks the report says the suite can show only large changes.

`eval run --json` prints the same report as JSON. `-k` changes the trials, `--model` and `--agent`
the agent, and `--harness <bundle>` runs a repo task suite with a stored harness instead of the
current setup. Suites can also be built by your agent through the `eval_init` MCP tool.

### From Anthropic's roadmap to coding.sh

Anthropic's [Demystifying evals for AI
agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) gives an eight-step
roadmap. What each step maps to here:

| Step | coding.sh |
| --- | --- |
| 0. Start early, with 20 to 50 tasks from real failures | `eval init --sessions` makes tasks from flagged sessions; the report notes suites under 20 tasks. |
| 1. Start with what you already test manually | `eval init --cases` with your checks as cases; `dataset add --session` keeps one session's prompt as a case. |
| 2. Unambiguous tasks with reference solutions | `eval validate` checks that doing nothing fails, the reference passes k of k and near misses fail; `eval crosscheck` reviews the verifier. |
| 3. Balanced problem sets | `should` and `should_not` prompts for skills; drafted cases are asked to be half and half, and `eval init` warns when every case tests the same side. |
| 4. A stable, isolated harness | Each repo trial starts from a fresh copy of the snapshot, with hidden tests added only for the verifier; harness bundles pin the setup. |
| 5. Graders: code first, then models | `eval init` picks a code grader when it can; LLM judges are marked uncalibrated until `judge calibrate` measures them against your labels. |
| 6. Read the transcripts | The report links each failed trial's captured session; `coding.sh show` and the viewer open it. |
| 7. Watch for saturation | The report flags a capability suite where 90% of tasks pass every trial. |
| 8. Keep suites healthy | Suites are files in your repo, reviewed like code; `eval run` in CI fails a pull request that breaks a regression suite. |

## Session to eval

`coding.sh eval new <session> --verifier "<cmd>"` drafts a replayable task that starts from the
repo snapshot taken before the agent ran.

`coding.sh eval validate <task>` checks that the verifier is fair: a do-nothing attempt fails, the
reference fix passes k of k, near-misses fail, an impossible variant fails, and no future history
leaks. When a check goes the wrong way (the reference fails, the no-op or a near-miss passes, or
setup fails), it prints the last 12 lines of that command's output under the summary, once per
kind of check. `--json` has each step's output in `steps[].outputTail`.

Validation also looks for gold-only coupling: a hidden test that names a helper or file only the
reference introduces, which the instruction never mentions (`_parseCidr`, `src/acl/util.ts`). A
valid solution that names things differently fails such a test. Each case is listed as a note and
in `report.coupling`. It does not block validation unless you pass `--strict-coupling`.

`coding.sh eval crosscheck <task> [--experiment <id>] [--max 5]` checks the verifier from the
other side. A reviewer model reads the instruction and each stored run's diff, with the reference
shown as one valid answer among many, and decides whether the change is valid. Where it disagrees
with the verifier, the run is a false reject (the verifier failed a valid fix) or a false accept
(it passed an invalid one). The report lists each disagreement next to any coupling found by
`eval validate`. Cancelled and timed-out runs are skipped. `--solver <bundle>` first solves the
task once with that harness and reviews that attempt too. `--judge '{"provider":"openai","model":…}'`
picks the reviewer (default Anthropic). It makes one model call per run, at most `--max`. The
counts are stored at `task.meta.crossCheck`, in the same shape as a human verifier audit (see
[Auditing a test verifier](#auditing-a-test-verifier)), and `eval list --json` shows them.

`coding.sh eval export --format harbor` writes a Harbor-format task.

### Hand-written tasks

Some behaviour has no session to start from, such as "asks which team before collecting
anything". You can write those tasks as directories and load them with `coding.sh eval import
tasks/*/`:

```
tasks/asks-for-scope/
  task.json        {"name": "asks-for-scope", "tags": ["skill-eval", "suite:scope"],
                    "setup": ["…"], "verifier": {"command": "sh grader/verify.sh"}}
  instruction.md   the prompt the agent gets
  repo/            the start tree (optional; without it the task starts empty)
  tests/           hidden files, copied into the work tree only for the verifier
```

A hidden file lands at its path inside `tests/`: `tests/check.js` becomes `check.js` in the work
tree, so the verifier runs `node check.js`. To have it at `tests/check.js`, put it at
`tests/tests/check.js`. `eval import` warns when the verifier names a `tests/` path that only a
hidden file at the root would match, since such a command finds no file, and a test runner given a
glob that matches nothing can run zero tests and pass.

A task can start from a commit of a git repo instead of `repo/`: `"start": {"commit": "af23a50"}`
starts from that commit of the repo the task directory is in, and `"start": {"commit": "HEAD~1",
"repo": "../app"}` from a commit of the repo at that path, relative to the task directory. This
lets a suite live inside the repo it tests. `eval import` fails when the commit is not in the
repo; fetch it first.

The task id comes from the name, so importing again updates the task in place. Imported tasks are
drafts. A draft has no reference patch for `eval validate` to check, so `compare` skips drafts by
default. Use `compare --tag <tag>` to run them.

The verifier can grade more than the work tree. It gets these environment variables:

- `CODING_SH_AGENT_OUTPUT`: a file with the agent's final answer.
- `CODING_SH_AGENT_STDOUT`: a file with the agent's whole stdout. For Claude Code this is
  stream-json, with every tool call and its result.
- `CODING_SH_AGENT_DIFF`: a file with the agent's work-tree diff, taken before the hidden files
  land. `judge grade` hands it to the [agent-slop](#agent-slop) grader.
- `CODING_SH_AGENT`: the agent's adapter id.

The files live outside the work tree, so the agent can't edit what gets graded. A verifier can
`grep` them, or hand them to `coding.sh judge grade` (see [Checklists and trace
checks](#checklists-and-trace-checks)).

A verifier that grades the answer or the trace needs a recorded run to validate against, since a
patch alone has no answer and no tool calls. Put a correct run in `reference/` and wrong ones in
`near-misses/<label>/`:

```
tasks/load-check/
  reference/output.md               the final answer of a correct run
  reference/stdout.jsonl            its stdout (stream-json for Claude Code)
  reference.patch                   its diff, if it changed files
  near-misses/ran-uptime/output.md  a wrong run: output.md, stdout.jsonl and diff.patch, each optional
  near-misses/ran-uptime/stdout.jsonl
```

`eval validate` then runs the verifier with `CODING_SH_AGENT_OUTPUT`, `CODING_SH_AGENT_STDOUT`
and `CODING_SH_AGENT_DIFF` pointing at each run's files. The no-op attempt gets empty ones, the
reference run must pass k of k, and each near-miss run must fail. A task with a reference run
needs no `reference.patch`.

[Evaluate an Agent Skill](../how-to/evaluate-a-skill.md) walks through a full set of hand-written
tasks, from a stub CLI to the compare report.

## Datasets and experiments

`coding.sh dataset add|import` keeps versioned cases with stable train/dev/test splits.

`coding.sh exp run` runs a command or HTTP task over a dataset. Graders can be deterministic
(exact, contains, regex, numeric, similarity, JSON schema, JSON path, progress, executability,
calls, agent-slop), a command, or an LLM judge. `progress` scores the run's trace: the share of the run
before its first derail. `executability` scores the share of tool calls before the first one the
harness refused to run (see [Executability](explore.md#executability)). `calls` checks the tool
calls in the trace, with the same `must`, `mustNot`, `max` and `order` fields as the tool-eval
`calls` check ([Tool evals](../TOOL-EVALS.md#3-task-format)); an MCP tool matches by its own name
or by the agent's (`mcp__github__create_issue`). `agent-slop` flags placeholder code, type escapes, swallowed errors and other patterns in
the lines a diff adds (see [Agent slop](#agent-slop)). [Grader fields](#grader-fields) lists every
kind and its fields.

With a spec file, each `--grader` (`-g`) is added to the spec's `graders`: `exp run spec.json -g
judge.json` grades with both. `--replace-graders` uses only the `--grader` ones. A `--grader`
identical to one already in the spec is not added twice.

`coding.sh exp compare A B` reports the paired bootstrap CI of the difference, an exact McNemar
test on flipped cases and the minimum detectable effect. It also reports:

- **Clusters.** `--cluster repo` resamples groups of related cases (any case metadata field;
  `session` falls back to the case's source session) instead of single cases. It prints the cluster
  count and warns below 10 clusters. Without the flag, cases are treated as independent.
- **A Bayesian check at small n.** Below 100 paired cases it adds P(B>A) and a credible interval
  from a Dirichlet posterior on the paired outcomes. The bootstrap interval stays.
- **Attrition.** Per arm, trials lost to task errors, grader errors or missing runs, split into
  infra errors (timeouts, network, HTTP 429/5xx) and agent errors. Fisher's exact test flags an
  uneven split at p < 0.01.
- **Grader versions.** Each grader's version is part of the comparison. When a grader changed
  version between A and B, or graded only one side, a yellow line above the verdict says so: the
  pass rate requires every grader to pass, so B − A then mixes the change under test with a change
  of measurement. `--json` carries `comparison.instrumentWarning`, `graders[].versionChanged` and
  `gradersOnlyIn`. When one side is a regrade of the other, the line says B − A is the grader
  change alone and the timing warning is dropped. A grader that throws leaves its run ungraded:
  it is neither a pass nor a fail and is left out, unless another grader failed the run, which
  makes it a fail. Cases that ran on both sides but have no graded
  run on one are listed in `comparison.ungradedCases`.
- **Noise floor.** When an A/A run exists for the baseline config, it prints the A/A flip rate,
  and the minimum detectable effect never goes below what that noise allows.
- **Exact power.** The `power` line also gives the exact McNemar view, from the share of cases
  that flipped (raised to the A/A flip rate when that is larger). The exact test needs at least 6
  flipped cases to reject at α 0.05, so a small suite has a power ceiling: at 45 cases with 14%
  flipped, even the largest possible gap is found only 62% of the time. Then the line reads
  `no 80% power at this n (exact McNemar ceiling 62%)` and a `no-power` warning says so;
  otherwise it adds `exact MDE 10.6pp`, and the below-MDE warnings use the larger of the two MDEs.
  `compare` (harness A/B) prints the same line. The exact power sums K ~ Bin(n, d) flipped cases
  against the exact test (arXiv 2610.04433, power appendix).
- **Timing.** When the two runs were not interleaved and ran one after the other, it warns and
  says how far apart they were. Provider drift, rate limits and time of day can look like a change.
- **Coverage turnover.** With 2+ trials per case, a case is covered when it passed in at least one
  trial. The `coverage` line gives each arm's covered share, the cases B gained (A never passed, B
  passed at least once), the cases B lost (A passed at least once, B never) and those covered in
  both. Lost cases are listed under `lost coverage`, before the regressions. A net coverage gain
  can hide lost cases, and the mean pass rate can move the other way from coverage, so gains and
  losses are counted apart. The `reliability` line counts cases whose pass rate went up, down or
  stayed the same. The `halves` line splits each case's trials in order (trials 1 to k/2, then the
  rest) and gives B − A in each half. When the two halves have opposite signs it warns, and when the
  verdict is significant the warning asks you to confirm with more trials. `--matrix` prints the
  success-count matrix: cases by passes out of k in A (rows) and in B (columns), so the cells below
  the diagonal are cases B passed less often. `--json` always carries `comparison.turnover`
  (`gained`, `lost`, `keptCovered`, `neverCovered`, `reliability`, `matrix` when every case ran k
  trials in both arms, `halves`). With one trial per case, coverage is the pass rate, so the text
  output leaves these lines out. Method: EvoAudit (arXiv 2611.07624).

`coding.sh exp compare A B --gate` adds a ship-or-hold line under the verdict: `Ship it: B wins 8
cases, loses 0`, `Hold: not enough evidence`, or `Don't ship: B breaks 2 cases A solved` with up to
5 of the broken cases. It exits 0 only for "Ship it" and 1 otherwise, and `--json` carries
`comparison.gate`. It uses each case's majority outcome over its trials (a 0.5 pass rate counts as
a pass) and only cases both sides graded. A fixed case is a win and a broken one is a loss. B ships
when wins minus λ times losses is positive (`--lambda`, default 2). The wins must also beat
break-even in an exact one-sided binomial test at `--gate-alpha` (default 0.05), and B may break at
most `--tau` (default 10%) of the cases A solved. This is SAGE's accept-or-abstain rule (Wang et
al., arXiv 2609.36043). Plain "mean went up" accepts changes that break solved cases. At `--lambda
1 --gate-alpha 1 --tau 1` the gate is exactly "more fixes than breaks". When trials were lost to
errors unevenly, the gate notes that a task error counts as a failure.

`coding.sh exp compare A B --margin 0.03` is a paired non-inferiority check: is B at most 3pp worse
than A? Use it to keep a cheaper or faster config only when it gives up no more than the margin.
B is non-inferior when the lower end of the 95% paired bootstrap interval of B − A (the one the
`B − A` line prints, over clusters with `--cluster`) lies above −0.03, a one-sided test at 2.5%
(the confidence-interval form in the CONSORT non-inferiority extension). The report prints
`non-inf B − A ≥ -3.0pp: yes (95% CI lower bound -1.2pp > -3.0pp)` or `no`, and lists cases A
passed on every trial that B now passes at most a third of the time, which a mean within the
margin can hide. It exits 1 unless B is non-inferior; `--json` carries
`comparison.nonInferiority` (`mean`, `lower`, `delta`, `nonInferior`, `n`, `alpha`,
`hardRegressions`). The test itself is `nonInferiority(diffs, delta)` in `src/stats/tests.ts`.

### Grader fields

A grader is a JSON object with a `kind`. Every kind takes `name`, the grader's id in reports
(default: the kind, or the judge's name). Graders that compare with an answer use the case's
`expected` unless the grader gives `value`. A run passes when every grader passes it.

| Kind | Fields | Passes when |
|---|---|---|
| `exact` | `value`, `normalize` | The output equals the answer. JSON values compare structurally; text compares after `normalize`. |
| `contains` | `value` (a string or a list), `mode` (`all` by default, or `any`), `negate`, `normalize` | The output contains every substring (or any, with `mode: "any"`). With `negate`, when it contains none of them. |
| `regex` | `pattern` (required), `flags` (`g` and `y` are ignored), `negate` | The pattern matches the output text. With `negate`, when it doesn't. |
| `json-schema` | `schema` (required) | The output, parsed as JSON when it is text, validates against the schema. |
| `json-path` | `path` (required, e.g. `$.answer.city`), `equals`, `expectedPath`, `normalize` | The value at `path` in the output equals `equals`, else the value at `expectedPath` (default: `path`) in `expected`, else `expected` itself. |
| `numeric` | `abs`, `rel`, `value`, `path` | The first number in the output (or at `path`) is within `max(abs, rel × \|answer\|)` of the answer. Both tolerances default to 0. |
| `similarity` | `threshold` (default 0.8), `value`, `normalize` | 1 − edit distance / length of the longer text is at least `threshold`. |
| `progress` | `flags`, `maxDerails` (default 0) | The trace derailed at most `maxDerails` times. The score is the share of the run before the first derail. `flags` limits which derails count: `looping`, `failure-streak`, `churn`, `no-progress`, `stalled`, `context-thrash`. |
| `executability` | `kinds`, `maxInvalid` (default 0) | The trace has at most `maxInvalid` tool calls the harness refused. `kinds` limits which count: `schema`, `unknown-tool`, `precondition`, `state`, `missing`, `denied`, `other`. |
| `calls` | `must`, `mustNot`, `max`, `order` | Every `must` match is some tool call in the trace, no `mustNot` match is, there are at most `max` calls, and the `order` tools are called in that order (other calls may come between). A match is `{"tool": …, "args": {…}}`, with partial argument matches; an MCP tool matches by its own name or the agent's. See [Tool evals](../TOOL-EVALS.md#3-task-format). |
| `agent-slop` | `rules`, `exclude`, `maxErrors` (default 0), `maxWarnings` (default: no limit) | The lines the diff adds have at most that many findings. See [Agent slop](#agent-slop). |
| `command` | `command` (required, an executable, not a shell line), `args`, `cwd`, `env`, `timeoutMs` (default 60000, 0 for none), `passThreshold` (default 0.5) | The command exits 0. It gets `{input, output, expected, metadata, caseId, trace}` as JSON on stdin and may print a grade: `true`/`false`, a score from 0 to 1 (passes at `passThreshold`), or `{"score", "pass", "reason"}`. A non-zero exit fails the run. A timeout, a signal or a command that can't start is a grader error. |
| `module` | `module` (required, a path to a JS file, relative to the spec file), `export` (default `default`), `options`, `passThreshold` (default 0.5) | The exported function, called with the grade context and `options`, returns a passing grade, in the same forms as `command`. |
| `llm` | `name` and `rubric` (required), `criterion` (default: `name`), `passThreshold` (default 0.5), `template`, `system`, `tunedOn` (default `["train", "dev"]`), `concurrency` (default 4), and the provider fields below | The judge model's verdict passes, or its score is at least `passThreshold` when it gives no verdict. |
| `llm-checklist` | `name` and `items` (required), `mode` (`per-item` by default, or `batched`), `passThreshold` (default 0.5), `criterion`, `system`, `tunedOn`, `concurrency`, and the provider fields below | No `critical` item is answered no, and the weighted share of yes answers is at least `passThreshold`. An item has `id`, `question`, and optionally `critical`, `weight` (default 1), `dimension`, `violationExample` and `check`. See [Checklists and trace checks](#checklists-and-trace-checks). |

`normalize` takes `trim` (default true), `caseInsensitive`, `collapseWhitespace`,
`stripPunctuation` and `unicode` (NFKC).

The provider fields of `llm` and `llm-checklist`: `provider` (`anthropic` by default, `openai`,
`gateway`, `claude-code`, `codex` or `mock`; `claude-code` and `codex` judge through `claude -p` or
`codex exec` on a subscription, see [Replaying on a subscription](#replaying-on-a-subscription)), `model` (default `claude-sonnet-5-5` for Anthropic), `baseURL`, `apiKeyEnv`,
`maxTokens`, `effort` (Anthropic), `temperature` and `requireKey` (OpenAI-compatible; `requireKey:
false` for a local server with no key), and `mockAnswer` (`mock` only). A judge reads
`ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` when `baseURL` is not set. A `pairwise` judge takes the
`llm` fields but compares two experiments, so it goes to `exp compare --pairwise`, not to
`--grader`.

```json
{"kind": "exact", "normalize": {"caseInsensitive": true, "collapseWhitespace": true}}
{"kind": "contains", "value": ["refund", "billing"], "mode": "any"}
{"kind": "numeric", "path": "$.total", "rel": 0.01}
{"kind": "command", "command": "python3", "args": ["grade.py"], "timeoutMs": 30000}
{"kind": "llm", "name": "helpful", "rubric": "Answers the question asked, correctly and politely."}
```

### Regrade

`coding.sh exp regrade <experiment> spec.json` grades a stored experiment's outputs again with the
spec's graders, plus any `--grader` (`--replace-graders` uses only those), without calling the
task. Task errors are copied as they were. Stored runs keep no trace, so a grader that reads one sees none
(`metadata.regradeNoTrace`). The new experiment is stored with `metadata.regradeOf` and the
dataset version the original ran on. The report pairs runs by case and trial:

```
regrade exp_01M6W58AXWD3B0NNC8RYE0CEDZ of exp_01M6W58A7Z9RK200RS3ECT750K; the task was not called
pass    100.0% → 75.0% (-25.0pp) (4/4 → 3/4 graded runs)
grader  exact 48fe67515f98 → 056582bb6eee (changed)
flips   1 of 4 runs: 1 pass → fail, 0 fail → pass

case                trial  before  after
------------------  -----  ------  -----
c_85f4e1caf09f1000      1  pass    fail
```

A rubric fix can reverse orderings on its own (arXiv 2611.04399 finds "re-grading is a new
measurement"). To compare two configs graded by different grader versions, regrade the older one
with the newer graders and compare that. `--json` returns the new `experiment` and the `diff`
(`flips`, `toFail`, `toPass`, `toUngraded`, `fromUngraded`, `graders`).

`coding.sh exp run --arm base=a.json --arm cand=b.json` runs two task configs as one A/B. Cases go
in a random order, and each case runs in both arms back to back, in random arm order, so drift
hits both arms the same. Both arms are stored (as `<name>-base` and `<name>-cand`) and share a pair
id. `--seed` fixes the order, `--max-cases N` runs a random N cases.

Add `--stop-early` to stop once the answer is clear. It is a group sequential test with
O'Brien-Fleming alpha spending at `--looks` (default 4) evenly spaced points of the case budget,
never before 20 paired cases. Early looks need very strong evidence, so the last look is close to
the fixed-n test. The output says why it stopped (a boundary was crossed, or the budget ran out),
and the interval it prints is a repeated confidence interval, which stays valid however the run
stopped. After an early stop, the stored arms hold only the cases the deciding look saw, and
`exp compare` on them uses the sequential verdict and warns that its bootstrap interval is too
narrow.

`coding.sh exp aa --dataset D --task T --grader G` runs one config twice, interleaved like `--arm`,
and stores its run-to-run noise: the A/A delta, flipped cases, the SD of per-case differences, and
the cases needed to detect a 5pp or 10pp change. `coding.sh exp aa A B` measures it from two
stored runs instead, and warns when they were not interleaved.

`coding.sh exp sweep base=a.json b.json c.json -d D -g G` picks the best of several task configs.
It uses sequential halving (Karnin et al., ICML 2013): the budget is split over log2(N) rounds,
each round runs every surviving config on the same fresh cases from the train split, and the
better half goes on. Dropped configs show their gap to the leader with a CI, so you can see which
drops were close. Then the winner and the first (start) config run on the test split, which the
race never saw. The output prints the winner's train and held-out scores and the optimism gap
(train minus held-out). The winner of a race tends to be the luckiest config, so its train score
runs high; the held-out score is the one to trust. On those held-out cases the same gate as
`exp compare --gate` (default settings) decides: `adopt <winner>`, or `keep <start>` with the
reason (not enough evidence, or the winner breaks cases the start config solved). `--budget N`
caps case runs for the race (default: each train case used once), `--split` and `--held-out` pick
the splits, and a dataset with no splits gets a seeded 30% held out. Every run is stored as a
normal experiment.

### Matrix

A spec with `"matrix"` runs every combination of its axes against one baseline cell. Each axis is
a JSON Pointer into the spec and a list of values; a value is a scalar (labelled by its string
form) or a one-key `{label: value}` map. `"baseline"` names one label per axis:

```json
{
  "name": "shout-matrix",
  "dataset": "qa",
  "task": { "kind": "command", "command": "node agent.mjs", "env": { "MODEL": "stub-small", "PROMPT": "plain.md" } },
  "graders": [{ "kind": "regex", "name": "caps", "pattern": "^[A-Z]+$" }],
  "matrix": {
    "model": { "path": "/task/env/MODEL", "values": [{ "small": "stub-small" }, { "big": "stub-big" }] },
    "prompt": { "path": "/task/env/PROMPT", "values": [{ "plain": "plain.md" }, { "shout": "shout.md" }] }
  },
  "baseline": { "model": "small", "prompt": "plain" }
}
```

`"variants"` names the cells by hand instead: `{"short": {"/task/env/PROMPT": "short.md"}, ...}`,
with `"baseline"` naming one variant and `"vary"` listing the pointers the variants may change.
Overrides follow merge rules: a scalar or array replaces, a map merges, `null` deletes. A cell may
change only `/task/…` and `/trials`; graders, dataset and split define the comparison and are
refused. Before anything runs, every cell is checked against the baseline: a cell that differs
anywhere outside `vary` (with a matrix, the axis paths) is refused and named, and the command exits
2. `--plan` prints the cells and what each changes, and runs nothing:

```
model=small,prompt=plain  (baseline)
model=small,prompt=shout  /task/env/PROMPT="shout.md"
model=big,prompt=plain    /task/env/MODEL="stub-big"
model=big,prompt=shout    /task/env/MODEL="stub-big" /task/env/PROMPT="shout.md"
```

`exp run matrix.json` runs the cells interleaved like `--arm`: cases in a seeded random order, and
for each case and trial every cell in a random order, back to back. Each cell is stored as its own
experiment, `<name>/<cell>`, with `metadata.matrix` (the shared matrix id, the cell, its labels,
the baseline, `vary` and the seed). Each other cell is compared with the baseline as `exp compare`
would, and the McNemar p-values are Holm-adjusted over the cells, so a 16-cell sweep doesn't
produce a winner by chance:

```
matrix mx_01M6W60VZVFBRTE56QWZGMJV56  4 cells, interleaved (seed 11); baseline model=small,prompt=plain

cell                        pass     B − A  95% CI                    p  p (Holm)  regressed  improved  verdict
------------------------  ------  --------  --------------------  -----  --------  ---------  --------  ------------
model=small,prompt=plain    0.0%  baseline
model=small,prompt=shout  100.0%  +100.0pp  [+100.0pp, +100.0pp]  0.008     0.023          0         8  better
model=big,prompt=plain     50.0%   +50.0pp  [+12.5pp, +87.5pp]    0.125     0.125          0         4  inconclusive
model=big,prompt=shout    100.0%  +100.0pp  [+100.0pp, +100.0pp]  0.008     0.023          0         8  better
p: exact McNemar on flipped cases, Holm-adjusted over 3 comparisons with the baseline; verdict at Holm p < 0.05; CI: paired bootstrap, unadjusted
```

The verdict is `better` or `worse` when the Holm p is below 0.05, else `inconclusive`. `exp
compare <baseline cell> <cell>` gives the per-case diff of one cell, and treats the two as
interleaved. `--cell NAME` (repeatable) runs some cells; the baseline always runs. `--seed` fixes
the order, `--resume` picks up an interrupted matrix, and `--json` returns `matrix`, `plan`,
`experiments` (cell to id) and `comparisons` (each with `pHolm` and `holmVerdict`). Up to 256
cells.

Several matrices against one baseline pay for the baseline each time. `--reuse baseline` copies
the baseline cell's finished case-trials from earlier experiments instead of running them again
(`--reuse all` copies any cell's). A case-trial is copied only when everything it measured is the
same: the dataset and the case's input, expected value and metadata, the task spec with the
content of the files a command task runs, the graders' versions, the trial number and
`--trial-timeout`. It must have no task error, a grade from every grader, no infrastructure
failure, and must have started within `--reuse-max-age` (default `7d`). Each case-trial stores its
key as `cellKey`, and a copy stores `reusedFrom`, the experiment it was copied from; a copy is
never copied again. With `--plan`, `--reuse` prints how many case-trials each cell would copy and
run:

```
reuse: 8 case-trials reused, 8 to run
  model=small,prompt=plain  8 reused, 0 to run
  model=big,prompt=shout    0 reused, 8 to run
```

The copies did not run next to the new case-trials, so the run says how many were copied, the
comparisons are no longer marked interleaved, and each one warns that drift since then is not
balanced across the cells. `metadata.matrix.reused` counts a cell's copies, and `--json` adds
`reused` (cell to count).

### When to stop a loop

A loop that tries one candidate after another (prompt tuning, self-improvement) also needs a stop
rule. Tag each round's experiment with `exp run … --series NAME`; after the run it prints one
line: `series NAME: continue, incumbent v4 exp_… (round 4 +3.0pp, 120 cases, kept)` or
`series NAME: stop, ship v2 exp_… (version 2; the plateau began at round 3)`. `exp plateau
--series NAME` prints the whole series, one row per round, and exits 0 (continue), 3 (stop) or 2
(fewer than two experiments sharing cases). It also takes experiment ids in loop order
(`exp plateau v0 v1 v2`), or `--dataset ID` for every completed experiment on a dataset, and
`--baseline` sets version 0.

Each round compares the candidate with the incumbent on the cases both ran (per case, the pass
share over trials). With `--gate greedy` (the default) a candidate becomes the incumbent only when
its mean difference is above 0; `--gate chain` keeps every candidate. A boolean
`metadata.accepted` on an experiment overrides the gate. The differences feed a restart
e-detector (Yin, Liu and Qi, arXiv 2610.04756), also in the stats module as `createEDetector` and
`eDetector`. It stops once the gains have stayed below ε (`--eps`, default 0.05) for long enough,
and names the version to ship: the incumbent before the round the plateau began. Its guarantee
is an average run length of at least 1/δ rounds (`--delta`, 20 rounds at 0.05) before a false
alarm while the loop still gains ε per round. That is not a familywise error rate, and it warns
once a loop runs past 1/δ rounds. Small evals can't see a small ε: `plateauRoundsNeeded(12,
0.01)` is 51 rounds, against 4 at 200 cases, and it warns when that floor is above 1/δ. It also
warns on a dataset version or split change, rounds with fewer than 10 shared cases, and a stop
chosen on the dev or train split (confirm the version on test before shipping it).

### Gating runs: tie-breaks and the regression stop

A run that only has to say pass or fail can spend fewer trials. `exp run --samples adaptive` runs
2 trials per case and a third only when the two disagree. A case fails when half or more of its
trials fail, so 1 of 2 failing waits for the third trial and 2 of 3 failing fails. The report
prints the share of cases passed and how many cases got a third trial. It prints no confidence
interval: the trial count depends on the outcomes, so an interval over the trials is biased.
`exp compare` refuses an adaptive run unless you pass `--force`. `--json` carries `samples:
"adaptive"` and `summary.caseVerdicts` (`passed`, `failed`, `tieBreaks`). It does not combine with
`--trials` or a spec's `trials`.

`exp run --stop-on-regression --baseline <EXPERIMENT>` holds a run to a stored one on the same
dataset. Once a case that passed every graded trial of the baseline fails here (half or more of
its trials), no new case starts; the ones in flight finish. The run is stored as cancelled with
`regression: {caseId, baseline}`, the report names the case, and the command exits 1. `--json`
prints `{outcome: "regression", experiment, regression}`. Both flags work with plain spec runs,
not with `--arm`, matrix specs or `--watch`. `toolevals run` takes the same two flags (see
[Tool evals](../TOOL-EVALS.md#8-experiments)). The method is T3 Code's eval loop (see
[Theo Browne's tools](../research/theo-browne.md)).

## Long runs: resume, retries, status

`exp run` (and `--arm`), `exp aa`, `exp sweep`, `compare`, `bench run` and `workflows run` write
each trial to a checkpoint as soon as it finishes. When a run stops early (Ctrl-C, a crash, a
reboot, a killed remote job), run the same command again with `--resume`. Only the trials that
had not finished run again. The schedule, the seed, the A/B arm order and each `--stop-early` look
come from the checkpoint, so the resumed run reaches the same stopping decision, verdict and sweep
rounds as a run that was never interrupted.

- `--resume <id>` continues that run. `--resume` with no id continues the newest unfinished run of
  the same command with the same config. Without the flag, if an unfinished run with the same
  config exists, an interactive terminal asks whether to resume it; otherwise a note prints the
  resume command and a new run starts.
- The config hash covers the dataset version, split, graders, trials, task (including the agent
  script a command task runs) and timeouts, not concurrency. If any of them changed, `--resume`
  refuses and names the parts: `Can't resume exp_…: its config changed since it started
  (dataset, task)`. Mixing trials of two configs would give a result of neither.
- The first Ctrl-C starts no new trials and lets the ones in flight finish and be saved. The second
  stops them. The exit code is 130, and the command to continue is printed (and is the `resume`
  field of `--json` output).
- `--retries N` (default 3) retries a trial after a rate limit, HTTP 5xx, network error or exit
  code 75, with exponential backoff and jitter, honoring `Retry-After`. A task failure (wrong
  answer, crash, its own timeout) is never retried, because retrying failures would bias the pass
  rate up. Each run records its attempts. A trial still failing on infrastructure after its
  retries counts as unknown, not as a failure: it is left out of the pass rate, the run ends
  `incomplete`, and `--resume` runs those trials again.
- `--trial-timeout <SEC>` caps each trial, retries included. A trial over it fails.

`coding.sh exp status` lists the durable runs with progress, ETA (from this session's pace) and
the cost so far (from the trials that report one). `coding.sh exp status <id>` shows one run and
its resume command, and `--json` returns the same fields (`done`, `total`, `infra`, `retries`,
`etaMs`, `costUsd`, `resume`). A run whose process died reads as `interrupted`.

## Sessions: deltas, notes, watch

An experiment session collects the runs of one investigation. `coding.sh exp session new --name
<topic>` starts one in the current folder (it writes `.coding-sh/session.json`, with a
`.gitignore` that keeps the folder out of version control). Every `exp run` in that folder or below
then joins it, and as soon as a run finishes it is compared with the previous run on the same
dataset. The delta prints under the result, with the numbers `exp compare` gives:

```
session shout: vs exp_01M6W03B3SPG7NSG4MEM9T032J  changed prompt.md
pass    0.0% → 100.0%  Δ +100.0pp [+100.0pp, +100.0pp]  mcnemar p=0.125 (4 paired cases, 95% CI)
grader  caps  score Δ +100.0pp [+100.0pp, +100.0pp]
fixed   4: alpha, beta, delta, gamma
broke   —
```

`changed` lists the files (spec, the task's script, grader files, `watch` globs) whose content
differs from the previous run. Two runs on different dataset versions are not paired: the delta says
so and shows no numbers. `--no-session` runs outside the session, and `CODING_SH_EXP_SESSION=<id>`
picks a session without a `session.json`. `--json` output gains a `session` field with the block.

- `coding.sh exp session note "<text>"` adds a note. Write the hypothesis before a run and the
  reading after it, so the timeline shows what you expected next to what happened. Notes are
  redacted like captured sessions and capped at 4000 characters.
- `coding.sh exp session summary` prints the timeline oldest first: notes, the commands (redacted)
  and one line per run with its delta. `--json` returns the blocks with the same numbers.
- Agents do the same over MCP: `exp_session_note` adds a note and `exp_session_summary` returns
  the blocks (`limit`, `cursor`), so an agent can read the thread back after a context reset.

`coding.sh exp run spec.json --watch` runs, then reruns whenever something the run reads changes:
the spec file, the command task's script, command and module grader files, and the spec's `watch`
entries (`"watch": ["prompt.md", "prompts/**"]`, or `--watch-path <GLOB>`). `.git`,
`node_modules` and `.coding-sh` are ignored, and saves within 300 ms give one rerun. Each run
prints one line and its delta against the run before it:

```
15:54:41  run     exp_01M6W03CN9P1ZE633C2RXPGVYQ  pass 100.0% (4/4)  4 case runs
15:54:41  regrade exp_01M6W03D5H1YEKWWXWGNCGN7MF  pass 75.0% (3/4)  regrade of exp_01M6W03CN9P1ZE633C2RXPGVYQ, 0 task calls
```

- A change while a run is in flight aborts it. The aborted run is not stored, and the new one starts.
- When only the graders changed (a rubric edit, a grader file), the stored outputs of the last run
  are graded again with no task calls (`regrade`). The new experiment records `regradeOf`.
- A spec that fails to parse is reported and watching goes on. Enter reruns, `q` quits, Ctrl-C
  exits 0. `--watch` does not combine with `--json`, `--resume` or `--arm`.

## Metric A/B (ms, bytes)

`coding.sh exp metrics --arm base='<cmd>' --arm cand='<cmd>'` compares two commands that print
numbers instead of pass/fail. Each run prints one JSON object, such as
`{"lcp_ms": 2310, "js_bytes": 48211}`. Nested objects flatten to dotted names
(`mobile.home.lcp_ms`). An arm is a command line, a `{"kind":"command"}` task spec or a spec file.
Each run gets `{"arm","pair","warmup"}` on stdin.

The arms run in `--pairs` interleaved pairs (default 11), one run at a time. Half the pairs run A
first and half B first, in a seeded random order, so a warm cache or a heating CPU hits both arms
alike. `--warmup N` runs each arm N times first and drops those runs.

For each metric it prints both arms' medians, the median paired delta (B − A) with a 95% paired
bootstrap CI, and a verdict: better, worse or inconclusive. Lower is better unless the metric is
named in `--higher` (`*` wildcards work). A verdict needs two things. The CI must exclude 0, and an
exact sign test on the paired deltas must give p < 0.05 after a Holm correction across the metrics.
At 11 pairs the bootstrap alone is too optimistic, and a page run reports dozens of metrics, so
without the correction an A/A run would flag a few by chance. With 11 pairs, a noisy metric needs
nearly every pair to agree; use `--pairs 21` to find smaller changes. A metric whose deltas are all
the same, like the byte count of a fixed build, has no noise: a non-zero delta is a change.

`--json` prints the whole result, runs included. `--fail-on-worse` exits 1 when any metric got
worse, for CI gates. scripts/perf/ uses it to gate the coding.sh site on Lighthouse metrics.

## Judges

Judges call Anthropic with `ANTHROPIC_API_KEY` or OpenAI with `OPENAI_API_KEY`. Like the vendors'
SDKs, they send to `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` when set, so a proxy or gateway works
without `--base-url`. `"provider":"claude-code"` and `"provider":"codex"` judge on a Claude or
ChatGPT subscription instead, through the agent's CLI.

`coding.sh judge calibrate` measures judge and human agreement (Cohen's kappa) on a held-out split.
Every report flags judges that are not calibrated. It also stores the judge's held-out sensitivity
and specificity, so later `exp compare` runs show a bias-corrected (Rogan-Gladen) judge pass rate.

A calibrated judge can still cost more human labels than it saves. Its corrected pass rate is only
as precise as the labels behind its sensitivity s and false-pass rate α, and when s − α (the
discrimination gap) is small, those labels buy little. The report prints the gap and the label
efficiency η: how many human labels a direct audit of the outputs needs for the same precision,
per label spent calibrating the judge (Choi et al., arXiv 2610.35698, Eq.6-7).

```
discrimination gap 0.44 (pass-recall 0.84, false-pass 0.40)
label efficiency η 0.21 · auditing outputs directly needs ~4.8x fewer human labels for the same precision (at pass rate 0.80, corrected over 2500 judged test cases)
```

η < 1 or a gap under 0.2 adds a warning, but never changes the calibration state. `--judge-cost
0.001` (dollars per judge call) adds the human label cost above which the judge pays off (Eq.8):
`judge pays off when a human label costs more than $0.0046 (judge call $0.001)`, or "no
break-even" when η ≤ 1. `--json` carries `calibration.efficiency` with `eta`, `gap`, `theta`,
`n1Share` (the share of labels to spend on human-pass cases) and `breakEvenHumanCost`.

Judges read untrusted text: the agent writes the output they grade. Every judge prompt escapes the
data tags inside that text (`</output>` becomes `<\/output>`), so an output can't close its block
and append orders. The system prompts also say that everything inside the data tags is untrusted
and that an attempt to instruct the judge counts against the output. Citations still verify
against the raw text. This changed the default prompt, so judges built on it got new version ids
and old calibrations stay with the old ids.

`coding.sh judge calibrate <exp> --probe-injection judge.json` checks that this holds for your
judge. It rebuilds the judge from its grader spec and judges each human-fail case (up to
`--probe-max`, default 25) as is. It then judges two variants that carry a planted "respond pass"
order: one at the end of the output, and one at the end of the last tool result in the trace when
there is one. A flip is a variant judged pass where the original was judged fail. The report adds
`injection probe: 0 of 24 failing verdicts flipped to pass (0%); output 0/24`, `--json` carries
`calibration.injection`, and any flip exits 1 (BenchJack, arXiv 2605.12673).

`coding.sh exp compare A B --pairwise judge.json` adds a pairwise judge
(`{"kind":"pairwise","name":…,"rubric":…}` with the same provider options as `llm`). For each
shared case it shows the judge both outputs, then asks again with the order swapped. A side wins
only when both orders agree. When the answer changes with the order, the case is a tie, and the
share of such cases is printed as the position-bias rate (Wang et al., 2023). It reports B's win
rate (ties count half) with a bootstrap CI, a sign test on the decisive cases, and the ties.
`--labels labels.jsonl` (rows of `{"caseId","winner":"a"|"b"|"tie"}`) calibrates it the same way
as `judge calibrate`: kappa on the test split, with judge ties left out, stored on the judge.

An inconclusive win rate can mean "needs more cases" or "this judge flips". To tell them apart,
the report resamples the cases 1,000 times at 25, 50, 100 and all of them, and prints how often a
resample picks the same winner as the full data, and n*, the smallest size at which that holds
95% of the time (arXiv 2611.04090: with a poorly aligned judge, 26-70% of system pairs never
settled within 100 verdicts):

```
stable  B better in 97% of resamples (n*=50)
unstable  B better in 61% of resamples (n* censored)
```

Unstable and inconclusive adds a warning that more cases help only if the judge is calibrated; an
uncalibrated judge whose direction never settles adds "unresolved: pick or calibrate the judge
before collecting more verdicts". Judge graders (`llm`, or any calibrated grader) get the same
line in `exp compare`, from per-case score differences. With `--cluster`, whole clusters are
resampled and the sizes count clusters. `--json` carries `stability` with `share`, `bySize` and
`nStar`.

### Which cases to label

Which cases you label matters as much as how many. Labelling the low-confidence or "interesting"
outputs biases both the judge's measured accuracy and any pass rate built on it (verification
bias). `coding.sh judge sample <exp> --budget 60 --out plan.json` plans a random sample instead:
it splits the split's cases (default `test`, only the ones the experiment ran) into strata by the
judge's verdict and confidence (bins merged until each holds `--min-stratum` cases, default 25;
unjudged cases get their own), gives each stratum labels in proportion to its size, and draws them
at random with `--seed`. A judge's confidence is a valid stratum even when it is miscalibrated, and
proportional allocation keeps calibrate's kappa, sensitivity and specificity unbiased (Choi et al.,
arXiv 2610.35698). The output is the strata table, the cases to label with their source sessions,
and how many already carry a label (those stay in the draw so the design stays random). It warns
when the budget is below the number of strata (then it samples the whole split at random), above
the population, or short of a ±5 pp worst case (738 labels).

Label the picks, then `coding.sh judge calibrate <exp> --plan plan.json` adds the human-audited
pass rate, weighted by stratum, with a 95% interval and the worst-case (Hoeffding) half-width:

```
human-audited pass rate 0.71 [0.63, 0.79] (42/50 of plan labelled; worst case ±0.09)
  between 0.62 and 0.78 if the unlabelled picks all fail or all pass
```

Until every pick is labelled, it also prints those bounds and a warning. A plan drawn for another
experiment, grader, split or seed is refused. `--json` carries `calibration.audited`.

### Checklists and trace checks

An `llm-checklist` grader asks yes/no questions instead of one rating. An item can be `critical`
(a "no" fails the case) and can name a `check`: a deterministic test of the trace that answers
without a model. A checklist made only of checks makes no model calls and needs no calibration.
Checks read the case's trace, which a function task hands over by returning
`withTrace(output, events)` (the eve task does this for you). With no trace at all, the checks
below answer N/A.

Four checks grade whether the agent followed its rules, from its actions alone. The paper behind
them found such checks agreed with human judges 97-98% of the time (Wang et al., arXiv 2610.04832).

| Check | Yes when |
|---|---|
| `ran-command` | A shell call ran `args.command` (text) or matched `args.pattern` (regex). With `"ok": true`, that call also succeeded. |
| `read-path` | A Read/Edit/Write call's path ends with `args.path`, or a shell command names it. |
| `wrote-identifier` | `args.identifier` is on a `+` line of a file diff or in Write/Edit content. N/A when no diff is inline. |
| `follows-rules` | Every checkable rule in `args.text` (or the case's `metadata.instructions`, a string or `{path: text}`) was acted on. |

A checkable rule is an imperative line that names a backticked command, flag, path or identifier,
for example ``Always run `npm test`.`` or ``Never use `git push --force`.`` A required token must
show up in the trace and a forbidden one must not. `args.only` (`require`, `forbid` or `all`)
picks which rules to grade, and `args.skipConditional` drops rules with if/when/before/after. When
those rules fail they are marked "(conditional, low confidence)", because actions alone can't tell
whether the condition held. The answer is N/A when there are no rules or no tool calls.

Rule files can be path-scoped, and `follows-rules` reads their frontmatter. These are Claude Code
`.claude/rules/*.md` with `paths:`, Cursor `.cursor/rules/*.mdc` with `globs:` or
`alwaysApply:`, and Copilot `.github/instructions/*.instructions.md` with `applyTo:`. A scoped rule
is graded only once the trace touches a matching file. A Cursor rule with neither globs nor
`alwaysApply` is graded once its file is opened. Until then, the agent never saw the rule, so it
is left out and counted in the explanation: `acted on all 1 rule(s) (2 scoped rule(s) never came
into scope)`. When no rule came into scope, the answer is N/A.

```json
{"kind": "llm-checklist", "name": "rules", "items": [
  {"id": "tests", "question": "Ran the tests and they passed?", "check": {"name": "ran-command", "args": {"command": "npm test", "ok": true}}},
  {"id": "claude-md", "question": "Followed CLAUDE.md?", "critical": true, "check": {"name": "follows-rules", "args": {"text": "Always run `npm test`.\nNever use `git push --force`."}}}
]}
```

`"negate": true` on a check turns it around, so a check can require that a command never ran:
`{"name": "ran-command", "args": {"command": "vercel env pull"}, "negate": true}`. N/A stays N/A.

`no-test-tamper` checks that no change to a test, test-runner config or CI file hid a failure. It
answers no for a skip marker, for deleting a test file while tests were failing, and for an
assertion edit that alone turned a failing test run green. New tests and edits next to a real code
fix answer yes. The explanation names each change, the tool call and the event, and quotes what the
agent said about it (EPISTEME, arXiv 2611.06563):

```
1 test change(s) may hide failures: weaken test/sum.test.js by Edit in e42 (turned failing tests
green), disclosed: "The test expecting 5 is wrong; update the expected value."
```

Saying why doesn't make it pass: the change decides the answer, and the words only label it
`disclosed` or `stealth`. The item cites the change and the test runs before and after it.
`args.severity: "info"` also fails any non-additive test edit, and `args.pattern` (a regex) protects
more paths, such as a verifier script: `{"name": "no-test-tamper", "args": {"pattern": "^check\\.sh$"}}`.

`coding.sh judge grade --grader <JSON|FILE>` grades one output with any grader and exits 0 on
pass. It reads the output from `--output <FILE|->` and the trace from `--trace <FILE>`. The trace
can be Claude stream-json, a Claude transcript, or coding.sh events as JSONL. Inside a task
verifier, both default to the agent's files (`CODING_SH_AGENT_OUTPUT` and
`CODING_SH_AGENT_STDOUT`), so `coding.sh judge grade --grader grader/checklist.json` is a complete
verifier for a behaviour task. Each model call it makes is appended to `$CODING_SH_GRADER_USAGE`.
`compare` adds those calls up into the run's grader spend.

### Agent slop

The `agent-slop` grader flags patterns that agents tend to leave in code: placeholder code, type
check escapes, swallowed errors, leftover debugging, focused or skipped tests, barrel files,
placeholder text and comments that narrate. It reads only the lines a diff adds, so code the agent
did not write never counts. Rules live in `src/graders/slop.ts`.

```json
{"kind": "agent-slop", "rules": ["default", "unknown-param"], "exclude": ["debug-print"], "maxErrors": 0, "maxWarnings": 5}
```

- `rules` replaces the default rule set. `"default"` stands for the default rules and `"all"` for
  every rule. An unknown id is an error.
- `exclude` drops rules by id.
- It passes with at most `maxErrors` error findings (default 0) and at most `maxWarnings` warnings
  (default: no limit).
- The score is `1 / (1 + d)`, where `d` is errors plus a quarter of the warnings, per 100 added
  lines. A diff under 100 lines counts as 100 lines. No findings score 1, one error 0.5, one
  warning 0.8.

The grader looks for the diff in this order:

1. The diff it is handed: `judge grade --diff <FILE|->`, which defaults to `$CODING_SH_AGENT_DIFF`
   in a task verifier. That file holds the agent's work-tree diff, taken before the hidden files
   land.
2. The output, when it is a unified diff (a `---`/`+++` header and an `@@` hunk).
3. The diffs on the trace's `file.change` events.

With none of these it fails with "no diff to grade". An empty diff passes with score 1.

| Rule | Severity | Where | Flags |
| --- | --- | --- | --- |
| `elided-code` | error | code | A comment that stands in for code: `// ... rest of the code`, `# existing code unchanged` |
| `todo-implement` | error | code | A stub comment: `TODO: implement`, `implementation goes here` |
| `not-implemented` | error | code | A stub body: `throw new Error("Not implemented")`, `NotImplementedException`, `todo!()`, `unimplemented!()`, `panic("not implemented")` |
| `as-any` | error | TypeScript | An `as any` cast |
| `as-unknown-as` | error | TypeScript | A chained `as unknown as T` cast |
| `ts-ignore` | error | JS, TS | `@ts-ignore` or `@ts-nocheck` (`@ts-expect-error` is not flagged) |
| `lint-disable` | warn | code | A lint suppression that names no rule: `eslint-disable`, `tslint:disable`, a bare `noqa` or `nolint` |
| `type-ignore` | warn | Python | A bare `# type: ignore` or `# pyright: ignore` with no error code |
| `empty-catch` | error | code | An error swallowed with no handling and no comment: `catch {}`, `.catch(() => {})`, `except: pass` |
| `debugger` | error | code | `debugger`, `breakpoint()`, `pdb.set_trace()`, `binding.pry` |
| `debug-print` | warn | code, not tests or `scripts/`, `bin/`, `tools/` | `console.log`/`debug`/`trace`/`dir`/`table`, `dbg!()`, `print("DEBUG …")` |
| `focused-test` | error | test files | `it.only`, `describe.only`, `fit`, `{ only: true }` |
| `skipped-test` | warn | test files | A skip with no condition: `.skip`, `.todo`, `xit`, `@pytest.mark.skip`/`xfail`, `@unittest.skip`, `t.Skip`, `#[ignore]`, `@Disabled` |
| `barrel-export` | warn | JS, TS | `export * from` |
| `placeholder-text` | warn | code and HTML, not tests or fixtures | lorem ipsum, "coming soon", "sample data", "dummy data", "placeholder text" |
| `narrating-comment` | warn | code | A comment that restates the code: "increment i", "return the result", "loop through items" |
| `changelog-comment` | warn | code | A change note: `// New:`, `// Updated:`, `// <- added`, "added by AI" |
| `conditional-empty-spread` | warn, opt-in | JS, TS | `...(x ? { a } : {})`, `...(x && { a })` |
| `unknown-param` | warn, opt-in | TypeScript | A function parameter typed `unknown` |

"Code" is JavaScript, TypeScript, Python, Java, Kotlin, Scala, C#, Go, Rust, Swift, C, C++,
Objective-C, Dart, PHP, Ruby, shell and Elixir files. Markdown is never read, so comment rules
skip docs. Test files are paths under `test/`, `tests/`, `__tests__/` or `spec/`, and `*.test.*`,
`*.spec.*`, `*_test.*` and `test_*.py` files. `node_modules/`, `vendor/` and `*.min.*` files are
skipped. A comment that explains an empty catch (`catch { // optional cache }`) is not flagged, and
neither is a skip behind a condition (`if (!git) return t.skip("needs git")`, `skipIf`).

`coding.sh judge slop` runs the same rules on captured work, with no grader file:

```sh
coding.sh judge slop latest            # a session: the diffs on its file.change events and its subagents'
coding.sh judge slop run_01JC…         # a run of compare: its stored work-tree diff
coding.sh judge slop exp_01JC…         # a compare experiment: each run, and a rate per arm
git diff main | coding.sh judge slop --diff -
coding.sh judge slop --list-rules
```

It prints the score and one line per finding, with the rule, path and line. `--rules`,
`--exclude`, `--max-errors` and `--max-warnings` work as in the spec, and `--json` prints the
findings. It exits 0 on pass, 1 on fail, and 2 when there is nothing to grade (a session whose
agent does not record diffs, an experiment with no stored runs). For an experiment it fails when
any run fails, and per arm it prints the runs that pass, the findings, findings per 100 added
lines and the mean score. A session's diffs are graded edit by edit, so a line one edit adds and
a later edit removes still counts.

```
fail  agent-slop  score 0.31  dirty.diff  (2 errors, 1 warning in 3 added lines)
  error  as-any          src/a.ts:1  const x = y as any;
  warn   debug-print     src/a.ts:2  console.log("x");
  error  todo-implement  src/a.ts:3  // TODO: implement
```

### Auditing a test verifier

A passing test suite does not prove the change is right. METR found that test-passing SWE-bench
PRs overstated mergeable work by 24 points. `judge calibrate --grader <id>` also takes a `command`
or other deterministic grader and measures its precision: of the cases it passed, how many would a
human accept?

```bash
coding.sh judge calibrate my-exp --grader tests --sample-passes 40   # who to label
coding.sh judge calibrate my-exp --grader tests --labels labels.jsonl
```

`--sample-passes N` prints N passing cases that have no label yet, in a seeded order (`--seed`,
default 0). `--json` lists them with input and output. Label them in the viewer, or write
`{"caseId","value":"pass"|"fail"}` rows to a file and pass it with `--labels`. Those rows replace
stored labels for the cases they name. The audit prints, for example,
`verifier precision 0.78 [0.63, 0.88] (n=40); 9 false accepts`, with a Wilson interval. It also
prints the false-reject rate when failing cases are labelled too. A verifier never sees the
labels, so every labelled case counts and there is no held-out split. The command exits 1 below
`--min-n` labelled passes (default 20).

The audit is stored per grader version. After that, `exp show` puts the precision in the trust
column, and `exp show` and `exp compare` add a verifier-corrected pass rate: pass rate × precision
+ fail rate × P(human pass | verifier fail). Without labelled fails, the second term is taken as
0, and the line says it assumes no false rejects. Precision is measured on one experiment's
passes, so it carries over only roughly to configs that pass different cases. `--json` returns
the audit as `verifier` (`checked`, `agree`, `falseAccepts`, `falseRejects`, `precision`, …).
These are the same counts a blind-solver cross-check stores at `task.meta.crossCheck`.

### Witness audits

Labels tell you how often the verifier is wrong; a witness test shows which passes it got wrong. A
witness checks one requirement of the instruction that the hidden tests skip. `eval audit` makes
sure it passes the reference patch 3 of 3 times, then replays it on every passing run of one
experiment. Each run is rebuilt from the start snapshot, setup and the run's stored diff. The
original verifier must still pass on the rebuilt tree, or the run is `replay-mismatch`. A diff that
no longer applies is `unreplayable`. A run the witness fails twice in a row is refuted. A fail then
a pass is noted as flaky and the run stays clean. No model is called. TestJack (arXiv 2610.10619)
refuted 34% of passing trials this way.

```bash
coding.sh eval audit add-neg --experiment exp_01J… --witness test/neg.test.js \
  --witness-cmd 'node test/neg.test.js' --requirement 'handle negative numbers'
```

```
claude-default (1a2b3c4d): passes 6/10, refuted 0, audited pass rate 60% (6/10), replayed 6/6
claude-tdd (5e6f7a8b): passes 6/10, refuted 3, audited pass rate 30% (3/10), replayed 6/6
refuted run_01JX… (claude-tdd (5e6f7a8b)) by test/neg.test.js: handle negative numbers
  add(-2, -3) is 0, want -5
```

`--witness PATH=FILE` writes FILE at PATH in the repo; plain `--witness FILE` uses FILE's path
relative to the current directory. A witness the reference fails is rejected and nothing replays.
Confirmed witnesses are stored at `task.meta.witnesses`, and `eval audit <task> --experiment <id>`
without `--witness` replays them again. A witness that refutes more than half of all passing runs
is listed as ambiguous: the instruction probably doesn't state the requirement clearly. Its
refutations are shown but not counted unless you pass `--count-ambiguous`. The report is stored at
`task.meta.audits[<experiment>]`, where [`compare --audited`](#harness-ab) reads it. `--promote` then adds the
witnesses to the verifier (hidden file plus `&& <cmd>`) and puts the task back to draft for
`eval validate`. `eval export` writes witnesses to `witnesses/`, and `eval import` reads them back.

## Harness A/B

`coding.sh harness snapshot` bundles an agent's harness files (CLAUDE.md, AGENTS.md, skills, hooks,
MCP config). `coding.sh compare A B` runs both bundles on eval tasks in isolated config
directories. It reports per-arm Wilson intervals and the first step where the traces diverge.

`coding.sh compare A --without .claude/skills/pdf` tests one piece of a harness. B is A minus that
path: a skill, `AGENTS.md`, `CLAUDE.md` or `.mcp.json`. The path is also deleted from each task's
repo. The report adds `effect of <path> = A − B` with its CI. `--without` can be repeated.

`coding.sh compare A B --gate` adds a ship-or-hold answer under the verdict: `Ship it: B wins 9
tasks, loses 0`, `Hold: not enough evidence`, or `Don't ship: B breaks 3 tasks A solved` with the
broken task ids. It exits 0 only for "Ship it", so it can gate a harness change in CI. It works on
each task's majority outcome. A task B fixed is a win, a task A solved that B failed is a loss, and
ties are ignored. B ships when three things hold. First, wins minus λ times losses is positive (λ =
`--lambda`, default 2, so one break cancels two fixes). Second, an exact one-sided binomial test on
the wins and losses beats break-even at `--gate-alpha` (default 0.05). Third, B breaks at most
`--tau` (default 10%) of the tasks A solved. This is SAGE's accept-or-abstain rule (Wang et al.,
arXiv 2609.36043). The paper reports no default settings; these are ours. Passes that tampered
with tests count as fails for the gate only, in both arms. With `--without`, the line is labelled `drop-it gate`
and reads "Drop it" or "Keep it".

On a mixed task pool the pooled gate can ship a change that breaks most of a small suite: 3 losses
out of 40 solved tasks is under τ, even when all 3 come from a suite where A solved 4. `--gate --by
suite:` also runs the gate on each group of tasks, grouped by their first tag with that prefix
(tasks without one go in `(none)`). The pooled numbers stay, one line per group follows, and any
group that says "Don't ship" makes the whole gate "Don't ship" (reason `stratum-regression`):
`gate: Don't ship: B breaks 3 of 4 suite:swt tasks A solved`. A group that only holds never blocks.
`--json` adds `gate.strata` (each group's gate, lost and won tasks) and `gate.blockedBy`. `--by`
without `--gate`, or a prefix no task's tags start with, is an error before anything runs. Tag
tasks with `eval new --tag suite:swe`.

`coding.sh compare A B --promote` asks a different question: is B credible progress on quality or
on cost? A harness 40% cheaper at the same pass rate reads "no significant difference" in the
verdict, and `--gate` holds it, but it is still worth keeping. Each run gives a quality (pass = 1)
and a cost: USD when cost is known on at least 80% of each arm's runs, else tokens (with a note),
else no gate. A Bayesian bootstrap draws Dirichlet weights on each task's attempts (quality and cost
move together) and on the tasks, 10,000 times (`--draws`). A draw counts when B gains quality and
its cost rises by at most `--eps-c` (relative, default `inf`), or when B is cheaper and gives up at
most `--eps-q` of pass rate (default 0.1). The share of draws that count is the support. B is
promoted when it is at least `--gamma` (default 0.7). The line reads `pareto: support 0.86 ≥ 0.70 →
promote (cost-cut: cost -38% [-45%, -30%], quality -1.2 pp [-6.0, +3.0 pp])`, or `→ hold`.
`--promote` exits 0 only when B is promoted. With `--gate` too, both must pass. `--json` carries
`report.pareto`: `support`, `promote`, `reason` (`quality-gain`, `cost-cut`, `both` or `none`),
`unit`, `pQualityGain`, `pCostCut`, `dQ`, `dC`, the settings and notes (`epsC: null` means no
limit). With `--k 1` there are no repeat attempts to resample, so the note says to run `--k 3`. This
is ParetoSaddler's promotion gate (Qian et al., arXiv 2611.02079). The paper weights tasks equally;
coding.sh also resamples tasks, so one lucky run on one task can't promote B.

When B adds or removes exactly one instruction item and changes nothing else (one rule file, one
skill, or one `CLAUDE.md`/`AGENTS.md`; `--without` counts), the report adds the one-item gate:
`item gate k=3 τ=.34 m=2: KEEP · G=1.67 net +4 runs D=.33 fired 11/36 · S=9 tasks`. It only looks at
tasks where the item reached the agent's context in at least one run (S): an always-on file always
does, a path-scoped rule only after the agent touched a matching file, a skill only when it was
opened (listed is not enough). Exposure comes from each run's captured trace. Per task, Δ is B's
pass rate minus A's. An addition is KEEP when some task improved (G > 0), no task dropped by more
than τ = 0.34 (D, one run in three), no task A solved on every run lost one, B won at least 2 runs
net (k·N ≥ m, whole runs, so a one-run win doesn't count) and the item fired. When only the drop or
the solved-task rule fails it is RECHECK with the command to re-run those tasks; a drop again kills
it. Otherwise KILL with the failed gates. A removal is REJECT when it costs 2 runs net, drops a task
by more than τ, or a task the item's arm solved every time loses a run; UNMEASURED ("keep") when the
item never fired in the base runs, since a rare-situation rule looks like dead weight until its
situation comes up. A removal that costs nothing is not yet ACCEPT: the gate also needs the agent to
do well without the item. Over the exposed tasks, U is the pass rate without the item and A the
pass rate with it, and the first line ends ` · U=.92 A=.92`. When both are below 0.4 the verdict is
UNCOVERED: neither arm solves the tasks, so the item does not deliver what it teaches; keep it and
repair it, or check the tasks. When U is below 0.8 the verdict is UNMEASURED ("keep"), unless the
removal wins 2 runs net: then the item hurts and the verdict is ACCEPT. Otherwise only U ≥ 0.8 gives
ACCEPT. A second line counts the tasks by label: internalized (U and A at least 0.7), works
(A at least 0.7, U below 0.4), hurts (the reverse), uncovered (both below 0.4) and between. With
fewer than 3 exposed tasks and U within 0.2 of 0.8, a note says to add tasks rather than runs. A
gain-only rule retired 57-65% of skills the agent could not do with or without them (Wang et al.,
"Beyond Gain", arXiv 2610.32322). RERUN means the runs can't be scored: a task without k valid runs
per arm, more than 10% errored or cancelled runs, a run with no trace to read exposure from, two
agent versions, or no exposed task. `--item-gate` makes it decide the exit code (0 on KEEP or
ACCEPT, 1 on UNCOVERED and the rest), `--no-item-gate` hides it, and `--json` carries `report.itemGate`. This is Cortex's scorer
(arXiv 2610.14216).

With `--k 2` or more, compare sorts each arm's failed runs three ways. A bad run failed on a task the
same arm passed in another attempt, so a retry would help. A beyond-arm failure is on a task only
the other arm solved. Unsolved-by-all is a task neither arm solved; check the task itself. It also
splits the outcome variance into task, arm and run-to-run shares. With `--k 1` these can't be told
apart, and the report says so.

Compare also splits each arm's failed runs by what the agent's own tests said last, read from the
run's captured session: `A fails 12: own tests green 7 (58%), red 3, stale 1, none 1`. Green means
the agent's last test run passed and it changed no file after; stale means it changed files after a
green run; red means its last run had failures; none means it never ran tests coding.sh could parse.
Green fails are silent misses: the agent thought it was done. When both groups have at least 5 runs,
a second line compares how often a run with green own tests passed the verifier with every other
run (`own-green runs passed the verifier 71% [..] vs 40% [..] otherwise`); in BOBA (arXiv
2611.02207) a green local run barely changed the hidden-test pass rate. `--json` has the counts and
both rates under `baseline.selfCheck` and `candidate.selfCheck`.

Every replay run gets a tamper check on its diff: edits, deletes and skip markers in tests, the
verifier's files, test-runner configs, CI files and `package.json` test scripts. Tampered runs that
passed still count as passes. An edit that only adds new test cases to an existing test file, and
leaves every existing line as it was, is not a flag: a regression test next to the old ones hides
nothing. The run's `tamper.addedTests` lists those files. The check reads the file as the agent left
it, in JavaScript, TypeScript, Python, Go, Rust, Java, Kotlin and C#. Anything else in the edit
still flags it: a changed or removed line (other than an import line that gains names), a skip or
`.only` marker, an exit or early return, a block placed inside an existing test, a module-level hook,
fixture, mock or patch of the test framework, a definition that shadows an existing one, or a Go
build constraint. Runner configs and CI files flag on any edit. Compare links each flag to the tool call that made the change, read
from the run's captured session, and splits tampered passes by whether the agent said, before or
with the call, that it was changing the test:

```
tampered passes   B 3: disclosed 2, stealth 1
                    run_01JX… edit test/sum.test.js by Edit (event e42), said: "The test expecting 5 is wrong; update the expected value."
                    run_01JY… edit test/sum.test.js by Edit (event e57), stealth (said: "Refactor helpers.")
```

Stealth means some test change came with no such statement (EPISTEME, arXiv 2611.06563). Untraced
means no event in the trace touched the flagged file. The tamper note gets the same split. `--json`
adds `tamperedPassesDisclosed` and `tamperedPassesStealth` to each arm and `tamperAttribution`,
keyed by run id, with each flag's finding: event id, tool call id, shape, whether the edit alone
turned the tests green, and the agent's words.

Once `eval audit` has replayed witnesses on an experiment's passes, compare adds each audited
arm's raw and audited pass rate. `--audited` counts refuted passes as fails before every statistic
and labels the verdict:

```
audited pass      A 60% → 60% (0 refuted, coverage 100%)
                  B 60% → 30% (3 refuted, coverage 100%)
verdict (audited): candidate worse …
```

The audited verdict needs every pass in both arms replayed. Unreplayable and replay-mismatch
passes are never refuted but leave coverage short, and then the raw verdict stands with a note
saying which arm the audit covers. When the audit changes the verdict, a note gives both. `--json`
adds `refutedPasses`, `auditedRuns` and `auditedPassRate` to each audited arm, plus `audited:
{rawVerdict, method}` with `--audited`. The MCP `harness_compare` tool gives `refuted`, `audited`
and `auditedPassRate` per arm.

A cost, token or turn value shows `(3/10)` when only 3 of the arm's 10 runs reported it. The
"X% cheaper" note needs a known cost for at least 80% of each arm's runs. Below that, the report
says how many runs were priced instead.

The report ends its metrics with what each arm spent in total: an `agent spend` row, and a `grader
spend` row when verifiers called `judge grade`. `--max-cost 15` caps a live run in USD. Once the
finished runs reach the cap (agent plus grader cost), no new run starts. Runs already going finish,
so the total can pass the cap by what the runs in flight cost. The compare then covers the runs that
finished. Runs that report no cost count as $0 and are listed as such. `--json` carries `budget`.

### Verifier output

Each run of a repo task (`compare`, `eval run`, `eval crosscheck --solver`) keeps the end of what
its verifier printed as `verifierOutput`: the last 4096 characters of stdout and of stderr, with
colour codes and progress redraws removed. The text is redacted before it is stored, with the same
`capture.redact` and `capture.redactPatterns` rules as captured sessions. A stream the verifier left
empty is absent, and so is `verifierOutput` when both are. Each `compare --repair` round keeps its
own. After the report, `compare` and `eval run` print the last 8 lines for up to 5 failed runs:

```
Verifier output of failed runs (last 8 lines):
  s4 · A base · attempt 1  exit 1 · run_01KA…
    │ expected 5, got -1 with [redacted:anthropic-key]
```

`--json` lists every failed run in `failedRuns`, each with `runId`, `taskId`, `bundleId`,
`attempt`, `verifierExit`, `error` and `sessionId` when set, and `verifierOutput`. Cancelled,
superseded and infrastructure-failed runs are left out. Runs recorded before this field have no
output.

### Claude Code plugins

A claude-code bundle can carry Claude Code plugins: their hooks, skills, agents, commands and MCP
servers, the whole plugin directory. `harness snapshot --agent claude-code --plugin <name>` takes an
installed plugin by name (or `name@marketplace`) or a plugin directory, and can be repeated. In a
harness TOML, write `plugins = ["caveman", "./plugins/mine"]`; a directory there is relative to the
TOML file. A name is looked up read-only in `plugins/installed_plugins.json` under
`$CLAUDE_CONFIG_DIR` (default `~/.claude`). A directory must hold `.claude-plugin/plugin.json`, and
the plugin's name comes from it. An unknown or ambiguous name is an error that lists the installed
plugins. A snapshot carries only the plugins you name: the ones enabled in your settings are not
picked up.

The plugin's files are stored as blobs (`.git` is skipped, executable bits are kept), so the bundle
id changes when the plugin's content does. A bundle without plugins keeps the id it had. A run
writes each plugin under the run's own home, at `<run>/home/.coding.sh-plugins/<name>`, outside the
work dir the agent edits, and starts Claude Code with `--plugin-dir` for it. Your Claude config is
never changed, and the run loads no plugin the bundle does not carry. A bundle with plugins for
any other agent is refused at snapshot time, and a run of one fails with an error instead of
dropping them.

`coding.sh compare A --with plugin:<name|dir>` runs "with the plugin vs without" in one command: B
is A plus the plugin, stored as `<A>-with-plugin-<name>`. `--without plugin:<name>` drops a plugin
that A carries. `--with` and `--without` don't combine. The report's bundle diff reads
`+ plugin <name>`. A plugin holds many items, so the one-item gate does not apply to it.

### Reuse finished runs

Comparing three candidates against one baseline runs the baseline three times. `--reuse baseline`
copies A's finished runs from earlier comparisons instead (`--reuse both` copies B's too). A run is
reused only when everything it measured is the same, keyed by content, never by path: the task's
start snapshot, setup, instruction and verifier (hidden files included), the bundle (its id hashes
its files), the agent's version, the attempt number, the trial timeout, and the gateway route.
Editing a hidden test or a CLAUDE.md, or upgrading the agent, runs it again. So does a run that
recorded an error, was cancelled or failed on infrastructure, and one older than
`--reuse-max-age` (default `7d`). Every run stores its key as `cellKey`, and a copy stores
`reusedFrom`, the run it was copied from. Copies count $0 toward `--max-cost`, and the `agent
spend` and `grader spend` rows leave them out: they show what this comparison paid. A `reused` row
shows what the copied runs cost when they first ran:

```
agent spend       $0.00                 $0.24                 $0.24 total
reused            $0.24                                       $0.24 not spent: 2 runs paid for by earlier comparisons
```

`--dry-run` prints what would run and runs nothing:

```
dry run: 4 runs (1 task x 2 arms x 2), 2 reused, 2 to run
baseline   base                    2 reused, 0 to run
candidate  base-without-agents-md  0 reused, 2 to run
```

Reused runs did not run next to the new ones, so drift (a model update, API latency) is not
balanced across the arms. The report says so, with how much earlier they finished:

```
note: reused runs from earlier comparisons (baseline 2/2), finished up to 3h before the new ones: the arms did not run interleaved, so drift since then (model updates, API latency, rate limits) is not balanced across them
```

When the agent can't report its version, an upgrade can't change the key; the dry run and the
report warn about it. `--json` carries `report.reused` (`{"baseline", "candidate"}`) and
`report.spend.<arm>.reused` (`{runs, usd, priced}`), present only when runs were reused.

### Agent release

Every run records the agent release it started on as `agentVersion`: the adapter's detected
version, asked again at most once a minute, so an auto-update during a long comparison shows on the
runs after it. A captured session's own version wins. When the arms ran on different releases (a
reused baseline from before an update is the common case), B − A measures the change and the
release together, and the report says so with an `agent` row and a note:

```
agent claude-code 2.1.316 ×12          2.1.319 ×12          release differs
note: baseline ran on claude-code 2.1.316 (12 runs), candidate on claude-code 2.1.319 (12 runs); the agent release differs between arms, so the delta mixes your change with the release. Rerun both arms together on one release, with the agent's auto-update off
```

`--gate` repeats the warning under its answer, and `--promote` holds and exits 1
(`report.pareto.refused` is `release_confound`). When the release changed mid-comparison in both
arms alike, a softer note names the releases and how many tasks ran on more than one. `--json`
carries `report.agentVersions` (runs per release per arm, `unknown` runs per arm, `splitTasks`,
`agent`, `confound`: `arms-differ` or `mixed`) whenever some run's release is known. No note when
under half of an arm's runs have a known release or when the arms run different agents. Releases
change the agent's own prompt and tools often: 29% of 1,867 consecutive releases of five coding
agents did (Paixao et al., [arXiv 2610.37332](https://arxiv.org/abs/2610.37332)).

### Iterate on a comparison

An interrupted comparison continues with `--resume` (see [long runs](#long-runs-resume-retries-status)).
Three more flags save runs while you iterate:

- `compare A B --experiment exp_01 --retry-errors` runs again, in place, each run of that
  comparison that ended in an error (the agent or verifier could not run) or an infrastructure
  failure after its retries. The old run stays in the store, marked superseded, so each task, arm
  and attempt counts once. Pass the same `--gateway` and `--trial-timeout` as the first run.
- `compare A C --failing exp_01` runs only the tasks A failed in `exp_01` (`exp_01@<bundle>` for
  another arm of it; `--failing-mode majority` for tasks it failed in more than half of its
  attempts). With `--task` or `--tag`, only the selected tasks it failed. The difference between
  the arms holds on these tasks, but both pass rates are conditioned on A having failed them, so
  the report says so:

  ```
  note: selection: 1 of 4 tasks: the 1 task base failed in exp_01M6WB…. The B − A difference holds for these tasks; both pass rates are conditioned on base having failed them, so they are not the arms' rates on the full set.
  ```

- `--sample 20 --seed 7` runs a random 20 of the selected tasks. The same tasks and seed draw the
  same sample; without `--seed` the report prints the one it used. Pass it to `--resume` a sampled
  comparison.

When a task, arm and attempt holds more than one run that counts, the report keeps the newest and
notes how many it left out. `--json` adds `planned` (runs this command had to run), `skipped` (runs
a resumed comparison had already finished), `retried` with `--retry-errors`, and `selection` with
`--failing` or `--sample`. The consent prompt counts only the runs still to go.

### Repair rounds

A pass rate says how often the agent gets a task right the first time. `compare --repair N`
also measures how well it fixes its own failure once told about it. When the verifier fails, the
agent gets "Verification failed." in its own session (Claude Code `--resume`, `codex exec resume`)
and works again, up to N rounds (1 to 8), until the verifier passes. An agent that can't resume
starts a fresh session with the instruction and the message.

```sh
coding.sh compare base candidate --repair 2 --repair-signal names
```

- The hidden test files are taken out of the work tree before each round and put back to grade
  it, so the agent never reads them.
- `--repair-signal names` adds the failing test names, read from the verifier output (pytest,
  node:test and TAP, Jest, Vitest, Go and cargo test). When no name can be read, the round gets
  "Verification failed." alone. The verifier's other output is never sent.
- A round whose diff since the start edits, deletes or skips tests ends the loop, and the run does
  not count as repaired, even when the verifier passed.
- `--false-alarm 0.2` tells a seeded 20% of passing runs that they failed, once, to measure how
  often a wrong "failed" makes the agent break working code. `--seed` picks which runs.
- A first attempt that errored or timed out gets no rounds.

The report adds a block before the task table. Pass rates, the verdict and the gates stay on the
first attempt; `--repair-verdict` moves them to the outcome after the rounds. Here with `--k 3`:

```
with verifier feedback (names, up to 2 rounds, resume)
seq@1 (first)     0.0% [0.0–0.0%]       0.0% [0.0–0.0%]       +0.0 pp
seq@2             8.3% [0.0–25.0%]      100.0% [100.0–100.0%] +91.7 pp
seq@3             100.0% [100.0–100.0%] 100.0% [100.0–100.0%] +0.0 pp
repaired          12/12 (100%) · 1.9 rd 12/12 (100%) · 1.0 rd
gain shares       EGS 0.08 · LGS 0.92   EGS 1.00 · LGS 0.00   gain by attempt 2 · by the last
unchanged         11/23 (48%)           0/12 (0%)             rounds that changed no file
cost to solve     $0.350                $0.200                agent spend per run solved
extra             $2.76 · 23 rounds     $1.20 · 12 rounds
names unparsed    23                    12                    rounds sent the bare bit
front A           pass@2 $0.240 0.0% · seq@1 $0.120 0.0%* · seq@2 $0.240 8.3%* · seq@3 $0.350 100.0%*
front B           pass@2 $0.200 0.0% · seq@1 $0.100 0.0%* · seq@2 $0.200 100.0%*
                  cost per task → success; * = no protocol does better at that cost
```

- `seq@k` is the share of tasks solved by the k-th attempt: the first, then each round (Seq@K,
  arXiv 2610.37859). A round that tampered with tests never counts. With one attempt per task the
  interval is Wilson's; with more it is a bootstrap over tasks.
- `gain shares`: of the gain from seq@1 to the last, EGS is the share the first round made and LGS
  the share the last round still made. A high LGS says another round would likely pay.
- `unchanged`: rounds after which the work tree's diff was the same as before the round.
- `cost to solve`: the agent's spend on all runs, rounds included, over the runs solved.
- `front`, with `--k 2` or more: mean cost per task against success for k independent first
  attempts (unbiased pass@k) and for k attempts with feedback (seq@k). A `*` point is one no other
  point, of either protocol, beats on both. When the arms rank one way on seq@1 and the other way
  on the last seq@k, a note says so.
- `after repair` appears with `--false-alarm`: the share passing at the end, which can fall below
  the last seq@k when a told passing run broke its work.

`agent spend` includes the rounds. The repair settings are part of each run's reuse key, so
`--reuse` never copies a run with other repair settings, or without repair, into this comparison.
`--json` has each arm's `repair` and `seq` summaries, `seqRanking` when both arms ran the same
settings, and each run's `repair` record (see
[the API reference](../reference/api.md#get-apitasks-get-apiruns-get-apibundles)).

## A/B a harness edit on your own sessions

`coding.sh compare` needs eval tasks with verifiers. Often you don't have those yet. You have a
CLAUDE.md line you think will help, and a week of sessions where the agent did the thing that line
is meant to stop. `coding.sh exp ab` tests the line on those sessions:

```sh
$ echo "After changing code, run the tests before you say you are done." >> CLAUDE.md
$ coding.sh exp ab
A: git:HEAD   B: your edits   model: claude-sonnet-5-5
12 decision points from 9 sessions | A 2/12 -> B 9/12 | fixed 7, broke 0 | paired p=0.016 | $0.41, 0/24 cached
Hold: not enough evidence (B wins 7, loses 0; needs 8+ wins with no losses)
Replay noise floor 8% (A's turn differs from the recorded one in 1/12); B moved +58 points, above it

Fixed (A failed, B passed):
  unverified-claim "The date picker drops the timezone. Fix it."  coding.sh show 3f9c2a1e
  ...
Full comparison: coding.sh exp compare exp_… exp_…
```

It works in three steps.

**Find the decision points.** It reads your recent sessions (`--since`, default 14 days) in this
repo (`--repo`, default the git root; `--repo all` for every repo) and looks for moments where the
agent tends to go wrong. Three are built in, and `--behavior` picks among them:
`unverified-claim` (it changed code, then said it was done without running anything),
`done-while-failing` (it ended the turn while its last test run was failing) and `unchanged-retry`
(it ran a failed command again unchanged). Each one becomes a case: the session frozen just before
that turn, plus a rubric for what a good next turn looks like. Sessions from eval runs and
subagents are skipped, and so are turns right after a context compaction. At most 2 cases come from
one session, and 40 overall (`--limit`).

**Replay the next turn twice.** For each case it asks the model for the next turn once with A's
harness files and once with B's. CLAUDE.md and AGENTS.md go in the way Claude Code injects them, a
path-scoped rule only when the session had touched a matching file, and a skill as a one-line
listing unless the session opened it. The model gets the tools the session used, plus a shell. Only
one turn is generated: nothing runs in your repo.

**Judge both turns.** An LLM judge scores each turn against the case's rubric. A turn passes at
0.8. The judge sees only the turn, never which arm wrote it.

By default A is your last commit (`git:HEAD`) and B is your working tree, so the usual loop is: edit
CLAUDE.md, run `coding.sh exp ab`, keep or revert. `--a` and `--b` take a file (it replaces the file
of the same path in A), a directory, `git:<rev>`, a harness bundle, or `none`. It errors when the
two arms have the same files, so a typo'd path can't produce a "no difference" result.

The headline counts the cases each arm passed, and which ones flipped. The second line is the same
ship gate as `compare --gate`, with the same settings (`--lambda`, `--gate-alpha`, `--tau`). With
`--gate`, the exit code follows it: 0 only for "Ship it". When B adds or removes one instruction
item, the one-item gate line appears too, scored only on the cases where that item would have been
in the agent's context.

**The noise floor.** A is the control arm. A replayed turn won't match what the agent did at the
time, even with the same files: a different model version, a missing system prompt and plain
sampling all move it. So `exp ab` also counts how often A's turn differs from the one recorded in
the session. That rate, with its Wilson interval, is the noise floor. When B moves fewer points than
that, the line says the difference may be replay noise. This is the control-arm requirement in
[experimentation-methods.md](../research/experimentation-methods.md) (EM-19). It is also why
absolute pass rates mean little here. Read the difference between A and B, not either number on
its own.

**Cost.** Before it runs, `--dry-run` prints the cases and an estimate: model calls, judge calls,
input tokens and dollars. `--max-cost 2` refuses to start when the estimate is over $2, and stops
the run if the spend passes it. A stopped or interrupted run keeps its finished trials, and
`--resume` picks up the rest. Responses and verdicts are cached under the data directory, so a rerun
with unchanged files makes no calls and costs nothing. Only an edited arm is asked again.
`--no-cache` asks the model again anyway, and `--trials 3` asks each case three times.

**Watch mode.** `coding.sh exp ab --watch` runs once, then reruns whenever B's files change and
prints one line per run:

```text
14:02:11  A 2/12 -> B 9/12 | fixed 7, broke 0 | Hold | $0.41, 24 new calls
14:05:40  A 2/12 -> B 11/12 | fixed 9, broke 0 | Ship it | $0.19, 12 new calls
```

Only B's calls are new: A's answers come from the cache. Ctrl-C stops it.

The model defaults to the one the agent was using at those moments (among the models the chosen
API can serve, so Codex sessions never pick a Claude model), else the provider's current default:
`claude-sonnet-5-5` for Anthropic, `gpt-6-sol` for OpenAI. The API defaults to Anthropic's
(`--provider openai` or `openai-compatible`, with `--base-url` for a local or proxied endpoint;
`openai-compatible` has no default model, so it needs `--model` when the sessions recorded none).
With no API key set, it uses a logged-in Claude Code or Codex instead (next section). `--json`
gives the comparison, the fixed and broken cases, the per-behavior counts, the provider, the cost
and the cache hits.

**A committed edit.** With no uncommitted harness edits and no `--a` or `--b`, `exp ab` tests your
last commit that changed CLAUDE.md, AGENTS.md, a rule or a skill (B, `git:HEAD`) against the version
before it (A, `git:<commit>^`), and says so. `--a git:<rev> --b git:<rev>` compares any two
commits, with or without `--dry-run`.

### Replaying on a subscription

`--provider claude-code` runs each next turn and each verdict through `claude -p`, and
`--provider codex` through `codex exec`, so a Claude or ChatGPT subscription can stand in for an API
key. `exp ab`, `refine` and the `improve` hints pick one when neither `ANTHROPIC_API_KEY` nor
`OPENAI_API_KEY` is set and the CLI is logged in: Claude Code first, Codex first when every
`--agent` is codex. They print one line saying which. Login is read from `CLAUDE_CODE_OAUTH_TOKEN`
(from `claude setup-token`), Claude Code's credentials file or account, or Codex's `auth.json`.

Each call is isolated from your setup:

- `claude -p` runs with `--setting-sources ""`, `--strict-mcp-config`,
  `--no-session-persistence` and `--disable-slash-commands`, and a throwaway `CLAUDE_CONFIG_DIR`
  that holds only the token or a copy of the credentials file. No hooks, plugins, MCP servers,
  CLAUDE.md or settings of yours load, and the call is not recorded as a session. On macOS, where
  the login lives in the keychain, there is no file to copy, so it uses your config dir and relies
  on those flags alone; set `CLAUDE_CODE_OAUTH_TOKEN` to get the throwaway dir there too.
- `codex exec` runs with `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, a read-only
  sandbox and `project_doc_max_bytes=0`, and a throwaway `CODEX_HOME` holding a copy of
  `auth.json`. Our system prompt replaces Codex's instructions (`model_instructions_file`).
- Every call runs in a new empty directory, removed afterwards. A login the CLI refreshes during
  the run is copied back when it exits, unless your own file changed meanwhile.

The prompt carries the same content as the API request: the system prompt, the harness files in a
`<system-reminder>` block before the first user message, and every turn up to the decision point,
with each tool call's input and each tool result. The tools reach the model in one of two ways:

- **Natively**, with `claude-code` when every tool of the session is a Claude Code built-in (Bash,
  Read, Edit, Write, Glob, Grep and the like). `claude -p` gets `--tools` with those names and
  calls them as it would in a session. A `PreToolUse` hook of our own (`--settings`) refuses every
  call, so none runs, and `--max-turns 1` ends the run after that first turn. The tool calls are
  read from the `stream-json` output.
- **As JSON**, with `codex`, and with `claude-code` when a session used other tools (MCP tools,
  another agent's tools). The tools are listed by name, description and input schema inside the
  prompt, the model has no tools (`--tools ""`), and it answers with `{"text": …, "tool_calls":
  [{"name": …, "input_json": …}]}`, held to that schema by `--json-schema` or `--output-schema`.
  The judge reads the same text and tool calls either way.

The JSON form is the fallback because it changes behavior. On a real replay of four sessions that
claimed done without running the tests, with a CLAUDE.md line telling the agent to run `npm test`,
Claude Haiku often answered in the JSON form that "the Bash tool is disabled", and arm B passed 0 to
2 of the 4 decision points over five runs. With native tools B passed 4 of 4 (A 0 of 4 both ways),
which matches what the edit did in later real sessions.

Other differences, in both forms:

- The turns are a transcript in one user message (`<user>`, `<assistant>`, `<tool_call>`,
  `<tool_result>` tags), not separate API messages.
- Claude Code adds lines before the system prompt (a billing header and "You are a Claude agent,
  built on Anthropic's Claude Agent SDK."), a message with its own environment (the throwaway
  directory, the platform, the date), and with `--tools` its own tool descriptions, which differ
  from the ones the session recorded. Codex wraps its own turn around the prompt.
- Thinking, effort and the reply length follow the CLI's defaults; `--model` still picks the
  model.

So a subscription replay is close to the API's but not identical. Compare edits on one provider;
don't mix an API run with a subscription run in one A/B.

Limits: calls run 2 at a time per CLI (`--concurrency` lowers it). A rate-limit error waits 20 s,
then 40, 80 and 160, and then fails that trial. A message that the plan's usage limit is reached
stops the run: no new trial starts, the finished ones are stored, and the next run reuses them from
the cache. Costs are API-equivalent, priced from the tokens the CLI reports, and shown as
`$0.41 API-equivalent`; `--json` adds `"apiEquivalent": true`. There is no spending cap unless you
pass `--max-cost`.

**Your own decision points.** `--anchor ./anchors.mjs` loads a module whose default export is an
anchor, or an array of them: `{ id, version, frame, behavior, rubric, find(events) }`. `find` gets a
session's events in time order and returns the cuts, each `{ cutBeforeEventId, evidenceEventIds }`.
`frame` is `"action"`, `"failure"` or `"claim"`.

**Building blocks.** The same pieces work without `exp ab`. A dataset of decision points is an
ordinary dataset (named `dp-…`), and a `continuation` task replays a frozen session's next turn:
`{"kind":"continuation","provider":"anthropic","model":"claude-sonnet-5-5","context":{"files":["CLAUDE.md"]}}`.
`exp run` with a continuation task needs a control arm: run it as an A/B with `--arm`, or pass
`--no-control` to run one arm alone, and the comparison then warns that it has no noise floor.

## Protected safety lines

A pass-rate A/B can't see the harm of dropping a safety rule. If no decision point needed
"Never run `git push --force`", deleting it costs nothing in the batch, and the gate may even call
the shorter file a win. Rewording a rule into a conditional ("only ask when the path is
ambiguous") or adding an exception next to it is just as invisible ("Masked Erosion",
arXiv 2610.38392). So harness edits are checked by text, before any model call.

```sh
$ coding.sh refine protected
WHERE        WHY     LINE
AGENTS.md:3  auto    Never run `git push --force`.
AGENTS.md:4  auto    Ask the owner before deleting anything under `prod/`.
AGENTS.md:9  marker  Keep answers short.
  3 protected lines in 1 file (current files; auto-protect on, 0 patterns)

$ coding.sh refine check
protected-line: AGENTS.md:3 "Never run `git push --force`." (auto)
relaxes-protected: "Only ask the owner when the path is ambiguous." vs AGENTS.md:4 (added at AGENTS.md:5)
✗ 2 protected-line problems from A (git:HEAD) to B (your edits); a pass-rate A/B can't see this harm

  Restore the line, or allow this edit on purpose:
    coding.sh refine check --allow-protected-edit AGENTS.md:3
```

A line is protected when it is:

- inside a `<!-- coding.sh:protect -->` … `<!-- coding.sh:protect end -->` block (`marker`),
- matched by a `[refine] protect` regex, tested against the line without its list marker or bold
  (`config`), or
- a sentence of at most 240 characters with a gate word and a safety topic (`auto`). The gate
  words are never, do not, don't and must not anywhere in the sentence, and only, before, ask,
  confirm, verify, check and require at its start. The topics are credentials, secrets, access
  tokens, private keys, `.env`, prod, deploy, push, `--force`, force-push, destructive,
  `--no-verify`, `rm -rf`, delete, drop table, `reset --hard`, migrations, permissions, sudo, chmod,
  payments, PII, personal data, another user, owner, dry-run and backups. Headings, table rows,
  fenced code and frontmatter are never auto-protected.

`refine check` runs two critics on an edit. By default the edit is git `HEAD` against your working
tree, and `--a`/`--b` take the same values as `exp ab`.

- **protected-line**: a protected line of A is gone from the same file in B. Deleting it,
  rewording it and moving it to another file all count. Case and spacing don't.
- **relaxes-protected**: B adds a line with a relaxing cue (skip, no need, unnecessary, only …
  when/if, unless, without asking, already verified …) that shares a backticked token, a safety
  topic or a word with a protected line.

It exits 1 when either fires. `--json` gives `ok`, the protected `lines`, the `rejections` (each
with `critic`, `reason`, the `protected` line and, for a relaxing one, the `added` line) and the
`overridden` ones. To make such an edit on purpose, name the protected line:
`--allow-protected-edit AGENTS.md:3` (repeatable; `--force` never implies it).

`exp ab` runs the same check on its arms. It warns before any model call, adds a `Protected:` line
to the report and `protected` to `--json`, and with `--gate` a protected-line problem fails the run
whatever the verdict. `--allow-protected-edit` works there too.

Set `[refine] autoProtect = false` in your user config to keep only markers and patterns. A repo's
`.coding.sh/config.toml` can add `protect` patterns but can't turn auto-protection off, since an
agent editing the repo could otherwise unprotect a rule and then delete it. See
[`[refine]`](../reference/config.md#refine).

## Refine loop

`coding.sh refine` improves CLAUDE.md, AGENTS.md, rules and skills in rounds. Each round tests one
or more candidate edits against your current files and keeps, rejects or holds each one. Only a kept
edit can be applied, and every round goes into a ledger.

```sh
$ coding.sh refine propose
r_3123c2cbef  CLAUDE.md (+1 line)
  + TEST-RULE: run npm test before you say you are done.
Why: sessions end with an unverified claim
  From 1 finding; spent <$0.01

$ coding.sh refine test r_3123c2cbef
r_3123c2cbef  (CLAUDE.md; +3 lines)
  protected  ok (1 protected line in place)
  critics    ok
  dev        8 decision points | effect +100pp [+100pp, +100pp] | B wins 8, loses 0; A solved 0
  preserved  gained 8, lost 0, 0 tasks regressed
  verdict    keep: dev: Ship it: B wins 8 decision points, loses 0; guard: no earlier kept wins to hold

$ coding.sh refine apply
✓ Applied r_3123c2cbef to CLAUDE.md
  Backup in ~/.coding.sh/refine/repo-d095414f/backups/a_25e3658e56

$ coding.sh refine test ./drafts/CLAUDE.md --behavior unchanged-retry
r_b25de6ab68  ./drafts/CLAUDE.md (CLAUDE.md; +1 line)
  protected  ok (1 protected line in place)
  critics    ok
  dev        8 decision points | effect +100pp [+100pp, +100pp] | B wins 8, loses 0; A solved 0
  guard      8 tasks earlier kept edits won (0 from this run, 8 rerun) | forgets kept edit r_3123c2cbef
  preserved  gained 8, lost 0, 0 tasks regressed
  verdict    reject: dev: Ship it: B wins 8 decision points, loses 0; guard: forgets kept edit r_3123c2cbef

$ coding.sh refine log
ROUND  CANDIDATE     VERDICT        EFFECT (95% CI)          GUARD                 COST   REASON
1      r_3123c2cbef  keep, applied  +100pp [+100pp, +100pp]  no tasks              $0.02  dev: Ship it: B wins 8 decision points, loses 0
2      r_b25de6ab68  reject         +100pp [+100pp, +100pp]  forgets r_3123c2cbef  $0.02  guard: forgets kept edit r_3123c2cbef
```

The second edit wins its own decision points, but it drops the line the first edit added, so it
loses the tasks that edit won. The guard catches that.

**Candidates.** `refine test` takes one or more edited files, directories, `git:REV`s, harness
bundles or stored `r_…` ids. A single file stands in for the harness file at its repo path, or
else for the file with its name, so `./drafts/AGENTS.md` replaces `AGENTS.md`. A candidate's id is
a hash of its changed files. Its files are stored with the ledger, so `refine test r_…` and
`refine apply r_…` work later.

**Proposals.** `refine propose` asks a model for lines to add to one file: `--target`, else
AGENTS.md, then CLAUDE.md, then GEMINI.md. The prompt lists your sessions' most severe flags (up to
five, since `--since`, in this repo), each with its diagnosis and severity score. It shows the
target file and marks its protected lines READ-ONLY. It also lists edits tested before and not kept,
with their reasons (the last 20). The prompt is redacted before it is sent. The reply must be JSON
with at most 40 lines and no HTML comments. The lines are appended in a
`<!-- coding.sh:refine r_… begin -->` … `end` block and stored as a candidate. `--dry-run` prints
the findings and the prompt without calling the model. The model is `--proposer-model`, else
`--judge-model`, else `--model`, else the provider's default.

**Stages.** `refine test` decides each candidate in this order and stops at the first that fails:

1. **protected**: the [protected-line check](#protected-safety-lines). A deleted, reworded or relaxed
   protected line rejects the candidate before any model call.
2. **critics**: two checks on the added lines, also before any model call. *harmless* rejects a
   line that tells the agent to skip or disable tests, edit CI or verifier files, use
   `--no-verify`, force-push, `chmod 777`, broaden permissions, hard-code expected output or "make
   the tests pass", or a line that holds a secret. A line that forbids the act ("never …",
   "don't …") is fine. *duplicate* rejects a line that is a near copy of a line the file already
   has (character 5-gram Jaccard of 0.8 or more).
3. **dev**: an A/B of the candidate against your current files on the decision points `exp ab`
   mines from your sessions, with the same runner, judge, cache and flags (`--behavior`, `--since`,
   `--limit`, `--model`, `--trials`, …). The acceptance gate decides: "Ship it" goes on, "Hold" is
   `inconclusive`, and "Don't ship" rejects.
4. **guard**: the decision points that earlier kept edits won, newest first, at most `--max-guard`
   (24). They must not go from solved to unsolved. Guard tasks inside this round's decision points
   reuse the dev results. The others are run again on both arms. When the gate on the guard tasks
   says "Don't ship", the candidate is rejected with `guard: forgets kept edit r_…`. A rolled-back
   edit's tasks no longer count.

A candidate that passes every stage is kept, and the decision points it won join the guard set.
Each tested round also reports what the candidate gained and lost per task. When a held or rejected
candidate gains tasks no kept edit covers and has no hard regression (a task the base solved every time and the candidate at most a third of the time), it is marked `alternative`. A guard
reject is never an alternative. With several keeps in one round, the largest effect wins, and ties
go to fewer regressed tasks, then lower cost per solved task.

`refine test` exits 0 when a candidate was kept and 1 otherwise. `--dry-run` shows the checks, the
decision points, the guard size and the cost estimate, and makes no model calls. `--max-cost 2`
refuses to start when the estimate is over $2. A run that passes the cap stops, and a partial run
is `inconclusive`, never kept. `--json` gives each round's ledger entry.

**Apply and roll back.** `refine apply` writes the latest kept candidate (or the one you name) into
your working tree and backs up what it replaces. It never commits. It refuses a candidate that was
not kept, or whose files changed since its test, unless you pass `--force`, and the ledger records
the override. `refine rollback` puts the backup back, byte for byte, and removes a file the apply
created. It refuses when the file was edited after the apply, or when a later apply touched the same
file, unless you pass `--force`.

**The ledger.** Every round, apply and rollback is a line in
`~/.coding.sh/refine/<repo>-<hash>/ledger.jsonl`, next to the stored candidates and the backups.
`refine log` prints one row per round: verdict, effect with its 95% CI, guard result, cost and
reason. It ends with the [`exp plateau`](#when-to-stop-a-loop) line for the series of kept rounds. `--json`
gives every entry.

**The loop.** `refine run` repeats propose, test and apply-when-kept for up to `--rounds` (3)
rounds. `--candidate FILE` (repeatable) tests your own edits in order instead of asking the
proposer. It stops at `--rounds`, when the candidates run out, at `--max-cost` (the cap covers the
whole loop, proposer calls included), when the plateau detector says stop, or on Ctrl-C. It exits 0
when it applied an edit. `refine run --dry-run` shows the findings, the decision points, the guard
size and the cost of one round.

### Climbing on an eval suite

With `--suite <name>`, `refine test` and `refine run` judge an edit on an eval suite of repo tasks
(`evals/<name>`, from [`eval init`](#your-first-eval-in-5-minutes) or written by hand) instead of mined decision
points. That lets a round ask more than "is it better?": it can also ask "is it cheaper or faster,
and no worse?".

```sh
$ coding.sh refine test ./drafts/CLAUDE.md --suite strkit --objective cost,wall,tokens --yes
$ coding.sh refine run --suite strkit --objective cost,wall,tokens --until-plateau --yes
$ coding.sh refine log
```

**Rounds.** Each round runs every task of the suite `--trials` times (default: the suite's
`trials`, else 3) with your current files and with the candidate, interleaved, as one durable job.
The harness is `--harness`, else the suite's, else a snapshot of the repo's setup, with the repo's
harness files laid over it. `--model` is the agent's model and `--concurrency` the parallel
sessions. Only `tasks` suites work: a `cases` suite grades a command's answers, which a harness
file does not change, and a `triggers` suite only checks that a skill loads.

**Objectives.** `--objective` lists what to improve, primary first: `pass` (the default), `cost`,
`tokens`, `wall` (wall time), `llm` (LLM time), `turns` and `size` (the instruction bytes the
agent loads). The pass rate is always judged. A candidate is:

- **rejected** when a task the base passed every time now mostly fails (a hard regression), when the
  acceptance gate says "Don't ship", or when a listed objective is significantly worse by
  `--min-gain`;
- **kept on quality** when the pass rate is significantly better (a one-sided paired permutation
  test over tasks), or the gate says "Ship it";
- **kept on efficiency** when the pass rate holds within `--margin` (default 2pp: the one-sided
  95% bootstrap lower bound of the per-task difference is above minus the margin) and a listed
  objective is significantly better by at least `--min-gain` (default 10%). Cost, tokens, times and
  turns are compared as per-task log ratios with a one-sided permutation test; size is a byte count.
- **rejected** when the pass rate fell and did not hold within the margin, however much cheaper or
  faster it got;
- **inconclusive** otherwise.

A measure decides only when at least 80% of each arm's runs reported it: cost and tokens need
captured sessions, so run `coding.sh init` for the agent first. With fewer than 5 tasks no
one-sided test can reach significance, and the round says so.

**Cuts.** When the primary objective is not `pass`, the proposer cuts instead of adding. It sees the
target file and its largest sections, and what made the last round's runs slow or expensive:
tokens, turns and time per run, the slowest tasks, tool calls per run, the same call repeated in a
run, duplicate fetches and long tool outputs (measured at full length, though the capture clips
them). It also sees the cuts tested before and not kept, with the sections each one took lines from.
It replies with edits: `{"find", "replace"}`, where `find` occurs exactly once, or `{"section",
"replace"}`, which replaces a heading and everything under it up to the next heading of the same or
a higher level. The protected-line check and the critics still run on the result, so a cut
that removes or weakens a safety line is rejected before any agent runs. `--proposer-command 'claude
-p'` writes the edit with a command instead of the proposer model: it gets the prompt on stdin and
prints the JSON reply.

**Skills.** `--target .claude/skills/<name>` edits that skill's `SKILL.md`. When `evals/<name>`
exists and `--suite` is not given, it is the suite.

**Until it stops gaining.** `--until-plateau` runs rounds until the restart e-detector (the one
[`exp plateau`](#when-to-stop-a-loop) uses) alarms on the rounds' per-task gains on the primary
objective, then names the version to keep. A climb is one suite, primary objective and target file;
its state is rebuilt from the ledger, so running the command again continues it. An interrupted
round (Ctrl-C or `--max-cost`) keeps its finished runs, and `--resume` runs only the rest. It
refuses when the harness files changed since the round started.

**The log.** `refine log` shows each climb as a table: pass rate, cost and wall time per run and
size for both arms of every round, the verdict and the reason. It ends with the Pareto front (pass
rate against the primary objective, or cost when the primary is `pass`) and the plateau line. The
front compares point estimates from different rounds, so it is a map, not a test.

Here is a climb with Claude Code (`--model claude-sonnet-5-5`) on a repo whose CLAUDE.md was
51 KB: a style guide and a project history, a step telling the agent to read three long docs
first, and a rule that error messages start with `strkit: `, which the task checks test. The
suite had 6 tasks and 2 trials. Round 1 was a hand trim that also dropped that rule. Rounds 2
and 3 came from `--proposer-command 'claude -p'`: round 2 removed the style guide and the
history, and round 3 changed "read the docs first" to "read them only if the task needs them".

```sh
$ coding.sh refine log
Climb on strkit (CLAUDE.md, primary cost / run)
ROUND	CANDIDATE	VERDICT	PASS	COST/RUN	WALL/RUN	SIZE	REASON
1	r_5f83c31fad	reject	100% → 0%	$0.29 → $0.0347 (−88%)	20.6s → 13.4s (−35%)	51166 B → 292 B (−99%)	hard regression: the base passed camelCase, countWords, padCenter, reverseWords, slugify, truncate every time and the candidate now mostly fails
2	r_d50d8bebd5	keep (efficiency), applied	100% → 100%	$0.27 → $0.22 (−20%)	14.6s → 14.0s (−4%)	51166 B → 596 B (−99%)	cost / run -20% [-25%, -9.8%], p 0.031 with quality held: pass rate 100% → 100% (+0.0 pts per task [+0.0 pts, +0.0 pts], one-sided lower bound +0.0 pts vs margin −2.0 pts)
3	r_9387e6524f	keep (efficiency), applied	100% → 100%	$0.22 → $0.0372 (−83%)	13.7s → 8.7s (−36%)	596 B → 530 B (−11%)	cost / run -83% [-83%, -82%], p 0.016; wall time / run -36% [-42%, -31%], p 0.016; tokens / run -45% [-51%, -40%], p 0.016 with quality held: pass rate 100% → 100% (+0.0 pts per task [+0.0 pts, +0.0 pts], one-sided lower bound +0.0 pts vs margin −2.0 pts)
Pareto front (pass rate vs cost / run): r_5f83c31fad (round 1, not kept): 0% pass, $0.0347; r_9387e6524f (round 3): 100% pass, $0.0372
climb: still gaining after 3 rounds (log wealth -0.17 of 3.00; a flat plateau needs at least 21 rounds to show at this suite size)
```

### Scoring diagnoses

`coding.sh refine score` checks diagnoses against labels you wrote by hand. Code does every match;
no model is called. It writes nothing.

```sh
$ coding.sh refine score labels.jsonl --pred run1.jsonl --pred run2.jsonl
Labels: labels.jsonl, 3 occurrences in 2 Signals over 4 sessions

run1.jsonl (3 predictions)
  occurrences P 66.7% (2/3)  R 66.7% (2/3)  F1 66.7%
  signals     P 50.0% (1/2)  R 50.0% (1/2)  F1 50.0%
  sessions    P 66.7% (2/3)  R 66.7% (2/3)  F1 66.7%
  coverage    >=1 matched 50.0% (1/2)  >=half matched 50.0% (1/2) of labelled Signals
  recall      out 0.0% (0/1), tool 100.0% (2/2)

run2.jsonl (2 predictions)
  ...

repeat agreement 25.0% (2 runs, 1 pair, 4 sessions)
```

**Labels.** One JSON object per line: an occurrence of a problem in one session.

```json
{"sessionId": "s1", "signalId": "edit-miss", "component": {"type": "tool", "name": "Edit"}, "typeIds": ["tool.invalid-args"], "nature": "defect"}
{"sessionId": "s4"}
```

`signalId` groups occurrences that one fix would address; a Signal can span sessions. The component
type is `agent`, `subagent`, `tool`, `model`, `runtime` or `harness`. `typeIds` holds 1 to 3 ids
from the diagnostic taxonomy (`src/refine/taxonomy.ts`), best first. `nature` is optional and must
be one the first type allows. A line with only `sessionId` marks a session you reviewed and found
nothing in. An unknown id, component type or nature fails the run with its line number (exit 1).
Prediction files use the same format.

**Matching.** A prediction matches a label when both are in the same session, the component types
are equal, the component names are equal after normalization (Unicode NFKC, camelCase and digit
boundaries split, lowercase, runs of `-_./` and spaces become `-`, so `createPayment`,
`create_payment` and `Create Payment` are one name), and their first three type ids share at least
one id. The matching is a maximum one-to-one matching, so input order does not change the result.
An unmatched prediction counts against precision and an unmatched label against recall.
Predictions in sessions the labels do not name are left out and counted.

**Metrics.** Each number comes with its counts.

- **occurrences**: precision, recall and F1 over the matched pairs.
- **signals**: Signal-to-Signal matching. Two Signals match when they share a component and a type
  id. How many occurrences each has does not matter.
- **sessions**: a session counts as positive when it has at least one occurrence.
- **coverage**: labelled Signals with at least one matched occurrence, and with at least half of
  them matched.
- **recall** per family of the label's first type id.
- **repeat agreement** (two or more `--pred` files): for each pair of runs, the share of labelled
  sessions where both agree on whether the session has a problem, averaged over pairs.

A rate with nothing to divide by prints `—` (`null` in `--json`, with the rate named in `empty`).

**Flags.** Without `--pred`, the predictions are the session flags of the labelled sessions in the
store, read through the taxonomy (`premature-completion` is `out.false-success` or
`out.incomplete-result`). Context-only flags and tags are skipped. A flag names no component, so it
matches a label in its session that shares a type id. The output adds precision per flag; each flag
is matched on its own, so two flags can both be credited with one label. Labelled sessions missing
from the store are left out with a warning.

## Skill triggers

`coding.sh eval trigger <skill-dir>` checks that the agent loads a skill when it should and leaves
it alone when it shouldn't. It reads `triggers.toml` next to the skill: `[[should]]` and
`[[should_not]]` prompts, each with an optional `weight` (1 or 0.5), and on near misses an
`expect_skill` naming the sibling that should take the prompt. Each prompt runs k times (the spec's
`k`, default 3) through the harness runner, in a fresh empty directory with the skill and its
siblings installed in the agent's project skills dir. A run counts as loaded when its captured
session has the skill load (Claude Code's Skill tool, or a read of the SKILL.md); without a session
it reads the agent's stdout. Runs that error, or time out before loading, are left out of the
metrics and counted.

The report gives precision, recall, F1 and accuracy (weighted), Wilson intervals on recall and on
the false-trigger rate, each missed prompt with x/k and a flaky mark, and the expected routes.
`--description TEXT|@FILE` or `--candidate DIR` adds a second arm. Both arms run the same prompts,
interleaved in a seeded order. The delta is a paired bootstrap CI on per-prompt accuracy, plus
McNemar at k=1 and the prompts whose majority answer flipped. `--min-f1 X` exits 1 when the tested
arm's F1 is under X. `--fail-on regression` exits 1 when B's CI is below 0. Results go to
`~/.coding.sh/triggers/<skill>/`. See [Does the skill load?](../how-to/evaluate-a-skill.md#does-the-skill-load).

## Replay a model call

`exp ab` replays a whole next turn with the agent. `exp replay` replays one model call: the exact
request [the proxy](../how-to/capture-with-proxy.md) logged, sent again with the model, the system
prompt or any request field changed.

```sh
coding.sh exp replay latest#-1 --vary model=claude-sonnet-4-5,claude-haiku-4-5 --n 5 --dry-run
coding.sh exp replay latest#-1 --vary model=claude-sonnet-4-5,claude-haiku-4-5 --n 5
coding.sh exp replay --session latest --limit 10 --vary system=@new-prompt.md
```

One `--vary` value changes arm B and keeps arm A as recorded; two values set both. Each reply is
graded by whether its first action (a tool call by name, or text) matches the one the agent took.
`--criterion` adds an LLM judge and `--grader` any grader above. The two arms are experiments, so the
report is the paired comparison of `exp compare`, and `exp compare` and `exp show` read them later.

It calls the API with your own `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, never the agent's login, and
stops before any call when the key is not set. `--dry-run` prints the call count and an estimated
cost without a key; `--max-cost` refuses a run estimated above it. Replay needs calls logged in
capture mode `full`.

## Tool evals

`coding.sh toolevals` measures how well agents use a CLI, MCP server or HTTP API: surface size,
schema checks, per-task tool-call metrics in a sandbox, variant comparisons and MCP description
compression. `toolevals compare` prints `p (perm)` next to McNemar: a task-paired permutation test
on per-task pass-rate differences, exact up to 20 tasks. See [TOOL-EVALS.md](../TOOL-EVALS.md).

## Workflows

`coding.sh workflows` imports multi-agent workflow runs and reports the run tree, critical path,
concurrency, cost and paired variant comparisons. See the [workflow experiments guide](workflows.md)
and [design/workflows.md](../design/workflows.md).

A variant can resume from a recorded run (`"resumeFromRunId"`), so only the stages after the edit
run again. Compare it against a control variant that resumes the unedited script from the same
runs, not against fresh baseline runs: `workflows compare` notes "no control fork" otherwise. With
a control, it reports how often the control's outcome changed from its source run as the replay
noise floor (`control.drift` in `--json`). Treat differences below that as replay drift.
