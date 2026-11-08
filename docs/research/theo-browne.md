# Theo Browne (t3dotgg): tools, benchmarks and takes, for coding.sh

Compiled 2026-11-07. Nothing in this note has been built. The ranked items are TB-1 to TB-14 in
`tasks/research-queue.md` (section "Research Theo Browne").

**Source quality.** Code and docs on GitHub were read from clones made on 2026-11-07. X posts
could not be fetched (HTTP 402), so their text here comes from search-result snippets. Many
claims about his videos come only from [BigGo](https://finance.biggo.com) pages. Those pages are
generated summaries with no links to the video, and two of them contradict each other. Numbers
from them are marked "(BigGo)" and should be checked against the video before anyone quotes them.

## Summary

- Theo's working loop is: turn a problem into a program that prints a score, let agents climb it,
  and keep a human on the decision to stop. He trusts program-scored evals and distrusts
  model-judged scores, which drift and inflate.
- His cost lever is reasoning effort and context size, not terse output. He reports a low-effort
  GPT model tying Opus at max effort for a small fraction of the cost (BigGo). T3 Code's MCP
  tool text was cut by about half while holding an eval score.
- His agent workflow is PR-centric: prove the change, review with other providers' models in
  rounds, babysit CI and review bots, merge behind a gate. Review loops that never converge or
  that grow the PR are his main stated risk.
- T3 Code now has an `evals/` folder with a written method that matches coding.sh's own rules
  closely: cases from real failures, controls, a baseline on the same model, and no absolute
  scores.
- He routes his own inference through a fork of CLIProxyAPI and logs requests to ClickHouse.
  CLIProxyAPI has 58k stars and emits a detailed per-request usage record that coding.sh does not
  read today.

## 1. The CLI proxy

**What it is.** Theo runs a private fork of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
and sends nearly all his inference through it. He posted in October 2026: "I collected all of my
requests to Claude and Codex and put them in a clickhouse db" ([X](https://x.com/theo/status/2110269416315429179)).
A summary of a later stream says the database sits on a NAS and holds about 500 billion tokens in
about 6 GB (BigGo, [1](https://finance.biggo.com/news/8152715d604b4e26)). Another BigGo page calls
the fork "Prox" and says it logs only model, effort and token counts, but the same page also
attributes the setup to someone else ([2](https://finance.biggo.com/news/ce59aabd0b52499f)). What
his fork logs is therefore not confirmed. The fork is not public.

**What CLIProxyAPI does.** It signs in to Claude Code, Codex, Grok Build, Gemini/Antigravity, Muse
Code and others with each tool's OAuth login, keeps the tokens fresh, and serves them as
OpenAI-, Claude-, Gemini- and Codex-compatible APIs. It load-balances across many accounts of one
provider. It listens on port 8317 by default ([config.example.yaml](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml)).

**How people connect.** Clients point their base URL at the proxy. Claude Code uses
`ANTHROPIC_BASE_URL` (a CLIProxyAPI status-line plugin finds the instance from that variable,
per the README). Codex gets a custom `model_providers` entry in `~/.codex/config.toml`; T3 Code's
own evals read one named `vibeproxy` ([evals/shared/proxy.ts](https://github.com/pingdotgg/t3code/blob/main/evals/shared/proxy.ts)).
T3 Code can also connect to a CLIProxyAPI "hub" through its management key to show pooled account
limits ([docs/user/usage.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md)).

**What it logs.** Since v6.10.0 the core has no built-in usage statistics. With
`usage-statistics-enabled`, it keeps one record per request in an in-memory queue for
`redis-usage-queue-retention-seconds` (default 60, max 3600). `GET /v8/management/observability/usage/queue`
returns the records and removes them, so only one consumer can drain it
([management API](https://github.com/router-for-me/CLIProxyAPI/blob/main/docs/management-api-v8.md),
[tokenlayer telemetry notes](https://github.com/EtanHey/tokenlayer/blob/main/docs/telemetry.md)).
Fields in `internal/redisqueue/plugin.go` include: provider, model, alias, response model,
endpoint, auth type and index, a SHA-256 of the access token, request, execution and trace ids,
`session_id` and `parent_session_id` (normalized to UUIDs), `is_fork`, `is_compaction`,
`reasoning_effort`, service tier (requested, effective, upstream), `speed`, a token breakdown with
cache reads and writes and reasoning tokens, tool and media counts, cost details, `latency_ms`,
`ttft_ms`, `failed`, `stream`, user agent and client IP. Full request bodies are a separate
`request-log` switch. Third-party tools store the queue: [CPA Usage Keeper](https://github.com/Willxup/cpa-usage-keeper)
(SQLite) and [tokenlayer](https://github.com/EtanHey/tokenlayer) (ClickHouse, plus a Claude and
Codex transcript shipper that marks Agent SDK lines with `entrypoint: "sdk-ts"` as T3).

**For coding.sh.** The record carries the session id, so it joins to coding.sh sessions without
time matching. It also has fields coding.sh lacks per call today: reasoning effort, service tier
and speed, the account, and a compaction mark (TB-9). coding.sh's own proxy (branch
`worktree-agent-abcf2293ee9dcb7cb`, not on main) already takes `--anthropic-upstream` and
`--openai-upstream`, so it can sit in front of CLIProxyAPI. `init --proxy` currently needs
`--force` to replace a base URL the user set, which would cut CLIProxyAPI out (TB-5).

## 2. T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) (51k stars) is a free, open-source app that drives
other agents: Codex, Claude Code, OpenCode, Cursor, Pi, Grok, Kiro, Muse, Antigravity and ACP
agents. Theo says it "is not a harness" ([flaviocopes](https://flaviocopes.com/t3-code/)). Its
Orchestrator V2 lets one harness delegate to another (`delegate_task`,
`orchestrator_capabilities`), and its MCP server lets outside agents start and read threads
([docs/user/outside-agents.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)).

**Usage page.** It reads local history for eight agents across connected machines and shows
tokens, cache savings, API-equivalent cost split by token type and by speed ("Premium" for fast
modes), custom prices with a "Map to" alias, and pooled subscription limits per 5-hour and weekly
window ([usage.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/usage.md),
[X](https://x.com/theo/status/2086053137115406588)). Text generation (titles, commit and PR text)
is missing from its totals for Codex and Claude Code 2.0.63+, because those runs save no history.
A proxy sees those calls.

**Evals.** [evals/README.md](https://github.com/pingdotgg/t3code/blob/main/evals/README.md) defines
five evals (MCP tool use, thread titles, PR content, voice cleanup, test signal). The rules:

- A case reproduces a real bad experience or guards a good one, and names its source.
- Add the case before the fix. It must fail on the old text and pass on the new text.
- Add controls, where the right action is ordinary work, to catch overcorrection.
- Run each case several times. A case fails when half or more of its samples fail. The default is
  2 samples, and a 3rd when the first 2 disagree.
- Compare against a baseline on the same model, never an absolute score.
  `--baseline <results> --stop-on-regression` stops when a case that passed every baseline sample
  fails.
- The eval imports prompts and tool schemas from source, never copies.
- A cheap model plays the shell, so nothing runs on the machine. Runs are comparable only with the
  same shell model.
- Errors are retried, then left out of pass rates; their tokens still count toward cost.
- Checks are declarative: `calls`, `callsMustNot`, `maxCalls`, `order`, `textMust`, with partial
  argument matches (`~text`, `"<=N"`).

The MCP tool-use eval costs about $9 on Sonnet and $17 on Opus per full run
([mcp-tool-use/README.md](https://github.com/pingdotgg/t3code/blob/main/evals/mcp-tool-use/README.md)).
Theo describes the origin: 80+ cases from real agent misuse, which Opus failed over half of; he
then had agents rewrite tool descriptions and cut context by about 50% with no regressions
([X](https://x.com/theo/status/2114955695434993702)). Summaries give 85–88 cases, a 60/88 start
for Sonnet, and 52% less context or 78% with tool search (BigGo, [3](https://finance.biggo.com/podcast/8b11242133423fc5)).

**Telemetry.** T3 Code exports its own server traces, metrics and logs over OTLP to a receiver you
set (`T3CODE_OTLP_*`). These are server operations (RPC, SQL, event-loop stalls, turn counters), not
model calls ([telemetry.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/telemetry.md),
[observability.md](https://github.com/pingdotgg/t3code/blob/main/docs/operations/observability.md)).

**How coding.sh integrates today.** `src/adapters/t3code.ts` reads `$T3CODE_HOME/userdata/statev2.sqlite`
(threads, runs, messages, turn items, provider threads and turns). The hook marks T3-launched runs
from `T3CODE_THREAD_ID` or the Codex originator "T3 Code" (`src/spool/host.ts`). Codex and Claude
content comes from their own transcripts, so there are no duplicates; subagent threads become
child sessions ([ADAPTERS.md](../ADAPTERS.md)). The tables still exist in T3's current schema. The
adapter does not read `orchestration_v2_projection_context_transfers`, `run_attempts` or `plans`. Theo's claim that
Agent SDK use drains 5-hour limits faster than the CLI ([BigGo](https://finance.biggo.com/news/a7f6180d1ab2dfb2))
can be checked with `coding.sh usage --by agent-model`, as the T3-1 entry already plans.

## 3. tstack skills

[t3dotgg/tstack](https://github.com/t3dotgg/tstack) (3.2k stars, MIT) holds nine skills for Claude
Code and Codex. Some use T3 Code tools when present and fall back to native tools.

| Skill | What it does | Design points worth copying |
|---|---|---|
| `council` | Three delegates, one flagship model per provider, high effort, read-only. Loops until all are satisfied. | Score out of 10 per delegate per round; "no score" is written, never invented. Results go in the PR description as a rounds table. Refuses to substitute a model it cannot reach. "Fight to keep scope limited." |
| `sol-loop` | GPT Sol reviews the diff in rounds. | Budget of 3 rounds (5 for security or data loss). A ledger of finding id, severity and outcome. Severity is `blocker`, `should` or `nit`. Stops on nits only. "Budget end is not approval." Reports diff size before and after. |
| `full-send` | Proof, sol-loop, file PR, babysit, merge. | Proof is evidence observed in the session. A merge gate: proof covers the diff, checks green, bots done, branch current. |
| `full-stop` | Same, but stops before merging. | Disables auto-merge first. |
| `babysit-pr` | Watches CI and review bots and fixes real findings. | One watcher per PR (`pr-wait`), no sleep loops. Declines scope-growing fixes with a written reason. |
| `file-pr` | Short PR that leads with the problem. | Ends with "Created with <model> in <harness>." |
| `takeover`, `modernize` | Finish or rebase someone else's PR. | `modernize` must pick MODERNIZE, REWORK or CLOSE before pushing. |
| `leaving-pr-comments` | Format for comments an agent posts. | A note naming the model that wrote it. |

The skills record the model, effort and round count in the PR. That is free provenance coding.sh
could read. The repeated warning about review loops growing the PR matches a reported case of a
council run growing a PR past 20,000 lines and another running four days (BigGo,
[1](https://finance.biggo.com/news/8152715d604b4e26)). Nothing measures that today (TB-10).

## 4. Benchmarks

| Bench | What it measures | How it runs | How it is reported |
|---|---|---|---|
| [SnitchBench](https://github.com/T3-Content/SnitchBench) ([video](https://www.youtube.com/watch?v=RzPSs6bLrms), [site](https://snitchbench.t3.gg)) | Whether a model contacts government or media when shown evidence of fraud. | Bun, AI SDK, OpenRouter. 4 tests: "act boldly" or not × email tools or a shell. 4 documents fed one per turn. A cheap model (gpt-4.1-mini) plays the shell. 20 runs per model, 80 in flight, 800 s timeout. README warns a run costs at least $40. | Gemini Flash reads each transcript and returns `contacted_government`, `contacted_media`, `first_contact_message`. JSON plus a v0 page. No intervals. |
| [skatebench](https://github.com/T3-Content/skatebench) | Naming skateboard tricks from a description. | 30 runs per model at temperature 1.0. Grading is substring match on answers, with `negative_answers` that fail a reply. Results are cached by a hash of system prompt, prompt and answers, so adding a model runs only its cells. | Accuracy and cost per model: "gpt-5 … 98.6% accuracy, $0.07 to run vs Grok 4: 79% accuracy, $4.86" ([X](https://x.com/theo/status/1953549077393944968)). The public repo has 7 cases; a v2 went private after labs seemed to train on the public set (BigGo, [4](https://finance.biggo.com/news/26e0bee7ca8915e7)). |
| [slotslop](https://github.com/t3dotgg/slotslop) | Not a bench. A slot machine that rolls harness, model and effort and runs the command. | Encodes the effort flag per harness: `claude --effort`, `codex -c model_reasoning_effort`. | — |
| [azure-bench](https://github.com/t3dotgg/azure-bench), [cf-vs-vercel-bench](https://github.com/t3dotgg/cf-vs-vercel-bench) | Provider latency and hosting performance. | Small scripts. | Videos and posts. |
| Terminal Bench, DeepSWE (third-party) | Coding agents. | He ran Terminal Bench himself with native harnesses: Sol at low effort tied Opus 5.5 at max, about $0.21 vs $14.65 and 4.8 vs 50 minutes per task (BigGo, [5](https://finance.biggo.com/news/6b689c5002fda008)). He backs DeepSWE: novel tasks, hand-written verifiers, a private holdout planned (BigGo, [4](https://finance.biggo.com/news/26e0bee7ca8915e7)). | Score next to cost and time per task. |

[ui-design-bench](https://github.com/t3dotgg/ui-design-bench) is a fork of someone else's gallery.
[Simon Willison](https://simonw.substack.com/p/how-often-do-llms-snitch-recreating) reproduced
SnitchBench with his `llm` CLI.

**What to learn.**

- Cost per run sits next to accuracy in every report. coding.sh `bench report` already does this.
- Reuse by content hash is what makes adding one model cheap. `exp run --reuse` already does this
  for matrix specs.
- SnitchBench caches a judge failure as "no contact" and counts it in the denominator, which biases
  rates down silently. coding.sh's judge throws `JudgeParseError` instead, which is the right call.
- Neither bench reports intervals or paired tests. coding.sh does; that is the gap to point at.
- A model-simulated shell or world lets a behavior eval run offline with no side effects (SnitchBench,
  T3 MCP eval). coding.sh has no simulator (TB-14).

## 5. Public takes

**Agent workflow.** Build environments where agents grow mergeable work, and fix root causes in docs
or code, not symptoms. T3 Code went from about 2 to over 400 merged PRs a day with three engineers
(BigGo, [1](https://finance.biggo.com/news/8152715d604b4e26)). Agents should prove their own work.
Prefer a hierarchy of fixes: architecture first, then lint or CI, then reflection, then skills, then
humans. CI should replay sample threads and fail a PR when wire size passes a baseline by 30%
(T3 Code ships `thread-transfer-report.yml` for this).

**Memory.** He turned agent memory off. On one machine, 19 of 355 sessions read a memory file and
80 wrote one; 26 of 45 files were never read; about a third were worth keeping (BigGo,
[6](https://finance.biggo.com/podcast/bb1b56f140ee671f)). This is a count coding.sh can produce
from captured tool calls (TB-1).

**Evals.** "Anything you can turn into a scored program, agents can optimize." Program-scored evals
beat model-judged ones. In the UI council loop, identical screenshots got different scores, framing
moved verdicts, telling reviewers the target score may inflate it, and competitor scores rose as
T3 improved. He plans to hide targets. The loop took about 17.6 agent-hours and about $400
(BigGo, [3](https://finance.biggo.com/podcast/8b11242133423fc5)). He calls standard coding
benchmarks contaminated and tells developers to keep a private benchmark from real failures
(BigGo, [4](https://finance.biggo.com/news/26e0bee7ca8915e7)).

**Token saving.** No primary source ties Theo to terse-output prompts or plugins. His levers
are effort level (Opus at max spends far more tokens for about a point, per BigGo
[7](https://finance.biggo.com/news/d88fb484e898ec12)) and context size (tool-description cuts).
Published measurements of terse-output prompts report single-digit cuts in output tokens on agent
tasks, and some terse-output projects now sell proxies and hosted evals, so they are competitors
as well as test subjects.

**Model comparison and cost.** The gap between Claude Code and Codex on the same model is "three to
five percent"; more than that is a model-layer bug (BigGo, [8](https://finance.biggo.com/news/a7f6180d1ab2dfb2)).
Subscriptions make heavy agent use viable; API prices do not. He estimates a large port at about
$38,000 at API rates against $500–800 of subscription use, and says council is not worth API prices
(BigGo, [9](https://finance.biggo.com/podcast/b50f615dc153d790)).

**Complaints about agent tooling.**

- No clear rules on what a Claude subscription allows ([X](https://x.com/theo/status/2045631571395530769),
  [X](https://x.com/theo/status/2085621311909642621)).
- The Claude Agent SDK is "atrocious" to wrap, and a change cut T3 users' limits
  ([X](https://x.com/theo/status/2054731856248283318)). He later confirmed an SDK bug that drains
  5-hour limits faster (BigGo, [8](https://finance.biggo.com/news/a7f6180d1ab2dfb2)).
- Requests billed or blocked by text in the system prompt; a Claude Code refusal of a non-coding
  debugging task (BigGo, [10](https://finance.biggo.com/podcast/00b9ba398b30a42e), April 2026).
- Worry that T3 Code users burn limits so fast they get banned ([X](https://x.com/theo/status/2099098186459861254)).
- The Codex system prompt; managing subagents across harnesses is hard to maintain (BigGo, [8](https://finance.biggo.com/news/a7f6180d1ab2dfb2)).

## 6. Already covered in coding.sh

| Theo practice | coding.sh today |
|---|---|
| Hill-climb MCP tool descriptions, then cut context under a score | `toolevals surface`, `toolevals compress` ([TOOL-EVALS.md](../TOOL-EVALS.md) cites him) |
| Personal benchmark from real failures, cost next to score | `bench` with a sessions source (`select = "failed"`), `bench report` |
| Reuse finished cells when adding a contender | `exp run --reuse` |
| Contamination through git history | `eval validate` flags commits reachable from refs but not HEAD |
| Judge drift and inflation | `judge calibrate` (Cohen's kappa on a held-out split); AB-13 (queued) |
| Compare harnesses on the same model | `compare` with harness bundles |
| T3 Code sessions | `t3code` adapter and host marker |

## 7. Ranked items for coding.sh

Scored like the main queue: value 1–10, effort S=1, M=2, L=3. Full specs are in the queue.

| Id | Item | Extends | Effort | Value | Score |
|---|---|---|---|---|---|
| TB-1 | Memory and rule-file audit: loads, reads, writes per file; never-read and write-only files | `harness audit` (new action) | S | 7 | 7.0 |
| TB-2 | `calls` check kind: must, must-not, max, order, partial args, over the captured trace | `toolevals` checks, exp graders | S | 6 | 6.0 |
| TB-3 | Tie-break sampling (a 3rd trial when 2 disagree) and `--stop-on-regression` against a baseline | `exp run`, `toolevals run` | S | 5 | 5.0 |
| TB-4 | How-to: does a terse mode (a terse-output plugin, "be concise") save money on your tasks? | `compare` (`exp replay` once the proxy lands) | S | 5 | 5.0 |
| TB-5 | `init --proxy` chains an existing base URL (CLIProxyAPI, a gateway) as the upstream | `init`, `proxy` | S | 5 | 5.0 |
| TB-6 | Reasoning effort as a first-class arm field, recorded per run | `compare`, `harness snapshot`, `bench` | M | 8 | 4.0 |
| TB-7 | Cross-harness child sessions: `codex exec`, `claude -p`, `gemini -p` launched from another agent's shell call | adapters, `show` | M | 8 | 4.0 |
| TB-8 | Service tier and speed per model call; premium cost split in `usage` | adapters, `usage` | S | 4 | 4.0 |
| TB-9 | CLIProxyAPI as a gateway source: drain its usage queue, join by session id | `gateway status`, `gateway enrich` | M | 7 | 3.5 |
| TB-10 | Review-loop analysis: rounds, scores, verdicts, diff growth; scope-creep and non-convergence flags | `show`, session flags | M | 7 | 3.5 |
| TB-11 | Judge panel with a hidden target and anchor re-scores | `judge grade`, exp graders | M | 6 | 3.0 |
| TB-12 | Case kinds `bad`, `guard`, `control` with per-kind results | `dataset`, `toolevals`, `exp compare` | M | 6 | 3.0 |
| TB-13 | Sessions joined to PRs: cost and sessions per PR | `usage --by pr`, `sessions` | M | 6 | 3.0 |
| TB-14 | Simulated shell for model-driver tool evals, part of the arm identity | `toolevals` model driver | M | 5 | 2.5 |

## 8. Not worth building

- Subscription limit pooling and quota resets. T3 Code, CodexBar and CLIProxyAPI panels own it, and
  it needs account credentials.
- A behavior bench like SnitchBench as a built-in. `bench` with a command source and command contenders already covers it.
- A UI gallery like ui-design-bench. Screenshots fit as experiment artifacts, not a product.
