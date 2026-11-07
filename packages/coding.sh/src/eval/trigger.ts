// Skill activation evals (`coding.sh eval trigger`): does the agent load a skill
// when it should, and leave it alone when it shouldn't? A skill's description is
// the routing layer, so this is what a description edit changes first.
//
// A spec (triggers.toml next to SKILL.md) lists should and should_not prompts.
// Each prompt runs k times per arm, in a fresh empty repo with the skill (and its
// sibling skills, which compete for the same prompts) installed in the agent's
// project skills dir. Whether a run loaded the skill comes from the captured
// session through core/skills-use.ts (the Skill tool, a read of SKILL.md, a
// script run), falling back to the agent's stream-json stdout.
//
// Per arm: TP/FP/TN/FN raw and weighted (medium-confidence prompts weigh 0.5),
// precision, recall, F1, accuracy, Wilson intervals on recall and the false
// trigger rate, per-prompt x/k with flaky prompts, and routes to other skills.
// Two arms (the skill and a candidate description or dir): a paired bootstrap
// over prompts of the per-prompt accuracy delta, McNemar at k=1, and the prompts
// whose majority answer flipped (microsoft/waza trigger tests; waza runs k=1,
// counts an errored run as wrong and can't compare descriptions).
//
// A run that errored (setup failure, no session, or a timeout or a failed exit
// before the skill loaded) is not an answer: it is counted and left out of every
// metric. A run that loaded the skill and then timed out did answer.
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sha256Hex, sortableId } from "../core/ids.ts";
import { skillUse } from "../core/skills-use.ts";
import { parseToml, TomlError, type TomlTable, type TomlValue } from "../core/toml.ts";
import type { Adapter, AgentEvent, AgentId, BlobRef, BlobStore, EvalTask, HarnessBundle, IndexStore, RunResult } from "../core/types.ts";
import { traceFromText } from "../judge/trace-file.ts";
import { bundleId, collect } from "../runner/bundle.ts";
import { loadRunSessions, pool } from "../runner/experiment.ts";
import type { SnapshotOps } from "../runner/git.ts";
import { runLayout, runTask } from "../runner/run.ts";
import { SCHEMA_VERSION, type EventKind } from "../schema/index.ts";
import { pairedBootstrap, wilson, type BootstrapResult, type Interval } from "../stats/interval.ts";
import { mulberry32 } from "../stats/prng.ts";
import { mcnemarPaired, type McNemarResult } from "../stats/tests.ts";

// ------------------------------------------------------------ spec

export type TriggerSide = "should" | "should_not";

export interface TriggerPrompt {
  prompt: string;
  /** 1 (high confidence) or 0.5 (medium). */
  weight: number;
  note?: string;
  /** should_not only: the sibling skill this prompt belongs to. Loading it is the expected route. */
  expectSkill?: string;
}

export interface TriggerSpec {
  /** Skill name (default: the SKILL.md frontmatter name). */
  skill?: string;
  k: number;
  timeoutS: number;
  should: TriggerPrompt[];
  shouldNot: TriggerPrompt[];
}

export const TRIGGER_DEFAULTS = { k: 3, timeoutS: 120 } as const;
/** Fewer prompts than this per side: only large differences can show. */
export const TRIGGER_MIN_PROMPTS = 10;

export class TriggerSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerSpecError";
  }
}

const TOP_KEYS = new Set(["skill", "k", "timeout_s", "should", "should_not"]);
const ITEM_KEYS: Record<TriggerSide, Set<string>> = { should: new Set(["prompt", "weight", "note"]), should_not: new Set(["prompt", "weight", "note", "expect_skill"]) };

