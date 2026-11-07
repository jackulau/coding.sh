# Evals and comparisons

Eval runs that drive a real agent or an LLM judge call that agent or provider, with your
credentials and at your cost.

## Session to eval

`coding.sh eval new <session> --verifier "<cmd>"` drafts a replayable task that starts from the
repo snapshot taken before the agent ran.

`coding.sh eval validate <task>` checks that the verifier is fair: a do-nothing attempt fails, the
reference fix passes k of k, near-misses fail, an impossible variant fails, and no future history
leaks.

`coding.sh eval export --format harbor` writes a Harbor-format task.

## Datasets and experiments

`coding.sh dataset add|import` keeps versioned cases with stable train/dev/test splits.

`coding.sh exp run` runs a command or HTTP task over a dataset. Graders can be deterministic
(exact, contains, regex, numeric, similarity, JSON schema, JSON path), a command, or an LLM judge.

`coding.sh exp compare A B` reports the paired bootstrap CI of the difference, an exact McNemar
test on flipped cases and the minimum detectable effect. It also reports:

- **Clusters.** `--cluster repo` resamples groups of related cases (any case metadata field;
  `session` falls back to the case's source session) instead of single cases. It prints the cluster
  count and warns below 10 clusters. Without the flag, cases are treated as independent.
- **A Bayesian check at small n.** Below 100 paired cases it adds P(B>A) and a credible interval
  from a Dirichlet posterior on the paired outcomes. The bootstrap interval stays.
- **Attrition.** Per arm, trials lost to task errors, grader errors or missing runs, split into
  infra errors (timeouts, network, HTTP 429/5xx) and agent errors. Fisher's exact test flags an
  uneven split at p < 0.01.
- **Noise floor.** When an A/A run exists for the baseline config, it prints the A/A flip rate,
  and the minimum detectable effect never goes below what that noise allows.
- **Timing.** When the two runs were not interleaved and ran one after the other, it warns and
  says how far apart they were. Provider drift, rate limits and time of day can look like a change.
- **Coverage turnover.** With 2+ trials per case, a case is covered when it passed in at least one
  trial. The `coverage` line gives each arm's covered share, the cases B gained (A never passed, B
  passed at least once), the cases B lost (A passed at least once, B never) and those covered in
  both. Lost cases are listed under `lost coverage`, before the regressions. A net coverage gain
  can hide lost cases, and the mean pass rate can move the other way from coverage, so gains and
  losses are counted apart. The `reliability` line counts cases whose pass rate went up, down or
  stayed the same. The `halves` line splits each case's trials in order (trials 1 to k/2, then the
  rest) and gives B − A in each half. When the two halves have opposite signs it warns, and when the
  verdict is significant the warning asks you to confirm with more trials. `--matrix` prints the
  success-count matrix: cases by passes out of k in A (rows) and in B (columns), so the cells below
  the diagonal are cases B passed less often. `--json` always carries `comparison.turnover`
  (`gained`, `lost`, `keptCovered`, `neverCovered`, `reliability`, `matrix` when every case ran k
  trials in both arms, `halves`). With one trial per case, coverage is the pass rate, so the text
  output leaves these lines out. Method: EvoAudit (arXiv 2611.07624).

`coding.sh exp compare A B --gate` adds a ship-or-hold line under the verdict: `Ship it: B wins 8
cases, loses 0`, `Hold: not enough evidence`, or `Don't ship: B breaks 2 cases A solved` with up to
5 of the broken cases. It exits 0 only for "Ship it" and 1 otherwise, and `--json` carries
`comparison.gate`. It uses each case's majority outcome over its trials (a 0.5 pass rate counts as
a pass) and only cases both sides graded. A fixed case is a win and a broken one is a loss. B ships
when wins minus λ times losses is positive (`--lambda`, default 2). The wins must also beat
break-even in an exact one-sided binomial test at `--gate-alpha` (default 0.05), and B may break at
most `--tau` (default 10%) of the cases A solved. This is SAGE's accept-or-abstain rule (Wang et
al., arXiv 2609.36043). Plain "mean went up" accepts changes that break solved cases. At `--lambda
1 --gate-alpha 1 --tau 1` the gate is exactly "more fixes than breaks". When trials were lost to
errors unevenly, the gate notes that a task error counts as a failure.

`coding.sh exp run --arm base=a.json --arm cand=b.json` runs two task configs as one A/B. Cases go
in a random order, and each case runs in both arms back to back, in random arm order, so drift
hits both arms the same. Both arms are stored (as `<name>-base` and `<name>-cand`) and share a pair
id. `--seed` fixes the order, `--max-cases N` runs a random N cases.

