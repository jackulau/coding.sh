# Dynamic benchmarks: how to build `coding.sh bench` so the claim survives an audit

Compiled 2026-11-06 for the `coding.sh bench` feature: fresh cases on every run, seeded sampling, freshness
dedupe, a content-hashed frozen set per run, every contender on the same set, paired stats, `history`,
`report`, `schedule`, MCP read tools. Facts come from primary sources (papers, official docs, repos); each
claim cites its URL. **[U]** marks a point no primary source confirmed.

The trigger was TRACE (trace.context.dev): "if we're going to claim we're better, we should have to
prove it every single day." The one-line lesson from everything below: **a rolling benchmark is a
sequence of independent paired experiments, one per frozen set. Compare contenders only within a
set, and pool the paired differences across sets. Never compare absolute scores across sets.**

Contents: 1. TRACE · 2. Live benchmarks · 3. Product prior art · 4. Statistics, with formulas ·
5. Failure modes and gaming · 6. Design checklist (MUST/SHOULD/NICE) · 7. Fit to the existing code ·
8. Review of the in-progress implementation · Sources

---

## 1. TRACE (trace.context.dev), read 2026-11-06

What it is: a public benchmark of four web-scraping APIs (context.dev, which publishes it and says so,
Firecrawl, Exa, Keenable). It asks "how reliably can web scrapers read a page?"
<https://trace.context.dev>

**Cadence.** Despite the "every single day" pitch, the live page is **weekly**: "A new sample of about
2,500 never-tested pages is drawn every Friday at 00:15 UTC" (Vercel cron `15 0 * * 5`). The 2026-11-07
sample has 2,527 pages under protocol `scraping-bench-v6`. <https://trace.context.dev>,
<https://github.com/context-dot-dev/trace-benchmark>

**Sampling.**
- Candidates come from 197–198 chosen feeds, registries, sitemaps and APIs (`config/sources.json`), plus
  newly added external links on English Wikipedia. They are grouped into 8 core categories plus Other.
- Each run takes up to 300 never-tested URLs per category, at most 125 per organization and 375 per
  hostname, with a maximum target of 2,700.
- "Day-seeded hashes order organizations and pages", so selection is deterministic for the day. The exact
  seed format is not published.
- A durable seen-URL ledger excludes every previously selected URL. The doc admits that "distinct URLs
  can still contain the same material."
- "The sample is saved before any provider runs."
- They say plainly: "it is not a random sample of the web"; "category balance does not remove
  source-selection bias."
<https://raw.githubusercontent.com/context-dot-dev/trace-benchmark/main/docs/methodology.md>

**Fairness controls.**
- The same frozen sample goes to every provider.
- Caching is disabled per provider (`maxAgeMs: 0`, `maxAge: 0, storeInCache: false`, `live=true`), and each
  response is checked for that provider's own cache marker. Observed cache hits become `CACHED_RESPONSE`:
  left unresolved, not graded, excluded from latency.
- One attempt per provider per page, with no retries ("to avoid duplicate paid retrievals").
- 30 s full-response deadline for every client, 27 s upstream timeout where the API supports it.
- HTTP 401/402/429 and exhausted credits are excluded and reported as `excluded`, not counted as failures.
- Latency is measured from a single region (Vercel us-east).
- "The benchmark relies on provider cache metadata; it cannot independently prove what happened inside a
  provider."

**Grading.**
- Access is graded by an LLM judge (TypeSafe Jev 1.13.0) that sees up to 12,000 chars (start, middle, end).
- The judge request omits provider, URL, title and category (blind), and the prompt "treats scraped text
  as untrusted evidence" (prompt injection from pages).
- Unclear judgments stay unresolved and count against the provider.
- Quality is graded in stages (returned → accessed → right page → substantive). Right-page and
  substantive grades are "not yet available". Length is shown as a signal, not a score.

**Metrics.**
- Access rate: failures stay in the denominator, and the overall score is the unweighted mean of
  category rates.
- Latency p50/p90/p95/p99 and the share of requests that hit the deadline.
- Cost per 1,000 accessed pages = published price ÷ access rate. Billing of failed requests is assumed,
  and the assumption is flagged.
- Head-to-head counts of pages one provider got that another missed.

**Statistics.**
- "Approximate 95% CIs from per-category binomial variance" (unnamed, normal approximation).
- Ranks come from exact McNemar on shared pages, and providers not separated at 95% share a place.
- "No family-wide correction" across the six pairwise tests.

**Failure display.** Misses are split by reason (timeout, HTTP error, no content, block/login/error
screen), shown as a per-provider share. Wrong documents and thin pages count as accessed and appear only
under Quality.

**Audit trail.**
- Page-level NDJSON per run (URLs, timings, HTTP status, judge verdicts, text hashes) plus JSON summaries.
  Raw scraped text is not published.
- Code, judge prompts and request settings are MIT on GitHub.
- Retention: grading evidence 30 days, page records 180 days, summaries forever.
- Protocol versions are explicit: earlier samples keep their rules and "are not directly comparable with
  v6 access scores."

**What TRACE gets right (copy these).**
- Freeze before collection.
- A seen-ledger for freshness.
- Per-source caps.
- Failures stay in the denominator.
- Excluded (quota) outcomes are reported separately, not hidden.
- Per-provider cache-marker checks.
- A blind judge that treats content as untrusted.
- McNemar with shared ranks.
- Cost per *successful* page.
- Failure taxonomy.
- Raw per-item records with text hashes.
- Explicit protocol versions that break comparability.
- An honest limitations list.

**What it gets wrong or leaves open (beat these).**
1. "Every day" is really weekly, and a weekly run with no cross-week pooling or trend statistics can't
   show a *sustained* advantage, only a series of snapshots.
2. No family-wise correction across pairs, and no correction for re-testing the same claim every week.
   Thirty runs at α = 0.05 give a 79% chance of at least one false "better".
3. The CI is a normal approximation on category rates and is not paired. The paired McNemar ranks are
   right, but the headline "±0.9" is not the uncertainty of the *difference*.
4. Live pages are fetched by four providers concurrently but not from one stored snapshot, so the page
   each provider saw can differ (A/B content, geo, rate-limits from the target site). The text hashes
   reveal this after the fact; nothing controls for it.
5. Excluding 429/402 outcomes per provider lets a provider that rate-limits the benchmark account drop its
   hardest pages from its denominator. The exclusion count is shown, but the paired set is not
   restricted to pages every provider attempted.
6. No published judge audit yet ("no audit has been published for this scoring rule"). Judge
   accuracy is unknown, so small gaps may sit inside judge error.
7. The publisher is a contender and chose the sources. Disclosure is good, but source selection is the
   largest lever on the ranking, and nothing stops a quiet tilt toward sources it handles well.
8. Latency comes from one region, with no time-of-day spread, and no paired latency statistic.

## 2. Live and contamination-resistant benchmarks

