# Test a CLAUDE.md change in five minutes

You keep telling your agent the same thing: run the tests before you say you're done. So you add a
line to CLAUDE.md. Did it help? `coding.sh exp ab` answers that from the sessions you already have,
before you commit the line.

You need: coding.sh capturing your agent's sessions for a week or two (`coding.sh init`), a repo
under git, and an API key for the model that answers (`ANTHROPIC_API_KEY` by default).

## 1. Make the edit

Edit CLAUDE.md the way you normally would, and don't commit it:

```sh
echo "After changing code, run the tests before you say you are done." >> CLAUDE.md
```

The same works for AGENTS.md, GEMINI.md, a rule under `.claude/rules/` or `.cursor/rules/`, or a
skill's SKILL.md.

## 2. Check what it will cost

```sh
coding.sh exp ab --dry-run
```

```text
3 decision points from 3 sessions since 14d
  unverified-claim: 3 cases from 3 sessions
  done-while-failing: 0 cases from 0 sessions
  unchanged-retry: 0 cases from 0 sessions
A git:HEAD (1 file) vs B your edits (1 file), claude-sonnet-4-5
Would make 6 of 6 model calls (0 cached) plus up to 6 judge calls: ~3k input tokens, ~$0.08
```

A decision point is a moment in one of your sessions where the agent went wrong. Three kinds are
built in: it said it was done after changing code without running anything, it ended a turn while
its tests were failing, or it ran a failed command again unchanged. Each one is a case. The dry run
makes no model calls.

No decision points? It looks at the last 14 days in this repo. Try `--since 30d`, or `--repo all`
for every repo.

## 3. Run it

```sh
coding.sh exp ab --max-cost 1
```

`--max-cost 1` refuses to start if the estimate is over $1, and stops if the spend gets there.
Here is a run on a small demo repo with three sessions:

```text
A: git:HEAD   B: your edits   model: claude-sonnet-4-5
3 decision points from 3 sessions | A 0/3 -> B 3/3 | fixed 3, broke 0 | paired p=0.25 | <$0.01, 0/6 cached
Hold: not enough evidence (B wins 3, loses 0; needs 8+ wins with no losses)
Replay noise floor 0% (A's turn differs from the recorded one in 0/3); B moved +100 points, above it

Fixed (A failed, B passed):
  unverified-claim "Make pad.js pad on the left."  coding.sh show 0a25368e-c939-467b-b3ae-33fc64e2eaa3
  unverified-claim "Make clamp.js clamp to the upper bound too."  coding.sh show 21fe887d-1197-43fc-baa0-3af00a30548c
  unverified-claim "Make range.js include its end value."  coding.sh show b75935e0-afd0-4ee0-9bf8-3e6f84eacdc2

Full comparison: coding.sh exp compare exp_01M6VX8WPCYZEKMDD9PD0CRFCN exp_01M6VX8WPFG2BS15JM0YV525KQ
```

For each case, the model wrote the agent's next turn twice: once with your committed CLAUDE.md (A)
and once with your edit (B). A judge scored both turns against what a good turn looks like at that
point. Nothing ran in your repo.

## 4. Read the verdict

**The first line** counts how many cases each version got right and which ones flipped. "Fixed"
cases are the ones your edit helped. "Broke" cases are ones it made worse, and those matter more.

**The second line** is the decision. "Ship it" means B won enough cases, broke few enough, and the
difference is unlikely to be luck. "Hold" means there isn't enough evidence either way: here 3 wins
out of 3 is a good sign, but 8 clean wins are needed to call it. "Don't ship" means B broke cases
that A got right.

**The noise floor line** tells you how much to trust the difference. Even with no change at all, a
replayed turn won't always match what the agent did at the time. A is the control: the share of
cases where A's turn differs from the recorded one is the noise floor. If B moved fewer points than
that, the line says so, and the difference may be noise.

**The fixed list** links each session, so `coding.sh show <id>` takes you to the moment in question.

## 5. Iterate

Rewording the line? Leave it running:

```sh
coding.sh exp ab --watch
```

Each time you save CLAUDE.md it reruns and prints one line:

```text
14:02:11  A 0/3 -> B 3/3 | fixed 3, broke 0 | Hold | <$0.01, 3 new calls
```

Answers are cached, so only your edited version is asked again. A's answers come from the cache,
and a rerun with nothing changed costs nothing. Ctrl-C stops it.

When you're happy, commit. To make it a gate in CI or a pre-commit hook, add `--gate`: it exits 0
only on "Ship it".

## Options worth knowing

- `--b drafts/CLAUDE.md` tests a draft file against your current one without touching the repo.
  `--a git:main --b .` compares a branch's files with your working tree.
- `--behavior unverified-claim` limits the run to one kind of decision point.
- `--model` picks the model for the next turn. By default it's the one your sessions used most.
- `--trials 3` asks each case three times, for steadier numbers on a small set.
- `--json` gives everything as one JSON document.
- An interrupted run picks up where it stopped with `--resume`.

More in the [evals guide](../guides/evals.md#ab-a-harness-edit-on-your-own-sessions).
