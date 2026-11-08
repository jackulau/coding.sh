// Is an edit to an existing test file only new test cases? An agent that adds a
// regression test next to the existing ones disables nothing, so the tamper
// check (runner/tamper.ts) leaves it out. Everything else stays an edit:
// removed or changed lines (weakened or deleted assertions), skip markers, an
// early return or exit, a block inserted inside an existing test, a file-level
// disable, a module-level hook, fixture or mock, patched test machinery, or a
// new definition that shadows an existing one. The check reads the patch's
// hunks against the post-image (the file as the agent left it); without the
// post-image, or in a language it doesn't know, nothing counts as pure addition.
import { SKIP_MARKERS } from "../core/intent.ts";

type Lang = "js" | "py" | "go" | "rust" | "jvm";

const LANGS: [RegExp, Lang][] = [
  [/\.(?:[cm]?[jt]sx?)$/i, "js"],
  [/\.py$/i, "py"],
  [/\.go$/i, "go"],
  [/\.rs$/i, "rust"],
  [/\.(?:java|kt|kts|scala|cs)$/i, "jvm"],
];

export function testLang(path: string): Lang | undefined {
  return LANGS.find(([re]) => re.test(path))?.[1];
}

interface HunkLine {
  t: " " | "+" | "-";
  s: string;
}

interface Hunk {
  /** 1-based first line of the hunk in the post-image. */
  newStart: number;
  lines: HunkLine[];
}

/** Hunks per post-image path ("+++ b/…"); deleted files have none. */
export function patchHunks(patch: string): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>();
  let cur: Hunk[] | undefined;
  let hunk: Hunk | undefined;
  let header = false;
  const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = undefined;
      hunk = undefined;
      header = true;
      continue;
    }
    if (header && line.startsWith("+++ ")) {
      const p = unquote(line.slice(4));
      if (p === "/dev/null") cur = undefined;
      else {
        const path = p.replace(/^b\//, "");
        cur = out.get(path) ?? [];
        out.set(path, cur);
      }
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) {
      header = false;
      hunk = { newStart: Number(m[1]), lines: [] };
      cur?.push(hunk);
      continue;
    }
    if (header || !hunk) continue;
    const t = line[0];
    if (t === "+" || t === "-" || t === " ") hunk.lines.push({ t, s: line.slice(1) });
    // "\ No newline at end of file" and the patch's trailing "" carry no line.
  }
  return out;
}

// ------------------------------------------------------------------ scanning

interface Frame {
  ch: string;
  /** 0-based line the bracket opened on. */
  line: number;
}

interface ScanState {
  stack: Frame[];
  /** Open string delimiter carried to the next line (template literal, triple-quoted, raw). */
  str?: string;
  block: boolean;
}

interface ScannedLine {
  /** Bracket depth at the start of the line. */
  depth: number;
  /** The line with string contents emptied and comments removed. */
  code: string;
  /** The line began inside a string or block comment. */
  cont: boolean;
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);

/** Scan lines, tracking brackets across strings and comments; returns false on a close with no open. */
function scan(lines: readonly string[], lang: Lang, st: ScanState, from = 0): { out: ScannedLine[]; ok: boolean } {
  const out: ScannedLine[] = [];
  let ok = true;
  // A block that closes a bracket opened before it is not self-contained.
  const floor = st.stack.length;
  const hash = lang === "py";
  lines.forEach((line, li) => {
    const depth = st.stack.length;
    const cont = !!st.str || st.block;
    let code = "";
    let i = 0;
    while (i < line.length) {
      if (st.block) {
        const end = line.indexOf("*/", i);
        if (end < 0) i = line.length;
        else {
          st.block = false;
          i = end + 2;
        }
        continue;
      }
      if (st.str) {
        const q = st.str;
        let j = i;
        let closed = false;
        while (j < line.length) {
          if (line[j] === "\\" && q !== "`raw") {
            j += 2;
            continue;
          }
          const want = q === "`raw" ? "`" : q;
          if (line.startsWith(want, j)) {
            closed = true;
            j += want.length;
            break;
          }
          j++;
        }
        if (closed) {
          code += st.str === "`raw" ? "``" : `${st.str}${st.str}`;
          st.str = undefined;
        }
        i = j;
        continue;
      }
      const c = line[i] as string;
      const two = line.slice(i, i + 2);
      if (hash ? c === "#" : two === "//") break;
      if (!hash && two === "/*") {
        st.block = true;
        i += 2;
        continue;
      }
      if (hash && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        st.str = line.slice(i, i + 3);
        i += 3;
        continue;
      }
      if (lang === "js" && c === "/") {
        const end = regexEnd(line, i, code);
        if (end > 0) {
          code += "/r/";
          i = end;
          continue;
        }
      }
      if (c === '"' || (c === "`" && lang !== "py")) {
        st.str = c === "`" && lang === "go" ? "`raw" : c;
        i++;
        continue;
      }
      if (c === "'") {
        // Rust lifetimes ('a) and generics are not strings; a char literal is.
        if (lang === "rust" && !/^'(?:\\.[^']*|[^\\'])'/.test(line.slice(i))) {
          i++;
          continue;
        }
        st.str = "'";
        i++;
        continue;
      }
      if (OPEN[c]) st.stack.push({ ch: c, line: from + li });
      else if (CLOSE.has(c)) {
        const top = st.stack.pop();
        if (!top || OPEN[top.ch] !== c || st.stack.length < floor) ok = false;
      }
      code += c;
      i++;
    }
    // A quoted string never spans lines; only template, triple-quoted and raw strings do.
    if (st.str === "'" || st.str === '"') st.str = undefined;
    out.push({ depth, code, cont });
  });
  return { out, ok };
}

