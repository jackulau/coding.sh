# What to fix first

`coding.sh improve` ranks the problems in your recent sessions, proposes the AGENTS.md line that
fixes each, and checks whether your last edits helped.

`improve` reads the sessions coding.sh recorded in this repo, from any agent it captures. It lists
the issues that recur, the line that fixes each, and how your last instruction changes did on the
sessions after them. It makes no model calls.

## See what to fix first

Run it from the repo:

```sh
coding.sh improve
```

```text
47 sessions in coding.sh since 14d (claude-code 28, codex 14, opencode 5)

Fix first
1. Says it is done without running anything to check
   6 of 47 sessions, low 27; latest 2h ago
   e.g. "Skip the site deploy when CLOUDFLARE_API_TOKEN is unset"
   Fix: Name the check in AGENTS.md. Add: "Run `npm test` before you say you are done, and say what it printed."
   → See it happen: coding.sh show 8411007a-03a4-4965-88b6-7a5388f2685b
   → Add the line to your instructions file (uncommitted): coding.sh improve fix 1
   → Test the edit on the moments it went wrong: coding.sh exp ab --behavior unverified-claim
   → Commit it, then check new sessions against it: coding.sh improve check

Did your last changes help?
  4925549  Nov 11 04:13  AGENTS.md +129 -0  "Add AGENTS.md and package.json"
      + # AGENTS.md …
    No sessions yet: No captured session ran with this change yet.
```

Each issue has a count, a severity, the newest example and the commands for the next step.
`coding.sh show <id>` opens the example session.

`improve` lists three kinds of issue:

| Kind | Example |
|---|---|
| A failure flag | The agent says it is done without running anything, or ends its turn while tests fail. [Concepts](../concepts.md) lists the flags. |
| A command that fails the same way in two or more sessions | A broken `npm test` or a missing script. When the test command failed before the agent changed any file, the issue says to fix the command first. |
| Prompt cache paid for again | Model calls that found the cache gone, so the prompt was billed again. Listed from $1 in two or more sessions, with a fix for each cause. |

Issues seen in two or more sessions come first, then by severity. Example prompts, error lines and
commands are redacted before they are shown.

:::more What improve leaves out
- Sessions older than 14 days, and sessions in other repos. `--since 30d` and `--repo all` widen it.
- Subagents, and eval and benchmark runs.
- Headless sessions (`claude -p`, an Agent SDK, `codex exec`): mostly scripts and judges nobody
  watched. The first line counts them, and `--headless` includes them.
- In a compound line such as `cat Cargo.toml && cargo build`, the part that failed is the one
  counted. When nothing singles out a part, the issue says "A compound command".
:::

## Add the line

```sh
coding.sh improve fix 1
```

```text
✓ Added to AGENTS.md (not committed):
+ Run `npm test` before you say you are done, and say what it printed.

  Test it on the moments it went wrong (A = committed, B = your edit):
    coding.sh exp ab --behavior unverified-claim

  Keep it: commit, then check new sessions against it:
    git add AGENTS.md && git commit -m "AGENTS.md: says it is done without running anything to check" && coding.sh improve check
```

`improve fix` appends the line to the repo's instructions file: AGENTS.md or the agent's own file,
whichever the repo has. With both, it picks the one the issue's agents read. When the file already has the line, it adds nothing; a line that is there and still
not followed needs rewording, or a place nearer the top.

| Flag | Default | What it does |
|---|---|---|
| `--target` | the file the agents read | Writes the line to another file. |
| `--dry-run` | off | Prints the line and writes nothing. |

Some issues, like a broken test command, have no line. For those, `improve` says what to fix
instead.

## Test it before you commit

```sh
coding.sh exp ab --behavior unverified-claim
```

`exp ab` replays the turns where the agent went wrong, once with the committed file and once with
your edit, and a judge grades both. It needs an API key, or a logged-in Claude Code or Codex.
[Test an AGENTS.md change](../how-to/test-agents-md-change.md) walks through it. This step is
optional: without a model, commit and let the next step judge it.