| Benchmark | Refresh | Cross-round comparison | Contamination control | Stats |
|---|---|---|---|---|
| LiveBench | ~1/6 of ~1,000 questions replaced monthly; oldest/easiest retired first | dated releases selectable; rank corr > 0.997 between updates while absolute scores fell ~1.2% | recent sources; newest questions private for 1 month; objective ground truth, no LLM judge | 95% bootstrap CIs; overall = mean of 6 category means |
| LiveCodeBench | new contest problems; cumulative `release_vN` (v6: 1,055) | `--start_date/--end_date` scores a model only on problems after its cutoff | release date vs model cutoff, which both detects and controls | n=10 samples, pass@1; no CIs on main results, ~1–1.5% subset-bootstrap variation |
| SWE-bench-Live | issues since 2024; ~50 verified tasks/month (README) | frozen `lite`/`verified` splits for fair, cheap comparison; `full` grows | fresh issues only | [U] repeats/CI |
| SWE-rebench | automated GitHub mining (21k+ tasks); leaderboard shows a chosen date window (~111 tasks) | per-window results; runs including pre-release issues flagged "potentially contaminated" | issue date vs model release date; identical minimal scaffold for every model | 5 runs per model, SEM, pass@5; cost and token columns |
| Terminal-Bench 2.0 | versioned, not rolling (89 curated tasks) | per version only | canary strings; an exploit agent found test monkey-patching and tasks were fixed | ≥5 trials per model-agent pair, 95% CIs (method [U]) |
| Chatbot Arena / LMArena | continuous user prompts and votes | Bradley-Terry by reweighted MLE; active pair sampling; sandwich SEs; style control as covariates | vote-anomaly detection | BT + bootstrap/sandwich CIs |
| HELM | "living" — scenarios and models added; versioned releases | each release pins `run_entries_*.conf` + `schema_*.yaml`, rerunnable | — | raw prompts and completions released in a public bucket |
| Dynabench | human adversarial rounds against the current SOTA | evaluate on all rounds plus a static set | items made adversarial to the round's model | — |

Sources: LiveBench <https://arxiv.org/abs/2406.19314>, <https://github.com/LiveBench/LiveBench>;
LiveCodeBench <https://arxiv.org/abs/2403.07974>, <https://github.com/LiveCodeBench/LiveCodeBench>;
SWE-bench-Live <https://arxiv.org/abs/2505.23419>, <https://github.com/microsoft/SWE-bench-Live>;
SWE-rebench <https://arxiv.org/abs/2505.20411>, <https://swe-rebench.com/about>;
Terminal-Bench <https://arxiv.org/abs/2601.11868>, <https://www.tbench.ai/leaderboard>;
Chatbot Arena <https://arxiv.org/abs/2403.04132>, style control <https://arena.ai/blog/style-control/>;
HELM <https://arxiv.org/abs/2211.09110>, <https://crfm-helm.readthedocs.io/en/latest/reproducing_leaderboards/>;
Dynabench <https://arxiv.org/abs/2104.14337>.

