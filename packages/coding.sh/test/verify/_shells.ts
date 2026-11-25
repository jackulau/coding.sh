// Executable models of the shells that read the command lines coding.sh writes and prints: the hook
// command in an agent's config, the crontab line of a scheduled bench, and the commands in hints.
// test/verify/quoting-proof.test.ts proves the quoting functions against these models;
// test/verify/shell-models.test.ts checks each model against the real shell on the machine.
//
// A model covers the forms the quoting functions write and returns undefined for anything else (an
// expansion, a glob, an operator, a mix of quotes it does not follow), so where it gives an answer
// that answer is what the shell does:
//
// - sh: POSIX sh (dash, bash) splitting a simple command into words and removing quotes. With
//   `prompt`, also a shell a person types into, interactive bash or zsh (macOS's default): there
//   `!` in double quotes is history, `$` in double quotes takes more forms (zsh's `$+name`), a word
//   that starts with `=` is a command's path (zsh), and `#` starts no comment (zsh).
// - crt: how a program built with the Microsoft C runtime, node.exe among them, splits its command
//   line into argv: 2n backslashes and a quote give n backslashes and open or close quotes, 2n+1 give
//   n and a literal quote, other backslashes stay, and `""` inside quotes is a literal quote.
// - cmd: what cmd.exe does to a command line before it starts the program: %NAME% becomes the
//   variable's value when it is set, inside double quotes too (an unset one stays, and the scan goes
//   on from its closing %); then outside double quotes ^ escapes the next character and & | < > ( )
//   are operators. Delayed expansion (!NAME!) is off, cmd's default. npm's .cmd shim puts its
//   arguments (%*) on a line of its own, which cmd reads again: no % expansion, but ^ and the
//   operators once more.
// - ps: Windows PowerShell 5.1 and PowerShell 7 reading a command's arguments (bare words, single
//   quotes with '' for a quote, double quotes where $ and ` expand; the curly quotes count as quotes;
//   a word that starts with a quote ends at the closing one), then passing them to a native program.
//   5.1 drops an empty argument, wraps one with whitespace in quotes as it is, and passes the rest as
//   they are, inner double quotes unescaped, so the C runtime drops them. 7.3 and later quote and
//   escape each argument for the C runtime. npm's .ps1 shim passes $args on, where PowerShell has
//   dropped the first bare `--` and split a bare `-name:value` in two. Windows PowerShell 5.1 runs a
//   .cmd through cmd.exe with the command line it builds.
// - cron: crontab(5) (Vixie cron, cronie): after the five time fields, the rest of the line is the
//   command for /bin/sh, where an unescaped % ends it (what follows is its standard input) and \%
//   is a literal %. cron does not run on Windows, so this model is checked only against that text.
//
// PowerShell 7 is checked only where pwsh is installed.

/** The characters the proof and the checks build strings from: those the shells treat specially, a letter and a non-ASCII letter. */
export const HOSTILE: readonly string[] = [" ", "\t", "\n", '"', "'", "\\", "$", "`", "%", "!", "^", "&", "|", "<", ">", "(", ")", ";", "=", ",", "*", "?", "~", "#", "@", "{", "}", "[", "]", "-", "a", "é"];

/** The value of an environment variable as the shell looks it up, or undefined when it is not set. */
export type Env = (name: string) => string | undefined;

/** An environment where nothing is set. */
export const noEnv: Env = () => undefined;

/** An environment where every name is set, to a value no string here contains. */
export const everyEnv: Env = () => "\u0007";

/** An environment from variables, looked up as Windows does, ignoring case. */
export function windowsEnv(vars: Record<string, string | undefined>): Env {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) m.set(k.toUpperCase(), v);
  return (name) => m.get(name.toUpperCase());
}

// ---------------------------------------------------------------------------------------------
// sh

/** A token of an sh command line: a word, or one of the operators the crontab line uses. */
export type ShToken = string | { op: "&&" | ">>" | "2>&1" };

export interface ShOptions {
  /** A shell a person types into: interactive bash, or zsh. */
  prompt?: boolean;
}

const SH_BARE = /[A-Za-z0-9_@%+=:,./-]/;
// In double quotes `$` stays itself before these: no name, `{`, `(` or special parameter follows.
const SH_DOLLAR_KEPT = new Set(['"', "/", " ", "\t", "%", ".", ",", ":", "=", "+", "\\"]);

