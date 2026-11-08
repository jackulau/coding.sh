# Build evals from your agent's failures

The best eval cases for a coding agent are the tasks it already got wrong. coding.sh records your
agent's sessions, flags the ones that went wrong, and turns them into an eval suite in your repo:
one task per session, starting from the repo as it was, with your command as the check.

## How it works

```sh
curl -fsSL https://coding.sh/install | sh      # capture sessions for a week or two first
coding.sh sessions --where is:flagged          # the sessions that went wrong
coding.sh eval init --sessions --verifier 'npm test'
coding.sh eval run failures --yes
```

`eval init --sessions` takes up to 10 failed or flagged sessions from this repo in the last 14 days
and writes a suite to `evals/failures/`. Each task has the repo as it was before the session, the
session's first prompt as the instruction, and your verifier. `--session <id>` picks sessions
yourself. `--since` and `--limit` change the window.

`eval run` runs the agent 3 times per task and reports pass@1, pass@k, pass^k and flaky tasks. The
report links the captured session of a failed trial, so you can read what happened.

## What marks a session as a failure

Flags are found on every ingest. Some of them:

- `premature-completion`: the agent stopped while the last test run was failing.
- `no-verification`: files changed, but no test, type check, lint or build ran.
- `repeated-tool-failure`: the same tool failed three times in a row with similar input.
- `test-tamper`: the agent edited a test in a way that hides failures.
- `looping`, `failure-streak`, `churn`, `stalled`: a long run went off the rails.

[Concepts](../concepts.md) has the full list and what each one checks.

## Make the task fair

A failed session's diff is not a correct answer. It is saved as a near miss that the verifier must
fail. Add a correct fix as `reference.patch` in the task's directory, load it, and validate:

```sh
coding.sh eval import evals/failures/tasks/<task>
coding.sh eval validate <task> --k 5
```

`eval validate` checks that doing nothing fails, the reference passes 5 of 5 runs, near misses
fail, and hidden test content does not leak to the agent. A task that passes is marked
`validated`. One that fails stays a draft, and the output says why.

## One session at a time

```sh
coding.sh eval new latest --verifier 'npm test' --hidden-test 'test/output.test.ts'
```

Test files that match `--hidden-test` are kept out of the agent's view and copied in only when the
verifier runs. For agents that don't edit a repo, `coding.sh dataset add <name> --session <id>`
keeps the session's first prompt as a dataset case, graded by a judge or your own command.

## What it does not do

- It does not write the correct fix. A task without `reference.patch` runs, but is listed as having
  no reference solution.
- Session tasks start from snapshots on this machine, so they run here, not in CI. For CI, use a
  dataset of cases and `exp compare`.
- Flags are heuristics. Read the session before you keep its task.

## Questions

### Does it work for my own agent, not just Claude Code or Codex?

Yes, as a dataset case. Sessions sent over OpenTelemetry or the SDK keep their first prompt as
input, and a `command` or `http` task runs your agent on each case.

### How do I catch a regression on every pull request?

Run the same cases on the base branch and on the PR with `coding.sh exp run`, then
`coding.sh exp compare base head`. Its JSON lists the cases that passed on base and fail on the PR.
[Catch a regression in CI](../how-to/ci-regressions.md) has the workflow.

### Can my agent build the suite?

Yes. The MCP server has `eval_init` and `eval_from_session` tools. `eval_from_session` asks you
first.

### How many tasks do I need?

The report notes suites under 20 tasks: a small suite only shows large changes. Grow it toward 20
to 50 tasks from real failures.

## Next

- [Turn a real session into an eval](../how-to/session-to-eval.md)
- [Evals and comparisons](../guides/evals.md)
- [Catch a regression in CI](../how-to/ci-regressions.md)
- [Concepts](../concepts.md)