const isTable = (v: TomlValue | undefined): v is TomlTable => typeof v === "object" && v !== null && !Array.isArray(v);
const normPrompt = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Parses a triggers.toml. Errors name the file and the key. */
export function parseTriggerSpec(text: string, file = "triggers.toml"): TriggerSpec {
  let t: TomlTable;
  try {
    t = parseToml(text, file);
  } catch (e) {
    throw new TriggerSpecError(e instanceof TomlError ? e.message : `${file}: ${(e as Error).message}`);
  }
  const fail = (key: string, msg: string): never => {
    throw new TriggerSpecError(`${file}: ${key}: ${msg}`);
  };
  for (const k of Object.keys(t)) if (!TOP_KEYS.has(k)) fail(k, `unknown key (expected ${[...TOP_KEYS].join(", ")})`);
  const skill = t.skill;
  if (skill !== undefined && (typeof skill !== "string" || !skill.trim())) fail("skill", "must be a non-empty string");
  const int = (key: string, d: number, max: number): number => {
    const v = t[key];
    if (v === undefined) return d;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) fail(key, `must be an integer from 1 to ${max}`);
    return v as number;
  };
  const seen = new Map<string, string>();
  const side = (name: TriggerSide): TriggerPrompt[] => {
    const v = t[name];
    if (v === undefined) fail(name, `missing: add at least one [[${name}]] table with a prompt`);
    if (!Array.isArray(v) || !v.length || !v.every(isTable)) fail(name, `must be a non-empty list of [[${name}]] tables`);
    return (v as TomlTable[]).map((item, i) => {
      const at = `${name}[${i}]`;
      for (const k of Object.keys(item)) if (!ITEM_KEYS[name].has(k)) fail(`${at}.${k}`, `unknown key (expected ${[...ITEM_KEYS[name]].join(", ")})`);
      const prompt = item.prompt;
      if (typeof prompt !== "string" || !prompt.trim()) fail(`${at}.prompt`, "must be a non-empty string");
      const weight = item.weight ?? 1;
      if (weight !== 1 && weight !== 0.5) fail(`${at}.weight`, "must be 1 (high confidence) or 0.5 (medium)");
      const note = item.note;
      if (note !== undefined && typeof note !== "string") fail(`${at}.note`, "must be a string");
      const expect = item.expect_skill;
      if (expect !== undefined && (typeof expect !== "string" || !expect.trim())) fail(`${at}.expect_skill`, "must be a skill name");
      const key = normPrompt(prompt as string);
      const prev = seen.get(key);
      if (prev) fail(`${at}.prompt`, `duplicates ${prev}`);
      seen.set(key, at);
      return { prompt: (prompt as string).trim(), weight: weight as number, ...(note ? { note: note as string } : {}), ...(expect ? { expectSkill: (expect as string).trim() } : {}) };
    });
  };
  const should = side("should");
  const shouldNot = side("should_not");
  if (typeof skill === "string" && shouldNot.some((p) => p.expectSkill === skill.trim())) fail("should_not", `expect_skill names the skill under test (${skill})`);
  return { ...(typeof skill === "string" ? { skill: skill.trim() } : {}), k: int("k", TRIGGER_DEFAULTS.k, 50), timeoutS: int("timeout_s", TRIGGER_DEFAULTS.timeoutS, 3600), should, shouldNot };
}

// ------------------------------------------------------------ SKILL.md

const FM = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const KEY_LINE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;

interface FmField {
  key: string;
  /** Line range [from, to) inside the frontmatter body. */
  from: number;
  to: number;
  value: string;
}

/** Top-level `key: value` fields of a YAML frontmatter body: plain, quoted, folded (>) and literal (|) scalars. */
function fmFields(body: string): { lines: string[]; fields: FmField[] } {
  const lines = body.split(/\r?\n/);
  const fields: FmField[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = KEY_LINE.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && (/^[ \t]/.test(lines[j]!) || (lines[j]!.trim() === "" && j + 1 < lines.length && /^[ \t]/.test(lines[j + 1]!)))) j++;
    const cont = lines.slice(i + 1, j);
    fields.push({ key: m[1]!, from: i, to: j, value: scalar(m[2]!.trim(), cont) });
    i = j - 1;
  }
  return { lines, fields };
}

function scalar(head: string, cont: string[]): string {
  const block = /^([>|])[+-]?$/.exec(head);
  if (block) {
    const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
    const body = cont.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
    return (block[1] === ">" ? body.join(" ").replace(/\s+/g, " ") : body.join("\n")).trim();
  }
  const all = [head, ...cont.map((l) => l.trim())].filter(Boolean).join(" ");
  if (all.startsWith('"') && all.endsWith('"') && all.length > 1) {
    try {
      return JSON.parse(all) as string;
    } catch {
      return all.slice(1, -1);
    }
  }
  if (all.startsWith("'") && all.endsWith("'") && all.length > 1) return all.slice(1, -1).replace(/''/g, "'");
  return all;
}

