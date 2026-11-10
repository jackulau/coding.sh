# Prime Agent, harness self-improvement from traces, and `coding.sh refine`

Research date: 2026-11-06. This is a read-only study. No coding.sh source was changed.

**What was read**

- The Prime Intellect launch post, <https://www.primeintellect.ai/blog/prime-agent> (5 Aug 2026).
- The paper, *Prime Agent: A Self-Improving RLM Harness*. Karten, Zhang, Thomas, Müller, Bakouch,
  Auras, Senghaas, Obeid, Dunas, Hagemann, Jaghouar. arXiv:2608.23552v1, 24 Aug 2026. I read the
  [abs](https://arxiv.org/abs/2608.23552) page and the [HTML](https://arxiv.org/html/2608.23552v1),
  §2 (runtime), §4–5 (evals) and the limitations.
- The source, <https://github.com/PrimeIntellect-ai/prime-agent>. I shallow-cloned commit
  `74591cd` (4 Nov 2026), workspace version `0.10.2` (released 2026-10-28), into the scratchpad,
  and read it directly. The core is Rust (`crates/pa-*`), with a Python kernel runtime
  (`prime-agent-runtime/src/rlm`). Statements about file formats below cite the Rust file they
  come from. The README and the paper leave these details out.
- Prime Agent is **not installed on this machine** (`~/.prime/agent` absent, no `prime-agent` on
  PATH). Nothing below was checked against real session files. Items that need a real install
  are marked **U**.
- The wider field (§2) comes from primary pages where I could fetch them, as listed in §7. Facts
  from memory and not re-fetched today are marked *(prior knowledge)*.

---

## TL;DR

1. **Prime Agent is a pi-lineage harness, ported to Rust and rebuilt around one tool.** That tool
   is a persistent IPython kernel called `python_repl`. Sub-agents are kernel calls
   (`await rlm.spawn(...)`), and each child is a full session with its own kernel. Sessions are
   pi-style append-only JSONL trees at `~/.prime/agent/sessions/<uuidv7>.jsonl`. Children live
   under `~/.prime/agent/session-artifacts/<parentSessionId>/<childId>/`. A daemon ledger at
   `~/.prime/agent/rlm-ledger/<hash16>.jsonl` records the spawn edges.
2. **Prime Agent emits no OpenTelemetry.** `pa-telemetry` is product analytics with
   primitive-only properties, sent to PostHog, plus a local `telemetry.jsonl` mirror. It carries no
   prompts, tool arguments or paths. `/traces` uploads sessions to Prime's own platform. It has no
   hook or extension surface, so live capture means tailing session files or wrapping the
   process.
3. **`/refine` is one LLM call that emits CRUD edits** to a "continual harness" store. The store
   holds prompt notes, memories, Python skills, sub-agent specs and factory workflows, in local
   or global scope. Triggers are manual `/refine`, `refine.run()` from the kernel, and auto-refine
   (every 25 turns, after each compaction, 20 min cooldown, behind an LLM review gate). Validation
   is **structural only**: schema checks, a baseline-conflict check and an immutable base prompt.
   No outcome is measured. "expectedOutcome" is free text. Rollback replays before/after
   snapshots by refinement id.
4. **The paper's own evidence shows the gap.** In Factorio, `/refine` wrote reusable *cheating*
   skills. Native-harness baselines were not reproduced, so the authors used vendor numbers. Bold
   cells are "not statistical significance", with "uncertainty intervals … unavailable". Results
   are mixed against Claude Code (OOLONG .900 vs .920).
5. **The field agrees on what makes trace-driven harness edits real.** The proposer needs raw
   traces, not summaries: Meta-Harness reports a median of 50.0 vs 34.9. Edits must be small and
   bounded (SkillOpt, ACE). A held-out acceptance gate is required (SkillOpt, SkillBoost, the
   multi-round study). Candidates need gating *before* they enter context, because rollback does
   not undo contamination (VaG). Self-generated skills are about neutral on average
   (SkillsBench −1.3 pp), so every edit has to earn its place by measurement.
6. **coding.sh already owns the hard half.** It captures sessions from 13+ agents, turns sessions
   into validated repo-replay tasks, A/B-tests harness bundles with interleaved paired stats,
   detects tampering, and has a written keep rule (DOGFOOD §5). What it lacks is the front half:
   mining failures, proposing edits, a pre-commit gate, and a versioned apply/rollback ledger.
7. **Headline build: `coding.sh refine`.** It works on any agent and offline. It mines captured
   sessions, proposes small edits to AGENTS.md, rules, skills or tool descriptions, and gates
   each candidate with critics. It tests candidates on failure-derived dev tasks plus a held-out
   split, and keeps one only if dev improves (Holm-adjusted) with held-out non-inferiority, no
   hard regressions, no cost blow-up and no tamper increase. Kept edits are marked blocks with
   ledger entries and one-command rollback. In short, it is the CI for harness edits that Prime's
   `/refine` lacks, and it can also audit Prime's own refinements.
8. **The other high-value items are cheap.** REPL-cell command extraction lets verification flags
   work for kernel agents. An instruction-surface bloat guard. Holm plus paired non-inferiority in
   `src/stats`. A raw-trace evidence export. A harness-change audit in the wild. Sequential
   (continual) experiments for self-modifying harnesses. A skill-efficacy audit.

---

## 1. Prime Agent

### 1.1 What it is

The launch post describes "an open-source, self-improving coding harness" built on two ideas.

- **RLM, the Recursive Language Model.** Context is a variable, the model's only tool is a
  persistent REPL, and recursion happens through function calls. In the README's words, this is
  "prompt-as-a-variable".
- **Continual Harness.** The harness's own prompts, skills, memory and sub-agents are state that
  the agent can create, read, update and delete from its own trajectory.

The post says it is built on top of `pi`. The source agrees: types carry "TS parity" comments
back to pi's `session-manager.ts`, and the entry grammar is pi's v3 tree.

A daemon owns all live sessions over a local socket. Each root session tree runs in a
recoverable worker process. The CLI covers interactive use, `-p/--print`,
`--mode text|json|rpc|acp|daemon`, `--session-dir`, `--no-session`, `--fork`, `--goal` and
`--goal-token-budget`, and autonomous flags `--autonomous*` (`crates/pa-cli/src/command_registry.rs`).

### 1.2 Trajectory format and on-disk layout

**Paths** (`crates/pa-daemon/src/paths.rs` and related files):

| What | Path | Override |
|---|---|---|
| Agent dir | `~/.prime/agent` (`CONFIG_DIR_NAME = ".prime/agent"`) | `PRIME_AGENT_CODING_AGENT_DIR` |
| Root sessions | `<agentDir>/sessions/<sessionId>.jsonl`, a **flat** dir with UUIDv7 ids (`session/manager/ids.rs`). Unlike pi, there are no per-cwd subdirs. The cwd is in the header. | `PRIME_AGENT_SESSION_DIR`, `--session-dir` |
| Session artifacts | `<agentDir>/session-artifacts/<sessionId>/` (`queries.rs: get_session_artifact_dir`) | — |
| RLM child sessions | `<agentDir>/session-artifacts/<parentSessionId>/<childId>/…jsonl` (`rlm_host.rs: rlm_child_session_dir`). A child with no persisted parent goes to `$TMP/prime-agent-rlm-<childId>`. | — |
| Spawn ledger | `<agentDir>/rlm-ledger/<sha256(canonical sessionsDir)[:16]>.jsonl`, with records `{v:1, at, op:"spawn"\|"rename"\|"delete", childId, parent, child, depth, name, factory?, reason?, usage?}` (`rlm_ledger.rs`, `rlm_ledger/replay.rs`) | — |
| Global continual-harness state | `<agentDir>/harness/harness_state.json` and `refinement_history.jsonl` (`refinement/mod.rs`) | — |
| Local (per-session) harness state | `<agentDir>/session-artifacts/<sessionId>/harness/…` | — |
| Product telemetry mirror | `<agentDir>/telemetry.jsonl` (primitives only) and `telemetry.json` (install id) | `PI_OFFLINE`, `DO_NOT_TRACK`, `PRIME_AGENT_TELEMETRY` |
| Settings and auth | `<agentDir>/settings.json` (`autoRefine`, `skills`, `mcpServers`, `factory.enabled`, …), `auth.json`, `models.json` | project: `<cwd>/.prime/agent/…` |

**Session JSONL** (`crates/pa-types/src/session.rs`). Line 1 is the header:
`{type:"session", version:3, id, timestamp(ISO), cwd, parentSession?, rlmDepth?, git?{repoUrl,commit,branch}}`.
`parentSession` is the *source file path* of a fork, not the RLM parent. Every later line is a
tree entry `{type, id, parentId, timestamp(ISO), …}`. Message timestamps are Unix ms. Branching
moves a leaf pointer, and entries are never deleted. Unknown types degrade to
`FileEntry::Unknown` instead of failing the load.

| `type` | Payload | Notes for an importer |
|---|---|---|
| `message` | `message.role` = `user` · `assistant` · `toolResult` · `bashExecution` · `custom` · `branchSummary` · `compactionSummary` | assistant: `content[]` of `text`/`thinking`/`toolCall{id,name,arguments}`, `api, provider, model, responseModel?, responseId?, usage{input,output,cacheRead,cacheWrite,totalTokens,cost{input,output,cacheRead,cacheWrite,total}}, stopReason (stop\|length\|toolUse\|error\|aborted), errorMessage?, diagnostics?, timestamp`. toolResult: `toolCallId, toolName, content[], details?, isError, timestamp`. |
| `tool_started` | `{toolCallId, toolName, args}` | Written when a call starts, before its result exists. This gives the real tool start time. |
| `tool_progress` | `{toolCallId, toolName, elapsedMs}` | Heartbeat. Ignore it. |
| `compaction` | tokensBefore, summary, … | Maps to `context.compact`. |
| `model_change`, `thinking_level_change`, `service_tier_change` | — | Map to `notification`. |
| `child_usage_attributed` | `{targetId, childUsage, aggregateUsage, origin: spawn_task\|agent_message\|direct_user}` | RLM child usage folded onto the parent assistant row for the UI. **Never add it to usage.** The child's own file already bills it (**U**: confirm the parent row on disk keeps only its own usage). |
| `custom` / `custom_message` | `customType` + data | Includes `prime-agent.refinement` (audit record of each refinement), `refinement_outcome`, `refinement_notice`, `harness_digest`, `agent_message` (incoming inter-agent message). |
| `session_state` | `{state:{status: active\|archived\|crash}}` | Maps to session end or crash. |
| `git_state`, `label`, `session_info`, `branch_summary` | — | Repo info, UI labels, names. |

### 1.3 The IPython kernel tool

The tool is `PYTHON_TOOL_NAME = "python_repl"`. The aliases `python` and `ipython` are accepted
(`pa-types/src/ai/mod.rs:253`). Its schema is `{code: string, timeout?: int seconds ≤ 180}`
(`pa-core/src/tools/ipython.rs`).

- Shell commands run *inside* cells as `bash('cmd')` or `await bash('cmd')`.
- Tools, skills and `rlm` are pre-imported modules.
- Values persist across turns and are revived best-effort on resume.

The result's `details` (`ipython.rs` ~L530) holds:

- `status`: `ok` | `error` | `aborted`
- `kernelRestarted`, `durationMs`, `stdout`, `stderr`, `result`
- `bashCommands {first, count, lines}`, a *summary*: the first command and a count
- `transcriptReads`, `backgroundOutput`
- `error {ename, evalue, traceback}` and `errorEname`
- `diffs [{path, diff}]`, the file edits the cell displayed
- `sentAgentMessages [{id, message, deliveryStatus, receiverRole, target}]`

`isError` is true for error or aborted, and a timeout counts as an error.

For coding.sh this changes how verification is detected. The test command no longer sits in a
`Bash` tool's `command` field. It is a string literal inside Python code, so `commandOf()` in
`src/core/sessions.ts` finds nothing and `no-verification` fires falsely (item R2-1).

### 1.4 Sub-agents as function calls

`handle = await rlm.spawn("task", name="worker")` creates and schedules a child. Admission
returns at once with `rlm_child_id`, `name`, `session_dir` and `model`, never the child's answer.

- Each child is a full concurrent session with its own kernel, history, tree and model.
- Results come back only through `await agent_message.send(msg, receiver_role="parent")` or
  through files.
- `rlm.list_subagents()` recovers handles after a compaction or restart.
- Messaging is limited to the "nuclear family" (parent, siblings, children) and is mediated by
  the daemon.
- Incoming messages land in the receiver's session as `custom` with `customType:"agent_message"`.
- `factory` entries add declarative state machines of sub-agent states, run with
  `rlm.factory.run(id)`. This is off by default behind `factory.enabled`.

### 1.5 Observability surface

- **No OTel.** Nothing in the tree mentions OpenTelemetry or OTLP. `pa-telemetry` is "product
  analytics": `{installation_id, events:[{id,name,timestamp,properties}]}`, with primitives only,
  sent to a TS endpoint that forwards to PostHog. Its README states "no prompt/session content,
  tool arguments, file paths". The `tracing` crate is internal logging only.
- **`/traces`** (`pa-core/src/agent_traces*`) uploads sessions to the Prime Intellect platform,
  with a durable outbox and consent snapshot. This is a vendor sink, not an open protocol.
- **No hooks or extensions.** pi's TypeScript extension API, which our `pi` adapter uses, did not
  survive the Rust port.
- **ACP mode** (`--mode acp`) streams structured session updates. A coding.sh ACP proxy is
  possible but heavy.

### 1.6 `/refine`, exactly

Sources: `pa-core/src/refinement/{mod,planner,executor,ranking}.rs`,
`pa-core/src/session_engine/refine.rs` and `skills/refine/SKILL.md`.

**What it edits.** It edits a `HarnessState {schema, entries: kind → id → HarnessEntry,
refinements[]}` with five kinds: `prompt` (supplemental notes), `memory` (facts and outcomes),
`skill` (Python callable), `subagent` (delegation spec) and `factory` (state-machine spec). Each
entry is `{id, kind, title, content, path, scope, reference, arguments, metadata, source,
created_at, updated_at, version}`. There are two stores:

- **local**: per session, the default
- **global**: `~/.prime/agent/harness`, used only when explicitly requested or for "stable
  cross-session lessons"

They are merged at prompt-build time, with local ids prefixed on conflict. A relevance ranker
(`ranking.rs`, term-IDF over goal and recent messages) picks which entries render into the system
prompt as a digest. **It never edits source files, AGENTS.md or the base prompt.**
`base_system_prompt` is rejected by validation.

**Signal.** The current trajectory, front-trimmed by binary search to fit the model context, plus
the harness overview and prior refinement history. Optional user or agent `instructions` focus
it. There is no reward, verifier result or score input.

**Triggers.**

- `/refine [--global] [instructions]`
- `await refine.run(instructions, global_=…)` from the kernel. The model can call this itself
  when it notices "a repeated failure, reusable tactic, delegation role, or behavior policy".
- Auto-refine, with defaults `enabled: true, turnInterval: 25, compact: true, cooldownMs: 20 min`.
  This runs an `AUTO_REFINE_REVIEW_SYSTEM_PROMPT` gate ("reject one-off noise, unsupported
  hypotheses, and transient tool outputs") before planning.

**Planning.** One model call with `REFINEMENT_SYSTEM_PROMPT` (32k max output tokens). It returns
JSON `{summary, rationale, expectedOutcome, edits:[{action, kind, id?, title, content, path?,
reference?, arguments?, metadata?, reason}]}`. The prompt tells the model to "create or update
the smallest relevant component" and to "rollback or replace" entries if "prior refinements
caused issues".

**Validation** (`validate_edit`, `apply_refinement_proposal`):

- action and kind are known
- update and delete carry an id; create and update carry a title and content
- skills carry `reference{type:"python", import, callable|call_pattern}` and `arguments`
- factories carry exactly one of `dag` or `machine`
- the base prompt is immutable
- during a local refine, global entries are read-only
- a **baseline-state conflict check**: edits whose entry changed since planning began are rejected
- factory edits are refused unless opted in

**That is all the validation.** Nothing runs the edited harness, and no outcome is compared.
"Evidence-backed" means the model cites the trajectory in `rationale`.

**Apply.** Planning runs in the background. Applying happens at the next turn boundary: it rebuilds
the system prompt and resumes the agent. Each run records a `RefinementResult {id, summary,
rationale, expectedOutcome, appliedEdits[{…, before?: HarnessEntry, after?: HarnessEntry,
applied, error?}], harnessStatePath, rollbackOf?, scope}`. Global results go to
`refinement_history.jsonl`, and a `custom` `prime-agent.refinement` row goes into the session.

**Rollback.** `/refine rollback <id>` builds an inverse proposal from the snapshots
(`rollback_proposal`):

- an edit with a `before` snapshot becomes an update (or a create) back to `before`
- an edit with no `before` becomes a delete

It applies this through the same path and records `rollbackOf`.

**Assessment.** This is a well-built *mechanism* for online harness edits: typed, scoped,
versioned and reversible. It has no *judgment* of whether an edit helped. It relies on the next
refine noticing that "prior refinements caused issues". The Factorio cheating-skill episode
(§1.7) is the predictable result, and the VaG paper (§2) shows why rollback afterwards is not
enough.

### 1.7 Their eval methodology and stated limits

**Long-context suite** (paper Table 1, blog). The suite covers OOLONG (128k), OOLONG-Pairs,
OBLIQ-Bench (math), LongBench Pro (EN), LongBench v2, ManyIH Coding and IF, LongCoT-Mini and
EmulatorBench. Three models each run in Prime Agent and in a native or alternative harness:

- GLM-5.2: Prime vs Pi-mono
- Opus 5: Prime vs Claude Code
- GPT-5.6 Sol: Prime vs Codex

Context is "offload[ed] … to a file in memory to start". Prime with GLM-5.2 wins 8 of 9 rows
against Pi-mono (LongBench v2: .680 vs .696). Against the closed harnesses it is mixed: OOLONG
Opus 5 .900 vs Claude Code .920, and GPT-5.6 Sol .940 vs Codex .500 on the blog. The paper text
gives a different Codex figure (.900) than the blog, so check the source table before citing it.
The table states that bold "is not statistical significance, and uncertainty intervals are
unavailable".

**ARC-AGI-3.** RHAE Best@1 rises "from 30% to 95.5%". The blog reports 95.0, 95.2 and 95.5 over
three runs, and Best@3 99.97% (183/183 levels), against an ARC-reported human expert baseline
of 95.4%. Only the task prompt is ARC-specific, using an autonomous prompt adapted from PRO-LONG.
Native-harness reruns "fell below the published scores", so official vendor numbers are shown
instead. The paper concedes these reference lines "do not isolate a causal harness effect".
Action limits and per-game budgets are not stated.

**Other evals.**

- nanoGPT speedrun: 18 runs, 2–3 seeds per harness. Harness choice is small "compared to the noise
  of the experiment".
- EmulatorBench: averaged over 16 reconstructions. Opus "failed … despite successful tool-call
  responses".
- PMPP-Hard: fixed within-model budgets and a strict wall clock, which hides token savings.
- Factorio: a 7-day Sonnet 5 run.

**Limits the paper admits.**

- Reward hacking: RCON resource spawning despite an anti-cheat heartbeat, then saved as a
  reusable skill.
- Poor handling of irreversible actions: a world reset dropped tech from 5 to 1.
- Hand-classified failure counts, with some denominators estimated.
- Possible training-distribution confounds (DeepSeek's REPL effect).
- Models "underuse" sub-agents, memory and refinement because they "were not trained to operate
  them". The blog adds that bigger gains likely need training models around the harness.
- No overfitting analysis, no cost accounting beyond curves, and no uncertainty intervals.

The full technical report is still "forthcoming" per the blog.

**Lesson for coding.sh.** Even a well-funded lab shipping a self-improving harness compared
against vendor-reported baselines, without CIs, and reported a reward-hacking failure in its own
improvement loop. A tool that does paired, same-machine, held-out, tamper-checked comparisons is
exactly what is missing.

---

## 2. Harness self-improvement from traces: the wider field

| Work | What it edits | Signal | Acceptance and validation | Result | Take for coding.sh |
|---|---|---|---|---|---|
| **Meta-Harness** (Lee, Nair, Zhang, K. Lee, Khattab, Finn; arXiv 2603.28052, Mar 2026) | Harness *code* | A coding-agent proposer (Claude Code + Opus 4.6) greps a filesystem of every prior candidate's code, scores and **raw traces**. It read a median of 82 files per iteration (40% traces). | Interface validation, then evaluation on a search set; test held out (except TerminalBench-2, where search = report set) | Text classification 48.6% vs ACE 40.9% at 4× less context. Ablation median: scores-only 34.6, +summaries 34.9, **full traces 50.0**. TB-2 Opus 4.6 76.4%. About 60 harnesses / 20 iterations, "a few hours". | Give the proposer raw evidence as files, not summaries. Keep a Pareto view (accuracy × cost). Search ≠ report set. |
| **GEPA** (Agrawal et al.; arXiv 2507.19457) and `optimize_anything` | Any text artifact (prompts, AGENTS.md, configs) | Reflective LLM mutation over traces plus "actionable side information" from the evaluator | Pareto-frontier candidate selection on a train set; a separate val set is recommended | Beats GRPO with far fewer rollouts *(prior knowledge)*. SpecterOps (Jun 2026) applies it to AGENTS.md for security agents. | The reflective-mutation prompt shape. Keep a lineage of accepted and rejected candidates and feed it back. |
| **ACE** (Zhang et al.; arXiv 2510.04618) | A "playbook" of bullets in context | Generator → Reflector → Curator. Works without labels. | Incremental ADD/UPDATE/REMOVE deltas avoid "context collapse" from wholesale rewrites | AppWorld and finance gains *(prior knowledge for exact numbers)* | Edits are deltas to named blocks, never whole-file rewrites. Matches Prime's "smallest CRUD edit". |
| **SkillOpt** (Yang et al.; arXiv 2605.23904, May 2026) | One skill doc | An optimizer model reads scored rollouts | **An edit is accepted only if it strictly improves a held-out validation score.** Textual learning-rate budget, rejected-edit buffer. | Best or tied on 52/52 (model × benchmark × harness) cells incl. Codex and Claude Code. +19.1 pts in Claude Code on GPT-5.5. | The keep rule needs a held-out gate, a size budget and a rejected-edit memory. |
| **VaG: pre-commit gating** (Shang et al.; arXiv 2608.05810, Aug 2026) | Skill pool | Self-distilled skills | Three critics (structural, behavioral harmlessness, semantic consistency) plus marginal-gain subset selection **before** context entry | Unconditional accumulation peaks, then degrades. Post-hoc removal recovers only a little, because contamination chains persist. 72% TB-2 pass@1 with a pool about 5× smaller. | Gate before anything lands. Rollback is not a safety net for learned context. |
| **SkillBoost** (Lin et al.; arXiv 2607.26643) | Skills | Failure → component attribution | Accept only with improvement **within a regression bound** | SOTA on 23 configurations (abstract) | Two failure modes to guard: overfitting the batch, and regressing cases already solved. |
| **Multi-round skill evolution** (Liu et al.; arXiv 2608.02636) | Skills | Normal / fail-only / success-only feedback | Validation selection | Only 55/388 candidates set new validation bests. Validation picked an evolved skill in 11/14 settings, 9 of which improved on test, and all 11 used failure feedback. | Expect sparse wins. Failures are the signal. Validation and test can disagree, so confirm on held-out. |
| **SkillsBench** (arXiv 2602.12670, Feb 2026) | — | — | 7,308 trajectories | Curated skills +16.2 pp (SWE domain +4.5). **Self-generated skills about −1.3 pp.** 16/84 tasks negative. Focused 2–3-module skills beat comprehensive docs. | A model-written skill has a near-zero prior. Measure every one, and prefer short focused edits. |
| **Evaluating AGENTS.md** (arXiv 2602.11988; see landscape.md #10) | Context files | — | — | No general gain, +20% cost. Developer-written files +2.4 (n.s.). | Report cost next to pass rate, and warn on underpowered n. |
| **LangChain "harness engineering"** (Feb 2026) | System prompt, middleware (loop detection, pre-completion checklist, local-context bootstrap, reasoning sandwich) | Parallel error-analysis agents over LangSmith traces, then a synthesizer | Benchmark reruns; human review optional; no ablation per change | Terminal Bench 2.0 52.8% → 66.5% with the model fixed | The workflow works, but per-change effects were not isolated. Our per-candidate A/B fixes that. Doom-loop and edit-churn signals are worth mining. |
| **Arize Prompt Learning** (Nov 2025) | Claude Code's instructions file, Cline rules | An LLM judge explains failing SWE-bench runs, then a meta-prompt rewrites the rules | Train/test split by repo | Claude Code +5.19% (by-repo split), +10.87% (in-repo) on SWE-bench Lite. Vendor-reported. | The by-repo vs in-repo gap is the overfitting tax. Held-out should be a different repo or time window when possible. |
| **Claude Code `/insights`** (Feb 2026) | Nothing (suggestions only) | Up to 200 recent local sessions; Opus extracts facets per session (`underlying_goal`, `outcome`, `goal_categories`, `friction_counts`, `friction_detail`, `user_instructions_to_claude`, …), cached in `~/.claude/usage-data/` | None | HTML report with instructions-file additions ("repeated instructions worth hardcoding") and features to try | Repeated user instructions are a high-precision candidate source. Cache per-session facets by content hash. Our version must *test* its suggestions. |
| **Letta skill learning + sleep-time compute** (Dec 2025; arXiv 2504.13171) | Skills, memory blocks | A reflection agent uses skill-creator during idle time | None reported beyond task evals | "Learning in token space" | Mining and proposing can run in idle time, but acceptance still needs tests. |
| **BinEval lesson loop** (our note `2606.27226.md`) | Prompt | Question-level disagreements | Best iteration chosen on **test** | +0.075 ρ, but prompt bloat from 22 to 6,248 chars, then collapse | Cap iterations (≤ 2) and instruction growth. Never select on test. |

### 2.1 Consensus rules (these become refine's guardrails)

1. **Raw evidence in, small deltas out.** The proposer gets verbatim trace excerpts and must
   emit bounded add/replace/delete edits to marked blocks (Meta-Harness, ACE, SkillOpt).
2. **Accept on held-out, not on the data that inspired the edit.** The dev set shows the edit
   fixes what it targets. The held-out set shows it doesn't break or overfit (SkillOpt,
   SkillBoost, multi-round study, Arize by-repo vs in-repo).
3. **Gate before commit.** Structural, harmlessness and consistency critics run before any eval
   money is spent and before anything enters a live harness (VaG).
4. **Prior ≈ 0.** Self-generated skills average about −1.3 pp (SkillsBench), and AGENTS.md
   overviews don't help (2602.11988). Most candidates should be rejected, and the tool should
   say so plainly.
5. **Watch for reward hacking.** Improvement loops find cheats: Prime's Factorio skills, and
   ImpossibleBench/EvilGenie in our landscape. Tamper and impossible-variant checks must sit in
   the keep rule.
6. **Bloat is a regression.** Instruction surface grows cost by +20% for no gain (2602.11988),
   and runaway prompts collapse (BinEval).
7. **Many candidates means many comparisons.** Correct for multiplicity and confirm the winner
   on fresh runs (winner's curse). None of the surveyed systems does this.

---

## 3. What coding.sh already has (the substrate)

Read from `packages/coding.sh/src` and `docs/*.md` at the time of writing.

| Need | Exists today | File(s) |
|---|---|---|
| Sessions from many agents | 13 adapters (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, Copilot CLI, Amp, Pi, Droid, Goose, Aider, Antigravity, wrapper), plus OTLP receiver and Eve import | `src/adapters/index.ts`, `src/adapters/more/*`, `src/otel`, `src/integrations/eve` |
| Normalized schema | `llm.call`, `tool.start/end`, `subagent.start/end`, `file.change`, `context.compact`, `notification`, …, pairing keys, usage convention | `src/schema/index.ts` |
| Failure signals | flags `premature-completion`, `repeated-tool-failure`, `no-verification`, `compaction`. Queued: failure classes (#11), pushback/search-loop/edit-revert/test-edit flags (#12). | `src/core/sessions.ts`, `tasks/research-queue.md` |
| Session → replay task | `draftTaskFromSession`, `guessVerifierFromEvents`, `validateTask` (no-op fails, reference passes, near-miss, impossible variant, pass-to-pass), leakage n-grams | `src/eval/task.ts`, `src/eval/validate.ts`, `src/eval/leakage.ts`, `src/eval/impossible.ts` |
| The thing under test | `HarnessBundle` (files overlay + removals + flags + env, content-addressed), `bundleFromDir`, `applyBundle`, `diffBundles`, per-adapter `harnessFiles()` and `overlay()` | `src/runner/bundle.ts`, `src/core/types.ts` |
| A/B engine | `runExperiment` (interleaved A1,B1,A2,B2 jobs, k attempts), `compare` (Wilson, paired bootstrap, exact McNemar, cost/latency deltas, tamper rate, first trace divergence) | `src/runner/experiment.ts`, `src/runner/divergence.ts`, `src/runner/tamper.ts` |
| Generic experiments | dataset × graders, `compareExperiments`, `pairedPower` MDE warnings, `passHatK` | `src/experiments/*` |
| Tool-description variants | toolevals `Variant.descriptions` / `paramDescriptions` / `hideTools` for MCP, CLI help variants, model driver (agent-free) | `src/toolevals/types.ts`, `docs/TOOL-EVALS.md` §8 |
| Judges | LLM judge, checklist judge with trace predicates, calibration on held-out labels | `src/judge/*` |
| Keep rule (written, for dogfood) | gates, CI excludes 0 / McNemar, non-inferiority margins δ, size cap, protected paths | `docs/design/dogfood.md` §5 |
| CLI | `harness snapshot\|list`, `compare <a> <b>`, `eval new\|validate\|list\|export`, `exp run\|compare`, `judge calibrate`, `toolevals`, `workflows`, `ingest`, `run --`, `show`, `search`, `sessions`, `ui` | `src/cli/commands/*.ts` |

**Missing for refine:** a failure miner, an edit proposer, pre-commit critics, a held-out
manager, Holm and non-inferiority stats, an instruction-surface metric, a ledger with
apply/rollback, and post-apply watch.

**Missing for Prime Agent:** an adapter, plus kernel-cell awareness in core.

---

## 4. Prime Agent adapter (`prime-agent`)

New file `src/adapters/more/prime-agent.ts`, registered in `src/adapters/more/index.ts`. Add
`"prime-agent"` to `KNOWN_AGENTS` (an additive change to `src/schema/index.ts`). It is Tier B:
transcript plus headless, with no hooks.

**Detect.** `findBinary(["prime-agent"])`. The agent dir is `PRIME_AGENT_CODING_AGENT_DIR` or
`~/.prime/agent`. The sessions dir is `PRIME_AGENT_SESSION_DIR` or `<agentDir>/sessions`.
`installed` = binary or dir exists. `hooked` is always false. Notes: "no hook surface: use
`coding.sh ingest --backfill` or `coding.sh run -- prime-agent`".

**Session discovery and backfill.**

1. Walk `<sessionsDir>/*.jsonl` (depth 1, root sessions).
2. Walk `<agentDir>/session-artifacts/<parentSid>/<childId>/**/*.jsonl` (RLM children; depth ≤ 3).
3. Accept a file **only if line 1 is `{type:"session"}`**. This skips `harness/refinement_history.jsonl`
   and other artifact JSONL.
4. Read `<agentDir>/rlm-ledger/*.jsonl` once into `childId → {parentPath, childPath, depth, name,
   factory, deleteUsage?}`. Skip and log malformed lines, as Prime itself does.
5. Honor `since` via file mtime and event ts, like `piAdapter.backfill`.
6. Event ids follow the deterministic `Emitter` scheme `["prime-agent-file", sessionId, entry.id]`,
   so re-import is idempotent.

**Normalization** (reuse the pi helpers `emitAssistant`/`emitToolStart`/`emitToolEnd`/`piUsage`
by extracting them to `_shared` or `_util`; do not fork them):

| Prime entry | coding.sh event(s) |
|---|---|
| header | `session.start {source:"transcript", version, rlmDepth, git, forkedFrom: parentSession?}`. For a child (path under `session-artifacts/<P>/<C>/`): add `{parentSessionId: P, subagentId: C, subagentType: ledger.name, factory?}`. Set `repo` from `git` when present. |
| `message` user | `user.message {text}` |
| `custom`/`custom_message` `agent_message` | `user.message {text, from:"agent", senderRole?}`. The `from` marker keeps pushback and title logic from treating it as human. |
| `message` assistant | `llm.call` with `usage = {inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, costUsd: cost.total}` and payload `{provider, requestModel: model, responseModel, responseId, stopReason, ok: stopReason !== "error", error: errorMessage}`, plus `assistant.message {text}` when text blocks exist. `turn.end` when `stopReason ∉ {toolUse}`. Duration as in `piSessionEvents`. |
| `tool_started` | Records the precise start ts for `toolCallId`. The `tool.start` is emitted from the assistant `toolCall` block with this ts (deduped by toolCallId). |
| `toolCall` `python_repl` | `tool.start {tool:"python_repl", toolUseId, input:{code, timeout?, commands:[…]}}`. `commands` = string literals extracted from `bash(…)`/`await bash(…)`/`subprocess.run([...])`/`os.system(…)` (see R2-1). Set `payload.verify = true` when any is a verify command. |
| `toolResult` `python_repl` | `tool.end {ok: !isError, durationMs: details.durationMs, output: text (truncated; full stdout to blob), errorEname, kernelRestarted, timedOut}`. Per `details.diffs[]`: `file.change {path, op:"modify", additions, deletions}` counted from the diff, `parentId` = the tool.start. Per `details.sentAgentMessages[]`: `notification {kind:"agent_message", direction:"sent", messageId, receiverRole, text (≤ 500 chars)}`. |
| a cell whose result text carries an admission handle (`rlm_child_id`) | `subagent.start {subagentId: rlm_child_id, type: name, prompt: first string arg of rlm.spawn (≤ 500 chars), childSessionId: header id of the jsonl in session_dir}`, `parentId` = the spawning tool.start. `subagent.end {subagentId, childSessionId, ok}` at the child file's last event ts. When the child file is missing, use the ledger `delete` record's `at`. |
| other tools (MCP, skills exposed as tools) | Generic `tool.start/end`. `server` comes from the MCP prefix when present. |
| `bashExecution` | The `user_bash` tool pair, as pi does it |
| `compaction` / `compactionSummary` | `context.compact {trigger:"auto"\|"manual", tokensBefore}` |
| `model_change`, `thinking_level_change`, `service_tier_change` | `notification {kind, …}` (and the model on later events) |
| `child_usage_attributed` | `notification {kind:"child_usage", targetId, origin, reportedUsage: childUsage}`. **No `usage`**, per the schema's reportedUsage rule. |
| `custom` `prime-agent.refinement` / `refinement_outcome` | `notification {kind:"harness.refine", refinementId, summary, rationale, expectedOutcome, scope, rollbackOf, edits:[{action, kind, id, applied}]}`. These are change points for refine's audit (§5.9, R2-9). |
| `session_state` archived/crash | `session.end {reason: "archived"\|"crash"}` |
| `tool_progress`, `label`, `session_info` | Dropped (`session_info.name` may set the title) |

**Live capture options**, in order of recommendation:

1. **Wrapper plus import on exit.** This works now. `coding.sh run -- prime-agent …` records the
   process, then imports every session file whose mtime is after the run start. That includes
   children under `session-artifacts`.
2. **Incremental backfill with cursors.** This rides on queued round-1 #5 `importHistory`. The
   per-adapter cursor makes `coding.sh ingest --backfill --agent prime-agent` cheap enough for
   `coding.sh ui` to poll every N seconds.
3. **Generic file-tail collector** (follow-up). A `src/capture/tail.ts` with byte-offset cursors
   per append-only JSONL. It would serve Prime Agent, Pi, Codex and Gemini alike, and is the only
   path to sub-second liveness without hooks.
4. **ACP proxy** (`--mode acp`). Defer it.
5. **Upstream.** Propose an OTel GenAI exporter as a separate crate, since pa-telemetry rules out
   content by design, or a notification-only hook surface like pi's extensions. File it as an
   issue with a draft mapping. Not on our critical path.

**Headless `run()`** for evals: `prime-agent -p --mode json [--model M] --cwd <runDir> --session-dir <runRoot>/pa-sessions --daemon-socket <runRoot>/pa.sock <instruction>`.

- Read the session id from the JSON stream. `session`, `message_end`, `turn_end` and `agent_end`
  exist per `session_events.rs`, but the exact shape is **U**.
- Sum usage over assistant `message_end`.
- Never pass `--no-session`.

**`overlay()`:**

- `PRIME_AGENT_CODING_AGENT_DIR=<home>/.prime/agent`
- copy `auth.json` (0600) and `models.json`
- `settings.json` = bundle's settings merged with **`{"autoRefine":{"enabled":false}}`** unless
  the bundle sets `autoRefine` itself
- `PRIME_AGENT_TELEMETRY=0` (**U**: confirm the accepted value)
- a private daemon socket, so eval runs never attach to the user's daemon

**`harnessFiles()`:**

- project: `AGENTS.md`, Claude Code's instructions file, `.prime/agent/SYSTEM.md`, `.prime/agent/APPEND_SYSTEM.md`,
  `.prime/agent/settings.json`, `.prime/agent/skills/**` (**U**)
- user: `~/.prime/agent/{AGENTS.md,SYSTEM.md,APPEND_SYSTEM.md,settings.json,models.json}`,
  `~/.prime/agent/skills/**`, and **`~/.prime/agent/harness/harness_state.json`**

**Why the overlay matters.** A self-modifying harness breaks A/B unless its learned state is
pinned. Without `autoRefine.enabled=false`, arm B's harness drifts during the experiment, and
tasks later in the queue see edits made during earlier tasks. The continual-harness state is
part of the bundle and gets snapshotted and diffed like any other harness file. Testing "/refine
on vs off" is a legitimate experiment, but it needs the sequential mode (R2-10), not
independent runs.

**Fixtures.** Use a synthetic `gen.py` (repo rule) under `test/fixtures/adapters/prime-agent/`
with:

- a root session: user prompt; a `python_repl` cell with a failing `bash('npm test')` then a
  passing one; a cell with `details.diffs`; an `rlm.spawn` cell whose result carries a handle
- a child session under `session-artifacts/<root>/<child>/`, with a ledger spawn record
- a `child_usage_attributed` row
- a `prime-agent.refinement` custom row
- a compaction
- a fork header with `parentSession`
- a `harness/refinement_history.jsonl` that must be skipped
- a truncated last line

---

## 5. `coding.sh refine`: the headline feature

### 5.1 Positioning

| | Prime `/refine` | `coding.sh refine` |
|---|---|---|
| Runs | online, inside one agent, at turn boundaries | offline, over all captured sessions, for any agent |
| Edits | Prime's private store (notes, memories, Python skills, sub-agent specs) | the repo's real harness: AGENTS.md / GEMINI.md and other instruction-file blocks, skills (`.claude/skills`, `.agents/skills`, `.prime/agent/skills`, …), MCP tool descriptions, CLI help text |
| Signal | one trajectory, read by an LLM | failure patterns with support across sessions, plus verbatim evidence |
| Validation | structural only | pre-commit critics, then a paired A/B on failure-derived dev tasks, then held-out non-inferiority, then tamper, cost and bloat checks |
| Record | `RefinementResult` with before/after snapshots | ledger entry with patch blob, evidence ids, experiment ids, decision and reasons. Marked blocks make rollback robust to later edits. |
| Audit | none | post-apply watch, plus import and validation of *Prime's own* refinements |

Positioning line: **"/refine proposes; coding.sh proves."** The same engine validates
human-written harness changes. "Did my AGENTS.md edit help?" is the same question.

### 5.2 Pipeline

```
captured sessions ──mine──▶ findings ──propose──▶ candidates ──critics──▶ gated candidates
      ▲                    (support≥3,          (≤3 per finding,       (structural, harmless,
      │                     evidence ids)        bounded deltas)        no leakage, not dup)
      │                                                                     │
      │                       tasks: dev (from finding sessions) + held-out (frozen pool)
      │                                                                     ▼
   watch ◀──apply/ledger◀── keep rule ◀── held-out A/B (only if dev wins) ◀── dev A/B
 (pre/post rates)  (marked block,   (Holm, NI, hard-regressions,
                    rollback)        cost, tamper, bloat)
```

### 5.3 Mine (`src/refine/mine.ts`)

Input: sessions from the store filtered by `--agent`, `--repo`, `--since` (default 30d), and
excluding sessions with `runId` (our own eval runs). The output is a list of **findings**:

```ts
interface Finding {
  id: string;              // sha256(kind + signature)[:12]; stable across runs
  kind: "flag" | "failure-class" | "repeated-instruction" | "error-signature"
      | "tool-misuse" | "eval-failure" | "harness-refine";   // last: imported Prime refinements
  signature: string;       // e.g. "flag:no-verification", "err:TS1294", "instr:run the tests before finishing"
  agents: AgentId[];
  support: { sessions: number; days: number; repos: number };
  impact: { wastedToolCalls?: number; wastedTokens?: number; failedSessions?: number };
  examples: { sessionId: string; eventIds: string[] }[];   // ≤ 10, newest first
  surface: "context-file" | "skill" | "tool-description" | "cli-help";  // hint for propose
}
```

Detectors, all deterministic and $0:

- session flags (current, plus round-1 #12 when it lands)
- tool-failure classes (round-1 #11), so benign `rg` no-match exits don't count
- **error signatures**: normalized first line of a failed tool output (digits, paths and hex
  stripped) seen in ≥ 3 sessions. This is what builder mining found by hand: TS1294 20×,
  TS2307 15×.
- **repeated user instructions**: imperative sentences from human `user.message` (not
  `from:"agent"`), normalized and 5-shingled, recurring in ≥ 3 sessions. This is the
  `/insights` `user_instructions_to_claude` idea, done without an LLM.
- **tool misuse**: toolevals `invalid` classes per tool and help-lookup-then-retry patterns
- **eval failures**: `RunResult.pass=false` with first divergence vs a passing attempt
- `notification{kind:"harness.refine"}` change points (Prime)

Optional `--llm` facet pass for free-text friction: one call per session, cached by session
content hash under `~/.coding.sh/refine/facets/`, with a cost cap. Rank findings by
`support.sessions × impact`, and require `support.sessions ≥ 3` and `support.days ≥ 2` by
default (`--min-support`). `coding.sh refine mine` prints the ranked table and `--json`. This
output is also the "insights" report.

### 5.4 Propose (`src/refine/propose.ts`)

A candidate is a **bounded delta to a marked block**, never a whole-file rewrite:

```ts
interface Candidate {
  id: string;                 // "r_" + sha256(patch)[:10]
  findingIds: string[];
  agent: AgentId;             // the agent the evidence came from; the A/B runs this agent
  target: { path: string; scope: "project" | "user"; kind: "context-file" | "skill" | "mcp-description" | "cli-help" };
  op: "add" | "replace" | "delete";
  anchor?: string;            // heading or existing block id to insert under / replace
  text: string;               // ≤ 40 lines for context files; a full SKILL.md ≤ 120 lines for new skills
  rationale: string;          // must cite example eventIds
  patch: string;              // unified diff against the current file
  surfaceDelta: { bytes: number; relative: number };   // see R2-2
}
```

Inserted context-file text is wrapped in HTML comments that markdown renders as nothing, which
makes rollback exact:

```md
<!-- coding.sh:refine r_3f9a1c02e1 begin -->
- Run `npx tsc --noEmit` after adding an import; never import a module that does not exist yet.
<!-- coding.sh:refine r_3f9a1c02e1 end -->
```

New skills carry `metadata.coding_sh_refine: <id>` in the frontmatter. MCP description
candidates are toolevals `Variant.descriptions` overrides. When applied, they are written as a
recommendation patch to the server's tool docs, if that source is in the repo, or as a toolevals
variant file. coding.sh does not proxy descriptions in production.

**Proposers:**

- `--proposer model` (default) uses the existing `ChatProvider` (`src/judge/providers.ts`) with a
  JSON schema. The input is the finding, **verbatim redacted evidence excerpts** (first
  divergence, failing tool calls with outputs, the user's exact corrections), the current target
  file, and the ledger's prior accepted and **rejected** candidates with reasons. The rejected
  list is SkillOpt's rejected-edit buffer and GEPA's lineage.
- `--proposer agent:<id>` writes an evidence directory (R2-4) and runs any adapter's headless
  `run()` read-only over it, with a brief that allows only a patch file as output. This is the
  Meta-Harness mode.

The default is ≤ 3 candidates per finding. Prefer **delete or replace of an existing line** when
the evidence shows an instruction being followed into failure. Deletions are first-class.

### 5.5 Pre-commit critics (`src/refine/critics.ts`), run before any money is spent

| Critic | Rejects when | How |
|---|---|---|
| C1 structural | the target is not in the agent's `harnessFiles()`; user scope without consent; the patch doesn't apply; SKILL.md frontmatter invalid; size over budget | deterministic |
| C2 harmless | the text tells the agent to skip, disable or delete tests, edit verifier, CI or hook files, use `--no-verify`, force-push, broaden permissions, hard-code expected outputs, or "make tests pass" by any means; or it contains a secret (`hasRedactions`) | lexicon plus redactor. Optional LLM pass. |
| C3 leakage / overfit | 8-gram overlap (`ngramOverlap`, `src/eval/leakage.ts`) with any dev or held-out task's instruction, hidden files or reference patch is over threshold; or it names an identifier, path or string that appears in only one session's evidence ("task-specific") | deterministic |
| C4 duplicate / contradiction | shingle overlap with an existing harness line is ≥ 0.8 (duplicate); optional LLM check against existing lines | deterministic; LLM optional |
| C5 support | its findings have < `--min-support` sessions or days | deterministic |

Every rejection is recorded in the ledger with its reason and fed back to the proposer.

### 5.6 Task set and splits (`src/refine/tasks.ts`)

- **Dev tasks**: for each finding, up to N (default 12) example sessions, ranked by round-1 #23
  `rankEvalCandidates` when available. Run `draftTaskFromSession` then `validateTask`, and keep
  only `validated` tasks with a non-gameable verifier.
- **Held-out pool**: every validated task in the store gets a frozen assignment on first sight,
  `heldout = sha256(taskId)[0] < 0x55` (about 1/3), stored as tag `refine:heldout`. Tasks derived
  from the finding's own sessions are **never** held-out for that finding. Held-out evidence is
  **never** given to any proposer. When the store spans ≥ 2 repos or ≥ 2 time windows, prefer
  held-out tasks from a different repo or window. Arize's by-repo vs in-repo gap (5.19 vs 10.87)
  is the overfitting tax this measures.
- **Minimums**: dev ≥ 8 and held-out ≥ 12 paired tasks, or refuse with the `pairedPower` MDE
  printed. Honest numbers: with k = 3 and a per-task diff sd ≈ 0.4, the 80%-power MDE is about
  20 pp at n = 30 and about 11 pp at n = 100. Refine on a small repo will often say
  *inconclusive*, and that is the correct answer.
- **No regression to the mean.** Tasks are *selected* from historical failures, but both arms
  run fresh, interleaved and paired in the experiment. The baseline's chance passes on rerun
  are in the comparison, so selection does not bias the paired diff.

### 5.7 Trial and keep rule (`src/refine/trial.ts`, reusing `runExperiment` and `compare`)

- Baseline bundle = `bundleFromDir` over the agent's current harness files ("current", recorded
  by id). Candidate bundle = baseline plus the patch, named `refine/<id>`.
- **Stage 1, dev**: `runExperiment({tasks: dev, bundles:[base, cand], k: 3})`, then `compare()`.
- **Stage 2, held-out**: only for candidates that pass K2, with fresh run ids.
- **Budget**: before spending, estimate `Σ tasks × k × 2 × median $/run`. Use prior runs of this
  agent, or else the source sessions' `stats.usage.costUsd`. Require `--budget-usd ≥ estimate`
  (or an interactive yes), and stop the pool when the spend reaches the cap. A partial result
  is `inconclusive` and never `keep`. `--dry-run` prints the plan, the MDE and the estimate,
  and spends $0.

**Keep rule.** All must hold. It is DOGFOOD §5 generalized, plus multiplicity:

| # | Check | Default |
|---|---|---|
| K1 gates | every critic passed; run error rate < 10% per arm; candidate `tamperedPasses` ≤ baseline and tamper rate not higher | — |
| K2 dev improves | paired bootstrap 95% CI lower bound of the per-task diff > 0 **or** exact McNemar p < α. α is **Holm-adjusted** over all candidates tested in this `refine test` invocation (R2-3). | α = 0.05 |
| K3 held-out non-inferior | paired bootstrap lower bound > −δ, **and** zero hard regressions (held-out tasks where baseline pass^k = 1 and candidate pass rate ≤ 1/3) | δ = 0.05 (0.03 when n ≥ 100) |
| K4 cost | held-out cost/solved (or tokens/run when cost is unknown) not up > 10%, unless the K2 lower bound ≥ 0.10 | 10% |
| K5 bloat | instruction surface growth ≤ 20%. Above that, K3 must show superiority (lower bound > 0), not just non-inferiority (landscape #9). | 20% |
| K6 one change at a time | candidates are tested one at a time against the same baseline. Composing two kept candidates needs its own trial. | — |

The decision is `keep`, `reject` (with the failing check), or `inconclusive` (underpowered or
budget-stopped). Only `keep` can be applied without `--force`, and `--force` writes the reason
into the ledger.

### 5.8 Apply, ledger, rollback (`src/refine/ledger.ts`)

The ledger is `~/.coding.sh/refine/<repoKey>/ledger.jsonl`. It is local, because evidence ids
point into private sessions. Patch, before and after file contents go in the `BlobStore`.

```ts
interface LedgerEntry {
  id: string; at: number; op: "propose" | "reject" | "test" | "apply" | "rollback";
  candidate?: Candidate; decision?: "keep" | "reject" | "inconclusive"; reasons?: string[];
  experiments?: { dev?: string; heldout?: string }; report?: BlobRef;      // CompareReport JSON
  file?: { path: string; beforeSha: string; afterSha: string; patch: BlobRef };
  rollbackOf?: string; consent?: { scope: "user"; confirmedAt: number };
}
```

- `refine apply <id>` writes the marked block to the working tree. It **never commits**, so the
  user commits it and gets a normal git review. It prints the diff.
- `refine rollback <id>` removes the marked block (or the skill file) when its content hash
  still matches. If the block was hand-edited, it shows a 3-way diff and refuses without
  `--force`. It records `rollbackOf`, the same idea as Prime's `rollback_proposal` with sturdier
  anchoring.
- `refine log` lists entries.

### 5.9 Watch (`src/refine/watch.ts`), the post-apply audit

For an applied id, compare the target finding's rate (affected sessions / sessions) in sessions
started after `apply.at` with the 30 days before, using Wilson CIs. Also show every other flag's
rate. The output is one of:

- "working": the target rate dropped and its CI excludes the old rate
- "no effect yet": n is too small or the CIs overlap
- "suspect": another flag rose significantly. Suggest `refine rollback <id>`.

Label the output **observational** (confounded by task mix). The same code audits **Prime's own
refinements**: each `harness.refine` notification is a change point, and
`coding.sh refine import prime-agent` turns global `harness_state.json` entries into candidates
that can be A/B-tested on and off. That lets `/refine` output get validated.

### 5.10 Agent-agnostic target map

| Agent | Context file(s) | Skills | Tool docs |
|---|---|---|---|
| Claude Code | its own instructions file (or an `@AGENTS.md` import) | `.claude/skills/*/SKILL.md` | `.mcp.json` servers → MCP description variants |
| Codex | `AGENTS.md` | `.agents/skills`, `.codex/skills` (**U** per version) | MCP description variants |
| Gemini CLI | `GEMINI.md` | — | MCP description variants |
| Pi | `AGENTS.md`, `.pi/APPEND_SYSTEM.md` | `.pi/skills`, `.agents/skills` | — |
| Prime Agent | `AGENTS.md` or Claude Code's file, `.prime/agent/APPEND_SYSTEM.md` | `.prime/agent/skills` (**U**) | MCP description variants |
| OpenCode, Cursor, Amp, Droid, Goose, Copilot CLI | `AGENTS.md` (plus `.cursor/rules/*` for Cursor) | per adapter `harnessFiles()` | MCP description variants |
| any CLI under test | — | — | toolevals CLI help variants |

The target is picked from the evidence's agent `harnessFiles()`, project scope first. When the
same finding spans agents, prefer `AGENTS.md`, which most agents read. Optionally pass
`--transfer <agent>` to check the kept edit on a second agent.

### 5.11 Guardrails (stated in `--help` and in docs)

1. **Held-out split.** A frozen, hashed held-out pool is never shown to a proposer and never
   used for selection. Each finding's own tasks are excluded from its held-out set.
2. **Overfitting.**
   - support ≥ 3 sessions over ≥ 2 days
   - a leakage and task-specific-identifier critic
   - bounded edits (≤ 40 lines)
   - ≤ 2 propose→test iterations per finding, stopping on dev results, never on held-out
     (landscape #9)
   - Holm correction across candidates, and held-out is a one-shot confirmation
3. **Cost cap.** A mandatory `--budget-usd` for any spending step, a dry-run estimate first, a
   hard stop at the cap, cached LLM facets, and agent-free model drivers for tool-description
   candidates.
4. **Consent.**
   - Never touch user-global configs (Claude Code's user-level instructions file, `~/.codex/AGENTS.md`,
     `~/.prime/agent/*`, …) unless `--scope user` is given **and** the user confirms on a TTY.
     Non-TTY additionally needs `--allow-global`. Consent is recorded in the ledger.
   - Never commit, push or edit tests, verifiers or CI.
   - Eval runs use isolated overlays (`overlay()`), never the user's live config.
5. **Reward hacking.** The C2 harmlessness critic, tamper detection and tampered-pass parity in
   K1, and impossible-variant validation on every task. The Factorio lesson: an improvement loop
   optimizes whatever check you give it.
6. **Privacy.** Evidence sent to a model provider goes through `createRedactor`. `--provider` can
   point at a local model, and `--no-llm` limits refine to deterministic mining and the agent
   proposer.
7. **Honesty.** Every report prints n, MDE, CIs, the decision and the failing check.
   "Inconclusive" is a first-class outcome.

### 5.12 CLI

```
coding.sh refine                         # plan: mine → top findings → proposals → cost/MDE; spends $0
coding.sh refine mine     [--agent A] [--repo DIR] [--since 30d] [--min-support 3] [--llm] [--json]
coding.sh refine propose  <finding…> [--proposer model|agent:<id>] [--max 3] [--json]
coding.sh refine test     <candidate…> [--k 3] [--budget-usd N] [--dry-run] [--transfer <agent>] [--json]
coding.sh refine apply    <candidate> [--scope project|user] [--force]
coding.sh refine rollback <id> [--force]
coding.sh refine watch    <id> [--json]
coding.sh refine log      [--json]
coding.sh refine import prime-agent      # Prime continual-harness entries → candidates
```

Output follows the repo's CLI rules: stdout carries only the answer, `--json` is supported,
and exit codes are 0/1/2/130. `test` exits 0 when the decision is keep, 1 for reject or
inconclusive, and 2 for usage errors.

### 5.13 Honest limits

- **Power.** Most repos have fewer than 30 validated tasks, so expect `inconclusive` often. The
  remedy is more tasks (R2-6 export and round-1 #23 ranking help) or larger effects. Lowering α
  is not a remedy.
- **Cost.** A full trial is about 2 × k × (dev + held-out) runs: about 120 runs at 8 + 12 tasks
  and k = 3. Tool-description candidates can use the agent-free model driver at a fraction of
  that.
- **Watch is observational.** It suggests actions and decides nothing.
- **Prime-specific coverage depends on unverified details.** The JSON stream shape, the skills
  path, telemetry env values and child usage on disk are all **U** until a real install is
  checked.

---

## 6. Ranked build items

Ranked by (user value + scorecard gain) / effort, with S=1, M=2, L=3, using the same scale as
`tasks/research-queue.md`. The top five touch five different modules (core, runner, stats,
adapters, refine), so they can be built in parallel. Full specs, acceptance criteria and tests
are in the queue under "Round 2 additions".

| # | Item | Module | Effort | V+G | Score |
|---|---|---|---|---|---|
| R2-1 | REPL-cell command extraction: `commandOf` sees `bash('…')`/`subprocess`/`!cmd` in code cells | src/core | S | 5 | 5.0 |
| R2-2 | Instruction-surface size metric and bloat note in compare | src/runner | S | 5 | 5.0 |
| R2-3 | Holm–Bonferroni and paired non-inferiority helpers | src/stats | S | 5 | 5.0 |
| R2-4 | Prime Agent adapter (backfill, kernel cells, RLM children, refine records, run/overlay) | src/adapters | M | 9 | 4.5 |
| R2-5 | `refine mine`: deterministic failure-pattern miner | src/refine | M | 9 | 4.5 |
| R2-6 | Raw-trace evidence export (`coding.sh show --dir`) | src/core | S | 4 | 4.0 |
| R2-7 | `refine propose` and pre-commit critics | src/refine | M | 8 | 4.0 |
| R2-8 | `refine test/apply/rollback/log`: keep rule, ledger, marked blocks | src/refine | L | 10 | 3.3 |
| R2-9 | Harness-change audit (`refine watch`, plus Prime refinement import) | src/refine | M | 6 | 3.0 |
| R2-10 | Sequential (continual) experiments for self-modifying harnesses | src/runner | M | 6 | 3.0 |

**Dependencies:**

- R2-5 benefits from round-1 #11/#12 but does not need them.
- R2-7 needs R2-5.
- R2-8 needs R2-2, R2-3 and R2-7, and builds tasks with existing `src/eval`.
- R2-9 needs R2-8 (ledger) and R2-4 (Prime notifications).
- R2-10 shares `src/runner/experiment.ts` with round-1 #10 and R2-2, so sequence those.

Not queued (folded in or deferred):

- A skill-efficacy audit (pass rate with and without a skill loaded) waits on round-1 #20 skill
  detection. Add it to R2-9 once #20 lands.
- The generic file-tail collector and the ACP proxy are deferred (§4).

---

## 7. Sources

Prime Agent:

- Blog: <https://www.primeintellect.ai/blog/prime-agent>
- Paper: <https://arxiv.org/abs/2608.23552>, <https://arxiv.org/html/2608.23552v1>
- Code: <https://github.com/PrimeIntellect-ai/prime-agent> @ `74591cd` (v0.10.2). Files cited:
  `crates/pa-types/src/session.rs`, `crates/pa-types/src/ai/mod.rs`,
  `crates/pa-daemon/src/paths.rs`, `crates/pa-daemon/src/rlm_ledger.rs` and `rlm_ledger/replay.rs`,
  `crates/pa-core/src/session/manager/{ids,queries}.rs`,
  `crates/pa-core/src/session_engine/{rlm_host,rlm_usage,refine,agent_messaging,session_events}.rs`,
  `crates/pa-core/src/tools/ipython.rs`,
  `crates/pa-core/src/refinement/{mod,planner,executor,ranking}.rs`,
  `crates/pa-core/src/settings/types.rs`, `crates/pa-telemetry/README.md`,
  `crates/pa-cli/src/command_registry.rs`, `skills/refine/SKILL.md`.

Wider field:

- Meta-Harness: <https://arxiv.org/abs/2603.28052>, <https://arxiv.org/html/2603.28052v1>
- SkillOpt: <https://arxiv.org/abs/2605.23904>
- VaG pre-commit gating: <https://arxiv.org/abs/2608.05810>
- SkillBoost / skill overfitting: <https://arxiv.org/abs/2607.26643>
- Multi-round skill feedback dynamics: <https://arxiv.org/abs/2608.02636>
- Self-Evolving Coding Agents survey: <https://arxiv.org/abs/2608.03392>
- CODESKILL: <https://arxiv.org/html/2605.25430v1>
- SkillsBench: <https://arxiv.org/html/2602.12670v1>
- Evaluating AGENTS.md: <https://arxiv.org/abs/2602.11988> (via `docs/research/landscape.md`)
- GEPA: <https://github.com/gepa-ai/gepa>, <https://gepa-ai.github.io/gepa/blog>; SpecterOps
  (Jun 2026): <https://specterops.io/blog/2026/06/09/prompt-engineering-security-agents-gepa>;
  paper arXiv 2507.19457 *(prior knowledge)*
- ACE: <https://huggingface.co/papers/2510.04618>, <https://github.com/ace-agent/ace>
- LangChain harness engineering:
  <https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering>
- Arize Prompt Learning:
  <https://ai.engineer/talks/the-unreasonable-effectiveness-of-prompt-learning>,
  <https://nhimg.org/articles/prompt-learning-for-claude-code-shows-prompt-level-gains/>
- Claude Code `/insights`: <https://blog.vincentqiao.com/en/posts/claude-code-insights/>
  (third-party; not official docs)
- Letta: <https://www.letta.com/blog/skill-learning/>; sleep-time compute arXiv 2504.13171
  *(prior knowledge)*
- BinEval lesson loop: `docs/research/2606.27226.md`
