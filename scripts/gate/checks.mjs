// The checks `npm run gate` runs in-process: repo hygiene (git identity, private
// agent files), branch freshness, adapter version bumps and the dist secret scan.
// Each takes the repo root and returns { status, detail }: status is "pass",
// "fail", "warn" or "skip"; detail is the lines to print. Reads git; never writes.
// Zero dependencies.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SECRET_PATTERNS } from "../release/secret-patterns.mjs";
import { archiveEntries } from "./archive.mjs";

export const NOREPLY = /@users\.noreply\.github\.com$/;

/** Runs git in `root`; `env` lets a test keep the user's config out. */
export function git(root, args, env = process.env) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const lines = (s) => (s ? s.split("\n") : []);
const result = (status, detail = []) => ({ status, detail });

// ---------------------------------------------------------------- repo-hygiene

/** Repo-local `user.email` / `user.name`: commits must use the global identity. */
export function localIdentity(root, env) {
  const found = [];
  for (const key of ["user.email", "user.name"]) if (git(root, ["config", "--local", "--get", key], env).out) found.push(key);
  return found;
}

/**
 * Commits in `range` whose author email is not allowed. With `expected` the
 * email must equal it; with `noreply` (the default) it must end in
 * @users.noreply.github.com. Merge commits and bot accounts pass.
 */
export function badAuthors(root, range, { expected, noreply = true, env } = {}) {
  const r = git(root, ["log", "--format=%H%x09%ae%x09%P%x09%an", range], env);
  if (!r.ok) return { error: r.err || `git log ${range} failed`, bad: [] };
  const bad = [];
  for (const row of lines(r.out)) {
    const [sha, email, parents, name] = row.split("\t");
    if ((parents ?? "").trim().includes(" ") || /\[bot\]$/.test(name ?? "")) continue;
    if ((noreply && !NOREPLY.test(email)) || (expected && email !== expected)) bad.push({ sha, email });
  }
  return { bad };
}

/**
 * A push range whose base this clone lacks (a new branch's all-zero `before`, or
 * a force-push that dropped it) can't be logged. Then only the pushed commit is
 * checked, with a note.
 */
export function usableRange(root, range, env) {
  const m = /^([^.\s]+)\.\.([^.\s]+)$/.exec(range ?? "");
  if (!m) return { range };
  const [, from, to] = m;
  if (!/^0+$/.test(from) && git(root, ["cat-file", "-e", `${from}^{commit}`], env).ok) return { range };
  const hasParent = git(root, ["rev-parse", "-q", "--verify", `${to}^`], env).ok;
  return {
    range: hasParent ? `${to}^..${to}` : to,
    note: `the push's base ${from.slice(0, 10)} is not in this clone (a new branch or a force-push); checked ${to.slice(0, 10)} alone`,
  };
}

/** Tracked files under the private agent folders, and whether .claude stays ignored. */
export function privateFiles(root, env) {
  const tracked = lines(git(root, ["ls-files", "--", ".claude", ".claude-workspace", "tasks"], env).out);
  // --no-index: the answer is what .gitignore says, even when a .claude file is tracked.
  const ignored = git(root, ["check-ignore", "-q", "--no-index", ".claude/skills/x/SKILL.md"], env).ok;
  return { tracked, ignored };
}

