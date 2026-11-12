#!/usr/bin/env node
// Anti-slop lint for the coding.sh repo: chained `as` casts, unchecked
// `unknown` params, conditional empty spreads, barrel files and visible
// "sample"/"planned" text on the site. Zero dependencies.
//
//   node scripts/lint/slop.mjs                 # the whole tree
//   node scripts/lint/slop.mjs packages/sdk    # some paths
//   node scripts/lint/slop.mjs --staged        # what the next commit holds (pre-commit)
//
// Exceptions live in scripts/lint/allowlist.json or in a comment on the line
// (or the line above): `slop-allow <rule>: <reason>`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { lintFiles, parseAllowlist, repoFiles, siteDocs, stagedContent, stagedFiles, updatedAllowlist } from "./lib/lint.mjs";
import { RULE_IDS, RULES } from "./lib/rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

const FLAGS = [
  { name: "--staged", help: "Lint the staged version of staged files (what pre-commit runs)" },
  { name: "--rule", value: "id", help: `Run only this rule; repeatable. One of: ${RULE_IDS.join(", ")}` },
  { name: "--all", help: "Also print allowlisted findings" },
  { name: "--json", help: "Print one JSON document on stdout" },
  { name: "--strict-allowlist", help: "Fail when an allowlist count is higher than the findings it covers (the allowlist only shrinks)" },
  { name: "--update-allowlist", help: "Rewrite allowlist counts to the current tree (whole tree only)" },
  { name: "--allowlist", value: "file", help: "Allowlist file (default scripts/lint/allowlist.json)" },
  { name: "--root", value: "dir", help: "Repo root (default: this checkout)" },
  { name: "--list-rules", help: "Print the rules and exit" },
  { name: "--help", help: "Show this help (with --json: as data)" },
];

const USAGE = `Usage: node scripts/lint/slop.mjs [paths...] [flags]

Lints the repo for anti-slop patterns. Exit 0: clean; 1: findings; 2: usage.

Flags:
${FLAGS.map((f) => `  ${(f.name + (f.value ? ` <${f.value}>` : "")).padEnd(24)}${f.help}`).join("\n")}

Rules:
${RULES.map((r) => `  ${r.id.padEnd(26)}${r.description}`).join("\n")}

Examples:
  node scripts/lint/slop.mjs
  node scripts/lint/slop.mjs --staged
  node scripts/lint/slop.mjs packages/coding.sh/src --rule chained-as --json
`;

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const closest = (word, options) => options.map((o) => [o, distance(word, o)]).sort((x, y) => x[1] - y[1]).find(([, n]) => n <= 3)?.[0];

class UsageError extends Error {
  constructor(message, next) {
    super(message);
    this.next = next;
  }
}

export function parseArgs(argv) {
  const opts = { paths: [], rules: [], staged: false, all: false, json: false, strictAllowlist: false, update: false, listRules: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") ? a.split(/=(.*)/s, 2) : [a, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`, `node scripts/lint/slop.mjs ${flag} <value>`);
      return v;
    };
    if (flag === "--staged") opts.staged = true;
    else if (flag === "--all") opts.all = true;
    else if (flag === "--json") opts.json = true;
    else if (flag === "--strict-allowlist") opts.strictAllowlist = true;
    else if (flag === "--update-allowlist") opts.update = true;
    else if (flag === "--list-rules") opts.listRules = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else if (flag === "--root") opts.root = value();
    else if (flag === "--allowlist") opts.allowlist = value();
    else if (flag === "--rule") {
      const id = value();
      if (!RULE_IDS.includes(id)) {
        const near = closest(id, RULE_IDS);
        throw new UsageError(`unknown rule ${JSON.stringify(id)}${near ? ` (did you mean ${near}?)` : ""}`, `node scripts/lint/slop.mjs --rule ${near ?? RULE_IDS[0]}`);
      }
      opts.rules.push(id);
    } else if (flag.startsWith("-")) {
      const near = closest(flag, FLAGS.map((f) => f.name));
      throw new UsageError(`unknown flag ${flag}${near ? ` (did you mean ${near}?)` : ""}`, "node scripts/lint/slop.mjs --help");
    } else opts.paths.push(a);
  }
  if (opts.update && (opts.staged || opts.paths.length || opts.rules.length)) {
    throw new UsageError("--update-allowlist reads the whole tree; drop --staged, --rule and paths", "node scripts/lint/slop.mjs --update-allowlist");
  }
  if (opts.strictAllowlist && (opts.staged || opts.paths.length || opts.rules.length)) {
    throw new UsageError("--strict-allowlist compares counts over the whole tree; drop --staged, --rule and paths", "node scripts/lint/slop.mjs --strict-allowlist");
  }
  if (opts.staged && opts.paths.length) throw new UsageError("--staged lints staged files; drop the paths", "node scripts/lint/slop.mjs --staged");
  return opts;
}

const fmt = (f) => `${f.path}:${f.line}:${f.column}  ${f.rule}  ${f.message}${f.over ? ` [file has ${f.over.found}, allowlist allows ${f.over.allowed}]` : ""}\n    ${f.text}`;

