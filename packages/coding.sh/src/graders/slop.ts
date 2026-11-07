// Agent-slop rules over a unified diff: placeholder code, type-check escapes,
// swallowed errors, leftover debugging, focused or skipped tests, barrel
// files, placeholder UI text and narrating comments. Only lines the diff adds
// are read, so a pattern the agent left alone never counts against it.
// Pure: regexes over text, no model, no I/O.
import { parsePatch } from "../eval/patch.ts";
import { TEST_PATH } from "../core/intent.ts";

export type SlopSeverity = "error" | "warn";

export interface SlopFinding {
  rule: string;
  path: string;
  /** Line in the new file, from the hunk header. */
  line: number;
  /** The added line, trimmed and clipped. */
  text: string;
  severity: SlopSeverity;
}

/** What a rule sees for one added line. */
interface LineView {
  /** The line as added. */
  raw: string;
  /** Code with the comment removed; string contents kept. */
  code: string;
  /** Code with the comment removed and string contents blanked. */
  bare: string;
  /** The comment's text, without its markers; undefined when the line has none. */
  comment?: string;
  /** The next line of the hunk when it is also an added line. */
  next?: string;
  path: string;
}

export interface SlopRule {
  id: string;
  description: string;
  severity: SlopSeverity;
  /** File extensions (lowercase, no dot) it applies to. */
  langs: readonly string[];
  /** "only": test files only; "skip": not in test, fixture, mock, story or example files. Default: any file. */
  tests?: "only" | "skip";
  /** Paths it never reads. */
  skipPaths?: RegExp;
  /** Off unless named in `rules`. */
  optIn?: true;
  match(v: LineView): boolean;
}

// ---------------------------------------------------------------- languages

const JS = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte", "astro"];
const TS = ["ts", "tsx", "mts", "cts", "vue", "svelte", "astro"];
const PY = ["py", "pyi"];
const OTHER = ["java", "kt", "kts", "scala", "cs", "go", "rs", "swift", "c", "cc", "cpp", "cxx", "h", "hpp", "m", "mm", "dart", "php", "rb", "sh", "bash", "zsh", "ex", "exs"];
const CODE = [...JS, ...PY, ...OTHER];
const MARKUP = ["html", "htm"];

const HASH = new Set([...PY, "rb", "sh", "bash", "zsh", "ex", "exs"]);
const BOTH = new Set(["php"]);
const ANGLE = new Set(["vue", "svelte", "astro", "html", "htm"]);

/** Paths no rule reads: installed dependencies and minified bundles. */
const SKIP_PATH = /(?:^|\/)(?:node_modules|vendor)\/|\.min\.[a-z]+$/;
/** Fixture, mock, story and example files: placeholder text is their job. */
const FIXTURE_PATH = /(?:^|\/)(?:__)?(?:fixtures?|mocks?|examples?)(?:__)?\/|\.stories\.[a-z]+$/;

const extOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

export const isTestPath = (path: string): boolean => TEST_PATH.test(path);

// ---------------------------------------------------------------- comments

interface Split {
  code: string;
  bare: string;
  comment?: string;
  /** A block comment opened on this line is still open at its end. */
  open: boolean;
}

/**
 * Splits a line into code and comment, skipping over string literals. A line
 * inside a block comment (`inBlock`) is all comment until its closing marker.
 */
