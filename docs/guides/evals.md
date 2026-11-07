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

`coding.sh exp aa --dataset D --task T --grader G` runs one config twice and stores its run-to-run
noise: the A/A delta, flipped cases, the SD of per-case differences, and the cases needed to detect
a 5pp or 10pp change. `coding.sh exp aa A B` measures it from two stored runs instead.

## Judges

`coding.sh judge calibrate` measures judge and human agreement (Cohen's kappa) on a held-out split.
Every report flags judges that are not calibrated. It also stores the judge's held-out sensitivity
and specificity, so later `exp compare` runs show a bias-corrected (Rogan-Gladen) judge pass rate.

## Harness A/B

`coding.sh harness snapshot` bundles an agent's harness files (CLAUDE.md, AGENTS.md, skills, hooks,
MCP config). `coding.sh compare A B` runs both bundles on eval tasks in isolated config
directories. It reports per-arm Wilson intervals and the first step where the traces diverge.

## Tool evals

`coding.sh toolevals` measures how well agents use a CLI, MCP server or HTTP API: surface size,
schema checks, per-task tool-call metrics in a sandbox, variant comparisons and MCP description
compression. See [TOOL-EVALS.md](../TOOL-EVALS.md).

## Workflows

`coding.sh workflows` imports multi-agent workflow runs and reports the run tree, critical path,
concurrency, cost and paired variant comparisons. See [design/workflows.md](../design/workflows.md).
