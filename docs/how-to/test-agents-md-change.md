# Test an AGENTS.md change in five minutes

You add a line to AGENTS.md, such as "run the tests before you say you're done". Did it help?
`coding.sh exp ab` answers that from the sessions you already have, before you commit the line.

You need coding.sh capturing your agent for a week or two (`coding.sh init`), a repo under git,
and a model: `ANTHROPIC_API_KEY`, or with no key, a logged-in Claude Code or Codex (see
[Replaying on a subscription](../guides/evals.md#replaying-on-a-subscription)).

## 1. Make the edit

Edit AGENTS.md and don't commit it:

```sh
echo "After changing code, run the tests before you say you are done." >> AGENTS.md
```

GEMINI.md and the other agents' instruction files, a rule under `.claude/rules/` or
`.cursor/rules/`, and a skill's SKILL.md work the same way.

## 2. Check what it will cost

```sh
coding.sh exp ab --dry-run
```

```text
3 decision points from 3 sessions since 14d
  unverified-claim: 3 cases from 3 sessions
  done-while-failing: 0 cases from 0 sessions
  unchanged-retry: 0 cases from 0 sessions
A git:HEAD (1 file) vs B your edits (1 file), claude-sonnet-5-5
Would make 6 of 6 model calls (0 cached) plus up to 6 judge calls: ~3k input tokens, ~$0.05
```

A decision point is a moment where the agent went wrong. Each one is a case:

| Kind | The agent |
|---|---|
| `unverified-claim` | said it was done after changing code without running anything |
| `done-while-failing` | ended a turn while its tests were failing |
| `unchanged-retry` | ran a failed command again unchanged |

The dry run makes no model calls. No decision points? It reads the last 14 days in this repo; try
`--since 30d`, or `--repo all` for every repo.

## 3. Run it

```sh
coding.sh exp ab --max-cost 1
```

`--max-cost 1` refuses to start if the estimate is over $1, and stops if the spend gets there.
A run on a small demo repo:

```text
A: git:HEAD   B: your edits   model: claude-sonnet-5-5
3 decision points from 3 sessions | A 0/3 -> B 3/3 | fixed 3, broke 0 | paired p=0.25 | <$0.01, 0/6 cached
Hold: not enough evidence (B wins 3, loses 0; needs 8+ wins with no losses)
Replay noise floor 0% (A's turn differs from the recorded one in 0/3); B moved +100 points, above it

Fixed (A failed, B passed):
  unverified-claim "Make pad.js pad on the left."  coding.sh show 8f0e1e52-bdc1-4da0-a03b-14edf6dfcf77
…
Full comparison: coding.sh exp compare exp_01M6VXZSFPM2QK12ANN6Z269WP exp_01M6VXZSFSZ25HD2HXXVY40BXV
```

For each case, the model wrote the agent's next turn twice: with your committed AGENTS.md (A) and
with your edit (B). A judge scored both. Nothing ran in your repo.

## 4. Read the verdict

| Line | Tells you |
|---|---|
| `… A 0/3 -> B 3/3 …` | Cases each version got right. "Fixed" ones your edit helped; "broke" ones it made worse, which matter more. |
| `Hold: …` | The decision: "Ship it", "Hold" (not enough evidence; 8 clean wins are needed) or "Don't ship" (B broke cases A got right). |
| `Replay noise floor` | How often A's replayed turn differs from the recorded one. If B moved less than that, the difference may be noise. |
| `Fixed` | `coding.sh show <id>` opens the moment in question. |

## 5. Iterate

```sh
coding.sh exp ab --watch
```

Each time you save AGENTS.md it reruns and prints one line:

```text
14:02:11  A 0/3 -> B 3/3 | fixed 3, broke 0 | Hold | <$0.01, 3 new calls
```

Answers are cached, so only your edited version is asked again. Ctrl-C stops it.

When you're happy, commit. To gate CI or a pre-commit hook, add `--gate`: it exits 0 only on
"Ship it".

## Options worth knowing

| Option | What it does |
|---|---|
| `--b drafts/AGENTS.md` | Test a draft file against your current one, without touching the repo |
| `--a git:main --b .` | Compare a branch's files with your working tree |
| `--a git:HEAD~1 --b git:HEAD` | Name two commits yourself. With no uncommitted edits, the default tests your last harness commit against the version before it |
| `--provider claude-code` or `codex` | Run on your Claude or ChatGPT subscription; costs are API-equivalent |
| `--behavior unverified-claim` | Only one kind of decision point |
| `--model` | Model for the next turn (default: the one the agent used, else the current Sonnet) |
| `--trials 3` | Ask each case three times, for steadier numbers on a small set |
| `--resume` | Continue an interrupted run |
| `--json` | Everything as one JSON document |

All options: [coding.sh exp ab](https://coding.sh/docs/cli/exp#cmd-exp-ab). More in the
[evals guide](../guides/evals.md#ab-a-harness-edit-on-your-own-sessions).
