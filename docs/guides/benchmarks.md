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

`usage` can also carry `cacheReadTokens` and `cacheWriteTokens`. Input and output tokens are kept
apart in every record, so the report can show both.

The definition lives in `bench/answers.toml`. Edit it to change sampling, limits or contenders.

## Sources

| `kind` | Cases come from | Default visibility |
| --- | --- | --- |
| `command` | a script that prints JSONL | private |
| `sessions` | your recent failed or flagged sessions in the coding.sh index | private |
| `github` | issues or PRs created in the last `since` (7d), via `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` | public |
| `urls` | a sitemap, a URL list file, or `urls = [...]` | public |
| `dataset` | a sample of an existing coding.sh dataset | private |

The GitHub window is on `created_at`. An old issue that got a comment yesterday is not a new case.

For `urls`, each sampled page is fetched once when the sample is frozen. Its body is stored, and
its hash is part of the case list, so the frozen set records what the page said that morning.
Graders compare against that snapshot. Contenders still get the URL and fetch it themselves.

A `sessions` source can't be used with agent contenders yet. Those cases need the repo as it was
when the session started, so use `coding.sh eval` for session replays.

## Contenders

Two or more, each with a `name`:

- `command = "node small.mjs"`: any program; runs from the project root.
- `url = "https://…"`: an HTTP endpoint that gets the input as a JSON body. Put keys in `headerEnv`.
- `agent = "claude-code"` (with `model`, `harness`, `prompt`): a coding agent, run headless.

`costPerRun` sets a fixed price per call for contenders that don't report cost. `version` is a label
that gets recorded with each run. Agent versions are detected.

Each call's cost records where it came from, checked in this order:

1. **reported**: the contender's own `costUsd`.
2. **costPerRun**: the fixed price in the definition.
3. **price table**: tokens times the model's list price. This uses the same table as the rest of
   coding.sh, with your `[prices."<model>"]` overrides from the config. The run records when the
   table's prices were last checked.
4. **unknown**: no cost, no price and no tokens to price. These calls count as unknown, not as free.

`bench show` and the report list the mix for each contender, for example "8 reported, 4 price table".

## Fairness

- **One frozen set.** Before any contender runs, the sample is saved as a dataset version
  (`bench-<name>`). Its sha256 is recorded, and every contender runs exactly that set.
- **Random, interleaved order.** Cases are shuffled by the seed, and the contender order is shuffled
  for each case. No contender always goes first, and a slow hour hits everyone.
- **Same limits.** `timeoutMs` and `retries` are set once, at the top of the file, and apply to every
  contender. A per-contender timeout is an error.
- **Exclusions are shared.** A 401, 402 or 429, a quota or rate-limit error, or a grader that fails
  twice means the case couldn't be measured. It is dropped for every contender, so comparisons stay
  paired, and the count is shown. Above 2% the run is marked degraded. Above 10% no winner is
  declared. Timeouts and crashes are failures, not exclusions.
- **Fresh by default.** A case tested in an earlier counted run is never sampled again
  (`fresh = false` to allow repeats). The ledger keeps two things for each tested case: its key and
  a hash of its content. So the same content under a new key is not fresh either. For `urls` the
  content is the page body: a page that was already tested under another URL is swapped for the next
  candidate. Caps such as `maxPerHost = 3` and `maxPerOrg` apply after the seeded shuffle, so they
  keep a random few, not the first few.
- **No rerunning until it looks good.** History counts the first complete plain `bench run` for each
  date. A run with `--seed`, `--cases` or `--date`, a second run on the same day, a run stopped by
  the budget and an interrupted run are all kept and listed, but never charted. They also don't use
  up fresh cases.
- **Published inputs.** The seed, the case list, its sha256, each case's content hash, every
  contender's model and version, and the coding.sh version are in each run record. When a key comes
  back with different content (an edited issue, a changed page), `bench history` and the report say
  so: scores on either side of the change measure different things.