/** The frontmatter fields of a SKILL.md (undefined without frontmatter). */
export function skillFrontmatter(text: string): Record<string, string> | undefined {
  const m = FM.exec(text);
  if (!m) return undefined;
  const out: Record<string, string> = {};
  for (const f of fmFields(m[1]!).fields) out[f.key] = f.value;
  return out;
}

/** SKILL.md text with only its frontmatter `description:` replaced (added when missing). */
export function withDescription(text: string, description: string): string {
  const m = FM.exec(text);
  if (!m) throw new Error("SKILL.md has no frontmatter (--- name/description ---) to put a description in");
  const { lines, fields } = fmFields(m[1]!);
  const line = `description: ${JSON.stringify(description.replace(/\s+/g, " ").trim())}`;
  const f = fields.find((x) => x.key === "description");
  if (f) lines.splice(f.from, f.to - f.from, line);
  else lines.push(line);
  const start = m[0].startsWith("﻿") ? "﻿" : "";
  const nl = m[0].includes("\r\n") ? "\r\n" : "\n";
  return `${start}---${nl}${lines.join(nl)}${nl}---${nl}${text.slice(m[0].length)}`;
}

export interface SkillSource {
  /** Frontmatter name, else the directory name. */
  name: string;
  description: string;
  dir: string;
  /** Repo-relative file → replacement text (a candidate description). */
  override?: Record<string, string>;
}

/** A skill directory (or its SKILL.md): name and description from the frontmatter. */
export async function readSkill(path: string): Promise<SkillSource> {
  const st = await stat(path).catch(() => undefined);
  if (!st) throw new Error(`no such skill: ${path}`);
  const dir = st.isDirectory() ? path : dirname(path);
  const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => undefined);
  if (text === undefined) throw new Error(`${dir} has no SKILL.md`);
  const fm = skillFrontmatter(text) ?? {};
  return { name: fm.name?.trim() || basename(dir), description: fm.description ?? "", dir };
}

/** Skill dirs next to `dir` (those with a SKILL.md), in name order: the skills it competes with for a prompt. */
export async function siblingSkills(parent: string, except: readonly string[]): Promise<SkillSource[]> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const out: SkillSource[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = join(parent, e.name);
    if (except.includes(dir)) continue;
    const s = await readSkill(dir).catch(() => undefined);
    if (s) out.push(s);
  }
  return out;
}

// ------------------------------------------------------------ probe bundles

/** Where each agent reads project skills from. Agents not listed read `.agents/skills`. */
export const PROJECT_SKILLS_DIR: Partial<Record<AgentId, string>> = { "claude-code": ".claude/skills", opencode: ".opencode/skills" };
export const skillsDirOf = (agent: AgentId): string => PROJECT_SKILLS_DIR[agent] ?? ".agents/skills";

/** Flags that end a probe soon after the routing decision. Claude Code: three turns are enough to load a skill. */
export const PROBE_FLAGS: Partial<Record<AgentId, string[]>> = { "claude-code": ["--max-turns", "3"] };

export interface ProbeBundleOpts {
  name: string;
  agent: AgentId;
  model?: string;
  /** Start from this bundle's files, flags, env and model (e.g. a stored `harness snapshot`). */
  base?: HarnessBundle;
  skills: readonly SkillSource[];
  blobs: BlobStore;
  now?: number;
}

/** A harness bundle with each skill's whole directory under the agent's project skills dir. */
export async function probeBundle(o: ProbeBundleOpts): Promise<HarnessBundle> {
  const root = skillsDirOf(o.agent);
  const files: Record<string, BlobRef> = {};
  const owned = o.skills.map((s) => `${root}/${s.name}/`);
  // A base that already holds one of these skills: its copy goes, so the arm runs exactly the given files.
  for (const [p, ref] of Object.entries(o.base?.files ?? {})) if (!owned.some((d) => p.startsWith(d))) files[p] = ref;
  for (const s of o.skills) {
    for (const rel of (await collect(s.dir, "")).sort()) {
      const text = s.override?.[rel];
      files[`${root}/${s.name}/${rel}`] = await o.blobs.put(text ?? (await readFile(join(s.dir, rel))));
    }
  }
  const sorted: Record<string, BlobRef> = {};
  for (const k of Object.keys(files).sort()) sorted[k] = files[k]!;
  const flags = [...(o.base?.flags ?? [])];
  const probe = PROBE_FLAGS[o.agent] ?? [];
  if (probe.length && !flags.includes(probe[0]!)) flags.push(...probe);
  const body = { name: o.name, agent: o.agent, model: o.model ?? o.base?.model, flags, env: { ...(o.base?.env ?? {}) }, files: sorted, remove: [...(o.base?.remove ?? [])] };
  return { id: bundleId(body), ...body, createdAt: o.now ?? Date.now(), note: "eval trigger probe" };
}

