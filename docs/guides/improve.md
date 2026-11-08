# Improve your agent every week

Your agent makes the same mistakes again and again. coding.sh already records every session. This
guide turns those sessions into one weekly loop:

1. See what goes wrong most.
2. Add the line to CLAUDE.md or AGENTS.md that fixes it.
3. Test the edit on the moments it went wrong (needs an API key), or skip to 4.
4. Commit it.
5. Let new sessions tell you whether it helped, and catch a change that made things worse.

You need coding.sh capturing your agent (`coding.sh init`) for a week or so, and a repo under git.
Run every command from the repo.

## 1. See what to fix first

```sh
coding.sh improve
```

```text
12 sessions in textkit since 14d (claude-code 12)

Fix first
1. Says it is done without running anything to check
   3 of 12 sessions, low 23; latest 28m ago
   e.g. "Make wrap() in src/wrap.js break at word boundaries instead of mid-word."
   Fix: Name the check in CLAUDE.md or AGENTS.md. Add: "Run `npm test` before you say you are done, and say what it printed."
   → See it happen: coding.sh show 36ee2026-fff1-4fd3-aab3-a7d1706f15e0
   → Add the line to CLAUDE.md or AGENTS.md (uncommitted): coding.sh improve fix 1
   → Test the edit on the moments it went wrong (needs ANTHROPIC_API_KEY or OPENAI_API_KEY): coding.sh exp ab --behavior unverified-claim --dry-run
   → Commit it, then check new sessions against it: coding.sh improve check
```

`improve` reads the sessions in this repo from the last 14 days (`--since 30d` for more,
`--repo all` for every repo). It lists two kinds of issue:

- **A failure flag**, such as an agent that says it is done without running anything, or one that
  ends its turn while tests fail without saying so. [concepts.md](../concepts.md) lists the flags.
- **A command or tool that fails the same way in two or more sessions**, such as a broken
  `npm test` or a missing script. When the test command failed before the agent changed any file,
  the issue says so: fix the command first, or the agent can't check its work.

Issues seen in two or more sessions come first. Then the order follows the severity score that
`coding.sh refine` uses. Each issue shows the newest example, what to try, and the commands for the
next steps. `coding.sh show <id>` opens the example. Its header has a `Flags` row.

## 2. Add the line

```sh
coding.sh improve fix 1
```

```text
✓ Added to CLAUDE.md (not committed):
+ Run `npm test` before you say you are done, and say what it printed.
```

`improve fix` appends the issue's line to CLAUDE.md or AGENTS.md: the one the repo has, or, when
it has both, the one the issue's agents read. `--target <file>` picks another file, and `--dry-run` only
prints the line. When the file already has the line, it says so and adds nothing. A line that is
already there and still not followed needs rewording, or a place nearer the top of the file.

Some issues have no line, like a broken test command. For those, `improve` says what to fix
instead.

## 3. Test the edit before you commit it (optional)

```sh
coding.sh exp ab --behavior unverified-claim
```

`exp ab` replays the moments in your sessions where the agent went wrong. It asks the model for the
next turn twice: once with the committed CLAUDE.md and once with your edit. A judge says which
turns did the right thing. [Test a CLAUDE.md change in five
minutes](../how-to/test-claude-md-change.md) walks through it.

It calls the model API, so it needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. A Claude subscription
is not enough. With only `OPENAI_API_KEY` set, `improve` suggests `--provider openai`. Without a
key, `exp ab` stops before it starts and points at step 5.

## 4. Commit it

```sh
git commit CLAUDE.md -m "CLAUDE.md: run the tests before saying done"
```

coding.sh records the git HEAD each session starts at. A session counts for the newest commit
that changed CLAUDE.md, AGENTS.md, GEMINI.md, a rule under `.claude/rules/` or `.cursor/rules/`,
or a skill's SKILL.md that its HEAD contains. So an edit counts from the commit that keeps it, not
from when you saved the file.

## 5. Did it help?

Keep working as usual. After a few sessions:

