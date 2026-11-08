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

Agents can read the results too: the MCP tool `harness_compare` lists these experiments, newest
first, and with an experiment id returns its report: pass rates, the ship gate (`by` gates each task
group), the item gate and the own-tests split.

## Ship it or not?

A higher pass rate can still hide tasks B broke. Add `--gate` for a yes or no answer:

```sh
coding.sh compare claude claude-new --k 3 --gate
```

It looks only at tasks where the two arms disagree (by majority over the attempts) and prints one of:

- `Ship it: B wins 9 tasks, loses 0`. Exit code 0.
- `Hold: not enough evidence (...)`. B may be better, but too few tasks changed to tell. Exit code 1.
- `Don't ship: B breaks 3 tasks A solved`. Exit code 1. The broken tasks are listed below.

The line under it has the numbers. One broken task cancels two fixed ones (`--lambda`, default 2),
the wins must clear a one-sided exact test at `--gate-alpha` (default 0.05), and B may break at most
`--tau` (default 10%) of the tasks A solved. With the defaults, B needs at least 8 fixes and no
breaks to ship. A B pass that edited, deleted or skipped tests counts as a fail for the gate. The
method is SAGE (Wang et al., [arXiv 2609.36043](https://arxiv.org/abs/2609.36043)).

`--gate` also works with `--experiment`, and `--json` carries it as `report.gate`. Without `--gate`,
the report and the exit code are unchanged.

If your tasks come from several suites, tag them (`eval new --tag suite:swe`) and add `--by suite:`.
The gate then also runs per suite and prints one line each; one suite that B breaks blocks the
ship even when the pooled numbers look fine:

```
gate: Don't ship: B breaks 3 of 4 suite:swt tasks A solved
      abstain (stratum-regression) · 12 won, 3 lost of 40 solved (7.5%) · net +9 at λ=1 · p = 0.018 < α 0.05
      lost: t48, t49, t50
      suite:swe  Ship it: B wins 12 tasks, loses 0
      suite:swt  Don't ship: B breaks 3 tasks A solved
```

## Cheaper counts too

`--gate` only ships quality wins. A B that passes the same tasks for 40% less is still progress. Add
`--promote` to keep it:

```sh
coding.sh compare claude claude-haiku --k 3 --promote
```

It prints `pareto: support 0.93 ≥ 0.70 → promote (cost-cut: cost -41% [...], quality +0.0 pp [...])`
or `→ hold`, and exits 0 only on promote. Support is the share of bootstrap draws where B is better
without costing more than `--eps-c` (default: any cost), or cheaper while losing at most `--eps-q`
of pass rate (default 0.1, so 10 points). Cost is USD per run, or tokens when fewer than 80% of runs
have a price. Use `--k 3`: with one attempt per task the support comes from resampling tasks only.
The method is ParetoSaddler (Qian et al., [arXiv 2611.02079](https://arxiv.org/abs/2611.02079)).
With `--gate` and `--promote` together, exit 0 needs both to pass.

## Same agent, same release

Agents update often, and a release can change the agent's own instructions and tools. Each run
records the agent release it started on (the adapter's detected version, checked at most once a
minute; a captured session's own version wins). When the two arms ran on different releases, for
example a baseline reused from last week, the report adds an `agent` row and a note:

```text
agent claude-code 2.1.316 ×12          2.1.319 ×12          release differs
note: baseline ran on claude-code 2.1.316 (12 runs), candidate on claude-code 2.1.319 (12 runs); the agent release differs between arms, so the delta mixes your change with the release. Rerun both arms together on one release, with the agent's auto-update off
```

`--gate` prints the same warning under its answer, and `--promote` holds whatever the support
(`pareto.refused` is `release_confound` in `--json`, and it exits 1). When the release changed
mid-comparison in both arms alike, a softer note names the releases and the tasks that ran on more
than one. `--json` carries `report.agentVersions`: runs per release per arm, runs with no known
release, those split tasks and `confound` (`arms-differ` or `mixed`). There is no note when under
half of an arm's runs have a known release, or when the arms run different agents.

## Does a skill help?

To test one part of a setup, compare a bundle with itself minus that part:

```sh
coding.sh compare claude --without .claude/skills/pdf --k 3
```

B is `claude` without the skill. The path is also deleted from each task's repo, so the agent can't
find a copy there. The same works for `AGENTS.md`, `CLAUDE.md` or `.mcp.json`, and `--without` can
be repeated. The report adds a line like `effect of .claude/skills/pdf = A − B: +20.0 pp [...]`.
The derived bundle is stored, so `--experiment` finds it again. With `--gate` the line reads
`drop-it gate: Keep it: ...` or `drop-it gate: Drop it: ...`, and only "Drop it" exits 0.

A Claude Code plugin works the same way the other way round:

```sh
coding.sh compare claude --with plugin:caveman --k 3
```

B is `claude` plus the installed plugin `caveman` (or a plugin directory, `plugin:./my-plugin`),
stored as `claude-with-plugin-caveman`. Each B run loads the plugin with `--plugin-dir` from the
run's own home; your Claude config is not touched. `--without plugin:<name>` drops a plugin a
bundle carries. See [Claude Code plugins](../guides/evals.md#claude-code-plugins).

For one rule, skill or context file, the report also prints an item gate, which counts only the tasks
where the item reached the agent's context:

```
item gate k=3 τ=.34 m=2: UNMEASURED · G=0 net 0 runs D=0 fired 0/18 · S=0 tasks
          B removes rule .claude/rules/clock.md (path-scoped)
          never fired in base rollouts; keep
```

A removal reads ACCEPT, REJECT (it costs 2+ runs, or breaks a task by more than one run in three),
UNMEASURED (the item never fired, or the agent passes less than 80% of the exposed tasks without it)
or UNCOVERED (neither arm solves the exposed tasks: repair the item or check the tasks). ACCEPT needs
a pass rate of at least 80% without the item, or a removal that wins 2+ runs, shown as `U=` on the first line next to `A=`, the rate
with it. Comparing a bundle with one added
item gives KEEP, KILL or RECHECK, which prints the command to re-run the tasks that dropped. RERUN
means the runs can't be scored, for example a run without a captured trace. Use `--k 3`, and add
`--item-gate` to make the verdict set the exit code.

## Why runs failed

With `--k 2` or more, the report counts each arm's failed runs:

- **bad-run**: the same arm passed this task in another attempt. Retries would help.
- **beyond-arm**: only the other arm solved the task.
- **unsolved-by-all**: neither arm solved it. Check the task with `coding.sh eval validate`.

A `variance` row splits the outcome variance into task, arm and run-to-run shares. If run-to-run is
bigger than arm, add attempts before reading much into the difference.

An `own tests` row splits failed runs by the agent's own last test run: `A fails 12: own tests green
7 (58%), red 3, stale 1, none 1`. Green fails are silent misses: the agent's tests passed, the
verifier's didn't, so its tests checked what it wrote rather than what was asked. Stale means it
edited files after its last green run.

A `tampered passes` row appears when a passing run edited, deleted or skipped tests or the
verifier's files: `B 3: disclosed 2, stealth 1`. Each pass gets a line naming the run, the file and
the tool call that changed it, with what the agent said. Disclosed means it said it was changing the
test (`the test expecting 5 is wrong; update the expected value`). Stealth means it didn't. Read the
stealth ones first.

A `surface` row shows the bytes of instruction text each bundle puts in front of the agent:
`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `SKILL.md` files, Claude Code, Cursor and Copilot rules, and
Pi or Prime system prompts, under `~/` too:

```
surface           1.5 KB (2 files)      2.1 KB (3 files)      +620 B (+40%)
```

Those bytes are paid on every turn. When B's surface is more than 20% bigger than A's, the notes say
`instruction surface +40%: require a success CI above 0, not just non-inferiority`: a bigger prompt
that only ties is a cost with no gain. `--json` has the sizes per file in `report.surface`.

Cost, token and turn values show `(3/10)` when only some runs reported them. The "X% cheaper" note
only appears when each arm has a known cost for at least 80% of its runs.

## Same agent, two models

To compare models rather than agents, snapshot the same agent twice with different `--model`
values. If you use a gateway, `--gateway` routes both arms through it with one key and records billed
cost: `--gateway` for Vercel AI Gateway (`AI_GATEWAY_API_KEY`), or `--gateway openrouter`, `litellm` or
`ramp`. See [LLM gateways](https://coding.sh/docs/ai-gateway).

## Notes

- Both agents need a headless driver. Agents without one fail with `unsupported_agent`.
- With `k = 1`, one lucky run decides a task. Use `--k 3` or more before trusting a difference.
- For prompt-and-answer agents rather than repo edits, use datasets and `coding.sh exp` instead:
  see [Catch a regression in CI](ci-regressions.md). `coding.sh exp compare A B --gate` gives the
  same ship-or-hold answer per case.