/** After these (or at the start of a line) a `/` starts a regex literal, not a division. */
const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|delete|void|throw|new|yield|await))\s*$/;

/** The index just past a JS regex literal starting at `i` (flags included), or -1 when the `/` is a division. */
function regexEnd(line: string, i: number, before: string): number {
  if (!REGEX_BEFORE.test(before)) return -1;
  let inClass = false;
  for (let j = i + 1; j < line.length; j++) {
    const ch = line[j];
    if (ch === "\\") j++;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      let k = j + 1;
      while (k < line.length && /[a-z]/i.test(line[k] as string)) k++;
      return k;
    }
  }
  return -1;
}

// ------------------------------------------------------------------ rules

/** Lines that disable or bypass tests wherever they appear in an added block, even inside a new test. */
const DISABLING: readonly RegExp[] = [
  /\b(?:process\.(?:exit|kill|abort)|os\._exit|sys\.exit|os\.Exit|std::process::exit|System\.exit|Environment\.Exit)\s*\(|(?<![.\w$])(?:quit|exit)\s*\(/,
  /\bSystemExit\b/,
  /\b(?:assert|expect|chai|should|unittest|pytest|jest|vi|mocha|describe|it|test|TestCase|testing)\s*(?:\.[\w$]+)+\s*=(?!=)/,
  /\bself\.assert\w*\s*=(?!=)/,
  /\brequire\.cache\b/,
  /\b(?:jest|vi)\s*\.\s*(?:mock|doMock|unstable_mockModule)\s*\(/,
  /\bsys\.modules\s*\[/,
  /\bbuiltins\.\w+\s*=(?!=)/,
  /\b(?:setattr|monkeypatch\.setattr)\s*\(\s*["']?(?:builtins|unittest|pytest|assert)/,
];

/** At the block's top level (module or an existing class): changes that reach the existing tests. */
const TOP_LEVEL_DISABLING: readonly RegExp[] = [
  /\b(?:globalThis|global|window)\s*(?:\.[\w$]+|\[[^\]]*\])\s*=(?!=)/,
  /\bObject\.defineProperty\s*\(/,
  /\bautouse\s*=\s*True\b|^\s*@[\w.]*fixture\b/,
];

/** Comments that switch a whole file off (build constraints, crate attributes). */
const FILE_DISABLE = /^\s*(?:\/\/\s*\+build\b|\/\/go:build\b|#!\[)/;

/** A test definition anywhere in the added block. */
const TEST_DEF: Record<Lang, RegExp> = {
  js: /^\s*(?:await\s+)?(?:(?:it|test|specify|Deno\.test|t\.test|bench)(?:\.(?:each|concurrent)\b[^(]*)?\s*\()/,
  py: /^\s*(?:async\s+)?def\s+test\w*\s*\(|^\s*class\s+Test\w*/,
  go: /^\s*func\s+(?:Test|Benchmark|Fuzz|Example)(?!Main\b)\w*\s*\(/,
  rust: /^\s*#\[(?:test|tokio::test|async_std::test|rstest)\b/,
  jvm: /^\s*(?:@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|Property)\b|\[(?:Fact|Theory|Test|TestCase|TestMethod)\b)/,
};

/** What may start a statement at the top level of an added block, per language. */
const STARTERS: Record<Lang, readonly RegExp[]> = {
  js: [
    TEST_DEF.js,
    /^\s*(?:describe|context|suite)(?:\.each\b[^(]*)?\s*\(/,
    /^\s*import\s+(?!['"])/,
    /^\s*(?:export\s+)?(?:const|let)\s+[\w${}[\]\s,:]+=\s*(?:await\s+import|require)\s*\(/,
    /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*[\w$]+\s*[<(]/,
    /^\s*(?:export\s+)?(?:const|let)\s+[\w$]+\s*(?::[^=]+)?=/,
    /^\s*(?:export\s+)?class\s+[\w$]+/,
    /^\s*(?:export\s+)?(?:type|interface)\s+[\w$]+/,
  ],
  py: [
    TEST_DEF.py,
    /^\s*@[\w.]+/,
    /^\s*(?:async\s+)?def\s+\w+\s*\(/,
    /^\s*class\s+\w+/,
    /^\s*(?:from\s+[\w.]+\s+)?import\s+/,
    /^\s*[A-Za-z_]\w*\s*(?::[^=]+)?=(?!=)/,
  ],
  go: [TEST_DEF.go, /^\s*func\s+[a-z_]\w*\s*\(/, /^\s*(?:var|const|type)\s+\w+/, /^\s*import\s+/],
  rust: [TEST_DEF.rust, /^\s*#\[(?:cfg\(test\)|should_panic|case\b|ignore_if_never\b)/, /^\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+/, /^\s*(?:pub\s+)?mod\s+\w+\s*\{/, /^\s*use\s+/],
  jvm: [TEST_DEF.jvm, /^\s*@(?:DisplayName|Tag|ValueSource|CsvSource|MethodSource|Timeout)\b/, /^\s*(?:(?:public|private|protected|internal|static|final|async|override|suspend)\s+)*(?:void|fun|def|Task|[\w<>[\],\s]+)\s+(?:\w+|``)\s*\(/],
};

/** Definitions at the block's top level that change how the existing tests run: hooks, setup, fixtures, collection. */
const HOOK_NAMES =
  /^\s*(?:(?:async\s+)?def\s+(?:pytest_\w+|setup_module|teardown_module|setUpModule|tearDownModule|setup_function|teardown_function|setup|teardown|setUp|tearDown|setUpClass|tearDownClass|asyncSetUp|asyncTearDown|setup_method|teardown_method|setup_class|teardown_class|load_tests)\b|(?:pytestmark|__test__|collect_ignore(?:_glob)?)\s*=|func\s+(?:TestMain|init)\s*\(|(?:before|after)(?:Each|All)?\s*\(|(?:setup|teardown|suiteSetup|suiteTeardown)\s*\(|@(?:Before|After)(?:Each|All|Class)?\b|\[(?:SetUp|TearDown|OneTimeSetUp|OneTimeTearDown|TestInitialize|ClassInitialize)\b)/;

/** A bracket a new test may sit inside: a describe/suite/context call, a class, module or namespace body. */
const CONTAINER =
  /^\s*(?:(?:describe|context|suite)(?:\.\w+)*\s*\(|@Nested\b|(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|export|default|pub(?:\([\w:]+\))?)\s+)*(?:class|object|mod|namespace|impl|module)\b)/;
/** The body of a callback passed to the container on an earlier line: `() => {`, `function () {`. */
const ARG_FN = /^\s*(?:async\s+)?(?:\([^)]*\)\s*=>|[\w$]+\s*=>|function\s*\*?\s*\([^)]*\))\s*\{\s*$/;
const IMPORT_LIST = /^\s*(?:import|export|from\s+\S+\s+import|use)\b/;
/** A line inside an import list (strings already emptied): names, or a Go import spec. */
const IMPORT_ITEM = /^\s*(?:[\w$*]+(?:\s+as\s+[\w$]+)?\s*,?\s*)+$|^\s*(?:[\w.]+\s+)?""\s*$/;

/** Names a block declares at its top level (functions, classes, tests in Python). */
function declaredName(line: string, lang: Lang): string | undefined {
  if (lang === "py") return /^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)/.exec(line)?.slice(1).find(Boolean);
  if (lang === "js") return /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)|^\s*(?:export\s+)?(?:const|let|class)\s+([\w$]+)/.exec(line)?.slice(1).find(Boolean);
  return undefined;
}

function definitions(post: readonly string[], name: string, lang: Lang): number {
  const esc = name.replace(/[$]/g, "\\$");
  const re =
    lang === "py"
      ? new RegExp(String.raw`^\s*(?:(?:async\s+)?def|class)\s+${esc}\b|^\s*${esc}\s*(?::[^=]+)?=(?!=)`)
      : new RegExp(String.raw`\b(?:function\s*\*?\s*|const\s+|let\s+|var\s+|class\s+)${esc}\b`);
  return post.filter((l) => re.test(l)).length;
}

/** A single-line import, its source and the names it brings in. */
function importOf(line: string): { from: string; names: Set<string> } | undefined {
  const js = /^\s*import\s+(?:type\s+)?(.+?)\s+from\s+(['"])(.+?)\2\s*;?\s*$/.exec(line);
  if (js) return { from: js[3] as string, names: new Set((js[1] as string).split(/[\s,{}]+/).filter((n) => n && n !== "as")) };
  const req = /^\s*(?:const|let)\s+\{([^}]*)\}\s*=\s*require\(\s*(['"])(.+?)\2\s*\)\s*;?\s*$/.exec(line);
  if (req) return { from: req[3] as string, names: new Set((req[1] as string).split(/[\s,:]+/).filter(Boolean)) };
  const py = /^\s*from\s+([\w.]+)\s+import\s+\(?([^)#]+)\)?\s*(?:#.*)?$/.exec(line);
  if (py) return { from: py[1] as string, names: new Set((py[2] as string).split(/[\s,]+/).filter((n) => n && n !== "as")) };
  return undefined;
}

/** A removed import line that an added line in the same hunk extends with more names (to import what a new test uses). */
function extendedImport(removed: string, added: readonly string[]): boolean {
  const r = importOf(removed);
  if (!r) return false;
  return added.some((a) => {
    const x = importOf(a);
    return !!x && x.from === r.from && [...r.names].every((n) => x.names.has(n)) && x.names.size > r.names.size;
  });
}

const blank = (code: string) => code.trim() === "";
const indent = (s: string) => /^[ \t]*/.exec(s)?.[0].replace(/\t/g, "    ").length ?? 0;

interface Run {
  /** 0-based index of the run's first line in the post-image. */
  at: number;
  lines: string[];
}

/** One contiguous block of added lines, checked against the post-image around it. */
function runOk(run: Run, post: readonly string[], lang: Lang): boolean {
  // The post-image must hold the block where the hunk says it is.
  if (run.lines.some((l, k) => post[run.at + k] !== l)) return false;
  if (run.lines.some((l) => FILE_DISABLE.test(l))) return false;
  const st: ScanState = { stack: [], block: false };
  const above = scan(post.slice(0, run.at), lang, st).out;
  if (st.str || st.block) return false; // inserted inside a string or comment: no telling
  const frames = [...st.stack];
  const head = (f: Frame) => above[f.line]?.code ?? "";
  const base = frames.length;
  const body = scan(run.lines, lang, st, run.at);
  if (!body.ok || st.stack.length !== base || st.str || st.block) return false;

  const lines = body.out;
  const code = lines.map((l) => l.code);
  if (code.some((c) => DISABLING.some((re) => re.test(c)) || SKIP_MARKERS.some((re) => re.test(c)))) return false;
  const top = (k: number) => !lines[k]!.cont && lines[k]!.depth === base && !blank(code[k] as string);
  // Inside an import list ("import {", "from x import (", Go's "import ("): names only.
  const inner = frames.at(-1);
  if (inner && IMPORT_LIST.test(head(inner))) return code.every((c, k) => !top(k) || IMPORT_ITEM.test(c));
  // Every enclosing bracket belongs to a container, never to a test or a function body.
  const frameOk = (k: number) => {
    const h = head(frames[k]!);
    if (CONTAINER.test(h)) return true;
    const parent = frames[k - 1];
    return ARG_FN.test(h) && parent?.ch === "(" && CONTAINER.test(head(parent));
  };
  if (!frames.every((_, k) => frameOk(k))) return false;
  if (lang === "py") return pyRunOk(run, post, lines, code, base);
  // Brace languages: each statement at the block's top level is a test, a describe, an import or a new declaration.
  for (let k = 0; k < lines.length; k++) {
    if (!top(k)) continue;
    const c = code[k] as string;
    if (!STARTERS[lang].some((re) => re.test(c)) || HOOK_NAMES.test(c) || TOP_LEVEL_DISABLING.some((re) => re.test(c))) return false;
    const name = declaredName(c, lang);
    if (name && definitions(post, name, lang) !== 1) return false;
  }
  return true;
}

function pyRunOk(run: Run, post: readonly string[], lines: readonly ScannedLine[], code: readonly string[], depth: number): boolean {
  const first = lines.findIndex((l, k) => !l.cont && !blank(code[k] as string));
  if (first < 0) return true; // blank lines and comments only
  const base = indent(run.lines[first] as string);
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!;
    const c = code[k] as string;
    if (l.cont || l.depth > depth || blank(c)) continue;
    const ind = indent(run.lines[k] as string);
    if (ind < base) return false;
    if (ind > base) continue;
    if (!STARTERS.py.some((re) => re.test(c)) || HOOK_NAMES.test(c) || TOP_LEVEL_DISABLING.some((re) => re.test(c))) return false;
    const name = declaredName(c, "py") ?? /^\s*([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(c)?.[1];
    if (name && definitions(post, name, "py") !== 1) return false;
  }
  // The code after the block must not be more indented: that would take the rest of an existing body.
  const next = post.slice(run.at + run.lines.length).find((l) => l.trim() !== "" && !/^\s*#/.test(l));
  if (next !== undefined && indent(next) > base) return false;
  // Above the block, the nearest less-indented line must open a class (or there is none: module level).
  if (base > 0) {
    const above = post
      .slice(0, run.at)
      .reverse()
      .find((l) => l.trim() !== "" && !/^\s*#/.test(l) && indent(l) < base);
    if (!above || !/^\s*class\s/.test(above)) return false;
  }
  return true;
}

/**
 * Slide a block of added lines along equal context lines (the diff could have
 * placed `});` above or below it) and accept it if any placement checks out.
 */
function slides(hunk: Hunk, start: number, end: number): { at: number; lines: string[] }[] {
  const ls = hunk.lines;
  const postIndex = (i: number) => hunk.newStart - 1 + ls.slice(0, i).filter((l) => l.t !== "-").length;
  const out = [{ at: postIndex(start), lines: ls.slice(start, end).map((l) => l.s) }];
  // Up: the context line before the block equals the block's last line.
  let lines = out[0]!.lines;
  for (let s = start - 1, at = out[0]!.at; s >= 0 && ls[s]!.t === " " && ls[s]!.s === lines.at(-1); s--) {
    lines = [ls[s]!.s, ...lines.slice(0, -1)];
    out.push({ at: --at, lines });
  }
  lines = out[0]!.lines;
  for (let e = end, at = out[0]!.at; e < ls.length && ls[e]!.t === " " && ls[e]!.s === lines[0]; e++) {
    lines = [...lines.slice(1), ls[e]!.s];
    out.push({ at: ++at, lines });
  }
  return out;
}

/**
 * True when the file's hunks only add new test cases (plus the imports and
 * helpers they need) and leave every existing line and test as it was.
 * `post` is the file as the agent left it.
 */
export function onlyAddsTests(path: string, hunks: readonly Hunk[], post: string | undefined): boolean {
  const lang = testLang(path);
  if (!lang || post === undefined || !hunks.length) return false;
  const postLines = post.split("\n");
  let tests = 0;
  for (const h of hunks) {
    const added = h.lines.filter((l) => l.t === "+").map((l) => l.s);
    // A changed line is a change, except an import line that gains the names a new test uses.
    if (h.lines.some((l) => l.t === "-" && !extendedImport(l.s, added))) return false;
    // The removed lines left are imports an added line extends; drop them and check the blocks of added lines.
    const sub: Hunk = { newStart: h.newStart, lines: h.lines.filter((l) => l.t !== "-") };
    for (let i = 0; i < sub.lines.length; ) {
      if (sub.lines[i]!.t !== "+") {
        i++;
        continue;
      }
      let j = i;
      while (j < sub.lines.length && sub.lines[j]!.t === "+") j++;
      if (!slides(sub, i, j).some((r) => runOk(r, postLines, lang))) return false;
      tests += sub.lines.slice(i, j).filter((l) => TEST_DEF[lang].test(l.s)).length;
      i = j;
    }
  }
  return tests > 0;
}
