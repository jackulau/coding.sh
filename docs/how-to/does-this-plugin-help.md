# Does this plugin help me?

See what a Claude Code plugin's hooks add to your sessions and what it costs, then run your tasks
with and without it.

A Claude Code plugin adds hooks that put text in the context, skills, agents or MCP servers. This
recipe answers two questions: what the plugin adds to the sessions you already have, and whether it
makes your agent better on your own tasks.

## Before you start

- coding.sh records your Claude Code sessions (`coding.sh init`).
- The plugin is installed, or in a directory.
- A repo under git with a few tasks the agent should solve.

## 1. See what the plugin adds to your sessions

Text a plugin's hooks add to the context (a SessionStart note, a UserPromptSubmit reminder) is
stored with each session, with its source and a size estimate in tokens (characters / 4).

```sh
coding.sh sessions --where hook:plugin:terse      # sessions the plugin's hooks reached
coding.sh sessions --where -hook:plugin:terse     # and those it did not
coding.sh sessions --facets hook                  # sessions per source
coding.sh sessions --where 'hook.tokens>500'      # where hooks added the most
```

`coding.sh show <session>` has a `Hook context` row, and each injected text is on the timeline:

```text
Hook context  4 texts, ~52 tokens: plugin:terse ~29 (2), unknown ~12 (1), settings ~11 (1)
```

| Source | The hook |
|---|---|
| `plugin:<name>` | belongs to an installed plugin |
| `settings` | is in your settings files |
| `plugin` | belongs to a plugin no longer installed, or loaded with `--plugin-dir` |
| `unknown` | was not recorded by Claude Code (UserPromptSubmit hooks, as of Claude Code 2.1.319) |

Scripts and SDK runs differ from sessions at a keyboard, so look at them apart with
`launch:headless` and `launch:interactive`, for example
`coding.sh sessions --where 'hook:plugin:terse launch:interactive'`.

These splits show where the plugin is active and what it costs, not whether it helps: sessions with
and without it differ in more than the plugin. For that, run the same tasks both ways.

## 2. Get tasks to run

Each task is a repo state, an instruction and a verifier command that passes only when the task is
solved. The fastest source is your own failed sessions:

```sh
coding.sh eval init plugin-check --sessions
```

The tasks get the tag `suite:plugin-check`. [Turn failed runs into evals](session-to-eval.md) drafts
and checks tasks one at a time.

## 3. Run with and without the plugin

```sh
coding.sh harness snapshot --agent claude-code --name current
coding.sh compare current --with plugin:terse --tag suite:plugin-check --k 3 --gate --yes
```

B is `current-with-plugin-terse`. Each run gets its own Claude config directory and loads the plugin
with `--plugin-dir` from the run's own home, so your own config is never changed. To measure a
plugin your setup already has, drop it instead: `compare current --without plugin:terse`.

| Flag | Default | What it does |
|---|---|---|
| `--with plugin:NAME` | none | B is A plus this plugin: an installed name, `name@marketplace`, or a directory. |
| `--without plugin:NAME` | none | B is A without it. |
| `--tag` | none | Runs every task with this tag. |
| `--k` | 1 | Attempts per task and arm. |
| `--gate` | off | A ship-or-hold answer; exits 0 only on Ship it. |

## 4. Read the result

The report gives each arm's pass rate with an interval, the paired difference, cost and tokens per
arm, and the gate. A plugin often changes tokens more than the pass rate.

| You see | It means | Do this |
|---|---|---|
| `Ship it` | The plugin won enough tasks without breaking what the agent solved without it. | Keep it. |
| `Hold: not enough evidence` | Too few tasks changed outcome. The `power` line gives the smallest change these tasks could detect. | Add tasks from real failures. |
| `Don't ship` | The plugin broke tasks; they are listed. | Read the failures below. |
| Runs that errored | They have no outcome and are left out. | Rerun with `--experiment <id> --retry-errors`. |

Under the report, `compare` prints the last lines each failed run's verifier printed, redacted, so
you can tell a real miss from a broken task. `--json` has them in `failedRuns[].verifierOutput`.

The tamper check flags runs that edited, skipped or deleted tests. A run that only added test cases
is not flagged, so a plugin that makes the agent write regression tests is not counted against it.

## If something goes wrong

| Symptom | Check |
|---|---|
| No sessions match `hook:plugin:<name>` | The plugin's hooks may add no context, or Claude Code did not record them. Blocking hook output is not counted. |
| Hook token counts look off | They are estimates: characters divided by 4. |
| `eval init --sessions` finds nothing | It needs failed sessions in this repo. See [Turn failed runs into evals](session-to-eval.md). |

## Next steps

- [Does a terse mode save money?](../guides/terse-mode.md): split the cost into output tokens and the
  input a plugin adds.
- [Evaluate a skill](evaluate-a-skill.md): the same test for an Agent Skill.
- [Compare two agents on your repo](compare-agents.md): other things `compare` can test.