/** An in-memory task for one prompt: an empty start tree, no setup, a verifier that always passes (the answer is the trace). */
export function probeTask(prompt: string, start: EvalTask["start"]): EvalTask {
  return {
    id: `trigger_${sha256Hex(prompt).slice(0, 16)}`,
    name: `trigger: ${prompt.slice(0, 60)}`,
    status: "draft",
    start,
    instruction: prompt,
    setup: [],
    verifier: { command: "exit 0", hiddenFiles: {}, timeoutMs: 30_000 },
    tags: ["trigger"],
    createdAt: 0,
  };
}

// ------------------------------------------------------------ running

export interface TriggerArm {
  label: string;
  bundle: HarnessBundle;
}

export interface TriggerJob {
  arm: number;
  side: TriggerSide;
  index: number;
  attempt: number;
}

/**
 * Job order: prompts shuffled by `seed`, then per prompt the attempts, each attempt
 * running every arm back to back in a seeded order, so drift (rate limits, latency)
 * hits both arms alike. Same seed, same order.
 */
export function triggerJobs(spec: Pick<TriggerSpec, "should" | "shouldNot">, arms: number, k: number, seed = 1): TriggerJob[] {
  const rnd = mulberry32(seed);
  const prompts: { side: TriggerSide; index: number }[] = [...spec.should.map((_, index) => ({ side: "should" as const, index })), ...spec.shouldNot.map((_, index) => ({ side: "should_not" as const, index }))];
  for (let i = prompts.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [prompts[i], prompts[j]] = [prompts[j]!, prompts[i]!];
  }
  const jobs: TriggerJob[] = [];
  for (const p of prompts) {
    for (let attempt = 1; attempt <= k; attempt++) {
      const order = Array.from({ length: arms }, (_, a) => a);
      if (arms === 2 && rnd() < 0.5) order.reverse();
      for (const arm of order) jobs.push({ arm, side: p.side, index: p.index, attempt });
    }
  }
  return jobs;
}

/** What one probe run says. */
export interface ProbeOutcome {
  status: "ok" | "error";
  error?: string;
  /** Every skill the run used, in first-use order. */
  skills: string[];
  costUsd?: number;
  runId?: string;
  sessionId?: string;
}

export interface TriggerObservation extends TriggerJob, ProbeOutcome {
  /** The skill under test loaded. */
  triggered: boolean;
}

/** True when a used skill name is `skill` (or a plugin's `<plugin>:skill`). */
export const sameSkill = (used: string, skill: string): boolean => used === skill || used.endsWith(`:${skill}`);

/** The skills a run used, from its events (any order). */
export function skillsUsed(events: readonly AgentEvent[]): string[] {
  return [...new Set(skillUse(events).used.map((u) => u.name))];
}

export interface RunTriggerOpts {
  spec: TriggerSpec;
  skill: string;
  arms: readonly TriggerArm[];
  k: number;
  concurrency?: number;
  seed?: number;
  signal?: AbortSignal;
  runProbe: (job: TriggerJob, arm: TriggerArm, prompt: TriggerPrompt) => Promise<ProbeOutcome | undefined>;
  onProgress?: (done: number, total: number) => void;
}

export const promptOf = (spec: Pick<TriggerSpec, "should" | "shouldNot">, side: TriggerSide, index: number): TriggerPrompt => (side === "should" ? spec.should[index]! : spec.shouldNot[index]!);

/** Runs every job; a probe that returns undefined (cancelled) is no observation. */
export async function runTriggerEval(o: RunTriggerOpts): Promise<{ observations: TriggerObservation[]; cancelled: boolean; total: number }> {
  const jobs = triggerJobs(o.spec, o.arms.length, o.k, o.seed ?? 1);
  let done = 0;
  const settled = await pool(jobs, o.concurrency ?? 4, async (job) => {
    if (o.signal?.aborted) return undefined;
    const r = await o.runProbe(job, o.arms[job.arm]!, promptOf(o.spec, job.side, job.index));
    if (!r) return undefined;
    done++;
    o.onProgress?.(done, jobs.length);
    return { ...job, ...r, triggered: r.status === "ok" && r.skills.some((s) => sameSkill(s, o.skill)) } satisfies TriggerObservation;
  });
  const observations = settled.filter((x): x is TriggerObservation => x !== undefined);
  return { observations, cancelled: observations.length < jobs.length, total: jobs.length };
}

