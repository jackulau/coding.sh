# Improve your agent every week

Your agent makes the same mistakes again and again. coding.sh already records every session. This
guide turns those sessions into one weekly loop:

1. See what goes wrong most.
2. Add the line to AGENTS.md or CLAUDE.md that fixes it.
3. Test the edit on the moments it went wrong, or skip to 4.
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
   Fix: Name the check in AGENTS.md or CLAUDE.md. Add: "Run `npm test` before you say you are done, and say what it printed."
   → See it happen: coding.sh show 36ee2026-fff1-4fd3-aab3-a7d1706f15e0
   → Add the line to AGENTS.md or CLAUDE.md (uncommitted): coding.sh improve fix 1
   → Test the edit on the moments it went wrong (on your Claude subscription): coding.sh exp ab --behavior unverified-claim
   → Commit it, then check new sessions against it: coding.sh improve check
```

`improve` reads the sessions in this repo from the last 14 days (`--since 30d` for more,
`--repo all` for every repo). It leaves out subagents, eval and benchmark runs, and headless
sessions: `claude -p`, an Agent SDK or `codex exec`, the ones whose `stats.launch` is `"headless"`
(see [concepts.md](../concepts.md)). Those are mostly scripts, judges and evals that nobody watched,
and an AGENTS.md line is not what changes them. The first line says how many headless sessions it
left out, and `--headless` counts them. A session that does not say how it started stays in. It
lists three kinds of issue:

- **A failure flag**, such as an agent that says it is done without running anything, or one that
  ends its turn while tests fail without saying so. [concepts.md](../concepts.md) lists the flags.
- **A command or tool that fails the same way in two or more sessions**, such as a broken
  `npm test` or a missing script. When the test command failed before the agent changed any file,
  the issue says so: fix the command first, or the agent can't check its work.

  A compound line such as `cat Cargo.toml && cargo build` or a `for` loop counts against the part
  that failed, not its first word. That is the part the error names (`cat: x: No such file`), the
  tool the error comes from (a Rust `error[E0425]`, a Python traceback), the part `timeout` stopped
  (exit 124), or the one part left that could fail: the last part of a pipeline sets its status,
  and tools like `cat` and `sed` name themselves when they fail. Shell keywords, variable
  assignments, flags and wrappers like `sudo` or `xargs` are never the command. When nothing singles
  out a part, the issue says "A compound command" rather than guess. A test summary that a command
  like `cat test.log` printed is not a test run, so it never makes `cat` a broken setup.

- **Prompt cache paid for again**: the model calls that found the prompt cache gone, so the prompt
  was billed again at the write rate (`stats.cacheBreaks`, see [the API reference](../reference/api.md)). The
  issue says what that cost in dollars and as a share of the sessions' spend, and lists a fix for
  each cause (compaction, a model switch, a wait longer than the cache lives, or other), costliest
  first. The share sets its severity, from small under 2% of the spend to severe from 50%, so it
  ranks against the other issues by what it costs. It is listed from $1 in two or more sessions,
  and only for models with a price. `coding.sh usage --cache` breaks it down further.

Issues seen in two or more sessions come first. Then the order follows the severity score that
`coding.sh refine` uses. Each issue shows the newest example, what to try, and the commands for the
next steps. `coding.sh show <id>` opens the example. Its header has a `Flags` row.

What `improve` shows from your sessions, the example prompts, error lines and commands, goes
through redaction first: secrets and email addresses become `[redacted:<kind>]`, whatever
`capture.redact` kept in the store. The same holds for `improve check`, `--json` and the MCP tools.

## 2. Add the line

```sh
coding.sh improve fix 1
```

```text
✓ Added to CLAUDE.md (not committed):
+ Run `npm test` before you say you are done, and say what it printed.
```

`improve fix` appends the issue's line to AGENTS.md or CLAUDE.md: the one the repo has, or, when
it has both, the one the issue's agents read. This repo's sessions are Claude Code's and its file
is CLAUDE.md, so the line went there. `--target <file>` picks another file, and `--dry-run` only
prints the line. When the file already has the line, it says so and adds nothing. A line that is
already there and still not followed needs rewording, or a place nearer the top of the file.

Some issues have no line, like a broken test command. For those, `improve` says what to fix
instead.

## 3. Test the edit before you commit it (optional)

```sh
coding.sh exp ab --behavior unverified-claim
```

`exp ab` replays the moments in your sessions where the agent went wrong. It asks the model for the
next turn twice: once with the committed file and once with your edit. A judge says which
turns did the right thing. [Test an AGENTS.md change in five
minutes](../how-to/test-agents-md-change.md) walks through it.

It needs a model. With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set, it calls that API. With
neither, it runs on your subscription through a logged-in Claude Code (`claude -p`) or Codex
(`codex exec`), and says so in one line:

```text
No API key set: replaying through `claude -p` on your Claude subscription (CLAUDE_CODE_OAUTH_TOKEN); costs are API-equivalent
```

`--provider claude-code` or `--provider codex` picks one. Each call runs without your hooks,
plugins, MCP servers or settings, in an empty directory, with your edit as the only harness file in
the prompt. With `claude -p` the model gets the session's own tools, and a hook of ours refuses
every call it makes, so nothing runs. A subscription run shows its cost as API-equivalent: what the same
tokens would cost on the API, not what you pay. It has no spending cap unless you pass `--max-cost`.
It makes 2 calls at a time, waits and retries when rate limited, and stops when your plan's usage
limit is reached; run the same command after the reset and the finished trials come from the
cache. [Replaying on a subscription](evals.md#replaying-on-a-subscription) lists how its prompt
differs from the API's.

When you already committed the edit, `exp ab` with no `--a` or `--b` tests your last harness commit
against the version before it. `--dry-run` shows the moments it would replay and the cost without
calling a model, with or without uncommitted edits.

With nothing logged in and no key, `exp ab` stops before it starts and points at step 5.

## 4. Commit it

```sh
git commit CLAUDE.md -m "CLAUDE.md: run the tests before saying done"
```

coding.sh records the git HEAD each session starts at. A session counts for the newest commit
that changed AGENTS.md, CLAUDE.md, GEMINI.md, a rule under `.claude/rules/` or `.cursor/rules/`,
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
  Helped: Fewer sessions went wrong after it: flagged sessions 6 of 10 before, 1 of 9 after (p 0.06).
  Still flagged after it, 1 of 9 sessions (coding.sh show <id>):
    4b1c90d2-7a8e-4c55-9f0e-2d1f6e3b8a41  Nov 4 10:12  no-verification  "Add a --width flag to the CLI"
```

