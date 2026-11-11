# Benchmarks

A fixed test set goes stale. Contenders get tuned to it, and the cases leak into training data.
`coding.sh bench` draws new cases every day from a live source: a script, your recent failed
sessions, new GitHub issues, or a sitemap. It gives every contender the same frozen set and keeps
the history, so you can see who is ahead today and how that changes over weeks.

Benchmark runs call your contenders with your credentials and at your cost. Set `budget_usd`
before you schedule one.

## Quickstart

```sh
coding.sh bench new answers --command 'node gen.mjs' \
  -c small='node small.mjs' -c large='node large.mjs' -g '{"kind":"exact"}'
coding.sh bench run answers --dry-run    # see today's sample, what it can detect, the cost
coding.sh bench run answers              # run it
coding.sh bench history answers          # one row per day
coding.sh bench report answers --out ./public/bench
```

`gen.mjs` prints one JSON case per line, like `{"input": …, "expected": …, "metadata": {…}}`. It
gets the day's seed in `CODING_SH_BENCH_SEED`. A contender reads the case input as JSON on stdin and
prints its answer. To report cost, tokens or the model it used, it can print an envelope instead:

```json
{"output": 42, "usage": {"costUsd": 0.002, "inputTokens": 900, "outputTokens": 12}, "model": "small-2"}
```

