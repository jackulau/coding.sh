# Replay a Claude Code or Codex session step by step

coding.sh keeps a searchable history of your Claude Code and Codex sessions, and of other coding
agents, and replays any of them one step at a time: each prompt, reply and tool call, with the
command output and the diff each step made. It runs locally, from the agent's own records. Nothing
is re-run.

## How it works

Install coding.sh. The installer sets up capture hooks for the agents it finds, so new sessions are
recorded from then on. Sessions from before you installed live in the agents' own files: Claude
Code's `projects/<slug>/<session>.jsonl` transcripts and Codex's `sessions/**/rollout-*.jsonl`
rollouts. Import them once:

```sh
curl -fsSL https://coding.sh/install | sh
coding.sh ingest --backfill --since 30d
```

Find a session, then replay it:

```sh
coding.sh sessions --agent codex --since 7d     # or --agent claude-code
coding.sh search "rate limit"                   # full-text search over prompts, replies and tool calls
coding.sh replay <session>                      # the steps, and the files they touched
coding.sh replay <session> --step 12            # what step 12 did: command, exit code, output, diff
coding.sh replay <session> --step 12 --file src/app.ts   # that file as it was after step 12
coding.sh replay <session> --step 5 --to 12     # what steps 5 to 12 changed, per file
```

A session id can be a unique prefix of 4 or more characters, or `latest`.

## In the viewer

`coding.sh ui` opens the viewer on 127.0.0.1. On a session page, the Replay button (or R) plays
the session back. Space plays and pauses, the arrow keys or j and k step, s changes the speed and
Esc leaves. A scrubber jumps anywhere, with marks on edits and failures. The pane shows the step,
the files touched so far, and three tabs: the diff this step made, a file as of this step, and what
changed since an earlier step. The address ends in `?step=N`, so a copied link opens the replay at
that step.

For a timeline rather than a replay, `coding.sh show <session>` prints turns, tool calls,
subagents and latency. A long session shows one line per phase (start, each resume, each
compaction), and `--all` lists every event.

## How files are rebuilt

File content comes from the agent's own tool calls. A full write or a full read sets a file. Claude
Code records each file before an Edit or Write, so its files are known from their first edit. A file
a step created did not exist before that step. Edits (Edit, MultiEdit, `str_replace`, `apply_patch`
hunks) then apply in order. A session recorded with `coding.sh run -- <cmd>` starts from a snapshot
of the working tree.

## What it does not do

- It does not re-run commands or call the model. It shows what was recorded. `--fork` is the
  exception: for a session captured through the proxy, it sends a step's model call again with a
  changed AGENTS.md or another instruction file (see [Fork from a step](../guides/explore.md#fork-from-a-step)).
- A file edited before any step showed all of it reads as unknown, with the reason, until a later
  read or write. The step then shows the agent's own diff instead of a guess.
- A shell command that changes files (`sed -i`, `rm`) changes them in the replay only when the
  agent recorded the change.

## Questions

### Which agents can I replay?

Any captured session. History import works for Claude Code, Codex, OpenCode, Cursor CLI, the
Antigravity CLI, Gemini CLI, GitHub Copilot CLI, Factory Droid, Goose, Pi and T3 Code. Amp and
commands wrapped with `coding.sh run` are recorded from install on.

### Can my agent read an old session itself?

Yes. `coding.sh init` registers an MCP server with Claude Code, Codex, Cursor and OpenCode. Its
`session_replay` tool returns the same as `coding.sh replay`: the steps, one step with `step` (and
a file with `file`), or a range with `from` and `to`.

### Can I watch a session while it runs?

`coding.sh show latest --follow` prints new events as the hooks write them. In the viewer, a
running session's page adds new events every 4 seconds.

### Where is the history stored?

In `~/.coding.sh`: a SQLite index and a blob store for large payloads. Redaction of keys and tokens
runs before anything is written.

## Next

- [Explore sessions](../guides/explore.md#replay): replay, the viewer, long sessions and the MCP
  tools in full.
- [Agents and OpenTelemetry](../guides/agents.md): what each agent records and how.
- [Turn a real session into an eval](../how-to/session-to-eval.md): keep a session you replayed as
  a test.