function splitLine(raw: string, ext: string, inBlock: boolean): Split {
  const hash = HASH.has(ext) || BOTH.has(ext);
  const slash = !HASH.has(ext);
  const angle = ANGLE.has(ext);
  if (inBlock) {
    const end = raw.search(/\*\/|-->/);
    if (end < 0) return { code: "", bare: "", comment: tidy(raw), open: true };
    const rest = splitLine(raw.slice(end + (raw.startsWith("-->", end) ? 3 : 2)), ext, false);
    return { ...rest, comment: tidy(raw.slice(0, end)) + (rest.comment ? ` ${rest.comment}` : "") };
  }
  if (slash && /^\s*\*(?:\s|\/|$)/.test(raw)) return { code: "", bare: "", comment: tidy(raw.replace(/^\s*\*\/?/, "")), open: false };
  let quote = "";
  let bare = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === "\\") {
        bare += "  ";
        i++;
      } else if (c === quote) {
        quote = "";
        bare += c;
      } else bare += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      bare += c;
      continue;
    }
    const at = (s: string) => raw.startsWith(s, i);
    let marker = 0;
    let block = "";
    if (slash && at("//")) marker = 2;
    else if (hash && c === "#") marker = 1;
    else if (slash && at("/*")) [marker, block] = [2, "*/"];
    else if (angle && at("<!--")) [marker, block] = [4, "-->"];
    if (!marker) {
      bare += c;
      continue;
    }
    const code = raw.slice(0, i);
    let text = raw.slice(i + marker);
    let open = false;
    if (block) {
      const end = text.indexOf(block);
      if (end < 0) open = true;
      else text = text.slice(0, end);
    }
    return { code, bare, comment: tidy(text), open };
  }
  return { code: raw, bare, open: false };
}

/** Comment text without leading markers (`*`, `!`, `/`), a JSX `{`/`}` or surrounding space. */
const tidy = (s: string): string =>
  s
    .replace(/^[\s*!/]+/, "")
    .replace(/\s*\*+\/\s*\}?\s*$/, "")
    .trim();

// ---------------------------------------------------------------- rules

const ELIDED =
  /^(?:\.{3}|…)\s*(?:$|\(?\s*(?:rest|existing|remaining|other|previous|more|same|unchanged|everything|code|implementation|etc)\b)|\b(?:rest of (?:the )?(?:code|file|implementation|function|method|class|component|logic)|(?:existing|remaining|other) (?:code|logic|implementation) (?:here|unchanged|remains|stays|as (?:is|before))|(?:code|everything else) (?:remains|stays) (?:the same|unchanged))\b/i;
const TODO_IMPLEMENT =
  /\b(?:TODO|FIXME|XXX)\b(?:\([^)]*\))?[\s:-]*implement(?:ation)?(?: (?:this|me|it|here|later|the (?:function|method|logic|body)|this (?:function|method)))?\s*[.!]*$|\b(?:implementation|logic|code) goes here\b|\byour (?:code|logic|implementation) here\b|\b(?:add|insert|put|write) (?:your |the )?(?:code|logic|implementation) here\b|\bplaceholder (?:implementation|logic)\b/i;