```sh
coding.sh improve check
```

```text
533729e  Nov 3 09:00  CLAUDE.md +2 -0  "CLAUDE.md: run the tests before saying done"
    + Run `npm test` before you say you are done, and never claim a fix works without running it.
  Helped: The agent follows the new line more: 4 of 4 sessions after, 1 of 6 before (p 0.05); flagged sessions 3 of 6 before, 1 of 4 after.
  Still flagged after it, 1 of 4 sessions (coding.sh show <id>):
    4b1c90d2-7a8e-4c55-9f0e-2d1f6e3b8a41  Nov 4 10:12  no-verification  "Add a --width flag to the CLI"
```

For each harness commit in the last 30 days, `check` compares the sessions that ran on the version
before it with the sessions that ran on it. A session with no tool calls, or only calls to MCP
servers (asking your agent whether a change helped, for example), is left out. It uses two
measures:

- **Flagged sessions**: the share of sessions with a failure flag, before and after.
- **The new lines**: for each added line that names a command, flag, path or identifier (like
  `` `npm test` ``), the share of sessions that did what it says.

Each measure gets a two-sided Fisher exact test. The verdicts:

| Verdict | When |
|---|---|
| Helped | fewer flagged sessions (p ≤ 0.1), or the new line followed more with no more flagged sessions |
| Regressed | more flagged sessions (p ≤ 0.1); `check` exits 1 |
| No clear change | 5 or more sessions after, and the difference could be chance |
| Too early to tell | fewer than 5 sessions after, and no clear result yet |
| No sessions yet | no session ran with the change |
| No sessions before it | nothing to compare with, often the commit that added the file |

Under each change, `check` lists the sessions that ran with it and still got a failure flag:
newest first, with the session id, when it started, its flags and its title. It shows five and
counts the rest; `--sessions` lists them all. `coding.sh show <id>` opens one. With `--json`, each
change's `before` and `after` have `flaggedSessions`, every flagged session on that side, each
with `id`, `at`, `title` and `flags`.

`coding.sh improve` shows the same verdicts for up to three changes from the last 30 days. Once sessions have run on
your latest change, an issue none of them had is marked "Not seen in the N sessions since
<commit>" and moves to the end of the list.

## Catch regressions as new sessions arrive

```sh
coding.sh improve check --watch
```

`--watch` re-checks every 60 seconds (`--interval` changes it) and prints one line when a change's
verdict or counts move. In CI or a cron job, `coding.sh improve check` exits 1 when a change
regressed, and `--json` gives the numbers.

## From inside your agent

The coding.sh MCP server (`coding.sh init` sets it up) has the same loop:

- The `improve` tool returns the ranked issues with the line, the file it goes in and the next
  commands, plus the verdicts for recent changes.
- The `harness_changes` tool returns each change with its before and after counts, how often the
  agent followed each new line, and the verdict. `after.flaggedSessions` lists the sessions still
  flagged after the change (`sessionId`, `at`, `flags`, `title`), newest first: five per change,
  or up to 20 when `commit` picks one change. `after.moreFlagged` counts the ones left out. Your
  agent opens one with `session_get`.
- Two prompts run the loop. In Claude Code they are `/mcp__coding-sh__improve` and
  `/mcp__coding-sh__did-it-help`.

You can also ask in plain words: "look at my recent sessions and help me improve my setup", or
"did my CLAUDE.md change last week help?", or "which sessions still failed after it?".

## What it can't tell you

- Small samples give wide answers. With 6 sessions on each side, only a large change reaches
  p ≤ 0.1. "No clear change" means "not proven", not "no effect".
- Sessions differ in what you asked for. A week of harder tasks can look like a regression.
- Flags are heuristics. `premature-completion` skips an agent that says plainly that tests still
  fail, but it reads the agent's words with patterns, so an unusual phrasing can still be flagged
  or missed. Open the example before you act on an issue.
- Sessions without a recorded git HEAD (outside a repo, or from an agent that doesn't report one)
  are left out of `check`.
