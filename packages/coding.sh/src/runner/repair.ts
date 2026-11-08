// Verifier feedback repair rounds (`compare --repair N`): after a failed
// verifier the agent is told "Verification failed." (optionally with the
// failing tests' names) and tries again in its own session, up to N rounds.
//
// BOBA (arXiv 2611.02207 §6, App. F.3): one external "verification failed" bit
// and one repair round raised chain completion 51% → 59%; naming the failing
// test was worth about three bare rejections; a fresh conversation without the
// message did not help; at a 50% false-alarm rate most of the gain is gone.
// This module holds the pure parts: the message, the failing-name parser and
// the seeded false-alarm draw. The loop is in run.ts.
import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { safeJoin, safeWrite } from "./fsutil.ts";

export interface RepairOpts {
  /** Rounds after the first attempt, 1-8. */
  rounds: number;
  signal: "bit" | "names";
  /** Chance (0-1) of telling a passing first attempt it failed. Default 0. */
  falseAlarm?: number;
  /** Seed for the false-alarm draw (with the run id). Default 0. */
  seed?: number;
}

export const MAX_REPAIR_ROUNDS = 8;
/** Failing test names sent per round. */
export const MAX_FAILING_NAMES = 20;
const MAX_NAME = 200;

/** The message the agent gets after a failed (or falsely failed) verifier. */
export function repairMessage(names?: readonly string[]): string {
  return names?.length ? `Verification failed. Failing tests: ${names.join(", ")}` : "Verification failed.";
}

const PATTERNS: RegExp[] = [
  // pytest short summary: FAILED tests/test_x.py::test_y - AssertionError
  /^FAILED (\S+)/,
  // node:test TAP: not ok 3 - adds numbers
  /^\s*not ok \d+ - (.+?)(?:\s+#\s.*)?$/,
  // node:test spec reporter, jest and vitest: ✖ adds numbers (1.2ms) / ✕ adds (5 ms) / × adds
  /^\s*[✖✕×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/,
  // jest / vitest file or test line: FAIL  src/x.test.ts > adds
  /^\s*FAIL\s+(.+)$/,
  // go test: --- FAIL: TestAdd (0.00s)
  /^\s*--- FAIL: (\S+)/,
  // cargo test: test math::adds ... FAILED
  /^test (\S+) \.\.\. FAILED$/,
];

/**
 * Failing test ids from a verifier's output (pytest, node:test TAP and spec,
 * jest, vitest, go test, cargo test), first seen first, at most 20, each
 * clipped. Only names: never a line of test source or an assertion message.
 * Empty when nothing matched.
 */
export function failingTestNames(output: string): string[] {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    for (const re of PATTERNS) {
      const m = re.exec(line);
      const name = m?.[1]?.trim();
      if (!name) continue;
      const id = name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
      break;
    }
    if (out.length >= MAX_FAILING_NAMES) break;
  }
  return out;
}

/**
 * Whether the seeded false alarm fires for this run: a uniform draw from
 * sha256(seed, runId) below `p`. Never at p = 0; the same seed and run id
 * always draw the same.
 */
export function falseAlarmFires(p: number | undefined, seed: number | undefined, runId: string): boolean {
  if (!p || !(p > 0)) return false;
  const h = createHash("sha256").update(`${seed ?? 0}\u0000${runId}`).digest();
  return h.readUInt32BE(0) / 2 ** 32 < p;
}

/** A usage error for bad repair options, or undefined. */
export function repairOptsProblem(o: RepairOpts): string | undefined {
  if (!Number.isInteger(o.rounds) || o.rounds < 1 || o.rounds > MAX_REPAIR_ROUNDS) return `--repair takes 1-${MAX_REPAIR_ROUNDS} rounds, got ${o.rounds}`;
  if (o.signal !== "bit" && o.signal !== "names") return `--repair-signal takes bit or names, got ${JSON.stringify(o.signal)}`;
  if (o.falseAlarm !== undefined && !(o.falseAlarm >= 0 && o.falseAlarm <= 1)) return `--false-alarm takes a probability from 0 to 1, got ${o.falseAlarm}`;
  return undefined;
}

/** Saved contents of some work-tree paths: null when the path did not exist. */
export type SavedFiles = Map<string, Buffer | null>;

/** Read what is at each path now, so hidden files written over them can be taken out again. */
export async function saveFiles(dir: string, rels: readonly string[]): Promise<SavedFiles> {
  const out: SavedFiles = new Map();
  for (const rel of rels) {
    const abs = safeJoin(dir, rel);
    const st = await lstat(abs).catch(() => undefined);
    out.set(rel, st?.isFile() ? await readFile(abs) : null);
  }
  return out;
}

/** Put saved paths back: remove the ones that did not exist, rewrite the others. */
export async function restoreFiles(dir: string, saved: SavedFiles): Promise<void> {
  for (const [rel, data] of saved) {
    if (data === null) await rm(safeJoin(dir, rel), { force: true });
    else await safeWrite(dir, rel, data);
  }
}