const NOT_IMPLEMENTED = [
  /\bthrow\s+(?:new\s+)?\w*(?:Error|Exception)\s*\(\s*["'`](?:not\s+(?:yet\s+)?implemented|todo|implement\s+(?:me|this))\b/i,
  /\bthrow\s+new\s+NotImplementedException\s*\(/,
  /\braise\s+NotImplementedError\s*\(\s*["'](?:todo|not\s+(?:yet\s+)?implemented)\b/i,
  /\b(?:todo|unimplemented)!\s*\(/,
  /\bpanic\(\s*"(?:not\s+(?:yet\s+)?implemented|todo|unimplemented)\b/i,
];
const EMPTY_CATCH_LINE = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/;
const CATCH_OPEN = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/;
const PROMISE_SWALLOW = /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)/;
const EXCEPT_PASS = /^\s*except\b[^:]*:\s*(?:pass|\.\.\.)\s*$/;
const EXCEPT_OPEN = /^\s*except\b[^:]*:\s*$/;
const FOCUSED = /\b(?:it|test|describe|context|suite)\.only\s*\(|\b(?:fit|fdescribe|fcontext)\s*\(|\{[^}]*\bonly\s*:\s*true\b/;
const PLACEHOLDER_TEXT = /\blorem ipsum\b|\bcoming soon\b|\bsample data\b|\bdummy (?:data|text|content)\b|\bplaceholder (?:text|content|data)\b/i;
const NARRATING =
  /^(?:(?:increment|decrement)s? (?:the )?\w+(?: by (?:one|1))?|returns? the (?:result|value)|(?:loop|iterate)s? (?:through|over) (?:the |each |all )?\w+|imports? (?:the )?(?:necessary |required )?(?:modules|libraries|dependencies|packages)|(?:define|declare|initialize|create)s? (?:a |the )?(?:new )?(?:variables?|constants?|function)|call (?:the )?function)\.?$/i;
/** Capitalized (New:, NEW:) only: a lowercase "new:" is usually prose. */
const CHANGELOG = /^(?:N(?:ew|EW)|U(?:pdated?|PDATED?)|C(?:hanged?|HANGED?)|M(?:odified|ODIFIED)|A(?:dded|DDED)|F(?:ixed|IXED)|R(?:emoved|EMOVED|efactored|EFACTORED)|E(?:dited|DITED))(?:\s*\([^)]*\))?\s*:/;
/** A skip behind a condition (no git, wrong OS) is a guard, not a disabled test. */
const GUARDED_SKIP = /\b(?:if|unless)\b.*\bskip|\breturn\s+[\w.]*skip/i;
/** Unconditional skips (core/intent.ts SKIP_MARKERS without focus markers and skipIf/skipUnless/skipif). */
const SKIPPED: readonly RegExp[] = [
  /\b(?:it|test|describe|context|suite)\.(?:skip|todo)\s*\(/,
  /\b(?:xit|xtest|xdescribe|xcontext)\s*\(/,
  /\b(?:it|test|describe|suite)\s*\(.*\{[^}]*\b(?:skip|todo)\s*:\s*(?:true|["'`])/,
  /\bt\.(?:skip|todo|Skip|SkipNow|Skipf)\s*\(/,
  /@pytest\.mark\.(?:skip|xfail)\b/,
  /\bpytest\.(?:skip|xfail)\s*\(/,
  /@unittest\.(?:skip|expectedFailure)\b/,
  /\bself\.skipTest\s*\(/,
  /#\[ignore\b/,
  /@(?:Ignore|Disabled)\b/,
];
const BLANKET_LINT = /\b(?:eslint|oxlint)-disable(?:-next-line|-line)?\s*(?:$|--)|\btslint:disable(?:-next-line|-line)?\s*$|\bnolint\b(?!:)|\bnoqa\b(?!\s*:)/;
const AI_CREDIT = /\b(?:added|written|generated|created|updated|modified|edited)\s+(?:by|with|using|via)\s+(?:ai|an ai|claude(?: code)?|chatgpt|gpt[-\d.o]*|copilot|cursor|the assistant|codex|gemini|llm)\b/i;
const ARROW_NOTE = /(?:<-+|←)\s*(?:added|new|changed|fixed|updated)\b/i;

/** True when an unclosed "(" comes before `index` in `s`. */
function insideParens(s: string, index: number): boolean {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

export const SLOP_RULES: readonly SlopRule[] = [
  {
    id: "elided-code",
    description: 'A comment that stands in for code, e.g. "// ... rest of the code" or "# existing code unchanged"',
    severity: "error",
    langs: CODE,
    match: (v) => v.comment !== undefined && ELIDED.test(v.comment),
  },
  {
    id: "todo-implement",
    description: 'A stub comment, e.g. "TODO: implement" or "implementation goes here"',
    severity: "error",
    langs: CODE,
    match: (v) => v.comment !== undefined && TODO_IMPLEMENT.test(v.comment),
  },
  {
    id: "not-implemented",
    description: 'A stub body: throw new Error("Not implemented"), NotImplementedException, todo!(), unimplemented!(), panic("not implemented")',
    severity: "error",
    langs: CODE,
    match: (v) => NOT_IMPLEMENTED.some((re) => re.test(v.code)),
  },
  {
    id: "as-any",
    description: "An `as any` cast",
    severity: "error",
    langs: TS,
    match: (v) => /\bas\s+any\b/.test(v.bare),
  },
  {
    id: "as-unknown-as",
    description: "A chained `as unknown as T` cast",
    severity: "error",
    langs: TS,
    match: (v) => /\bas\s+unknown\s+as\b/.test(v.bare),
  },
  {
    id: "ts-ignore",
    description: "@ts-ignore or @ts-nocheck (use @ts-expect-error with a reason)",
    severity: "error",
    langs: JS,
    match: (v) => v.comment !== undefined && /@ts-(?:ignore|nocheck)\b/.test(v.comment),
  },
  {
    id: "lint-disable",
    description: "A blanket lint suppression that names no rule: eslint-disable, tslint:disable, a bare noqa or nolint",
    severity: "warn",
    langs: CODE,
    match: (v) => v.comment !== undefined && BLANKET_LINT.test(v.comment),
  },
  {
    id: "type-ignore",
    description: "A bare `# type: ignore` or `# pyright: ignore` with no error code",
    severity: "warn",
    langs: PY,
    match: (v) => v.comment !== undefined && /\b(?:type|pyright):\s*ignore\b(?!\[)|\bmypy:\s*ignore-errors\b/.test(v.comment),
  },
  {
    id: "empty-catch",
    description: "An error swallowed with no handling and no comment: catch {}, .catch(() => {}), except: pass",
    severity: "error",
    langs: CODE,
    match: (v) => {
      if (v.comment !== undefined) return false;
      if (EMPTY_CATCH_LINE.test(v.bare) || PROMISE_SWALLOW.test(v.bare) || EXCEPT_PASS.test(v.bare)) return true;
      const next = v.next?.trim();
      if (next === undefined) return false;
      if (CATCH_OPEN.test(v.bare)) return next.startsWith("}");
      return EXCEPT_OPEN.test(v.bare) && (next === "pass" || next === "...");
    },
  },
  {
    id: "debugger",
    description: "A breakpoint left in: debugger, breakpoint(), pdb.set_trace(), binding.pry",
    severity: "error",
    langs: CODE,
    match: (v) => /^\s*debugger\s*;?\s*$|\bbreakpoint\(\s*\)|\bi?pdb\.set_trace\(|^\s*import\s+i?pdb\b|\bbinding\.(?:pry|irb)\b|^\s*byebug\b/.test(v.bare),
  },
  {
    id: "debug-print",
    description: 'A debug print outside tests and scripts: console.log/debug/trace/dir/table, dbg!(), print("DEBUG …")',
    severity: "warn",
    langs: CODE,
    tests: "skip",
    skipPaths: /(?:^|\/)(?:scripts?|bin|tools)\//,
    match: (v) => /\bconsole\.(?:log|debug|trace|dir|table)\s*\(|\bdbg!\s*\(/.test(v.bare) || /^\s*print\(\s*f?["'](?:debug\b|>>>|\*{3}|-{3}|={3}|here\b)/i.test(v.code),
  },
  {
    id: "focused-test",
    description: "A focused test that silences the rest of the suite: it.only, describe.only, fit, { only: true }",
    severity: "error",
    langs: CODE,
    tests: "only",
    match: (v) => FOCUSED.test(v.bare),
  },
  {
    id: "skipped-test",
    description: "A test skipped with no condition: .skip, .todo, xit, @pytest.mark.skip/xfail, @unittest.skip, t.Skip, #[ignore], @Disabled",
    severity: "warn",
    langs: CODE,
    tests: "only",
    match: (v) => !GUARDED_SKIP.test(v.bare) && SKIPPED.some((re) => re.test(v.bare)),
  },
  {
    id: "barrel-export",
    description: "A barrel re-export: export * from",
    severity: "warn",
    langs: JS,
    match: (v) => /^\s*export\s+\*\s+from\s+["']/.test(v.code),
  },
  {
    id: "placeholder-text",
    description: 'Placeholder content: lorem ipsum, "coming soon", "sample data", "dummy data", "placeholder text"',
    severity: "warn",
    langs: [...CODE, ...MARKUP],
    tests: "skip",
    match: (v) => PLACEHOLDER_TEXT.test(v.raw),
  },
  {
    id: "narrating-comment",
    description: 'A comment that restates the next line: "increment i", "return the result", "loop through items"',
    severity: "warn",
    langs: CODE,
    match: (v) => v.comment !== undefined && NARRATING.test(v.comment),
  },
  {
    id: "changelog-comment",
    description: 'A change note left in the code: "// New:", "// Updated:", "// <- added", "added by AI"',
    severity: "warn",
    langs: CODE,
    match: (v) => v.comment !== undefined && (CHANGELOG.test(v.comment) || AI_CREDIT.test(v.comment) || ARROW_NOTE.test(v.comment)),
  },
  {
    id: "conditional-empty-spread",
    description: "A conditional spread with an empty branch: ...(x ? { a } : {}), ...(x && { a })",
    severity: "warn",
    langs: JS,
    optIn: true,
    match: (v) => /\.\.\.\s*\(.*\?.*:\s*(?:\{\s*\}|\[\s*\])\s*\)|\.\.\.\s*\([^)]*&&\s*[{[]/.test(v.bare),
  },
  {
    id: "unknown-param",
    description: "A function parameter typed `unknown`",
    severity: "warn",
    langs: TS,
    optIn: true,
    match: (v) => {
      const re = /(?:^|[(,])\s*(?:\.\.\.)?\w+\??\s*:\s*unknown\s*(?=[,)=])/g;
      for (const m of v.bare.matchAll(re)) if (insideParens(v.bare, m.index + m[0].indexOf(":"))) return true;
      return false;
    },
  },
];

export const SLOP_RULE_IDS: readonly string[] = SLOP_RULES.map((r) => r.id);
export const DEFAULT_SLOP_RULE_IDS: readonly string[] = SLOP_RULES.filter((r) => !r.optIn).map((r) => r.id);

/**
 * The rules to run. Without `rules`: every default rule. `rules` replaces the
 * default set; "default" in it stands for the default rules and "all" for
 * every rule, so ["default", "unknown-param"] adds one opt-in rule.
 * `exclude` drops rules by id. An unknown id throws.
 */
export function selectSlopRules(rules?: readonly string[], exclude?: readonly string[]): SlopRule[] {
  const known = new Set(SLOP_RULE_IDS);
  for (const id of [...(rules ?? []), ...(exclude ?? [])]) {
    if (id !== "default" && id !== "all" && !known.has(id)) throw new RangeError(`unknown slop rule ${JSON.stringify(id)} (expected default, all, ${SLOP_RULE_IDS.join(", ")})`);
  }
  const want = new Set<string>();
  for (const id of rules?.length ? rules : ["default"]) {
    if (id === "all") for (const r of SLOP_RULE_IDS) want.add(r);
    else if (id === "default") for (const r of DEFAULT_SLOP_RULE_IDS) want.add(r);
    else want.add(id);
  }
  for (const id of exclude ?? []) want.delete(id);
  return SLOP_RULES.filter((r) => want.has(r.id));
}

// ---------------------------------------------------------------- findings

export interface SlopOptions {
  rules?: readonly string[];
  exclude?: readonly string[];
}

export interface SlopReport {
  findings: SlopFinding[];
  /** Added lines read, in files some selected rule applies to. */
  addedLines: number;
  errors: number;
  warnings: number;
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Findings on the lines one or more unified diffs add. */
export function slopFindings(patches: string | readonly string[], opts: SlopOptions | readonly SlopRule[] = {}): SlopReport {
  const rules = Array.isArray(opts) ? (opts as readonly SlopRule[]) : selectSlopRules((opts as SlopOptions).rules, (opts as SlopOptions).exclude);
  const report: SlopReport = { findings: [], addedLines: 0, errors: 0, warnings: 0 };
  for (const patch of typeof patches === "string" ? [patches] : patches) {
    for (const f of parsePatch(patch).files) {
      const path = f.newPath;
      if (path === undefined || SKIP_PATH.test(path)) continue;
      const ext = extOf(path);
      const test = isTestPath(path);
      const fixture = test || FIXTURE_PATH.test(path);
      const active = rules.filter((r) => r.langs.includes(ext) && !r.skipPaths?.test(path) && (r.tests === "only" ? test : r.tests === "skip" ? !fixture : true));
      if (!active.length) continue;
      for (const h of f.hunks) {
        let line = h.newStart;
        let inBlock = false;
        for (let i = 0; i < h.lines.length; i++) {
          const l = h.lines[i]!;
          const kind = l[0];
          if (kind === "-" || kind === "\\") continue;
          const raw = l.slice(1);
          const s = splitLine(raw, ext, inBlock);
          inBlock = s.open;
          if (kind === "+") {
            report.addedLines++;
            const after = h.lines[i + 1];
            const view: LineView = { raw, code: s.code, bare: s.bare, path, ...(s.comment !== undefined ? { comment: s.comment } : {}), ...(after?.startsWith("+") ? { next: after.slice(1) } : {}) };
            for (const r of active) {
              if (!r.match(view)) continue;
              report.findings.push({ rule: r.id, path, line, text: clip(raw.trim()), severity: r.severity });
              if (r.severity === "error") report.errors++;
              else report.warnings++;
            }
          }
          line++;
        }
      }
    }
  }
  return report;
}

// ---------------------------------------------------------------- score

export interface SlopThresholds {
  /** Pass with at most this many error findings. Default 0. */
  maxErrors?: number;
  /** Pass with at most this many warnings. Default: no limit. */
  maxWarnings?: number;
}

/**
 * score = 1 / (1 + d), d = (errors + warnings / 4) per 100 added lines, with
 * diffs under 100 lines counted as 100 (one error in a short diff gives 0.5,
 * one warning 0.8, none 1). pass = errors ≤ maxErrors and warnings ≤ maxWarnings.
 */
export function slopScore(r: Pick<SlopReport, "errors" | "warnings" | "addedLines">, t: SlopThresholds = {}): { score: number; pass: boolean } {
  const d = ((r.errors + r.warnings / 4) * 100) / Math.max(100, r.addedLines);
  const pass = r.errors <= (t.maxErrors ?? 0) && (t.maxWarnings === undefined || r.warnings <= t.maxWarnings);
  return { score: 1 / (1 + d), pass };
}

/** "2 errors, 1 warning in 40 added lines: as-any src/a.ts:3, …". */
export function slopSummary(r: SlopReport, max = 3): string {
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const head = `${n(r.errors, "error")}, ${n(r.warnings, "warning")} in ${n(r.addedLines, "added line")}`;
  const top = [...r.findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1)).slice(0, max);
  return top.length ? `${head}: ${top.map((f) => `${f.rule} ${f.path}:${f.line}`).join(", ")}${r.findings.length > max ? ", …" : ""}` : head;
}

// ---------------------------------------------------------------- diffs from traces

/** A unified diff: a file header and at least one hunk. */
export function looksLikeDiff(text: string): boolean {
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text) && /^(?:diff --git |--- )/m.test(text);
}

interface DiffEvent {
  kind: string;
  payload?: Record<string, unknown>;
  blobs?: readonly string[];
}

export interface TraceDiffs {
  /** One unified diff per file.change that carried one. */
  patches: string[];
  /** file.change events that carried no diff (the agent's capture has none). */
  missing: number;
  /** Diffs cut to the inline budget whose full text could not be read. */
  truncated: number;
}

/**
 * The diffs a trace's file.change events carry, oldest first. A diff cut to
 * the inline budget is read whole from its blob when `readBlob` is given.
 * Each edit counts on its own, so a line one edit adds and a later edit
 * removes still counts.
 */
export async function traceDiffs(events: readonly DiffEvent[], readBlob?: (ref: string) => Promise<string | undefined>): Promise<TraceDiffs> {
  const out: TraceDiffs = { patches: [], missing: 0, truncated: 0 };
  for (const e of events) {
    if (e.kind !== "file.change") continue;
    const p = e.payload ?? {};
    let diff = typeof p.diff === "string" ? p.diff : typeof p.patch === "string" ? p.patch : undefined;
    if (diff === undefined || diff === "") {
      out.missing++;
      continue;
    }
    if (p.diffTruncated === true) {
      const ref = e.blobs?.at(-1);
      const full = ref && readBlob ? await readBlob(ref).catch(() => undefined) : undefined;
      if (full !== undefined && full.startsWith(diff.slice(0, 64))) diff = full;
      else out.truncated++;
    }
    const path = typeof p.path === "string" ? p.path : "unknown";
    if (!/^(?:diff --git |--- )/m.test(diff)) diff = `--- a/${path}\n+++ b/${path}\n${diff}`;
    out.patches.push(diff);
  }
  return out;
}
