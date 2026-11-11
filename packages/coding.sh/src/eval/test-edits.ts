// A session diff is a reference solution only when it leaves the verifier's own
// tests alone. A diff that rewrites, deletes or skips the tests the verifier
// runs passes it whatever the code does ("skip the failing test so CI is
// green"), so `eval init` must not take "fails the start, passes the end state"
// as proof of a fix. This is the runner's test-tamper check (runner/tamper.ts,
// the one behind RunResult.tamper) run on the reference patch.
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask, TamperFlag } from "../core/types.ts";
import { safeJoin } from "../runner/fsutil.ts";
import { applyPatch, rmrf, type DiffFile, type SnapshotOps, type WorkdirDiff } from "../runner/git.ts";
import { detectTamper, tamperOptsFor, type TamperOpts } from "../runner/tamper.ts";
import { parsePatch } from "./patch.ts";

/** A patch's files as the runner's diff lists them: path, add / delete / modify, line counts. */
export function patchDiff(patch: string): WorkdirDiff {
  const files: DiffFile[] = [];
  for (const f of parsePatch(patch).files) {
    const path = f.newPath ?? f.oldPath;
    if (!path) continue;
    const mode = (word: string) => f.header.some((h) => h.startsWith(`${word} file mode `));
    const status = !f.oldPath || mode("new") ? "add" : !f.newPath || mode("deleted") ? "delete" : "modify";
    const count = (sign: string) => f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith(sign)).length, 0);
    files.push({ path, status, additions: count("+"), deletions: count("-") });
  }
  return { patch, files };
}

/** Existing tests rewritten, deleted or skipped. New test files, runner config and CI are a task's own business. */
const testEdits = (diff: WorkdirDiff, opts: TamperOpts): TamperFlag[] =>
  detectTamper(diff, opts).flags.filter((f) => (f.kind === "edit" || f.kind === "delete" || f.kind === "skip") && (f.why === "verifier" || f.why === "hidden" || f.why === "test-glob"));

/**
 * The changes `patch` makes to the tests `task`'s verifier runs (empty = none): a file the
 * verifier command names, a hidden verifier file, or a test file by convention, when the
 * patch edits it, deletes it or adds a skip marker to it. A file that only gains new test
 * cases is not one: that needs the file as the patch leaves it, so the start state is
 * materialized (under `tmpRoot`) only when the patch edits a test.
 */
export async function referenceTestEdits(task: EvalTask, patch: string, ops: SnapshotOps, tmpRoot: string = tmpdir()): Promise<TamperFlag[]> {
  const diff = patchDiff(patch);
  const opts = tamperOptsFor(task);
  const flags = testEdits(diff, opts);
  if (!flags.some((f) => f.kind === "edit")) return flags;
  const dir = await mkdtemp(join(tmpRoot, "csh-ref-tests-"));
  try {
    await ops.materialize({ root: task.start.repoRoot, head: task.start.head, snapshot: task.start.snapshot }, dir);
    // A patch that only applies after setup stays judged by its paths alone.
    if (!(await applyPatch(dir, patch)).ok) return flags;
    const readFile = (p: string): string | undefined => {
      try {
        return readFileSync(safeJoin(dir, p), "utf8");
      } catch {
        return undefined;
      }
    };
    return testEdits(diff, { ...opts, readFile });
  } catch {
    // No start state to read the test from (a pruned snapshot): judged by its paths alone too.
    return flags;
  } finally {
    await rmrf(dir);
  }
}
