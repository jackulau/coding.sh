// Runs the anti-slop rules over files and applies the allowlist. No process
// exit, no printing: slop.mjs is the CLI. Zero dependencies.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { lineOf, lineStarts } from "./source.mjs";
import { RULES } from "./rules.mjs";

/**
 * Paths no rule reads: dependencies, build output, recorded fixtures, and
 * hidden folders other than .github (nested worktrees, agent workspaces).
 */
export const SKIP = /(?:^|\/)(?:node_modules|dist|vendor|fixtures?)\/|(?:^|\/)\.(?!github\/)[^/]+\//;

const git = (root, args, input) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, input });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
};

/** Tracked files plus untracked ones git does not ignore, repo-relative. */
export function repoFiles(root, under = []) {
  const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...under]);
  return [...new Set(out.split("\0").filter(Boolean))].filter((p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile());
}

/** Files staged for commit (added, copied, modified, renamed). */
export function stagedFiles(root) {
  return git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]).split("\0").filter(Boolean);
}

/** The staged content of a file. */
export const stagedContent = (root, path) => git(root, ["show", `:${path}`]);

/**
 * Repo docs the site renders as pages: the keys of SITE_PAGES in the docs
 * markdown renderer, plus CHANGELOG.md for /changelog.
 */
export function siteDocs(root) {
  const docs = new Set();
  const renderer = join(root, "apps/site/src/components/docs/markdown.ts");
  if (existsSync(renderer)) {
    const src = readFileSync(renderer, "utf8");
    const block = /SITE_PAGES[^{]*\{([\s\S]*?)\n\};/.exec(src);
    for (const m of (block?.[1] ?? "").matchAll(/"([^"]+\.md)"\s*:/g)) docs.add(`docs/${m[1]}`);
  }
  if (existsSync(join(root, "apps/site/src/lib/changelog.ts"))) docs.add("CHANGELOG.md");
  return docs;
}

// ---------------------------------------------------------------- allowlist

/** `**` matches across slashes, `*` within one segment. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Validates allowlist entries; throws with the entry index on a bad one. */
export function parseAllowlist(json, ruleIds) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  entries.forEach((e, i) => {
    const where = `allowlist entry ${i}`;
    if (!ruleIds.includes(e?.rule)) throw new Error(`${where}: unknown rule ${JSON.stringify(e?.rule)} (expected ${ruleIds.join(", ")})`);
    if (typeof e.path !== "string" || !e.path) throw new Error(`${where}: "path" must be a file path or glob`);
    if (typeof e.reason !== "string" || !e.reason.trim()) throw new Error(`${where}: "reason" must say why the exception is allowed`);
    if (e.max !== undefined && !(Number.isInteger(e.max) && e.max > 0)) throw new Error(`${where}: "max" must be a positive integer`);
  });
  return entries.map((e) => ({ ...e, re: globToRegExp(e.path) }));
}

/** An inline exception: `slop-allow <rule>[, <rule>]: <reason>` on the line or the line above. */
const INLINE = /slop-allow\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s*(?::|--)\s*(\S.*)?/;

function inlineAllowed(lines, line, rule) {
  for (const l of [lines[line - 1], lines[line - 2]]) {
    const m = l && INLINE.exec(l);
    if (m && m[2] && m[1].split(/\s*,\s*/).includes(rule)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- lint

/**
 * Lints `files` (repo-relative). `read(path)` returns the content. Returns
 * every finding with `allowed` set when the allowlist or an inline comment
 * covers it, plus per-entry usage for spotting stale counts.
 */
export function lintFiles(files, { read, rules = RULES, allowlist = [], site = new Set() }) {
  const linted = new Set();
  const findings = [];
  const counts = new Map();
  for (const path of files) {
    if (SKIP.test(path)) continue;
    const active = rules.filter((r) => r.applies(path, site));
    if (!active.length) continue;
    const src = read(path);
    if (src === undefined) continue;
    linted.add(path);
    const starts = lineStarts(src);
    const lines = src.split("\n");
    for (const rule of active) {
      const own = [];
      for (const f of rule.check(path, src)) {
        const line = lineOf(starts, f.offset);
        const column = f.offset - starts[line - 1] + 1;
        if (inlineAllowed(lines, line, rule.id)) continue;
        own.push({ rule: rule.id, path, line, column, message: f.message, text: (lines[line - 1] ?? "").trim().slice(0, 160) });
      }
      own.sort((a, b) => a.line - b.line || a.column - b.column);
      // Two rules can match the same spot through overlapping views; keep one.
      const unique = own.filter((f, i) => i === 0 || f.line !== own[i - 1].line || f.column !== own[i - 1].column);
      if (!unique.length) continue;
      const entry = allowlist.find((e) => e.rule === rule.id && e.re.test(path));
      if (entry) {
        const used = (counts.get(entry) ?? 0) + unique.length;
        counts.set(entry, used);
      }
      const over = entry?.max !== undefined && unique.length > entry.max && !/[*?]/.test(entry.path);
      for (const f of unique) findings.push(over ? { ...f, allowed: false, over: { allowed: entry.max, found: unique.length } } : { ...f, allowed: Boolean(entry) });
    }
  }
  const stale = allowlist
    .filter((e) => e.max !== undefined && !/[*?]/.test(e.path))
    .map((e) => ({ rule: e.rule, path: e.path, max: e.max, found: counts.get(e) ?? 0 }))
    .filter((s) => s.found < s.max && linted.has(s.path));
  return { findings, stale };
}

/**
 * The allowlist after `--update-allowlist`: count entries follow the current
 * counts (dropped at zero), glob and uncounted entries stay, and files with
 * findings no entry covers get a baseline entry.
 */
export function updatedAllowlist(entries, findings, today) {
  const perFile = new Map();
  for (const f of findings) {
    const key = `${f.rule}\0${f.path}`;
    perFile.set(key, (perFile.get(key) ?? 0) + 1);
  }
  const out = [];
  const covered = new Set();
  for (const e of entries) {
    const { re, ...plain } = e;
    if (e.max === undefined || /[*?]/.test(e.path)) {
      out.push(plain);
      for (const key of perFile.keys()) {
        const [rule, path] = key.split("\0");
        if (rule === e.rule && re.test(path)) covered.add(key);
      }
      continue;
    }
    const key = `${e.rule}\0${e.path}`;
    const n = perFile.get(key) ?? 0;
    covered.add(key);
    if (n > 0) out.push({ ...plain, max: n });
  }
  for (const [key, n] of perFile) {
    if (covered.has(key)) continue;
    const [rule, path] = key.split("\0");
    out.push({ rule, path, max: n, reason: `baseline ${today}: existing code, do not add more` });
  }
  return out.sort((a, b) => a.rule.localeCompare(b.rule) || a.path.localeCompare(b.path));
}