/** The tokens of `line` as sh reads it, or undefined when it uses anything the model leaves out. */
export function shTokens(line: string, o: ShOptions = {}): ShToken[] | undefined {
  const out: ShToken[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "#") {
      if (o.prompt || line.includes("\n", i)) return undefined;
      return out;
    }
    const op = /^(?:&&|>>|2>&1(?=[ \t]|$))/.exec(line.slice(i));
    if (op) {
      out.push({ op: op[0] as "&&" | ">>" | "2>&1" });
      i += op[0].length;
      continue;
    }
    const start = i;
    let w = "";
    while (i < line.length && line[i] !== " " && line[i] !== "\t") {
      const ch = line[i]!;
      if (ch === "'") {
        const j = line.indexOf("'", i + 1);
        if (j < 0) return undefined;
        w += line.slice(i + 1, j);
        i = j + 1;
      } else if (ch === '"') {
        i++;
        for (;;) {
          const d = line[i];
          if (d === undefined || d === "`" || (o.prompt && d === "!")) return undefined;
          if (d === '"') {
            i++;
            break;
          }
          if (d === "\\" && i + 1 < line.length && '$`"\\\n'.includes(line[i + 1]!)) {
            if (line[i + 1] !== "\n") w += line[i + 1];
            i += 2;
          } else if (d === "$" && (o.prompt || !SH_DOLLAR_KEPT.has(line[i + 1] ?? ""))) {
            return undefined;
          } else {
            w += d;
            i++;
          }
        }
      } else if (ch === "\\") {
        if (i + 1 >= line.length) return undefined;
        if (line[i + 1] !== "\n") w += line[i + 1];
        i += 2;
      } else if (SH_BARE.test(ch) || ch > "\u007f") {
        if (o.prompt && ch === "=" && i === start) return undefined;
        w += ch;
        i++;
      } else {
        return undefined;
      }
    }
    out.push(w);
  }
  return out;
}

/** The words of a simple command `line` as sh reads it, or undefined. */
export function shWords(line: string, o: ShOptions = {}): string[] | undefined {
  const t = shTokens(line, o);
  return t && t.every((x) => typeof x === "string") ? (t as string[]) : undefined;
}

// ---------------------------------------------------------------------------------------------
// The C runtime's argv

/** argv as a program built with the Microsoft C runtime (ucrt) splits its command line. */
export function crtArgv(line: string): string[] {
  const argv: string[] = [];
  let i = 0;
  let prog = "";
  let q = false;
  while (i < line.length && (q || (line[i] !== " " && line[i] !== "\t"))) {
    if (line[i] === '"') q = !q;
    else prog += line[i];
    i++;
  }
  argv.push(prog);
  let inq = false;
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i++;
    if (i >= line.length) break;
    let a = "";
    for (;;) {
      let bs = 0;
      while (line[i] === "\\") {
        i++;
        bs++;
      }
      let copy = true;
      if (line[i] === '"') {
        if (bs % 2 === 0) {
          if (inq && line[i + 1] === '"') i++;
          else {
            copy = false;
            inq = !inq;
          }
        }
        bs = Math.floor(bs / 2);
      }
      a += "\\".repeat(bs);
      if (i >= line.length || (!inq && (line[i] === " " || line[i] === "\t"))) break;
      if (copy) a += line[i];
      i++;
    }
    argv.push(a);
  }
  return argv;
}

// ---------------------------------------------------------------------------------------------
// cmd.exe

/** cmd.exe's % expansion of a command line it runs (not a line of a batch file). */
export function cmdPercent(line: string, env: Env): string | undefined {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const p = line.indexOf("%", i);
    if (p < 0) return out + line.slice(i);
    out += line.slice(i, p);
    const q = line.indexOf("%", p + 1);
    if (q < 0) return out + line.slice(p);
    const name = line.slice(p + 1, q);
    if (name.includes(":")) return undefined; // %NAME:~1,2% and %NAME:a=b%: left out
    const v = name ? env(name) : undefined;
    if (v !== undefined) {
      out += v;
      i = q + 1;
    } else {
      out += `%${name}`;
      i = q;
    }
  }
  return out;
}

