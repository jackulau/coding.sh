// What the git hooks run, worked out from the files a commit or push touches.
// Pure planning plus a few git reads; run.mjs executes the plan. Zero
// dependencies. See CONTRIBUTING.md "Lint and git hooks".
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ZERO = /^0+$/;
/** git's empty tree: diffing against it lists every file. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Whether spawning `cmd` needs a shell: on Windows npm and npx are .cmd files,
 * which spawn without a shell can't start (ENOENT).
 */
export function needsShell(cmd, platform = process.platform) {
  return platform === "win32" && (cmd === "npm" || cmd === "npx");
}

export function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** The npm workspaces under `root` that have a package.json: their directory, package name and scripts. */
export function workspaces(root) {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dirs = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2);
      if (!existsSync(join(root, base))) continue;
      for (const d of readdirSync(join(root, base), { withFileTypes: true })) if (d.isDirectory()) dirs.push(`${base}/${d.name}`);
    } else dirs.push(pattern);
  }
  const found = [];
  for (const dir of dirs.sort()) {
    const file = join(root, dir, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    found.push({ dir, name: pkg.name, scripts: pkg.scripts ?? {} });
  }
  return found;
}

/** The workspace a repo-relative path belongs to, or undefined. */
export const workspaceOf = (spaces, path) => spaces.find((w) => path === w.dir || path.startsWith(`${w.dir}/`));

/** A step: a label for the log and the command to run from `cwd` (repo-relative). */
const step = (label, cmd, args, cwd = ".") => ({ label, cmd, args, cwd });

/**
 * The command a workspace typechecks with: its `typecheck` script, a `check`
 * that runs no tests, or `astro check` when `check` runs it before the tests
 * (the site's `check` is `astro check && npm test`, too slow to run alone).
 */
function typecheckCommand(w) {
  if (w.scripts.typecheck) return ["npm", ["run", "--silent", "typecheck"]];
  if (w.scripts.check && !/\btest\b/.test(w.scripts.check)) return ["npm", ["run", "--silent", "check"]];
  if (/(^|&&\s*)astro check\b/.test(w.scripts.check ?? "")) return ["npx", ["astro", "check"]];
  return undefined;
}

/**
 * pre-commit: the anti-slop lint over staged files, then a typecheck of each
 * workspace the commit touches.
 */
export function precommitPlan(root, files) {
  if (!files.length) return [];
  return [step("slop lint (staged files)", process.execPath, ["scripts/lint/slop.mjs", "--staged"]), ...typecheckSteps(root, files)];
}

/** A typecheck step for each workspace that holds one of `files`. */
function typecheckSteps(root, files) {
  const spaces = workspaces(root);
  const touched = new Set(files.map((f) => workspaceOf(spaces, f)).filter(Boolean));
  const steps = [];
  for (const w of spaces) {
    if (!touched.has(w)) continue;
    const cmd = typecheckCommand(w);
    // Typechecks only read, each in its own workspace, so the runner starts them together.
    if (cmd) steps.push({ ...step(`typecheck ${w.name}`, cmd[0], cmd[1], w.dir), together: true });
  }
  return steps;
}

/** Past this many pushed files the lint reads the whole tree: the paths would not fit a Windows command line. */
export const LINT_PATHS_MAX = 200;

/**
 * pre-push: with `ranges` (the pushed commits), the gate's repo-hygiene check
 * first; then the anti-slop lint over the files the push changes and a
 * typecheck of each workspace it touches. No tests: CI runs them, and
 * `npm run gate` runs them here. The lint and the typecheck read the working
 * tree, which is the pushed commit unless there are uncommitted edits.
 */
export function prepushPlan(root, files, ranges) {
  const plan = [];
  // The gate's repo-hygiene check on the pushed commits: a users.noreply.github.com
  // author on each, no repo-local identity, no tracked agent files.
  if (ranges?.length && existsSync(join(root, "scripts/gate/hygiene.mjs"))) {
    plan.push(step("commit identity and private files", process.execPath, ["scripts/gate/hygiene.mjs", ...ranges]));
  }
  // A file the push deletes is in the diff and not on disk; the lint has nothing to read there.
  const present = files.filter((f) => existsSync(join(root, f)));
  if (present.length) {
    const whole = present.length > LINT_PATHS_MAX;
    plan.push(step(whole ? "slop lint (whole tree)" : "slop lint (pushed files)", process.execPath, whole ? ["scripts/lint/slop.mjs"] : ["scripts/lint/slop.mjs", ...present]));
  }
  plan.push(...typecheckSteps(root, files));
  return plan;
}

/** Staged paths (added, copied, modified, renamed). */
export function stagedFiles(root) {
  const r = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  return r.ok && r.out ? r.out.split("\n") : [];
}

/**
 * Files a push changes. `stdin` holds git's pre-push lines
 * (`<local ref> <local sha> <remote ref> <remote sha>`). A new remote branch
 * is diffed against where it forked from the remote's default branch; with
 * no such base, every file counts.
 */
export function pushedFiles(root, stdin, remote = "origin") {
  const files = new Set();
  for (const { base, local } of pushes(root, stdin, remote)) {
    const r = git(root, ["diff", "--name-only", base ?? EMPTY_TREE, local]);
    if (r.ok && r.out) for (const f of r.out.split("\n")) files.add(f);
  }
  return [...files];
}

/**
 * The commit ranges a push sends, as `base..local` (or `local` alone when there
 * is no base, so every commit counts). Read from the same pre-push lines.
 */
export function pushedRanges(root, stdin, remote = "origin") {
  return pushes(root, stdin, remote).map(({ base, local }) => (base ? `${base}..${local}` : local));
}

function pushes(root, stdin, remote) {
  const out = [];
  for (const line of stdin.split("\n")) {
    const [, local, , remoteSha] = line.trim().split(/\s+/);
    if (!local || ZERO.test(local)) continue;
    let base = remoteSha && !ZERO.test(remoteSha) && git(root, ["cat-file", "-e", `${remoteSha}^{commit}`]).ok ? remoteSha : undefined;
    if (!base) {
      for (const ref of [`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`, "refs/heads/main"]) {
        const mb = git(root, ["merge-base", local, ref]);
        if (mb.ok && mb.out && mb.out !== local) {
          base = mb.out;
          break;
        }
      }
    }
    out.push({ base, local });
  }
  return out;
}
