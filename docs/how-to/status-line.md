# Put your cost and flags in the Claude Code status line

Claude Code can show a status line under the prompt. This recipe puts one there that reads from
your stored sessions: the model, how full the context window is, what this session has cost, what
today has cost across all sessions (subagents included, the same spend `coding.sh budget status`
counts), and the worst failure flag coding.sh found in the session so far.

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
Opus 5.5  ·  ctx 62%  ·  $0.0011 session  ·  $0.2867 today
```

`ctx 62%` is how full the session's context window is, from the `context_window.used_percentage`
Claude Code sends. At 85% or more it reads `ctx 87% full`. Without that field there is no `ctx`
part. `--json` has it as `contextPercent`.

The session part shows only for a session coding.sh has stored. For a session id it has not
stored yet, `--json` has `sessionCostUsd: null`. A stored session that cost nothing still shows
`$0.0000 session`.

A session with a failure flag adds it after the costs (`  ·  ! no-verification`). The flag part is
dropped when there is nothing to report. Only real failures show. A tag with a
colon (`gateway:vercel`, `skill:pdf`) and context-only flags (`compaction`, `model:switch`) are
not failures. Among the rest, a defect outranks a risk, which outranks an inefficiency, so the one
most worth your attention is the one you see.

When the ingest the hook starts has been failing, the line adds `! ingest stopped 4h ago` next: the
costs are then as old as that. Then come the [work items](https://coding.sh/docs/cli/work) blocked
on you or failed, over the last 7 days, as `2 need you`; at 0 the part is left out. `--json` has
the count as `needYou`, absent at 0. With every part, the line reads:

```text
Opus 5.5  ·  ctx 62%  ·  $0.0011 session  ·  $0.2867 today  ·  ! no-verification  ·  2 need you
```

The plan windows, the gateway spend and the budget below come after these.

On a Pro, Max or Ultra plan, Claude Code also sends how much of the plan's 5-hour and weekly
windows you have used, and the line ends with them (`  ·  5h 62% 7d 41%`, only the windows Claude
Code sent). coding.sh saves that reading to `quota.json` in its data folder, where
`coding.sh quota` reads it. Some Claude Code versions leave the field out; the line is then
unchanged.

Behind a Claude apps gateway with a spend limit, Claude Code also sends how much of that limit is
spent, and the line adds `spend 63%` after the plan windows. It can pass 100%. `--json` and
`coding.sh quota --json` give it as the window `spend`, with `usedUsd`, `limitUsd` and `period`
when the gateway sent them. `coding.sh quota wait --window spend` waits for it to drop or reset.

With a [spend budget](https://coding.sh/docs/cost#set-a-budget) set (`coding.sh budget set day 20`),
the line ends with the highest budget's share once it passes 80% (`  ·  budget 82%`). `--json`
adds `budget` with its id, percent and `over`. A day budget is read every turn; a week or month
total is reused for up to 60 s (`budget-spend.json` in the data folder). A `--where` budget counts
only when it is a day budget whose query uses session keys, matched against the day's sessions the
line already read; the others are left out of the line.

## If you already have a status line

`install` will not overwrite another tool's status line. It stops and tells you what is there.
Replace it with `--force`, and the old one is recorded so `uninstall` can put it back:

```sh
coding.sh statusline install --force
```

## How it works

Claude Code runs the command every turn with a small JSON object on stdin: the session id, the
model, and more. coding.sh reads it, looks up the session in your local store by that id, and
prints one line. It does no network or git work, and always exits 0, so the status line never
disrupts the agent. Input that is empty or not a JSON object still prints the line from the store
alone: today's cost and the `need you` count. If the store can't be opened it prints nothing, or
only a stopped ingest. Before the first capture, with no store yet, it prints the model, plan usage
and $0 today, and creates no store.

Claude Code closes stdin once it has written the object. If the writer keeps stdin open, coding.sh
stops reading after 1 s and prints from what arrived. In `--json`, costs and percents have at most
4 decimals.

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
