# Does this plugin help me?

You installed a Claude Code plugin, or you are about to. It adds hooks that put text in the
context, skills, agents or MCP servers. Does it make your agent better at your work, and what does
it cost in tokens? This recipe answers both: first from the sessions you already have, then with a
paired A/B on your own tasks.

You need: coding.sh capturing your Claude Code sessions (`coding.sh init`), the plugin installed
or in a directory, and a repo under git with a few tasks the agent should solve.

## 1. See what the plugin adds to your sessions

Text a plugin's hooks add to the context (a SessionStart note, a UserPromptSubmit reminder) is
stored with each session, with its source and an estimate of its size in tokens (characters / 4).
List the sessions the plugin's hooks reached, and those it did not:

```sh
coding.sh sessions --where hook:plugin:terse
coding.sh sessions --where -hook:plugin:terse
```

Count sessions per source, and find the sessions where hooks added the most:

```sh
coding.sh sessions --facets hook
coding.sh sessions --where 'hook.tokens>500'
```

`coding.sh show <session>` has a `Hook context` row with the total and the split by source, and
each injected text on the timeline:

```text
Hook context  4 texts, ~52 tokens: plugin:terse ~29 (2), unknown ~12 (1), settings ~11 (1)
```

The source is `plugin:<name>` when the hook's command belongs to an installed plugin,
`settings` for a hook in your settings files, `plugin` for a plugin hook whose plugin is not
installed any more (or was loaded with `--plugin-dir`), and `unknown` when Claude Code did not
record which hook it was (UserPromptSubmit hooks, as of Claude Code 2.1.319).

Scripts and SDK runs (`claude -p`, the Agent SDKs) differ from sessions at a keyboard, so look at
them apart. `launch:headless` and `launch:interactive` split them:

```sh
coding.sh sessions --where 'hook:plugin:terse launch:interactive'
coding.sh sessions --facets launch
```

These splits show where the plugin is active and what it costs, not whether it helps: sessions
with and without it differ in more than the plugin. For that, run the same tasks both ways.

## 2. Get tasks to run

Each task is a repo state, an instruction and a verifier command that passes only when the task is
solved. The fastest source is your own failed sessions:

```sh
coding.sh eval init plugin-check --sessions
```

The tasks are stored with the tag `suite:plugin-check`. [Turn a session into an eval](session-to-eval.md)
covers drafting and checking tasks one at a time.

## 3. Run with and without the plugin

Snapshot your current setup as a harness bundle, then compare it with the same bundle plus the
plugin:

```sh
coding.sh harness snapshot --agent claude-code --name current
coding.sh compare current --with plugin:terse --tag suite:plugin-check --k 3 --gate --yes
```

B is `current-with-plugin-terse`. Each run gets its own Claude config directory, and the plugin
is loaded with `--plugin-dir` from the run's own home, so your `~/.claude` is never changed. To
measure a plugin your bundle already carries, drop it instead: `compare current --without
plugin:terse`. Details: [Claude Code plugins](../guides/evals.md#claude-code-plugins).

The report gives each arm's pass rate with an interval, the paired difference, cost and tokens per
arm, and with `--gate` a ship-or-hold answer. A plugin often changes tokens more than the pass rate;
both are in the report.

## 4. Read the failures

Under the report, `compare` prints the last lines each failed run's verifier printed, redacted, so
you can tell a real miss from a broken task without running it again. `--json` lists every failed
run in `failedRuns` with its `verifierOutput`. See
[Verifier output](../guides/evals.md#verifier-output).

The tamper check flags runs that edited, skipped or deleted tests. A run that only added new test
cases to an existing test file is not flagged, and its `tamper.addedTests` names those files, so a
plugin that makes the agent write regression tests is not counted against it.

For a terse-output plugin, [Does a terse mode save money?](../guides/terse-mode.md) splits the cost
into output tokens and the input the plugin adds, and compares it with a one-line rule.

## What this does not tell you

- The token count of hook text is an estimate, characters divided by 4.
- A plugin's hooks show up in sessions only when Claude Code records their output. Hook output
  that blocks a tool call is not counted.
- A comparison on a handful of tasks shows only large effects. The report's `power` line gives
  the smallest difference the comparison could detect; grow the task set from real failures when
  the gate says "Hold: not enough evidence".
