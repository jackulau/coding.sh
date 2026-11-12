# Concepts

The words coding.sh uses for your agent's runs and for testing changes, and where you see each one.
Site version: [coding.sh/docs/concepts](https://coding.sh/docs/concepts).

Each run of your agent is a session. A session has turns: a turn starts with a prompt and lasts
until the agent hands control back. A turn has events, such as a prompt, a model call, a tool call
or a file change. When the agent starts a subagent, the subagent's work is a child session.

If you use OpenTelemetry: one trace becomes one session, and a span becomes an event. Traces that
share a conversation id become turns of one session.

![At the top, one session drawn as two turns, each a row of events (prompt, model call, tool call, file change), with a subagent as a child session. Below, a dataset of cases runs twice, before and after a change; each case is graded and the two runs are compared case by case.](diagram:concepts "A session is made of turns and events. A dataset runs before and after a change, and the two runs are compared.")

## Your agent's runs

### Session

One run of your agent, from the first prompt to the end: a Claude Code conversation, a Codex
thread, one trace from your own agent, or one `coding.sh run -- <command>`.

- In the viewer: a row in the session list. Click it to open its timeline.
- In the CLI: `coding.sh sessions` lists sessions, and `coding.sh show <id>` prints one.

### Turn

One prompt and everything the agent does until it hands control back to you.

- In the viewer: on the session timeline, each turn starts with a row labeled Turn 1, Turn 2 and so
  on.
- In the CLI: the `TURNS` column of `coding.sh sessions`, and the turn count in `coding.sh show`.

### Event

One thing that happened in a session: a prompt, a reply, a model call with its tokens and cost, a
tool call with its input and output, or a file change.

- In the viewer: one step on the timeline. Press `e` for the Events list, which shows
  events across sessions.
- In the CLI: `coding.sh show <id>` prints one line per event, and `coding.sh search` finds text in
  them.

### Subagent

A child agent that a session started, such as Claude Code's Task tool. Its work is stored as its
own session, linked to its parent.

- In the viewer: subagents fold under their parent in the session list, and the parent's page shows
  the whole run as a tree.
- In the CLI: `coding.sh tree <id>` shows the run with what each part cost, and
  `coding.sh sessions --subagents` lists them.

### Flag

A failure pattern coding.sh found in a session, such as `no-verification` when files changed but no
test ran. A flag with a colon, such as `skill:pdf`, is a tag, not a failure.

- In the viewer: a row shows its first flag and a count of the rest, the session page shows them
  all, and a ⚑ marks the step where a long run went off the rails.
- In the CLI: `coding.sh sessions --flag <name>` lists the sessions that have it, and
  `coding.sh improve` ranks them.

Every flag and what sets it: [Flags and derails](https://coding.sh/docs/query#flags-and-derails).

### Weight edit

A change a script made to a model's weights, recorded as one event: the tensor's name and shape,
how many weights changed, the size of the change, and the hash of the tensor before and after. A
session that recorded one has the `weights:edited` tag and counts its edits in `stats.weightEdits`.

- In the viewer: each edit is a row on the session page, and the header counts them.
- In the CLI: `coding.sh sessions --flag weights:edited` lists the sessions, and
  `coding.sh show <id>` prints one line per edit.
- Recorded by the Python SDK's `coding_sh.weights_edit()`, the TypeScript SDK's `weightsEdit()`,
  or any OpenTelemetry SDK as a span named `weights.edit`. The fields are in the
  [API reference](https://coding.sh/docs/api).

### Cost

What a session's model calls cost, from their token counts and each model's price. A `~` marks an
estimate.

- In the viewer: the cost of each session in the list, and cost per day on Explore
  (`g x`).
- In the CLI: `coding.sh usage` shows tokens and cost by agent, model or day. See
  [Track cost](https://coding.sh/docs/cost).

## Testing changes

### Case

One input to test, with the answer you expect when you know it.

- In the viewer: open a model call in the playground and choose "Save as case".
- In the CLI: `coding.sh dataset add <name> --case '{"input":"2+2","expected":"4"}'`, or
  `--session <id>` to keep a session's prompt as a case.

### Dataset

A named list of cases. Each change makes a new version, so an experiment records exactly what it ran
on.

- In the viewer: the Experiments page lists each experiment with its dataset and pass rate.
- In the CLI: `coding.sh dataset add`, `dataset import` and `dataset list`.

### Experiment

One run of your task over a dataset, with every case graded. Two experiments are compared case by
case, and the result is better, worse or inconclusive.

- In the viewer: Experiments (`g e`). Select two with `x` and press
  `c` to compare them.
- In the CLI: `coding.sh exp run` makes one, and `coding.sh exp compare` compares two. See
  [Experiments](https://coding.sh/docs/experiments).

### Grader

A check that scores one output: an exact match, a regex, a JSON schema, your own script, or a model.

- In the viewer: an experiment's page shows the pass rate of each grader.
- In the CLI: `--grader` on `coding.sh exp run`, and `coding.sh judge grade` to try one on a single
  output.

### Judge

A grader that asks a model. Trust it only after you check it against your own pass or fail labels.

- In the viewer: mark a session Pass (`p`) or Fail (`f`) on its page. That
  label is stored as a human score.
- In the CLI: `coding.sh judge calibrate` measures how often the judge agrees with human labels. See
  [Judges](https://coding.sh/docs/judges).

## Which one to use

| | Eval suite (`eval run`) | Experiment (`exp run`) | A/B on sessions (`exp ab`) |
|---|---|---|---|
| What runs | Any command, such as your own agent or a coding agent, on each case, checked by graders | Your task, a command or an HTTP endpoint, on each case of a dataset | A model writes the agent's next turn at the moments it went wrong, with and without your edit |
| Built from | `eval init --cases` with a cases file, or `eval init --sessions` from flagged sessions | A dataset | Your recent sessions |
| You get | pass@k for each case. A regression suite exits 1 when a case fails most trials | A pass rate per grader. `exp compare` says better, worse or inconclusive | A ship or hold verdict for your edit |
| Reach for it when | You want the same cases to keep passing, on every machine and in CI | You changed a prompt, a model or a tool in your own agent | You edited AGENTS.md, a rule or a skill and want a check before you commit |

Start with [Evals](https://coding.sh/docs/evals),
[Experiments](https://coding.sh/docs/experiments) or
[Test an AGENTS.md change](https://coding.sh/docs/how-to/test-agents-md-change). How the numbers
are computed, from paired comparisons to pass@k: [How evals are computed](https://coding.sh/docs/eval-methods).
