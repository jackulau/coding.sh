// The refine ledger (R2-8): one append-only JSONL file per repo under the data
// dir, `<data>/refine/<repo>-<hash>/ledger.jsonl`, plus each tested candidate's
// files (`candidates/<id>/files/…`) and each apply's backups
// (`backups/<apply id>/…`). Local only: rounds point into private sessions.
//
//   test       one candidate's round: verdict, stage, reasons, effect CI, gate,
//              guard result, preservation, the dev tasks it won (guardTasks),
//              experiment ids and spend
//   apply      the candidate's files written to the working tree (never git),
//              with the sha of what was there before and a backup of it
//   rollback   an apply undone from its backup
//   propose    a candidate a distiller wrote (`refine distill`, AD-3), with
//              its provenance and critic result; `refine test` decides it
//   recheck    a suite round's arms run again under another model (Z-14,
//              `refine recheck <id> --model`): the canary verdict and spend
//
// guardEntries turns the ledger into AB-3's GuardEntry list: a kept round is
// 'kept', an applied one 'applied', and a rolled-back apply no longer guards.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataHome } from "../core/paths.ts";
import type { RefineStage, RefineVerdict } from "./decide.ts";
import type { GuardEntry } from "./guard.ts";
import type { Preservation } from "./keep.ts";
import type { ArmPoint, MetricResult, Objective, QualityResult } from "./objectives.ts";
import type { RejectedEdit } from "./propose.ts";
import type { HarnessText } from "./protect.ts";
import type { CanaryRecord } from "./canary.ts";

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

export interface FileRef {
  path: string;
  sha: string;
}

/** The version new ledger entries carry. 2: per-task `preservation.fixed` and `stillFailing` (AE-2). Entries without `v` are version 1. */
export const LEDGER_VERSION = 2;

export interface TestEntry {
  op: "test";
  /** LEDGER_VERSION when written; absent on version 1 entries. */
  v?: number;
  /** The candidate id (r_…). */
  id: string;
  /** 1-based count of test rounds in this ledger. */
  round: number;
  at: string;
  candidate: {
    label: string;
    source: "file" | "proposal";
    /** The files the candidate changes, as tested. */
    files: FileRef[];
    /** Lines it adds (at most 40), for the log and the proposer's rejected list. */
    added: string[];
    /** Lines it deletes or rewords (at most 40), when it removes any. */
    removed?: string[];
    /** How many lines it deletes or rewords, when that is more than `removed` holds. */
    removedCount?: number;
    /** The sections it takes lines from (a cut of more than a few lines). */
    sections?: { path: string; heading: string; removed: number; lines: number }[];
    findings?: string[];
    rationale?: string;
  };
  /** The incumbent's files the candidate replaces (absent: the file is new). */
  base: FileRef[];
  verdict: RefineVerdict;
  stage: RefineStage;
  reasons: string[];
  /** Set when several candidates were tested together and more than one was kept. */
  rank?: { position: number; of: number; winner: boolean; reason?: string; tied?: string[] };
  /** Paired mean B − A over decision points, with its 95% bootstrap CI. */
  effect?: { mean: number; lo: number; hi: number; paired: number };
  gate?: { verdict: string; wins: number; losses: number; solved: number; p: number };
  guard?: { size: number; fromDev: number; rerun: number; missing: number; dropped: number; ok: boolean; verdict: string; forgets: string[]; forgotten: { task: string; entries: string[] }[] };
  /**
   * Per-task outcomes of the round. `fixed` (tasks the base never passed and the
   * candidate did), `stillFailing` (neither arm passed) and `basis` were added in
   * ledger v2 (AE-2); entries written before lack them.
   */
  preservation?: { gained: number; lost: number; regressed: string[]; R: number; reasons: string[]; fixed?: string[]; stillFailing?: string[]; basis?: "heldOut" | "dev" };
  alternative?: { uniqueGains: string[] };
  /** Dev tasks won (kept rounds): they guard later candidates. */
  guardTasks: string[];
  dataset?: { id: string; version: string; cases: number };
  experiments?: { devA: string; devB: string; guardA?: string; guardB?: string };
  model?: string;
  /** `--suite` rounds: the eval suite and primary objective of the climb, and the experiment that ran the round (absent when the candidate was rejected before any run). */
  suite?: { name: string; tasks: number; k: number; primary: Objective; experiment?: string; base?: string; cand?: string };
  /** `--suite` rounds: each objective's result (objectives.ts), point estimates per arm, and the per-task gains the e-detector took. */
  objectives?: {
    list: Objective[];
    margin: number;
    minGain: number;
    /** --max-cost-rise for this round; null: no limit. Absent on rounds before it existed. */
    maxCostRise?: number | null;
    branch?: "quality" | "efficiency";
    /** A significant quality gain met a significant rise on a listed objective (objectives.ts ObjectiveDecision.trade); limit null: no limit. */
    trade?: { limit: number | null; rose: Exclude<Objective, "pass">[]; within: boolean };
    quality: QualityResult;
    metrics: MetricResult[];
    arms: { base: ArmPoint; cand: ArmPoint };
    gains: number[];
    warnings: string[];
  };
  /** `--suite` rounds: stage 3, the base and candidate re-run under the canary model (Z-14). */
  canary?: CanaryRecord;
  cost: { usd: number; unpriced: number };
}

