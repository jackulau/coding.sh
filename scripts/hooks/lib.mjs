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

/**
 * The npm workspaces under `root` that have a package.json: their directory,
 * package name, scripts and the names of the workspaces they depend on.
 */
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
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
    found.push({ dir, name: pkg.name, scripts: pkg.scripts ?? {}, deps });
  }
  const names = new Set(found.map((w) => w.name));
  for (const w of found) w.deps = w.deps.filter((d) => names.has(d));
  return found;
}

/** The workspace a repo-relative path belongs to, or undefined. */
export const workspaceOf = (spaces, path) => spaces.find((w) => path === w.dir || path.startsWith(`${w.dir}/`));

/** Workspaces that depend on any of `names`, directly or through another workspace. */
export function dependents(spaces, names) {
  const out = new Set(names);
  for (let grew = true; grew; ) {
    grew = false;
    for (const w of spaces) if (!out.has(w.name) && w.deps.some((d) => out.has(d))) out.add(w.name), (grew = true);
  }
  return spaces.filter((w) => out.has(w.name));
}

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
  const plan = [step("slop lint (staged files)", process.execPath, ["scripts/lint/slop.mjs", "--staged"])];
  const spaces = workspaces(root);
  const touched = new Set(files.map((f) => workspaceOf(spaces, f)).filter(Boolean));
  for (const w of spaces) {
    if (!touched.has(w)) continue;
    const cmd = typecheckCommand(w);
    if (cmd) plan.push(step(`typecheck ${w.name}`, cmd[0], cmd[1], w.dir));
  }
  return plan;
}

/** Repo scripts with their own tests, by path prefix. */
const SCRIPT_SUITES = [
  { prefix: ["scripts/lint/", "scripts/hooks/"], label: "lint and hook tests", args: ["--test", "scripts/lint/test/*.test.mjs", "scripts/hooks/test/*.test.mjs"] },
  { prefix: ["scripts/dogfood/"], label: "dogfood tests", args: ["--test", "scripts/dogfood/test/*.test.mjs"] },
];

/**
 * pre-push: with `ranges` (the pushed commits), the gate's repo-hygiene check
 * first; then the tests of each workspace the pushed commits touch and of the
 * workspaces that depend on it (a coding.sh change runs the store plugins'
 * tests too), the Python SDK's tests, and the repo scripts' own tests.
 */
export function prepushPlan(root, files, ranges) {
  const spaces = workspaces(root);
  const touched = [...new Set(files.map((f) => workspaceOf(spaces, f)).filter(Boolean))];
  const plan = [];
  // The gate's repo-hygiene check on the pushed commits: a users.noreply.github.com
  // author on each, no repo-local identity, no tracked agent files.
  if (ranges?.length && existsSync(join(root, "scripts/gate/hygiene.mjs"))) {
    plan.push(step("commit identity and private files", process.execPath, ["scripts/gate/hygiene.mjs", ...ranges]));
  }
  for (const w of dependents(spaces, touched.map((t) => t.name))) {
    if (w.scripts.test) plan.push(step(`test ${w.name}${touched.includes(w) ? "" : " (depends on a changed package)"}`, "npm", ["test", "--silent"], w.dir));
  }
  const py = "packages/sdk-python";
  if (files.some((f) => f.startsWith(`${py}/`)) && existsSync(join(root, py, "tests"))) {
    plan.push(step("test coding-sh (Python)", process.platform === "win32" ? "python" : "python3", ["-m", "unittest", "discover", "-s", "tests", "-t", "tests"], py));
  }
  for (const s of SCRIPT_SUITES) {
    if (files.some((f) => s.prefix.some((p) => f.startsWith(p)))) plan.push(step(s.label, process.execPath, s.args));
  }
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
