# Put your cost and flags in the Claude Code status line

Claude Code can show a status line under the prompt. This recipe puts one there that reads from
your stored sessions: the model, what this session has cost, what today has cost across all
sessions, and the worst failure flag coding.sh found in the session so far.

You need: coding.sh capturing your Claude Code sessions (`coding.sh init`), and coding.sh on your
`PATH` (a global install, `npm i -g coding.sh`).

## Install it

```sh
coding.sh statusline install
```

This writes a `statusLine` block into your Claude Code `settings.json`:

```json
"statusLine": { "type": "command", "command": "coding.sh statusline", "padding": 0 }
```

Claude Code shows the line on the next turn. It looks like this:

```text
Opus 5.5  ·  $0.0011 session  ·  $0.2867 today
```

A session with a failure flag adds it at the end (`  ·  ! no-verification`). The flag part is
dropped when there is nothing to report. Only real failures show. A tag with a
colon (`gateway:vercel`, `skill:pdf`) and context-only flags (`compaction`, `model:switch`) are
not failures. Among the rest, a defect outranks a risk, which outranks an inefficiency, so the one
most worth your attention is the one you see.

## If you already have a status line

`install` will not overwrite another tool's status line. It stops and tells you what is there.
Replace it with `--force`, and the old one is recorded so `uninstall` can put it back:

```sh
coding.sh statusline install --force
```

## How it works

Claude Code runs the command every turn with a small JSON object on stdin: the session id, the
model, and more. coding.sh reads it, looks up the session in your local store by that id, and
prints one line. It does no network or git work, and if the store is missing or the input is
unexpected it prints nothing and exits 0, so the status line never disrupts the agent.

Print the line yourself to see it, or pass `--json` for the parts:

```sh
echo '{"session_id":"<id>","model":{"display_name":"Opus 5.5"}}' | coding.sh statusline
echo '{"session_id":"<id>"}' | coding.sh statusline --json
```

## Remove it

```sh
coding.sh statusline uninstall
```

This restores your `settings.json` as it was before `install`, byte-for-byte, including a status
line you had before, or deleting the file if `install` created it. It only touches a status line
that is coding.sh's; another tool's is left alone.