/** Paths trimmed to two segments with a count, so a message never names a private file. */
const folders = (paths) => {
  const counts = new Map();
  for (const p of paths) {
    const k = p.split("/").slice(0, 2).join("/");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k} (${n} file${n === 1 ? "" : "s"})`);
};

/**
 * `range` is the commit range to check ("origin/main..HEAD", or a pushed
 * range in CI). Locally every commit must be authored with the global
 * identity, whatever address a contributor uses; a global address that is not
 * a users.noreply.github.com one is a note. `ci` checks only the noreply
 * suffix of a pushed range.
 */
export function repoHygiene(root, { env = process.env, range, ci = false } = {}) {
  const fail = [];
  const note = [];
  const local = localIdentity(root, env);
  if (local.length) fail.push(`repo-local git identity set (${local.join(", ")}); unset it, commits use the global one: git config --local --unset-all user.email`);
  const usable = usableRange(root, range, env);
  if (usable.note) note.push(usable.note);
  let base = usable.range;
  if (!base && !ci) base = git(root, ["rev-parse", "--verify", "-q", "origin/main"], env).ok ? "origin/main..HEAD" : undefined;
  if (base) {
    const expected = ci ? undefined : git(root, ["config", "--global", "--get", "user.email"], env).out;
    const commits = Number(git(root, ["rev-list", "--count", base], env).out || 0);
    if (!ci && !expected) {
      if (commits > 0) fail.push("global git user.email is not set; commits need the global identity: git config --global user.email <your address>");
    } else {
      if (!ci && !NOREPLY.test(expected)) note.push("global git user.email is not a users.noreply.github.com address; GitHub links a commit to an account only when the address is on it");
      const { bad, error } = badAuthors(root, base, { expected, noreply: ci, env });
      if (error) fail.push(error);
      for (const b of bad) fail.push(`commit ${b.sha.slice(0, 10)} is authored by ${b.email}; amend it with the global identity (git commit --amend --reset-author)`);
    }
  } else note.push(ci ? "no push range; commit authors not checked" : "origin/main not found; commit authors not checked");
  const priv = privateFiles(root, env);
  if (priv.tracked.length) fail.push(`private agent files are tracked: ${folders(priv.tracked).join(", ")}; git rm --cached them`);
  if (!priv.ignored) fail.push("private agent files are not ignored: .gitignore needs a /.claude/ line");
  return fail.length ? result("fail", fail) : result("pass", note);
}

// ---------------------------------------------------------------- branch-fresh

/** Folders whose tests and lint rules a stale branch would not run. */
export const FRESH_PATHS = ["apps/site/test", "scripts/lint", "packages/coding.sh/test/docs"];

export function branchFresh(root, { env = process.env } = {}) {
  if (!git(root, ["rev-parse", "--verify", "-q", "origin/main"], env).ok) return result("warn", ["origin/main not found; cannot tell whether this branch is fresh (git fetch origin)"]);
  if (git(root, ["merge-base", "--is-ancestor", "origin/main", "HEAD"], env).ok) return result("pass");
  const mb = git(root, ["merge-base", "origin/main", "HEAD"], env).out;
  const changed = lines(git(root, ["diff", "--name-only", mb, "origin/main", "--", ...FRESH_PATHS], env).out);
  if (changed.length) return result("fail", ["origin/main changed tests and lint rules this branch has not run; rebase onto origin/main:", ...changed.map((p) => `  ${p}`)]);
  return result("warn", ["origin/main has moved on; rebase onto origin/main before you open a pull request"]);
}

// ---------------------------------------------------------------- adapter-versions

const ADAPTER_SRC = /^packages\/coding\.sh\/src\/adapters\/(?:.*\/)?([^/]+)\.ts$/;
const ADAPTER_GOLDEN = (name) => new RegExp(`^packages/coding\\.sh/test/fixtures/adapters/${name}/`);
const GOLDEN_FILE = /^packages\/coding\.sh\/test\/.*\.golden\.json$/;
/** True when a diff changes the number a `name: 12` or `name = 12` line holds, not just a line around it. */
function versionChanged(name, diff) {
  const re = new RegExp(`\\b${name}\\s*[:=]\\s*(\\d+)`);
  const seen = { "-": new Set(), "+": new Set() };
  for (const line of diff.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++") || !(line[0] in seen)) continue;
    const m = re.exec(line);
    if (m) seen[line[0]].add(m[1]);
  }
  return [...seen["+"]].some((v) => !seen["-"].has(v));
}

/**
 * An adapter whose golden changed needs a parseVersion bump; goldens that hold
 * session stats need a SESSION_FOLD_VERSION bump. A warning, not a failure:
 * a golden can change for a reason that needs neither.
 */
export function adapterVersions(root, { env = process.env, base } = {}) {
  let from = base;
  if (!from) {
    const mb = git(root, ["merge-base", "origin/main", "HEAD"], env);
    if (!mb.ok) return result("skip", ["origin/main not found; no base to compare adapters against"]);
    from = mb.out;
  }
  const changed = lines(git(root, ["diff", "--name-only", from, "--"], env).out);
  const diffOf = (p) => git(root, ["diff", from, "--", p], env).out;
  const warn = [];
  for (const file of changed) {
    const m = ADAPTER_SRC.exec(file);
    if (!m || m[1] === "index") continue;
    const golden = ADAPTER_GOLDEN(m[1]);
    if (!changed.some((c) => golden.test(c))) continue;
    if (!versionChanged("parseVersion", diffOf(file))) warn.push(`${file} changed with its golden under test/fixtures/adapters/${m[1]}/; bump parseVersion so stored sessions are parsed again`);
  }
  const statGoldens = changed.filter((c) => GOLDEN_FILE.test(c) && /"stats"/.test(readIfExists(join(root, c))));
  if (statGoldens.length && !versionChanged("SESSION_FOLD_VERSION", diffOf("packages/coding.sh/src/core/sessions.ts"))) {
    warn.push(`${statGoldens[0]}${statGoldens.length > 1 ? ` and ${statGoldens.length - 1} more` : ""} hold session stats; bump SESSION_FOLD_VERSION in src/core/sessions.ts so stored sessions are folded again`);
  }
  return warn.length ? result("warn", warn) : result("pass");
}

function readIfExists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- secret-scan

const BINARY = /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mov|zip|gz|tgz|whl|pdf|wasm|br)$/i;
const MAX_BYTES = 32 * 1024 * 1024;

/** The build outputs that ship: each package's dist, the site's and the Python SDK's. */
export function distRoots(root) {
  const roots = [];
  const packages = join(root, "packages");
  if (existsSync(packages)) for (const d of readdirSync(packages)) roots.push(join("packages", d, "dist"));
  roots.push(join("apps", "site", "dist"));
  return roots.filter((r) => existsSync(join(root, r)));
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/**
 * Scans built output for vendor-shaped secrets. With no dist at all it fails,
 * unless `static` (a run before any build).
 */
export function secretScan(root, { static: isStatic = false } = {}) {
  const roots = distRoots(root);
  if (!roots.length) return isStatic ? result("pass", ["no dist built; nothing to scan"]) : result("fail", ["no dist found under packages/*/dist or apps/site/dist; build first (npm run build)"]);
  const hits = [];
  let files = 0;
  const scan = (label, text) => {
    for (const p of SECRET_PATTERNS) if (p.re.test(text)) hits.push(`${label}: ${p.name}`);
  };
  for (const r of roots) {
    for (const file of walk(join(root, r))) {
      if (statSync(file).size > MAX_BYTES) continue;
      const label = file.slice(root.length + 1);
      // A wheel or sdist is what PyPI gets: scan each file inside it.
      let entries;
      try {
        entries = archiveEntries(file, readFileSync(file));
      } catch (e) {
        hits.push(`${label}: can't be read as an archive (${e.message})`);
        continue;
      }
      if (entries) {
        for (const e of entries) {
          if (BINARY.test(e.name) || e.data.length > MAX_BYTES) continue;
          files++;
          scan(`${label}!${e.name}`, e.data.toString("utf8"));
        }
        continue;
      }
      if (BINARY.test(file)) continue;
      files++;
      scan(label, readFileSync(file, "utf8"));
    }
  }
  return hits.length ? result("fail", ["built output holds something that looks like a secret:", ...hits.map((h) => `  ${h}`)]) : result("pass", [`${files} files in ${roots.length} dist folder${roots.length === 1 ? "" : "s"}`]);
}