/** Runs the lint; returns the exit code. Writes to the given streams. */
export function main(argv, { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    const json = argv.includes("--json");
    if (json) stdout.write(`${JSON.stringify({ ok: false, error: { reason: "usage", message: e.message, next: e.next, retryable: false } })}\n`);
    else stderr.write(`error: ${e.message}\nnext: ${e.next}\n`);
    return 2;
  }
  if (opts.help) {
    if (opts.json) stdout.write(`${JSON.stringify({ usage: "node scripts/lint/slop.mjs [paths...] [flags]", flags: FLAGS, rules: RULES.map(({ id, description }) => ({ id, description })), exitCodes: { 0: "clean", 1: "findings", 2: "usage" } })}\n`);
    else stdout.write(USAGE);
    return 0;
  }
  if (opts.listRules) {
    if (opts.json) stdout.write(`${JSON.stringify(RULES.map(({ id, description }) => ({ id, description })))}\n`);
    else for (const r of RULES) stdout.write(`${r.id}\t${r.description}\n`);
    return 0;
  }

  const root = resolve(cwd, opts.root ?? DEFAULT_ROOT);
  const allowlistPath = resolve(cwd, opts.allowlist ?? join(root, "scripts/lint/allowlist.json"));
  let entries;
  try {
    entries = parseAllowlist(readFileSync(allowlistPath, "utf8"), RULE_IDS);
  } catch (e) {
    if (e.code !== "ENOENT") {
      stderr.write(`error: ${allowlistPath}: ${e.message}\nnext: fix the entry, then rerun\n`);
      return 2;
    }
    entries = [];
  }

  let files;
  let read;
  try {
    if (opts.staged) {
      files = stagedFiles(root);
      read = (p) => stagedContent(root, p);
    } else {
      const under = opts.paths.map((p) => relative(root, resolve(cwd, p)).split(sep).join("/") || ".");
      const outside = under.find((p) => p.startsWith(".."));
      if (outside) throw new UsageError(`${outside} is outside the repo at ${root}`, "node scripts/lint/slop.mjs <path inside the repo>");
      files = repoFiles(root, under);
      read = (p) => readFileSync(join(root, p), "utf8");
    }
  } catch (e) {
    const usage = e instanceof UsageError;
    if (opts.json) stdout.write(`${JSON.stringify({ ok: false, error: { reason: usage ? "usage" : "git_failed", message: e.message, next: usage ? e.next : "run it inside a git checkout", retryable: false } })}\n`);
    else stderr.write(`error: ${e.message}\nnext: ${usage ? e.next : "run it inside a git checkout"}\n`);
    return 2;
  }

  const rules = opts.rules.length ? RULES.filter((r) => opts.rules.includes(r.id)) : RULES;
  const { findings, stale } = lintFiles(files, { read, rules, allowlist: entries, site: siteDocs(root) });

  if (opts.update) {
    const today = new Date().toISOString().slice(0, 10);
    const next = updatedAllowlist(entries, findings, today);
    const doc = { $comment: "Exceptions to scripts/lint/slop.mjs. `max` caps findings in that file; lower it as code is fixed, never raise it to fit new code. See CONTRIBUTING.md.", entries: next };
    mkdirSync(dirname(allowlistPath), { recursive: true });
    writeFileSync(allowlistPath, `${JSON.stringify(doc, null, 2)}\n`);
    stderr.write(`allowlist: ${next.length} entries written to ${relative(cwd, allowlistPath) || allowlistPath}\n`);
    if (opts.json) stdout.write(`${JSON.stringify({ ok: true, entries: next.length })}\n`);
    return 0;
  }

  const failing = findings.filter((f) => !f.allowed);
  // A count above what the file holds is room for new findings; --strict-allowlist closes it.
  const loose = opts.strictAllowlist ? stale : [];
  const shown = opts.all ? findings : failing;
  if (opts.json) {
    stdout.write(`${JSON.stringify({ ok: failing.length === 0 && loose.length === 0, files: new Set(findings.map((f) => f.path)).size, findings: shown, allowlisted: findings.length - failing.length, stale })}\n`);
  } else {
    for (const f of shown) stdout.write(`${fmt(f)}${f.allowed ? "  (allowlisted)" : ""}\n`);
    for (const s of stale) stderr.write(`allowlist: ${s.path} has ${s.found} ${s.rule} (max ${s.max}); lower it with --update-allowlist${loose.length ? " (--strict-allowlist: this fails the lint)" : ""}\n`);
    const n = failing.length;
    if (n) stderr.write(`slop lint: ${n} finding${n === 1 ? "" : "s"} (${findings.length - n} allowlisted). Fix them, or add \`slop-allow <rule>: <reason>\` on the line.\n`);
    else if (loose.length) stderr.write(`slop lint: ${loose.length} stale allowlist entr${loose.length === 1 ? "y" : "ies"}. Lower them: node scripts/lint/slop.mjs --update-allowlist\n`);
    else stderr.write(`slop lint: clean (${files.length} files, ${findings.length} allowlisted)\n`);
  }
  return failing.length || loose.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