For each harness commit in the last 30 days, `check` compares the sessions that ran on the version
before it with the sessions that ran on it. A session with no tool calls, or only calls to MCP
servers (asking your agent whether a change helped, for example), is left out, and so is one whose
agent never got to work because it was not logged in. A `Left out:` line under the change counts
them (`idle` on each side in `--json`). When your agents
work in other checkouts or worktrees of the repo, `--repo <DIR>` or `--repo all` counts their
sessions too, against this repo's history: a session counts when this repo has the commit it
started from. It asks three questions of each change:

- **Did the failure fall?** The share of sessions with a failure flag, before and after, and the
  share for each flag on its own.
- **Did the agent follow the new lines?** For each added line that names a command, flag, path or
  identifier (like `` `npm test` ``), the share of sessions that did what it says.
- **Did it add work?** Tool calls and wall time per session, before and after.

Shares get a two-sided Fisher exact test at p ≤ 0.1. A single flag's test is Holm-adjusted across
the flags seen before the change. Work gets a two-sided permutation test on the mean of
log(1 + x), with 2000 seeded shuffles, when both sides have 5 or more sessions. Following a line is
not the same as fixing what it targets: in a study of agent harness changes, Claude read the new
instructions in nearly every session, but only 2 of 7 changes stopped the action they targeted
([Treude and Baltes](https://arxiv.org/html/2610.34938v1)). So a line the agent follows is not
"Helped" unless the failures fall too. The verdicts:

| Verdict | When |
|---|---|
| Helped | fewer flagged sessions (p ≤ 0.1), or one flag fell (Holm p ≤ 0.1) while no other flag rose and the flagged share did not rise. When sessions also got costlier, the reason says "It also added work" |
| Followed, no effect yet | the agent follows a new line more (p ≤ 0.1), but flagged sessions did not fall |
| Costlier | sessions after it make at least 1.25 times the tool calls or take 1.25 times as long (median, p ≤ 0.1), and flagged sessions did not fall |
| Regressed | more flagged sessions (p ≤ 0.1); `check` exits 1. This is the only verdict that exits 1 |
| No clear change | 5 or more sessions after, and the difference could be chance. When one flag fell but another rose in its place, the reason says the failures moved |
| Too early to tell | fewer than 5 sessions after, and no clear result yet |
| No sessions yet | no session ran with the change |
| No sessions before it | nothing to compare with, often the commit that added the file |

For "Followed, no effect yet" and "Costlier", `check` suggests testing the harness without the
change: `coding.sh refine test git:<previous>`, where `<previous>` is the harness commit before it.
A line that adds work and fixes nothing is a candidate for removal.

Under each change, `check` lists the sessions that ran with it and still got a failure flag:
newest first, with the session id, when it started, its flags and its title. It shows five and
counts the rest; `--sessions` lists them all. `coding.sh show <id>` opens one. With `--json`, each
change's `before` and `after` have `flaggedSessions`, every flagged session on that side, each
with `id`, `at`, `title` and `flags`. A change has `work` (`toolCalls` and `durationMs`, each with
the `before` and `after` medians and `p`) only when both sides have 5 or more sessions and the
medians differ, and `next` (the `refine test` command) for the two verdicts above.

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
  commands, plus the verdicts for recent changes. It leaves out headless sessions as `improve`
  does, and `scope.headlessLeftOut` counts them; `headless: true` counts them The prompt cache issue carries `usd` and
  `causes`, each with its `cause`, `breaks`, `usd` and `fix`.
- The `harness_changes` tool returns each change with its before and after counts, how often the
  agent followed each new line, and the verdict. `after.flaggedSessions` lists the sessions still
  flagged after the change (`sessionId`, `at`, `flags`, `title`), newest first: five per change,
  or up to 20 when `commit` picks one change. `after.moreFlagged` counts the ones left out. Your
  agent opens one with `session_get`. `work` is there when `check --json` has it.
- Two prompts run the loop. In Claude Code they are `/mcp__coding-sh__improve` and
  `/mcp__coding-sh__did-it-help`.
- The `harness_audit` tool lists the memory files, skills and instruction files your sessions
  never read, with what loading each costs per session, and with `check: true` checks your edits
  for removed safety lines. The `/mcp__coding-sh__trim` prompt runs it. See
  [Memory and instruction files](explore.md#memory-and-instruction-files).

You can also ask in plain words: "look at my recent sessions and help me improve my setup", or
"did my AGENTS.md change last week help?", or "which sessions still failed after it?", or "audit
my setup and trim what I don't use".

## What it can't tell you

- Small samples give wide answers. With 6 sessions on each side, only a large change reaches
  p ≤ 0.1. "No clear change" means "not proven", not "no effect".
- Sessions differ in what you asked for. A week of harder tasks can look like a regression.
- Flags are heuristics. `premature-completion` skips an agent that says plainly that tests still
  fail, but it reads the agent's words with patterns, so an unusual phrasing can still be flagged
  or missed. Open the example before you act on an issue.
- Sessions without a recorded git HEAD (outside a repo, or from an agent that doesn't report one)
  are left out of `check`.
