# Benchmarks

Compare two or more agents or models on new cases every day, drawn from a live source, so none of
them can be tuned to a fixed test set. The command is `coding.sh bench`.
Site version: [coding.sh/docs/benchmarks](https://coding.sh/docs/benchmarks).

Every contender (an agent or model you compare) gets the same frozen sample, in shuffled order, and the history shows who is ahead
today and over weeks. Runs call your contenders with your credentials and at your cost; set
`budget_usd` before you schedule one.

## The shortest run

Two contenders add two numbers: `large` always gets it right, and `small` gets some sums wrong. The
source, `gen.mjs`, prints one JSON case per line, like `{"input": "977 + 903", "expected": "1880"}`,
and reads the day's seed from `CODING_SH_BENCH_SEED`.

```sh
coding.sh bench new sums --command 'node gen.mjs' \
  -c small='node small.mjs' -c large='node large.mjs' -g '{"kind":"exact"}'
```

```text title=output
✓ Wrote bench/sums.toml
  With 50 cases and 1 pair, the smallest pass-rate gap this run can reliably detect is about 22 points (80% power, α 0.05).
  To detect a 10-point gap you need about 234 cases; 5 points, about 940 (assuming 30% of cases split the contenders, a guess until the first run).
```

`bench/sums.toml` holds the definition: sampling, limits, contenders and graders. This run sets
`cases = 30` in it. `coding.sh bench run sums --dry-run` prints today's sample without calling anyone.

```sh
coding.sh bench run sums
```

```text title=output
sums · 2026-11-11 · 30 cases · seed sums:2026-11-11 · sha256 e5b5ab1c98af
#	CONTENDER	PASS	95% CI	P50	P95	COST/RUN	ERRORS
1	large	100.0% (30/30)	88.6%-100.0%	1.49s	2.27s	-	0
1	small	83.3% (25/30)	66.4%-92.7%	1.56s	2.10s	-	0
large vs small: +16.7 pp (95% CI +3.3 to +30.0, unadjusted), McNemar p=0.063 (Holm) → no significant difference
Cost source: large 30 unknown; small 30 unknown
```

Both share first place: 30 cases are not enough to tell a 17-point gap from luck, as `bench new`
warned. Run it again tomorrow and `coding.sh bench history sums` pools the days.

A contender reads the case input as JSON on stdin and prints its answer. To report cost, tokens or
its model, it can print an envelope instead:

```json
{"output": 42, "usage": {"costUsd": 0.002, "inputTokens": 900, "outputTokens": 12}, "model": "small-2"}
```

## Sources

| `kind` | Cases come from | Default visibility |
| --- | --- | --- |
| `command` | A script that prints JSONL | private |
| `sessions` | Your recent failed or flagged sessions | private |
| `github` | Issues or PRs created in the last `since` (7d), via `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` | public |
| `urls` | A sitemap, a URL list file, or `urls = [...]` | public |
| `dataset` | A sample of a coding.sh dataset | private |

A `github` case is new when the issue was created in the window, not when it was last commented on. A
`urls` page is fetched once when the sample is frozen; contenders still fetch it themselves. A
`sessions` source can't be used with agent contenders yet.

## Contenders

- `command = "node small.mjs"`: any program, run from the project root.
- `url = "https://…"`: an HTTP endpoint that gets the input as a JSON body. Put keys in `headerEnv`.
- `agent = "claude-code"`, with `model`, `harness` and `prompt`: a coding agent, run headless.

| Field | What it does |
| --- | --- |
| `costPerRun` | A fixed price per call, for contenders that report no cost. |
| `version` | A label recorded with each run. Agent versions are detected. |
| `axes = { model = "…", harness = "…" }` | Places the contender on the model × harness grid. Labels only: changing them keeps the history. |

A call's cost is the contender's own `costUsd`, else `costPerRun`, else tokens times the model's list
price. A call with none of these is unknown, not free.

## Fairness

- **One frozen set.** The sample is saved as dataset `bench-<name>`, with its sha256, before any
  contender runs.
- **Shuffled, interleaved order.** Cases and the contender order per case are shuffled by the seed,
  so a slow hour hits everyone.
- **Same limits.** `timeoutMs` and `retries` are set once for everyone.
- **Shared exclusions.** A 401, 402 or 429, a quota error, or a grader that fails twice drops the
  case for every contender. Above 10% excluded, no winner is declared.
- **Fresh by default.** A case tested in an earlier counted run is never sampled again.
  `fresh = false` allows repeats.
- **No rerunning until it looks good.** History counts the first complete plain `bench run` per
  date. Runs with `--seed`, `--cases` or `--date`, same-day reruns and stopped runs are kept but
  never charted.
- **A seed nobody can predict.** With `seed = "secret"`, each date's salt is an HMAC under a key in
  `CODING_SH_BENCH_SEED_KEY`. Each run publishes the sha256 of the next salt, and `bench show`
  checks the chain.
- **Secrets stay out.** Cases and outputs are redacted before they are stored.

## What a run reports

| Number | How it is computed |
| --- | --- |
| Pass rate | 95% Wilson interval with one trial per case, a bootstrap over cases with several. |
| Gap between two contenders | A paired bootstrap interval, not adjusted for the number of pairs. |
| Verdict | An exact McNemar test, Holm-adjusted across pairs. Contenders with no significant difference share a place. |
| Detectable gap | `bench new` and `run --dry-run` print the smallest gap your case count can detect. |
| Pooled gap | `bench history --vs <contender>` pools the daily gaps over the last `window` counted runs (default 28), with an interval that lets the true gap vary by day (DerSimonian-Laird, Hartung-Knapp). |
| Routing headroom | With 20 or more cases: whether sending each case to a different contender would beat the best single one, tested against 500 simulations with no specialization. |
| Model × harness grid | With two or more models and harnesses, one contender each: pass rate per cell, the interaction, and rank reversals, with 2,000-draw bootstrap intervals. |
| Anchor set | With `[anchor] cases = 30`, a fixed set of cases runs next to the fresh ones. If fresh pass rates drop and the anchor holds, the day was harder. |

The formulas for the paired interval and McNemar's test are on
[How evals are computed](../reference/eval-methods.md).

## Budget, schedule and report

```toml
budget_usd = 5
```

A run whose estimate is over the budget does not start, and no call starts that could cross it. A
run stopped at the cap is saved as incomplete; `bench run sums --resume` finishes it after you raise
the budget.

```sh
coding.sh bench schedule sums --install-cron   # add a crontab line, after asking
coding.sh bench schedule sums --workflow-out .github/workflows/bench-sums.yml
coding.sh bench report sums --out ./public/bench
```

`bench schedule` refuses a benchmark without a budget. The workflow lists every secret the
definition reads and defaults to a self-hosted runner, which keeps run records on disk.

`bench report` writes `index.html` and `report.json`: one self-contained page with no scripts, with
the leaderboard, daily trends, head-to-head pairs, failures and the method. Reports leave out local
paths. For private benchmarks they also leave out inputs, outputs and session links;
`--include-private` adds them back.

:::more Files, regrading and more
- Run records live in `~/.coding.sh/benchmarks/<name>/runs/`, one JSON file per run, with full
  outputs in `blobs/`. History and reports are rebuilt from them alone, so you can copy the folder
  between machines.
- `coding.sh bench regrade <name>` scores the stored outputs again after you fix a grader, without
  calling the contenders.
- Each run also stores one experiment per contender, so `coding.sh exp compare` works on benchmark
  runs. Agents read results with the `benchmarks` MCP tool.
- Every command and flag is in the [CLI reference](https://coding.sh/docs/cli/bench).
:::