Add `--stop-early` to stop once the answer is clear. It is a group sequential test with
O'Brien-Fleming alpha spending at `--looks` (default 4) evenly spaced points of the case budget,
never before 20 paired cases. Early looks need very strong evidence, so the last look is close to
the fixed-n test. The output says why it stopped (a boundary was crossed, or the budget ran out),
and the interval it prints is a repeated confidence interval, which stays valid however the run
stopped. After an early stop, the stored arms hold only the cases the deciding look saw, and
`exp compare` on them uses the sequential verdict and warns that its bootstrap interval is too
narrow.

`coding.sh exp aa --dataset D --task T --grader G` runs one config twice, interleaved like `--arm`,
and stores its run-to-run noise: the A/A delta, flipped cases, the SD of per-case differences, and
the cases needed to detect a 5pp or 10pp change. `coding.sh exp aa A B` measures it from two
stored runs instead, and warns when they were not interleaved.

`coding.sh exp sweep base=a.json b.json c.json -d D -g G` picks the best of several task configs.
It uses sequential halving (Karnin et al., ICML 2013): the budget is split over log2(N) rounds,
each round runs every surviving config on the same fresh cases from the train split, and the
better half goes on. Dropped configs show their gap to the leader with a CI, so you can see which
drops were close. Then the winner and the first (start) config run on the test split, which the
race never saw. The output prints the winner's train and held-out scores and the optimism gap
(train minus held-out). The winner of a race tends to be the luckiest config, so its train score
runs high; the held-out score is the one to trust. On those held-out cases the same gate as
`exp compare --gate` (default settings) decides: `adopt <winner>`, or `keep <start>` with the
reason (not enough evidence, or the winner breaks cases the start config solved). `--budget N`
caps case runs for the race (default: each train case used once), `--split` and `--held-out` pick
the splits, and a dataset with no splits gets a seeded 30% held out. Every run is stored as a
normal experiment.

## Metric A/B (ms, bytes)

`coding.sh exp metrics --arm base='<cmd>' --arm cand='<cmd>'` compares two commands that print
numbers instead of pass/fail. Each run prints one JSON object, such as
`{"lcp_ms": 2310, "js_bytes": 48211}`. Nested objects flatten to dotted names
(`mobile.home.lcp_ms`). An arm is a command line, a `{"kind":"command"}` task spec or a spec file.
Each run gets `{"arm","pair","warmup"}` on stdin.

The arms run in `--pairs` interleaved pairs (default 11), one run at a time. Half the pairs run A
first and half B first, in a seeded random order, so a warm cache or a heating CPU hits both arms
alike. `--warmup N` runs each arm N times first and drops those runs.

For each metric it prints both arms' medians, the median paired delta (B − A) with a 95% paired
bootstrap CI, and a verdict: better, worse or inconclusive. Lower is better unless the metric is
named in `--higher` (`*` wildcards work). A verdict needs two things. The CI must exclude 0, and an
exact sign test on the paired deltas must give p < 0.05 after a Holm correction across the metrics.
At 11 pairs the bootstrap alone is too optimistic, and a page run reports dozens of metrics, so
without the correction an A/A run would flag a few by chance. With 11 pairs, a noisy metric needs
nearly every pair to agree; use `--pairs 21` to find smaller changes. A metric whose deltas are all
the same, like the byte count of a fixed build, has no noise: a non-zero delta is a change.

`--json` prints the whole result, runs included. `--fail-on-worse` exits 1 when any metric got
worse, for CI gates. scripts/perf/ uses it to gate the coding.sh site on Lighthouse metrics.

## Judges