- **A seed nobody can predict.** With a public source and `seed = "date"`, anyone can compute
  tomorrow's sample. `seed = "secret"` fixes that; see [Secret seeds](#secret-seeds).
- **Secrets stay out.** Cases are redacted with the same secret scanner as capture before they are
  frozen. Outputs are redacted before they are stored.

## Statistics

The leaderboard shows each pass rate with a 95% interval. With one trial per case that is a Wilson
interval. With several trials it is a bootstrap that resamples cases, because the trials of one case
are not independent.

Each pair gets a paired bootstrap interval for the pass-rate gap. That interval is not adjusted for
the number of pairs. The verdict uses an exact McNemar test on the cases where only one side passed,
Holm-adjusted across pairs. Contenders whose difference is not significant share a place. Latency and
cost also get a geometric-mean ratio over cases both answered.

`bench new` and `run --dry-run` print the smallest gap your case count can detect and how many cases
a 10-point gap needs. Small benchmarks only find big differences.

One day is a small sample. `bench history --vs <contender>` and the report also pool each
contender's daily gaps over the last `window` counted runs (default 28, set in the definition so it
is chosen before you see results). They show:

- the pooled gap with a 95% interval that allows the true gap to vary from day to day
  (DerSimonian-Laird, with the Hartung-Knapp correction);
- where one more day's gap should land (from 5 runs on);
- I², the share of the day-to-day spread that is real rather than noise.

Pooling stops at a protocol change or a change to the contender, the same places where the trend
lines break.

Every day draws new cases, so some days are harder than others. The report's difficulty chart shows
the mean pass rate over all contenders per day. When every contender drops on the same day, the
sample was probably harder. An anchor set makes that clear.

## Anchor set

```toml
[anchor]
cases = 30
version = "1"
```

The anchor set is a fixed sample that runs every day next to the fresh cases. It is picked once,
from the first run's pool, and stored in the run records. After that, every run reuses it until you
change `version` or `cases`. Anchor cases are scored apart from the fresh ones: the leaderboard,
verdicts, history and freshness ledger use fresh cases only. The anchor numbers have their own
column, chart and head-to-head table.

The anchor trend has no day-to-day difficulty in it, so you can read it straight. If fresh pass rates
drop and the anchor holds, the day was harder. If both drop, the contenders got worse. Because the
cases never change, they can leak into training data over time. Bump `version` now and then, and
always read the anchor next to the fresh numbers.

```sh
coding.sh bench history answers --anchor
coding.sh bench history answers --anchor --vs small
```

## Secret seeds

```toml
seed = "secret"
```

Each date's salt is an HMAC of `<name>:<date>` under a key in `CODING_SH_BENCH_SEED_KEY` (rename it
with `seedKeyEnv`). Keep the key out of the repo; in CI it is a secret. The seed is
`<name>:<date>:<salt>`.

Each run reveals its own salt in the record and the report, and publishes the sha256 of the next
date's salt. When the next run reveals its salt, anyone can check that it hashes to the value
published the day before. That shows the sample was fixed before the run, not picked after looking.
`bench show` runs the check and exits 1 if it fails. `run --dry-run` hides the salt.

The same key and date always give the same seed. Lose the key and the chain breaks: the next run
can't match what the last one published.

## Budget

```toml
budget_usd = 5
```

Before running, coding.sh estimates the cost from `costPerRun` or from each contender's average in
its last run. Above the budget, the run does not start. During the run, no call starts if it could
cross the cap. A run that stops at the cap is saved as incomplete and stays out of history.
`bench schedule --install-cron` and `--workflow-out` refuse to install a benchmark without a budget.

## Resuming a run

```sh
coding.sh bench run answers --resume             # the latest incomplete run
coding.sh bench run answers --resume --run 2026-11-04
```

