// Shell commands inside a REPL cell. Kernel agents (Prime's python_repl,
// CodeAct, smolagents) run shell commands from code: `await bash("npm test")`,
// `subprocess.run(["pytest", "-q"])`, an IPython `!cargo test` line. commandOf
// (core/sessions.ts) reads a cell's `code` through this, so a cell that runs the
// tests counts as verification, and plain Python does not. Pure.

/** At most this many commands from one cell. */
export const MAX_CELL_COMMANDS = 50;

/** Calls whose first argument is a shell command. */
const CALL = /(?<![\w.])(?:bash|subprocess\.(?:run|call|check_call|check_output|getoutput|getstatusoutput|Popen)|os\.(?:system|popen)|sh\.run)\s*\(/g;
/** IPython: `!cmd`, `files = !ls`, `%sx cmd`, `%system cmd`. */
const BANG = /^[ \t]*(?:[A-Za-z_]\w*[ \t]*=[ \t]*)?(?:!(?!=)|%(?:sx|system)\b)[ \t]*(.*)$/;
/** IPython cell magics whose body is a shell script. */
const CELL_MAGIC = /^\s*%%(?:bash|sh|script\s+(?:ba|z)?sh)\b[^\n]*\n/;

interface Lit {
  value: string;
  end: number;
}

/** The string literal at `i` (Python prefixes, single, double and triple quotes, JS backticks), or undefined. */
function literalAt(code: string, i: number): Lit | undefined {
  const m = /^([rRbBuUfF]{0,2})("""|'''|"|'|`)/.exec(code.slice(i, i + 5));
  if (!m) return undefined;
  const raw = /r/i.test(m[1]!);
  const q = m[2]!;
  let j = i + m[0].length;
  let value = "";
  while (j < code.length) {
    if (code.startsWith(q, j)) return { value, end: j + q.length };
    const c = code[j]!;
    if (q.length === 1 && q !== "`" && c === "\n") return undefined;
    if (c === "\\" && j + 1 < code.length) {
      const n = code[j + 1]!;
      if (raw) value += c + n;
      else value += n === "n" ? "\n" : n === "t" ? "\t" : n === "\n" ? "" : n === "\\" || n === "'" || n === '"' || n === "`" ? n : c + n;
      j += 2;
      continue;
    }
    value += c;
    j++;
  }
  return undefined;
}

const skipSpace = (code: string, i: number): number => {
  while (i < code.length && /\s/.test(code[i]!)) i++;
  return i;
};

/** The first argument of the call opened at `i` (just past "("): a string, or a list of strings joined with spaces. */
function firstArg(code: string, i: number): string | undefined {
  i = skipSpace(code, i);
  // A keyword first argument: subprocess.run(args=[...]), bash(cmd="...").
  const kw = /^(?:args|cmd|command)\s*=\s*/.exec(code.slice(i, i + 16));
  if (kw) i = skipSpace(code, i + kw[0].length);
  const lit = literalAt(code, i);
  if (lit) return lit.value;
  if (code[i] !== "[" && code[i] !== "(") return undefined;
  const close = code[i] === "[" ? "]" : ")";
  const words: string[] = [];
  i = skipSpace(code, i + 1);
  while (i < code.length && code[i] !== close) {
    const w = literalAt(code, i);
    if (!w) return undefined; // a variable in the list: not a literal command
    words.push(w.value);
    i = skipSpace(code, w.end);
    if (code[i] === ",") i = skipSpace(code, i + 1);
  }
  return words.length ? words.join(" ") : undefined;
}

/**
 * `code` with comments blanked out (same length), so a commented-out call is not
 * read; with `strings`, string contents too, so a call quoted in a string is not.
 */
function mask(code: string, strings: boolean): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "#") {
      const nl = code.indexOf("\n", i);
      const end = nl < 0 ? code.length : nl;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    const lit = /["'`]/.test(c) || (/[rRbBuUfF]/.test(c) && /["']/.test(code[i + 1] ?? "") && !/\w/.test(code[i - 1] ?? "")) ? literalAt(code, i) : undefined;
    if (lit) {
      out += strings ? code.slice(i, lit.end).replace(/[^\n]/g, " ") : code.slice(i, lit.end);
      i = lit.end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The shell commands a code cell runs, in order: string literal arguments of
 * `bash(…)` / `await bash(…)`, `subprocess.run|call|check_call|check_output|Popen(…)`
 * (a list of strings joined with spaces), `os.system(…)`, `sh.run(…)`, and
 * IPython `!cmd`, `%sx cmd` lines and `%%bash` cells. f-strings keep their braces
 * as written. Commented lines and non-literal arguments are skipped. At most
 * MAX_CELL_COMMANDS.
 */
export function shellCommandsInCode(code: string): string[] {
  if (typeof code !== "string" || !code.trim()) return [];
  const magic = CELL_MAGIC.exec(code);
  if (magic) {
    const body = code.slice(magic[0].length);
    return body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).slice(0, MAX_CELL_COMMANDS);
  }
  const found: { at: number; cmd: string }[] = [];
  const lines = mask(code, false).split("\n");
  const blank = mask(code, true).split("\n");
  // Bang lines are not Python: read them line by line and leave them out of the call scan.
  let at = 0;
  let scan = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = BANG.exec(line);
    // A line wholly inside a triple-quoted string blanks out: it is text, not a bang line.
    if (m && m[1]!.trim() && blank[i]!.trim()) {
      found.push({ at, cmd: m[1]!.trim() });
      scan += " ".repeat(line.length) + "\n";
    } else scan += blank[i] + "\n";
    at += line.length + 1;
  }
  for (const m of scan.matchAll(CALL)) {
    const cmd = firstArg(code, m.index + m[0].length);
    if (cmd !== undefined && cmd.trim()) found.push({ at: m.index, cmd: cmd.trim() });
  }
  return found
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_CELL_COMMANDS)
    .map((f) => f.cmd);
}
