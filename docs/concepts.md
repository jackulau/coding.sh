# Concepts

The words coding.sh uses for your agent's runs and for testing changes, and where you see each one.
Site version: [coding.sh/docs/concepts](https://coding.sh/docs/concepts).

Each run of your agent is a session. A session has turns: a turn starts with a prompt and lasts
until the agent hands control back. A turn has events, such as a prompt, a model call, a tool call
or a file change. When the agent starts a subagent, the subagent's work is a child session.

With OpenTelemetry, one trace becomes one session, and a span becomes an event. Traces that
share a conversation id become turns of one session.

![At the top, one session drawn as two turns, each a row of events (prompt, model call, tool call, file change), with a subagent as a child session. Below, a dataset of cases runs twice, before and after a change; each case is graded and the two runs are compared case by case.](diagram:concepts "A session is made of turns and events. A dataset runs before and after a change, and the two runs are compared.")

## Your agent's runs

### Session

One run of your agent, from the first prompt to the end: a Claude Code conversation, a Codex
thread, one trace from your own agent, or one `coding.sh run -- <command>`.

- In the viewer: a row in the session list, a link to its timeline.
- A session with a failure opens on its first failing step. First failure in the header, or
  `F`, goes back to it.
- A session with no failure opens on its first prompt. A link to a step opens on that step.
- In the CLI: `coding.sh sessions` lists sessions, and `coding.sh show <id>` prints one.
- `stats.prs` lists the PRs it opened, merged, closed or linked.
- [`stats.retrieval`](https://coding.sh/docs/api/read#get-apisessionsid) counts reads and searches.
- `<id>` may be `latest`, a prefix or an `x_` alias; coding.sh prints the shortest id that works.
- Agent is the agent that ran: Claude Code in T3 Code is `claude-code`, host `t3code`.

### Turn

One prompt and everything the agent does until it hands control back to you.

- In the viewer: each turn starts with a Turn N row on the timeline, with the prompt's
  first line and its time into the session.
- In the viewer: `}` and `{` move to the next and previous turn. The strip beside the step list marks
  where each turn starts.
- In the viewer, a session of more than three turns starts with each finished turn folded to one
  row: its prompt, what it did ("read 6 files, 2 edits +40 −12"), tool calls, errors and length.
- A turn with a failure and the last turn stay open. Enter or a click unfolds a turn; Enter or `←`
  on an open turn's row folds it.
- `z` shows every step; the viewer remembers it.
- In the viewer: Chat, beside Steps (or `v`), shows only the prompts and replies, in full.
  It is remembered and kept in the link (`?view=chat`).
- In Chat, `}` and `{` move between prompts, and `j` and `k` between messages.
- In Chat, one line per turn counts its other steps ("4 steps · read 2 files, 1 command") and
  opens Steps at that turn.
- The viewer formats markdown in prompts and replies, such as headings, lists and code. A link
  shows its text and address, HTML shows as written, and Copy text copies the original.
- In the CLI: the `TURNS` column of `coding.sh sessions`, and the turn count in `coding.sh show`.

### Event

One thing that happened in a session: a prompt, a reply, a model call with its tokens and cost, a
tool call with its input and output, or a file change.

- In the viewer: one step on the timeline. Press `e` for the Events list across sessions.
- The viewer shows tool output without terminal escape codes; the stored output keeps them.
- In the CLI: `coding.sh show <id>` prints one line per event, and `coding.sh search` searches
  them.
- The CLI strips escape sequences and control characters from captured text, except in
  `--json`, CSV and JSONL output to a file or pipe.

### Subagent

A child agent that a session started, such as Claude Code's Task tool. Its work is its own
session, linked to its parent.

- In the viewer: subagents fold under their parent in the list, and its page shows the run
  as a tree.
- In the CLI: `coding.sh tree <id>` shows a session's subagents with each part's cost, and
  `coding.sh sessions --subagents` lists them.
- Agents of one workflow run share `parent.workflowId`;
  [`coding.sh work`](reference/cli.md#codingsh-work) shows the run as one item with its phases.

### Flag

A failure pattern coding.sh found in a session, such as `no-verification` when files changed but no
test ran, `api-stall` when rate limits or an overloaded API held the session up, or `llm-error`
when a model call failed and the session never got past it. A flag with a colon, such as
`skill:pdf`, is a tag, not a failure.

Files changed counts each file once, whether an edit tool or a shell command such as
`sed -i` wrote it.

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

### Weights checkpoint

The file a script saved its edited weights to, recorded as one event: the SHA-256 of the file, and
of the file the edits started from. It links an edit's hashes, which cover one tensor, to the
whole-file hash that `coding.sh exp run --weights` records. A session that recorded one has the `weights:checkpoint` tag and lists the hashes in
`stats.weightEdits.checkpoints`.

- In the viewer: a `Saved weights` row on the session page, a `ran in <name>` header link per
  experiment that ran the file, and a session link beside an experiment's weights stamp.
- In the CLI: `coding.sh sessions --where 'weights.checkpoint:58899f90572c*'` finds the session
  that saved a file, and `coding.sh show <id>` prints `checkpoint 58899f90572c ← 0496e5111097`
  and the experiments that ran that file.
- In evals: `coding.sh exp show` and `exp compare` name the session under the experiment's
  `weights` line, with its edits. See
  [Compare an edited model with its base](https://coding.sh/docs/experiments#weights).
- Recorded by the Python SDK's `coding_sh.weights_checkpoint()`, the TypeScript SDK's
  `weightsCheckpoint()`, or any OpenTelemetry SDK as a span named `weights.checkpoint`. You compute
  the hash.

### Cost

What a session's model calls cost, from their token counts and each model's price. A `~` marks an
estimate.

- In the viewer: each session's cost in the list, and cost per day on Explore
  (`g x`).
- In the CLI: `coding.sh usage` shows tokens and cost by agent, model, day, MCP server, skill or
  subagent. See [Track cost](https://coding.sh/docs/cost).
- In the API: [`stats.compactionRefetches`](https://coding.sh/docs/api) counts reads that fetched
  again what a compaction dropped.
- Budgets: `coding.sh budget set` sets a spend limit per day, week or month. See
  [Track cost](https://coding.sh/docs/cost#set-a-budget).
- Plan usage: `coding.sh quota` shows the use of a plan's 5-hour and weekly windows. See
  the [CLI reference](https://coding.sh/docs/cli/quota).

### Alert

A threshold on failure rate, cost, session count, one flag or a score over a recent window. Only a
change of state notifies. See the [CLI reference](https://coding.sh/docs/cli/alert).

## Testing changes

### Case

One input to test, with the answer you expect when you know it.

- In the viewer: open a model call in the playground and choose "Save as case".
- In the CLI: `coding.sh dataset add <name> --case '{"input":"2+2","expected":"4"}'`, or
  `--session <id>` to keep a session's prompt as a case.

### Dataset

A named list of cases. Each change makes a new version, so an experiment records what it ran
on.

- In the viewer: the Experiments page lists each experiment with its dataset and pass rate.
- In the CLI: `coding.sh dataset add`, `dataset import` and `dataset list`.

### Experiment

One run of your task over a dataset, with every case graded. Two experiments are compared case by
case: better, worse or inconclusive.

- In the viewer: Experiments (`g e`). `x` selects two, and `c`
  compares them.
- In the CLI: `coding.sh exp run` makes one, and `coding.sh exp compare` compares two. See
  [Experiments](https://coding.sh/docs/experiments).

### Grader

A check that scores one output: an exact match, a regex, a JSON schema, your own script, or a model.

- In the viewer: an experiment's page shows the pass rate of each grader.
- In the CLI: `--grader` on `coding.sh exp run`, and `coding.sh judge grade` to try one on a single
  output.

### Judge

A grader that asks a model. Trust it only after you check it against your own pass or fail labels.

- In the viewer: mark a session Pass (`p`) or Fail (`f`) on its page. It is a human score; press
  again to clear it.
- In the CLI: `coding.sh judge calibrate` measures how often the judge agrees with human labels. See
  [Judges](https://coding.sh/docs/judges).

### Monitor

A judge rubric or a command that scores each new session once, after it ends. See the
[CLI reference](https://coding.sh/docs/cli/monitor).

## Which one to use

| | Eval suite (`eval run`) | Experiment (`exp run`) | A/B on sessions (`exp ab`) |
|---|---|---|---|
| What runs | Any command, such as your own agent or a coding agent, on each case, checked by graders | Your task, a command or an HTTP endpoint, on each case of a dataset | A model writes the agent's next turn at the moments it went wrong, with and without your edit |
| Built from | `eval init --cases` with a cases file, or `eval init --sessions` from flagged sessions | A dataset | Your recent sessions |
| You get | pass@k for each case. A regression suite exits 1 when a case fails most trials | A pass rate per grader. `exp compare` says better, worse or inconclusive | A ship or hold verdict for your edit |
| Reach for it when | You want the same cases to keep passing, on every machine and in CI | You changed a prompt, a model or a tool in your own agent | You edited AGENTS.md, a rule or a skill and want a check before you commit |

Start with [Evals](https://coding.sh/docs/evals),
[Experiments](https://coding.sh/docs/experiments) or
[Test an AGENTS.md change](https://coding.sh/docs/how-to/test-agents-md-change). The math, from
paired comparisons to pass@k: [How evals are computed](https://coding.sh/docs/eval-methods).
