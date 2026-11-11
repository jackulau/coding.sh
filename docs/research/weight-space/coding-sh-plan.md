# Weight-space programming: what coding.sh should build

Goal: a person running weight-space experiments can record the run, inspect it, and evaluate the
edited model against its base. Research behind this: [README.md](README.md). Checked against the
repo on 2026-11-11 (paths are under `packages/coding.sh` unless they start with `docs/`, `scripts/`
or `packages/sdk-python`).

Compute rule for every item: forward passes, MATH-500 runs and agent runs go to the desk machine
(WSP-sized jobs need a GPU). Nothing here runs a model on the Mac. Tests use tiny synthetic data
and stub models.

## What fits today

| Need | Status | What exists | Gap |
| --- | --- | --- | --- |
| Capture a run with code cells and forward passes | Partly | An agent's Python runs as `tool.start` / `tool.end` with code in `input` and output in `output`; large text goes to a blob (`src/schema/index.ts`). `src/core/cells.ts` reads shell commands out of REPL code. | No notion of a forward pass. The 16 event kinds have nothing model-run specific (item 13). |
| Record a weight edit (tensor, count, norm, hashes) | Missing | `notification` events with `payload.kind` already carry `hook.context`, `model.fallback`, `harness.loaded` (`src/core/hook-context.ts:21`, `src/core/models.ts:228`). | No payload convention, stat, tag or viewer row. |
| Store activations or plots without bloating the index | Partly | Content-addressed zstd blob store (`src/store/fs-blobs.ts`); payload values over 4,096 bytes move to a blob with a 1,024-byte preview (`src/core/offload.ts`, `src/core/config.ts:45`). | `/api/blobs` serves `text/plain` only; no image preview; no blob size cap found by search; `/v1/ingest` drops client blob refs. |
| Evaluate edited vs base on the same items | Supported | `exp ab` interleaves arms; `exp compare A B` pairs by case id with paired bootstrap CI and exact McNemar (`src/experiments/compare.ts`); `exp metrics` pairs whole runs (`src/experiments/metrics.ts`); `dataset import` reads JSONL. | Nothing records which checkpoint an arm used (item 14). Grader scores clamp to 0..1 (`src/graders/builtin.ts` `result()`), so a Breakout score of 309.9 needs normalizing; `exp metrics` pairs runs, not items. |
| Tell "fixed looping" from "better at math" | Partly | `exp compare` gives one `GraderDelta` per grader; the `json-path` grader can read `$.finish_reason`. | No termination or repetition grader. The `looping` derail (`src/core/derail.ts`) is about an agent repeating tool calls, not a model repeating tokens. No accuracy-given-terminated comparison. |
| Compare two agents or prompts at weight editing | Partly | `coding.sh compare` A/B's two harness bundles on eval tasks with `--k`, `--max-cost`, `--otel`; `bench` runs contenders on one frozen sample. `exp metrics` reports any number a command task prints, per arm, with a paired CI (`src/experiments/metrics.ts`). | Edit size and gain per weight are not documented columns (item 15). Running two different agents as arms is unverified (item 16). |
| Show it in the viewer | Partly | Tool calls, blobs by ref, experiments and compare views. An unknown `notification` kind renders as a muted "Notification" row with its payload as JSON. | No weight-edit row, before/after header, or image blob preview. |
| Import the authors' published logs | Missing | The Codex adapter backfills only `rollout-*.jsonl` (`src/adapters/codex.ts:981`). The headless runner reads `exec --json` but only `thread.started` and `turn.completed` (`codex.ts:1034`). `ingest` has no path flag. | No reader for `exec --json` files plus `tool_calls.jsonl`. |

Unchecked from the table: whether redaction (`src/core/redact.ts`) runs on blob content, and how
its secret rules treat long float or base64 dumps. Both need a test before P1 item 6 ships.

## Build items, ranked by value over cost

### P0

**1. Recipe: edited vs base with termination and accuracy as separate graders** (evals, S)
- User gets: a short guide that runs MATH-500-style items through base and edited checkpoints and
  reports "terminated" and "correct" as two paired deltas, using only commands that exist.
- Files: `docs/guides/evals.md` (one section; no new page unless it outgrows a screen),
  `test/experiments/weight-recipe.test.ts`.
- Smallest version: `dataset import math500.jsonl`; two command tasks that print
  `{answer, finish_reason, tokens}` per case; graders `{kind:"json-path", name:"terminated",
  path:"$.finish_reason", equals:"stop"}` and an exact or numeric grader named `correct`;
  `exp compare base edited`. Note the 0..1 grader clamp for unbounded scores.
