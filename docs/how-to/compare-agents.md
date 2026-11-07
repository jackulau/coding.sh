# Compare two agents on your repo

Run Claude Code and Codex on the same tasks from your own repo, several times each, and see which
one passes more often. The examples use a checkout of coding.sh; use your own repo the same way.

You need: coding.sh installed, both agents installed and logged in, and a repo with a test command.

This recipe is for coding agents. To compare two versions of an agent you built (a prompt, a model,
a tool), run each over a dataset and use `coding.sh exp compare`; see
[Trace your own agent](trace-your-agent.md#compare-two-versions).

## 1. Make a few eval tasks

A task is a repo state, an instruction and a command that passes only when the work is done. The
quickest way to get one: the next time a test is failing, hand the fix to an agent under
`coding.sh run --`, which snapshots the repo before and after:

```sh
cd coding.sh
coding.sh run -- claude -p 'Fix the failing test in packages/coding.sh/test/cli/output.test.ts'
coding.sh eval new latest --name output-test-fix \
  --verifier 'node --no-warnings --test packages/coding.sh/test/cli/output.test.ts' \
  --hidden-test 'packages/coding.sh/test/cli/output.test.ts'
coding.sh eval validate output-test-fix --k 3
```

`eval validate` runs the verifier on the untouched repo (it must fail) and on the session's diff
(it must pass 3 of 3 times). Only validated tasks are used by `compare`. Repeat for a handful of
tasks; five to ten is a reasonable start. See [Turn a session into an eval](session-to-eval.md).

## 2. Snapshot each agent's setup

```sh
coding.sh harness snapshot --agent claude-code --name claude --model claude-sonnet-4-5
coding.sh harness snapshot --agent codex --name codex --model gpt-5
coding.sh harness list
```

A bundle records the files the agent reads, plus the model. For Claude Code that is `CLAUDE.md`,
`.claude/settings.json`, agents, commands, skills, hooks and `.mcp.json` in the project, and the same
files under `~/.claude`. Pass `--dir` to snapshot another project.

## 3. Run both on every validated task

```sh
coding.sh compare claude codex --k 3
```

This runs each task 3 times per agent in a fresh copy of the repo, so `2 arms x 3 x tasks` agent
sessions. It asks before starting; pass `--yes` in scripts. Use `--task <id>` to pick tasks and
`-c` to set how many run at once.

The report shows each arm's pass rate with a 95% Wilson interval, the tasks where they differ, and
the first step where the two agents' traces diverge. It ends with the experiment id.

## 4. Look again without re-running

```sh
coding.sh compare claude codex --experiment <experiment-id>
coding.sh compare claude codex --experiment <experiment-id> --json
```

Every run is also a captured session, so `coding.sh sessions` and `coding.sh ui` show what each agent
did.

## Does a skill help?

To test one part of a setup, compare a bundle with itself minus that part:

```sh
coding.sh compare claude --without .claude/skills/pdf --k 3
```

B is `claude` without the skill. The path is also deleted from each task's repo, so the agent can't
find a copy there. The same works for `AGENTS.md`, `CLAUDE.md` or `.mcp.json`, and `--without` can
be repeated. The report adds a line like `effect of .claude/skills/pdf = A − B: +20.0 pp [...]`.
The derived bundle is stored, so `--experiment` finds it again.

## Why runs failed

With `--k 2` or more, the report counts each arm's failed runs:

- **bad-run**: the same arm passed this task in another attempt. Retries would help.
- **beyond-arm**: only the other arm solved the task.
- **unsolved-by-all**: neither arm solved it. Check the task with `coding.sh eval validate`.

A `variance` row splits the outcome variance into task, arm and run-to-run shares. If run-to-run is
bigger than arm, add attempts before reading much into the difference.

Cost, token and turn values show `(3/10)` when only some runs reported them. The "X% cheaper" note
only appears when each arm has a known cost for at least 80% of its runs.

## Same agent, two models

To compare models rather than agents, snapshot the same agent twice with different `--model`
values. If you use Vercel AI Gateway, `--gateway` routes both arms through it with one key
(`AI_GATEWAY_API_KEY`) and records billed cost. See [AI Gateway](https://coding.sh/docs/ai-gateway).

## Notes

- Both agents need a headless driver. Agents without one fail with `unsupported_agent`.
- With `k = 1`, one lucky run decides a task. Use `--k 3` or more before trusting a difference.
- For prompt-and-answer agents rather than repo edits, use datasets and `coding.sh exp` instead:
  see [Catch a regression in CI](ci-regressions.md).