## Did your last change help?

Commit the line and keep working. After a few sessions:

```sh
git add AGENTS.md && git commit -m "AGENTS.md: run the tests before saying done"
coding.sh improve check
```

coding.sh records the git HEAD each session starts at. A session counts for the newest commit that
changed AGENTS.md, another instructions file, a rule or a skill. So an edit counts from the commit
that keeps it, not from when you saved the file.

For each such commit in the last 30 days, `check` compares the sessions before it with the sessions
after it. It asks three questions: did flagged sessions fall, did the agent follow the new lines,
and did each session take more work. Then it gives one verdict:

| Verdict | When |
|---|---|
| Helped | Fewer flagged sessions, or one flag fell while no other rose. |
| Followed, no effect yet | The agent does what the new line says, but flagged sessions did not fall. |
| Costlier | Sessions take at least 1.25 times the tool calls or time, and flagged sessions did not fall. |
| Regressed | More flagged sessions. `check` exits 1. |
| No clear change | 5 or more sessions after, and the difference could be chance. |
| Too early to tell | Fewer than 5 sessions after, and no clear result yet. |
| No sessions yet | No session ran with the change. |
| No sessions before it | Nothing to compare with, often the commit that added the file. |

For Followed and Costlier, `check` suggests `coding.sh refine test git:<previous>` to test the
harness without the change. Under each change it lists the sessions after it that still got a
flag. `coding.sh improve` shows the same verdicts for up to three recent changes.

| Flag | Default | What it does |
|---|---|---|
| `--since` | 30d | Changes after this time. |
| `--repo` | this repo | Also counts sessions in other checkouts or worktrees: a directory, or `all`. |
| `--sessions` | off | Lists every flagged session after each change, not five. |
| `--watch` | off | Checks again every `--interval` seconds (60) and prints a line when a verdict moves. |
| `--json` | off | The counts, tests and flagged sessions as JSON. |

In CI or a cron job, `coding.sh improve check` exits 1 when a change regressed.

:::more How check decides
- Shares of sessions get a two-sided Fisher exact test at p ≤ 0.1. One flag's test is
  Holm-adjusted across the flags seen before the change.
- Tool calls and wall time per session get a permutation test on log(1 + x), when both sides have
  5 or more sessions.
- Following a line is counted only for added lines that name a command, flag, path or identifier,
  like `` `npm test` ``.
- An agent can follow a line without fixing what it targets. So a followed line is not Helped
  unless the failures fall too.
- Sessions with no tool calls, or only MCP calls, are left out, and so are sessions with no recorded
  git HEAD.

[How evals are computed](https://coding.sh/docs/eval-methods) has the details.
:::

## From inside your agent

The coding.sh MCP server (`coding.sh init` sets it up) runs the same loop:

| Tool or prompt | What it does |
|---|---|
| `improve` tool | The ranked issues with the line, the file it goes in and the next commands, plus recent verdicts. |
| `harness_changes` tool | Each change with its before and after counts, how often each new line was followed, and the verdict. |
| `harness_audit` tool | The instruction files and skills your sessions never read, and what each costs to load. |
| `/mcp__coding-sh__improve`, `/mcp__coding-sh__did-it-help`, `/mcp__coding-sh__trim` | Prompts that run the loop in Claude Code. |

You can also ask in plain words: "did my AGENTS.md change last week help?"

## What it can't tell you

- Small samples give wide answers. With 6 sessions on each side, only a large change reaches
  p ≤ 0.1. No clear change means not proven, not no effect.
- Sessions differ in what you asked for. A week of harder tasks can look like a regression.
- Flags are heuristics that read the agent's words with patterns. Open the example before you act.

## Next steps

- [Test an AGENTS.md change](../how-to/test-agents-md-change.md): replay the bad turns with your
  edit before you commit.
- [Evaluate AGENTS.md and skills](https://coding.sh/docs/harness-evals): refine in tested rounds,
  and protect safety lines.
- [Concepts](../concepts.md): the failure flags and how sessions are built.
