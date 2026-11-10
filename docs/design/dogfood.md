# Dogfood: testing coding.sh on itself, continuously

Status: partly built. The self-evals (§3) and the scorecard (§4) are in `scripts/dogfood`
(`npm run dogfood`, `npm run dogfood:validate`); the project-scope hook files of §1.1 are not
committed. §6 gives the state of each step, with code pointers. This doc is the contract for `npm run dogfood`, the self-capture setup in this repo,
and the improvement loop.

coding.sh is built mostly by coding agents. Every one of those sessions is data about agents, and
every bug those agents hit in coding.sh is a test case. The plan has four parts:

- record all of it;
- score coding.sh with its own evals;
- combine the scores into one scorecard;
- run a loop that fixes the worst regression and keeps only changes that improve the scorecard
  without regressing anything else.

Paths below are relative to the repo root unless absolute.

## 1. Self-capture

### 1.1 Hooks at project scope

Capture uses project-scope files only. Nothing user-global changes, except coding.sh's own home
directory `~/.coding.sh/`, where the hook binary and the spool live.

| Agent | File (project scope) | Notes |
|---|---|---|
| Claude Code | `.claude/settings.json` (committed) | Committed so every git worktree, including fix-agent worktrees, is captured too. `settings.local.json` would not exist in a fresh worktree. |
| Codex | `.codex/hooks.json` (Claude-shaped) + `[features] hooks = true` in `.codex/config.toml` | Codex runs new hooks only after the user trusts them by hash (`/hooks` in the TUI, once). We never write trust hashes. Headless dogfood runs pass `--dangerously-bypass-hook-trust`. Codex loads project `config.toml` only for trusted projects (U: confirm on 0.166). |
| OpenCode 2.x | `.opencode/plugins/coding-sh.ts` (U: confirm 2.x project plugin dir) | OpenCode is not installed on this machine. Add the plugin when the adapter lands. |

