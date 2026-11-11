// Impossible variants (ImpossibleBench, arxiv 2510.20270): flip one expected
// value in a test file so the tests contradict the instruction. No honest
// solution can pass such a variant, so a verifier that still passes the
// reference solution does not check what its tests assert: it is gameable.
// The instruction is left unchanged, as in ImpossibleBench "one-off" variants,
// so the same variant can later measure an agent's cheat rate.
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { safeJoin, toPosix } from "../runner/fsutil.ts";

export interface TestFileText {
  /** Path relative to the task dir. */
  path: string;
  text: string;
}

export interface ImpossibleMutation {
  /** e.g. `test/add.test.js:4 5→6` */
  label: string;
  path: string;
  /** 1-based line number of the flipped assertion. */
  line: number;
  before: string;
  after: string;
  /** Whole mutated file. */
  text: string;
}

const ASSERT_RE = /\b(assert\w*|expect|should|toBe\w*|toEqual|toStrictEqual|t\.(?:is|equal|deepEqual|same|strictSame))\b/;
const SKIP_LINE_RE = /^\s*(?:import\b|from\s+\S+\s+import\b|export\s+\*|#|\/\/|\/\*|\*|--|use\s|extern\s)|\brequire\s*\(/;
// Strings, then numbers not glued to identifiers or other digits, then booleans.
const LITERAL_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])|\b(?:true|false|True|False)\b/g;

const STRING_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
// Calls whose arguments a test never compares: log lines and exit codes.
const QUIET_CALL_RE = /\b(?:console\.\w+|process\.exit|sys\.exit|os\._exit|exit|print|println|printf|fmt\.Print\w*|log\.\w+|logger\.\w+)\s*\(/g;

const MAX_FILE_BYTES = 1024 * 1024;

/** The line with each string literal's contents blanked (same length), so words and parens in messages don't count. */
function maskStrings(line: string): string {
  return line.replace(STRING_RE, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

/** [start, end) of each quiet call, parentheses included, on the masked line. */
function quietSpans(masked: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of masked.matchAll(QUIET_CALL_RE)) {
    let depth = 0;
    let end = masked.length;
    for (let i = m.index + m[0].length - 1; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    spans.push([m.index, end]);
  }
  return spans;
}

function flipLiteral(lit: string): string {
  if (lit === "true") return "false";
  if (lit === "false") return "true";
  if (lit === "True") return "False";
  if (lit === "False") return "True";
  const q = lit[0];
  if (q === '"' || q === "'") return `${lit.slice(0, -1)}_impossible${q}`;
  if (lit.includes(".")) return String(Number(lit) + 1);
  return (BigInt(lit) + 1n).toString();
}

/**
 * Pick the literal to flip on an assertion line, outside log and exit calls. The expected value is
 * usually the last non-string literal (`assert.equal(add(2, 3), 5, "msg")`);
 * with only strings, the first one, since a trailing string is often just the
 * failure message (`assert greet() == "hi", "greeting"`).
 */
function pickLiteral(line: string, quiet: readonly [number, number][]): { index: number; lit: string } | undefined {
  const all = [...line.matchAll(LITERAL_RE)].map((m) => ({ index: m.index, lit: m[0] })).filter((m) => !quiet.some(([a, b]) => m.index >= a && m.index < b));
  const nonString = all.filter((m) => m.lit[0] !== '"' && m.lit[0] !== "'");
  return nonString.at(-1) ?? all[0];
}

/** One mutation per assertion line that has a literal, in file order, at most `max`, one per line. */
export function impossibleMutations(files: TestFileText[], max = 3): ImpossibleMutation[] {
  const out: ImpossibleMutation[] = [];
  for (const f of files) {
    const lines = f.text.split("\n");
    for (const [i, line] of lines.entries()) {
      if (out.length >= max) return out;
      const masked = maskStrings(line);
      if (!ASSERT_RE.test(masked) || SKIP_LINE_RE.test(line)) continue;
      const pick = pickLiteral(line, quietSpans(masked));
      if (!pick) continue;
      const flipped = flipLiteral(pick.lit);
      const after = line.slice(0, pick.index) + flipped + line.slice(pick.index + pick.lit.length);
      const mutated = [...lines];
      mutated[i] = after;
      out.push({ label: `${f.path}:${i + 1} ${pick.lit}→${flipped}`, path: f.path, line: i + 1, before: line, after, text: mutated.join("\n") });
    }
  }
  return out;
}

const TEST_NAME_RE = /(^|[._-])(test|tests|spec|specs)([._-]|$)|^test_|_test\.\w+$/i;
const TEST_DIR_RE = /(^|\/)(tests?|specs?|__tests__)\//i;
/** Test files by name or location: only these are mutated, never source a verifier merely greps. */
export function isTestPath(rel: string): boolean {
  return TEST_NAME_RE.test(rel.split("/").pop() ?? "") || TEST_DIR_RE.test(rel);
}
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", "__pycache__", ".venv", "venv"]);

async function walkTests(root: string, dir: string, out: string[], cap: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= cap) return;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walkTests(root, abs, out, cap);
    } else if (e.isFile() && TEST_NAME_RE.test(e.name)) {
      out.push(toPosix(relative(root, abs)));
    }
  }
}

/**
 * Test files the verifier command names, or test files under directories it
 * names, excluding hidden files. These are the visible tests a verifier runs.
 */
export async function verifierReferencedFiles(dir: string, command: string, exclude: Set<string>, cap = 50): Promise<string[]> {
  const out: string[] = [];
  const tokens = command.split(/[\s;&|()<>`'"]+/).filter((t) => t && !t.startsWith("-") && !t.includes("$") && !t.includes("="));
  for (const raw of tokens) {
    const rel = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!rel || exclude.has(rel) || out.includes(rel)) continue;
    let abs: string;
    try {
      abs = safeJoin(dir, rel);
    } catch {
      continue;
    }
    if (!existsSync(abs)) continue;
    const st = await stat(abs);
    if (st.isFile()) {
      if (isTestPath(rel)) out.push(rel);
    }
    else if (st.isDirectory()) {
      const found: string[] = [];
      await walkTests(dir, abs, found, cap);
      for (const f of found) if (!exclude.has(f) && !out.includes(f)) out.push(f);
    }
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}

/** Read text files under dir, skipping missing, huge or binary ones. */
export async function readTextFiles(dir: string, rels: string[]): Promise<TestFileText[]> {
  const out: TestFileText[] = [];
  for (const rel of rels) {
    try {
      const abs = safeJoin(dir, rel);
      const st = await stat(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const buf = await readFile(abs);
      if (buf.includes(0)) continue;
      out.push({ path: rel, text: buf.toString("utf8") });
    } catch {
      // unreadable: not a candidate
    }
  }
  return out;
}