A run stopped by the budget or by Ctrl-C can be finished later. `--resume` reads the stored record
and keeps its seed, its frozen cases and its job order. It keeps every call that finished and runs
only the rest. The record keeps its id, and spend continues from the stored total. To let a
budget-stopped run finish, raise `budget_usd` first. The budget is not part of the protocol, so
changing it is allowed.

`--resume` refuses when the protocol or a contender's definition changed since the run started. In
that case the stored cells and the new ones would not be comparable. Once finished, the run counts
for its original date, unless another run has counted for that date in the meantime. Then it is
kept as adhoc.

## The report

`coding.sh bench report <name> --out <dir>` writes `index.html` and `report.json`. The page is one
self-contained file with no scripts and no external assets, so you can publish the folder as is.

- **Leaderboard**: the latest counted run, with places, pass rate, latency, cost (and where it came
  from), tokens in and out, and errors. With an anchor set, its pass rate is a column.
- **Trend**: pass rate, median latency and cost per day. A dashed line marks a protocol change
  (sampling, source, graders or limits): the values on either side are not comparable. Adding a
  contender is not a protocol change.
- **Gap to the reference**: each contender's pass-rate gap to `reference` (default: the first
  contender), on the cases both ran that day. Easy and hard days cancel out here. Below it, the gap
  pooled over the window.
- **Difficulty**: the mean pass rate per day, for fresh cases and the anchor set.
- **Anchor set**: its leaderboard, trend, gap chart and head-to-head table, when the definition has
  one.
- **Head to head**: every pair, with the paired interval, McNemar and Holm p-values.
- **Where each contender fails**: failure reasons per contender, then its worst cases with a link
  to the session when there is one.
- **Method and audit**: source, sampling, seed (with the revealed salt, its check and the next
  commitment for a secret seed), limits, exclusions, cost sources, versions, cases whose content
  changed, the case list and every run, including the ones not charted.

Reports are safe to publish by default. Local paths are removed. For private benchmarks, case
inputs, outputs and session links are left out and only case ids are listed. The sha256 still pins
the set. `--include-private` adds them back for a copy you keep locally.

`coding.sh bench history <name> --vs <contender>` prints the same paired gaps in the terminal.

## Regrading

Every answer is stored in full. After you fix a grader, `coding.sh bench regrade <name>` (or
`--all`) scores the stored outputs again and writes new records. Contenders are not called, and
history uses the newest regrade of each day.

Before scoring, regrade checks the stored inputs. The case list must still hash to the recorded
sha256, each case must still match its content hash, and each page snapshot on disk must still have
the body hash pinned at freeze. A mismatch is a warning on the new record.

## Scheduling

```sh
coding.sh bench schedule answers                 # print a cron line and a GitHub Actions workflow
coding.sh bench schedule answers --install-cron  # add the line to your crontab, after asking
coding.sh bench schedule answers --workflow-out .github/workflows/bench-answers.yml
```

Printing is the default. `--install-cron` adds or replaces only this benchmark's marked line.

The workflow pins the coding.sh version it was generated with. It has an `env:` block for every
secret the definition reads (`tokenEnv`, `apiKeyEnv`, `headerEnv`, and the seed key for
`seed = "secret"`), and it defaults to a
self-hosted runner, which keeps run records on disk. On a hosted runner it restores history from
the previous run's artifact and uploads it again after the run.

## Files

```
bench/<name>.toml                          definition (or ~/.coding.sh/benchmarks/<name>.toml)
~/.coding.sh/benchmarks/<name>/runs/       one JSON record per run
~/.coding.sh/benchmarks/<name>/blobs/      full outputs and page snapshots, by sha256
~/.coding.sh/benchmarks/<name>/report/     default report folder
```

History, freshness and reports are rebuilt from these records alone, so you can copy the folder
between machines. Each run also stores one experiment per contender, so `coding.sh exp compare`
works on benchmark runs. Agents can read the list, results and history with the `benchmarks` MCP
tool.
