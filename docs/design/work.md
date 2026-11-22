# Work tracking

Design for the first version of `coding.sh work`. It answers one question for a person who runs
10 to 100 agent tasks at once: what needs me now, and what is the next step?

Status: built, except the items under "Later". The code is `packages/coding.sh/src/core/waiting.ts`
(the fold stat), `src/core/work.ts` (items and the queue), `src/core/work-overlay.ts` (acks and
snoozes) and `src/cli/commands/work.ts` (the command). The user docs are
the CLI reference ([`coding.sh work`](../reference/cli.md#codingsh-work)), the API reference (`stats.waiting`, `GET /api/work`)
and the viewer guide ([Open the viewer](../guides/explore.md#open-the-viewer)).

## Why sessions are the right base

A task board needs someone to file and update tickets. Agents start and finish work faster than
anyone files tickets, and most of their work never gets one. A chat thread or one orchestrator bot
shows one agent's view. coding.sh already stores every session from every agent on the machine,
with parent links for subagents and workflow runs, stall and failure flags, permission prompts
from agents whose hooks report them, and how each agent was launched (`stats.launch`). Work items
are derived from those sessions on read. Nothing is filed.

## Work items

- A work item is a root session plus every session linked to it by parent: subagents, forks and
  workflow agents. A workflow that starts 45 agents is one item.
- A child that a harness or host starts for a separate task (`codex exec` from an orchestrator, a
  T3 Code thread) is its own item. Its row names the item that started it. A long-lived
  orchestrator does not swallow every task it starts.
- The first version does not group by branch. The stored branch is the branch a session started
  on, so a session that runs `git checkout -b` stays on main, and long-lived branches such as
  `dev` would join unrelated work.
- An item's id is `w` plus the first 6 hex characters of a hash of its root session id, so it stays
  the same between reads.
- When a child's parent is not stored (a workflow agent whose root transcript is missing), the
  children group under the parent's id. The item's id does not change when the root arrives.
- Items are built in `src/core/work.ts`. Everything there is pure except the store read.

## Waiting state

One new fold stat, `Session.stats.waiting` (`src/core/waiting.ts`), records what a session is
waiting on. It is optional and absent when nothing waits:

```ts
waiting?: { kind: "permission" | "question" | "plan" | "turn"; at: number; toolUseId?: string; text?: string };
```

- `at` is the event time in ms, like other stats. `work --json` and the MCP `status` tool give it
  as an ISO string.
- `permission`: a live hook notification of type `permission_prompt` (Claude Code, and Devin CLI's
  `PermissionRequest` hook) or `ToolPermission` (Gemini CLI), or one whose text matches
  `PERMISSION_TEXT` (`src/core/unapproved.ts`). An `idle_prompt` notification never counts. The
  wait names the last open call on the notification's thread, or else the last open call anywhere,
  since a hook notification may not name the subagent. When the prompt names its tool (Devin CLI's
  prompts do) and a call of that tool is open, the wait names that tool's last open call. A call
  that starts a subagent (`Agent`, `Task`, `spawn_agent`, `invoke_agent`, `run_subagent`) is
  never the call a prompt is about. `waiting.ts` and `unapproved.ts` share that list (`SPAWN_TOOL`).
  With no open call (Gemini CLI sends its notification before the call starts) the wait has no
  `toolUseId`. Devin's calls have no ids, so the wait keeps the tool of the call it names, and
  only a call of that tool ending clears it. Transcript notifications never set it.
- `question`: an open call of a question tool (`QUESTION_TOOL` in the same file).
- A request a host app's store reports open: T3 Code's pending approvals (`permission`) and
  questions (`question`). The adapter reads them from T3's runtime requests and their
  `approval_request` and `user_input_request` items, and emits a notification with a `requestId`,
  its kind, its tool when it has one, and its prompt or first question as `text`. A request kind
  T3 does not put to the user (a provider's own tool call, a sign-in refresh) is skipped. The
  notification counts in a backfill too, since the store holds current state. The wait names no
  call. It clears when the store reports the request resolved, expired or cancelled (a
  `request_resolved` notification with the same `requestId`), or on the thread's next
  `tool.start` or prompt.
- `plan`: an open plan-approval call (`ExitPlanMode`).
- `turn`: the main thread's turn ended. The fold keeps it for every session, and the stat shows it
  only for a session launched interactively (`stats.launch`). Today only Claude Code and Codex
  report a launch. Claude Code sends an `idle_prompt` notification after every turn end, so that
  notification does not set it. A turn end does not replace an open prompt.
- A wait clears on its own thread only: the open call's `tool.end`, or a `tool.start`, a
  `user.message` the harness did not inject, or a `session.end` on that thread. A subagent's end
  clears only a wait on that subagent's thread. Events from sibling subagents and usage summaries
  leave it.
- A transcript's quiet marker (a `session.end` with reason `idle`) clears a turn wait but not an
  open prompt. A prompt left open in a terminal stays blocked, and the queue shows its age.
- A hook and a transcript can both report one call. It is open once, and a copy of its start that
  arrives after its end opens nothing.
- `text` is redacted, its whitespace collapsed, and it is cut to 300 characters before it is
  stored. Age rules apply on read, not in the fold.
- It bumps `SESSION_FOLD_VERSION`, so stored sessions are folded again.

Agents whose hooks send no permission signal (Codex, Cursor, OpenCode) never set `permission`.
Their waits show up as stalls, and the queue says so. A thread T3 Code runs reports its prompts
through T3's store, whichever agent it runs.

## The queue

`coding.sh work` prints one row per item, in this order:

1. **Blocked on you**: a session in the item waits on a permission, a question or a plan. Oldest
   first.
2. **Failed**: no session in the item is running or waiting, and its main session ended on API
   errors (the `api-stall` flag, shown as "api 529") or with failing tests. Items that failed on
   one API cause are also counted as a group ("api 529 x4"). Newest first.
3. **Stalled**: a session in the item has no end, waits on nothing, and has been quiet for the
   derail stall threshold (15 minutes) or longer. For agents that report no prompts, the row says
   it may be waiting on approval. Oldest first.
4. **Your turn**: the main session waits for the next prompt (`waiting.kind` is `turn`). Oldest
   first.
5. **Ready for review**: no session in the item is running or waiting, and the item changed files.
   Grouped by repo and branch, newest first.

A session is running when it has no end and was active in the last 30 minutes, or when its end is
only its last event seen (`stats.endInferred`) and that event is under 15 minutes old. A session
whose events stop on a tool call with no result, with no session end, has no end.

An item shows the most urgent cause it has that is not acknowledged. A wait or a stall older than
12 hours gets a "probably closed" badge, and its next step offers the resume command or an ack,
since a closed terminal may send no session end.

The agents that report prompts are Claude Code, Gemini CLI, Devin CLI and T3 Code. The header names the other agents
in view. Items with nothing to act on are hidden, with a reason: running, done, acknowledged or
snoozed. `--all` shows them. Every row carries a reason and a next step.

The queue reads the sessions that started inside `--since` (default 7 days), plus the stored
parents of those whose parent started earlier, up to 500 lookups. It reads at most 20,000 sessions
and says so when it left older ones out. `--agent` keeps items with a session from that agent.
`--repo` keeps items whose main session ran under that path, or in a repo or folder with that name.

## Stages and kinds

Each item also has a stage: planning, executing, review, approval or done. A bucket is what a
person must do now, and an item with nothing to do has none. A stage is where the work is, and
every item has one, hidden items too. So a person can see the shape of all the work at once, or
list every item that waits for approval, while the buckets stay a to-do list.

The stage comes from the item's sessions and the causes the queue already found, with no extra
store read (`workStage` in `src/core/work.ts`). The first rule that matches wins:

1. **approval**: a session in the item waits on a permission, a question or a plan. An ack does
   not change it, since the agent still waits.
2. **executing** or **planning**: a session in the item is running or stalled and waits on
   nothing. It is executing once a session changed a file or ran tests (`testsPassed` or
   `testsFailed` is set), and planning before that.
3. **review**: nothing runs, and the item has a failed, your-turn or ready-for-review cause the
   person has not acknowledged. Those causes are the queue's own: the main session ended on API
   errors or failing tests, waits for the next prompt, or the item changed files.
4. **done**: everything else, including an item whose failed, your-turn and review causes were
   all acknowledged.

A snooze does not change the stage. A session that waits for the next prompt counts as stopped
here, though the queue may still count it as running.

The kind is `change` once a session in the item changed a file, and `research` when the item is
in review or done without a changed file. An item that still plans or executes with no changed file
has no kind yet.

`stageWhy` gives the evidence in one line of at most 80 characters: "waits 2m for permission: …",
"running 8m, no file changed yet", "quiet 20m, changed 1 file", "tests: 2 failed, stopped 4m ago",
"changed 3 files, stopped 12m ago", or "acknowledged: changed 3 files, stopped 12m ago". The
running time counts from the item's first session; a stalled item says how long it has been quiet.

## Acknowledging and snoozing

`<CODING_SH_HOME>/work.json` (`src/core/work-overlay.ts`) holds acks and snoozes, keyed by member
session ids and joined per item, so an item keeps them when its root falls out of the time window.
An ack covers one cause: its fingerprint is the bucket, the session and the wait's tool call id or
time, so acknowledging one prompt does not hide the next. Acking the top cause shows the next one.
A snooze is stored on the item's main session and on the session behind its cause, with the bucket
the item was in. It ends at its time, or sooner when the item moves to a more urgent bucket. The
file is written to a temp file and renamed. A missing or corrupt file reads as empty. Each write
drops expired snoozes and keeps at most 20 acks per session and 5,000 sessions.

## Surfaces

- `coding.sh work [--all] [--stage <list>] [--repo <path>] [--agent <name>] [--since 7d] [--limit 20] [--json]`.
  It runs the same automatic ingest as other reads first, so a fresh prompt shows up. The header
  gives the count of items per stage, and each row its stage and kind. `--json` gives each item's
  `stage`, `kind` (when known) and `stageWhy`, and `stages`, the count per stage over every item in
  the window, hidden ones included. `--stage review,approval` lists only the items in those stages,
  hidden ones too, so `--stage done` lists the done items the queue hides. An unknown stage exits 2
  and names the stage it is closest to.
- `coding.sh work show <id>`: the decision packet. What the item is doing, what it waits on (the
  redacted prompt text), for how long, its cost, the files it changed, its child sessions, and the
  next step: the agent and folder to answer in while it runs, or the resume command once it ended.
  It also prints the stage, the kind and the evidence for the stage.
  A session that ran in a folder under its repo, on a branch other than the one the sessions at the
  repo root had nearest in time, ran in a worktree nested in the repo: the item's repo is that
  folder, so Where names it and the review step runs `git -C <folder> diff`. When an item wrote
  files both inside and outside its folder, every path in the list is absolute.
  The id is an item id or the id of any session in the item. A session outside the window is
  still found by its id. An unknown id exits 1.
- `coding.sh work ack <id>` and `coding.sh work snooze <id> <duration>`. A bad duration exits 2.
- `coding.sh status` gets a Work line with the count per bucket, and its JSON a `work` field with
  the counts and `needYou`.
- The statusline adds "N need you" when items are blocked on you or failed, and its JSON a
  `needYou` field. On every render it first reads new hook events, for at most 400 ms and not while
  another ingest holds the lock, then the 7-day window.
- The local viewer's Work page (`#/work`, `src/viewer/work.ts`, the tab after Sessions) reads the
  queue through `GET /api/work`, which builds it with `readWorkQueue` and `workJson` like the
  command, so its items equal `work --json` for the same store and filters. The agent, repo, since,
  stage and `all` filters live in the URL; `stage` filters as `--stage` does. Each item shows its
  stage and kind as chips with `stageWhy` as their title, and the header counts the stages. A server
  that sends no `stages` gets no chips and no stage filter. Ack and snooze buttons post to `/api/work/ack` and
  `/api/work/snooze`, which write `work.json` by the command's rules. Only `coding.sh ui` serves
  it; `coding.sh serve` answers 404.
- The MCP `status` tool gets a `work` field, so an agent can read the queue without a new tool:
  the counts, `needYou`, and the first 5 items as `work --json` gives them, over the same 7-day
  window, with acks and snoozes applied. `more` counts the items left out, and `rest` names
  `coding.sh work --json`, which lists them. The tool stays
  read-only: ack and snooze stay with the user.

The new stats and fields are optional. One existing field changed: a session whose events stop on a
tool call with no result, with no session end, has no `endedAt`.

## Cost

The measurement used a synthetic store of 5,000 sessions started over 7 days (one in five a root,
the rest its subagents), on a Windows laptop, with the built CLI. `work --json` took 250 to 285 ms
end to end, against about 100 ms for `--help`. Reading the sessions took 40 to 50 ms of that, and
building the queue 15 to 30 ms. The statusline pays about 55 to 75 ms more on each render for the
queue, plus up to 400 ms when new hook events wait to be read.

## Later

T3 Code's secret and link requests (`secret_request` and `link_request` items),
which are not read yet; a reply path for hook protocols that accept one; branch grouping with merge, split and name;
done by a check command; budgets; cloud agents; dependencies between items; notifications.

## Tests

- `test/cli/work.test.ts`: the recorded workflow fixture `test/fixtures/workflows/claude-code-running`
  gives one item, keyed by its missing root. It also runs `--json`, `show`, `ack` and `snooze` on a
  seeded store, and checks that an unknown id exits 1 and a bad duration is a usage error.
- `test/core/waiting.test.ts`: the Claude Code subagents fixture with a permission prompt spliced
  in mid-run stays blocked across the subagent's `subagent.end`, and clears on the open call's
  `tool.end`. The Gemini CLI hook fixture's `ToolPermission` notification blocks. `idle_prompt`
  never sets a wait, a turn wait needs an interactive launch, and the text is redacted. For Devin
  CLI, whose calls have no ids, a prompt stays while another tool's call or an open `run_subagent`
  ends, and clears when its own call ends. An open `invoke_agent` (or any other spawn tool) is
  never the call a prompt names. A host request blocks in a backfill and clears on its own
  resolution only, even when the resolution sorts first.
- `test/adapters/t3code.test.ts`: a T3 store with an approval and a question still pending gives
  a `permission` and a `question` wait with their text. `work --json` shows both threads blocked
  on you, and once T3 resolves the approval (its runtime request row alone changes) the thread is
  no longer blocked.
- `test/core/work.test.ts`: with two prompts in a row, acknowledging the first leaves the second in
  the queue. An agent with no prompt signal falls to stalled with the approval hint, and Devin CLI
  and a T3 Code thread do not. It also covers
  bucket order, API groups, harness and host children, snoozes, and a corrupt overlay. For stages
  it has one test per rule, and checks that an acked blocked item stays approval, an acked review
  item becomes done, a snoozed review item stays review, a failed item with no change is review
  with kind research, and the stage counts include hidden items.
- `test/cli/work.test.ts` also checks that `work --stage executing --json` lists only the running
  item that changed a file, that `--stage done` lists hidden items, and that `--stage reveiw` exits
  2 and suggests `review`.
- `test/viewer/work.test.ts`: `GET /api/work` returns the items `work --json` returns for the same
  seeded store and filters, and an ack or snooze posted to the viewer is one the command sees.
  `test/viewer/work-browser.test.ts` drives the page in headless Chrome.
- The permission prompts in these tests, and the T3 store rows, are synthetic. The `scripts/e2e` captures run with
  permissions bypassed, so no real prompt has been recorded yet.
