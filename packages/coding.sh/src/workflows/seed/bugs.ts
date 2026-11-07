// Seeded-bug cases (docs/design/workflows.md §5): start from a clean tree, apply N
// bug patches, record {id, file, lines, category, severity} as truth, and
// validate each bug before use: on the seeded tree its own test fails, and
// with only that bug's patch reverted it passes.
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobStore } from "../../core/types.ts";
import { parsePatch } from "../../eval/patch.ts";
import { commandEnv, execFileTail, sh } from "../../runner/exec.ts";
import type { SeededBug } from "../types.ts";

export interface BugSpec {
  id: string;
  /** Unified diff that introduces the bug into the clean tree. */
  patch: string;
  category: string;
  severity: SeededBug["severity"];
  /** Command that fails with the bug applied and passes without it. */
  test?: string;
}

/** File and new-side line range a bug patch touches (first file with hunks). */
export function locatePatch(patchText: string): { file: string; lines: [number, number] } {
  const p = parsePatch(patchText);
  const f = p.files.find((x) => x.hunks.length && (x.newPath ?? x.oldPath));
  if (!f) throw new Error("bug patch has no textual hunks");
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of f.hunks) {
    // Narrow to the changed lines inside the hunk, not its context: the added
    // lines, or for a pure deletion the new-side lines around the gap.
    let line = h.newStart;
    let add: [number, number] | undefined;
    let del: [number, number] | undefined;
    for (const l of h.lines) {
      if (l.startsWith("+")) {
        add = [add?.[0] ?? line, line];
        line++;
      } else if (l.startsWith("-")) {
        del = [del?.[0] ?? Math.max(1, line - 1), line];
      } else if (!l.startsWith("\\")) {
        line++;
      }
    }
    const r = add ?? del ?? [h.newStart, h.newStart + Math.max(0, h.newLines - 1)];
    lo = Math.min(lo, r[0]);
    hi = Math.max(hi, r[1]);
  }
  return { file: (f.newPath ?? f.oldPath)!, lines: [lo, Math.max(lo, hi)] };
}

async function gitApply(dir: string, patchText: string, reverse = false): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), "csh-seed-"));
  try {
    const file = join(tmp, "bug.patch");
    await writeFile(file, patchText.endsWith("\n") ? patchText : `${patchText}\n`);
    const args = ["apply", "--whitespace=nowarn", ...(reverse ? ["-R"] : []), file];
    const r = await execFileTail("git", args, { cwd: dir, env: commandEnv(), timeoutMs: 60_000 });
    if (r.exitCode !== 0) throw new Error(`git apply${reverse ? " -R" : ""} failed: ${r.stderrTail.trim() || `exit ${r.exitCode}`}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Copies `cleanDir` to `outDir` and applies every bug patch. Returns the truth
 * (patches stored in `blobs`). Throws when a patch does not apply.
 */
export async function buildSeededTree(o: { cleanDir: string; outDir: string; bugs: BugSpec[]; blobs: Pick<BlobStore, "put"> }): Promise<SeededBug[]> {
  await mkdir(o.outDir, { recursive: true });
  await cp(o.cleanDir, o.outDir, { recursive: true, filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) });
  const out: SeededBug[] = [];
  for (const b of o.bugs) {
    await gitApply(o.outDir, b.patch);
    const loc = locatePatch(b.patch);
    const bug: SeededBug = { id: b.id, file: loc.file, lines: loc.lines, category: b.category, severity: b.severity, patch: await o.blobs.put(b.patch) };
    if (b.test) bug.test = b.test;
    out.push(bug);
  }
  return out;
}

export interface BugValidation {
  id: string;
  failsSeeded: boolean;
  passesReverted: boolean;
  ok: boolean;
  error?: string;
}

/**
 * Validates bugs on a seeded tree (all patches applied): each bug's test must
 * fail there and pass with that one patch reverted. The tree is restored after
 * each bug. Bugs without a test are reported not ok.
 */
export async function validateSeededTree(o: { dir: string; bugs: BugSpec[]; timeoutMs?: number }): Promise<BugValidation[]> {
  const out: BugValidation[] = [];
  const run = async (cmd: string) => (await sh(cmd, { cwd: o.dir, env: commandEnv(), timeoutMs: o.timeoutMs ?? 120_000 })).exitCode === 0;
  for (const b of o.bugs) {
    if (!b.test) {
      out.push({ id: b.id, failsSeeded: false, passesReverted: false, ok: false, error: "no test command" });
      continue;
    }
    const v: BugValidation = { id: b.id, failsSeeded: false, passesReverted: false, ok: false };
    try {
      v.failsSeeded = !(await run(b.test));
      await gitApply(o.dir, b.patch, true);
      try {
        v.passesReverted = await run(b.test);
      } finally {
        await gitApply(o.dir, b.patch);
      }
    } catch (e) {
      v.error = e instanceof Error ? e.message : String(e);
    }
    v.ok = v.failsSeeded && v.passesReverted && !v.error;
    out.push(v);
  }
  return out;
}