/** Where a probe's trace came from: the captured session, the agent's stdout, or nowhere. */
export type TraceSource = "session" | "stdout" | "none";

/**
 * A probe's outcome from its run and trace. No trace at all is an error. A run
 * that loaded the skill answered, even if it then timed out or exited non-zero;
 * one that did not load it answered only if it finished (or left a session).
 */
export function probeOutcome(r: Pick<RunResult, "id" | "sessionId" | "agent" | "error">, events: readonly AgentEvent[], skill: string, source: TraceSource): ProbeOutcome {
  const base = { runId: r.id, ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(typeof r.agent.usage?.costUsd === "number" ? { costUsd: r.agent.usage.costUsd } : {}) };
  if (source === "none") {
    const why = r.agent.timedOut ? "timed out" : r.agent.exitCode !== 0 && r.agent.exitCode !== null ? `exited ${r.agent.exitCode}` : (r.error ?? "no session captured");
    return { ...base, status: "error", error: `no trace (${why})`, skills: [] };
  }
  const skills = skillsUsed(events);
  if (skills.some((s) => sameSkill(s, skill))) return { ...base, status: "ok", skills };
  if (r.agent.timedOut) return { ...base, status: "error", error: "timed out before loading the skill", skills };
  if (source === "stdout" && r.agent.exitCode !== 0) return { ...base, status: "error", error: r.error ?? `exited ${r.agent.exitCode}`, skills };
  return { ...base, status: "ok", skills };
}

export interface DefaultProbeOpts {
  adapterFor: (bundle: HarnessBundle) => Adapter;
  blobs: BlobStore;
  index: IndexStore;
  /** The empty start tree every probe runs in. */
  start: EvalTask["start"];
  skill: string;
  timeoutMs: number;
  experimentId: string;
  /** Pulls the run's captured session into the index (before its dir is removed). */
  ingest?: () => Promise<unknown>;
  signal?: AbortSignal;
  env?: Record<string, string>;
  runsDir?: string;
  git?: SnapshotOps;
}

/** The agent's stream-json stdout as events (the trace when no session was captured). */
function stdoutEvents(stdout: string, agent: AgentId, sessionId: string): AgentEvent[] {
  return traceFromText(stdout).map((e, i) => ({ id: e.id, v: SCHEMA_VERSION, sessionId, ts: e.ts ?? i, agent, kind: e.kind as EventKind, payload: e.payload ?? {} }));
}

/**
 * Runs one prompt through the harness runner (src/runner/run.ts): a fresh work dir
 * and HOME, the arm's bundle and the adapter's isolated config with hooks, the agent
 * headless. The trace is the captured session (by CODING_SH_RUN_ID), else the
 * agent's stdout.
 */