export interface ApplyEntry {
  op: "apply";
  /** a_… */
  id: string;
  candidate: string;
  at: string;
  /** `before` is null when the file did not exist. */
  files: { path: string; before: string | null; after: string }[];
  /** Applied though the round was not a keep, or the files changed since the test. */
  forced?: string;
}

export interface RollbackEntry {
  op: "rollback";
  id: string;
  apply: string;
  candidate: string;
  at: string;
  files: { path: string; restored: string | null }[];
  forced?: boolean;
}

export interface RecheckEntry {
  op: "recheck";
  /** k_… */
  id: string;
  /** The re-checked candidate (r_…). */
  candidate: string;
  at: string;
  canary: CanaryRecord;
  /** Whether the candidate was applied (and not rolled back) when it was re-checked. */
  applied: boolean;
  cost: { usd: number; unpriced: number };
}

export interface ProposeEntry {
  op: "propose";
  /** The candidate id (r_…); `refine test <id>` tests it. */
  id: string;
  at: string;
  proposer: "distill";
  files: FileRef[];
  /** "rejected": a critic or the size cap turned it down before any test. */
  verdict: "proposed" | "rejected";
  reasons: string[];
  provenance: {
    corpusEpisodes: number;
    failures: number;
    passRate: number | null;
    /** The experiment, or "sessions". */
    source: string;
    /** Held-out tasks whose runs the corpus left out. */
    leftOut: string[];
    draw: number;
    distiller: string;
    model?: string;
    costUsd?: number;
    durationMs: number;
  };
}

export type LedgerEntry = TestEntry | ApplyEntry | RollbackEntry | RecheckEntry | ProposeEntry;

/** `<data>/refine/<repo name>-<sha of the repo path>`. */
export function refineDir(env: NodeJS.ProcessEnv, repoRoot: string): string {
  const name = basename(repoRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "repo";
  return join(dataHome(env), "refine", `${name}-${sha(resolve(repoRoot)).slice(0, 8)}`);
}

export const ledgerFile = (dir: string): string => join(dir, "ledger.jsonl");

/** Every entry, oldest first; malformed lines are skipped. */
export function readLedger(dir: string): LedgerEntry[] {
  let text: string;
  try {
    text = readFileSync(ledgerFile(dir), "utf8");
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (e && (e.op === "test" || e.op === "apply" || e.op === "rollback" || e.op === "recheck" || e.op === "propose")) out.push(e);
    } catch {
      // A torn last line from a crash: skip it.
    }
  }
  return out;
}

export function appendLedger(dir: string, e: LedgerEntry): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(ledgerFile(dir), `${JSON.stringify(e)}\n`);
}

export const tests = (entries: readonly LedgerEntry[]): TestEntry[] => entries.filter((e): e is TestEntry => e.op === "test");

/** Applies not rolled back, oldest first. */
export function liveApplies(entries: readonly LedgerEntry[]): ApplyEntry[] {
  const undone = new Set(entries.filter((e): e is RollbackEntry => e.op === "rollback").map((e) => e.apply));
  return entries.filter((e): e is ApplyEntry => e.op === "apply" && !undone.has(e.id));
}

/** A preservation report as the ledger stores it (ids of fixed, regressed and still-failing tasks on the basis set). */
export function preservationEntry(p: Preservation): NonNullable<TestEntry["preservation"]> {
  const basis = p.heldOut ?? p.dev;
  return { gained: p.dev.gained.length, lost: p.dev.lost.length, regressed: p.regressed, R: p.R, reasons: p.reasons, fixed: [...basis.gained].sort(), stillFailing: p.stillFailing, basis: p.basis };
}

/**
 * The rounds not kept, as the proposer sees them, oldest first: id, verdict,
 * reasons, added lines and (ledger v2, AE-2) the task ids the edit fixed,
 * regressed and left failing. Read from the stored entries, never recomputed;
 * an entry without per-task outcomes gets none.
 */
export function rejectedEdits(entries: readonly LedgerEntry[]): RejectedEdit[] {
  return tests(entries)
    .filter((t) => t.verdict !== "keep")
    .map((t) => {
      const p = t.preservation;
      return {
        id: t.id,
        verdict: t.verdict,
        reasons: t.reasons,
        added: t.candidate.added,
        ...(p?.fixed?.length ? { fixed: p.fixed } : {}),
        ...(p?.regressed?.length ? { regressed: p.regressed } : {}),
        ...(p?.stillFailing?.length ? { stillFailing: p.stillFailing } : {}),
      };
    });
}

