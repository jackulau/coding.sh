// Verifier isolation (BenchJack V1, arXiv 2605.12673; EvilGenie, arXiv 2511.21654).
// Graded in the agent's own work tree, a verifier runs whatever the agent left
// there: a conftest.py that marks every test passed, a sitecustomize.py or
// *.pth that patches the interpreter, an .npmrc with node-options=--require, a
// package.json whose test script became `exit 0`. So the verifier runs in a
// fresh copy of the start tree (taken after setup, before the agent, ignored
// files included) plus only the agent's changes to tracked source paths:
//
// - hook files the agent added or changed (conftest.py, sitecustomize.py,
//   usercustomize.py, *.pth, .npmrc, .yarnrc, bunfig.toml, …) are left out;
// - test-runner and build config (pytest.ini, pyproject.toml, jest.config.*,
//   Makefile, …) and files the verifier command runs stay as they were at the start;
// - each package.json keeps the agent's edits except `scripts` (and the jest,
//   mocha and ava keys), which come from the start;
// - vendored dependencies (node_modules, site-packages, .venv) stay as they were;
// - symlinks that point out of the tree and special files (FIFOs, sockets) are left out;
// - files git ignores (build output, caches) are never carried over.
//
// The copy lands at the work dir's own path (the agent's tree moves aside while
// the verifier runs), so absolute paths baked in by setup (venv shebangs,
// editable installs) still point into the verified tree. A task opts paths
// back in with `meta.verifierAllow: ["globs"]`, or turns isolation off with
// `meta.verifierIsolation: "off"`.
import { constants, existsSync } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import type { EvalTask, VerifierIsolation } from "../core/types.ts";
import { execFileTail } from "./exec.ts";
import { assertInsideReal, safeJoin } from "./fsutil.ts";
import { rmrf, START_REF } from "./git.ts";
import { matchAny } from "./glob.ts";
import { RUNNER_CONFIG_GLOBS, verifierDataPaths, verifierPaths } from "./tamper.ts";

export type StripReason = VerifierIsolation["stripped"][number]["why"];

/** Files an interpreter or package manager loads on its own, wherever they sit. */
export const HOOK_FILES: readonly string[] = [
  "conftest.py",
  "sitecustomize.py",
  "usercustomize.py",
  ".pythonstartup",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  "bunfig.toml",
];

/** Config that decides what a verifier runs and how: restored from the start. */
export const ISOLATED_CONFIG_GLOBS: readonly string[] = [
  ...RUNNER_CONFIG_GLOBS.filter((g) => g !== "**/conftest.py"),
  "**/pyproject.toml",
  "**/setup.cfg",
  "**/Makefile",
  "**/makefile",
  "**/GNUmakefile",
  "**/vite.config.*",
  "**/babel.config.*",
  "**/.babelrc*",
  "**/.rspec",
  "**/.cargo/config",
  "**/.cargo/config.toml",
  "**/deno.json",
  "**/deno.jsonc",
];

/** Vendored dependencies: an edit there patches what the tests import. */
export const DEPENDENCY_GLOBS: readonly string[] = ["**/node_modules/**", "**/site-packages/**", "**/.venv/**", "**/venv/**"];

/** package.json keys that decide how tests run. */
export const PACKAGE_TEST_KEYS: readonly string[] = ["scripts", "jest", "mocha", "ava"];

export interface ChangedPath {
  path: string;
  kind: "add" | "modify" | "delete";
}

export interface IsolationPlan {
  /** Changes copied into the verified tree as the agent left them. */
  carry: ChangedPath[];
  /** package.json files written as the agent's version with the start's test keys. */
  merge: { path: string; content: string }[];
  stripped: VerifierIsolation["stripped"];
}

/** Whether a task turned isolation off (`meta.verifierIsolation: "off"`). */
export function isolationOff(task: EvalTask): boolean {
  const v = task.meta?.verifierIsolation;
  return v === "off" || v === false;
}

/** `meta.verifierAllow`: paths (globs) the task lets the agent change even when isolation would restore them. */
export function isolationAllow(task: EvalTask): string[] {
  const a = task.meta?.verifierAllow;
  return Array.isArray(a) ? a.filter((g): g is string => typeof g === "string" && g !== "") : [];
}

const base = (p: string) => posix.basename(p).toLowerCase();