export function defaultProbe(o: DefaultProbeOpts): RunTriggerOpts["runProbe"] {
  return async (job, arm, prompt) => {
    const runId = sortableId("run_");
    const layout = runLayout(runId, o.runsDir);
    let stdout = "";
    const r = await runTask({
      task: probeTask(prompt.prompt, o.start),
      bundle: arm.bundle,
      adapter: o.adapterFor(arm.bundle),
      blobs: o.blobs,
      index: o.index,
      attempt: job.attempt,
      experimentId: o.experimentId,
      timeoutMs: o.timeoutMs,
      runId,
      ...(o.runsDir ? { runsDir: o.runsDir } : {}),
      ...(o.env ? { env: o.env } : {}),
      ...(o.git ? { git: o.git } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      // Before the run dir goes: keep the agent's stdout, then ingest the session its hooks spooled.
      ingest: async () => {
        stdout = await readFile(join(layout.agent, "stdout"), "utf8").catch(() => "");
        await o.ingest?.();
      },
    });
    if (r.cancelled) return undefined;
    const session = (await loadRunSessions(o.index, [r])).get(r.id);
    const captured = session ? await o.index.listEvents(session.id) : [];
    const text = stdout || r.agent.stdoutTail;
    const source = captured.length ? "session" : text.trim() ? "stdout" : "none";
    const events = captured.length ? captured : stdoutEvents(text, arm.bundle.agent, runId);
    return probeOutcome({ ...r, ...(session ? { sessionId: session.id } : {}) }, events, o.skill, source);
  };
}

// ------------------------------------------------------------ scoring

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface TriggerMetrics {
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
}

export interface TriggerPromptRow {
  side: TriggerSide;
  index: number;
  prompt: string;
  weight: number;
  /** Runs that answered. */
  n: number;
  /** Of those, runs that loaded the skill. */
  triggered: number;
  errors: number;
  /** Some answered runs loaded the skill and some did not. */
  flaky: boolean;
  /** Share of answered runs that did what the side expects (NaN when none answered). */
  correct: number;
  /** Other skills loaded, with counts. */
  others: Record<string, number>;
  expectSkill?: string;
  /** should_not with expect_skill: runs that loaded the expected skill (and not this one). */
  expectHits?: number;
}

export interface TriggerArmScore {
  label: string;
  bundleId: string;
  raw: Confusion;
  weighted: Confusion;
  /** From the weighted counts (equal to raw when every weight is 1). */
  metrics: TriggerMetrics;
  rawMetrics: TriggerMetrics;
  /** Wilson 95% over runs: TP / (TP + FN). */
  recallCI: Interval;
  /** Wilson 95% over runs: FP / (FP + TN). */
  falseTriggerCI: Interval;
  runs: number;
  errors: number;
  errorReasons: Record<string, number>;
  prompts: TriggerPromptRow[];
  costUsd: number;
  unpriced: number;
}

export interface TriggerFlip {
  side: TriggerSide;
  index: number;
  prompt: string;
  /** Majority answer per arm: loaded the skill or not. */
  from: boolean;
  to: boolean;
  /** The flip made the answer right. */
  better: boolean;
}

export interface TriggerDelta {
  /** Prompts answered in both arms. */
  prompts: number;
  /** Mean per-prompt accuracy in A and B, and the paired bootstrap of B − A over prompts. */
  accuracyA: number;
  accuracyB: number;
  ci: BootstrapResult;
  /** k = 1: McNemar over prompts (B right where A was wrong, and the reverse). */
  mcnemar?: McNemarResult;
  flips: TriggerFlip[];
  /** Too few prompts per side for anything but a large change to show. */
  smallNote?: string;
  /** The CI lies wholly below 0. */
  regression: boolean;
  verdict: string;
}

export interface TriggerReport {
  skill: string;
  agent: AgentId;
  k: number;
  seed: number;
  arms: TriggerArmScore[];
  delta?: TriggerDelta;
  observations: TriggerObservation[];
}

const div = (a: number, b: number) => (b > 0 ? a / b : NaN);

export function triggerMetrics(c: Confusion): TriggerMetrics {
  const precision = div(c.tp, c.tp + c.fp);
  const recall = div(c.tp, c.tp + c.fn);
  const f1 = c.tp === 0 && c.fp + c.fn > 0 ? 0 : div(2 * c.tp, 2 * c.tp + c.fp + c.fn);
  return { precision, recall, f1, accuracy: div(c.tp + c.tn, c.tp + c.tn + c.fp + c.fn) };
}

/** Whether one answered run did what its side expects. */
const rightAnswer = (o: Pick<TriggerObservation, "side" | "triggered">) => (o.side === "should" ? o.triggered : !o.triggered);

function scoreArm(spec: TriggerSpec, arm: TriggerArm, armIdx: number, obs: readonly TriggerObservation[], skill: string): TriggerArmScore {
  const raw: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const weighted: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const errorReasons: Record<string, number> = {};
  let costUsd = 0;
  let unpriced = 0;
  const mine = obs.filter((o) => o.arm === armIdx);
  const prompts: TriggerPromptRow[] = [];
  for (const side of ["should", "should_not"] as const) {
    (side === "should" ? spec.should : spec.shouldNot).forEach((p, index) => {
      const runs = mine.filter((o) => o.side === side && o.index === index);
      const ok = runs.filter((o) => o.status === "ok");
      const others: Record<string, number> = {};
      let expectHits = 0;
      for (const o of ok) {
        for (const s of o.skills) if (!sameSkill(s, skill)) others[s] = (others[s] ?? 0) + 1;
        if (p.expectSkill && !o.triggered && o.skills.some((s) => sameSkill(s, p.expectSkill!))) expectHits++;
        const cell: keyof Confusion = side === "should" ? (o.triggered ? "tp" : "fn") : o.triggered ? "fp" : "tn";
        raw[cell]++;
        weighted[cell] += p.weight;
      }
      for (const o of runs) {
        if (o.status === "error") errorReasons[o.error ?? "error"] = (errorReasons[o.error ?? "error"] ?? 0) + 1;
        if (typeof o.costUsd === "number") costUsd += o.costUsd;
        else unpriced++;
      }
      const triggered = ok.filter((o) => o.triggered).length;
      prompts.push({
        side,
        index,
        prompt: p.prompt,
        weight: p.weight,
        n: ok.length,
        triggered,
        errors: runs.length - ok.length,
        flaky: triggered > 0 && triggered < ok.length,
        correct: div(ok.filter(rightAnswer).length, ok.length),
        others,
        ...(p.expectSkill ? { expectSkill: p.expectSkill, expectHits } : {}),
      });
    });
  }
  const runs = raw.tp + raw.fp + raw.tn + raw.fn;
  return {
    label: arm.label,
    bundleId: arm.bundle.id,
    raw,
    weighted,
    metrics: triggerMetrics(weighted),
    rawMetrics: triggerMetrics(raw),
    recallCI: wilson(raw.tp, raw.tp + raw.fn),
    falseTriggerCI: wilson(raw.fp, raw.fp + raw.tn),
    runs,
    errors: mine.length - runs,
    errorReasons,
    prompts,
    costUsd,
    unpriced,
  };
}

const majority = (r: TriggerPromptRow): boolean | undefined => (r.n === 0 || r.triggered * 2 === r.n ? undefined : r.triggered * 2 > r.n);
const pp = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)} pp`;
const ppNum = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}`;