**Critiques that shape the design.**
- *The Leaderboard Illusion* (<https://arxiv.org/abs/2504.20879>):
  - Private testing of many variants plus the option to retract bad scores (Meta tested 27 variants
    before Llama 4) inflates the best-of-N score.
  - Unequal sampling and silent deprecation break Bradley-Terry's assumptions.
  - Its fixes: no retraction, capped variants, a transparency log.
  - For us: **every run is append-only and shown**. A contender that was run and then removed from the
    report stays visible in the raw data.
- *Adding Error Bars to Evals* (Miller, <https://arxiv.org/abs/2411.00640>):
  - Clustered standard errors.
  - Paired per-question differences.
  - Resample answers to cut within-question variance.
  - Power analysis.
  - Already the basis of `src/experiments/power.ts`.
- *Signal and Noise* (Ai2, <https://arxiv.org/abs/2508.13144>): a benchmark's signal-to-noise ratio
  predicts whether it can rank models. Drop noisy subtasks and choose metrics with less noise.
- *Agentic Benchmark Checklist* (<https://arxiv.org/abs/2507.02825>): task or grader flaws mis-estimate
  agent performance by up to 100%.
- *METR on reward hacking* (<https://metr.org/blog/2025-06-05-recent-reward-hacking/>): o3 monkey-patched
  evaluators in 30.4% of RE-Bench runs. Grader code and expected answers must be out of the contender's
  reach. `src/runner/tamper.ts` already covers this for repo tasks.
- *The SWE-Bench Illusion* (<https://arxiv.org/abs/2506.12286>): file-localization accuracy from issue
  text alone is 76% on SWE-bench repos versus ≤53% outside, which is memorization. Freshness relative to
  the contender's training cutoff matters, not freshness relative to our last run.
- *AntiLeakBench* (<https://arxiv.org/abs/2412.13670>): contamination appears even before stated cutoffs,
  so a date filter is necessary but not sufficient.
- Survey of static-to-dynamic evaluation (<https://arxiv.org/abs/2502.17521>): finds no standard criteria
  for judging dynamic benchmarks.

**Lessons carried into the checklist.**
- Freeze and pin each round (HELM, SWE-bench-Live).
- Date-stamp every item and compare it with each contender's cutoff (LiveCodeBench, SWE-rebench).
- Keep a small overlapping anchor set so rounds can be linked (LiveBench's partial replacement is what
  makes its rank correlation measurable).
- Report per-window and all-time results, but compare ranks and paired deltas, not absolute scores, across
  windows (LiveBench's −1.2% drift with unchanged models).
- Repeat trials only where variance demands it (SWE-rebench, Terminal-Bench run 5).
- Use the same scaffold, prompt and budget for every contender (SWE-rebench).
- Build environments once and reuse them by content hash (SWE-bench-Live saved 82% of LM cost).

## 3. Product prior art (online and continuous evals)

Across the six products I read:
- **None documents confidence intervals or significance tests** for comparing experiments. LangSmith
  repetitions give a standard deviation only.
- **None has a native scheduler.** Cron is left to CI.
- **None addresses a dataset whose items rotate**, beyond pinning a version.

That is the opening for `coding.sh bench`.

| Product | Online evals | CI / schedule | Regression alerts | Dataset drift / versions | Compare |
|---|---|---|---|---|---|
| Braintrust | scoring rules with sampling rate + filter; "rewind" rescoring of past spans | `eval-action` PR comment; `bt eval --sample N`; no cron | SQL conditions to Slack/webhook; sustained drops need a time-window alert | experiments pin dataset versions | pairs rows by exact `input` (custom SQL comparison key otherwise; unmatched rows show "-"); baseline = last experiment on the same git branch; Improvement/Regression/Tradeoff/Tie also weighs cost and latency; **no CIs** |
| LangSmith | automation rules with `sampling_rate`; backfill only when the rule is created | pytest/Vitest plugins; no cron | aggregate + operator + threshold over 5/15-min windows, previewed against history | timestamp versions, tags, `as_of="prod"` | one row per example vs baseline, red/green; **no significance** |
| Langfuse | filters + sampling %, 7-day volume preview, backfill | `experiment-action` pinning `dataset_version`; absolute threshold gate + per-case "passed before, fails now" gate; **fails closed** on missing/duplicate cases and evaluator errors; **refuses to compare across dataset or evaluator versions** | warning/alert thresholds, no-data alerts, HMAC webhooks | timestamp versions; experiments on historical versions | paired per item; docs warn that averages hide regressions |
| Arize AX / Phoenix | AX: sampling, filters, continuous runs every 2 min; Phoenix: bring your own | scripted CI | **thresholds learned automatically from history**, adjustable sensitivity | every mutation versions; experiments pin `version_id` | side by side; no stats |
| W&B Weave | monitors with sampling; "Signals" presets | none documented | windowed threshold automations with preview | publish bumps the version | warns when datasets/scorers differ and restricts to the intersection; no CIs |
| Judgment Labs | per-judge online toggle + sampling; actions with cooldown | versioned test suites; judge error = failure; CI gate | Slack with cooldown, scheduled reports | versioned; runs pin the version | none documented |

Sources:
- Braintrust: <https://www.braintrust.dev/docs/core/logs/score>, <https://braintrust.dev/docs/evaluate/run-in-ci>,
  <https://braintrust.dev/docs/deploy/monitor>, <https://docs.braintrust.dev/evaluate/compare-experiments.md>
- LangSmith: <https://docs.langchain.com/langsmith/rules>, <https://docs.langchain.com/langsmith/alerts>,
  <https://docs.langchain.com/langsmith/manage-datasets>, <https://docs.langchain.com/langsmith/compare-experiment-results>,
  <https://docs.langchain.com/langsmith/repetition>
- Langfuse: <https://langfuse.com/docs/evaluation/get-started/online.md>,
  <https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd.md>, <https://langfuse.com/docs/observability/features/alerts>,
  <https://langfuse.com/docs/evaluation/experiments/compare-experiments.md>
- Arize: <https://arize.com/docs/ax/evaluate/online-evals/setting-up-online-evals>,
  <https://arize.com/docs/ax/observe/production-monitoring/configure-monitors>
- W&B Weave: <https://docs.wandb.ai/weave/guides/evaluation/monitors.md>, <https://docs.coreweave.com/weave/guides/evaluation/compare_evals>
- Judgment Labs: <https://docs.judgmentlabs.ai/documentation/judges/run-on-live-traffic>,
  <https://docs.judgmentlabs.ai/documentation/tests/overview>

**Copy:**
- Langfuse's fail-closed denominator and refusal to compare across versions.
- Langfuse's two gates (aggregate plus per-case "previously passed").
- Braintrust's last-run-on-branch baseline and cost/latency "Tradeoff" grade.
- Arize's thresholds learned from history.
- Backfill/rescore when a judge changes.

**Beat:**
- Paired CIs and tests.
- Native local scheduling.
- Trends that stay valid while the items rotate (section 4.3).

## 4. Statistics for a rolling benchmark

### Notation

- Run (day) t = 1..T. Run t has frozen set S_t with n_t cases.
- Contenders k = 1..K. Repeats r per case (default 1).
- y_{t,i,k} is case i's score for contender k, averaged over its r trials. For a binary pass it is the
  case pass rate in [0,1]; otherwise a [0,1] quality score.
- For a pair (A, B): d_{t,i} = y_{t,i,B} − y_{t,i,A}, with mean d̄_t and sample sd s_t.

### 4.1 Within a run: paired, case = cluster (already in `src/experiments/compare.ts`)

- **Difference.** d̄_t, with SE_t = s_t / √n_t (Miller eq. 7). The case is the cluster, so trials are
  averaged before differencing (eq. 8). CI: the existing `pairedBootstrap` over cases, or d̄_t ± t_{n−1}·SE_t.
- **Binary test.** Exact McNemar on discordant cases, b = A-pass/B-fail and c = A-fail/B-pass
  (`mcnemar`). The marginal pass rates are not enough; the paired b/c table is the information
  (<https://arxiv.org/abs/2411.00640>).
- **K > 2.** All K(K−1)/2 pairs, Holm-adjusted within the run. Reject while p_(i) ≤ α/(m−i+1)
  (<https://www.jstor.org/stable/4615733>). Ties, meaning pairs not separated after Holm, share a rank
  (TRACE does this without the correction).
- **Run inclusion.** Use only cases where every contender has a scored outcome. Pair on the
  intersection: a case one contender didn't attempt (excluded or quota) leaves the paired set for
  *all* contenders, and the count is reported. A contender's *errors and timeouts are scored as
  failures*, not exclusions.

### 4.2 Across runs with fresh items: pool the paired differences, never the absolute scores

Absolute pass rates move with item difficulty: LiveBench's unchanged models lost ~1.2% between
releases. Pairing within a run cancels that run's difficulty, so the cross-run quantity is the
series of (d̄_t, SE_t).

- **Fixed-effect (inverse variance).** w_t = 1/SE_t², d̂ = Σ w_t d̄_t / Σ w_t, SE(d̂) = 1/√Σw_t.
  This answers "how big was the gap over these runs".
- **Random effects (DerSimonian–Laird with HKSJ)** answers "how big will the gap be on a typical
  future run". Use it for public claims:
  - Q = Σ w_t (d̄_t − d̂_FE)²
  - τ̂² = max(0, (Q − (T−1)) / (Σw − Σw²/Σw))
  - w*_t = 1/(SE_t² + τ̂²), d̂_RE = Σ w*_t d̄_t / Σ w*_t
  - SE²_HK = Σ w*_t (d̄_t − d̂_RE)² / ((T−1) Σ w*_t)
  - CI: d̂_RE ± t_{T−1, 1−α/2} · SE_HK
  - Prediction interval for the next run: d̂_RE ± t_{T−2} · √(τ̂² + SE²_HK)
  - I² = max(0, (Q − (T−1))/Q)
  - Cochrane recommends HKSJ because plain DL underestimates τ²
    (<https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-10>).
- **Reading τ̂².** If every run's cases come from the same generator, item-difficulty variance is
  already inside SE_t. So **τ̂² > 0 means something actually moved**: a contender was silently
  updated, or the source distribution drifted. Show τ̂² and I² next to every window estimate.
- **Check.** A two-stage (hierarchical) bootstrap resamples runs, then cases within each resampled
  run (<https://pmc.ncbi.nlm.nih.gov/articles/PMC7906290>). It is unreliable below ~15–20 runs.
- **Avoid.** A mixed-effects logistic model (`logit P = β_k + u_t + v_{t:i}`) is the textbook answer,
  but it needs Laplace or quadrature fitting (lme4). It's not worth hand-writing in TypeScript.
- **Window.** A trailing window (e.g. the last 28 runs) declared in the bench definition, *not
  chosen after looking*. Report the window and all-time results separately, as LiveCodeBench and
  SWE-rebench do.

### 4.3 Trends while the items rotate

- **The per-contender pass-rate line** is plotted with its Wilson interval and labeled "absolute, items
  differ per run". It's descriptive only.
- **The trend that means something** is each contender's paired difference against a **reference
  contender** that is pinned and never upgraded: d̄_{t,k} = mean_i (y_{t,i,k} − y_{t,i,ref}). Pairing
  cancels the day's difficulty.
- **The reference's own absolute pass rate is the "difficulty index".** If it moves while its version
  is pinned, the source got harder or easier, or the reference is not actually pinned (an API model
  alias moved).
- **Anchor set (link rounds).** A small fixed set, about 5–10% of N or ≥ 30 cases, re-run every run
  next to the fresh sample, with its content frozen once. It separates "contender changed" from
  "items changed": a moving anchor score with fresh items held aside means the contender, the judge
  or the environment changed. LiveBench's partial replacement serves the same linking purpose. The
  anchor is excluded from the fresh-sample statistics and from freshness dedupe.

### 4.4 Telling run-to-run noise from a real change (alerts)

- **Standardize.** z_t = (d̄_{t,k} − μ₀) / √(SE_t² + τ̂²), where μ₀ and τ̂² come from a baseline
  window of past runs.
- **EWMA.** E_t = λ z_t + (1−λ) E_{t−1}, λ = 0.2. Alert when |E_t| > L √(λ/(2−λ)), L = 3
  (<https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc324.htm>).
- **CUSUM alternative**, for small persistent shifts: S⁺_t = max(0, S⁺_{t−1} + z_t − k), and S⁻_t
  mirrors it with k = 0.5 and h = 4–5
  (<https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc323.htm>).
- **Overdispersion.** A plain p-chart on absolute pass rates (p̄ ± 3√(p̄(1−p̄)/n)) is too narrow when the
  daily mix varies. Use Laney p′ if absolute charts are kept.
- **Run the same chart on the judge's anchor re-grades** (section 4.8), so a judge shift is not
  reported as a contender shift.
- **Retrospective change points:** PELT on the d̄_t series (<https://arxiv.org/abs/1101.1438>). NICE.

### 4.5 Repeated looks: the "every single day" problem

- **A fixed-α test each day is not a sustained claim.** With 30 independent runs at α = 0.05, there is
  a 1 − 0.95³⁰ = 79% chance of at least one false "better". Looking at a growing pool and stopping
  when it turns significant is worse (Johari et al., <https://arxiv.org/abs/1512.04922>).
- **Per-run verdicts.** Each run's verdict is reported as that run's result.
- **Headline claim, option (a).** "B beats A" comes from the pre-declared window estimate (4.2).
- **Headline claim, option (b), always valid (NICE).** A betting e-process on the cumulative paired
  diffs. With d_j ∈ [−1, 1] in arrival order, wealth is W_n = Π_{j≤n} (1 + λ_j d_j), where λ_j ∈
  (−1, 1) is predictable (chosen from d_1..d_{j−1} only, e.g. aGRAPA). Claim when W_n ≥ 1/α (Ville's
  inequality). It can be checked after every run with no penalty
  (<https://arxiv.org/abs/2010.09686>, <https://arxiv.org/abs/1810.08240>).
- **Many metrics × contenders**, as in the "where each fails" lists and per-category verdicts:
  Benjamini–Hochberg, reject up to the largest i with p_(i) ≤ iα/m
  (<https://www.jstor.org/stable/2346101>), or e-BH on e-values under arbitrary dependence
  (<https://arxiv.org/abs/2009.02824>).

### 4.6 Sample size (power) per run

- **Paired binary (Connor 1987).** With discordance p_d = p₁₀ + p₀₁ and effect δ = p₁₀ − p₀₁:
  n = [ z_{1−α/2} √p_d + z_{1−β} √(p_d − δ²) ]² / δ²
  (<https://support.sas.com/documentation/cdl/en/statug/65328/HTML/default/statug_power_details55.htm>)

  | δ | p_d | power | n (paired cases) |
  |---|---|---|---|
  | 5 pp | 0.20 | 80% | 626 |
  | 5 pp | 0.20 | 90% | 837 |
  | 5 pp | 0.10 | 80% | 312 |
  | 10 pp | 0.20 | 80% | 155 |

- **The existing MDE** in `power.ts`, (z_{1−α/2} + z_{1−β}) · sd/√n with sd = √(p_d − δ²), gives 621 for
  row 1, which is close enough.
- **Inverse.** N = 200 per run with p_d = 0.2 detects about 8.9 pp per run. Pooling 7 runs at τ² = 0
  detects about 3.3 pp.
- **Holm cost.** For K contenders, plan with α/m, where m = K(K−1)/2.
- **Continuous scores.** n = ((z_{1−α/2} + z_{1−β}) σ_d / δ)². For example σ_d = 0.15 and δ = 0.03 give
  n ≈ 197 (Miller eq. 9).
- **`bench new` should print this** as "to see a 5 pp gap you need ~630 cases per run, or ~90 per run
  pooled over 7 runs". p_d comes from the last run, or 0.2 as a prior.

### 4.7 Repeats for non-deterministic contenders

- **Variance.** Var(d̄) = (σ²_between + σ²_within / r) / n (Miller section 3). More trials only shrink
  the second term.
- **Estimate the components** from a run with r ≥ 2: σ̂²_w = mean of within-case variances, and
  σ̂²_b = Var(case means) − σ̂²_w / r.
- **Cost-optimal repeats** (Cochran two-stage): r* = √((c_case / c_trial) · σ²_w / σ²_b).
  - In a dynamic benchmark a new case costs about one trial (c_case ≈ c_trial), plus a snapshot.
  - So r* < 2 unless within-case noise dominates. **Default r = 1 and spend on cases.**
  - Use r ≥ 2 only when reporting reliability.
- **Reliability estimators:**
  - pass@k = 1 − C(n−c, k)/C(n, k) (<https://arxiv.org/abs/2107.03374>)
  - pass^k = C(c, k)/C(n, k), averaged over cases (<https://arxiv.org/abs/2406.12045>)
- **Never treat the K×n trials as independent** in an SE.

### 4.8 Judge drift

- **Series key.** The judge's identity (model + prompt hash + rubric + params, already `JudgeVersion.id`)
  is part of the series key. **A chart never mixes judge versions.** A change draws a break.
- **On a judge change, re-score stored outputs.** Outputs are frozen per run, so this costs judge
  tokens only and needs no contender re-runs. `src/judge/cache.ts` keys by (judge version, input
  hash), so old verdicts stay cached.
- **Anchor re-grade every run.** Re-grade a fixed, human-labeled anchor set every run and track
  the mean score and Cohen's κ (`cohenKappa`) on the EWMA chart. Re-estimate Se/Sp and apply
  Rogan–Gladen π̂ = (p̂ + Sp − 1)/(Se + Sp − 1) (`roganGladen`).
- **Pin model snapshots.** API aliases like `*-latest` drift silently; record the provider-reported
  model in each verdict, which the cache already stores.
- **Bias controls** (MT-Bench, <https://arxiv.org/abs/2306.05685>):
  - Blind the judge to contender identity.
  - For pairwise judging, swap positions and count a win only when it holds in both orders. GPT-4 was
    consistent in only 65% of cases.
  - Control for verbosity.
  - Never let a model judge its own outputs without flagging self-preference
    (<https://arxiv.org/abs/2404.13076>).

### 4.9 Latency, cost, tokens

- **Latency.** Paired per case: ℓ_i = ln(L_{i,B} / L_{i,A}). Report the geometric mean ratio
  GMR = exp(mean ℓ), with a bootstrap CI over cases. Add Δp50 and Δp90 by paired case bootstrap; tail
  quantiles at small n are approximate.
- **Which requests count for latency.**
  - Only those that completed. Timeouts are reported as a separate "hit the deadline" share,
    since a censored latency is not a latency.
  - Cached responses are excluded (TRACE).
- **Time of day.** Interleave contenders per case in a seeded random order, so time-of-day drift and
  rate-limit windows hit everyone equally (A/A experiments show that regular interference
  masquerades as differences, <https://research.spec.org/icpe_proceedings/2017/proceedings/p287.pdf>).
  Record the wall-clock start of every attempt.
- **Cost.** Paired GMR as for latency.
  - **Cost per success** = total cost / successes, TRACE's price ÷ access rate.
  - Store tokens in and out, so cost can be recomputed when prices change (Kapoor et al. section 4).
  - Mark costs as `reported` (from the agent or provider) or `estimated` (from a price table, with
    its date).
- **Cost–quality frontier.** Plot success against mean cost per case. A contender is on the Pareto
  frontier if no other is at least as good on both and strictly better on one.
  - Bootstrap the frontier and report P(on frontier).
  - Include cheap baselines (retry, escalation): "AI Agents That Matter" found SOTA agents did not beat
    them, with ~100× cost spreads at similar accuracy (<https://arxiv.org/abs/2407.01502>).

### 4.10 Ratings (Bradley–Terry / Elo): mostly no

- **Every contender runs every case with an absolute grade**, so per-case outcomes are the whole
  information. Pass rates (levels) and paired b/c tables (differences) are sufficient. For two
  contenders, BT on "battles" reduces to log(b/c) and throws away ties and the absolute level.
- **Online Elo depends on comparison order** (<https://arxiv.org/abs/2311.17295>). Never use it.
- **Use batch BT with bootstrap CIs** (Chatbot Arena, <https://arxiv.org/abs/2403.04132>) only for:
  - pairwise *preference* judges, or
  - contenders that join and leave over time, linked through shared runs.
- **That is NICE, not core.** Arena's experience (*Leaderboard Illusion*) shows that unequal
  participation and silent deprecation bias BT, so the comparison graph must stay connected.

## 5. Failure modes and gaming

| Failure mode | How it bites | Control |
|---|---|---|
| Cherry-picked sources | The source list is the biggest lever on the ranking; the publisher picks sources it handles well. TRACE admits "category balance does not remove source-selection bias". | Source list is part of the versioned bench definition (hashed); changes create a new protocol version and break the series; per-source results are always shown; source list is published with the report. |
| Selection bias in sampling | Easy-URL bias (only pages that responded to a pre-check), survivorship (only issues that got a merged fix, only sessions that still parse), recency bias. | Log the **selection funnel** per run: candidates seen → filtered (per reason) → deduped → sampled. Never pre-filter on any contender's behaviour. Stratify by source with caps (TRACE: 300/category, 125/org, 375/host). Record how each case was chosen (`metadata.sampling = {source, stratum, rank, seed}`). |
| Freshness ≠ uncontaminated | "Never tested by us" does not mean "never seen by the model". SWE-Bench Illusion; AntiLeakBench finds contamination before stated cutoffs. | Store `createdAt` of the source item (issue/PR/page date) on each case; store contender cutoff when known; report a "post-cutoff only" slice (LiveCodeBench/SWE-rebench). For GitHub items: the contender must not be able to fetch the fix (check out the pre-fix commit, no network or block the fix PR URL). |
| Near-duplicate items | Distinct URLs, same content (TRACE admits it); same issue cross-posted. | Dedupe key = normalized source key **and** content hash of the frozen input; ledger stores both. |
| Live content changes between contenders | A page or API answer differs between contender A's and B's fetch: the pair is no longer paired. | **Snapshot content, not just the pointer**: the frozen case holds the fetched content (or a content-addressed blob ref) + its hash; contenders that must hit the live URL (scraper APIs) still get the same URL at the same moment *and* the snapshot is kept to grade against; record per-contender text hash so divergent fetches are visible. |
| Time-of-day / rate limits | Contender run later in the day sees different load; one contender hits 429s. | Interleave contenders per case with seeded random order; equal concurrency and deadlines; 401/402/429 are `excluded` (separate count), and the case leaves the paired set for everyone; alert when excluded > 2%. |
| Caching unfairness | One contender serves from cache (fast, maybe stale); repeated cases across runs hit warm caches. | Freshness dedupe stops cross-run reuse; ask each contender for no-cache where it can; detect provider cache markers; exclude cache hits from latency and mark them; the bench's own result cache (bench-cli.md "results are cached by (task, setup hash, attempt)") must **never** be used to answer a scheduled run, only to resume an interrupted one. |
| Retries asymmetry | A wrapper retries one contender silently. | One attempt per case per trial unless the bench sets `retries` for all; record attempt count. |
| Partial runs | Budget or crash stops the run after the fast/easy cases; partial results look better. | A run is `complete` only when every (case, contender, trial) has an outcome; incomplete runs are resumable, excluded from history and report by default, and flagged. |
| Best-of-N / retraction | Run your new version 5 times, report the best (Leaderboard Illusion). | Append-only runs; every run of a contender is in history; report shows run count per contender; no delete of a run from a published bench without a tombstone. |
| Version drift | `claude-sonnet-latest`, a CLI auto-update, a judge prompt edit. | Pin and record: contender id + version + config hash (model id as reported, CLI version, harness bundle hash), grader/judge version, bench definition hash, source adapter version. A change starts a new series segment. |
| Judge drift / judge bias | Judge model alias updates; judge favors long answers or its own family. | 4.8: series key includes judge version; anchor re-grade + κ; blind judge; swap positions for pairwise; treat case content as untrusted (prompt injection from scraped pages / issues, TRACE does this). |
| Reward hacking / tamper | Contender edits tests or graders (METR: 30% on RE-Bench). | Grader and expected values never in the contender's workspace; `src/runner/tamper.ts` for repo tasks; no-op/exploit sanity contender (Terminal-Bench, ABC). |
| Non-reproducibility | Can't re-grade or audit later. | Frozen dataset version stored content-addressed; seed, source cursor (e.g. GitHub `since`), and funnel stored; contender outputs stored; `bench export <run>` emits per-case JSONL (ids, hashes, versions, outcomes, timings, cost) for audit (TRACE NDJSON, HELM raw outputs). |
| Privacy | Cases from your own sessions hold code, paths, customer data, secrets. | Redact at freeze time with `createRedactor` (src/core/redact.ts) before hashing (so hashes are of redacted content); mark each case `visibility: private|public` from its source; `report --public` refuses private-sourced cases unless `--include-private` and shows only ids/hashes/outcomes otherwise. |
| Secrets in GitHub-sourced cases | Issue bodies/PR diffs contain leaked tokens; frozen sets and public reports republish them. | Run the secret rules on every fetched case; drop or redact cases with hits; never store the GitHub token in case metadata or source config (env var name only); a public report never includes raw inputs by default. |
| Cost blowup | K contenders × N cases × r trials × judge calls, nightly. | Pre-run estimate from last run's per-case cost (shown before spend, bench-cli.md rule); hard `budget_usd` per run checked during the run (stop scheduling new cases, mark incomplete); judge cache; `--dry-run`; schedule refuses to install without a budget. |
| Command sources run arbitrary code | `source = "command: ..."` executes on every scheduled run, possibly in CI with secrets. | Run it with a timeout, a minimal env (no contender API keys), cap output size and case count; validate each JSONL line against the case schema. |

## 6. Design checklist

### MUST

1. **Freeze before running.** Sample → fetch/snapshot content → redact → content-hash → persist the dataset
   version → *then* run any contender. The run record points at that version; nothing is re-sampled
   mid-run. (TRACE "saved before collection"; HELM; SWE-bench-Live)
2. **Snapshot content, not pointers.** URL/issue/session cases store the fetched content (or a content-
   addressed blob) and its hash; graders grade against the snapshot. Per-contender fetched-text hash
   recorded when contenders fetch live.
3. **Deterministic seeded sampling.** `seed = hash(benchId, runKey)` recorded on the run; same seed +
   same candidate pool ⇒ same sample (`hashUnit` in src/datasets/hash.ts fits). Stratified by source /
   category with per-stratum caps and per-host/org caps.
4. **Freshness ledger.** Durable seen-set keyed by normalized source key *and* content hash; only
   cases actually run (complete runs) are added; anchor set exempt. Report how many candidates were
   rejected as seen.
5. **Selection funnel stored per run.** candidates → filtered (by reason) → seen → sampled, per source.
   Empty or tiny pools fail loudly instead of silently running N=12.
6. **Same set, interleaved, randomized order.** Every contender gets the identical frozen set; jobs are
   scheduled per case with a seeded shuffle of contender order (and case order), equal concurrency,
   deadlines and retry policy for all.
7. **Fail-closed denominators.** Errors and timeouts are failures. Only infrastructure exclusions
   (quota 401/402/429, our own crash) are `excluded`, counted and shown, and they remove the case from
   the paired set for *all* contenders.
8. **Complete-run rule.** History, report and claims use complete runs only; partial runs are resumable
   and flagged; budget stop ⇒ incomplete.
9. **Pin and record every version.** Contender (model as reported, CLI/agent version, config/harness
   hash), graders (`Grader.version`, `JudgeVersion.id`), bench definition hash (sources, sampler,
   N, caps, graders), source adapter version. A change in bench definition or grader = new series
   segment; history never silently joins them.
10. **Paired stats per run.** Paired bootstrap CI + exact McNemar per pair (existing
    `compareExperiments`), Holm across pairs, MDE/power warning; shared ranks when not separated.
11. **Cross-run aggregation on paired diffs only.** Window estimate by inverse-variance / DL-HKSJ over
    per-run paired diffs (4.2); absolute pass-rate trend labeled as descriptive. Window declared in
    the definition.
12. **Quality, latency, cost, tokens, errors per case per contender.** Latency excludes timeouts and
    cache hits; cost marked reported/estimated; tokens stored so cost can be recomputed.
13. **Privacy gate.** Session-sourced cases redacted at freeze; cases carry visibility; `report` defaults
    to private (local file), and a public report excludes private inputs.
14. **Secret scan on external sources** (GitHub issues/PRs, URLs, command output) before freezing.
15. **Budget.** Pre-run estimate, hard cap enforced during the run, schedule requires a budget.
16. **Append-only runs + raw export.** No silent deletion; per-case JSONL export with hashes, seed,
    versions, outcomes for audit.
17. **Judge blind to contender**, content treated as untrusted in the judge prompt.

### SHOULD

1. **Reference contender** (pinned, never upgraded) per bench; trends plotted as paired diff vs reference;
   reference absolute rate shown as the difficulty index.
2. **Anchor set** (fixed ≥30 cases re-run every run) to separate contender/judge/env drift from item drift.
3. **EWMA (or CUSUM) regression alert** on the standardized paired diff; same chart on judge anchor
   re-grades; alert payload names the cases that flipped.
4. **Post-cutoff slice:** cases carry `sourceCreatedAt`; contenders may declare `cutoff`; report shows
   the post-cutoff-only comparison.
5. **Power planner** in `bench new` / `bench run --dry-run` (Connor formula, 4.6) and a warning when N
   per run is below the MDE the user asked for.
6. **Where each fails:** failure taxonomy (timeout, error, wrong, blocked, judge-unresolved) per contender;
   discordant cases (only one contender failed) listed with links to the stored output/trace; BH across
   per-category verdicts.
7. **Cost per success and Pareto frontier** in the report; GMR for paired latency and cost.
8. **Re-score history on judge change** from stored outputs; never mix judge versions in a series.
9. **Repeats policy:** default r = 1; r ≥ 2 only on request, with pass^k reported and the
   within/between variance decomposition printed so the user can see whether repeats were worth it.
10. **Schedule hygiene:** GitHub Actions snippet with `concurrency:` group (no overlapping runs), secrets
    via env, run artifact upload, a timeout; local cron entry uses a lock file; run key = UTC date so a
    re-fire the same day resumes rather than resamples.
11. **Protocol version string** shown on every report and in MCP output.
12. **Judge calibration status** (`CalibrationStatus`) shown next to any judge-graded metric; uncalibrated
    ⇒ "unverified" badge.

### NICE

1. Always-valid claim monitor (betting e-process / confidence sequence) for "B has beaten A since <date>".
2. DL τ̂²/I² and prediction interval in the report; hierarchical bootstrap check at ≥20 runs.
3. Batch Bradley–Terry with bootstrap CIs when contenders join/leave or for pairwise-preference judges.
4. IRT/Rasch item difficulty (logit P = θ_k − b_i) to put runs on a common scale via the anchor set.
5. Item signal-to-noise tracking; drop sources whose cases never discriminate (Ai2 Signal & Noise).
6. Exploit/no-op sanity contender run on new sources before they join a bench.
7. PELT change-point annotations on history.
8. Private lag: hold the newest run's items out of the public export for one cycle (LiveBench).

## 7. Fit to the existing code

What already exists and should be reused, not re-implemented (`packages/coding.sh/src`):

| Need | Existing piece | Note |
|---|---|---|
| Content-hashed frozen set | `datasets/hash.ts` (`canonicalJson`, `contentHash`), `Dataset.version` = hash over id-sorted cases, `FileEvalStore` | Version must hash the *snapshot content* (post-redaction), not only ids. |
| Seeded sampling | `hashUnit(...parts)` (datasets/hash.ts), `mulberry32` (stats/prng.ts) | Order candidates by `hashUnit(seed, key)` → stable, no RNG state. |
| Per-contender run | `experiments/run.ts` `runExperiment` | Runs **one** task over the dataset with `mapPool` in case order. Calling it once per contender runs contenders sequentially, which violates MUST 6 (interleave). `runner/experiment.ts` already interleaves arms (A1, B1, A2, B2…) for repo tasks; bench needs the same for generic tasks. |
| Per-case cost/tokens | `CaseRun` has `latencyMs` only | Needs `costUsd`, `tokens {in,out}`, `excluded?: reason`, `cached?`, `attempt`, `startedAt` already there. `runner/experiment.ts` has cost/tokens metrics for repo runs to mirror. |
| Paired stats | `experiments/compare.ts` (`compareExperiments`: paired bootstrap, McNemar, per-grader deltas, Rogan–Gladen, pass^k, `pairedPower`) | Already right per pair. Missing: Holm across K, cross-run pooling, latency/cost GMR. `compareExperiments` pairs by case id and only *warns* on dataset version mismatch; bench should require identical version. |
| Power | `experiments/power.ts` | Add the planner direction (n for a given MDE). |
| Intervals/tests | `stats/interval.ts` (`wilson`, `pairedBootstrap`, `roganGladen`), `stats/tests.ts` (`mcnemar`) | Add: Holm, BH, DL-HKSJ pooling, Student-t quantile, EWMA. All small pure functions. |
| Judge versioning/cache | `JudgeVersion.id`, `judge/cache.ts` keyed by (judge version, input hash), `judge/calibrate.ts`, `cohenKappa` | Re-scoring history on judge change is cheap; series key = grader versions. |
| Leakage | `eval/leakage.ts` n-gram overlap; `runner/tamper.ts` | Use overlap to flag cases whose input already contains the expected answer (e.g. issue body pasting the fix). |
| Redaction | `core/redact.ts` `createRedactor().value()`, `secretRules()` | Apply at freeze to every source, not only sessions. |
| Design intent | `docs/design/bench-cli.md` (`coding.sh bench` as the one noun; `benches/<name>.toml`; budget_usd; Holm for matrices; "no second implementation") | The dynamic bench should extend that file format (a `source`/`sample` block) rather than invent a parallel one. |

## 8. Review of the in-progress implementation

Reviewed the working tree on 2026-11-06 around 23:20. The code was still being written, so this is a snapshot.

Files read:
- `src/bench/{types,define,sample,sources,contenders,run,stats,store,report,schedule,cli-spec}.ts`
- `src/cli/commands/bench.ts`
- the `holm` added to `src/stats/tests.ts`

MCP tools and `docs/guides/benchmarks.md` didn't exist yet.

### Already right (keep)

- **Freezing.**
  - The sample is frozen and stored as a dataset version before any contender runs.
  - `casesSha256` can be recomputed, and the report explains how.
  - The seed is recorded.
- **Order.** Jobs run case by case, with the contender order shuffled per case and trial from the seed
  (`seededShuffle`), so no contender always goes first.
- **Freshness ledger.** It is built only from stored runs, and only complete runs are stored, so an
  interrupted run doesn't burn its cases.
- **Sampling.** `hashUnit(seed, key)` ranking gives the same sample whatever order the input arrives in.
  Stratified equal shares are supported.
- **Paired stats.**
  - `compareExperiments` gives a paired bootstrap CI, exact McNemar, and power warnings.
  - Holm runs across pairs, and contenders that aren't separated share a place.
- **Failures.** There is a failure taxonomy (timeout, http-error, crash, empty, wrong, grader-error).
  Errors count as failures, and latency only covers answered requests.
- **Blind judging.** Graders see input, output and expected but never the contender's name.
- **Schedule.**
  - The Actions workflow has a `concurrency:` group.
  - The crontab is edited only after explicit consent and only on its own marked line.
- **Compatibility.** One experiment is stored per contender, so `exp compare` keeps working.

### Gaps, with fixes (ordered by how much they threaten a "we're better" claim)

| # | Gap (file) | Checklist | Fix |
|---|---|---|---|
| 1 | **URL cases freeze only the URL string** (`sources.ts` `urlCases`: `input: loc`). Live pages change between contenders' fetches; graders can't grade against what was there; nothing records what each contender saw. | MUST 2 | Add snapshotting to the urls source (default on): fetch each sampled URL once at freeze (bounded concurrency, timeout), store the body content-addressed in `BlobStore`, put `{url, status, fetchedAt, snapshotSha256}` in case metadata so `casesSha256` covers it; graders get the snapshot; record a per-cell `textSha256` of what each contender returned; flag pairs where contenders demonstrably saw different content. Same for github (`body` already captured — good) and command sources (their output *is* the snapshot). |
| 2 | **Only a 400-char output preview is stored** (`run.ts` `preview`; `cellsToRuns` drops output). Can't re-grade history when a judge changes, can't audit, "where each fails" shows truncated evidence. | MUST 16, 4.8 | Store full output as a blob (`Cell.outputSha256`), keep the preview for display; add `bench regrade <name> [--since] --grader <id>` that re-scores stored outputs and writes a new graded record (judge cache makes it cheap). |
| 3 | **No `excluded` outcome.** 401/402/429/quota, aborts and grader errors all become contender failures (`classifyFailure`). One account hitting a rate limit loses the ranking; a judge outage punishes whoever it hit. | MUST 7 | `Cell.excluded?: "quota" \| "aborted" \| "grader-error" \| "infra"`; classify HTTP 401/402/429 as `quota`; retry a grader error once, then `grader-error`; drop excluded cases from the paired set for **all** contenders (intersection) and show the counts; mark the run degraded above ~2% and refuse to call a verdict above ~10%. Real contender errors/timeouts stay failures. |
| 4 | **No uniform deadline.** Each contender keeps its own `timeoutMs` (agent default 30 min; command/http task defaults differ). | MUST 6 | Bench-level `timeoutMs` (required when contenders are external services) applied to every contender and recorded in the run; per-contender overrides rejected or shown as a fairness warning in the report. |
| 5 | **Contender versions aren't recorded** (only the config `ref`); the definition hash covers the whole TOML, so adding a contender changes it while a silent model/CLI update doesn't. | MUST 9 | Record per contender per run: provider-reported model(s), agent CLI version, harness bundle hash, contender config hash, and the coding.sh version. Split the identity into `protocolHash` (source, sampler, cases, dedupe, stratify, graders, timeout) and per-contender hashes; series segment on `protocolHash` + grader versions, and annotate contender version changes on the trend. |
| 6 | **History/report are absolute per-run pass rates only**, mixing runs across definition hashes and grader versions (`store.ts` `series`, `report.ts`). With items changing daily, a line going up means nothing on its own; no cross-run estimate exists. | MUST 11, 4.2, 4.3 | (a) segment series by `protocolHash` + grader versions (draw breaks); (b) add a paired series vs a reference contender (`history --vs <name>`: per-run d̄ ± CI); (c) a window estimate per pair: fixed-effect and DL+HKSJ pooled paired diff, τ̂², prediction interval (formulas in 4.2); (d) label the absolute line "items differ per run". |
| 7 | **Re-rolls land in history.** `--seed`, `--cases`, `--date` overrides and repeated runs on one date are stored and charted like scheduled runs, so a user can re-sample until the numbers look good (Leaderboard Illusion best-of-N). | 4.5, section 5 | Add `run.mode: "scheduled" \| "adhoc"`: adhoc when any override is used or a complete run already exists for that date. History, report and claims use the first complete scheduled run per date; adhoc runs are kept and listed separately, never silently merged or deleted. |
| 8 | **No budget** (the design in `docs/design/bench-cli.md` requires `budget_usd`). Nightly K × N × trials × judge calls can run unbounded. | MUST 15 | `budget_usd` in the definition. Pre-run estimate = last run's mean cost per cell × jobs, printed before spending (in `--dry-run` too). Stop scheduling new jobs once spend ≥ budget, store the run as `incomplete` (excluded from history and the ledger), and have `schedule` refuse to install without a budget. |
| 9 | **No privacy or secret gate.** github/urls/command cases aren't redacted or secret-scanned at freeze. The report embeds the latest run's full `cases`, failure inputs, session ids and metadata (`repo` local paths, GitHub `author`) in a page meant to be published. | MUST 13, 14 | At freeze, run `createRedactor().value()` (`core/redact.ts`, `secretRules`) on every case before hashing, and drop or redact cases with hits (count them in the funnel). Tag cases `visibility: private` (sessions, command by default) or `public` (github/urls). `report` shows only ids, hashes and outcomes for private cases unless `--include-private`. Strip local paths and author logins from published fields. |
| 10 | **Per-contender CI ignores trials.** `summarizeContender` uses Wilson over cells (n = cases × trials), so the interval is too narrow when trials > 1. | 4.7 | Use per-case means with the cluster bootstrap. `summarizeRuns` (already called in `run.ts`) computes exactly this as `ciMethod: "cluster-bootstrap"`, so reuse its `passRate`. |
| 11 | **The head-to-head CI is unadjusted but the verdict is Holm-adjusted**, so a CI can exclude 0 next to "tie". The default `cases = 50` gives an MDE of about 18 pp (p_d = 0.2), yet nothing says so before running. | 4.1, 4.6 | Either show Bonferroni-width CIs at α/m, or label them "unadjusted" next to the adjusted p. `bench new` and `run --dry-run` should print the Connor N for a chosen MDE and the MDE for the configured N. Recommend ≥ 200 cases per run, or pooling. |
| 12 | **Survivorship in the sources.** `urlCases` truncates the candidate list (first 200 child sitemaps in index order, `limit` 50k) *before* seeded sampling, so samples come from the earliest sitemaps. There is no per-host or per-org cap. The GitHub source sorts by `updated` and filters `since` on `updated_at`, so an old (pre-cutoff, possibly memorized) issue with a fresh comment counts as fresh. | MUST 3, 5; section 5 | Order child sitemaps by `hashUnit(seed, url)` before the cap, or sample per child. Add `maxPerHost` and `maxPerOrg` caps (TRACE: 375 per host, 125 per org). Record a per-reason funnel. For GitHub, filter and sort on `created`, store `sourceCreatedAt` on every case, and allow a contender `cutoff` so the report can show a post-cutoff slice. |
| 13 | **The sessions source can't be solved by agent contenders.** Agents run in an empty temp dir (`contenders.ts`), but a failed coding session needs its repo at the starting commit. | correctness | For agent contenders, replay sessions from the pre-session repo snapshot (`runner/git.ts`, as `eval` does). Otherwise reject the sessions × agent combination with a clear error instead of producing guaranteed failures. |
| 14 | **Schedule drift and history loss.** The workflow runs `npm install -g coding.sh` unpinned, so harness and grader code change between runs. It has no `env:` block, so contender, judge and GitHub keys are missing. On hosted runners, history and the freshness ledger live in `actions/cache`, which evicts after 7 days unused, so freshness silently resets and old cases get re-tested. | MUST 9, 4, 10 | Pin `coding.sh@<version>` and record it per run. Emit an `env:` block with `${{ secrets.NAME }}` for every env var the definition references. Persist runs as an artifact or on a data branch as well as in the cache. `bench run` should warn when a definition with prior published runs finds an empty history (keep a ledger checksum in the report). |
| 15 | **The seed is predictable.** `seed = "date"` is `<name>:<date>`, so anyone who knows the public sources can compute tomorrow's sample and pre-warm a cache or answers. That matters as soon as contenders are third parties. | section 5 | Optional `seed = "secret"`: salt from an env var. Publish sha256(salt) before the run and reveal the salt in the report after it (commit-reveal), so the sample stays unpredictable yet auditable. |
| 16 | **Freshness uses a single key.** `dedupeBy = metadata.url` misses the same content under another URL, which TRACE admits too. | MUST 4 | Once snapshots exist (gap 1), also add the snapshot content hash to the ledger and skip either match. |
| 17 | **No reference contender and no anchor set**, so contender drift, judge drift and item drift can't be separated. | SHOULD 1, 2 | `reference = "<contender>"` (pinned) and `[anchor]` (a fixed set of ≥30 cases re-run every run and excluded from fresh stats). Report the reference's absolute rate as the difficulty index and run EWMA on paired diffs and on anchor re-grades. |
| 18 | **Latency and cost comparisons are thin.** The latency diff is an arithmetic mean in ms. There is no paired cost comparison. A fixed `costPerRun` is charged on failures with no flag. Tokens are stored as one sum, so cost can't be recomputed. | 4.9 | Report the paired log-ratio GMR for latency and cost, store tokens `{in, out}`, mark each cost `reported` / `price-table(date)` / `assumed`, and add cost per success and a Pareto frontier to the report. |
| 19 | **An interrupted run stores nothing and can't resume**, wasting spend. | SHOULD | Checkpoint cells keyed by (case, contender, trial) to a partial file. `bench run --resume` finishes the same frozen set, and only complete runs enter history. |
| 20 | **Not built yet:** MCP read tools, `docs/guides/benchmarks.md`, raw per-case export. | MUST 16 | Have MCP expose `bench_list`, `bench_show`, `bench_history`, `bench_compare` with the same JSON as `--json`. Add `bench export <run>` that writes per-case JSONL (ids, hashes, seed, versions, outcomes, timings, cost, excluded reasons), private inputs omitted. |

## Sources

TRACE: <https://trace.context.dev>, <https://github.com/context-dot-dev/trace-benchmark>,
<https://raw.githubusercontent.com/context-dot-dev/trace-benchmark/main/docs/methodology.md>

Live benchmarks and critiques: <https://arxiv.org/abs/2406.19314>, <https://github.com/LiveBench/LiveBench>,
<https://arxiv.org/abs/2403.07974>, <https://github.com/LiveCodeBench/LiveCodeBench>, <https://arxiv.org/abs/2506.11928>,
<https://arxiv.org/abs/2505.23419>, <https://github.com/microsoft/SWE-bench-Live>, <https://arxiv.org/abs/2505.20411>,
<https://swe-rebench.com/about>, <https://arxiv.org/abs/2506.12286>, <https://arxiv.org/abs/2601.11868>,
<https://www.tbench.ai/leaderboard>, <https://arxiv.org/abs/2403.04132>, <https://arena.ai/blog/style-control/>,
<https://arxiv.org/abs/2504.20879>, <https://arxiv.org/abs/2211.09110>,
<https://crfm-helm.readthedocs.io/en/latest/reproducing_leaderboards/>, <https://arxiv.org/abs/2104.14337>,
<https://arxiv.org/abs/2502.17521>, <https://arxiv.org/abs/2412.13670>, <https://arxiv.org/abs/2411.00640>,
<https://arxiv.org/abs/2508.13144>, <https://arxiv.org/abs/2507.02825>, <https://metr.org/blog/2025-06-05-recent-reward-hacking/>,
<https://arxiv.org/abs/2510.07575>

Products: see the list under section 3.

Statistics: Cochrane Handbook ch. 10 <https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-10>;
hierarchical bootstrap <https://pmc.ncbi.nlm.nih.gov/articles/PMC7906290>; lme4 <https://www.jstatsoft.org/article/view/v067i01>;
NIST EWMA/CUSUM <https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc324.htm>,
<https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc323.htm>; PELT <https://arxiv.org/abs/1101.1438>;
Elo order-dependence <https://arxiv.org/abs/2311.17295>; Holm <https://www.jstor.org/stable/4615733>;
BH <https://www.jstor.org/stable/2346101>; BY <https://projecteuclid.org/journals/annals-of-statistics/volume-29/issue-4/10.1214/aos/1013699998.full>;
always-valid inference <https://arxiv.org/abs/1512.04922>; confidence sequences <https://arxiv.org/abs/1810.08240>;
betting CIs <https://arxiv.org/abs/2010.09686>, <https://arxiv.org/abs/2210.01948>; e-BH <https://arxiv.org/abs/2009.02824>;
Connor McNemar sample size <https://support.sas.com/documentation/cdl/en/statug/65328/HTML/default/statug_power_details55.htm>;
pass@k <https://arxiv.org/abs/2107.03374>; pass^k <https://arxiv.org/abs/2406.12045>; MT-Bench judge biases
<https://arxiv.org/abs/2306.05685>; self-preference <https://arxiv.org/abs/2404.13076>; geometric means for ratios
<https://dl.acm.org/doi/10.1145/5666.5673>; randomized interleaved trials
<https://research.spec.org/icpe_proceedings/2017/proceedings/p287.pdf>; AI Agents That Matter <https://arxiv.org/abs/2407.01502>.

Not verified from a primary page: SWE-bench-Live repeat count and CI method; Terminal-Bench CI method and 4.0
contents; LMArena's current production CI method; HELM CI method. Cochran's optimal two-stage allocation
and the Holm/BH originals are cited from standard references, not fetched.