- Test: the test reads the recipe out of the guide, so deleting the section fails it. Add
  `guides/evals.md` to `GUIDES` in `test/docs/guide-commands.test.ts` (every `coding.sh` command in
  it must parse). `weight-recipe.test.ts` takes the grader JSON and the `exp compare` argv from the
  guide with `fileBlock` / `commandsOf`, as the terse-mode test there does, and runs them on a stub
  command task over 4 synthetic cases where arm B terminates more often. Assert two `GraderDelta`s,
  `terminated` and `correct`, both up.
- Compute: none for the test. Real runs (vLLM, 32,768-token generations) on the desk.

**2. `exp compare --given <grader>`: accuracy on cases both arms pass a gate** (evals, S)
- User gets: "correct among answers that finished" as its own paired delta, the number nobody
  published for Exp 8.
- Files: `src/experiments/compare.ts`, `src/cli/registry.ts` (flag), `docs/reference/cli.md`
  (regenerate with `scripts/cli-reference.ts`), `docs/guides/evals.md`, `CHANGELOG.md`,
  `test/experiments/compare-given.test.ts`.
- Smallest version: filter the paired cases to those where the gate grader passes in both arms,
  then reuse the existing bootstrap and McNemar code; print n kept and n dropped.
- Test: synthetic runs where B's overall `correct` delta is positive only because B terminates
  more; with `--given terminated` the CI must cover 0. Fails without the flag.
- Compute: none.

**3. `weights.edit` event convention and a Python SDK helper** (capture, M)
- User gets: each weight edit an agent makes shows up in its session as one record: tensor, shape,
  weights changed, L2 and max-abs of the change, base and edited sha256.
- Files: `packages/sdk-python/src/coding_sh/_trace.py` (or a new `_weights.py`) exporting
  `weights_edit(...)`, `packages/sdk-python` tests, `docs/reference/api.md`, `docs/concepts.md`,
  `CHANGELOG.md`; `src/otel/map.ts` only if a span named `weights.edit` should map to the same
  notification (otherwise it already lands as a generic `span` event).
- Smallest version: a `notification` with `payload.kind: "weights.edit"` and small scalar fields,
  posted through `/v1/ingest`. No new `EventKind`, so the JSON Schema does not change. Hashes and
  norms are computed by the agent's script; the hook does none of it.
- Test: SDK test posts one edit to a temp `CODING_SH_HOME` server and reads it back with the
  payload intact and redaction applied.
- Compute: none.

### P1

**4. Session stats and tag for weight edits** (sessions, S)
- User gets: sessions that edited weights are findable (`weights:edited`) and show a count.
- Files: `src/core/sessions.ts` (fold `weights.edit` notifications into optional
  `stats.weightEdits {events, tensors, weightsChanged}`; bump `SESSION_FOLD_VERSION` from 19),
  `src/schema/index.ts` (stat type; regenerate the JSON Schema), `docs/reference/api.md`,
  `docs/concepts.md`, `CHANGELOG.md`, `test/core/sessions.test.ts`.
- Smallest version: count only; absent when there are no edits.
- Test: a session with two edits gets the stat and tag; one with none has neither
  (`Object.hasOwn` false). No existing test catches a missing fold bump: `foldStamp()` hashes only
  the shape of `sessionState()` (`test/core/fold-stamp.test.ts`), so it moves by itself only when a
  new sub-state is added. Put the counters in `sessionState()` so the stamp changes, and add a test
  that a store whose `REFOLD_CURSOR` holds the old stamp is refolded and its stored session gains
  `stats.weightEdits` (cursor pattern from `test/core/reparse.test.ts`).
- Compute: none.

**5. Viewer row for weight edits and a before/after header** (viewer, M)
- User gets: "Edited layers.15.mlp.down_proj.weight · 65,536 weights · ‖Δ‖ = x" with copyable short
  hashes, and a header that shows metric before and after from numeric scores.
- Files: `src/viewer/ui/index.html` (`case "notification"` near line 3701), `test/viewer/`.
- Smallest version: the row only; the header reads existing `score` rows of source `code`.
- Test: viewer test renders a fixture session with one `weights.edit` and checks the row text.
- Compute: none.

**6. Artifact references for activations and plots** (store, M)
- User gets: activations and plots attached to the step that made them, with a small summary
  inline and bytes stored only on request.
- Files: `docs/reference/api.md` (a `payload.kind: "artifact"` convention: name, mime, bytes,
  sha256, shape, dtype, min/max/mean/L2), the Python SDK helper, `src/core/config.ts`
  (`capture.maxArtifactBytes`), the blob route in the server (serve `image/png` with its type),
  viewer image preview.
- Smallest version: the summary event only, file left on the desk; then PNG storage under a cap.
  Full `.npy` tensors stay out of the store by default.
- Test: an over-cap artifact is recorded with `skipped: true` and no blob; a small PNG round-trips
  with `Content-Type: image/png`. Add a redaction test with a synthetic float dump.
