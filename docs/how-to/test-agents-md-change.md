# Test an AGENTS.md change

Replay the moments your agent went wrong with your committed AGENTS.md and with your edit, and get
a ship-or-hold verdict before you commit.

`coding.sh exp ab` finds turns in your recorded sessions where the agent went wrong. For each one,
a model writes the agent's next turn twice: with your committed AGENTS.md (A) and with your edit
(B). A judge grades both turns. Nothing runs in your repo.

## Before you start

- coding.sh records your coding agent's sessions in this repo. `coding.sh init` imports your past
  sessions; if you skipped that, run `coding.sh ingest --backfill --since 30d`.
- The repo is under git, and AGENTS.md is committed.
- A model to replay with: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. With neither, `exp ab` runs on a
  logged-in Claude Code or Codex, and reports the cost as API-equivalent dollars.

## 1. Make the edit

Edit AGENTS.md and leave it uncommitted. [`coding.sh improve`](../guides/improve.md) proposes a
line for your most common problem, and `improve fix 1` adds it for you:

```sh
coding.sh improve fix 1
```

```text
✓ Added to AGENTS.md (not committed):
+ Run `npm test` before you say you are done, and say what it printed.

  Test it on the moments it went wrong (A = committed, B = your edit):
    coding.sh exp ab --behavior unverified-claim
```

A rule under `.claude/rules/` or `.cursor/rules/`, a skill's SKILL.md and the other agents'
instructions files work the same way.

## 2. Check what it will cost

```sh
coding.sh exp ab --dry-run
```

```text
16 decision points from 16 sessions since 14d
  unverified-claim: 16 cases from 16 sessions
  done-while-failing: 0 cases from 0 sessions
  unchanged-retry: 0 cases from 0 sessions
A git:HEAD (1 file) vs B your edits (1 file), claude-sonnet-4-6
Would make 32 of 32 model calls (0 cached) plus up to 32 judge calls: ~93k input tokens, ~$0.67
```

A decision point is one turn where the agent went wrong. The dry run makes no model calls.

The estimate is rough: four characters per token, a 400-token reply per call and a 200-token judge
reply, at list price, with no prompt caching. A run can cost less or more, so cap it with
`--max-cost`. The outputs in steps 2 and 3 come from different runs, so their costs differ.

| Kind | The agent |
|---|---|
| `unverified-claim` | said it was done after changing code, without running anything to check |
| `done-while-failing` | ended a turn while its tests were failing |
| `unchanged-retry` | ran a failed command again, unchanged |

## 3. Run it

```sh
coding.sh exp ab --max-cost 1
```

```text
A: git:HEAD   B: your edits   model: claude-sonnet-4-6
16 decision points from 16 sessions | A 0/16 -> B 16/16 | fixed 16, broke 0 | paired p<0.001 | $0.05, 0/32 cached
Ship it: B wins 16 decision points, loses 0
Replay noise floor 0% (A's turn differs from the recorded one in 0/16); B moved +100 points, above it

Fixed (A failed, B passed):
  unverified-claim "Skip the site deploy when CLOUDFLARE_API_TOKEN is unset"  coding.sh show 8411007a-03a4-4965-88b6-7a5388f2685b
  unverified-claim "Commit the eval task fixtures"  coding.sh show 27c9742c-a453-4f8a-82ab-329aa740715a
  … 13 more

Full comparison: coding.sh exp compare exp_01M75267AHHFRD8E72E9G619N2 exp_01M75267DXXCF3PPV3T5KVF6XD
```

`--max-cost 1` refuses to start when the estimate is over $1, and stops once the spend passes it.
`coding.sh show <id>` opens the session a decision point came from.

## 4. Read the result

| You see | It means | Do this |
|---|---|---|
| `Ship it: B wins N …, loses M` | B won enough decision points without breaking what A got right. With no losses it takes 8 wins. | Commit the edit. |
| `Hold: not enough evidence (B wins N, loses M; …)` | Too few wins to be sure, or wins mixed with losses. | Add `--since 30d` or `--trials 3`, or reword the line. |
| `Don't ship: B breaks N … A solved` | Your edit made some turns worse. | Open them with `exp compare` and fix the line. |
| `Hold … (no decision point changed outcome)` with `A 0/N -> B 0/N` | Nothing changed, or the judge failed on every run. `exp ab` does not say which. | Run the `Full comparison` command. |

The noise floor line says how often A's replayed turn differs from the recorded one. A change in B
smaller than that may be noise.

