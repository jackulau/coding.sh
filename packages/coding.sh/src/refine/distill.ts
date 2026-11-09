// `refine distill` (AD-3, CASD after arXiv 2609.26261): a coding agent gets the
// run corpus (src/refine/corpus.ts) and the current harness, analyzes it with
// its own code, and writes one skill, out/SKILL.md. Each draw runs in its own
// temp directory with an empty-bundle overlay, so the user's agent config is
// untouched. The skill becomes a refine candidate: the critics and a size cap
// check it, it is ledgered as proposed, and only `refine test` can keep it.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, HarnessBundle } from "../core/types.ts";
import { runCritics } from "./critics.ts";
import type { CorpusResult } from "./corpus.ts";
import { appendLedger, saveCandidate, sha, type ProposeEntry } from "./ledger.ts";
import { candidateId } from "./propose.ts";
import type { HarnessText } from "./protect.ts";

export const MAX_SKILL_LINES = 160;
export const MAX_SKILL_BYTES = 10 * 1024;
export const MIN_EPISODES = 20;
export const MIN_FAILURES = 5;
export const DISTILL_TIMEOUT_MS = 20 * 60_000;

/** The fixed instruction every draw gets. */
export const DISTILL_BRIEF = `You are improving the instructions of an AI coding agent from a corpus of its earlier runs.

The corpus is in ./corpus: read corpus/SCHEMA.md first. corpus/episodes.jsonl has one row per episode with its outcome, corpus/tool_calls.jsonl one row per tool call, corpus/episodes/<episode>/transcript.md the full timeline of each episode, and corpus/prompt/ the instructions the agent runs with now. Do not edit anything under corpus/.

Analyze the corpus yourself, with code you write and run. There are no precomputed summaries. Before you read single episodes, measure:
- the pass rate, and how failing episodes fail and end;
- tool use: which tools, how often they fail, and how many calls exactly duplicate an earlier input (inputSha);
- differences between task categories (tags), harnesses (bundle) and models.
Then read the episodes behind the largest failure modes to see what went wrong.

Write exactly one file, out/SKILL.md: a skill for this agent that would have prevented the failures you measured.
- Start with YAML frontmatter holding name (lowercase letters, digits and hyphens) and description (one sentence saying when to use the skill).
- Give each rule the number behind it from your analysis, for example "12 of 30 failing episodes ended without running the tests".
- Write general rules only: no task ids, episode ids, file paths or strings that appear in a single episode.
- Never tell the agent to weaken, skip, delete or edit tests, checks or verifiers.
- At most ${MAX_SKILL_LINES} lines and ${MAX_SKILL_BYTES} bytes.
Write nothing else outside out/.`;

export interface SkillDoc {
  name: string;
  description: string;
  text: string;
}

/** The frontmatter of a SKILL.md, or why it is unusable. */
export function parseSkill(text: string): SkillDoc | { error: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { error: "out/SKILL.md has no YAML frontmatter (--- name: … description: … ---)" };
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+?)\\s*$`, "m").exec(m[1]!)?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
  const name = field("name");
  const description = field("description");
  if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return { error: `out/SKILL.md's frontmatter needs a name of lowercase letters, digits and hyphens${name ? `, got ${JSON.stringify(name)}` : ""}` };
  if (!description) return { error: "out/SKILL.md's frontmatter needs a description" };
  return { name, description, text };
}

export interface DistillRejection {
  critic: string;
  reason: string;
}

/** The size cap, then the harmless and duplicate critics on the new skill. */
export function checkSkill(base: readonly HarnessText[], file: HarnessText): DistillRejection[] {
  const out: DistillRejection[] = [];
  const lines = file.text.replace(/\n$/, "").split(/\r?\n/).length;
  const bytes = Buffer.byteLength(file.text);
  if (lines > MAX_SKILL_LINES || bytes > MAX_SKILL_BYTES) out.push({ critic: "cap", reason: `the skill is ${lines} lines and ${bytes} bytes; the cap is ${MAX_SKILL_LINES} lines and ${MAX_SKILL_BYTES} bytes` });
  const after = [...base.filter((f) => f.path !== file.path), file];
  for (const r of runCritics(base, after).rejections) out.push({ critic: r.critic, reason: r.reason });
  return out;
}

export interface DistillDraw {
  draw: number;
  cwd: string;
  /** Why the draw gave no candidate (agent failed, no out/SKILL.md, bad frontmatter). */
  error?: string;
  skill?: SkillDoc;
  /** Set when the draw gave a skill: the candidate and its repo path. */
  candidate?: { id: string; file: HarnessText };
  rejections: DistillRejection[];
  costUsd?: number;
  durationMs: number;
}

export interface DistillOptions {
  corpusDir: string;
  adapter: Pick<Adapter, "id" | "run" | "overlay">;
  model?: string;
  n?: number;
  timeoutMs?: number;
  /** Stop starting draws once their cost reaches this. */
  maxCostUsd?: number;
  /** Where each draw's temp directory goes. */
  workRoot: string;
  /** The repo's current harness files: the critics compare against them. */
  base: readonly HarnessText[];
  /** The skills directory of the agent the skill is for (.claude/skills, .agents/skills). */
  skillsDir: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  runId?: (draw: number) => string;
}

/** An empty bundle: the overlay sets up an isolated config without laying any harness file. */
const emptyBundle = (agent: string): HarnessBundle => ({ id: "distill-empty", name: "distill", agent, flags: [], env: {}, files: {}, remove: [], createdAt: 0 }) as unknown as HarnessBundle;