- Compute: none.

**7. Import Codex `exec --json` logs, with the authors' logs as a demo** (capture, M)
- User gets: `coding.sh ingest --path <dir>` turns a folder of `events.jsonl` (+ `run.json`,
  `tool_calls.jsonl`) into sessions, so the published Exp 1 and Exp 3 runs open in the viewer.
- Files: `src/adapters/codex.ts` (reader for `thread.started`, `item.completed` reasoning /
  agent_message / error, `turn.completed` usage; model and effort from `run.json`; tool rows from
  `tool_calls.jsonl` by order), `src/cli/registry.ts` (flag), CLI reference, `docs/ADAPTERS.md`,
  `CHANGELOG.md`, `scripts/e2e/` capture for the fixture.
- Smallest version: single-turn runs only (Exps 1, 2): one session per `thread_id`, messages and
  usage. Multi-turn `turns/tNNN` and `tool_calls.jsonl` next.
- Test: fixture recorded by a new `scripts/e2e` script that runs pinned Codex `exec --json` against
  `stub-model.mjs` under a throwaway home, scrubbed to `/work/demo`; golden via `UPDATE_GOLDEN=1`.
  The authors' files are not fixtures: AGENTS.md wants fixtures from our own recorded runs, and the
  Exp 5 prompts carry GPL-3.0 MinAtar source. A demo script may fetch a few CC BY 4.0 run folders
  (kilobytes each, attribution kept) into a temp dir.
- Compute: none. The full repo is 138,603 KB; fetch single run folders, not a clone, on this Mac.

**8. Per-item paired analysis for unbounded numeric scores** (evals, M)
- User gets: base vs edited on per-episode or per-problem numbers (Breakout scores, ramp climbs)
  paired by item, with a CI, instead of squeezing them into 0..1.
- Files: `src/experiments/metrics.ts` (accept `{item, value}` rows from a command task), reuse
  `src/stats/` (`pairedBootstrapMedian`, `signTest`), registry and CLI reference, evals guide.
- Smallest version: one metric, pairing by `item`, median paired delta with 95% bootstrap CI.
- Test: synthetic rows with a known shift; CI excludes 0. Rows with unmatched items are reported,
  not silently dropped.
- Compute: none.

**9. Termination grader** (evals, M)
- User gets: a built-in grader that flags non-terminating generations even when the runner gives
  no `finish_reason`: hit the token cap, or the last N tokens repeat.
- Files: `src/graders/builtin.ts`, `src/graders/index.ts` (`GraderSpec`), registry help, CLI
  reference, evals guide, `test/graders/termination.test.ts`.
- Smallest version: `maxTokens` cap check plus a suffix n-gram repeat ratio with one threshold.
- Test: a looping synthetic string fails, a normal answer passes, a long non-repeating answer
  under the cap passes.
- Compute: none.

### P2

**10. Replication suite: Exp 1 end to end on the desk** (bench, M)
- User gets: a frozen suite that reruns "which game is this" over the four published networks and
  scores the agent, so two agents or prompts can be compared with `coding.sh compare` or `bench`.
- Files: `scripts/e2e/` or `evals/weight-space/` task dirs (`eval import`), a docs section.
- Smallest version: 4 tasks, each prompt built from the CC BY 4.0 `*_actor.txt` weights; an exact
  grader on the game name; k=3. About 74k input tokens per attempt, per the published usage.
- Test: `eval validate` alone checks only the verifier (`src/eval/validate.ts`), not the grader or
  the prompts. Add: (a) the prompt builder on tiny synthetic weight files embeds the weights and no
  game name; (b) the grader on four canned answers (right game, wrong game, right game in a
  sentence, empty) gives the expected pass or fail; (c) a stub agent that always names one game
  scores exactly 1 of 4 through the real eval run path. Synthetic weights only: the Exp 5 prompts
  carry GPL-3.0 source.
- Compute: agent API calls on the desk, no GPU. A GPU follow-up (Exp 8: base vs published edited
  checkpoint on MATH-500 with items 1 and 2) also runs on the desk.

**11. Run facts as tags: tool access and forward-pass budget** (sessions, S)
- User gets: `tools:none` vs `tools:python` and the pass budget on each session, the facts critics
  argued over.
- Files: `src/core/sessions.ts`, fold bump, docs.
- Smallest version: read them from a `notification` the harness emits; no guessing from traces.
  The payload shape is not defined yet; fix it before writing the test.
- Test in `test/core/sessions.test.ts`: `tools:python` plus a budget gives the tag and stat;
  `tools:none` gives `tools:none`; no notification gives neither key; a malformed payload is
  ignored; the colon tag adds no failure; Python tool calls with no notification get no tag. Same
  fold-bump test as item 4.
- Compute: none.