/** Why a changed path stays out of the verified tree (package.json aside), or undefined to carry it. */
export function stripReason(path: string, command: string, allow: readonly string[] = []): StripReason | undefined {
  if (matchAny(path, allow)) return undefined;
  const b = base(path);
  if (HOOK_FILES.includes(b) || b.endsWith(".pth")) return "hook";
  if (matchAny(path, DEPENDENCY_GLOBS)) return "dependency";
  if (matchAny(path, ISOLATED_CONFIG_GLOBS)) return "config";
  // A file the verifier runs; one it only reads (`cat out.txt`) is the deliverable.
  const data = verifierDataPaths(command);
  if (verifierPaths(command).some((t) => t === path) && !data.has(path)) return "verifier";
  return undefined;
}

/**
 * The agent's package.json with the start's test keys. Undefined when nothing
 * differs (carry it as is); null when it can't be merged (keep the start's).
 */
export function mergePackageJson(start: string | undefined, agent: string): string | undefined | null {
  let a: Record<string, unknown>;
  let s: Record<string, unknown> = {};
  try {
    a = JSON.parse(agent) as Record<string, unknown>;
    if (start !== undefined) s = JSON.parse(start) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  let changed = false;
  for (const k of PACKAGE_TEST_KEYS) {
    if (JSON.stringify(a[k]) === JSON.stringify(s[k])) continue;
    changed = true;
    if (s[k] === undefined) delete a[k];
    else a[k] = s[k];
  }
  return changed ? `${JSON.stringify(a, null, 2)}\n` : undefined;
}

/** Decide, per changed path, what reaches the verifier. Reads the start's and the agent's package.json. */
export function planIsolation(
  changes: readonly ChangedPath[],
  o: { command: string; allow?: readonly string[]; readStart: (p: string) => string | undefined; readAgent: (p: string) => string | undefined },
): IsolationPlan {
  const plan: IsolationPlan = { carry: [], merge: [], stripped: [] };
  for (const c of changes) {
    const why = stripReason(c.path, o.command, o.allow);
    if (why) {
      plan.stripped.push({ path: c.path, why, change: c.kind });
      continue;
    }
    if (base(c.path) === "package.json" && c.kind !== "delete" && !matchAny(c.path, o.allow ?? [])) {
      const agent = o.readAgent(c.path);
      const merged = agent === undefined ? null : mergePackageJson(o.readStart(c.path), agent);
      if (merged === null) {
        plan.stripped.push({ path: c.path, why: "config", change: c.kind });
        continue;
      }
      if (merged !== undefined) {
        plan.merge.push({ path: c.path, content: merged });
        plan.stripped.push({ path: c.path, why: "scripts", change: c.kind });
        continue;
      }
    }
    plan.carry.push(c);
  }
  return plan;
}

/**
 * Paths the agent added, changed or deleted since the start commit, ignored
 * files left out. A scratch index keeps the agent's own index untouched.
 */
export async function changedPaths(dir: string): Promise<ChangedPath[]> {
  const scratch = await mkdtemp(join(tmpdir(), "csh-iso-"));
  try {
    const idx = join(scratch, "index");
    const own = join(dir, ".git", "index");
    // The work tree's index saves rehashing every file, but only with its own mtime: git
    // trusts a cached stat older than the index file, so a fresh mtime would hide a
    // same-size edit made in the same second as the checkout (racy git).
    if (existsSync(own)) {
      await copyFile(own, idx)
        .then(async () => {
          const st = await stat(own);
          await utimes(idx, st.atime, st.mtime);
        })
        .catch(() => rm(idx, { force: true }));
    }
    const env = { ...process.env, GIT_INDEX_FILE: idx, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", GIT_TRACE2_EVENT: "0" };
    const add = await execFileTail("git", ["-c", "core.splitIndex=false", "add", "-A", "--ignore-errors"], { cwd: dir, env, timeoutMs: 120_000 });
    if (add.exitCode !== 0 && add.exitCode !== 128) throw new Error(`git add failed: ${add.stderrTail.trim()}`);
    const d = await execFileTail("git", ["-c", "core.quotepath=off", "diff", "--cached", "--no-renames", "--name-status", "-z", START_REF], { cwd: dir, env, timeoutMs: 120_000, tailBytes: 64 * 1024 * 1024 });
    if (d.exitCode !== 0) throw new Error(`git diff failed: ${d.stderrTail.trim()}`);
    const parts = d.stdoutTail.split("\0");
    const out: ChangedPath[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const s = parts[i] as string;
      const p = parts[i + 1] as string;
      if (!s || !p) continue;
      out.push({ path: p, kind: s.startsWith("A") ? "add" : s.startsWith("D") ? "delete" : "modify" });
    }
    return out;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Copy a tree (ignored files and .git included) as cheaply as the filesystem allows. */
export async function copyTree(src: string, dest: string): Promise<void> {
  await rmrf(dest);
  await cp(src, dest, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE });
}

/** A symlink at `rel` in `root` whose target stays inside root. */
function linkInside(root: string, rel: string, target: string): boolean {
  if (isAbsolute(target)) {
    const r = relative(resolve(root), resolve(target));
    return !r.startsWith("..") && !isAbsolute(r);
  }
  const r = relative(resolve(root), resolve(dirname(join(root, rel)), target));
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

/**
 * Apply a plan to `dest` (a fresh copy of the start): deletions, then the
 * agent's files from `from`, then the merged package.json files. Symlinks that
 * leave the tree and special files are left out and added to the plan's stripped list.
 */
export async function applyPlan(plan: IsolationPlan, from: string, dest: string): Promise<void> {
  for (const c of plan.carry.filter((x) => x.kind === "delete")) await rm(safeJoin(dest, c.path), { recursive: true, force: true });
  for (const c of plan.carry.filter((x) => x.kind !== "delete")) {
    const src = safeJoin(from, c.path);
    const st = await lstat(src).catch(() => undefined);
    if (!st) continue;
    const abs = safeJoin(dest, c.path);
    if (st.isSymbolicLink()) {
      const target = await readlink(src);
      if (!linkInside(from, c.path, target)) {
        plan.stripped.push({ path: c.path, why: "symlink", change: c.kind });
        continue;
      }
      await mkdir(dirname(abs), { recursive: true });
      await assertInsideReal(dest, abs);
      await rm(abs, { recursive: true, force: true });
      await symlink(target, abs);
      continue;
    }
    if (!st.isFile()) {
      plan.stripped.push({ path: c.path, why: "special", change: c.kind });
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await assertInsideReal(dest, abs);
    await rm(abs, { recursive: true, force: true });
    await copyFile(src, abs);
    // No setuid or setgid bits in the verified tree.
    if (process.platform !== "win32" && st.mode & 0o6000) await chmod(abs, st.mode & 0o1777);
  }
  for (const m of plan.merge) {
    const abs = safeJoin(dest, m.path);
    await mkdir(dirname(abs), { recursive: true });
    await assertInsideReal(dest, abs);
    await writeFile(abs, m.content);
  }
}

/** Read a repo-relative text file under root; undefined when missing or outside. */
export async function readRel(root: string, rel: string): Promise<string | undefined> {
  try {
    return await readFile(safeJoin(root, rel), "utf8");
  } catch {
    return undefined;
  }
}

export interface IsolatedDirs {
  /** The agent's work dir: the verifier runs at this path. */
  work: string;
  /** The pristine copy of the start (after setup, before the agent). */
  start: string;
  /** Where the agent's tree waits while the verifier runs. */
  aside: string;
  /** Where the verified tree is kept afterwards (for `keep`), else removed. */
  verified: string;
}

/**
 * Swap the verified tree in at the work dir's path, run `fn` there, and put the
 * agent's tree back. `reuseStart` keeps the pristine copy for a later round
 * (copied, not moved). The plan is decided before the swap.
 */
export async function withIsolatedTree<T>(
  d: IsolatedDirs,
  o: { task: EvalTask; reuseStart: boolean; keepVerified: boolean },
  fn: (report: VerifierIsolation) => Promise<T>,
): Promise<T> {
  const changes = await changedPaths(d.work);
  // The start's and the agent's version of each changed package.json, read before the swap.
  const pkg = new Map<string, string | undefined>();
  for (const c of changes) {
    if (base(c.path) !== "package.json" || c.kind === "delete") continue;
    pkg.set(`start:${c.path}`, await readRel(d.start, c.path));
    pkg.set(`agent:${c.path}`, await readRel(d.work, c.path));
  }
  const plan = planIsolation(changes, {
    command: o.task.verifier.command,
    allow: isolationAllow(o.task),
    readStart: (p) => pkg.get(`start:${p}`),
    readAgent: (p) => pkg.get(`agent:${p}`),
  });
  await rmrf(d.aside);
  await rename(d.work, d.aside);
  try {
    if (o.reuseStart) await copyTree(d.start, d.work);
    else await rename(d.start, d.work);
    await applyPlan(plan, d.aside, d.work);
    return await fn({ carried: plan.carry.length + plan.merge.length, stripped: plan.stripped });
  } finally {
    await rmrf(d.verified).catch(() => {});
    if (existsSync(d.work)) {
      if (o.keepVerified) await rename(d.work, d.verified).catch(() => rmrf(d.work));
      else await rmrf(d.work);
    }
    await rename(d.aside, d.work);
  }
}
