// Which test files the quick CI run of a pull request needs, from the paths its diff changed.
// scripts/test-ci.mjs asks this only when the workflow set TEST_SELECT (a pull request without the
// `ready` label); pushes and the full suite never do. The answer is every test file unless every
// changed path has a rule below. Anything else runs everything: a path no rule knows, a path that
// is gone (a rename is a delete and an add), a manifest, a lockfile, a compiler config, a fixture,
// a golden, a helper no test file uses, a new file at the top of the repository, an empty diff, an
// error.
//
// The rules, each measured before it was written (CONTRIBUTING.md "Pull requests"):
//   - a changed test file runs, with the test files that import it;
//   - a changed helper under test/ runs the test files that reach it;
//   - docs/, apps/site/, a root *.md, the files of .github/ that are not workflows, and the other
//     packages run the test files that name the changed directory, package or file.
// A test file reaches the code files under test/ and scripts/ that it imports, and the ones whose
// file name it writes (a script it spawns), and whatever those reach. It names a word when its own
// text or the text of a file it reaches holds it. src/ is not followed: it reads nothing outside
// this package, and a change under src/ runs everything.
//
//   node scripts/test-select.ts <base>   what a quick run of HEAD against <base> would run
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { testFiles } from "./test-shards.ts";

export type Selection = { all: true; why: string } | { all: false; files: string[]; why: string[] };

/** Test files every narrowed run keeps: the ones that list test/ and test/verify, and the checks of these rules. */
export const ALWAYS = ["test/scripts/test-select.test.ts", "test/scripts/test-shards.test.ts", "test/scripts/verify-deep.test.ts"];

const CODE = /\.(ts|mts|cts|mjs|cjs|js)$/;
/** npm, tsc and pip read these wherever they are, so no rule can place them. */
const MANIFEST = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|[^/]+\.lock|pnpm-lock\.yaml|tsconfig[^/]*\.json|pyproject\.toml|\.npmrc)$/;
/** Under test/: directories of recorded data. A test finds these by listing, not by name. */
const DATA_DIR = /(^|\/)(fixtures|golden)\//;

/**
 * Paths outside this package that a run narrows on, and the name a test that reads one writes:
 * the top-level directory or file, or the package directory. `listed`: the CLI lists the
 * directory when a test runs it from inside the repository, so a new file there has no rule.
 */