**12. Exp 8 termination split: check the totals, then rerun on the desk** (research, S)
- Finding: the published files cannot give accuracy among finished answers. `merged.json` has
  `acc` and `cut_share`, and `acc / (1 - cut_share)` exceeds 1 unedited (0.079 / 0.07). Shard
  `scores.json` has `ok`, `cut`, `total` but no correct-and-finished count, and per-problem files
  have no finish field (README, "The Exp 8 critique").
- Smallest version: a research script that sums `ok` and `total` over the `parts/*/scores.json`
  shards and asserts 158 / 2,000 (7.9) unedited and 962 / 2,000 (48.1) at 50 passes, failing if a
  file is missing. A one-off sum on 2026-11-11 gave exactly these totals. The split itself waits for the desk run under item 1 with `--given terminated`
  (item 2), base vs the published 50-pass checkpoint. Not product code.
- Compute: a few KB of JSON for the check; the split needs a desk vLLM run.

**13. `forward.request` event convention** (capture, S; P1)
- User gets: each forward pass an agent spends is one record, so the pass count against the budget
  is visible per session.
- Fields, after WSP-Scope Table 9 ([arXiv HTML](https://arxiv.org/html/2611.09382)): `n` (1-based
  pass number), `turn`, `type` (`generate` or `teacher_forced`), `batch`, `cap` (token cap),
  `baseCorrect`, `editedCorrect`, `gainPp`, `purpose`. Table 9 lists only successful requests;
  whether failed ones count is not stated.
- Files: same as item 3 (Python SDK helper, `docs/reference/api.md`, `CHANGELOG.md`). A
  `notification` payload kind, so no schema change. The budget comes from item 11.
- Test: the SDK posts two requests to a temp server and reads them back with `n` 1 and 2.
- Compute: none.

**14. Checkpoint stamp on an experiment** (evals, S; P1)
- User gets: `exp compare` shows which weights each side ran, and warns when both ran the same.
- Smallest version: `exp run --weights <SHA256>` stores `metadata.weights {sha256}` in the
  `ExperimentResult` (`src/experiments/run.ts`; `metadata.checkpoint` is already a progress marker,
  so use a new key). The user hashes the file on the desk; the CLI hashes nothing. The authors
  stamped only `ckpt` path and `ckpt_mtime`
  ([scores.json](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp8_math/eval/unedited/parts/math500_s0of10/scores.json)).
  `exp metrics` arms carry only `TaskInfo {kind, ref}` (`src/experiments/metrics.ts`); leave them
  for later. Experiment metadata only, so no fold bump.
- Files: `src/experiments/run.ts`, `src/experiments/compare.ts`, `src/cli/registry.ts`, CLI
  reference, evals guide, `CHANGELOG.md`, `test/experiments/weights-stamp.test.ts`.
- Test: two runs with different stamps show both in the compare header; equal stamps warn; no flag
  leaves `metadata.weights` absent.
- Compute: none.

**15. Edit size and gain per weight as report columns** (evals, S; P2)
- User gets: "weights changed" and "gain per weight" next to the score, as Exp 4 (6,073 of
  171,664) and WSP-Scope (1,023 parameters, +29.45) report them.
- Smallest version: docs only. `exp metrics` already reports every number a task prints, with a
  paired CI. Document the keys `edited_weights`, `gain_pp`, `gain_per_weight` in the evals guide.
  `MetricUnit` is `ms`, `bytes` or `count`, so a ratio has no unit; add one only if the report
  needs it. Whether `bench` should show them is not checked.
- Test: a stub command arm that prints these keys; the `exp metrics` report lists all three.
- Compute: none.

**16. Two agents as arms: smoke test** (evals, S; P2)
- User gets: proof that `exp metrics` runs two different command-wrapped agents on the same cases.
- Smallest version: a test with two command arms that print fixed JSON under `tmpEnv()`. It proves
  the arm plumbing only. Whether a wrapped `claude -p` or `codex exec` links its own session and
  cost to the experiment needs a live desk run; keep "unverified" in the table until then.
- Compute: none for the test.

## What not to build

- A new `EventKind` for weight edits or forward passes. A `notification` payload kind avoids
  changing the schema and every consumer.
- Tensor parsing, numpy or safetensors readers in `packages/coding.sh`. Zero runtime dependencies;
  the agent's script computes hashes and norms.
- Hashing checkpoints or running forward passes in the hook or the CLI. The hook stays well under
  50 ms with no heavy work.
- Storing checkpoints or full activation tensors in the blob store by default.
- A weight-editing tool, MCP server or sandbox of our own. That is the experimenter's harness, not
  observability.
- A project-share bundle format or GPU job runner. Out of scope for local capture and evals.
- Public claims or site copy built on the replication numbers until they are verified.
