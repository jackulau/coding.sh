# Evals and comparisons

Eval runs that drive a real agent or an LLM judge call that agent or provider, with your
credentials and at your cost.

## Session to eval

`coding.sh eval new <session> --verifier "<cmd>"` drafts a replayable task that starts from the
repo snapshot taken before the agent ran.

`coding.sh eval validate <task>` checks that the verifier is fair: a do-nothing attempt fails, the
reference fix passes k of k, near-misses fail, an impossible variant fails, and no future history
leaks.

Validation also looks for gold-only coupling: a hidden test that names a helper or file only the
reference introduces, which the instruction never mentions (`_parseCidr`, `src/acl/util.ts`). A
valid solution that names things differently fails such a test. Each case is listed as a note and
in `report.coupling`. It does not block validation unless you pass `--strict-coupling`.

`coding.sh eval crosscheck <task> [--experiment <id>] [--max 5]` checks the verifier from the
other side. A reviewer model reads the instruction and each stored run's diff, with the reference
shown as one valid answer among many, and decides whether the change is valid. Where it disagrees
with the verifier, the run is a false reject (the verifier failed a valid fix) or a false accept
(it passed an invalid one). The report lists each disagreement next to any coupling found by
`eval validate`. Cancelled and timed-out runs are skipped. `--solver <bundle>` first solves the
task once with that harness and reviews that attempt too. `--judge '{"provider":"openai","model":…}'`
picks the reviewer (default Anthropic). It makes one model call per run, at most `--max`. The
counts are stored at `task.meta.crossCheck`, in the same shape as a human verifier audit (see
[Auditing a test verifier](#auditing-a-test-verifier)), and `eval list --json` shows them.

`coding.sh eval export --format harbor` writes a Harbor-format task.

### Hand-written tasks

Some behaviour has no session to start from, such as "asks which team before collecting
anything". You can write those tasks as directories and load them with `coding.sh eval import
tasks/*/`:

```
tasks/asks-for-scope/
  task.json        {"name": "asks-for-scope", "tags": ["skill-eval", "suite:scope"],
                    "setup": ["…"], "verifier": {"command": "sh grader/verify.sh"}}
  instruction.md   the prompt the agent gets
  repo/            the start tree (optional; without it the task starts empty)
  tests/           hidden files, copied into the work tree only for the verifier
```

The task id comes from the name, so importing again updates the task in place. Imported tasks are
drafts. A draft has no reference patch for `eval validate` to check, so `compare` skips drafts by
default. Use `compare --tag <tag>` to run them.

The verifier can grade more than the work tree. It gets these environment variables:

- `CODING_SH_AGENT_OUTPUT`: a file with the agent's final answer.
- `CODING_SH_AGENT_STDOUT`: a file with the agent's whole stdout. For Claude Code this is
  stream-json, with every tool call and its result.
- `CODING_SH_AGENT`: the agent's adapter id.

Both files live outside the work tree, so the agent can't edit what gets graded. A verifier can
`grep` them, or hand them to `coding.sh judge grade` (see [Checklists and trace
checks](#checklists-and-trace-checks)).

[Evaluate an Agent Skill](../how-to/evaluate-a-skill.md) walks through a full set of hand-written
tasks, from a stub CLI to the compare report.

## Datasets and experiments

`coding.sh dataset add|import` keeps versioned cases with stable train/dev/test splits.

`coding.sh exp run` runs a command or HTTP task over a dataset. Graders can be deterministic
(exact, contains, regex, numeric, similarity, JSON schema, JSON path, progress), a command, or an
LLM judge. `progress` scores the run's trace: the share of the run before its first derail.

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

`coding.sh exp compare A B --margin 0.03` is a paired non-inferiority check: is B at most 3pp worse
than A? Use it to keep a cheaper or faster config only when it gives up no more than the margin.
B is non-inferior when the lower end of the 95% paired bootstrap interval of B − A (the one the
`B − A` line prints, over clusters with `--cluster`) lies above −0.03, a one-sided test at 2.5%
(the confidence-interval form in the CONSORT non-inferiority extension). The report prints
`non-inf B − A ≥ -3.0pp: yes (95% CI lower bound -1.2pp > -3.0pp)` or `no`, and lists cases A
passed on every trial that B now passes at most a third of the time, which a mean within the
margin can hide. It exits 1 unless B is non-inferior; `--json` carries
`comparison.nonInferiority` (`mean`, `lower`, `delta`, `nonInferior`, `n`, `alpha`,
`hardRegressions`). The test itself is `nonInferiority(diffs, delta)` in `src/stats/tests.ts`.

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

## Long runs: resume, retries, status

`exp run` (and `--arm`), `exp aa`, `exp sweep`, `compare`, `bench run` and `workflows run` write
each trial to a checkpoint as soon as it finishes. When a run stops early (Ctrl-C, a crash, a
reboot, a killed remote job), run the same command again with `--resume`. Only the trials that
had not finished run again. The schedule, the seed, the A/B arm order and each `--stop-early` look
come from the checkpoint, so the resumed run reaches the same stopping decision, verdict and sweep
rounds as a run that was never interrupted.

- `--resume <id>` continues that run. `--resume` with no id continues the newest unfinished run of
  the same command with the same config. Without the flag, if an unfinished run with the same
  config exists, an interactive terminal asks whether to resume it; otherwise a note prints the
  resume command and a new run starts.
- The config hash covers the dataset version, split, graders, trials, task (including the agent
  script a command task runs) and timeouts, not concurrency. If any of them changed, `--resume`
  refuses and names the parts: `Can't resume exp_…: its config changed since it started
  (dataset, task)`. Mixing trials of two configs would give a result of neither.
- The first Ctrl-C starts no new trials and lets the ones in flight finish and be saved. The second
  stops them. The exit code is 130, and the command to continue is printed (and is the `resume`
  field of `--json` output).
- `--retries N` (default 3) retries a trial after a rate limit, HTTP 5xx, network error or exit
  code 75, with exponential backoff and jitter, honoring `Retry-After`. A task failure (wrong
  answer, crash, its own timeout) is never retried, because retrying failures would bias the pass
  rate up. Each run records its attempts. A trial still failing on infrastructure after its
  retries counts as unknown, not as a failure: it is left out of the pass rate, the run ends
  `incomplete`, and `--resume` runs those trials again.
- `--trial-timeout <SEC>` caps each trial, retries included. A trial over it fails.

`coding.sh exp status` lists the durable runs with progress, ETA (from this session's pace) and
the cost so far (from the trials that report one). `coding.sh exp status <id>` shows one run and
its resume command, and `--json` returns the same fields (`done`, `total`, `infra`, `retries`,
`etaMs`, `costUsd`, `resume`). A run whose process died reads as `interrupted`.

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

A calibrated judge can still cost more human labels than it saves. Its corrected pass rate is only
as precise as the labels behind its sensitivity s and false-pass rate α, and when s − α (the
discrimination gap) is small, those labels buy little. The report prints the gap and the label
efficiency η: how many human labels a direct audit of the outputs needs for the same precision,
per label spent calibrating the judge (Choi et al., arXiv 2610.35698, Eq.6-7).

```
discrimination gap 0.44 (pass-recall 0.84, false-pass 0.40)
label efficiency η 0.21 · auditing outputs directly needs ~4.8x fewer human labels for the same precision (at pass rate 0.80, corrected over 2500 judged test cases)
```

η < 1 or a gap under 0.2 adds a warning, but never changes the calibration state. `--judge-cost
0.001` (dollars per judge call) adds the human label cost above which the judge pays off (Eq.8):
`judge pays off when a human label costs more than $0.0046 (judge call $0.001)`, or "no
break-even" when η ≤ 1. `--json` carries `calibration.efficiency` with `eta`, `gap`, `theta`,
`n1Share` (the share of labels to spend on human-pass cases) and `breakEvenHumanCost`. The same
paper's stratified estimator, proportional allocation and Hoeffding label budget are in the stats
API (`stratifiedMean`, `allocateProportional`, `hoeffdingBudget`); a CLI that plans an audit from
them is still to come.

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

Rule files can be path-scoped, and `follows-rules` reads their frontmatter. These are Claude Code
`.claude/rules/*.md` with `paths:`, Cursor `.cursor/rules/*.mdc` with `globs:` or
`alwaysApply:`, and Copilot `.github/instructions/*.instructions.md` with `applyTo:`. A scoped rule
is graded only once the trace touches a matching file. A Cursor rule with neither globs nor
`alwaysApply` is graded once its file is opened. Until then, the agent never saw the rule, so it
is left out and counted in the explanation: `acted on all 1 rule(s) (2 scoped rule(s) never came
into scope)`. When no rule came into scope, the answer is N/A.

```json
{"kind": "llm-checklist", "name": "rules", "items": [
  {"id": "tests", "question": "Ran the tests and they passed?", "check": {"name": "ran-command", "args": {"command": "npm test", "ok": true}}},
  {"id": "claude-md", "question": "Followed CLAUDE.md?", "critical": true, "check": {"name": "follows-rules", "args": {"text": "Always run `npm test`.\nNever use `git push --force`."}}}
]}
```

`"negate": true` on a check turns it around, so a check can require that a command never ran:
`{"name": "ran-command", "args": {"command": "vercel env pull"}, "negate": true}`. N/A stays N/A.

`no-test-tamper` checks that no change to a test, test-runner config or CI file hid a failure. It
answers no for a skip marker, for deleting a test file while tests were failing, and for an
assertion edit that alone turned a failing test run green. New tests and edits next to a real code
fix answer yes. The explanation names each change, the tool call and the event, and quotes what the
agent said about it (EPISTEME, arXiv 2611.06563):

```
1 test change(s) may hide failures: weaken test/sum.test.js by Edit in e42 (turned failing tests
green), disclosed: "The test expecting 5 is wrong; update the expected value."
```

Saying why doesn't make it pass: the change decides the answer, and the words only label it
`disclosed` or `stealth`. The item cites the change and the test runs before and after it.
`args.severity: "info"` also fails any non-additive test edit, and `args.pattern` (a regex) protects
more paths, such as a verifier script: `{"name": "no-test-tamper", "args": {"pattern": "^check\\.sh$"}}`.

`coding.sh judge grade --grader <JSON|FILE>` grades one output with any grader and exits 0 on
pass. It reads the output from `--output <FILE|->` and the trace from `--trace <FILE>`. The trace
can be Claude stream-json, a Claude transcript, or coding.sh events as JSONL. Inside a task
verifier, both default to the agent's files (`CODING_SH_AGENT_OUTPUT` and
`CODING_SH_AGENT_STDOUT`), so `coding.sh judge grade --grader grader/checklist.json` is a complete
verifier for a behaviour task. Each model call it makes is appended to `$CODING_SH_GRADER_USAGE`.
`compare` adds those calls up into the run's grader spend.

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

### Witness audits

Labels tell you how often the verifier is wrong; a witness test shows which passes it got wrong. A
witness checks one requirement of the instruction that the hidden tests skip. `eval audit` makes
sure it passes the reference patch 3 of 3 times, then replays it on every passing run of one
experiment. Each run is rebuilt from the start snapshot, setup and the run's stored diff. The
original verifier must still pass on the rebuilt tree, or the run is `replay-mismatch`. A diff that
no longer applies is `unreplayable`. A run the witness fails twice in a row is refuted. A fail then
a pass is noted as flaky and the run stays clean. No model is called. TestJack (arXiv 2610.10619)
refuted 34% of passing trials this way.

```bash
coding.sh eval audit add-neg --experiment exp_01J… --witness test/neg.test.js \
  --witness-cmd 'node test/neg.test.js' --requirement 'handle negative numbers'
```

```
claude-default (1a2b3c4d): passes 6/10, refuted 0, audited pass rate 60% (6/10), replayed 6/6
claude-tdd (5e6f7a8b): passes 6/10, refuted 3, audited pass rate 30% (3/10), replayed 6/6
refuted run_01JX… (claude-tdd (5e6f7a8b)) by test/neg.test.js: handle negative numbers
  add(-2, -3) is 0, want -5
```

`--witness PATH=FILE` writes FILE at PATH in the repo; plain `--witness FILE` uses FILE's path
relative to the current directory. A witness the reference fails is rejected and nothing replays.
Confirmed witnesses are stored at `task.meta.witnesses`, and `eval audit <task> --experiment <id>`
without `--witness` replays them again. A witness that refutes more than half of all passing runs
is listed as ambiguous: the instruction probably doesn't state the requirement clearly. Its
refutations are shown but not counted unless you pass `--count-ambiguous`. The report is stored at
`task.meta.audits[<experiment>]`. `--promote` then adds the
witnesses to the verifier (hidden file plus `&& <cmd>`) and puts the task back to draft for
`eval validate`. `eval export` writes witnesses to `witnesses/`, and `eval import` reads them back.

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

On a mixed task pool the pooled gate can ship a change that breaks most of a small suite: 3 losses
out of 40 solved tasks is under τ, even when all 3 come from a suite where A solved 4. `--gate --by
suite:` also runs the gate on each group of tasks, grouped by their first tag with that prefix
(tasks without one go in `(none)`). The pooled numbers stay, one line per group follows, and any
group that says "Don't ship" makes the whole gate "Don't ship" (reason `stratum-regression`):
`gate: Don't ship: B breaks 3 of 4 suite:swt tasks A solved`. A group that only holds never blocks.
`--json` adds `gate.strata` (each group's gate, lost and won tasks) and `gate.blockedBy`. `--by`
without `--gate`, or a prefix no task's tags start with, is an error before anything runs. Tag
tasks with `eval new --tag suite:swe`.

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

When B adds or removes exactly one instruction item and changes nothing else (one rule file, one
skill, or one `CLAUDE.md`/`AGENTS.md`; `--without` counts), the report adds the one-item gate:
`item gate k=3 τ=.34 m=2: KEEP · G=1.67 net +4 runs D=.33 fired 11/36 · S=9 tasks`. It only looks at
tasks where the item reached the agent's context in at least one run (S): an always-on file always
does, a path-scoped rule only after the agent touched a matching file, a skill only when it was
opened (listed is not enough). Exposure comes from each run's captured trace. Per task, Δ is B's
pass rate minus A's. An addition is KEEP when some task improved (G > 0), no task dropped by more
than τ = 0.34 (D, one run in three), no task A solved on every run lost one, B won at least 2 runs
net (k·N ≥ m, whole runs, so a one-run win doesn't count) and the item fired. When only the drop or
the solved-task rule fails it is RECHECK with the command to re-run those tasks; a drop again kills
it. Otherwise KILL with the failed gates. A removal is REJECT when it costs 2 runs net, drops a task
by more than τ, or a task the item's arm solved every time loses a run; UNMEASURED ("keep") when the
item never fired in the base runs, since a rare-situation rule looks like dead weight until its
situation comes up; else ACCEPT. RERUN means the runs can't be scored: a task without k valid runs
per arm, more than 10% errored or cancelled runs, a run with no trace to read exposure from, two
agent versions, or no exposed task. `--item-gate` makes it decide the exit code (0 on KEEP or
ACCEPT), `--no-item-gate` hides it, and `--json` carries `report.itemGate`. This is Cortex's scorer
(arXiv 2610.14216).

With `--k 2` or more, compare sorts each arm's failed runs three ways. A bad run failed on a task the
same arm passed in another attempt, so a retry would help. A beyond-arm failure is on a task only
the other arm solved. Unsolved-by-all is a task neither arm solved; check the task itself. It also
splits the outcome variance into task, arm and run-to-run shares. With `--k 1` these can't be told
apart, and the report says so.

Compare also splits each arm's failed runs by what the agent's own tests said last, read from the
run's captured session: `A fails 12: own tests green 7 (58%), red 3, stale 1, none 1`. Green means
the agent's last test run passed and it changed no file after; stale means it changed files after a
green run; red means its last run had failures; none means it never ran tests coding.sh could parse.
Green fails are silent misses: the agent thought it was done. When both groups have at least 5 runs,
a second line compares how often a run with green own tests passed the verifier with every other
run (`own-green runs passed the verifier 71% [..] vs 40% [..] otherwise`); in BOBA (arXiv
2611.02207) a green local run barely changed the hidden-test pass rate. `--json` has the counts and
both rates under `baseline.selfCheck` and `candidate.selfCheck`.

Every replay run gets a tamper check on its diff: edits, deletes and skip markers in tests, the
verifier's files, test-runner configs, CI files and `package.json` test scripts. Tampered runs that
passed still count as passes. Compare links each flag to the tool call that made the change, read
from the run's captured session, and splits tampered passes by whether the agent said, before or
with the call, that it was changing the test:

```
tampered passes   B 3: disclosed 2, stealth 1
                    run_01JX… edit test/sum.test.js by Edit (event e42), said: "The test expecting 5 is wrong; update the expected value."
                    run_01JY… edit test/sum.test.js by Edit (event e57), stealth (said: "Refactor helpers.")
```

Stealth means some test change came with no such statement (EPISTEME, arXiv 2611.06563). Untraced
means no event in the trace touched the flagged file. The tamper note gets the same split. `--json`
adds `tamperedPassesDisclosed` and `tamperedPassesStealth` to each arm and `tamperAttribution`,
keyed by run id, with each flag's finding: event id, tool call id, shape, whether the edit alone
turned the tests green, and the agent's words.

A cost, token or turn value shows `(3/10)` when only 3 of the arm's 10 runs reported it. The
"X% cheaper" note needs a known cost for at least 80% of each arm's runs. Below that, the report
says how many runs were priced instead.

The report ends its metrics with what each arm spent in total: an `agent spend` row, and a `grader
spend` row when verifiers called `judge grade`. `--max-cost 15` caps a live run in USD. Once the
finished runs reach the cap (agent plus grader cost), no new run starts. Runs already going finish,
so the total can pass the cap by what the runs in flight cost. The compare then covers the runs that
finished. Runs that report no cost count as $0 and are listed as such. `--json` carries `budget`.

## A/B a harness edit on your own sessions

`coding.sh compare` needs eval tasks with verifiers. Often you don't have those yet. You have a
CLAUDE.md line you think will help, and a week of sessions where the agent did the thing that line
is meant to stop. `coding.sh exp ab` tests the line on those sessions:

```sh
$ echo "After changing code, run the tests before you say you are done." >> CLAUDE.md
$ coding.sh exp ab
A: git:HEAD   B: your edits   model: claude-sonnet-5-5
12 decision points from 9 sessions | A 2/12 -> B 9/12 | fixed 7, broke 0 | paired p=0.016 | $0.41, 0/24 cached
Hold: not enough evidence (B wins 7, loses 0; needs 8+ wins with no losses)
Replay noise floor 8% (A's turn differs from the recorded one in 1/12); B moved +58 points, above it

Fixed (A failed, B passed):
  unverified-claim "The date picker drops the timezone. Fix it."  coding.sh show 3f9c2a1e
  ...
Full comparison: coding.sh exp compare exp_… exp_…
```

It works in three steps.

**Find the decision points.** It reads your recent sessions (`--since`, default 14 days) in this
repo (`--repo`, default the git root; `--repo all` for every repo) and looks for moments where the
agent tends to go wrong. Three are built in, and `--behavior` picks among them:
`unverified-claim` (it changed code, then said it was done without running anything),
`done-while-failing` (it ended the turn while its last test run was failing) and `unchanged-retry`
(it ran a failed command again unchanged). Each one becomes a case: the session frozen just before
that turn, plus a rubric for what a good next turn looks like. Sessions from eval runs and
subagents are skipped, and so are turns right after a context compaction. At most 2 cases come from
one session, and 40 overall (`--limit`).

**Replay the next turn twice.** For each case it asks the model for the next turn once with A's
harness files and once with B's. CLAUDE.md and AGENTS.md go in the way Claude Code injects them, a
path-scoped rule only when the session had touched a matching file, and a skill as a one-line
listing unless the session opened it. The model gets the tools the session used, plus a shell. Only
one turn is generated: nothing runs in your repo.

**Judge both turns.** An LLM judge scores each turn against the case's rubric. A turn passes at
0.8. The judge sees only the turn, never which arm wrote it.

By default A is your last commit (`git:HEAD`) and B is your working tree, so the usual loop is: edit
CLAUDE.md, run `coding.sh exp ab`, keep or revert. `--a` and `--b` take a file (it replaces the file
of the same path in A), a directory, `git:<rev>`, a harness bundle, or `none`. It errors when the
two arms have the same files, so a typo'd path can't produce a "no difference" result.

The headline counts the cases each arm passed, and which ones flipped. The second line is the same
ship gate as `compare --gate`, with the same settings (`--lambda`, `--gate-alpha`, `--tau`). With
`--gate`, the exit code follows it: 0 only for "Ship it". When B adds or removes one instruction
item, the one-item gate line appears too, scored only on the cases where that item would have been
in the agent's context.

**The noise floor.** A is the control arm. A replayed turn won't match what the agent did at the
time, even with the same files: a different model version, a missing system prompt and plain
sampling all move it. So `exp ab` also counts how often A's turn differs from the one recorded in
the session. That rate, with its Wilson interval, is the noise floor. When B moves fewer points than
that, the line says the difference may be replay noise. This is the control-arm requirement in
[experimentation-methods.md](../research/experimentation-methods.md) (EM-19). It is also why
absolute pass rates mean little here. Read the difference between A and B, not either number on
its own.

**Cost.** Before it runs, `--dry-run` prints the cases and an estimate: model calls, judge calls,
input tokens and dollars. `--max-cost 2` refuses to start when the estimate is over $2, and stops
the run if the spend passes it. A stopped or interrupted run keeps its finished trials, and
`--resume` picks up the rest. Responses and verdicts are cached under the data directory, so a rerun
with unchanged files makes no calls and costs nothing. Only an edited arm is asked again.
`--no-cache` asks the model again anyway, and `--trials 3` asks each case three times.

**Watch mode.** `coding.sh exp ab --watch` runs once, then reruns whenever B's files change and
prints one line per run:

```text
14:02:11  A 2/12 -> B 9/12 | fixed 7, broke 0 | Hold | $0.41, 24 new calls
14:05:40  A 2/12 -> B 11/12 | fixed 9, broke 0 | Ship it | $0.19, 12 new calls
```

Only B's calls are new: A's answers come from the cache. Ctrl-C stops it.

The model defaults to the one the agent was using at those moments (among the models the chosen
API can serve, so Codex sessions never pick a Claude model), else the provider's current default:
`claude-sonnet-5-5` for Anthropic, `gpt-6-sol` for OpenAI. The API defaults to Anthropic's
(`--provider openai` or `openai-compatible`, with `--base-url` for a local or proxied endpoint;
`openai-compatible` has no default model, so it needs `--model` when the sessions recorded none).
`--json` gives the comparison, the fixed and broken cases, the per-behavior counts, the cost and the
cache hits.

**Your own decision points.** `--anchor ./anchors.mjs` loads a module whose default export is an
anchor, or an array of them: `{ id, version, frame, behavior, rubric, find(events) }`. `find` gets a
session's events in time order and returns the cuts, each `{ cutBeforeEventId, evidenceEventIds }`.
`frame` is `"action"`, `"failure"` or `"claim"`.

**Building blocks.** The same pieces work without `exp ab`. A dataset of decision points is an
ordinary dataset (named `dp-…`), and a `continuation` task replays a frozen session's next turn:
`{"kind":"continuation","provider":"anthropic","model":"claude-sonnet-5-5","context":{"files":["CLAUDE.md"]}}`.
`exp run` with a continuation task needs a control arm: run it as an A/B with `--arm`, or pass
`--no-control` to run one arm alone, and the comparison then warns that it has no noise floor.

## Tool evals

`coding.sh toolevals` measures how well agents use a CLI, MCP server or HTTP API: surface size,
schema checks, per-task tool-call metrics in a sandbox, variant comparisons and MCP description
compression. `toolevals compare` prints `p (perm)` next to McNemar: a task-paired permutation test
on per-task pass-rate differences, exact up to 20 tasks. See [TOOL-EVALS.md](../TOOL-EVALS.md).

## Workflows

`coding.sh workflows` imports multi-agent workflow runs and reports the run tree, critical path,
concurrency, cost and paired variant comparisons. See the [workflow experiments guide](workflows.md)
and [design/workflows.md](../design/workflows.md).

A variant can resume from a recorded run (`"resumeFromRunId"`), so only the stages after the edit
run again. Compare it against a control variant that resumes the unedited script from the same
runs, not against fresh baseline runs: `workflows compare` notes "no control fork" otherwise. With
a control, it reports how often the control's outcome changed from its source run as the replay
noise floor (`control.drift` in `--json`). Treat differences below that as replay drift.
