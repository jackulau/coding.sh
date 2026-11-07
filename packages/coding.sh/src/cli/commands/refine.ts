// coding.sh refine protected|check: the harness lines an edit may not delete,
// reword or relax (src/refine/protect.ts). `check` runs the two critics on an
// edit (default: git HEAD vs your uncommitted edits) and exits 1 when the edit
// drops or waives a protected line. `exp ab` runs the same check on its arms.
// The loop (propose, test, apply, rollback, log, run) is in refine-loop.ts,
// `score` (diagnoses against human labels) in refine-score.ts.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Context } from "../../core/context.ts";
import { checkProtected, protectedLines } from "../../refine/protect.ts";
import { UsageError } from "../args.ts";
import { str, withContext } from "../common.ts";
import { plural } from "../output.ts";
import { protectJson, protectOptions, protectOverrides, rejectionLines } from "../protect.ts";
import type { CommandContext } from "../types.ts";
import { gitRoot, harnessFilesIn, resolveArm, sameFiles, type Arm } from "./exp-ab.ts";

type ArmCtx = Pick<Context, "index" | "blobs">;

/** A value only a harness bundle can satisfy needs the store; files, dirs, git revisions and `none` do not. */
const needsStore = (v: string | undefined, cwd: string): boolean => v !== undefined && v !== "none" && !v.startsWith("git:") && !existsSync(resolve(cwd, v));

/** Runs `fn` with a store context only when an arm names a bundle. */
async function withArms<T>(c: CommandContext, values: (string | undefined)[], fn: (ctx: ArmCtx) => Promise<T>): Promise<T> {
  if (values.some((v) => needsStore(v, c.cwd))) return withContext(c, fn);
  const none = { getBundle: async () => undefined } as unknown as ArmCtx["index"];
  return fn({ index: none, blobs: undefined as unknown as ArmCtx["blobs"] });
}

const LOOP = new Set(["propose", "test", "apply", "rollback", "log", "run"]);

export async function run(c: CommandContext): Promise<number> {
  if (c.action && LOOP.has(c.action)) return (await import("./refine-loop.ts")).refineLoop(c);
  if (c.action === "score") return (await import("./refine-score.ts")).refineScore(c);
  const { out } = c;
  const root = gitRoot(c.cwd);
  const repoRoot = root ?? c.cwd;
  const { files: configFiles, ...opts } = protectOptions(c);
  const aFlag = str(c.flags.a);

  if (c.action === "protected") {
    return withArms(c, [aFlag], async (ctx) => {
      const arm: Arm = aFlag === undefined ? { label: "current files", files: harnessFilesIn(repoRoot), watch: [] } : await resolveArm(aFlag, { cwd: c.cwd, root: repoRoot, base: harnessFilesIn(repoRoot), flag: "a", ctx });
      const lines = protectedLines(arm.files, opts);
      const settings = { autoProtect: opts.autoProtect, patterns: opts.protect, configFiles };
      if (out.json) {
        out.data({ harness: arm.label, files: arm.files.map((f) => f.path), settings, count: lines.length, lines });
        return 0;
      }
      const how = `auto-protect ${opts.autoProtect ? "on" : "off"}, ${plural(opts.protect.length, "pattern")}`;
      if (!lines.length) {
        out.note(`No protected lines in ${plural(arm.files.length, "harness file")} (${arm.label}; ${how})`);
        out.next("Protect lines by hand with a marker block in the file", "<!-- coding.sh:protect --> … <!-- coding.sh:protect end -->");
        return 0;
      }
      out.table(["WHERE", "WHY", "LINE"], lines.map((p) => [`${p.path}:${p.line}`, p.why, p.text]));
      out.note(`${plural(lines.length, "protected line")} in ${plural(new Set(lines.map((p) => p.path)).size, "file")} (${arm.label}; ${how})`);
      return 0;
    });
  }

  if (c.action !== "check") throw new UsageError(`Unknown refine command ${c.action}`);
  const bFlag = str(c.flags.b);
  const allow = protectOverrides(c.flags["allow-protected-edit"]);
  return withArms(c, [aFlag, bFlag], async (ctx) => {
    const current: Arm = { label: "current files", files: harnessFilesIn(repoRoot), watch: [] };
    let a: Arm;
    let b: Arm;
    if (aFlag === undefined && bFlag === undefined) {
      if (!root) throw new UsageError("Not in a git repo: pass the two versions with --a and --b", { reason: "missing_argument", suggestion: "coding.sh refine check --a ./old --b ./new" });
      a = await resolveArm("git:HEAD", { cwd: c.cwd, root: repoRoot, base: current.files, flag: "a", ctx });
      b = { ...current, label: "your edits" };
    } else {
      a = aFlag === undefined ? current : await resolveArm(aFlag, { cwd: c.cwd, root: repoRoot, base: current.files, flag: "a", ctx });
      b = bFlag === undefined ? current : await resolveArm(bFlag, { cwd: c.cwd, root: repoRoot, base: a.files, flag: "b", ctx });
    }
    const r = checkProtected(a.files, b.files, { ...opts, allow });
    if (out.json) {
      out.data({ a: a.label, b: b.label, changed: !sameFiles(a.files, b.files), ...protectJson(r) });
      return r.ok ? 0 : 1;
    }
    for (const v of r.unusedOverrides) out.warn(`--allow-protected-edit ${v}: no rejection names that protected line`);
    for (const l of rejectionLines(r.rejections)) out.print(l);
    for (const l of rejectionLines(r.overridden)) out.print(`allowed: ${l}`);
    if (!r.ok) {
      const first = r.rejections[0]!.protected;
      out.fail(`${plural(r.rejections.length, "protected-line problem")} from A (${a.label}) to B (${b.label}); a pass-rate A/B can't see this harm`);
      out.next("Restore the line, or allow this edit on purpose", `coding.sh refine check --allow-protected-edit ${first.path}:${first.line}`);
      return 1;
    }
    if (sameFiles(a.files, b.files)) out.ok(`No changes from A (${a.label}) to B (${b.label}); ${plural(r.protected.length, "protected line")} in place`);
    else out.ok(`No protected line deleted, reworded or relaxed (${plural(r.protected.length, "protected line")} in A; ${a.label} -> ${b.label})`);
    return 0;
  });
}