function deltaOf(spec: TriggerSpec, a: TriggerArmScore, b: TriggerArmScore, k: number, seed: number): TriggerDelta {
  const pairs = a.prompts.map((ra, i) => [ra, b.prompts[i]!] as const).filter(([ra, rb]) => ra.n > 0 && rb.n > 0);
  const diffs = pairs.map(([ra, rb]) => rb.correct - ra.correct);
  const ci = pairedBootstrap(diffs, { seed });
  const accuracyA = pairs.length ? pairs.reduce((s, [ra]) => s + ra.correct, 0) / pairs.length : NaN;
  const accuracyB = pairs.length ? pairs.reduce((s, [, rb]) => s + rb.correct, 0) / pairs.length : NaN;
  const mcnemar = k === 1 && pairs.length ? mcnemarPaired(pairs.map(([ra]) => ra.correct === 1), pairs.map(([, rb]) => rb.correct === 1)) : undefined;
  const flips: TriggerFlip[] = [];
  for (const [ra, rb] of pairs) {
    const from = majority(ra);
    const to = majority(rb);
    if (from === undefined || to === undefined || from === to) continue;
    flips.push({ side: ra.side, index: ra.index, prompt: ra.prompt, from, to, better: ra.side === "should" ? to : !to });
  }
  const small = spec.should.length < TRIGGER_MIN_PROMPTS || spec.shouldNot.length < TRIGGER_MIN_PROMPTS;
  const regression = Number.isFinite(ci.hi) && ci.hi < 0;
  const ft = (s: TriggerArmScore) => `${s.raw.fp}/${s.raw.fp + s.raw.tn}`;
  const rc = (s: TriggerArmScore) => `${s.raw.tp}/${s.raw.tp + s.raw.fn}`;
  const accPart = Number.isFinite(ci.mean) ? `Δacc ${pp(ci.mean)} (95% CI ${ppNum(ci.lo)} to ${ppNum(ci.hi)})` : "Δacc — (no prompt answered in both arms)";
  return {
    prompts: pairs.length,
    accuracyA,
    accuracyB,
    ci,
    ...(mcnemar ? { mcnemar } : {}),
    flips,
    ...(small ? { smallNote: `${spec.should.length} should and ${spec.shouldNot.length} should_not prompts: only a large change can show; aim for ${TRIGGER_MIN_PROMPTS}+ per side` } : {}),
    regression,
    verdict: `recall ${rc(a)}→${rc(b)} · false triggers ${ft(a)}→${ft(b)} · ${accPart}`,
  };
}