`coding.sh judge calibrate` measures judge and human agreement (Cohen's kappa) on a held-out split.
Every report flags judges that are not calibrated. It also stores the judge's held-out sensitivity
and specificity, so later `exp compare` runs show a bias-corrected (Rogan-Gladen) judge pass rate.

Judges read untrusted text: the agent writes the output they grade. Every judge prompt escapes the
data tags inside that text (`</output>` becomes `<\/output>`), so an output can't close its block
and append orders. The system prompts also say that everything inside the data tags is untrusted
and that an attempt to instruct the judge counts against the output. Citations still verify
against the raw text. This changed the default prompt, so judges built on it got new version ids
and old calibrations stay with the old ids.

`coding.sh judge calibrate <exp> --probe-injection judge.json` checks that this holds for your
judge. It rebuilds the judge from its grader spec and judges each human-fail case (up to
`--probe-max`, default 25) as is. It then judges two variants that carry a planted "respond pass"
order: one at the end of the output, and one at the end of the last tool result in the trace when
there is one. A flip is a variant judged pass where the original was judged fail. The report adds
`injection probe: 0 of 24 failing verdicts flipped to pass (0%); output 0/24`, `--json` carries
`calibration.injection`, and any flip exits 1 (BenchJack, arXiv 2605.12673).

`coding.sh exp compare A B --pairwise judge.json` adds a pairwise judge
(`{"kind":"pairwise","name":…,"rubric":…}` with the same provider options as `llm`). For each
shared case it shows the judge both outputs, then asks again with the order swapped. A side wins
only when both orders agree. When the answer changes with the order, the case is a tie, and the
share of such cases is printed as the position-bias rate (Wang et al., 2023). It reports B's win
rate (ties count half) with a bootstrap CI, a sign test on the decisive cases, and the ties.
`--labels labels.jsonl` (rows of `{"caseId","winner":"a"|"b"|"tie"}`) calibrates it the same way
as `judge calibrate`: kappa on the test split, with judge ties left out, stored on the judge.

### Checklists and trace checks

An `llm-checklist` grader asks yes/no questions instead of one rating. An item can be `critical`
(a "no" fails the case) and can name a `check`: a deterministic test of the trace that answers
without a model. A checklist made only of checks makes no model calls and needs no calibration.
Checks read the case's trace, which a function task hands over by returning
`withTrace(output, events)` (the eve task does this for you). With no trace at all, the checks
below answer N/A.

Four checks grade whether the agent followed its rules, from its actions alone. The paper behind
them found such checks agreed with human judges 97-98% of the time (Wang et al., arXiv 2610.04832).

| Check | Yes when |
|---|---|
| `ran-command` | A shell call ran `args.command` (text) or matched `args.pattern` (regex). With `"ok": true`, that call also succeeded. |
| `read-path` | A Read/Edit/Write call's path ends with `args.path`, or a shell command names it. |
| `wrote-identifier` | `args.identifier` is on a `+` line of a file diff or in Write/Edit content. N/A when no diff is inline. |
| `follows-rules` | Every checkable rule in `args.text` (or the case's `metadata.instructions`, a string or `{path: text}`) was acted on. |

A checkable rule is an imperative line that names a backticked command, flag, path or identifier,
for example ``Always run `npm test`.`` or ``Never use `git push --force`.`` A required token must
show up in the trace and a forbidden one must not. `args.only` (`require`, `forbid` or `all`)
picks which rules to grade, and `args.skipConditional` drops rules with if/when/before/after. When
those rules fail they are marked "(conditional, low confidence)", because actions alone can't tell
whether the condition held. The answer is N/A when there are no rules or no tool calls.

```json
{"kind": "llm-checklist", "name": "rules", "items": [
  {"id": "tests", "question": "Ran the tests and they passed?", "check": {"name": "ran-command", "args": {"command": "npm test", "ok": true}}},
  {"id": "claude-md", "question": "Followed CLAUDE.md?", "critical": true, "check": {"name": "follows-rules", "args": {"text": "Always run `npm test`.\nNever use `git push --force`."}}}
]}
```

### Auditing a test verifier

A passing test suite does not prove the change is right. METR found that test-passing SWE-bench
PRs overstated mergeable work by 24 points. `judge calibrate --grader <id>` also takes a `command`
or other deterministic grader and measures its precision: of the cases it passed, how many would a
human accept?

```bash
coding.sh judge calibrate my-exp --grader tests --sample-passes 40   # who to label
coding.sh judge calibrate my-exp --grader tests --labels labels.jsonl
```

`--sample-passes N` prints N passing cases that have no label yet, in a seeded order (`--seed`,
default 0). `--json` lists them with input and output. Label them in the viewer, or write
`{"caseId","value":"pass"|"fail"}` rows to a file and pass it with `--labels`. Those rows replace
stored labels for the cases they name. The audit prints, for example,
`verifier precision 0.78 [0.63, 0.88] (n=40); 9 false accepts`, with a Wilson interval. It also
prints the false-reject rate when failing cases are labelled too. A verifier never sees the
labels, so every labelled case counts and there is no held-out split. The command exits 1 below
`--min-n` labelled passes (default 20).

The audit is stored per grader version. After that, `exp show` puts the precision in the trust
column, and `exp show` and `exp compare` add a verifier-corrected pass rate: pass rate × precision
+ fail rate × P(human pass | verifier fail). Without labelled fails, the second term is taken as
0, and the line says it assumes no false rejects. Precision is measured on one experiment's
passes, so it carries over only roughly to configs that pass different cases. `--json` returns
the audit as `verifier` (`checked`, `agree`, `falseAccepts`, `falseRejects`, `precision`, …).
These are the same counts a blind-solver cross-check stores at `task.meta.crossCheck`.

## Harness A/B

`coding.sh harness snapshot` bundles an agent's harness files (CLAUDE.md, AGENTS.md, skills, hooks,
MCP config). `coding.sh compare A B` runs both bundles on eval tasks in isolated config
directories. It reports per-arm Wilson intervals and the first step where the traces diverge.

`coding.sh compare A --without .claude/skills/pdf` tests one piece of a harness. B is A minus that
path: a skill, `AGENTS.md`, `CLAUDE.md` or `.mcp.json`. The path is also deleted from each task's
repo. The report adds `effect of <path> = A − B` with its CI. `--without` can be repeated.

`coding.sh compare A B --gate` adds a ship-or-hold answer under the verdict: `Ship it: B wins 9
tasks, loses 0`, `Hold: not enough evidence`, or `Don't ship: B breaks 3 tasks A solved` with the
broken task ids. It exits 0 only for "Ship it", so it can gate a harness change in CI. It works on
each task's majority outcome. A task B fixed is a win, a task A solved that B failed is a loss, and
ties are ignored. B ships when three things hold. First, wins minus λ times losses is positive (λ =
`--lambda`, default 2, so one break cancels two fixes). Second, an exact one-sided binomial test on
the wins and losses beats break-even at `--gate-alpha` (default 0.05). Third, B breaks at most
`--tau` (default 10%) of the tasks A solved. This is SAGE's accept-or-abstain rule (Wang et al.,
arXiv 2609.36043). The paper reports no default settings; these are ours. B passes that tampered
with tests count as fails for the gate only. With `--without`, the line is labelled `drop-it gate`
and reads "Drop it" or "Keep it".

