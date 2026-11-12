# A/B a Claude Code plugin

This example measures what one Claude Code plugin changes: pass rate, tokens, cost, wall time,
reply length and how clear the replies are. It runs plain Claude Code ("base") and Claude Code
with the plugin ("plugin") on the same ten tasks, `k` times each, in a container, with
`coding.sh compare`.

We used it to test a popular terse-output plugin. You can point it at any plugin directory.
`demo-plugin/` is a small one to try the method on: a SessionStart hook that asks for short
replies.

## Run it

You need Docker, Node 22.16 or newer, and a model credential in a file only you can read: a line
`CLAUDE_CODE_OAUTH_TOKEN=…` with the token `claude setup-token` prints, or
`ANTHROPIC_API_KEY=…`.

```sh
chmod 600 ab.env
examples/plugin-ab/run.sh ~/plugin-ab-out --plugin examples/plugin-ab/demo-plugin --env-file ab.env
```

For your own plugin, pass its root, the directory that holds `.claude-plugin/plugin.json`.

The container sees only the output directory and the credential. No `~/.claude` goes in. Each
run gets a throwaway `CLAUDE_CONFIG_DIR` built from its arm.

| Variable | Default | What it does |
|---|---|---|
| `K` | `3` | Runs per task and arm |
| `C` | `4` | Runs in parallel |
| `MODEL` | `claude-opus-5-5` | The agent's model, both arms |
| `MAX_COST` | `40` | USD cap on agent runs; no new run starts past it |
| `JUDGE` | `1` | `0` skips the clarity judge |
| `JUDGE_MODEL` | `claude-sonnet-5-5` | The judge's model |
| `MARKER` | | Text the plugin injects. The analysis counts the runs whose stream shows it, to check the plugin reached its arm only |
| `ONLY` | | One task, for example `ab-c1-paginate`, for a smoke run |
| `CLAUDE_CODE_VERSION` | `2.1.319` | Claude Code release installed in the image |

At `K=3` that is 60 agent runs. With the demo plugin and the defaults, expect a few US dollars per
arm; read `agent spend` in `compare.txt` after a smoke run before sizing a bigger one. Judge calls
run after the comparison and are not counted in `MAX_COST`.

## How the plugin gets in

A harness bundle has no plugin slot yet, so `build-arms.mjs` turns the plugin into user-level
files in each run's `CLAUDE_CONFIG_DIR`:

- the plugin directory is copied to `~/.claude/ab-plugin/`;
- its hooks (from `plugin.json` or `hooks/hooks.json`) go into `settings.json`, with
  `CLAUDE_PLUGIN_ROOT` set to that copy;
- its `skills/`, `agents/` and `commands/` are copied into `~/.claude/`.

Bundle files are written without their mode bits, so a hook that runs a `.sh`, `.js` or `.py`
file directly is run through its interpreter. MCP servers and LSP servers are not mapped; the
script prints a note when the plugin has them. Both arms get the same base settings
(`effortLevel: high`), so the plugin is the only difference.

## The tasks

Ten small tasks in `tasks/`, tagged `plugin-ab`, in two suites:

- `suite:code` (6): fix or extend a small Node module. Hidden `node:test` files grade them.
- `suite:explain` (4): review a diff, explain a function, find why a job crashed, fix a test
  that fails in some timezones. `e2-flaky` is graded by running its tests in three timezones;
  the other three by a checklist of facts the answer must state.

`check-tasks.py` checks that each task's starting tree fails its verifier and a reference fix
passes. It needs no agent and no key:

```sh
python3 examples/plugin-ab/check-tasks.py
```

## What you get

In the output directory:

- `compare.txt`: coding.sh's report, with pass rates, the ship gate per suite, cost, tokens and
  time per arm.
- `runs.json`: one row per run, from coding.sh's store.
- `answers/`: each run's final reply and Claude Code stream, saved by the verifier.
- `judge.json`: a clarity score per reply (0 to 1), and a verdict per pair of replies to the same
  task and attempt, judged in both orders.
- `summary.txt` and `summary.json`: the paired analysis.

The analysis pairs each base run with the plugin run of the same task and attempt. Each metric
is a mean per run with a 95% interval from a bootstrap that resamples tasks, not runs, 5,000
draws with seed 7: runs of the same task are not independent. Cost is split by token type at list
prices (`PRICES`, USD per million tokens: input, output, cache read, 5-minute cache write, 1-hour
cache write). That split shows where a plugin's cost goes when it shortens output but adds to
every prompt.

To analyze again without rerunning: `python3 examples/plugin-ab/analysis/analyze.py <out-dir>`.
