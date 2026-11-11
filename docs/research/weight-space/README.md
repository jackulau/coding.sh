# Weight-space programming: what is known

Checked 2026-11-11, from public pages only. Nothing was run and no weights were downloaded.
"Inference" marks a conclusion drawn here, not stated by a source. "Unverified" means no public
page shows it. The build plan for coding.sh is in [coding-sh-plan.md](coding-sh-plan.md).

Main sources, linked by short name below:

| Name | URL |
| --- | --- |
| Blog | https://rikiyat.github.io/blog/weight-space-programming/ |
| Blog source | https://raw.githubusercontent.com/RikiyaT/RikiyaT.github.io/master/blog/weight-space-programming/index.html (76,425 bytes, one static HTML file) |
| Logs | https://github.com/RikiyaT/lm_understand-logs |
| Exp 4 log | https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp4_fix_car/README.md |
| Exp 6 log | https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp6_go_from_scratch/README.md |
| Gemma log | https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp8_math/gemma_followup/README.md |
| Exp 8 eval | https://github.com/RikiyaT/lm_understand-logs/tree/main/exp8_math/eval (`unedited/merged.json`, `p50c/merged.json`, `RESULTS_excerpt.md`) |
| Edited card | https://huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming |
| Qwen card | https://huggingface.co/Qwen/Qwen3.5-0.8B/blob/main/README.md |
| Replication page | https://openresearch.sh/p/qgq98UNCo8pK |
| WSP-Scope | https://huggingface.co/papers/2611.09382 and https://www.alphaxiv.org/abs/2611.09382 |
| Deletion Tuning | https://arxiv.org/abs/2611.10866 and https://www.alphaxiv.org/abs/2611.10866 |

The Blog numbers below were checked against the Blog source with curl, not a summarizer: the Exp 3
confidences, Exp 5 scores, Exp 7 head 10.2 shares and Exp 8 table all match. The Exp 4 and Exp 6
log READMEs and the Exp 8 `merged.json` files were also read raw.

## What it is

An LLM "reads and writes a network's weights directly", "not through an optimizer, and in
particular not with gradient descent", "around some natural language spec, sometimes even with no
environment feedback at all" ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)).

- Authors: Rikiya Takehi, Jayden Teoh, Alex Zhang, Omar Khattab, MIT CSAIL. Published
  November 2, 2026 ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)).
- The editing model is "GPT-6 Astra" (TL;DR and Exp 4), "Astra" elsewhere
  ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)). The logs name the model
  `gpt-6-astra` ([Logs](https://github.com/RikiyaT/lm_understand-logs)).
- The page has Experiments 1 to 8 plus an unnumbered "Additional experiment" on Gemma 3 270M.
  Calling that one the ninth is inference; the replication post counts 9.
- The authors' limits: results are "very early", capabilities "still limited". "Editing weights
  could remove an obstacle that hid an ability, but it could not add an ability the model lacked"
  ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)).

## The experiments, original and replication

Replication numbers come only from the user's pasted post. The
[Replication page](https://openresearch.sh/p/qgq98UNCo8pK) shows counts only ("Experiments: 11,
Runs: 16, Chats: 9") and an 840.4 MiB `.orx` file for a macOS app. None of the replication numbers
are on the public page, so all of them are unverified.

| # | Task | Network | Original result | Replication (pasted, unverified) |
| --- | --- | --- | --- | --- |
| 1 | Name the game a policy plays (Breakout, Pong, Pac-Man, Freeway) | MLP 500→32→32→5, tanh, 17,253 weights | Right game for all four ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)) | Not given |
| 2 | Name the shape a diffusion MLP draws (filled circle, square, triangle; 12×12) | MLP 160→64→64→144, ReLU, 23,824 weights | Right shape for each, but drawn as outlines though the models generate filled shapes ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)) | Not given |
| 3 | Name the training language (Python, romaji, English) and the copying heads | Transformer 4 layers × 6 heads, width 384, 7.16M weights; middle 4 blocks only | Right language for all three, both attempts. Confidence Python 0.56/0.52, romaji 0.55/0.62, English 0.58/0.48. Heads named: Python 2.1, 3.1, 3.5; romaji 3.3; English 3.1. Ground truth: copying heads score 0.22 to 0.55, others at most 0.02 ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)) | Not given |
| 4 | Fix a Kinetix car policy that fails to climb a ramp | 679→128 ReLU→5×128 tanh→16, 171,664 weights, official PPO, 1B steps | Before: "The car never succeeds in 256 episodes". After: all 1,024 episodes succeed, "changing 3.5% of the weights" ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)). Exact: "6,073 of 171,664 (3.54 %)", from 51 edit statements; 256/256 on the shown episodes ([Exp 4 log](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp4_fix_car/README.md)) | 0/1,024 → 1,024/1,024, 4,813 weights edited, "21% fewer than the authors" |
| 5 | Write MinAtar policies from all-zero weights | 600→32→32→6, tanh | Astra / PPO 100M / PPO 500M: Breakout 517.4 / 15.8 / 25.3; Seaquest 53.1 / 5.6 / 88.9; Asterix 53.2 / 25.8 / 55.2 ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)) | Breakout 309.9 average, "~12x higher than the blog" |
| 6 | Write a 9×9 Go network from all-zero weights | 243→512×6→82, ReLU, 1,480,274 weights | 0 passes (one 336-line Python run): "wins more than half of its games" against two PPO nets (243→32→32→82). 50 passes: "beats the equal-sized PPO network that was trained on 20 million games". Scored on 2,000 games against each of PPO seeds 0 and 2 ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)). Win rates vs seed 0 / seed 2: budget 0 54.1% / 54.9%, 10 72.9 / 60.0, 25 76.0 / 62.3, 50 84.0 / 80.8. Vs same-size PPO seeds 0 / 1 / 2: budget 0 42.6 / 26.3 / 36.3, budget 50 74.2 / 70.0 / 78.5 ([Exp 6 log](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp6_go_from_scratch/README.md)) | Not given |
| 7 | Pick the sycophantic one of two Gemma 3 270M fine-tunes | Gemma 3 270M, 18 layers, token embedding frozen; 3 pairs | Sycophant follows 100% of wrong guesses, honest 1–3%. From weights alone it failed; with the attention tool it picked the sycophant in all three pairs. Head 10.2: honest 94.3% to question numbers, 0.75% to the user's answer; sycophant 3.5% and 85.7% ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)) | Not given |
| 8 | Improve Qwen3.5-0.8B (thinking on) at math | 24 layers, 0.8B weights | 131,072 weights edited (0.016%), layers 15 and 19. MATH-500 7.9% → 48.1% with 50 passes ([Blog](https://rikiyat.github.io/blog/weight-space-programming/), [Edited card](https://huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming)) | 34.4% MATH-500 with 50 passes |
| Add. | Improve Gemma 3 270M at math (rarely loops) | Gemma 3 270M | MATH-500 base 6.8; 7.0 / 7.6 / 7.7 / 7.0 at 5 / 10 / 25 / 50 passes; "Astra could not improve it" ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)) | Not given |