`coding.sh compare A B --promote` asks a different question: is B credible progress on quality or
on cost? A harness 40% cheaper at the same pass rate reads "no significant difference" in the
verdict, and `--gate` holds it, but it is still worth keeping. Each run gives a quality (pass = 1)
and a cost: USD when cost is known on at least 80% of each arm's runs, else tokens (with a note),
else no gate. A Bayesian bootstrap draws Dirichlet weights on each task's attempts (quality and cost
move together) and on the tasks, 10,000 times (`--draws`). A draw counts when B gains quality and
its cost rises by at most `--eps-c` (relative, default `inf`), or when B is cheaper and gives up at
most `--eps-q` of pass rate (default 0.1). The share of draws that count is the support. B is
promoted when it is at least `--gamma` (default 0.7). The line reads `pareto: support 0.86 ≥ 0.70 →
promote (cost-cut: cost -38% [-45%, -30%], quality -1.2 pp [-6.0, +3.0 pp])`, or `→ hold`.
`--promote` exits 0 only when B is promoted. With `--gate` too, both must pass. `--json` carries
`report.pareto`: `support`, `promote`, `reason` (`quality-gain`, `cost-cut`, `both` or `none`),
`unit`, `pQualityGain`, `pCostCut`, `dQ`, `dC`, the settings and notes (`epsC: null` means no
limit). With `--k 1` there are no repeat attempts to resample, so the note says to run `--k 3`. This
is ParetoSaddler's promotion gate (Qian et al., arXiv 2611.02079). The paper weights tasks equally;
coding.sh also resamples tasks, so one lucky run on one task can't promote B.

With `--k 2` or more, compare sorts each arm's failed runs three ways. A bad run failed on a task the
same arm passed in another attempt, so a retry would help. A beyond-arm failure is on a task only
the other arm solved. Unsolved-by-all is a task neither arm solved; check the task itself. It also
splits the outcome variance into task, arm and run-to-run shares. With `--k 1` these can't be told
apart, and the report says so.

A cost, token or turn value shows `(3/10)` when only 3 of the arm's 10 runs reported it. The
"X% cheaper" note needs a known cost for at least 80% of each arm's runs. Below that, the report
says how many runs were priced instead.

## Tool evals

`coding.sh toolevals` measures how well agents use a CLI, MCP server or HTTP API: surface size,
schema checks, per-task tool-call metrics in a sandbox, variant comparisons and MCP description
compression. See [TOOL-EVALS.md](../TOOL-EVALS.md).

## Workflows

`coding.sh workflows` imports multi-agent workflow runs and reports the run tree, critical path,
concurrency, cost and paired variant comparisons. See [design/workflows.md](../design/workflows.md).
