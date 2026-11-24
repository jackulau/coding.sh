# Compare models on your own sessions

Put the models you used side by side on your own sessions: how often you pushed back or stopped a
turn, how long a turn took, and how often edits and shell commands failed. Every row shows its
counts and a 95% interval.

```sh
coding.sh stats --scorecard --since 90d
```

The scorecard reads the sessions coding.sh already captured and runs nothing. Each model did its
own tasks, so a difference can come from the task mix. To settle it, run both models on the same
tasks ([below](#run-two-models-on-the-same-tasks)).

## Before you start

- coding.sh is set up (`coding.sh init`) and has captured sessions from more than one model.
- After an update, coding.sh folds your stored sessions again in the background, so sessions from
  before the update get these counts too.

## 1. Print the scorecard

```sh
coding.sh stats --scorecard --since 90d
```

```text
MEASURE                model-a        model-b         DIFFERENCE
Turns                  64             41
  sessions             3              2
Pushback (4 kinds)     17.2% (10/58)  32.4% (12/37)   no clear difference
  95% CI               9.6% to 28.9%  19.6% to 48.5%  -2.1 to +33.0pp
  sessions             3              2
Pushback: intent       3.4% (2/58)    2.7% (1/37)     no clear difference
  95% CI               1.0% to 11.7%  0.5% to 13.8%   -9.3 to +10.7pp
Pushback: undo         5.2% (3/58)    0.0% (0/37)     no clear difference
  95% CI               1.8% to 14.1%  0.0% to 9.4%    -14.1 to +4.8pp
Pushback: redo         1.7% (1/58)    5.4% (2/37)     no clear difference
  95% CI               0.3% to 9.1%   1.5% to 17.7%   -4.7 to +16.1pp
Pushback: broken       6.9% (4/58)    24.3% (9/37)    +17.4pp
  95% CI               2.7% to 16.4%  13.4% to 40.1%  +2.9 to +33.8pp
Cancelled turns        4.7% (3/64)    2.4% (1/41)     no clear difference
  95% CI               1.6% to 12.9%  0.4% to 12.6%   -10.7 to +8.4pp
  sessions             3              2
Median turn            39s (64)       1m08s (41)      +29s
  95% CI               32s to 48s     43s to 1m39s    +1.7s to +1m01s
  quartiles            25s to 1m02s   40s to 2m10s
  sessions             3              2
Failed file edits      7.6% (10/132)  15.7% (11/70)   no clear difference
  95% CI               4.2% to 13.4%  9.0% to 26.0%   -0.7 to +19.0pp
  sessions             4              2
Failed shell commands  6.7% (14/210)  14.6% (23/158)  +7.9pp
  95% CI               4.0% to 10.9%  9.9% to 20.9%   +1.6 to +14.8pp
  sessions             3              3
  DIFFERENCE is model-b minus model-a: percentage points for a rate, time for the median. Where its 95% interval includes 0 it says no clear difference.
  Turn rows count the 5 top-level sessions launched interactively, not 1 subagent session and 1 headless session. Edit and shell rows count the calls of all 7 sessions, each under its own model.
  The intervals treat each turn and each call as independent. Turns of one session are alike, so the real uncertainty is larger.
  The models did different tasks, so a difference can come from the task mix. coding.sh compare runs two of them on the same tasks: https://coding.sh/docs/how-to/compare-models
```

Each model gets a column, the one with the most turns first. Under a measure, `95% CI` gives its
95% interval and `sessions` the sessions it read. `-` means the column has nothing to count for
that row.

| Row | What it counts |
|---|---|
| Turns | Your prompts, each with the agent's work until your next one. A turn counts under the model that made most of its model calls, or the session's model when it made none. |
| Pushback (4 kinds) | Of the turns you answered with a prompt, the ones whose prompt names one of the four kinds below. |
| Pushback: intent | The agent did something else: "not what I meant", "that's wrong", "you edited the wrong file". |
| Pushback: undo | Take the work out: "undo that", "revert your changes", "take that out". |
| Pushback: redo | Do it again: "try again", "retry", "start over", "I don't like it". |
| Pushback: broken | The work does not work: "still failing", "that didn't work", "now the tests fail", "same error". |
| Cancelled turns | The turns you stopped, out of the turns whose capture records a stopped turn ([below](#what-each-row-reads)). |
| Median turn | How long a turn ran, from your prompt to the end of its last work, with the quartiles. It has an interval from 6 turns on. |
| Failed file edits | File edit calls that failed, out of all of them. |
| Failed shell commands | Shell commands that failed, out of all of them. |

A prompt takes the first kind it matches, so the four kinds add up to Pushback (4 kinds). The row
counts only these kinds. Other corrections, such as "no, use the other helper" or "you forgot the
docs", do not count. "No problem", "wait for the build" and "actually, also add a test" are not
pushback.

## 2. Read the result

- A rate shows the percent, then the counts: `17.2% (10/58)` is 10 of 58 turns.
- With exactly two columns, DIFFERENCE is the second minus the first: percentage points for a rate,
  time for the median.
- Where the difference's 95% interval includes 0, DIFFERENCE says `no clear difference`. In the
  example, model-b has more broken pushback, longer turns and more failed shell commands.
- With three or more columns there is no DIFFERENCE column. When a `--where` can keep just the
  first two, a next step prints the command, with your window and query kept.
- The scorecard names no winner, and counting rows does not give one. Pushback and its kinds count
  the same prompts, and with many rows one can look clear by chance.

## What each row reads

- Turns, pushback, cancelled turns and the median turn count only top-level sessions launched
  interactively. A headless prompt is no person's reaction, and a subagent's prompt comes from its
  parent.
- File edits and shell commands count the calls of every session, subagents and headless runs
  included, each under its session's model.
- A failed call counts only when it failed for real. A search that found nothing, a probe such as
  `test -f`, a `diff` that found differences and a call you stopped are not failures.
- Cancelled turns count only turns whose capture records a stopped turn: the captures of
  `claude-code`, `codex`, `opencode`, `cursor` and `pi`. A column with only other turns says
  `not recorded`, never 0.
- A thread built from T3 Code's own store records no stopped turns, whatever agent ran it.
- A `claude-code` stop is a prompt's text. Its turns record no stops when the prompt has no text
  (`capture.mode = "metadata"`) or came from its OpenTelemetry export.
- The notes under the table say which sessions and turns a row left out.

## Narrow it down

| Flag | What it does |
|---|---|
| `--by agent` | One column per agent instead of per model. |
| `--since`, `--until` | The window. `--since` defaults to 30 days. |
| `--where 'repo:my-app'` | Only the sessions a query matches, here one repo's. |
| `--where 'model:a OR model:b'` | Only sessions whose main model is `a` or `b`, for a DIFFERENCE column. A turn another model ran in them still gets its own column. |
| `--json` | The same counts and intervals as JSON. |

## Limits

- The models did different tasks. A model you keep for hard tasks shows more pushback, however it
  does on easy ones.
- The intervals treat each turn and each call as independent. Turns of one session are alike, so
  the real uncertainty is larger.
- Tiny counts can still read as clear: 0 of 4 against 1 of 1 gives +100.0pp, with an interval of
  +6.7 to +100.0pp. Check the counts before you trust a difference.
- Pushback is read from the words of your next prompt, its first 400 characters. Other corrections,
  such as "you forgot the docs" or "no, use the other helper", name no kind and do not count. A
  model whose misses draw those words scores better than one whose misses draw "still failing".
- A prompt about work outside the agent's last turn, such as "roll back the prod deploy to v1.2",
  names no kind. The kinds come from matching words, so some prompts are still read wrong.
- A turn's time includes the time it waited on you, such as at a permission prompt.
- Each session keeps up to 500 turn times per model.
- With `capture.mode = "metadata"` no prompt text is stored, so there are no pushback rows. An
  agent's prompt then reads as yours and adds a turn, and so does a `claude-code` stop.

## Run two models on the same tasks

`coding.sh compare` runs two setups on the same validated tasks from your repo and grades every run
with the task's own test. Snapshot one agent twice, with a different model each time:

```sh
coding.sh harness snapshot --agent <agent> --name model-a --model <model-a>
coding.sh harness snapshot --agent <agent> --name model-b --model <model-b>
coding.sh compare model-a model-b --k 3
```

[Compare two agents on your repo](compare-agents.md) shows how to make the tasks and read the
report.

## Next steps

- [Track cost and tokens](track-cost.md): what each model spent.
- [Compare two agents on your repo](compare-agents.md): two setups on the same tasks, graded.
- [stats reference](https://coding.sh/docs/cli/stats): every flag.
