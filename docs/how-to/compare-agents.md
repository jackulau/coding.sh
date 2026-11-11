# Compare two agents on your repo

Turn a real task into a checked eval, snapshot two agent setups, and run both on it with a paired
comparison.

`coding.sh compare` runs two agent setups on the same tasks from your repo, several times each, in
fresh copies of the repo, and grades every run with the task's own test. The examples use a checkout
of coding.sh; use your own repo the same way. To compare two versions of an agent you built (a
prompt, a model, a tool), use [experiments](https://coding.sh/docs/experiments) instead.

## Before you start

- Both agents are installed and logged in, for example Claude Code and Codex. `compare` drives
  agents that have a headless mode; others fail with `unsupported_agent`.
- coding.sh is set up (`coding.sh init`), so every run is captured as a session.
- The repo has a test command that fails before the work and passes after it.

## 1. Make a few eval tasks

A task is a repo state, an instruction, and a command that passes only when the work is done. The
quickest way to get one: the next time a test fails, hand the fix to an agent under
`coding.sh run --`, which snapshots the repo before and after.

```sh
cd coding.sh
coding.sh run -- claude -p 'Fix the failing test in packages/coding.sh/test/cli/output.test.ts'
coding.sh eval new latest --name output-test-fix \
  --verifier 'node --no-warnings --test packages/coding.sh/test/cli/output.test.ts' \
  --hidden-test 'packages/coding.sh/test/cli/output.test.ts'
coding.sh eval validate output-test-fix --k 3
```

`eval validate` checks that the verifier fails on the untouched repo and passes on the session's
diff 3 times out of 3. `compare` uses only validated tasks. Five to ten tasks is a reasonable
start. [Turn failed runs into evals](session-to-eval.md) has the details.

## 2. Snapshot each agent's setup

```sh
coding.sh harness snapshot --agent claude-code --name claude --model claude-sonnet-4-5
coding.sh harness snapshot --agent codex --name codex --model gpt-5
coding.sh harness list
```

A snapshot (a bundle) records the agent, the model and the files the agent reads: AGENTS.md, its
own instructions file, settings, skills, hooks and MCP config, in the project and in your home.
`--dir` snapshots another project.

## 3. Run both on every validated task

```sh
coding.sh compare claude codex --k 3 --gate
```

Each task runs 3 times per agent. It asks before it starts; pass `--yes` in scripts. The report
gives each arm's pass rate with a 95% interval, the tasks where they differ, the first step where
the two agents' traces diverge, and the experiment id.

| Flag | Default | What it does |
|---|---|---|
| `--k` | 1 | Attempts per task and arm. Use 3 or more before you trust a difference. |
| `-t`, `--task` | all validated | Only these tasks. Repeatable. |
| `--tag` | none | Every task with this tag, drafts included. |
| `--max-cost` | none | Starts no new run once agent and judge spend reach this. |
| `--gate` | off | Prints Ship it, Hold or Don't ship, and exits 0 only on Ship it. |

## 4. Read the result

| You see | It means | Do this |
|---|---|---|
| `Ship it: B wins N tasks, loses M` | B fixed enough tasks without breaking what A solved. With no losses it takes 8 wins. | Switch to B. |
| `Hold: not enough evidence (…)` | Too few tasks changed outcome to tell. | Add tasks, or raise `--k`. |
| `Don't ship: B breaks N tasks A solved` | B lost tasks A got right; they are listed. | Open those runs in `coding.sh ui`. |
| Runs marked errored or infrastructure | Those runs have no outcome and are left out. | `compare claude codex --experiment <id> --retry-errors` |

A pass that edited, deleted or skipped tests counts as a fail. How the gate weighs wins against
breaks: [Gate a change in CI](https://coding.sh/docs/harness-evals#gate).

## 5. Look again without re-running

```sh
coding.sh compare claude codex --experiment <experiment-id>
coding.sh compare claude codex --experiment <experiment-id> --json
```

Every run is also a captured session, so `coding.sh sessions` and `coding.sh ui` show what each
agent did. An agent can read the results with the MCP tool `harness_compare`.

## Other comparisons

| Question | Command |
|---|---|
| Is the cheaper setup as good? | `compare claude claude-haiku --k 3 --promote`: exits 0 when B is better, or cheaper within 10 points of A's pass rate. |
| Does a skill help? | `compare claude --without .claude/skills/pdf --k 3`: B is A without that path. With `--gate` it reads Keep it or Drop it. |
| Does a Claude Code plugin help? | `compare claude --with plugin:terse --k 3`: B is A plus the plugin. Your own config is not changed. |
| Same agent, two models? | Snapshot it twice with different `--model` values. `--gateway` routes both arms through an [LLM gateway](https://coding.sh/docs/ai-gateway). |
| Does B break one group of tasks? | Tag tasks with `eval new --tag suite:<name>` and add `--by suite:`. One group's Don't ship blocks. |
| One rule or skill added or removed? | The report adds an item gate that counts only tasks where the item reached the agent. `--item-gate` makes it the exit code. |

## If something goes wrong

| Symptom | Check |
|---|---|
| `unsupported_agent` | That agent has no headless driver in coding.sh. See [Agents](https://coding.sh/docs/agents). |
| No tasks run | `compare` uses validated tasks only. Run `eval validate <task>`, or pass `--tag` for drafts. |
| A note that the agent release differs | The arms ran on different agent versions, so the difference mixes your change with the release. Rerun both together with auto-update off. `--promote` holds. |
| Every run of a task fails in both arms | The task may be broken. Run `coding.sh eval validate <task>` again. |

:::more What else the report shows
- `failures`: each arm's failed runs as bad-run (it passed in another attempt), beyond-arm (only
  the other arm solved it) or unsolved-by-all. Needs `--k 2` or more.
- `variance`: task, arm and run-to-run shares. If run-to-run beats arm, add attempts.
- `own tests`: failed runs by the agent's last own test run. A green one is a silent miss: the
  agent's tests passed and the verifier's did not.
- `tampered passes`: passing runs that edited, deleted or skipped tests, disclosed or stealth.
  Read the stealth ones first.
- `surface`: the bytes of instruction text each setup puts in front of the agent. When B's is
  more than 20% bigger, the notes ask for a clear win, not a tie.
:::

## Next steps

- [Catch a regression in CI](ci-regressions.md): run `compare --gate` on every pull request.
- [Evaluate a skill](evaluate-a-skill.md): whole tasks with and without a skill.
- [compare reference](https://coding.sh/docs/cli/compare): every flag.