/** Scores every arm and, with two, the paired delta of B against A. Pure. */
export function scoreTrigger(o: { spec: TriggerSpec; skill: string; agent: AgentId; arms: readonly TriggerArm[]; observations: readonly TriggerObservation[]; k: number; seed?: number }): TriggerReport {
  const seed = o.seed ?? 1;
  const arms = o.arms.map((arm, i) => scoreArm(o.spec, arm, i, o.observations, o.skill));
  const delta = arms.length === 2 ? deltaOf(o.spec, arms[0]!, arms[1]!, o.k, seed) : undefined;
  return { skill: o.skill, agent: o.agent, k: o.k, seed, arms, ...(delta ? { delta } : {}), observations: [...o.observations] };
}

// ------------------------------------------------------------ text

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "—");
const num2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const ci = (i: Interval) => (Number.isFinite(i.p) ? `${pct(i.p)} [${pct(i.lo)}–${pct(i.hi)}]` : "—");
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const counts = (c: Confusion) => `TP ${num(c.tp)} FP ${num(c.fp)} TN ${num(c.tn)} FN ${num(c.fn)}`;
const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/** The report as text: one block per arm, then the A/B verdict. */
export function formatTrigger(r: TriggerReport): string {
  const lines: string[] = [];
  const two = r.arms.length === 2;
  for (const [i, a] of r.arms.entries()) {
    const name = two ? `${i === 0 ? "A" : "B"} (${a.label})` : a.label;
    lines.push(`${name}: ${r.skill} on ${r.agent}, k=${r.k}`);
    lines.push(`  precision ${pct(a.metrics.precision)}  recall ${pct(a.metrics.recall)}  F1 ${num2(a.metrics.f1)}  accuracy ${pct(a.metrics.accuracy)}`);
    lines.push(`  ${counts(a.raw)}${a.weighted.tp + a.weighted.fp + a.weighted.tn + a.weighted.fn !== a.runs ? ` (weighted ${counts(a.weighted)})` : ""}`);
    lines.push(`  recall ${ci(a.recallCI)} · false triggers ${ci(a.falseTriggerCI)} (Wilson 95%, over ${a.runs} runs)`);
    if (a.errors) lines.push(`  ${a.errors} errored run${a.errors === 1 ? "" : "s"} left out: ${Object.entries(a.errorReasons).map(([w, n]) => `${w} ×${n}`).join(", ")}`);
    const misses = a.prompts.filter((p) => p.n && p.correct < 1);
    if (misses.length) {
      lines.push("  missed:");
      for (const p of misses) {
        const what = p.side === "should" ? `loaded ${p.triggered}/${p.n}` : `false trigger ${p.triggered}/${p.n}`;
        const others = Object.entries(p.others).map(([s, n]) => `${s} ${n}/${p.n}`).join(", ");
        lines.push(`    ${p.side === "should" ? "should    " : "should_not"} ${what}${p.flaky ? " (flaky)" : ""}${others ? ` · loaded ${others}` : ""}  ${JSON.stringify(clip(p.prompt))}`);
      }
    }
    const routes = a.prompts.filter((p) => p.expectSkill);
    if (routes.length) lines.push(`  expected routes: ${routes.map((p) => `${p.expectSkill} ${p.expectHits}/${p.n}`).join(", ")}`);
    if (a.costUsd || a.unpriced < a.runs + a.errors) lines.push(`  agent spend $${a.costUsd.toFixed(2)}${a.unpriced ? ` (${a.unpriced} runs unpriced)` : ""}`);
  }
  const d = r.delta;
  if (d) {
    lines.push("");
    lines.push(`B vs A over ${d.prompts} prompts: ${d.verdict}`);
    if (d.mcnemar) lines.push(`  McNemar (k=1): B right where A wrong ${d.mcnemar.c}, the reverse ${d.mcnemar.b}, p = ${d.mcnemar.p.toFixed(3)}`);
    for (const f of d.flips) lines.push(`  flip ${f.better ? "better" : "worse "} ${f.side === "should" ? "should    " : "should_not"} ${f.from ? "loaded" : "skipped"} → ${f.to ? "loaded" : "skipped"}  ${JSON.stringify(clip(f.prompt))}`);
    if (d.smallNote) lines.push(`  note: ${d.smallNote}`);
    lines.push(d.regression ? "Worse: B answers fewer prompts right (the CI is below 0)" : d.ci.lo > 0 ? "Better: B answers more prompts right (the CI is above 0)" : "No clear difference");
  }
  return lines.join("\n");
}