/** AB-3's view of the ledger: each kept candidate's latest round, applied or not, rolled back or not. */
export function guardEntries(entries: readonly LedgerEntry[]): GuardEntry[] {
  const kept = new Map<string, TestEntry>();
  for (const t of tests(entries)) if (t.verdict === "keep") kept.set(t.id, t);
  const applied = new Set<string>();
  const rolledBack = new Set<string>();
  for (const e of entries) {
    if (e.op === "apply") {
      applied.add(e.candidate);
      rolledBack.delete(e.candidate);
    } else if (e.op === "rollback") rolledBack.add(e.candidate);
  }
  return [...kept.values()].map((t) => ({
    id: t.id,
    at: t.at,
    status: applied.has(t.id) ? "applied" : "kept",
    ...(rolledBack.has(t.id) ? { rolledBack: true } : {}),
    guardTasks: t.guardTasks,
  }));
}

// ---------------------------------------------------------------- files

/** A repo-relative POSIX path that stays inside `root`, or throws. */
export function safePath(root: string, rel: string): string {
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error(`unsafe path ${JSON.stringify(rel)}`);
  const abs = resolve(root, rel);
  const back = relative(resolve(root), abs);
  if (back.startsWith("..") || isAbsolute(back)) throw new Error(`unsafe path ${JSON.stringify(rel)}`);
  return abs;
}

function walk(dir: string, base: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names.sort()) {
    const abs = join(dir, n);
    if (statSync(abs).isDirectory()) walk(abs, base, out);
    else out.push(relative(base, abs).split(sep).join("/"));
  }
}

export interface StoredCandidate {
  id: string;
  files: HarnessText[];
  source: "file" | "proposal";
  findings?: string[];
  rationale?: string;
  /** Who wrote it, when not the proposer model (`distill`). */
  proposer?: string;
}

const candidateDir = (dir: string, id: string): string => {
  if (!/^r_[0-9a-f]{10}$/.test(id)) throw new Error(`not a candidate id: ${JSON.stringify(id)}`);
  return join(dir, "candidates", id);
};

/** Keep a candidate's changed files (and how it was made) so `refine test <id>` and `refine apply` can find them later. */
export function saveCandidate(dir: string, c: StoredCandidate): string {
  const cd = candidateDir(dir, c.id);
  for (const f of c.files) {
    const abs = safePath(join(cd, "files"), f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.text);
  }
  const meta = { id: c.id, source: c.source, paths: c.files.map((f) => f.path), ...(c.findings ? { findings: c.findings } : {}), ...(c.rationale ? { rationale: c.rationale } : {}), ...(c.proposer ? { proposer: c.proposer } : {}) };
  writeFileSync(join(cd, "candidate.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return join(cd, "files");
}

export function loadCandidate(dir: string, id: string): StoredCandidate | undefined {
  const cd = candidateDir(dir, id);
  if (!existsSync(join(cd, "files"))) return undefined;
  let meta: { source?: string; findings?: string[]; rationale?: string } = {};
  try {
    meta = JSON.parse(readFileSync(join(cd, "candidate.json"), "utf8"));
  } catch {
    // Files without metadata: a hand-made candidate.
  }
  const rels: string[] = [];
  walk(join(cd, "files"), join(cd, "files"), rels);
  return {
    id,
    files: rels.map((p) => ({ path: p, text: readFileSync(join(cd, "files", p), "utf8") })),
    source: meta.source === "proposal" ? "proposal" : "file",
    ...(meta.findings ? { findings: meta.findings } : {}),
    ...(meta.rationale ? { rationale: meta.rationale } : {}),
  };
}

const readOr = (abs: string): string | null => {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

/** Current sha of each path in the working tree (null when absent). */
export function currentShas(root: string, paths: readonly string[]): Map<string, string | null> {
  return new Map(paths.map((p) => {
    const t = readOr(safePath(root, p));
    return [p, t === null ? null : sha(t)];
  }));
}

/** Write a candidate's files into the working tree, backing up what was there under `backups/<applyId>/`. */
export function writeApply(dir: string, root: string, applyId: string, files: readonly HarnessText[]): ApplyEntry["files"] {
  const out: ApplyEntry["files"] = [];
  for (const f of files) {
    const abs = safePath(root, f.path);
    const prev = readOr(abs);
    if (prev !== null) {
      const b = safePath(join(dir, "backups", applyId), f.path);
      mkdirSync(dirname(b), { recursive: true });
      writeFileSync(b, prev);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.text);
    out.push({ path: f.path, before: prev === null ? null : sha(prev), after: sha(f.text) });
  }
  return out;
}

/** Put back what an apply replaced: the backup, or no file when there was none. */
export function writeRollback(dir: string, root: string, apply: ApplyEntry): RollbackEntry["files"] {
  const out: RollbackEntry["files"] = [];
  for (const f of apply.files) {
    const abs = safePath(root, f.path);
    if (f.before === null) {
      rmSync(abs, { force: true });
      out.push({ path: f.path, restored: null });
      continue;
    }
    const text = readOr(safePath(join(dir, "backups", apply.id), f.path));
    if (text === null) throw new Error(`no backup of ${f.path} for ${apply.id}`);
    writeFileSync(abs, text);
    out.push({ path: f.path, restored: sha(text) });
  }
  return out;
}