`usage` can also carry `cacheReadTokens` and `cacheWriteTokens`. The definition lives in
`bench/answers.toml`; edit it to change sampling, limits or contenders. Every command and flag is in
the [CLI reference](https://coding.sh/docs/cli/bench).

## Sources

| `kind` | Cases come from | Default visibility |
| --- | --- | --- |
| `command` | a script that prints JSONL | private |
| `sessions` | your recent failed or flagged sessions in the coding.sh index | private |
| `github` | issues or PRs created in the last `since` (7d), via `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` | public |
| `urls` | a sitemap, a URL list file, or `urls = [...]` | public |
| `dataset` | a sample of an existing coding.sh dataset | private |

The GitHub window is on `created_at`, so an old issue with a new comment is not a new case. A
`urls` page is fetched once when the sample is frozen, and graders compare against that snapshot;
contenders still get the URL and fetch it themselves.
A `sessions` source can't be used with agent contenders yet; use `coding.sh eval` for session
replays.

## Contenders

Two or more, each with a `name`:

- `command = "node small.mjs"`: any program; runs from the project root.
- `url = "https://…"`: an HTTP endpoint that gets the input as a JSON body. Put keys in `headerEnv`.
- `agent = "claude-code"` (with `model`, `harness`, `prompt`): a coding agent, run headless.

| Field | What it does |
| --- | --- |
| `costPerRun` | A fixed price per call, for contenders that don't report cost. |
| `version` | A label recorded with each run. Agent versions are detected. |
| `axes = { model = "…", harness = "…" }` | Places the contender on the [model × harness grid](#model--harness-grid). Agent contenders get axes on their own. Labels only: changing them keeps the history. |

A call's cost is the contender's own `costUsd`, else `costPerRun`, else tokens times the model's
list price (with your `[prices."<model>"]` overrides). A call with none of these is unknown, not
free, and `bench show` lists the mix per contender.

## Fairness

- **One frozen set.** The sample is saved as dataset `bench-<name>`, with its sha256, before any
  contender runs.
- **Random, interleaved order.** Cases are shuffled by the seed, and the contender order is
  shuffled for each case, so a slow hour hits everyone.
- **Same limits.** `timeoutMs` and `retries` are set once, at the top of the file, for everyone.
- **Shared exclusions.** A 401, 402 or 429, a quota error, or a grader that fails twice drops the
  case for every contender. Above 10% no winner is declared. Timeouts and crashes are failures.
- **Fresh by default.** A case tested in an earlier counted run is never sampled again, even under a
  new key with the same content. `fresh = false` allows repeats.
- **Seeded caps.** `maxPerHost = 3` and `maxPerOrg` apply after the seeded shuffle, so they keep a
  random few, not the first few.
- **No rerunning until it looks good.** History counts the first complete plain `bench run` per
  date. Runs with `--seed`, `--cases` or `--date`, same-day reruns and stopped runs are kept but
  never charted.
- **Published inputs.** Each run record holds the seed, the case list and its hash, and every
  version. A case whose content changed under the same key is flagged.
- **A seed nobody can predict.** With a public source, `seed = "secret"` stops anyone from
  computing tomorrow's sample; see [Secret seeds](#secret-seeds).
- **Secrets stay out.** Cases and outputs are redacted with the capture secret scanner before they
  are stored.

## Statistics

Each pass rate gets a 95% interval: Wilson with one trial per case, a bootstrap over cases with
several. Each pair gets a paired bootstrap interval for the gap, not adjusted for the number of
pairs. The verdict uses an exact McNemar test, Holm-adjusted across pairs. Contenders whose
difference is not significant share a place.

`bench new` and `run --dry-run` print the smallest gap your case count can detect and how many cases
a 10-point gap needs. Small benchmarks only find big differences.

One day is a small sample, so `bench history --vs <contender>` and the report also pool the daily
gaps over the last `window` counted runs (default 28). The pooled gap has a 95% interval that lets
the true gap vary by day (DerSimonian-Laird with the Hartung-Knapp correction).

They also show where the next day's gap should land (from 5 runs on) and I², the share of the spread
that is real. Pooling stops at a protocol change or a change to the contender. When every contender
drops on the same day, the sample was probably harder; an [anchor set](#anchor-set) shows it.

## Routing headroom

Some contender usually passes a case the best one fails, so "pick the right contender per case"
always looks better than running the best one everywhere. Most of that gap is run noise. With 20 or
more counted cases and two or more contenders, each run tests it:

```text
Routing headroom: any contender 88.0% vs best single (claude) 70.0%: gap 18.0 pp; with no specialization expect 8.0-26.0 pp (p 0.44).
Upsets 31.7% of 60 split cells (expected 17.8%-42.1%, p 0.40).
No evidence of specialization: per-case routing is unlikely to beat running claude alone.
```

The gap is the share of cases any contender passed minus the best contender's pass rate. Upsets are
the split cases the weaker contender won. Both are checked against 500 simulations of a Rasch model
with no specialization (one ability per contender, one difficulty per case). The verdict is
"contenders specialize" when the smaller p-value, Holm-adjusted over the two, is below 0.05.

## Model × harness grid

When contenders cover two or more models and two or more harnesses, with one contender per
combination, the run reads them as a grid. A harness that is best with one model can be worst with
another, and a flat ranking hides that.

```text
Model × harness grid: 40 cases; pass rate and interaction Δp in pp (* = 95% CI excludes 0)
MODEL  H1             H2
m1     100.0% +17.5*  65.0% -17.5*
m2     65.0% -17.5*   100.0% +17.5*
Cross-model fit: h1 80.6 (70.7-89.4); h2 80.6 (70.7-89.4). h1 leads h2 by +0.0 (95% CI +0.0 to +0.0), not a clear lead.
Rank reversal: m1 leads m2 under h1, m2 leads under h2.
Leave-one-model-out regret: m1 35.0 pts (picks h2, best h1); m2 35.0 pts (picks h1, best h2); mean 35.0.
```

| Number | Meaning |
| --- | --- |
| p | Pass rate: each case's share of passing trials, averaged over cases. |
| v | Share of attempts that completed cleanly (no timeout, crash, error or empty answer). |
| J | Passed and completed cleanly. |
| Δp, Δv | Interaction, `x(m,h) − x(m,·) − x(·,h) + x(·,·)`, equal-weight margins. Positive: the pair beats its parts. |
| F | J as a share of the model's best J over harnesses. |
| Cross-Model Fit | Per harness, 100 × the geometric mean of F (0 when any F is 0). 100: every model's best. |
| Leave-one-model-out regret | Points of J a held-out model loses when the harness is picked by fit on the others. |
| Rank reversal | Two models whose order flips between two harnesses. |

Intervals are 95% from 2,000 case bootstrap draws. An incomplete grid is skipped.

## Anchor set

```toml
[anchor]
cases = 30
version = "1"
```

The anchor set is a fixed sample that runs every day next to the fresh cases, until you change
`version` or `cases`. It is scored apart: the leaderboard, verdicts and history use fresh cases.

If fresh pass rates drop and the anchor holds, the day was harder. If both drop, the contenders got
worse. Fixed cases can leak into training data, so bump `version` now and then.

```sh
coding.sh bench history answers --anchor
coding.sh bench history answers --anchor --vs small
```

## Secret seeds

```toml
seed = "secret"
```

Each date's salt is an HMAC of `<name>:<date>` under a key in `CODING_SH_BENCH_SEED_KEY` (rename it
with `seedKeyEnv`). Keep the key out of the repo; in CI it is a secret.

Each run reveals its own salt and publishes the sha256 of the next date's salt, so anyone can check
that a sample was fixed before its run. `bench show` runs the check and exits 1 if it fails.
`run --dry-run` hides the salt. Lose the key and the chain breaks.

## Budget

```toml
budget_usd = 5
```

A run whose estimated cost is over the budget does not start, and no call starts that could cross
the cap. A run stopped at the cap is saved as incomplete. `bench schedule --install-cron` and
`--workflow-out` refuse a benchmark without a budget.

## Resume a run

```sh
coding.sh bench run answers --resume             # the latest incomplete run
coding.sh bench run answers --resume --run 2026-11-04
```

`--resume` keeps the run's seed, frozen cases and job order, and runs only the calls that did not
finish. To finish a budget-stopped run, raise `budget_usd` first. It refuses when the protocol or a
contender's definition changed since the run started. A resumed run counts for its original date,
unless another run has counted for that date since.

## The report

`coding.sh bench report <name> --out <dir>` writes `index.html` and `report.json`. The page is one
self-contained file with no scripts, so you can publish the folder as is.

| Section | Shows |
| --- | --- |
| Leaderboard | Places, pass rate, latency, cost and its source, tokens and errors. |
| Trend | Pass rate, latency and cost per day; a dashed line marks a protocol change (sampling, source, graders or limits; adding a contender is not one). |
| Gap to the reference | Each contender's daily and pooled gap to `reference` (default: the first contender). |
| Difficulty, Anchor set | Mean pass rate per day; the anchor set's own charts and tables. |
| Head to head | Every pair, with the paired interval, McNemar and Holm p-values. |
| Routing headroom, Model × harness | The checks above. |
| Failures | Failure reasons, then the worst cases with session links. |
| Method and audit | Source, seed, limits, exclusions, cost sources, versions and every run. |

Reports leave out local paths. For private benchmarks they also leave out case inputs, outputs and
session links; `--include-private` adds them back for a copy you keep.

## Regrade after a grader fix

After you fix a grader, `coding.sh bench regrade <name>` (or `--all`) scores the stored outputs again
without calling the contenders. History uses the newest regrade of each day. A stored input whose
hash no longer matches is a warning on the new record.

## Run it every day

```sh
coding.sh bench schedule answers                 # print a cron line and a GitHub Actions workflow
coding.sh bench schedule answers --install-cron  # add the line to your crontab, after asking
coding.sh bench schedule answers --workflow-out .github/workflows/bench-answers.yml
```

`--install-cron` adds or replaces only this benchmark's marked line. The workflow pins the coding.sh
version, lists every secret the definition reads, and defaults to a self-hosted runner, which keeps
run records on disk. On a hosted runner it carries history between runs as an artifact.

## Files

```
bench/<name>.toml                          definition (or ~/.coding.sh/benchmarks/<name>.toml)
~/.coding.sh/benchmarks/<name>/runs/       one JSON record per run
~/.coding.sh/benchmarks/<name>/blobs/      full outputs and page snapshots, by sha256
~/.coding.sh/benchmarks/<name>/report/     default report folder
```

History, freshness and reports are rebuilt from these records alone, so you can copy the folder
between machines. Each run also stores one experiment per contender, so `coding.sh exp compare`
works on benchmark runs. Agents can read results with the `benchmarks` MCP tool.