Notes on the replication numbers (all inference):

- Exp 4: the original baseline is 0 of 256 episodes, not 0 of 1,024. The two baselines differ in
  sample size.
- Exp 4: against the logged 6,073 weights, 4,813 / 6,073 ≈ 0.79, so "21% fewer" is consistent.
  The replication's own count is still unverified.
- Exp 5: 309.9 is below the original Astra score of 517.4 (about 60% of it). 309.9 / 25.3 ≈ 12.2,
  so "12x higher than the blog" most likely compares with the PPO 500M baseline, not with Astra.
- Exp 5: Astra beat PPO 500M only on Breakout. On Seaquest PPO 500M scored 88.9 against 53.1, and
  on Asterix 55.2 against 53.2 ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)).
- The replication page counts 11 experiments, two more than the 9 the post names.

### Exp 8 result table

From the [Blog](https://rikiyat.github.io/blog/weight-space-programming/) and the
[Edited card](https://huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming). Thinking on,
up to 32,768 tokens. Sampling: temperature 0.6, top-p 0.95, top-k 20, presence penalty 1.5.

| Run | MATH-500 | GSM8K | IFEval | Hit 32,768-token limit (MATH-500) |
| --- | --- | --- | --- | --- |
| Base | 7.9 | 13.8 | 21.0 | 93.0 |
| 10 passes | 12.3 | 25.7 | 49.0 | 87.2 |
| 25 passes | 14.1 | 25.1 | 39.9 | 86.4 |
| 50 passes | 48.1 | 67.1 | 62.3 | 33.1 |
| Independent re-run of the 50-pass checkpoint (`akhaliq`) | 51.0 | | | 31.6 |

The re-run used 500 problems × 4 samples = 2,000 generations
([Edited card](https://huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming)). Its base
comparison was only a 25-problem smoke test at 5.0%. It checks the checkpoint, not that an agent
can redo the edit. "51 minutes on an H200, 43.4 million tokens" comes from a secondary blog
([buildmvpfast](https://www.buildmvpfast.com/blog/astra-weight-editing-qwen-misleading-rebuttal-2026)).

IFEval is non-monotone (49.0 at 10 passes, 39.9 at 25). One run per budget is noisy.

The eval files agree: MATH-500 `acc` 0.079 and `cut_share` 0.93 unedited, 0.481 and 0.3305 at 50
passes; mean tokens 30,868 → 22,037
([unedited](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp8_math/eval/unedited/merged.json),
[p50c](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp8_math/eval/p50c/merged.json)).
Each shard's `scores.json` gives counts over 4 samples per problem; shard 0 of the unedited run has
`ok` 14, `cut` 190, `total` 200
([scores.json](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp8_math/eval/unedited/parts/math500_s0of10/scores.json)).
Summed over the 10 MATH-500 shards (`parts/math500_s<i>of10/scores.json`): unedited 158 correct
and 1,860 cut of 2,000; 50 passes 962 correct and 661 cut of 2,000. Other benchmarks
unedited → 50 passes: AIME24 0.0 → 0.0, AMC23 0.5 → 23.4, Minerva 1.5 → 25.4, OlympiadBench 1.3 →
21.8, GPQA 22.7 → 36.6, MMLU-Pro 40.3 → 45.5
([RESULTS_excerpt.md](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp8_math/eval/RESULTS_excerpt.md),
read through a summarizing fetch). That file numbers the Qwen math runs "Experiment 6" and Gemma
"Experiment 8", unlike the Blog.

## What the agent was given

From the [Blog](https://rikiyat.github.io/blog/weight-space-programming/). Reasoning effort per
experiment is from the [Logs](https://github.com/RikiyaT/lm_understand-logs) README.

| # | Given | Tools | Forward passes | Effort |
| --- | --- | --- | --- | --- |
| 1 | All weights as text, grid and action layout; game options withheld | None | 0 | high |
| 2 | Weights as text, no shape named; "told not to compute any forward pass" | None | 0 | high |
| 3 | The four middle blocks only, no input or output layers | Python for analysis, up to 100 runs; running the network or any layer is not allowed | 0 | xhigh |
| 4 | All weights, a scene description, one recorded episode; explain and fix in one reply | None, single try | 0 | high |
| 5 | Rules, game source code, I/O layout, scoring method; "no data, no loss, no gradients, and no tools" | None, one reply | 0 | xhigh |
| 6 | Rules, I/O layout | Python sandbox (no Go library, no internet) to write weights; each pass plays up to 128 games against a practice opponent | 0 to 50 | xhigh |
| 7 | Weights, tokenizer, numpy | Attention tool: up to 16 self-written texts, attention weights only, at most 20 runs | None beyond the attention tool | xhigh |
| 8 | Python kernel over the weights (no GPU); 7,469 GSM8K and 7,275 MATH practice problems, not the test sets | Python kernel; each pass up to 512 problems, average batch 64 | 10, 25 or 50 | max |
| Add. | Same setup on Gemma 3 270M; temperature 1.0, top-k 64, top-p 0.95, 8,192 tokens, 4 samples per problem | Same as 8 | 5, 10, 25 or 50 | not stated |

Exp 6 has two pass types: "the network plays up to 128 games against a practice opponent ... or
gives its outputs on up to 256 positions" ([Blog source](https://raw.githubusercontent.com/RikiyaT/RikiyaT.github.io/master/blog/weight-space-programming/index.html)).

### The harness and the published logs

From the [Logs](https://github.com/RikiyaT/lm_understand-logs) README, the GitHub API and raw files.

- "Each turn is one codex exec call". Every built-in Codex tool (shell, file editing, web search)
  is off. Code runs only in Exps 3, 6, 7, 8, one Python block per turn, in a sandbox with no
  network. "All 1,125 turns in this release are tool-free", recorded in `run.json`
  `audit.tool_free`.
- Repo: 138,603 KB, created 2026-10-29, folders `exp1_which_game` … `exp8_math` plus `harness/`
  (`codex_config.toml`, `instructions.md`, `sandbox.py`). Exp 4 is `exp4_fix_car`. The Gemma run is
  `exp8_math/gemma_followup` (`README.md`, `eval/`, `runs/`). `exp8_math/eval` holds
  `RESULTS_excerpt.md` and the folders `unedited`, `p10c`, `p25c`, `p50c`, each a `merged.json`
  plus per-shard `parts/` ([GitHub API](https://api.github.com/repos/RikiyaT/lm_understand-logs/contents/exp8_math/eval)).
  The 17 GB Exp 7 Gemma fine-tunes are not included. Exp 3 holds three `blocks.npz` files of 28,345,926
  bytes each ([GitHub API](https://api.github.com/repos/RikiyaT/lm_understand-logs)).
- No-tool runs (Exps 1, 2): one folder per run with `prompt.txt` (115,478 bytes for Breakout,
  157,889 for the circle, because the weights are pasted as text), `events.jsonl` (3,084 to 4,160
  bytes), `run.json`, `answer.md`, `instructions.md`, an empty `stderr.log`.
- `events.jsonl` is the Codex `exec --json` stream: `thread.started {thread_id}`,
  `item.completed` (`error`, `reasoning`, `agent_message`), `turn.started`, `turn.completed {usage}`.
  Sample usage: 73,749 input, 2,432 cached, 0 cache-write, 1,679 output, 833 reasoning tokens
  ([raw](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp1_which_game/runs/breakout/events.jsonl)).
  Breakout `run.json`: `wall_s` 107.2, one turn.
- Tool-using runs (Exp 3 sampled): `turns/tNNN/{prompt.txt, events.jsonl, answer.md, run.json,
  stderr.log}`, plus `state.json` (`{"turn": 8, "runs": 7, "thread": "id-00548804", "done": true,
  "next": "OUTPUT of run 7 of at most 100: ..."}`) and `tool_calls.jsonl`
  ([raw](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp3_language/runs/english_r0/state.json)).
- `tool_calls.jsonl` rows are `{t, s, code, out}`: timestamp, probably seconds, Python source,
  stdout. No call id, tool name or exit code
  ([raw](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp3_language/runs/english_r0/tool_calls.jsonl)).
- Exp 4 (one reply, no tools): Astra writes statements in a small edit language; `loop.log` and
  `eval/oneshot_result.json` record statements applied, tensors touched and `changes` (`changed`,
  `frac_changed`, per tensor). `run.json` `audit.usage`: 10,134 output, 9,146 reasoning tokens
  ([Exp 4 log](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp4_fix_car/README.md)).
- Exp 6: each turn is a `python`, `games` or `positions` block; each pass is a `tool_calls.jsonl`
  row plus a `requests/` file. A weight write has no log of its own: it happens inside a Python run.
  Final weights are `.npy` plus `arch.json` per budget
  ([Exp 6 log](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp6_go_from_scratch/README.md)).
- Exp 8 eval `scores.json` stamps each run with `ckpt` (a path) and `ckpt_mtime`, not a hash, plus
  the sampling protocol and samples per benchmark
  ([scores.json](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp8_math/eval/unedited/parts/math500_s0of10/scores.json)).
- Paths are scrubbed to placeholders such as `<data>`, `<repo>`, `<codex_home>`, `<home>`.
- License: logs, data and networks CC BY 4.0; scripts MIT; MinAtar source in the Exp 5 prompts
  GPL-3.0; benchmark data keeps its own licenses. The GitHub API reports `NOASSERTION`.
- Unresolved: `harness/codex_config.toml` names `gpt-6-luna` at medium effort, while the README and
  `run.json` say `gpt-6-astra` at high effort or more. It may be a base file the runs override
  (inference, not checked).

## The Exp 8 critique

The user's pasted critique: the LLM "was given weights explicitly as text in prompt and used
code/forward passes (per authors' logs) to ablate Qwen looping direction, a known thinking-mode
issue per model card. Primarily fixed repetition in that mode, not general 'natively' improving
weights/math."

| Part of the critique | Verdict | Evidence |
| --- | --- | --- |
| Weights given as text in the prompt | Wrong for Exp 8 | Exp 8 used "a Python kernel over the weights (no GPU)". Weights as text applies to Exps 1 and 2 ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)). |
| Used code and forward passes | Right | Budgets of 10, 25 and 50 forward passes; Python was the only tool ([Blog](https://rikiyat.github.io/blog/weight-space-programming/), [Logs](https://github.com/RikiyaT/lm_understand-logs)). |
| Ablated a looping direction | Right in substance | Astra "traced the base model's thinking loops to one direction written by the MLPs of layers 15 and 19, and subtracted it from 64 output columns of down_proj in each layer". Only `layers.15.mlp.down_proj.weight` and `layers.19.mlp.down_proj.weight` differ ([Edited card](https://huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming)). The authors do not use the word "ablate"; subtracting a direction is directional ablation (inference). |
| Looping is a known issue on the model card | Right | "Qwen3.5-0.8B is more prone to entering thinking loops compared to other Qwen3.5 models"; "adjust the `presence_penalty` parameter between 0 and 2 to reduce endless repetitions" ([Qwen card](https://huggingface.co/Qwen/Qwen3.5-0.8B/blob/main/README.md)). |
| Mainly a repetition fix, not better math | Substantially right | Token-limit hits fell 93.0% → 33.1%. The authors say: "Fixing loops, however, is not the same as making a model better at math: it lets the model finish answers it could already work out." Gemma 3 270M, where only 8.5% of answers hit the limit, gained about a point at most ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)). IFEval, not a math task, rose 21.0 → 62.3. |

Verdict: the gain is best explained by fewer answers that never finish. The critique overstates
the "weights as text" detail, and the authors already concede the main point.

Caveats:

- The base was run with presence penalty 1.5, the card's mitigation, so loops persisted with it.
  But the authors used temperature 0.6, and the card recommends 1.0 for thinking mode
  ([Qwen card](https://huggingface.co/Qwen/Qwen3.5-0.8B/blob/main/README.md)). No penalty sweep,
  temperature 1.0 run or thinking-off baseline was found.
- 85 of the first 96 practice answers ran to the 32,768-token limit
  ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)).
- Answers are graded on the last `\boxed{}` with math-verify 0.9.0
  ([Edited card](https://huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming)). A cut
  answer can still score: in unedited shard 0, 14 of 200 generations are correct but only 10
  finished, so at least 4 correct ones were cut
  ([scores.json](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp8_math/eval/unedited/parts/math500_s0of10/scores.json);
  arithmetic here).
- Accuracy among answers that finish cannot be computed from the published files. `acc /
  (1 - cut_share)` gives 0.079 / 0.07 > 1 for the unedited run. `math500_per_problem.json` has `id`,
  `correct` (4 per problem) and `pred_first`, with no finish field; `math500_first_samples.jsonl.gz`
  holds 20 rows of `{id, answer, text}` per shard, also with no finish field (one shard read).
  The split needs per-sample finish flags, which means a desk rerun.

## Follow-up work and coverage

**WSP-Scope** ([HF paper page](https://huggingface.co/papers/2611.09382),
[alphaXiv](https://www.alphaxiv.org/abs/2611.09382)): "Exploring Weight-Space Programming:
Capabilities, Generalization, and Limitations", arXiv 2611.09382, Shanghai AI Lab, Tongji, Fudan.
alphaXiv says submitted 06 Nov 2026; the HF page shows 09 Nov.

- "16 editing trajectories across seven benchmarks and two model scales" (Qwen3.5-0.8B and 9B).
- "modifying only 1,023 parameters yields a 29.45-point improvement" on MATH-500. Best gains: 29.45
  (MATH-500), 4.42 (GPQA Diamond), 36.72 (IFEval), 17.11 (SciBench).
- "six of the 16 trajectories retain the original weights when candidate improvements cannot be
  reliably validated."
- Harness: helpers `load`, `load_original`, `save_edit`, `drop_edit`, `edited()`. "Each search is
  allocated 50 successful forward-tool requests", "up to 300 Python analyses per search". Updates
  computed in float32, stored in bfloat16. Embeddings, final norm and LM head stay fixed.
- Requests: `generate` (results in `/work/gen_<k>.jsonl`) and `teacher_forced` (log-probs and
  activations as `.npy` with `meta.json` in `/work/fwd_<k>/`). Table 9 lists every forward request
  of one search.
- Evaluation: same decoding as the Blog, seed 0, held-out splits (IFEval 270/271 of 541), paired
  differences clustered by question with 95% normal CI. It "does not measure wall-clock time or
  total compute, and it does not correct for multiple comparisons"
  ([alphaXiv](https://www.alphaxiv.org/abs/2611.09382)).
- Table 9 columns, one row per successful forward request: F (request number), Turn, Type (G
  generation or TF teacher forcing), Batch, Cap (token cap), Base and Edited correct counts, Δ pp,
  Intervention / purpose ([arXiv HTML](https://arxiv.org/html/2611.09382)). No checkpoint hash
  was found in the fetched page.
- Code repo [WSP-Scope-Project](https://github.com/WSP-Scope/WSP-Scope-Project) lists only a PDF.
- [Project page](https://wsp-scope.github.io): MATH-500 on Qwen3.5-0.8B "8.35% to 37.80%" from
  1,023 changed BF16 values in one MLP down-projection; "Development gains do not always hold up on
  unseen questions." Its 37.80% is a different setup from the Blog's 48.1% (inference).

**Other papers** ([arXiv API search](https://export.arxiv.org/api/query?search_query=all:%22weight-space%20programming%22),
14 results, abstracts only, each id not opened): several report limits. 2611.12066 (medical
imaging): "a same-architecture network trained on a few hundred labeled images performs better";
2611.09271 (games): "collapsed on multi-move plans"; 2611.11537 (quantum circuits): "fails in
opaque weight spaces with more than 30 weights"; 2611.08070 favors "local arithmetic plus dataset
priors" over reasoning about weights.

**LessWrong replication** ([GreaterWrong mirror](https://www.greaterwrong.com/posts/WnL4nWrS2owzZfwiz),
CCaptainX, 8 Nov 2026, code at github.com/CCaptainX/wsp-replication): reruns Exp 1 with controls
(anonymous channels, random weights). Astra 4/4, DeepSeek-V4.1-Flash 3/4; Flash leans on channel
labels and a Pac-Man prior; n = 15 per variant with Wilson 95% CIs.

**Critiques**, mostly quoted by one secondary blog
([buildmvpfast](https://www.buildmvpfast.com/blog/astra-weight-editing-qwen-misleading-rebuttal-2026)).
[HN search](https://hn.algolia.com/api/v1/search?query=weight-space%20programming) returns 38 hits;
the top one is "Can a Linear Program Do Weight-Space Programming?" (nathan.rs, 201 points, not
read). HN user schleck8: "ROME cannot look at thousands of ASCII numbers and deduce that it's
looking at a Breakout paddle" ([item](https://hn.algolia.com/api/v1/items/50351025)). Secondary
quotes:

- Matthew Honnibal: "Every experiment involving a real language model uses Python".
- Sean Goedecke: the loop fix is "the Heretic abliteration playbook". His post was not found.
  [Heretic](https://github.com/p-e-w/heretic) does "directional ablation (aka abliteration)",
  scored by refusal rate and KL divergence, and does not mention repetition or loops.
- HN user x313: "you can do this yourself in 4-8 hours".
- Simon Willison: "The paper combines two topics that I think deserve to be treated separately".
- Alex Krentsel: "there is no self-editing going on here, and this is on tiny models".

**Willison anecdote** ([letsdatascience](https://letsdatascience.com/news/willison-replicates-mit-weight-reading-test-on-laptop-with-q-3488f9da)):
Exp 1 Pac-Man on a laptop with a 17GB "Qwen 3.8 27B" through LM Studio and `llm`; "a single
anecdotal example". Kimi K3.1 Pro "guessed Breakout after 9m 41s and 19,493 reasoning tokens". The
model name looks odd and the secondary sources differ on details.

**The replication platform** ([docs](https://openresearch.sh/docs),
[repo](https://github.com/alphaXiv/OpenResearch)): "a local-first workspace for research agents";
"Each project is a git repository with a tree of experiments"; it "records every experiment in a
local SQL database". Agents: Claude Code, Codex, OpenCode, Cursor, Google Antigravity. "Run entirely
locally. We don't collect your code or agent traces." How it renders traces or activations is not
documented publicly.

No MCP server, tensor-editing tool or benchmark built for agent weight editing turned up in
searches (absence of evidence, four searches).

## Related research

alphaXiv links follow `https://www.alphaxiv.org/abs/<id>`. Only 2611.10866, 2202.05262,
2611.09382 and the overview of 2406.11717 were opened; the rest follow the pattern untested. The
alphaXiv search URL returned 404, so rows added later came from the
[arXiv API](https://export.arxiv.org/api/query?search_query=all:AlphaEdit) (searches for AlphaEdit,
PMET, abliteration, "neural functional", "model zoo"). Numbers are from the arXiv abstract or the
alphaXiv page.

| arXiv | alphaXiv | Method | Key numbers |
| --- | --- | --- | --- |
| [2611.10866](https://arxiv.org/abs/2611.10866) | [abs](https://www.alphaxiv.org/abs/2611.10866) | Deletion Tuning: learned keep/zero mask over MLP gate projections | Fewer than 0.05% of weights zeroed; mask "hundreds to thousands of times smaller" than the FFT checkpoint |
| [2611.09382](https://arxiv.org/abs/2611.09382) | [abs](https://www.alphaxiv.org/abs/2611.09382) | WSP-Scope: agent weight editing with a forward-pass tool | 1,023 parameters, +29.45 MATH-500; 6 of 16 trajectories kept the original weights |
| [2202.05262](https://arxiv.org/abs/2202.05262) | [abs](https://www.alphaxiv.org/abs/2202.05262) | ROME: rank-one edit of one mid-layer MLP, located by causal tracing | CounterFact, GPT-2 XL: 89.2 overall vs 66.9 for constrained fine-tuning |
| [2210.07229](https://arxiv.org/abs/2210.07229) | [abs](https://www.alphaxiv.org/abs/2210.07229) | MEMIT: many fact edits across several MLP layers | "thousands of associations" on GPT-J (6B) and GPT-NeoX (20B) |
| [2308.08742](https://arxiv.org/abs/2308.08742) | [abs](https://www.alphaxiv.org/abs/2308.08742) | PMET: precise model editing in a transformer (AAAI 2024) | None quoted |
| [2403.14236](https://arxiv.org/abs/2403.14236) | [abs](https://www.alphaxiv.org/abs/2403.14236) | EMMET: unifies ROME and MEMIT, batched edits with an equality constraint | "batched-edits up to a batch-size of 10,000" |
| [2410.02355](https://arxiv.org/abs/2410.02355) | [abs](https://www.alphaxiv.org/abs/2410.02355) | AlphaEdit: null-space constrained knowledge editing (ICLR 2025 Oral); reproduced in 2606.26783 | None quoted |
| [2406.11717](https://arxiv.org/abs/2406.11717) | [overview](https://www.alphaxiv.org/overview/2406.11717) | Refusal direction: ablate one residual direction; weight orthogonalization makes it permanent. The origin of abliteration; [Heretic](https://github.com/p-e-w/heretic) cites it | 13 chat models up to 72B; Qwen 14B HarmBench attack success 84.3% vs 83.5% GCG; Llama-3 70B MMLU 79.8 vs 79.9; TruthfulQA "consistently falls" |
| [2607.17427](https://arxiv.org/abs/2607.17427) | [abs](https://www.alphaxiv.org/abs/2607.17427) | "Abliteration Is Not a Scalpel": off-target effects of deleting a direction (id from the API, not opened) | None quoted |
| [2512.13655](https://arxiv.org/abs/2512.13655) | [abs](https://www.alphaxiv.org/abs/2512.13655) | Comparative analysis of abliteration methods | None quoted |
| [2310.01405](https://arxiv.org/abs/2310.01405) | [abs](https://www.alphaxiv.org/abs/2310.01405) | Representation Engineering: monitor and steer traits from population-level representations | None in abstract |
| [2308.10248](https://arxiv.org/abs/2308.10248) | [abs](https://www.alphaxiv.org/abs/2308.10248) | ActAdd: steering vector from one contrasting prompt pair | None in abstract |
| [2312.06681](https://arxiv.org/abs/2312.06681) | [abs](https://www.alphaxiv.org/abs/2312.06681) | CAA: mean residual difference over paired examples, added at inference (Llama 2) | None in abstract |
| [2212.04089](https://arxiv.org/abs/2212.04089) | [abs](https://www.alphaxiv.org/abs/2212.04089) | Task arithmetic: add or negate fine-tuned minus base weights | None in abstract |
| [2306.01708](https://arxiv.org/abs/2306.01708) | [abs](https://www.alphaxiv.org/abs/2306.01708) | TIES-Merging: trim, elect sign, merge | None in abstract |
| [2311.03099](https://arxiv.org/abs/2311.03099) | [abs](https://www.alphaxiv.org/abs/2311.03099) | DARE: drop and rescale delta parameters before merging | Drops "90% or even 99%" of delta parameters |
| [1803.03635](https://arxiv.org/abs/1803.03635) | [abs](https://www.alphaxiv.org/abs/1803.03635) | Lottery Ticket Hypothesis | Subnetworks "less than 10-20% of the size" train well |
| [2306.11695](https://arxiv.org/abs/2306.11695) | [abs](https://www.alphaxiv.org/abs/2306.11695) | Wanda: prune by weight × input norm, no retraining; Deletion Tuning's mask init | None quoted |
| [2503.22764](https://arxiv.org/abs/2503.22764) | [abs](https://www.alphaxiv.org/abs/2503.22764) | Mask Fine-Tuning: binary mask over a fine-tuned LLM | IFEval +2.70 / +4.15 on LLaMA2-7B / 3.1-8B |
| [1609.09106](https://arxiv.org/abs/1609.09106) | [abs](https://www.alphaxiv.org/abs/1609.09106) | HyperNetworks: one network generates another's weights | None quoted |
| [2301.12780](https://arxiv.org/abs/2301.12780) | [abs](https://www.alphaxiv.org/abs/2301.12780) | Equivariant layers that take raw MLP weights as input (Navon et al., ICML 2023) | None quoted |
| [2302.14040](https://arxiv.org/abs/2302.14040) | [abs](https://www.alphaxiv.org/abs/2302.14040) | Permutation-equivariant neural functionals: networks that "process the weights or gradients of other neural networks" | None quoted |
| [2305.13546](https://arxiv.org/abs/2305.13546) | [abs](https://www.alphaxiv.org/abs/2305.13546) | Neural functional transformers | None quoted |
| [2410.04209](https://arxiv.org/abs/2410.04209) | [abs](https://www.alphaxiv.org/abs/2410.04209) | Equivariant neural functionals for transformer weights (closest to Exp 3) | None quoted |
| [2209.14764](https://arxiv.org/abs/2209.14764) | [abs](https://www.alphaxiv.org/abs/2209.14764) | Model Zoos: a dataset of trained network populations | None quoted |
| [2504.10231](https://arxiv.org/abs/2504.10231) | [abs](https://www.alphaxiv.org/abs/2504.10231) | A model zoo of vision transformers | None quoted |
| [2506.06105](https://arxiv.org/abs/2506.06105) | [abs](https://www.alphaxiv.org/abs/2506.06105) | Text-to-LoRA: hypernetwork makes a LoRA from a task description | Trained on 9 LoRA adapters |
| [2102.11174](https://arxiv.org/abs/2102.11174) | [abs](https://www.alphaxiv.org/abs/2102.11174) | Linear attention as fast weight programmers (cited by the Blog) | None quoted |
| [2301.05062](https://arxiv.org/abs/2301.05062) | [abs](https://www.alphaxiv.org/abs/2301.05062) | Tracr: compile programs into transformer weights (cited by the Blog) | None quoted |
| [2309.03409](https://arxiv.org/abs/2309.03409) | [abs](https://www.alphaxiv.org/abs/2309.03409) | OPRO: LLM as optimizer over prompts | Up to 8% over human prompts on GSM8K, up to 50% on Big-Bench Hard |
| [2310.12931](https://arxiv.org/abs/2310.12931) | [abs](https://www.alphaxiv.org/abs/2310.12931) | Eureka: LLM writes reward code | Beats human rewards on 83% of tasks, 52% mean normalized improvement, 29 environments |
| [2509.04259](https://arxiv.org/abs/2509.04259) | [abs](https://www.alphaxiv.org/abs/2509.04259) | RL's Razor: KL to base on the new task predicts forgetting | None in abstract |

Among these, only the Blog and WSP-Scope have an LLM edit weights. The rest edit with an algorithm
or learn masks with gradients (inference from the papers read). The Blog has no reference list;
its links are Software 2.0, 2102.11174 and 2301.05062, and it never names ROME, abliteration or
neural functionals ([Blog](https://rikiyat.github.io/blog/weight-space-programming/)). zsRE is named
on the ROME abstract, and CounterFact is described there as "a new dataset of counterfactual
assertions" ([2202.05262](https://arxiv.org/abs/2202.05262)).

Inference: the Exp 8 edit (subtract one direction from MLP output columns) has the same form as
abliteration, so the 2406.11717 line backs the critique's reading. No fetched source links loop
removal to that line, and no abliteration abstract read mentions loops.

## Deletion Tuning

[arXiv 2611.10866](https://arxiv.org/abs/2611.10866): "The Surprising Effectiveness of Deleting
Weights in LLM Post-Training". Lu, Yang, Lasby, Pote, Ioannou, Ren (NYU and University of Calgary
per [alphaXiv](https://www.alphaxiv.org/abs/2611.10866)). Submitted 7 Nov 2026, comment
"NeurIPS 2026". The [NeurIPS poster](https://neurips.cc/virtual/2026/poster/154971) titles it "…in
LLM Reasoning and Adaptation" and calls the method Bit-Mask Tuning (BMT). The
[project page](https://agenticlearning.ai/deleting-weights/) calls it Deletion Tuning and links code
at github.com/agentic-learning-ai-lab/deleting-weights. No OpenReview or checkpoint link is on it.

- Claim: "zeroing fewer than 0.05% of its weights, with no other modification, matches full
  fine-tuning (FFT) at scale" ([arXiv](https://arxiv.org/abs/2611.10866)). The pasted post says
  "<0.1%".
- Method ([HTML](https://arxiv.org/html/2611.10866)): the mask covers "the gate projection of
  transformer blocks"; one trainable logit per weight; positive keeps, negative zeroes; alpha ramps
  10^3 → 10^4 for GRPO (10^2 → 10^3 for SFT); Wanda-based init (about 0.18% zeroed at init);
  lambda 10^-5 for SFT and GRPO, 0 for SDFT.
- Share deleted: "0.035% to 0.046% across the GRPO runs"; "about 0.03 bits per target weight after
  compression" ([HTML](https://arxiv.org/html/2611.10866)).
- Settings: GRPO on GSM8K (Llama 1B/3B/8B), GRPO on a six-benchmark SimpleRL-Zoo mean (Qwen
  0.5B/3B/7B/14B and Qwen3-30B-A3B), SFT on MMLU-Pro and BBEH (Llama 1B/3B), SDFT on ToolAlpaca and
  Science (Qwen 7B).

Mask size versus the FFT checkpoint ([HTML](https://arxiv.org/html/2611.10866),
[alphaXiv](https://www.alphaxiv.org/abs/2611.10866)):

| Model | Mask | FFT checkpoint |
| --- | --- | --- |
| Llama 1B / 3B / 8B | 1.0 / 3.1 / 8.4 MB | 4,714 / 12,256 / 30,633 MB |
| Qwen 0.5B / 3B / 7B | 0.5 / 2.7 / 6.9 MB | 1,885 / 11,772 / 29,051 MB |
| Qwen3-30B-A3B | 29.6 MB | 116,471 MB |

Accuracy, base / FFT / DT. Every row matches the
[project page](https://agenticlearning.ai/deleting-weights/) and the earlier
[HTML](https://arxiv.org/html/2611.10866) fetch. The PDF fetch returned compressed binary, so no
row is checked against the PDF.

| Setting | Base | FFT | DT |
| --- | --- | --- | --- |
| GRPO Llama 1B, GSM8K | 1.21 | 60.50 | 54.44 |
| GRPO Llama 3B, GSM8K | 53.53 | 82.49 | 81.49 |
| GRPO Llama 8B, GSM8K | 60.27 | 83.24 | 83.55 |
| GRPO Qwen 0.5B, SimpleRL-Zoo mean | 10.44 | 19.01 | 17.64 |
| GRPO Qwen 3B | 37.73 | 44.35 | 41.98 |
| GRPO Qwen 7B | 40.18 | 51.89 | 52.32 |
| GRPO Qwen 14B | 44.37 | 54.87 | 55.43 |
| GRPO Qwen3-30B-A3B | 49.41 | 58.43 | 58.54 |
| SFT Llama 1B / 3B, MMLU-Pro | 10.37 / 12.63 | 16.97 / 21.19 | 18.62 / 22.28 |
| SDFT Qwen 7B, ToolAlpaca / Science | 41.24 / 32.35 | 68.04 / 71.20 | 69.07 / 70.61 |

Inference: "matches FFT" holds from about 7–8B up; at 1B DT trails by about 6 points.

Forgetting ([arXiv](https://arxiv.org/abs/2611.10866), [HTML](https://arxiv.org/html/2611.10866)):
at step 348, FFT forward KL to base is about 1.0 (Llama 1B) and 1.5 (8B), with prior-task accuracy
1.3 to 3.1 points below base. DT forward KL is at most 0.05, within one point of base. "FFT, LoRA,
and random sparse fine-tuning lose up to 5.4 points." Continual learning across a task sequence is
"proposed by the authors as a next test, not shown" ([alphaXiv](https://www.alphaxiv.org/abs/2611.10866)).

Caveats from [alphaXiv](https://www.alphaxiv.org/abs/2611.10866): training uses "less memory than
FFT but more than LoRA"; no faster training or generation is reported; a no-training Wanda
baseline gains little (Qwen 7B base 40.18%, best Wanda 42.49%, DT 52.32%).

How it relates: Deletion Tuning learns its mask with gradients. It is not agent-driven editing. It
matters here because it records the same things a weight-edit run should: share of weights
changed, artifact size, target metric, and forgetting against base.

## Open questions

- The replication numbers (4,813 weights, 0/1,024 → 1,024/1,024, Breakout 309.9, MATH-500 34.4%)
  are only in the user's post. Checking them needs the 840.4 MiB `.orx` file or the app. Which agent
  and model ran the replication is not stated publicly. What the 11 experiments are is unknown.
- Exps 5 and 7 in the logs repo were not sampled; Exp 6 and 8 run folders were read only through
  their READMEs and eval files.
- Which model ran each experiment: `gpt-6-astra` (README, `run.json`) or `gpt-6-luna`
  (`harness/codex_config.toml`)?
- Is `s` in `tool_calls.jsonl` (and in `scores.json`, 505 for shard 0) a duration in seconds?
- Exp 8: accuracy among answers that finish needs per-sample finish flags (not published). Base at
  presence penalty 2.0, at temperature 1.0, and with thinking off. How the 50-pass replication's
  34.4% was sampled (4 per problem, 32,768 tokens?) decides whether it is comparable to 48.1%.
- How Exps 1, 2 and 5 serialized weights as text. Exp 4 writes each tensor "as integers times one
  scale, 3 significant digits of the tensor's largest entry"
  ([Exp 4 log](https://raw.githubusercontent.com/RikiyaT/lm_understand-logs/main/exp4_fix_car/README.md)).
- Deletion Tuning: no row checked against the PDF; checkpoints not found; the user's "<0.1%" vs the
  page's "fewer than 0.05%".
- Unfetched leads: the honnibal.dev critique, the nathan.rs LP post and its HN thread, the
  CCaptainX code, 4 of the 14 arXiv API hits, the "Debunked" post on besthub.dev, Goedecke's post.
- Primary zsRE (Levy et al. 2017) and CounterFact definitions; policy-writing work beyond Eureka.