When the judge fails, `exp compare` names the runs it could not grade and leaves them out:

```sh
coding.sh exp compare exp_01M752BX8HMDVHATDEY856T7TP exp_01M752BXAPEKK8H7FBBQR52E4D
```

```text
! 32 run(s) had a grader error (A 16, B 16); their outcome is unknown, so they are left out and only graded runs are compared. Re-run them before trusting the verdict
…
verdict inconclusive (CI includes 0)
lost    A 16/16 (16 ungraded runs)  B 16/16 (16 ungraded runs)  Fisher p=1.000
```

Fix the judge's model or key, then run `exp ab` again.

To see the cases A and B fixed and broke side by side in the viewer, see
[Compare two versions](https://coding.sh/docs/experiments#compare).

## 5. Iterate on the wording

```sh
coding.sh exp ab --watch
```

Each save of AGENTS.md reruns the A/B and prints one line. A's answers are cached, so only B is
asked again. Ctrl-C stops it.

```text
Watching . for changes to B; Ctrl-C to stop.
04:25:55  A 0/16 -> B 16/16 | fixed 16, broke 0 | Ship it | $0.01, 16 new calls
```

## 6. Commit, then check new sessions

```sh
git add AGENTS.md && git commit -m "AGENTS.md: run the tests before saying done"
coding.sh improve check
```

`improve check` compares the sessions after the commit with those before it, on real work. It makes
no model calls and exits 1 when the change made things worse. It says Too early to tell until 5
sessions ran with the change. See [Did your last change help?](../guides/improve.md#did-your-last-change-help)

## Flags

| Flag | Default | What it does |
|---|---|---|
| `--a` | git HEAD | The baseline: a file, a directory, `git:REV` or `none`. |
| `--b` | your uncommitted edits | The candidate. A file replaces the file of the same path in A, so `--b drafts/AGENTS.md` tests a draft. |
| `--behavior` | all | Only these kinds of decision point. |
| `--since` | 14d | Sessions started since this time. |
| `--repo` | this repo | Another directory, or `all`. |
| `-n`, `--limit` | 40 | Most decision points to test. |
| `--provider` | anthropic | `openai`, `openai-compatible`, or `claude-code` / `codex` to run on your subscription. |
| `--model` | the recorded model | The model that writes the next turn. `--judge-model` sets the judge. |
| `--trials` | 1 | Next turns per case and arm. More trials steady a small set. |
| `--max-cost` | none | Refuse to start over this estimate, and stop once spent. |
| `--gate` | off | Exit 0 only on Ship it, for CI or a pre-commit hook. |
| `--resume` | off | Continue an interrupted A/B. |

With no uncommitted edits, the default tests your last AGENTS.md commit against the version before
it. Every flag: [exp ab reference](https://coding.sh/docs/cli/exp).

## If something goes wrong

| Symptom | Check |
|---|---|
| `0 decision points` | The default reads 14 days of sessions in this repo. Try `--since 30d` or `--repo all`, or import history with `coding.sh ingest --backfill --since 30d`. |
| `improve` says headless sessions were left out | Your sessions ran with `claude -p`, `codex exec` or an Agent SDK. Add `--headless` to `improve`, `improve fix` and `improve check`. |
| It refuses to start | The estimate is over `--max-cost`. Lower `-n` or pick one `--behavior`. |
| No API key and no login | Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, or log in to Claude Code or Codex. Without any, commit the change and let `improve check` judge it. |
| `--watch needs B to be files on disk` | `--watch` follows files. Drop `--b git:…`. |
| A protected-line warning | Your edit deletes or relaxes a safety line. See [Keep safety lines from being dropped](https://coding.sh/docs/harness-evals#protected). |

## Other ways to test a change

| Question | Command |
|---|---|
| What should I change first? | [`coding.sh improve`](../guides/improve.md) |
| Did a committed change help on real work? | `coding.sh improve check` |
| Does a skill change what the agent does on whole tasks? | [Evaluate a skill](evaluate-a-skill.md) |
| Does the agent load my skill when it should? | [`coding.sh eval trigger`](https://coding.sh/docs/harness-evals#triggers) |
| Can rounds of edits be tested for me? | [`coding.sh refine run`](https://coding.sh/docs/harness-evals#refine) |

## Next steps

- [What to fix first](../guides/improve.md): the ranked issues and the line for each.
- [Evaluate AGENTS.md and skills](https://coding.sh/docs/harness-evals): refine rounds and protected lines.
- [Catch a regression in CI](ci-regressions.md): run `--gate` on every pull request.
