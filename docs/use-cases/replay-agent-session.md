# Replay an agent session step by step

Replay any AI agent's session one step at a time: each prompt, reply and tool call, with the
command output and the diff each step made. Built from the agent's own records; nothing is re-run.

coding.sh replays a captured session from what the agent recorded: each prompt, reply and tool
call, with its output and the diff it made. Nothing is re-run and no model is called. It works for
any agent coding.sh captures: Claude Code, Codex, OpenCode, Cursor, an SDK app and the rest.

## Replay a session

Find a session, then list its steps:

```sh
coding.sh sessions --since 7d
coding.sh replay ses_b32e
```

```text
Fix the Antigravity adapter's session title
5 steps, 1 file touched

1  prompt             Fix the Antigravity adapter's session title
2  read     ✓  300ms  read src/adapters/more/antigravity.ts
3  edit     ✓  300ms  edit src/adapters/more/antigravity.ts
4  shell    ✓   6.0s  $ npm test -- test/adapters/antigravity.test.ts
5  reply              Sessions now take their title from the first prompt, falling back to Antigravity's summary.

Files
  M src/adapters/more/antigravity.ts  1 change, last touched at step 3
```

A session id can be a unique prefix of 4 or more characters, or `latest`. To find a session by what
was said in it, use `coding.sh search "rate limit"`.

## Read one step

```sh
coding.sh replay ses_b32e --step 3
```

```text
Step 3 of 5  edit (edit)  ✓  300ms
edit src/adapters/more/antigravity.ts

Changes (1)
--- a/src/adapters/more/antigravity.ts
+++ b/src/adapters/more/antigravity.ts
@@ -1,1 +1,1 @@
-title: str(meta.summary),
+title: makeTitle(str(meta.firstPrompt) ?? str(meta.summary)),
  The diff above is the change as the agent recorded it, without the whole file around it.
```

A shell step shows the command, its exit code and its output. For files and ranges:

| Command | Shows |
|---|---|
| `replay <id> --step 12` | What step 12 did: command, exit code, output, diff |
| `replay <id> --step 12 --file src/app.ts` | That file as it was after step 12 |
| `replay <id> --step 5 --to 12` | What steps 5 to 12 changed, per file |
| `replay <id> --json` | The same, as one JSON document |

All options: [coding.sh replay](https://coding.sh/docs/cli/replay).

## Replay it in the viewer

`coding.sh ui` opens the viewer on 127.0.0.1. On a session page, the Replay button (or R) plays the
session back.

![The replay pane on an edit step, with the step's diff and the files touched so far](shot:docs/replay-diff "Replay in coding.sh ui: one step's diff")

| Key | Does |
|---|---|
| Space | Play and pause |
| Arrow keys, j, k | Step |
| s | Change the speed |
| Esc | Leave |

A scrubber jumps anywhere, with marks on edits and failures. The pane has three tabs: this step's
diff, a file as of this step, and what changed since an earlier step. The address ends in
`?step=N`, so a copied link opens that step.

## How files are rebuilt

File content comes from the agent's own tool calls. A full write or a full read sets a file, and
edits (Edit, MultiEdit, `str_replace`, `apply_patch` hunks) then apply in order. A file a step
created did not exist before that step.

Claude Code records each file before an Edit or Write, so its files are known from their first
edit. A session recorded with `coding.sh run -- <cmd>` starts from a snapshot of the working tree.

## What it does not do

- It does not re-run commands or call the model.
- A file edited before any step showed all of it reads as unknown, with the reason, until a later
  read or write. The step then shows the agent's own diff instead of a guess.
- A shell command that changes files (`sed -i`, `rm`) changes them in the replay only when the
  agent recorded the change.

To send one step's model call again with a changed instructions file, see
[Fork from a step](https://coding.sh/docs/explore#fork-from-a-step). That is the one command that
calls a model.

## Questions

### Which agents can I replay?

Any captured session. History import (`coding.sh ingest --backfill`) works for Claude Code, Codex,
OpenCode, Cursor CLI, the Antigravity CLI, Gemini CLI, GitHub Copilot CLI, Factory Droid, Goose, Pi
and T3 Code. Amp, SDK apps and commands wrapped with `coding.sh run` are recorded from install on.

### Can my agent read an old session itself?

Yes. The MCP server's `session_replay` tool returns the same as `coding.sh replay`: the steps, one
step with `step` (and a file with `file`), or a range with `from` and `to`.

### Can I watch a session while it runs?

`coding.sh show latest --follow` prints new events as they arrive. In the viewer, a running
session's page adds new events every 4 seconds.

### Where is the history stored?

In `~/.coding.sh`: a SQLite index and a blob store for large payloads. Keys and tokens are redacted
before anything is written.

## Next steps

- [Find and read runs](https://coding.sh/docs/explore#replay-a-session): the viewer, long sessions
  and subagents.
- [Turn failed runs into evals](https://coding.sh/docs/how-to/session-to-eval): keep a session
  you replayed as a test.
- [Agents](https://coding.sh/docs/agents): what each agent records.