The Claude Code entry for each event is below. Events: SessionStart, UserPromptSubmit, PreToolUse,
PostToolUse, PostToolUseFailure, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact,
SessionEnd.

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "timeout": 5,
        "command": "[ -f \"$HOME/.coding.sh/bin/hook.mjs\" ] && node \"$HOME/.coding.sh/bin/hook.mjs\" claude-code PostToolUse || true" } ] }
    ]
  }
}
```

- The `[ -f … ] && … || true` guard makes the file harmless in a clone without coding.sh: the
  hook exits 0 and prints nothing.
- Our entries are identified by the substring `/.coding.sh/bin/hook.mjs` in `command`, not by an
  extra JSON key, because Claude Code may reject unknown keys in hook entries.
- The hook at `~/.coding.sh/bin/hook.mjs` is a pinned copy. It is updated only by
  `npm run dogfood:install-hook`, which runs the hook tests first. A fix agent that breaks
  `src/spool/hook.ts` in a worktree cannot break capture of its own session.
- Reverse with `coding.sh uninstall --scope project`, or, before the CLI exists, with
  `node scripts/dogfood/hooks.mjs remove`. Both delete only the matching entries and leave the rest
  of `.claude/settings.json` (for example `workflows/`) unchanged.

### 1.2 OTel for model latency

Claude Code ignores OTel exporter variables in a repository's `.claude/settings.json` and
`settings.local.json`; a repository can only turn a signal off (code.claude.com/docs/en/monitoring-usage).
Two project-scoped routes remain:

1. **Headless runs.** Every dogfood script launches Claude Code with
   `--settings scripts/dogfood/claude-otel.json`. A `--settings` file is honored:

   ```json
   { "env": {
       "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
       "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
       "OTEL_TRACES_EXPORTER": "otlp", "OTEL_LOGS_EXPORTER": "otlp", "OTEL_METRICS_EXPORTER": "otlp",
       "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
       "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",
       "OTEL_LOGS_EXPORT_INTERVAL": "2000"
   } }
   ```

2. **Interactive sessions.** A repo-root `mise.toml` with the same keys under `[env]`. mise is
   installed here and appears to be activated in the shell. The variables are set only while the
   shell is inside the repo, and deleting the file reverses it. Without mise, the user exports them
   by hand. We never edit `~/.claude/settings.json`.

Prompt and response content stays off (`OTEL_LOG_USER_PROMPTS` unset). Hooks and transcripts
already capture content, with redaction applied.

What this yields:

- `claude_code.llm_request` spans with `duration_ms`, `ttft_ms` and `agent_id`/`parent_agent_id`,
  normalized to `llm.call` events;
- `claude_code.api_request` log events as a fallback;
- for Codex, `PreModelRequest`/`PostModelRequest` hooks.

The receiver must be running (`coding.sh collector`). If it is not, exports are lost and
`doctor` reports `receiver: down`. The scorecard's capture-health metric (§4) catches silent gaps.

### 1.3 Data safety

- Live capture writes to the default `~/.coding.sh`.
- The scorecard never runs a development build against the live store. Every step that needs data
  copies it first:

  ```sh
  cp -c ~/.coding.sh/index.db* "$TMP/home/"   # APFS clone
  CODING_SH_HOME="$TMP/home" node dist/cli.mjs ...
  ```

  A schema migration bug in a candidate therefore cannot corrupt the real store.
- Tests and fixtures never contain real session content. Fixtures derived from our sessions go
  through `createRedactor` and a manual review before being committed (§3.3).

## 2. Running agents headless

The user's interactive `claude` is a zsh function that adds fallback models and permission flags.
npm scripts run under `sh` and resolve the real binary, which is the intended behavior. Dogfood
scripts pin the model explicitly.

| Agent | Command used by dogfood scripts |
|---|---|
| Claude Code | `claude -p --output-format stream-json --verbose --model <m> --max-turns <n> --max-budget-usd <x> --settings scripts/dogfood/claude-otel.json --permission-mode bypassPermissions "<instruction>"` (inside a trial sandbox only) |
| Codex | `codex exec --json -m <m> -s workspace-write -C <dir> --skip-git-repo-check --dangerously-bypass-hook-trust "<instruction>"` |

Gemini CLI is not installed. That affects the council (§3.4). No other model substitutes for it.

## 3. Self-evals

### 3.1 CLI effectiveness suite on coding.sh's own CLI

This is the tool-eval suite (docs/TOOL-EVALS.md) with target `codingsh` (CLI,
`command = ["node", "<worktree>/packages/coding.sh/dist/cli.mjs"]`).

- It measures whether the Vercel CLI guidelines hold up in practice. Under a guideline-compliant
  CLI, an agent should need few `--help` reads, hit few unknown-flag errors, and recover from the
  errors it does hit.
- Task files live in `evals/toolevals/codingsh/tasks/`.
- `fixtures/make-home.mjs --seed <n>` builds a deterministic `CODING_SH_HOME`:
  - synthetic spool lines for claude-code, codex and opencode sessions with known properties (one
    slow tool call, a failing run, a subagent tree, a compaction, two experiment arms with a
    known difference, and so on);
  - timestamps rebased to the trial's start time, so "yesterday" is well defined;
  - ingestion through the CLI build under test, so ingest is tested too;
  - `hidden/answers.json` for the checks.
- Drivers are `agent:claude-code:<sonnet-class model>` and `agent:codex:<default>`, with k = 3.
  The model driver is added when an API key is set.

Dev split (20 tasks, committed):

| id | Instruction (abridged) | Check |
|---|---|---|
| `slowest-tool` | Find the slowest tool call in yesterday's sessions; give session id and tool | output contains both |
| `sessions-by-agent` | Sessions per agent in the last 7 days, as JSON | output jsonEquals |
| `most-failed-tools` | Which session had the most failed tool calls? | output contains id |
| `session-to-eval` | Turn session S into an eval task | state: `eval list --json` has `sourceSessionId = S` |
| `validate-task` | Validate task T and say whether it passed | output + state `status` |
| `compare-arms` | Compare arms A and B of experiment E; which is better, and is it significant? | output contains verdict + yes/no from answers |
| `why-run-failed` | Why did the most recent eval run fail? | output contains the fixture's failure reason |
| `search-prompt` | Find the session where the user asked about the flaky snapshot test | output contains id |
| `llm-p95` | p95 model-call latency across codex sessions this week, in ms | number within ±1 |
| `subagent-types` | Which subagent types did session S spawn? | set equality |
| `spend-today` | Total agent spend today in USD, to the cent | number equality |
| `export-harbor` | Export task T in Harbor format to `./out` | state: Harbor files exist |
| `doctor-codex` | Codex capture looks broken; find out why | output contains the doctor reason code |
| `uninstall-preview` | Show what removing coding.sh would change, without changing anything | state: fake HOME hash unchanged; output lists paths |
| `gc-preview` | How many bytes would gc free? | number equality |
| `otel-env` | Env vars to send Claude Code telemetry to coding.sh | output contains endpoint + protocol |
| `repo-sessions` | Session ids for repo R since Monday | set equality |
| `bundle-diff` | What differs between bundles `base` and `lean`? | output contains changed paths |
| `dataset-add` | Add a case to dataset `smoke` (input `ping`, expected `pong`) | state: dataset JSON |
| `mcp-surface` | How many description bytes does the fixture MCP server send? | number equality |

Held-out split: 10 tasks, written by a human, stored in `~/.coding.sh/dogfood/heldout/` and never
committed. They cover the same capability areas (querying, eval authoring, experiments, capture
diagnosis, config) with different phrasing and multi-step composition. This doc does not list
them, because the repo is readable by the agents being scored.

Scores from this suite:

| Score | Definition |
|---|---|
| `cli.heldout.success` | Success rate (Wilson CI) over held-out trials, all drivers |
| `cli.dev.success` | Same on dev; reported, not in the headline |
| `cli.invalidRate` | Held-out `invalidCalls / targetCalls` |
| `cli.helpPerTask` | Held-out mean `helpLookups` |
| `cli.recoveryRate` | Held-out mean `recoveryRate` |
| `cli.costPerSuccess` | Held-out cost / successes |
| `cli.guidelines` | Static conformance: the fraction of `test/cli/guidelines.test.ts` cases passing. Every command runs in 7 modes (TTY via `script`, redirected, piped stdin, `--json`, `--non-interactive`, `CI=1`, agent env). Asserts: one JSON document; nothing but the result on stdout; exit codes 0/1/2/130; `--help` under 200 ms offline; no color under `NO_COLOR` or a pipe; at most one "did you mean"; `action_required` instead of a prompt when non-interactive; no "successfully", "just" or "simply" in output |

### 3.2 Session-derived evals from our builder sessions

Our captured sessions in this repo are the source.

1. **Weekly harvest.** `node scripts/dogfood/harvest.mjs --since 7d` lists sessions in this repo
   that have flags (`premature-completion`, `repeated-tool-failure`, `no-verification`). It also
   lists sessions whose changes were later corrected: a later session touches the same files and
   its message says fix or revert.
2. **Draft.** Each candidate goes through `coding.sh eval new <session>`: the pre-agent snapshot,
   the instruction, a verifier guessed from repo facts (`npm test -w coding.sh -- <file>`), and the
   reference patch from the later fixing session.
3. **Validate.** `coding.sh eval validate`: the no-op fails, the reference passes k/k, the near
   misses fail, and there is no leakage.
4. **Promote.** A task is promoted automatically when validation passes and the verifier is a test
   file that exists in the repo. Anything else waits for a human in `tasks/dogfood/review.md`.
5. **Replay.** Replay runs under bundle `repo-default` (this repo's AGENTS.md, CLAUDE.md, `.claude/`)
   with `claude-code` and `codex`, k = 3.

Score: `replay.success`, the pass rate on promoted tasks. 30% of promoted tasks are randomly
assigned to held-out when promoted. Fix agents never see their instructions.

### 3.3 Conformance

| Suite | Runs | Score |
|---|---|---|
| Fixtures | `npm test -w coding.sh -- test/adapters`. Recorded raw payloads per agent version go through `normalize` and are compared with golden events. Fixtures come from our own spool (redacted) for claude-code and codex, and from docs examples for the others | `conformance.fixtures`: the fraction of golden files passing |
| Nightly smoke | `node scripts/dogfood/smoke.mjs` | `conformance.smoke`: the fraction of installed agents passing; agents not installed are `skipped`, not failed |
| Doctor | `coding.sh doctor --json` against the live home | `capture.health`: the fraction of this repo's sessions in the last 24 h that have session.start, tool events and session.end, plus, for Claude Code, at least one `llm.call` |

What the nightly smoke does for each agent:

1. Install the latest version into an isolated prefix (`~/.coding.sh/dogfood/agents/<agent>/`),
   not on `PATH`.
2. Create a temp HOME with the agent's auth copied in read-only (for example `~/.codex/auth.json`)
   and a temp repo with project hooks installed.
3. Run a scripted headless session: read a file, run `ls`, spawn one subagent, finish.
4. Assert that the normalized events contain session.start, tool.start/end, subagent.start/end
   (where the agent supports them, per docs/TOOL-EVALS.md §7) and session.end.

Claude Code in an isolated config dir needs a long-lived token. A human creates it once with
`claude setup-token` and stores it in `~/.coding.sh/dogfood/secrets.env` (mode 600).

### 3.4 Site

| Score | How | Target |
|---|---|---|
| `site.lighthouse` | `npx -y lighthouse@12 <url> --preset=desktop` and mobile defaults, against `astro preview` on `127.0.0.1:4329`; min over the performance, accessibility, best-practices and SEO categories | mobile perf ≥ 0.95; a11y = 1.0; BP ≥ 0.95; SEO = 1.0 |
| `site.vitals` | From the same reports: LCP, CLS, TBT (mobile, simulated) | LCP ≤ 2.0 s; CLS ≤ 0.02; TBT ≤ 100 ms |
| `site.js` | gzip bytes of JS shipped on `/` (from `apps/site/dist`) | ≤ 60 KB |
| `site.council` | Council score relative to competitors (below) | ≥ +1.0 over the competitor mean |

Council rules:

- **Members:** Claude Opus (an Agent subagent, `model: "opus"`, read-only) and GPT (`codex exec -s
  read-only -o <out.md> -i <png>… "<brief>"`). Gemini is not a member while the `gemini` CLI is
  missing, and every council report states that.
- **Screenshots:** taken fresh by chrome-devtools MCP: desktop 1440×900 and mobile through
  `emulate` `390x844x2,mobile,touch`, confirmed with `innerWidth`. The site has one (dark) theme,
  so there is one set. Competitor screenshots are refreshed monthly into
  `~/.coding.sh/dogfood/competitors/<yyyy-mm>/` (not committed).
- **Blinding:**
  - Reviewers score every site in the set, ours included, on the same 1–10 rubric. Sites are
    labeled `Site A`…`Site J` in shuffled order.
  - Reviewers never see the target, our previous scores or the round number.
  - The fix-agent brief may include the target; reviewer briefs may not. Theo saw scores inflate
    when reviewers knew the target.
- **Relative score:** our mean minus the competitor mean. Uniform inflation cancels out.
- **Anchor:** a frozen screenshot of our site from the first council run is in every set. If the
  anchor's score moves by more than 1.0 from its first value, the round is flagged
  `reviewer-drift` and excluded from keep decisions.

### 3.5 Performance budgets

Each benchmark runs interleaved with the baseline build (A B A B …) on the same machine in the same
tick, so machine noise is paired.

| Score | Benchmark | Target |
|---|---|---|
| `perf.hook` | `scripts/dogfood/bench-hook.mjs`: 5 warmups, then 50 spawns of `node dist/hook.mjs claude-code PostToolUse` with a 2 KB payload, compared with 50 spawns of `node -e ""` | median(hook) − median(node) ≤ 10 ms; p95 ≤ +25 ms; with a 1 MB payload ≤ +40 ms |
| `perf.ingest` | `bench-ingest.mjs`: 100k synthetic claude-code spool lines → fresh SQLite home | ≥ 5,000 events/s |
| `perf.storeSize` | `bench-store.mjs`: (index.db + blobs on disk) / (events / 1000), over the synthetic corpus plus a redacted copy of our last 7 days | ≤ 2.0 MB per 1k events |
| `perf.viewerTti` | Lighthouse `interactive` on `coding.sh ui` serving a 5,000-event session | ≤ 1,000 ms |
| `perf.help` | `coding.sh --help`, median of 20 runs | ≤ 200 ms |

The initial targets come from the design constraints: the hook must stay invisible, and the help
time is Vercel's limit. After 10 runs, each throughput or size target tightens to
`max(target, best observed × 0.9)`. Targets never loosen without human approval.

## 4. One scorecard

`npm run dogfood [-- --mode quick|full] [--compare-to <scorecard.json>] [--json]` writes
`tasks/dogfood/scorecard.json` and appends one line to `tasks/dogfood/history.jsonl`.

| Mode | Includes | Cost | When |
|---|---|---|---|
| `quick` | gates, `cli.guidelines`, conformance fixtures, perf, Lighthouse, capture health | $0 | every loop tick, every candidate |
| `full` | quick + CLI suite (dev + held-out, 2 drivers, k = 3), replays, nightly smoke, council | about $15–30 in reported cost per run (U: measure the first run) | nightly, and for candidates that touch the CLI or adapters |

In `quick` mode, components that were not run keep their last `full` value and are marked
`stale: true` with their age.

```jsonc
// tasks/dogfood/scorecard.json
{
  "v": 1, "ts": 1794000000000, "commit": "<sha>", "dirty": false, "mode": "full",
  "agents": { "claude-code": "2.1.319", "codex": "0.166.0" },
  "gates": { "typecheck": true, "tests": true, "build": true, "siteBuild": true },
  "headline": 71.4,
  "components": {
    "cli.heldout.success": { "value": 0.63, "ci": [0.55, 0.70], "n": 60, "target": 0.90, "weight": 30, "unit": "rate" },
    "perf.hook":           { "value": 7.8, "target": 10, "unit": "ms", "weight": 0, "group": "perf" }
    // … every score in §3
  },
  "costUsd": 22.10, "notes": ["gemini CLI not installed: council has 2 members"]
}
```

**Headline** (0–100). If any gate fails, the headline is `null` with `gated: [<gate>]`, and nothing
can be kept. Otherwise it is the weighted sum of normalized components:

| Weight | Component | Normalization to [0, 1] |
|---|---|---|
| 30 | `cli.heldout.success` | value |
| 10 | `cli.invalidRate` (held-out) | 1 − min(1, value / 0.20) |
| 10 | `cli.guidelines` | value |
| 15 | `replay.success` (held-out part) | value |
| 15 | `conformance` | mean of fixtures, smoke and capture health |
| 10 | `perf` | fraction of perf budgets met |
| 10 | `site` | 0.6 × fraction of Lighthouse, vitals and JS budgets met + 0.4 × clamp((council relative + 2) / 4) |

Dev-split scores, cost and latency are reported without weight. The headline uses held-out splits
only. Cost is not in the headline, so "raise the budget" cannot raise the score. Instead,
`cli.costPerSuccess` and `cli.wallMs` are regression-checked in the keep rule (§5).

Guards against Goodhart's law:

1. **Held-out data.** The headline uses held-out tasks. Fix agents see dev tasks and their traces
   only. Each week, the loop reports `gap = dev − heldout` for the CLI and replay suites. A gap
   above 15 points is flagged as overfitting to dev, and a human writes new held-out tasks. Held-out
   tasks rotate quarterly.
2. **Hidden targets.** Fix-agent briefs name the failing metric and the failing dev tasks, not the
   headline value or the targets. Reviewer briefs (council, judges) never contain targets or prior
   scores.
3. **Programmatic over judged.** The only judged input is the council, at 4 of 100 points. Every
   other score is a test, a measured number or a state check.
4. **Scorer immutability.** A candidate diff is rejected automatically if it touches:
   - `scripts/dogfood/**`, `evals/**` or `apps/site/lighthouse*`;
   - any existing file under `test/` (adding new test files is allowed);
   - any target in this doc or in `scorecard.json`.

   Changing the scorer is human work.
5. **Statistical honesty.** No keep decision rests on one trial. Agent suites use k ≥ 3 and paired
   statistics. Deterministic metrics use the interleaved benchmark with a bootstrap CI on the
   median difference.
6. **Limited held-out feedback.** Held-out suites run only for candidates that already pass dev,
   at most 20 held-out evaluations per week. The fix agent learns only kept or rejected, so
   repeated queries cannot fit the held-out set.

## 5. The loop

One tick runs the steps below. Steps 1–3 and 5–7 are deterministic scripts. Only step 4 is an
agent.

```sh
# 0. preconditions: clean main checkout, receiver up, daily budget not exhausted
node scripts/dogfood/tick.mjs preflight            # exits 3 with a reason if any precondition fails

# 1. score main (quick; full if last full is older than 24 h)
npm run dogfood -- --mode auto --json > "$TICK/base.json"

# 2. pick the worst item
node scripts/dogfood/pick.mjs "$TICK/base.json" tasks/dogfood/history.jsonl > "$TICK/next.json"
#    order: failing gate > component regressed vs previous entry (significant) >
#           largest (target − value) × weight; skip items attempted ≥ 2 times in a row

# 3. worktree
ID=$(node -p 'require(process.argv[1]).id' "$TICK/next.json")
git worktree add ".claude-workspace/worktrees/dogfood-$ID" -b "dogfood/$ID"

# 4. fix agent (captured by the committed project hooks)
cd ".claude-workspace/worktrees/dogfood-$ID"
claude -p --model "$FIX_MODEL" --max-turns 120 --max-budget-usd 8 \
  --settings scripts/dogfood/fix-agent-settings.json \
  --output-format stream-json --verbose \
  "$(node scripts/dogfood/brief.mjs "$TICK/next.json")" > "$TICK/fix.jsonl"

# 5. re-score the candidate, paired with base
npm run dogfood -- --mode auto --compare-to "$TICK/base.json" --json > "$TICK/cand.json"

# 6. decide
node scripts/dogfood/keep.mjs "$TICK/base.json" "$TICK/cand.json" --diff "$(git diff main...HEAD --stat)"

# 7. keep → commit on dogfood/$ID, fast-forward local main; reject → record and remove worktree
node scripts/dogfood/tick.mjs finish "$TICK" --decision "$(cat "$TICK/decision")"
```

`fix-agent-settings.json` (a `--settings` file, so it applies only to this run):

```json
{
  "permissions": {
    "allow": ["Read", "Edit", "Write", "Bash(npm *)", "Bash(node *)", "Bash(npx tsc *)",
              "Bash(git diff*)", "Bash(git status*)", "Bash(git log*)"],
    "deny":  ["Read(~/.coding.sh/dogfood/heldout/**)", "Edit(scripts/dogfood/**)", "Edit(evals/**)",
              "Bash(git push*)", "Bash(git commit*)", "Bash(npm publish*)", "Bash(git worktree*)",
              "WebFetch", "Bash(curl *)"]
  },
  "env": { "CODING_SH_DOGFOOD_ROLE": "fixer" }
}
```

The deny rules deter the fix agent but do not stop a determined one: Bash can read files in other
ways. The keep rule's diff check, and running held-out suites outside the worktree, are what
enforce the rules.

The brief (`brief.mjs`) contains:

- the item id, the metric name and its definition;
- for agent suites, the failing dev task ids, with `coding.sh show` excerpts of the failing trials
  (first invalid call, error text, help lookups);
- the files most likely involved, from the trace's tool calls and stack traces;
- the rules: edit only `packages/` and `apps/`, add a regression test, run
  `npm run check -w coding.sh`.

It does not contain the headline, targets or held-out data.

Keep rule (`keep.mjs`). A candidate is kept only if all of the following hold:

1. All gates pass.
2. The picked component improves.
   - Agent suites: the paired bootstrap 95% CI of the success difference excludes 0, or McNemar
     p < 0.05.
   - Deterministic metrics: the CI of the median difference excludes 0 in the good direction.
3. No other component regresses. Each needs paired non-inferiority with margin δ:
   - 0.03 for rates;
   - 5% for perf medians;
   - 10% for `cli.costPerSuccess` and `cli.wallMs`;
   - 0.5 for the council relative score.

   Stale components count as unchanged only if the diff does not touch their area. A CLI change
   forces the CLI suite to run.
4. The diff touches no protected path (§4, guard 4) and is at most 600 changed lines.
5. The headline does not go down.

On keep:

1. `git commit` on `dogfood/<id>` with the scorecard delta in the message.
2. Fast-forward the local default branch.
3. Append `{decision:"keep", id, delta}` to `tasks/dogfood/history.jsonl`.

On reject:

1. Append `{decision:"reject", reason}` to `tasks/dogfood/attempts.jsonl`.
2. Keep the branch for 7 days, and remove the worktree.

An item rejected twice in a row moves to `tasks/dogfood/review.md` for a human.

Scheduling:

| How | Use |
|---|---|
| `/loop 2h node scripts/dogfood/tick.mjs run` in a dedicated Claude Code session in this repo | During working hours, with the session open. `/loop` re-arms in-session. |
| `launchd` agent `sh.coding.dogfood.plist` → `scripts/dogfood/tick.sh` at 02:00 | Nightly `full` plus one tick. Installing it writes to `~/Library/LaunchAgents`, a user-global change, so a human installs it. |
| `/schedule` (cloud routines) | Not used. Cloud runs have no access to the local store, agents or receiver. |

Limits per day: 6 ticks, $40 in reported cost (`DOGFOOD_DAILY_USD`), and 1 concurrent fix agent.
Fix agents in worktrees are recorded by the project hooks, and their sessions feed §3.2.

### What a human must approve

| Action | Why |
|---|---|
| `npm publish`, `git push`, opening PRs, creating releases | Outward-facing |
| Claiming names: npm packages, GitHub orgs or repos, domains, social handles | Outward-facing and hard to undo |
| Any change to user-global config: `~/.claude`, `~/.codex`, `~/.config/*`, `~/Library/LaunchAgents` | Outside project scope |
| Writing or changing held-out tasks, targets, weights, the scorer, or the keep rule | Prevents the loop from grading itself |
| Promoting session-derived tasks without a test verifier | Task quality |
| Merging a kept change over 600 lines, or one touching protected paths | Review size |
| Raising the daily budget; installing new agent CLIs on `PATH` | Cost and machine state |
| Deleting anything under `~/.coding.sh` except the loop's own temp dirs | Data loss |

## 6. Bootstrapping order

The order the pieces were planned in. The State column is checked against the code; the commit
history has started, so step 0 is done.

| Step | State |
|---|---|
| 0 | Done. |
| 1 | Partly built. The build and the hook are in `packages/coding.sh`; `coding.sh init --scope project` writes project-scope hooks. Open: `scripts/dogfood/hooks.mjs`, `npm run dogfood:install-hook` and a committed `.claude/settings.json` (§1.1). |
| 2 | Built: `scripts/dogfood/score.mjs`, `bench.mjs` and `bench-{hook,ingest,store,help,viewer,where,proxy,collector}.mjs`; `npm run dogfood`. |
| 3 | Built: `src/adapters/claude-code.ts`, fixtures in `packages/coding.sh/test/fixtures/adapters/claude-code`, checked by `scripts/dogfood/conformance.mjs`. |
| 4 | Built: the OTLP receiver (`src/otel`) and `scripts/dogfood/claude-otel.json`. Open: `mise.toml`. |
| 5 | Built: the CLI (`src/cli`) and `scripts/dogfood/cli-guidelines.mjs` for `cli.guidelines`. |
| 6 | Built: tool evals (`src/toolevals`), `evals/cli` (25 dev tasks, `fixtures/make-home.mjs`) and `scripts/dogfood/cli-suite.mjs`. The held-out tasks live outside the repo (`heldoutDir` in `evals/cli/suite.toml`) and are written by a human. |
| 7 | Built: `src/adapters/codex.ts`. The project `.codex/hooks.json` is installed per machine, not committed. |
| 8 | Open: `harvest.mjs` and the replay of promoted tasks; `score.mjs` reports `replay.success` as skipped. |
| 9 | Partly built: `scripts/dogfood/site.mjs` runs Lighthouse and the JS budget. Open: the council script (`site.council` is skipped). |
| 10 | Open: `tick.mjs`, `pick.mjs`, `brief.mjs` and `keep.mjs`. The loop runs as `.claude/workflows/coding-sh-improve.js` for now. |
| 11 | Open: workflow scoring of `coding-sh-improve.js` (docs/design/workflows.md §9). |

The plan for each step:

| Step | Work | Gives the scorecard |
|---|---|---|
| 0 | Human makes the first commit (needed for worktrees and for scorecard `commit` fields) | — |
| 1 | `npm run build -w coding.sh`; `scripts/dogfood/hooks.mjs install` copies `dist/hook.mjs` to `~/.coding.sh/bin/` and writes the `.claude/settings.json` hooks (§1.1). The spool starts filling today, before any adapter exists. | data |
| 2 | `scripts/dogfood/{score.mjs,bench-hook.mjs,bench-ingest.mjs,bench-store.mjs}`; root script `"dogfood": "node scripts/dogfood/score.mjs"`. The ingest and store benchmarks use synthetic events through `ingest()` with a stub normalizer until the Claude Code adapter lands. | gates, `perf.hook`, `perf.ingest`, `perf.storeSize` |
| 3 | Claude Code adapter + fixtures recorded from our spool (redacted) | `conformance.fixtures`; the real data becomes queryable |
| 4 | OTLP receiver + `scripts/dogfood/claude-otel.json` + `mise.toml` | `llm.call` latency in our own sessions; `capture.health` |
| 5 | CLI (integrate) + `test/cli/guidelines.test.ts` | `cli.guidelines`, `perf.help`, `perf.viewerTti` |
| 6 | Tool evals core: CLI target, shim tap, agent driver, output/state checks. Then `fixtures/make-home.mjs` and the 20 dev tasks; a human writes the 10 held-out tasks. | `cli.*` |
| 7 | Codex adapter + `.codex/hooks.json`; the user trusts the hooks once | second driver; Codex capture |
| 8 | `harvest.mjs` + replay of promoted tasks | `replay.success` |
| 9 | Lighthouse + council scripts | `site.*` |
| 10 | `tick.mjs`, `pick.mjs`, `brief.mjs`, `keep.mjs`. Three ticks supervised by hand, then `/loop`, then launchd after human approval | the loop |
| 11 | Workflow scoring of `coding-sh-improve.js` (docs/design/workflows.md §9) | `workflow.*` (reported, weight 0 at first) |

Each step lands with its tests and produces at least one scorecard line, so the history starts at
step 2 and every later step shows up as a change in the scorecard.

## Trace loop

The improve loop works better when it is fed by what went wrong in real sessions. Run the trace
loop first:

1. `coding-sh-traces {round: n}` imports new history into `~/.coding.sh` and mines it with
   `scripts/traces/traces.mjs`. Both steps are incremental and cost no tokens. It then digests up
   to 40 new informative sessions, clusters them, and appends:
   - coding.sh bugs to `tasks/research-queue.md`, under "Round 2 additions (real traces)";
   - harness proposals to `docs/research/my-traces.md`. These are never applied automatically.
2. `coding-sh-improve {round: n, skip: ["integrate", "build", "seamless"]}` then reads the queue in
   its Research and Queue phases.

Snapshots go to `~/.coding.sh/dogfood/traces-<n>.json`, each with a diff against round n-1. One
round costs about 120 to 150 k tokens. Numbers, storage choice and budget:
[docs/research/trace-loop.md](../research/trace-loop.md).