export const OUTSIDE: { path: RegExp; name: (m: RegExpExecArray) => string; listed?: true }[] = [
  { path: /^docs\//, name: () => "docs" },
  { path: /^apps\/site\//, name: () => "apps" },
  { path: /^[^/]+\.md$/, name: (m) => m[0], listed: true },
  { path: /^\.github\/(ISSUE_TEMPLATE\/|[^/]+\.md$)/, name: () => ".github" },
  { path: /^packages\/(sdk|sdk-python|store-postgres|store-clickhouse|blob-s3)\//, name: (m) => m[1]! },
];

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SPEC = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** The code files under test/ and scripts/ of the package at `dir`, and what each reaches. */
function tree(dir: string): { tests: string[]; text: (f: string) => string; reach: (f: string) => Set<string> } {
  const code: string[] = [];
  for (const top of ["test", "scripts"]) {
    if (!existsSync(join(dir, top))) continue;
    for (const e of readdirSync(join(dir, top), { recursive: true, withFileTypes: true })) {
      if (e.isFile() && CODE.test(e.name)) code.push(posix.join(relative(dir, e.parentPath).replaceAll("\\", "/"), e.name));
    }
  }
  const known = new Set(code);
  const texts = new Map<string, string>();
  const text = (f: string): string => texts.get(f) ?? (texts.set(f, readFileSync(join(dir, f), "utf8")), texts.get(f)!);
  // A file name counts as written when it stands alone: `helpers.ts` is not in `_helpers.ts`.
  const byName = new Map<string, string[]>();
  for (const f of code) if (!f.endsWith(".test.ts")) byName.set(posix.basename(f), [...(byName.get(posix.basename(f)) ?? []), f]);
  const named = [...byName].map(([name, files]) => ({ files, re: new RegExp(`(?<![\\w.-])${escape(name)}(?!\\w)`) }));
  const edges = new Map<string, string[]>();
  const edgesOf = (f: string): string[] => {
    let out = edges.get(f);
    if (out) return out;
    out = [];
    // An import that resolves is an edge to that one file; what is left is searched for names.
    const rest = text(f).replace(SPEC, (all: string, spec: string) => {
      const target = spec.startsWith(".") ? posix.normalize(posix.join(posix.dirname(f), spec)) : "";
      if (!known.has(target)) return all;
      out!.push(target);
      return "";
    });
    for (const { files, re } of named) if (re.test(rest)) for (const g of files) if (g !== f) out.push(g);
    edges.set(f, out);
    return out;
  };
  const reach = (f: string): Set<string> => {
    const seen = new Set([f]);
    const queue = [f];
    while (queue.length) for (const next of edgesOf(queue.pop()!)) if (!seen.has(next)) (seen.add(next), queue.push(next));
    return seen;
  };
  return { tests: code.filter((f) => f.startsWith("test/") && f.endsWith(".test.ts")).sort(), text, reach };
}

/**
 * The test files a diff needs. `changed` holds paths relative to `root` (the repository), with
 * forward slashes; `added` holds the ones the diff creates; `pkg` is this package's directory.
 */
export function selectTests(changed: string[], root: string, pkg = "packages/coding.sh", added: ReadonlySet<string> = new Set()): Selection {
  if (changed.length === 0) return { all: true, why: "the diff is empty" };
  // Read only when a rule asks: a diff that runs everything costs nothing.
  let built: ReturnType<typeof tree> & { reaches: Map<string, Set<string>> } | undefined;
  const t = (): NonNullable<typeof built> => {
    if (!built) {
      const made = tree(join(root, pkg));
      built = { ...made, reaches: new Map(made.tests.map((f) => [f, made.reach(f)])) };
    }
    return built;
  };
  const users = (file: string): string[] => t().tests.filter((f) => f !== file && t().reaches.get(f)!.has(file));
  const naming = (word: string): string[] => t().tests.filter((f) => [...t().reaches.get(f)!].some((g) => t().text(g).includes(word)));

  const rules = new Map<string, { files: Set<string>; paths: string[] }>();
  // The paths that need no reading to refuse come first: one of them and nothing is read.
  let unplaced = changed.flatMap((path) => (refuse(path) ? [`${path} ${refuse(path)}`] : []));
  for (const path of unplaced.length ? [] : changed) {
    const placed = place(path);
    if (typeof placed === "string") {
      unplaced = [...unplaced, `${path} ${placed}`];
      continue;
    }
    const rule = rules.get(placed.rule) ?? { files: new Set<string>(), paths: [] };
    for (const f of placed.files) rule.files.add(f);
    rule.paths.push(path);
    rules.set(placed.rule, rule);
  }
  if (unplaced.length) return { all: true, why: `${unplaced[0]}${unplaced.length > 1 ? ` (and ${unplaced.length - 1} more of the ${changed.length} changed paths)` : ""}` };

  const files = new Set(ALWAYS.filter((f) => t().tests.includes(f)));
  const why: string[] = [];
  for (const [rule, { files: picked, paths }] of rules) {
    for (const f of picked) files.add(f);
    why.push(`${rule}: ${picked.size} test files, for ${paths.slice(0, 8).join(", ")}${paths.length > 8 ? ` and ${paths.length - 8} more` : ""}`);
  }
  why.push(`every narrowed run: ${ALWAYS.join(", ")}`);
  return { all: false, files: [...files].sort(), why };

  /** Why a changed path has no rule, as far as its name and the disk say; undefined when one may. */
  function refuse(path: string): string | undefined {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((s) => s === ".." || s === ".")) return "is not a path of the repository";
    if (MANIFEST.test(path)) return "is a manifest, a lockfile or a compiler config";
    if (!existsSync(join(root, path))) return "is deleted or renamed";
    if (path.startsWith(`${pkg}/test/`)) return DATA_DIR.test(path.slice(pkg.length + 1)) || !CODE.test(path) ? "is a fixture, a golden or a data file" : undefined;
    const outside = OUTSIDE.find((o) => o.path.test(path));
    if (!outside) return "has no rule that narrows it";
    return outside.listed && added.has(path) ? "is a new file at the top of the repository" : undefined;
  }

  /** The rule and test files for one changed path that `refuse` let through, or why it has none. */
  function place(path: string): { rule: string; files: string[] } | string {
    if (path.startsWith(`${pkg}/test/`)) {
      const file = path.slice(pkg.length + 1);
      if (file.endsWith(".test.ts")) return { rule: "a changed test file, and the test files that import it", files: [file, ...users(file)] };
      const using = users(file);
      return using.length ? { rule: "the test files that reach a changed helper", files: using } : "is a helper no test file imports or names";
    }
    for (const { path: re, name } of OUTSIDE) {
      const m = re.exec(path);
      if (m) return { rule: `the test files that name "${name(m)}"`, files: naming(name(m)) };
    }
    return "has no rule that narrows it";
  }
}

const git = (args: string[], cwd: string): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || String(r.error ?? r.status)).trim()}`);
  return r.stdout;
};

export type Picked = { files: string[]; narrowed: boolean; log: string[] };

/** The test files of `all` for the diff from `base` to HEAD, in the package at `cwd`. Throws on any error. */
export function selectFromDiff(all: string[], base: string, cwd: string): Picked {
  const root = git(["rev-parse", "--show-toplevel"], cwd).trim();
  const pkg = git(["rev-parse", "--show-prefix"], cwd).trim().replace(/\/$/, "");
  if (!pkg) throw new Error("the package is the repository root");
  // `--name-status -z`: a status letter, then its path, each ended by a NUL.
  const status = git(["diff", "--name-status", "--no-renames", "-z", base, "HEAD"], cwd).split("\0").filter(Boolean);
  if (status.length % 2) throw new Error("git diff printed a status without a path");
  const changed = status.filter((_, i) => i % 2 === 1);
  const added = new Set(changed.filter((_, i) => status[i * 2] === "A"));
  const picked = selectTests(changed, root, pkg, added);
  if (picked.all) return { files: all, narrowed: false, log: [`Running every test file: ${picked.why}`] };
  const ours = new Set(picked.files);
  const files = all.filter((f) => ours.has(f));
  if (files.length === 0) return { files: all, narrowed: false, log: ["Running every test file: the selection is empty"] };
  return { files, narrowed: true, log: [`Selected ${files.length} of ${all.length} test files for the ${changed.length} changed paths (${base}..HEAD):`, ...picked.why.map((w) => `  ${w}`)] };
}

/**
 * What scripts/test-ci.mjs runs. Narrows only when TEST_SELECT names the base commit and the
 * event itself is a pull request without the `ready` label. Never throws: an error runs `all`.
 */
export function selectForRun(all: string[], env: NodeJS.ProcessEnv, cwd: string): Picked {
  const everything = (why: string): Picked => ({ files: all, narrowed: false, log: [`Running every test file: ${why}`] });
  try {
    const base = env.TEST_SELECT;
    if (!base) return everything("TEST_SELECT is not set");
    if (env.GITHUB_EVENT_NAME !== "pull_request") return everything(`the event is ${env.GITHUB_EVENT_NAME || "not known"}, not pull_request`);
    const labels: { name: string }[] = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8")).pull_request.labels;
    if (labels.some((l) => l.name === "ready")) return everything("the pull request has the ready label");
    return selectFromDiff(all, base, cwd);
  } catch (err) {
    return everything(`the selection failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: node scripts/test-select.ts <base>");
    process.exit(2);
  }
  const picked = selectFromDiff(testFiles(process.cwd()), base, process.cwd());
  console.log(picked.log.join("\n"));
  if (picked.narrowed) console.log(picked.files.join("\n"));
}