/** Runs `n` independent draws, one after another, inside the cost cap. */
export async function distill(o: DistillOptions): Promise<{ draws: DistillDraw[]; spentUsd: number; stopped?: "budget" | "interrupted" }> {
  if (!o.adapter.run) throw new Error(`Agent ${o.adapter.id} has no headless driver, so it can't distill`);
  const draws: DistillDraw[] = [];
  let spent = 0;
  mkdirSync(o.workRoot, { recursive: true });
  for (let i = 1; i <= (o.n ?? 1); i++) {
    if (o.signal?.aborted) return { draws, spentUsd: spent, stopped: "interrupted" };
    if (o.maxCostUsd !== undefined && spent >= o.maxCostUsd) return { draws, spentUsd: spent, stopped: "budget" };
    const cwd = mkdtempSync(join(o.workRoot, `draw-${i}-`));
    cpSync(o.corpusDir, join(cwd, "corpus"), { recursive: true });
    mkdirSync(join(cwd, "out"), { recursive: true });
    // The overlay's isolated home sits next to the draw's cwd, never inside it.
    const home = `${cwd}-home`;
    mkdirSync(home, { recursive: true });
    const overlay = o.adapter.overlay ? await o.adapter.overlay(emptyBundle(o.adapter.id), cwd, { workDir: cwd, runRoot: cwd, home }) : { env: {}, flags: [] };
    const started = Date.now();
    const out = await o.adapter.run({ cwd, instruction: DISTILL_BRIEF, ...(o.model ? { model: o.model } : {}), env: { ...(o.env ?? {}), ...overlay.env }, timeoutMs: o.timeoutMs ?? DISTILL_TIMEOUT_MS, flags: overlay.flags, runId: o.runId?.(i) ?? `distill-${i}` });
    const cost = out.usage?.costUsd;
    if (cost !== undefined) spent += cost;
    const d: DistillDraw = { draw: i, cwd, rejections: [], ...(cost !== undefined ? { costUsd: cost } : {}), durationMs: out.durationMs || Date.now() - started };
    draws.push(d);
    const file = join(cwd, "out", "SKILL.md");
    if (!existsSync(file) || !statSync(file).isFile()) {
      d.error = `the distiller wrote no out/SKILL.md${out.timedOut ? " (it ran out of time)" : out.exitCode ? ` (it exited ${out.exitCode}: ${(out.stderrTail || out.stdoutTail).trim().slice(-300)})` : ""}`;
      continue;
    }
    const skill = parseSkill(readFileSync(file, "utf8"));
    if ("error" in skill) {
      d.error = skill.error;
      continue;
    }
    d.skill = skill;
    const f = { path: `${o.skillsDir.replace(/\/+$/, "")}/${skill.name}/SKILL.md`, text: skill.text };
    d.candidate = { id: candidateId([f]), file: f };
    d.rejections = checkSkill(o.base, f);
  }
  return { draws, spentUsd: spent };
}

/**
 * Saves each draw's skill as a stored candidate and appends one `propose`
 * entry per skill: proposed when the cap and the critics pass, rejected when
 * not. A draw with no skill writes nothing.
 */
export function ledgerDraws(dir: string, draws: readonly DistillDraw[], x: { corpus: CorpusResult; source: string; distiller: string; model?: string; at?: string }): ProposeEntry[] {
  const out: ProposeEntry[] = [];
  for (const d of draws) {
    if (!d.candidate || !d.skill) continue;
    const ok = !d.rejections.length;
    saveCandidate(dir, { id: d.candidate.id, files: [d.candidate.file], source: "proposal", proposer: "distill", rationale: `distilled from ${x.corpus.episodes} episodes (${x.corpus.failures} failing): ${d.skill.description}` });
    const e: ProposeEntry = {
      op: "propose",
      id: d.candidate.id,
      at: x.at ?? new Date().toISOString(),
      proposer: "distill",
      files: [{ path: d.candidate.file.path, sha: sha(d.candidate.file.text) }],
      verdict: ok ? "proposed" : "rejected",
      reasons: d.rejections.map((r) => (r.reason.startsWith(`${r.critic}:`) ? r.reason : `${r.critic}: ${r.reason}`)),
      provenance: {
        corpusEpisodes: x.corpus.episodes,
        failures: x.corpus.failures,
        passRate: x.corpus.passRate,
        source: x.source,
        leftOut: x.corpus.leftOut.tasks,
        draw: d.draw,
        distiller: x.distiller,
        ...(x.model ? { model: x.model } : {}),
        ...(d.costUsd !== undefined ? { costUsd: d.costUsd } : {}),
        durationMs: d.durationMs,
      },
    };
    appendLedger(dir, e);
    out.push(e);
  }
  return out;
}

/** Why the corpus is too small to learn from, or undefined. */
export function preflight(c: Pick<CorpusResult, "episodes" | "failures">, min: { episodes?: number; failures?: number } = {}): string | undefined {
  const me = min.episodes ?? MIN_EPISODES;
  const mf = min.failures ?? MIN_FAILURES;
  if (c.episodes < me) return `the corpus has ${c.episodes} episode${c.episodes === 1 ? "" : "s"}; distilling needs at least ${me}`;
  if (c.failures < mf) return `the corpus has ${c.failures} failing or flagged episode${c.failures === 1 ? "" : "s"}; distilling needs at least ${mf} to learn from`;
  return undefined;
}