/** cmd.exe's pass over ^, the quote toggle and the operators: the line as the program gets it, or undefined. */
export function cmdCarets(line: string): string | undefined {
  if (/[\r\n]/.test(line)) return undefined;
  let out = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') q = !q;
    else if (!q && c === "^") {
      if (i + 1 >= line.length) return undefined;
      out += line[++i];
      continue;
    } else if (!q && "&|<>()".includes(c)) return undefined;
    out += c;
  }
  // Whitespace at the end inside an open quote: %* drops it, so leave that out.
  return q && /[ \t]$/.test(out) ? undefined : out;
}

/** A command line cmd.exe runs, typed at its prompt or given to cmd /c: the command line the program gets. */
export function cmdRun(line: string, env: Env): string | undefined {
  const p = cmdPercent(line, env);
  return p === undefined ? undefined : cmdCarets(p);
}

/** cmd.exe runs `node <script> …`: the arguments node gets after the script. */
export function cmdToNode(line: string, env: Env): string[] | undefined {
  const r = cmdRun(line, env);
  return r === undefined ? undefined : crtArgv(r).slice(2);
}

/** cmd.exe runs `<bin> …`, an npm .cmd shim: the arguments node gets after the shim's script. */
export function cmdToShim(line: string, env: Env): string[] | undefined {
  const r = cmdRun(line, env);
  if (r === undefined) return undefined;
  const bin = /^[^ \t]+/.exec(r);
  if (!bin || bin[0].includes('"')) return undefined;
  const t = cmdCarets(r.slice(bin[0].length));
  return t === undefined ? undefined : crtArgv(`node "C:\\x\\cli.mjs" ${t}`).slice(2);
}

// ---------------------------------------------------------------------------------------------
// PowerShell

/** An argument as PowerShell reads it: its value, and whether it was a bare word. */
export interface PsArg {
  value: string;
  bare: boolean;
}

