# Turn failed runs into evals

The runs your agent already got wrong make the best eval cases. Keep any recorded run as a dataset
case, or turn a coding agent's flagged sessions into repo tasks that replay the repo as it was.
Site version: [coding.sh/docs/how-to/session-to-eval](https://coding.sh/docs/how-to/session-to-eval).

| You have | Keep it as | Graded by |
|---|---|---|
| A run of any agent: your own over the SDK or OpenTelemetry, or a coding agent | A **dataset case**: the run's first prompt is the input | An LLM judge or your own `command` grader |
| A coding agent session in a git repo (Claude Code, Codex, …) | A **repo task**: the repo at the session's start, its prompt, and a command that checks the result | Your verifier, for example the test that failed |

## Keep a run as a dataset case

Any recorded run with a user prompt works. Find it, then add it to a dataset:

```sh
coding.sh sessions --where is:flagged
coding.sh dataset add fixes --session c435f0ac --split test
```

```text title=output
✓ fixes: 1 case
fixes@be8fc9f95153d864
```

The case's input is the run's first prompt. The agent's last reply is kept in the case's metadata as
`output`, not as the expected answer, so grade these cases with a judge or a `command` grader rather
than `exact`. Run your agent on them:

```sh
coding.sh exp run --dataset fixes --name base \
  --task '{"kind":"command","command":"node","args":["triage.mjs"]}' \
  --grader '{"kind":"llm","name":"resolved","rubric":"Pass if the reply resolves the request."}'
```

Before you trust the judge, label some runs pass or fail and check it against your labels; see
[LLM judges](https://coding.sh/docs/judges).

## Turn coding agent sessions into repo tasks

This example runs on a copy of the coding.sh repo. Claude Code was asked to fix `passAllK` in
`packages/coding.sh/src/stats/seqk.ts`; it wrote a wrong fix and stopped while the test still failed.

### 1. Find the sessions that went wrong

```sh
coding.sh sessions --where is:flagged
```

```text title=output
ID                                    AGENT        STARTED  DURATION  TURNS  TOOLS         TITLE
c435f0ac-4806-4a11-a21f-26e8f6200814  claude-code  20s ago  16s       1      3 (1 failed)  Fix passAllK in packages/coding.sh/src/stats/seqk.ts: packages/coding.sh/test/stats/seqk.test.ts fails

  1 of these 1 sessions are flagged (premature-completion 1). See what to fix first and the line that fixes it:
    coding.sh improve
```

`coding.sh eval candidates` ranks them by how useful each would be as a task, and guesses the
verifier:

```text title=output
 1.   6  c435f0ac-4806-4a11-a21f-26e8f6200814  Fix passAllK in packages/coding.sh/src/stats/seqk.ts: packa…
         +2 premature-completion, +1 tests still failing, +2 verifier guessable, +1 last 7 days  · verifier: node --no-warnings --test packages/coding.sh/test/stats/seqk.test.ts
```

### 2. Write the suite

```sh
coding.sh eval init --sessions --verifier 'node --no-warnings --test packages/coding.sh/test/stats/seqk.test.ts'
```

```text title=output
✓ Wrote capability suite failures (1 task) to evals/failures
  evals/failures/suite.json
  evals/failures/tasks/fix-passallk-in-packages-coding-sh/
  fix-passallk-i… node --no-warnings --test packages/coding.sh/test/stats/seqk.test.ts · from session c435f0ac
! the agent's failed attempt is saved as near-misses/001.patch (the verifier must fail it). Add reference.patch, a correct fix, to each task dir; then coding.sh eval import evals/failures/tasks/<task> loads it and coding.sh eval validate <task> checks the verifier fails before the fix and passes after

  Capability suite: tasks the agent can't do reliably yet. Its score starts low; `eval run` reports it and never fails on it.
  Trials: 3 per task; the report gives pass@3 (passed at least once) and pass^3 (passed every time).
```

Each task directory holds `instruction.md` (the session's first prompt), `task.json` (the starting
commit and the verifier) and `near-misses/001.patch` (the session's own diff).

### 3. Run it

```sh
coding.sh eval run failures
```

```text title=output
failures  capability suite · 1 task · 3 trials each
pass@1  66.7% [20.8%, 93.9%]  (2/3 trials, 95% Wilson)
pass@3  100.0%  a task counts when any of 3 trials passes
pass^3  0.0%  a task counts only when all 3 trials pass

task                                passed         first failure
----------------------------------  ------  -----  ---------------------------
fix-passallk-in-packages-coding-sh     2/3  flaky  coding.sh show 73cfa2b3-7f7

flaky: fix-passallk-in-packages-coding-sh. These pass some trials and fail others; pass^3 counts them as failures.
1 task without a reference solution (fix-passallk-in-packages-coding-sh): add reference.patch to the task dir, then coding.sh eval import <task dir> and coding.sh eval validate <task>

Verifier output of failed runs (last 8 lines):
  fix-passallk-in-packages-coding-sh · attempt 2  exit 1 · run_01M754Z1D3PWC0WEM0NKVJXMRA
    │ # pass 18
    │ # fail 2
captured failures: 1 of 1 now pass: fix-passallk-in-packages-coding-sh (session c435f0ac-4806-4a11-a21f-26e8f6200814)
```

Each trial starts the agent on a fresh copy of the repo at the session's starting commit. The agent
fixed it in 2 of 3 trials, so the task is flaky. `coding.sh show <id>` opens a failed trial's
transcript. `captured failures` counts the sessions that failed before and now pass at least once.

### Pick the sessions

| Flag | What it does | Default |
|---|---|---|
| `--session <id>` | Use this session (an id, a prefix or `latest`). Repeatable. | |
| `--where <query>` | Use the sessions that match a query, for example `'is:flagged agent:claude-code'`. | |
| `--since`, `--limit` | The window and the most sessions to take. | `14d`, 10 |
| `--repo <dir\|all>` | Sessions from another repo, or from every repo. | This repo |
| `--verifier <cmd>` | The command that must pass when the task is done. | Guessed per session |
| `--hidden-test <glob>` | Test files kept out of the agent's view and copied in only when the verifier runs. | |
| `--validate` | Check each task before it goes into the suite (see below). | Off |
| `-k`, `--trials` | Trials per task in `eval run`. | 3 |

Sessions captured by hooks start from the commit that was checked out, so uncommitted changes at that
point are missing. `coding.sh run -- <agent command>` snapshots the whole working tree before and
after, so it records the exact start.

## Make the task fair

A failed session's diff is not a correct answer, so it is kept as a near miss the verifier must fail.
Add a correct fix as `reference.patch` in the task's directory, load it, and check the task:

```sh
coding.sh eval import evals/failures/tasks/fix-passallk-in-packages-coding-sh
coding.sh eval validate fix-passallk-in-packages-coding-sh --k 5
```

| Check | Passes when |
|---|---|
| No-op fails | The verifier fails on the untouched repo. |
| Reference passes | The reference passes the verifier k times out of k. |
| Near misses fail | The session's own diff, and other partial versions, fail the verifier. |
| Existing tests still pass | The repo's own test command passes after the reference wherever it passed before. |
| No leakage | Hidden test content does not appear in what the agent sees. |

A task that passes every check is marked `validated`; otherwise it stays a `draft` and the output says
why. `--keep` keeps the work directories so you can look. The existing-tests check runs the repo's
whole test command, so it takes as long as your test suite.

`eval init --validate` runs the same checks while it writes the suite. A session whose end state
passes the verifier becomes the task's reference. One that fails it, or that edits the tests the
verifier runs, is kept as a near miss.

## One session at a time

`eval new` drafts one task, with your own name and instruction:

```sh
coding.sh eval new latest --name passallk-fix \
  --verifier 'node --no-warnings --test packages/coding.sh/test/stats/seqk.test.ts' \
  --hidden-test 'packages/coding.sh/test/stats/seqk.test.ts' \
  --tag stats
```

The instruction defaults to the session's first prompt. `--instruction 'text'` or
`--instruction @prompt.md` replaces it, and `--setup 'npm ci'` (repeatable) adds setup commands.

## What marks a session as failed

Flags are found on every ingest. Some of them:

- `premature-completion`: the agent stopped while the last test run was failing.
- `no-verification`: files changed, but no test, type check, lint or build ran.
- `repeated-tool-failure`: the same tool failed three times in a row with similar input.
- `test-tamper`: the agent edited a test in a way that hides failures.
- `looping`, `failure-streak`, `churn`, `stalled`: a long run went off track.

Flags are heuristics: read the session before you keep its task. [Concepts](../concepts.md) lists
every flag.

## Limits

- coding.sh does not write the correct fix. A task without `reference.patch` runs, and the report
  lists it as having no reference solution.
- Repo tasks start from snapshots on this machine, so they run here, not in CI. Compare setups
  on them with `coding.sh compare <before> <after> --tag suite:failures --k 3`.
- For CI, use dataset cases; see [Catch a regression in CI](ci-regressions.md).
- With the MCP server registered, an agent can build a suite with the `eval_init` tool, or draft one
  task with `eval_from_session`, which asks you first.

## Next

- [Evals](https://coding.sh/docs/evals)
- [Compare two agents](compare-agents.md)
- [How evals are computed](../reference/eval-methods.md)
