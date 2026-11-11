# Compare two agents on your repo

Run Claude Code and Codex on the same tasks from your own repo, several times each, and see which
one passes more often. The examples use a checkout of coding.sh; use your own repo the same way.

You need coding.sh, both agents installed and logged in, and a repo with a test command. To
compare two versions of an agent you built (a prompt, a model, a tool), use `coding.sh exp compare`
instead: see [Trace your own agent](trace-your-agent.md#compare-two-versions).

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

`eval validate` checks that the verifier fails on the untouched repo and passes on the session's
diff 3 of 3 times. Only validated tasks are used by `compare`. Five to ten tasks is a reasonable
start. See [Turn a session into an eval](session-to-eval.md).

## 2. Snapshot each agent's setup

```sh
coding.sh harness snapshot --agent claude-code --name claude --model claude-sonnet-4-5
coding.sh harness snapshot --agent codex --name codex --model gpt-5
coding.sh harness list
```

A bundle records the files the agent reads, plus the model. For Claude Code that is `AGENTS.md`
and its own instructions file, `.claude/settings.json`, agents, commands, skills, hooks and
`.mcp.json` in the project, and the same files under `~/.claude`. Pass `--dir` to snapshot another
project.

## 3. Run both on every validated task

```sh
coding.sh compare claude codex --k 3
```

This runs each task 3 times per agent, each in a fresh copy of the repo. It asks before starting;
pass `--yes` in scripts. `--task <id>` picks tasks and `-c` sets how many run at once.

The report shows each arm's pass rate with a 95% Wilson interval, the tasks where they differ, and
the first step where the two agents' traces diverge. It ends with the experiment id.

## 4. Look again without re-running

```sh
coding.sh compare claude codex --experiment <experiment-id>
coding.sh compare claude codex --experiment <experiment-id> --json
```

Every run is also a captured session, so `coding.sh sessions` and `coding.sh ui` show what each agent
did. Agents can read the results with the MCP tool `harness_compare`.

## Ship it or not?

A higher pass rate can still hide tasks B broke. `--gate` gives a yes or no answer, looking only at
tasks where the two arms disagree:

```sh
coding.sh compare claude claude-new --k 3 --gate
```

| Answer | Exit code |
| --- | --- |
| `Ship it: B wins 9 tasks, loses 0` | 0 |
| `Hold: not enough evidence (...)`: too few tasks changed to tell | 1 |
| `Don't ship: B breaks 3 tasks A solved`, with the broken tasks listed | 1 |

With the defaults, B needs at least 8 fixes and no breaks to ship. A pass that edited, deleted or
skipped tests counts as a fail. `--gate` also works with `--experiment`, and `--json` carries it
as `report.gate`.

Tag tasks by suite (`eval new --tag suite:swe`) and add `--by suite:` to gate each suite too. One
suite that B breaks blocks the ship, even when the pooled numbers look fine:

```
gate: Don't ship: B breaks 3 of 4 suite:swt tasks A solved
      abstain (stratum-regression) · 12 won, 3 lost of 40 solved (7.5%) · net +9 at λ=1 · p = 0.018 < α 0.05
      lost: t48, t49, t50
      suite:swe  Ship it: B wins 12 tasks, loses 0
      suite:swt  Don't ship: B breaks 3 tasks A solved
```

| Option | Default | What it sets |
| --- | --- | --- |
| `--lambda` | 2 | How many fixed tasks one broken task cancels |
| `--gate-alpha` | 0.05 | Significance level of the one-sided exact test on the wins |
| `--tau` | 0.10 | The largest share of A's solved tasks B may break |

The method is SAGE (Wang et al., [arXiv 2609.36043](https://arxiv.org/abs/2609.36043)); the rule
in full is in [Harness A/B](../guides/evals.md#harness-ab).

## Cheaper counts too

`--gate` only ships quality wins. A B that passes the same tasks for 40% less is still progress.
`--promote` keeps it:

```sh
coding.sh compare claude claude-haiku --k 3 --promote
```

It prints `pareto: support 0.93 ≥ 0.70 → promote (cost-cut: cost -41% [...], quality +0.0 pp [...])`
or `→ hold`, and exits 0 only on promote. With `--gate` and `--promote` together, exit 0 needs both.

Support is the share of bootstrap draws where B is better (at any cost rise, unless `--eps-c` caps
it), or cheaper while losing at most `--eps-q` of pass rate (default 10 points). Cost is USD per
run, or tokens when fewer than 80% of runs have a price. The method is ParetoSaddler (Qian et al.,
[arXiv 2611.02079](https://arxiv.org/abs/2611.02079)).

## Same agent, same release

Each run records the agent release it ran on. When the two arms ran on different releases, for
example a baseline reused from last week, the report adds an `agent` row and a note:

```text
agent claude-code 2.1.316 ×12          2.1.319 ×12          release differs
note: baseline ran on claude-code 2.1.316 (12 runs), candidate on claude-code 2.1.319 (12 runs); the agent release differs between arms, so the delta mixes your change with the release. Rerun both arms together on one release, with the agent's auto-update off
```

`--gate` prints the same warning, and `--promote` holds whatever the support. When and how the
release is detected: [Agent release](../guides/evals.md#agent-release).

## Does a skill help?

To test one part of a setup, compare a bundle with itself minus that part:

```sh
coding.sh compare claude --without .claude/skills/pdf --k 3
```

B is `claude` without the skill, and the path is also deleted from each task's repo. The same works
for `AGENTS.md`, another instruction file or `.mcp.json`, and `--without` can be repeated. The
report adds `effect of .claude/skills/pdf = A − B: +20.0 pp [...]`, and `--experiment` finds the
derived bundle again.

With `--gate` the line reads
`drop-it gate: Keep it: ...` or `drop-it gate: Drop it: ...`, and only "Drop it" exits 0.

A Claude Code plugin works the other way round:

```sh
coding.sh compare claude --with plugin:terse --k 3
```

B is `claude` plus the installed plugin `terse` (or a directory, `plugin:./my-plugin`). Your Claude
config is not touched. See [Claude Code plugins](../guides/evals.md#claude-code-plugins).

For one rule, skill or context file, the report also prints an item gate, which counts only the
tasks where the item reached the agent's context:

```
item gate k=3 τ=.34 m=2: UNMEASURED · G=0 net 0 runs D=0 fired 0/18 · S=0 tasks
          B removes rule .claude/rules/clock.md (path-scoped)
          never fired in base rollouts; keep
```

| Verdict | Means |
| --- | --- |
| ACCEPT | Accept the removal: the pass rate without the item is at least 80%, or the removal wins 2+ runs |
| REJECT | The removal costs 2+ runs, or breaks a task by more than one run in three |
| UNMEASURED | The item never fired, or the agent passes under 80% of exposed tasks without it |
| UNCOVERED | Neither arm solves the exposed tasks: repair the item or check the tasks |
| KEEP, KILL, RECHECK | The same for an added item; RECHECK prints the command to re-run the tasks that dropped |
| RERUN | The runs can't be scored, for example a run without a captured trace |

Use `--k 3`, and add `--item-gate` to make the verdict set the exit code.

## Why runs failed

With `--k 2` or more, the `failures` row sorts each arm's failed runs, and a `variance` row
follows:

| Kind | Means |
| --- | --- |
| bad-run | The same arm passed this task in another attempt: retries would help |
| beyond-arm | Only the other arm solved the task |
| unsolved-by-all | Neither arm solved it: check the task with `coding.sh eval validate` |
| `variance` | Task, arm and run-to-run shares; if run-to-run beats arm, add attempts |

Other rows look at what the agent did:

| Row | What it tells you |
| --- | --- |
| `own tests` | Failed runs by the agent's last own test run: green, red, stale or none |
| `tampered passes` | Passing runs that edited, deleted or skipped tests: disclosed or stealth |
| `surface` | Bytes of instruction text each bundle puts in front of the agent |

A green `own tests` fail is a silent miss: the agent's tests passed and the verifier's didn't.
Stale means it edited files after its last green run. Read stealth tampered passes first: the
agent changed a test without saying so.

```
surface           1.5 KB (2 files)      2.1 KB (3 files)      +620 B (+40%)
```

`surface` counts instruction files, `SKILL.md` files, agent rules and system prompts, under `~/`
too; `--json` has the sizes per file in `report.surface`. When B's surface is more than 20% bigger
than A's, the notes ask for a success CI above 0, not just a tie: a bigger prompt is paid on every
turn.

## Same agent, two models

Snapshot the same agent twice with different `--model` values. `--gateway` routes both arms
through an LLM gateway with one key and records the billed cost: Vercel AI Gateway by default, or
`--gateway openrouter`, `litellm` or `ramp`. See [LLM gateways](https://coding.sh/docs/ai-gateway).

## Notes

- Both agents need a headless driver. Agents without one fail with `unsupported_agent`.
- With `k = 1`, one lucky run decides a task. Use `--k 3` or more before trusting a difference.
- For prompt-and-answer agents, use datasets and `coding.sh exp` instead: see
  [Catch a regression in CI](ci-regressions.md). Every `compare` flag is on
  [coding.sh compare](https://coding.sh/docs/cli/compare).