const PS_SQ = "'\u2018\u2019\u201A\u201B";
const PS_DQ = '"\u201C\u201D\u201E';
const PS_BARE = /[A-Za-z0-9_%+=:./\\!^~*?#@[\]-]/;
// In double quotes `$` stays itself before these.
const PS_DOLLAR_KEPT = new Set([...PS_DQ, "/", " ", "\\", "-", "%", "."]);
// A bare word PowerShell reads as a parameter: `-` and a letter, `_`, `?` or a non-ASCII letter.
const PS_PARAM = /^-[A-Za-z_?\u0080-￿]/;

/** The arguments of `text` as PowerShell reads them in argument mode, or undefined. */
export function psArgs(text: string): PsArg[] | undefined {
  const out: PsArg[] = [];
  let i = 0;
  const end = () => i >= text.length || text[i] === " " || text[i] === "\t";
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    let v = "";
    if (PS_SQ.includes(c)) {
      i++;
      for (;;) {
        if (i >= text.length) return undefined;
        const d = text[i]!;
        if (PS_SQ.includes(d)) {
          if (text[i + 1] === d) {
            v += d;
            i += 2;
            continue;
          }
          if (PS_SQ.includes(text[i + 1] ?? "\n")) return undefined;
          i++;
          break;
        }
        v += d;
        i++;
      }
      if (!end()) return undefined;
      out.push({ value: v, bare: false });
    } else if (PS_DQ.includes(c)) {
      i++;
      for (;;) {
        if (i >= text.length) return undefined;
        const d = text[i]!;
        if (PS_DQ.includes(d)) {
          if (PS_DQ.includes(text[i + 1] ?? "\n")) return undefined;
          i++;
          break;
        }
        if (d === "`" || (d === "$" && !PS_DOLLAR_KEPT.has(text[i + 1] ?? ""))) return undefined;
        v += d;
        i++;
      }
      if (!end()) return undefined;
      out.push({ value: v, bare: false });
    } else {
      // `@` splats, `#` starts a comment and `]` is a token of its own.
      if (c === "@" || c === "#" || c === "]") return undefined;
      while (!end()) {
        const d = text[i]!;
        if (!PS_BARE.test(d) && !(d > "\u007f" && !PS_SQ.includes(d) && !PS_DQ.includes(d) && !/[\u2013-\u2015]/.test(d))) return undefined;
        v += d;
        i++;
      }
      // A parameter (`-` and a name) ends at `.` or `[`, which start another argument; `--%` stops parsing.
      if (PS_PARAM.test(v) && /^[^:]*[.[]/.test(v)) return undefined;
      if (v === "--%") return undefined;
      out.push({ value: v, bare: true });
    }
  }
  return out;
}

/** A PowerShell command line, `[& ]<command> <arguments>`: the command and its arguments, or undefined. */
export function psCommand(line: string): { name: string; args: PsArg[] } | undefined {
  const a = psArgs(line.startsWith("& ") ? line.slice(2) : line);
  return a && a.length ? { name: a[0]!.value, args: a.slice(1) } : undefined;
}

/** The arguments a PowerShell script gets as $args: the first bare `--` is dropped and a bare -name:value is split. */
export function psScriptArgs(args: readonly PsArg[]): string[] | undefined {
  const out: string[] = [];
  let dropped = false;
  for (const a of args) {
    if (a.bare && a.value === "--" && !dropped) {
      dropped = true;
      continue;
    }
    if (a.bare && PS_PARAM.test(a.value) && a.value.includes(":")) {
      const m = /^(-[^:]+:)(.+)$/.exec(a.value);
      if (!m) return undefined;
      out.push(m[1]!, m[2]!);
      continue;
    }
    out.push(a.value);
  }
  return out;
}

export type PsVersion = "5.1" | "7";

/** The command-line tail PowerShell builds for a native program from argument values. */
export function psNative(values: readonly string[], version: PsVersion): string {
  if (version === "5.1") {
    return values
      .filter((v) => v !== "")
      .map((v) => {
        let quotes = 0;
        let ws = false;
        for (const ch of v) {
          if (ch === '"') quotes++;
          else if (/\s/.test(ch) && quotes % 2 === 0) ws = true;
        }
        return ws ? `"${v}"` : v;
      })
      .join(" ");
  }
  return values
    .map((v) => {
      if (v === "") return '""';
      if (!/[\s"]/.test(v)) return v;
      let out = '"';
      let bs = 0;
      for (const ch of v) {
        if (ch === "\\") {
          bs++;
          continue;
        }
        out += ch === '"' ? `${"\\".repeat(bs * 2 + 1)}"` : "\\".repeat(bs) + ch;
        bs = 0;
      }
      return `${out + "\\".repeat(bs * 2)}"`;
    })
    .join(" ");
}

/** PowerShell runs `[& ]node <script> …`: the arguments node gets after the script. */
export function psToNode(line: string, version: PsVersion): string[] | undefined {
  const c = psCommand(line);
  return c ? crtArgv(`node ${psNative(c.args.map((a) => a.value), version)}`).slice(2) : undefined;
}

/** PowerShell runs `<bin> …`, npm's .ps1 shim: the arguments node gets after the shim's script. */
export function psToShim(line: string, version: PsVersion): string[] | undefined {
  const c = psCommand(line);
  const args = c && psScriptArgs(c.args);
  return args ? crtArgv(`node ${psNative(["C:/x/cli.mjs", ...args], version)}`).slice(2) : undefined;
}

/** Windows PowerShell 5.1 runs `<bin>.cmd …`, an npm .cmd shim, through cmd.exe: what node gets. */
export function psToCmdShim(line: string, env: Env): string[] | undefined {
  const c = psCommand(line);
  return c ? cmdToShim(`${c.name} ${psNative(c.args.map((a) => a.value), "5.1")}`, env) : undefined;
}

// ---------------------------------------------------------------------------------------------
// cron

/** The command cron gives /bin/sh for a crontab line, or undefined when % cuts it or the line is not one line. */
export function cronCommand(line: string): string | undefined {
  if (line.includes("\n")) return undefined;
  const m = /^[ \t]*(?:[^ \t]+[ \t]+){5}/.exec(line);
  if (!m) return undefined;
  let out = "";
  let esc = false;
  for (const ch of line.slice(m[0].length)) {
    if (esc) {
      out += ch === "%" ? ch : `\\${ch}`;
      esc = false;
    } else if (ch === "\\") esc = true;
    else if (ch === "%") return undefined;
    else out += ch;
  }
  return esc ? `${out}\\` : out;
}
