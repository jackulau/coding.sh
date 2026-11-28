// Shell commands and the files they touch: the command of a tool call, the
// files it writes (shellWrites), and whether a file a shell call's dirty-tree
// diff reports was written by that command (shellDiffOrigin). Pure: rules over
// strings, no I/O.
import { posix } from "node:path";
import type { AgentEvent } from "../schema/index.ts";
import { commandLineOf, isShellCall } from "./shell-tools.ts";

// The checks before each replace skip it when it would change nothing: a session's fold keys every path it reads.
const unprivate = (x: string) => (x.startsWith("/private/") ? x.replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, "") : x);
/** Forward slashes. */
export const slashed = (x: string): string => (x.includes("\\") ? x.replace(/\\/g, "/") : x);

/** A cwd as normalizeTracePath compares a path with it: forward slashes, no trailing slash, no macOS `/private`. */
export function traceRoot(cwd: string | undefined): string | undefined {
  return cwd ? unprivate(slashed(cwd).replace(/(?<!\/)\/+$/, "")) : undefined;
}

/** normalizeTracePath against a root from traceRoot: for many paths under one cwd, the cwd read once. */
export function underTraceRoot(p: string, root: string | undefined): string {
  let s = unprivate(slashed(p));
  if (root) {
    const drive = driveOf(root);
    if (drive) s = onDrive(s, drive);
    if (s === root || (s.startsWith(root) && s.charCodeAt(root.length) === 47)) s = s.slice(root.length + 1);
  }
  return s.startsWith("./") ? s.replace(/^(?:\.\/)+/, "") : s;
}

/** Repo-relative, forward slashes, no leading "./". macOS `/private/var/…` and `/var/…` are one root. */
export function normalizeTracePath(p: string, cwd?: string): string {
  return underTraceRoot(p, traceRoot(cwd));
}

/** The drive letter of a Windows folder (`C:\x`, `c:/x`), or undefined. */
export function driveOf(dir: string | undefined): string | undefined {
  return dir && /^[A-Za-z]:/.test(dir) ? dir[0] : undefined;
}

/**
 * A path as a folder on `drive` (driveOf) names it: Git Bash's `/c/x` as `c:/x`, then the folder's
 * own drive letter in the folder's case and any other in upper case, so `/c/x`, `c:\x` and `C:\x`
 * are one path. Unchanged without a drive, where `/c/x` is a POSIX path.
 */
export function onDrive(p: string, drive: string | undefined): string {
  if (!drive) return p;
  if (p[0] === "/") p = p.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:");
  if (!/^[A-Za-z]:/.test(p)) return p;
  const d = p[0]!.toLowerCase() === drive.toLowerCase() ? drive : p[0]!.toUpperCase();
  return d === p[0] ? p : d + p.slice(1);
}

/**
 * The shell command of a tool call's input (commandLineOf: every command key, `bash -lc` unwrapped),
 * unless it is a patch passed as `command` (Codex apply_patch).
 */
export function shellCommand(tool: string | undefined, input: unknown): string | undefined {
  if (tool && /patch/i.test(tool)) return undefined;
  const cmd = commandLineOf(input);
  if (cmd === undefined || /^\s*(?:\*\*\* Begin Patch|diff --git )/.test(cmd)) return undefined;
  return cmd;
}

export interface ShellWrite {
  path: string;
  /**
   * create: the command writes the whole file (`>`, `tee`, a `cp`/`mv` target), so it exists afterwards whatever was there.
   * append: `>>`, `tee -a`. modify: an in-place edit (`sed -i`, `perl -pi`, `truncate`, `git checkout|restore`).
   */
  op: "create" | "append" | "modify" | "delete";
  /** `mv <path> <target>`: where the file went (a rename, not a removal, when the target is still a test). */
  renamedTo?: string;
}

/** A shell glob as an anchored regex over a path (`*` and `?` stay within one segment). */
export function globRe(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|\\[\]]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${src}$`);
}

const WORD = /'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"]+/g;
/** A `'…'` word or a run of unquoted text, at one index (sticky). */
const PLAIN_WORD = /'[^']*'|[^\s'"]+/y;
/** A `"` and the escaped or plain text after it, up to the next unescaped `"` (sticky). */
const QUOTED = /"(?:\\.|[^"\\])*/y;

/**
 * The words of a segment, as `seg.match(WORD)` finds them. A `"` whose string never closes makes
 * that regex scan to the end again at every escaped `"` after it; here one scan rules out every
 * `"` it passed.
 */
function wordsOf(seg: string): string[] {
  // Without a `\"` no scan runs past a `"`: the scans that fail cover separate stretches, and the regex is linear.
  if (!seg.includes('\\"')) return seg.match(WORD) ?? [];
  const out: string[] = [];
  /** A `"` before this index opens no string: an earlier scan ran past it without finding the close. */
  let unclosed = 0;
  for (let i = 0; i < seg.length; ) {
    if (seg[i] === '"') {
      if (i >= unclosed) {
        QUOTED.lastIndex = i;
        const end = i + QUOTED.exec(seg)![0].length;
        if (seg[end] === '"') {
          out.push(seg.slice(i, end + 1));
          i = end + 1;
          continue;
        }
        unclosed = end;
      }
      i++;
      continue;
    }
    PLAIN_WORD.lastIndex = i;
    const m = PLAIN_WORD.exec(seg);
    if (m) {
      out.push(m[0]);
      i += m[0].length;
    } else i++;
  }
  return out;
}

const unquote = (w: string) => (w.length >= 2 && (w[0] === "'" || w[0] === '"') && w.endsWith(w[0]) ? w.slice(1, -1) : w);
const pathLike = (w: string) => w !== "" && !w.startsWith("-") && !w.includes("$") && /^[\w.@~+/*[\]{},:-]+$/.test(w) && /[./]/.test(w) && w !== "." && w !== "..";

/** A shell command without its heredoc bodies (`<<EOF` … `EOF`): their text is data, not commands. */
export function stripHeredocs(command: string): string {
  if (!command.includes("<<")) return command;
  const lines: string[] = [];
  let heredoc: string | undefined;
  for (const line of command.split("\n")) {
    if (heredoc !== undefined) {
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    lines.push(line);
    const m = /<<-?\s*(['"]?)([\w.-]+)\1/.exec(line);
    if (m) heredoc = m[2];
  }
  return lines.join("\n");
}

/** One line of a unified diff hunk: context (" "), added ("+") or removed ("-"). */
export type DiffLine = { t: " " | "+" | "-"; s: string };

/** The hunks of a unified diff, lines in order (file headers skipped). */
export function diffHunks(diff: string): DiffLine[][] {
  const hunks: DiffLine[][] = [];
  let h: DiffLine[] | undefined;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ") || l.startsWith("--- ")) continue;
    if (l.startsWith("@@")) {
      hunks.push((h = []));
      continue;
    }
    const t = l[0];
    if (t !== "+" && t !== "-" && t !== " ") continue;
    if (!h) hunks.push((h = []));
    h.push({ t, s: l.slice(1) });
  }
  return hunks;
}

export interface SimpleCommand {
  /** The command word as written (`./bin/tool`, `rm`), after env assignments and `sudo`, `env`, `time`, `nohup`, `command`. */
  name: string;
  /** `name` without its directory. */
  cmd: string;
  /** The words after it, unquoted, redirections taken out. */
  args: string[];
  /** Redirection targets in order: `>` (append false) and `>>` (append true). */
  redirects: { path: string; append: boolean }[];
  /** The directory an earlier `cd`/`pushd` in the same command moved to (relative paths are under it). */
  dir?: string;
  /** The operator after the command (`|`, `&&`, `||`, `;`, `&` or a newline); absent for the last one. */
  sep?: string;
}

/**
 * The directory a run of `cd`s leads to, each step as `posix.join(dir, to)` gives it, or `to` as
 * written when there is no directory yet or `to` is absolute. A step costs the length of `to`,
 * not of the directory: the segments are kept on a stack, and each directory string extends the
 * one for the segment before it, so a `cd a && cd a && …` chain stays linear. The step it returns
 * takes `to` and returns the directory after it.
 */
function cdChain(): (to: string) => string {
  let dir: string | undefined;
  /** The directory as written, until a step joins something to it (it is not normalized until then). */
  let written: string | undefined;
  let absolute = false;
  const segs: string[] = [];
  /** heads[n]: the first n segments as a path, the root `/` included when absolute. */
  const heads: string[] = [""];
  const add = (path: string) => {
    for (const s of path.split("/")) {
      if (s === "" || s === ".") continue;
      if (s === "..") {
        if (segs.length && segs[segs.length - 1] !== "..") {
          segs.pop();
          continue;
        }
        // Nothing is above the root; a relative path keeps its leading `..`.
        if (absolute) continue;
      }
      segs.push(s);
      heads[segs.length] = segs.length > 1 ? `${heads[segs.length - 1]}/${s}` : absolute ? `/${s}` : s;
    }
  };
  return (to) => {
    if (dir === undefined || /^(?:\/|[A-Za-z]:\/|~)/.test(to)) return (dir = written = to);
    if (written !== undefined) {
      absolute = written.startsWith("/");
      segs.length = 0;
      add(written);
      written = undefined;
    }
    add(to);
    const slash = to.endsWith("/");
    const head = heads[segs.length] as string;
    return (dir = segs.length ? (slash ? `${head}/` : head) : absolute ? "/" : slash ? "./" : ".");
  };
}

/**
 * `text` split as `text.split(/(&&|\|\||[;|&\n])/)` splits it, but only at operators outside
 * quotes: a `;` or `|` inside `'…'` or `"…"` stays in its segment. A backslash outside single
 * quotes escapes the next character, so `\;` and a `\` line break split nothing. A quote that
 * never closes runs to the end. One pass over the text.
 */
function splitQuoted(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = "";
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === '"') quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    const op = ch === "&" || ch === "|" ? (text[i + 1] === ch ? ch + ch : ch) : ch === ";" || ch === "\n" ? ch : "";
    if (!op) continue;
    parts.push(text.slice(start, i), op);
    i += op.length - 1;
    start = i + 1;
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * The words of a segment as the shell reads them: quoted and unquoted parts next to each other
 * make one word, and the quotes go (`A="x y"` is the one word `A=x y`). A backslash keeps the
 * character after it, and a `\` line break joins the lines. One pass over the segment.
 */
function quotedWords(seg: string): string[] {
  const out: string[] = [];
  let w: string | undefined;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i] as string;
    if (ch === "'") {
      const end = seg.indexOf("'", i + 1);
      const stop = end < 0 ? seg.length : end;
      w = (w ?? "") + seg.slice(i + 1, stop);
      i = stop;
    } else if (ch === '"') {
      let j = i + 1;
      let s = "";
      for (; j < seg.length && seg[j] !== '"'; j++) {
        if (seg[j] === "\\" && j + 1 < seg.length && '"\\$`'.includes(seg[j + 1] as string)) j++;
        s += seg[j];
      }
      w = (w ?? "") + s;
      i = j;
    } else if (ch === "\\") {
      if (i + 1 < seg.length && seg[i + 1] !== "\n") w = (w ?? "") + seg[i + 1];
      i++;
    } else if (/\s/.test(ch)) {
      if (w !== undefined) out.push(w);
      w = undefined;
    } else w = (w ?? "") + ch;
  }
  if (w !== undefined) out.push(w);
  return out;
}

/**
 * The simple commands of a shell command line: split on `&&`, `||`, `;`, `|`,
 * `&` and newlines, heredoc bodies skipped, each as its unquoted words.
 * Best effort: no subshells. By default an operator inside quotes splits too;
 * with `quotes` it does not, and a word's quoted and unquoted parts join as the
 * shell joins them (`A="--x y"` is the one word `A=--x y`).
 */
export function simpleCommands(command: string, o: { quotes?: boolean } = {}): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  let dir: string | undefined;
  let cd: ((to: string) => string) | undefined;
  // A redirection to a descriptor (`2>&1`, `>&2`) and a heredoc's marker become a space. The
  // descriptor before `>&` is read from its first digit, `(?<!\d)`, so the time is linear.
  const text = stripHeredocs(command).replace(/(?<!\d)\d+>&\d+|>&\d+|<<-?\s*(['"]?)[\w.-]+\1/g, " ").replace(/&>/g, ">");
  // Odd entries are the operators between the segments.
  const parts = o.quotes ? splitQuoted(text) : text.split(/(&&|\|\||[;|&\n])/);
  for (let n = 0; n < parts.length; n += 2) {
    const seg = parts[n] as string;
    const sep = parts[n + 1];
    const words = o.quotes ? quotedWords(seg) : wordsOf(seg).map(unquote);
    // Redirections write their target wherever they sit.
    const rest: string[] = [];
    const redirects: SimpleCommand["redirects"] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i] as string;
      const r = w.includes(">") ? /^\d*(>>?)(.*)$/.exec(w) : null;
      if (r) {
        const target = r[2] || words[++i];
        if (target) redirects.push({ path: target, append: r[1] === ">>" });
      } else rest.push(w);
    }
    let k = 0;
    while (k < rest.length && (/^[A-Za-z_]\w*=/.test(rest[k] as string) || ["sudo", "command", "env", "time", "nohup"].includes(rest[k] as string))) k++;
    const name = rest[k] ?? "";
    const cmd = name.includes("/") ? name.replace(/^.*\//, "") : name;
    const args = rest.slice(k + 1);
    const c: SimpleCommand = { name, cmd, args, redirects, ...(dir !== undefined ? { dir } : {}) };
    if (sep !== undefined) c.sep = sep;
    out.push(c);
    if ((cmd === "cd" || cmd === "pushd") && args[0] && !args[0].startsWith("-")) dir = (cd ??= cdChain())(args[0].replace(/\\/g, "/"));
  }
  return out;
}

/** The shells whose `-c` option runs a script. */
export const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash"]);

/** The script a shell command runs with `-c` (`bash -lc 'lake build'`); undefined for any other command. */
export function shellScript(c: Pick<SimpleCommand, "cmd" | "args">): string | undefined {
  if (!SHELLS.has(c.cmd)) return undefined;
  const i = c.args.findIndex((a) => /^-\w*c$/.test(a));
  return (i >= 0 && c.args[i + 1]) || undefined;
}

/** A command's operands: words that are not options, everything after `--`, skipping the value of each option in `skipValueOf`. */
export function operandsOf(args: readonly string[], skipValueOf: readonly string[] = []): string[] {
  const ops: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      ops.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (skipValueOf.includes(a)) i++;
      continue;
    }
    ops.push(a);
  }
  return ops;
}

/**
 * Files a shell command writes or removes: `sed -i`, `perl -pi`, `>`/`>>`,
 * `tee`, `rm`, `mv`, `cp`, `truncate`, `git checkout|restore -- <path>`, `git rm`.
 * Heredoc bodies are skipped. Best effort: what it can't parse it leaves out.
 */
export function shellWrites(command: string): ShellWrite[] {
  const out: ShellWrite[] = [];
  for (const { cmd, args, redirects, dir } of simpleCommands(command)) {
    const under = (path: string) => (dir && !/^(?:\/|[A-Za-z]:[\\/]|~)/.test(path) ? posix.join(dir, path) : path);
    const add = (path: string, op: ShellWrite["op"], renamedTo?: string) => {
      // After `cd $DIR` relative paths are unknowable.
      if (!pathLike(path) || path.startsWith("/dev/") || (dir?.includes("$") && !/^(?:\/|[A-Za-z]:[\\/]|~)/.test(path))) return;
      out.push({ path: under(path), op, ...(renamedTo !== undefined ? { renamedTo: under(renamedTo) } : {}) });
    };
    for (const r of redirects) add(r.path, r.append ? "append" : "create");
    const operands = (skipValueOf: readonly string[] = []) => operandsOf(args, skipValueOf);
    if (cmd === "sed" && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) {
      const hasScriptFlag = args.some((a) => a === "-e" || a === "-f" || a === "--expression" || a === "--file");
      // BSD `sed -i '' …`: the empty word is -i's backup suffix, not the script.
      const ops = operands(["-e", "-f", "--expression", "--file"]).filter((o) => o !== "");
      for (const p of hasScriptFlag ? ops : ops.slice(1)) add(p, "modify");
    } else if (cmd === "perl" && args.some((a) => /^-\w*i/.test(a))) {
      for (const p of operands(["-e", "-E"])) add(p, "modify");
    } else if (cmd === "tee") {
      const append = args.some((a) => /^-\w*a/.test(a) || a === "--append");
      for (const p of operands()) add(p, append ? "append" : "create");
    } else if (cmd === "rm" || cmd === "unlink") {
      for (const p of operands()) add(p, "delete");
    } else if (cmd === "mv") {
      const ops = operands(["-t", "--target-directory", "-S", "--suffix"]);
      const to = ops.length >= 2 ? (ops[ops.length - 1] as string) : undefined;
      ops.forEach((p, i) => (i === ops.length - 1 ? add(p, "create") : add(p, "delete", to && ops.length === 2 ? to : undefined)));
    } else if (cmd === "cp") {
      const ops = operands(["-t", "--target-directory", "-S", "--suffix"]);
      if (ops.length >= 2) add(ops[ops.length - 1] as string, "create");
    } else if (cmd === "truncate") {
      for (const p of operands(["-s", "--size", "-r", "--reference"])) add(p, "modify");
    } else if (cmd === "git" && (args[0] === "checkout" || args[0] === "restore" || args[0] === "rm")) {
      const sub = args[0];
      const tail = args.slice(1);
      const dd = tail.indexOf("--");
      const ops = dd >= 0 ? tail.slice(dd + 1) : tail.filter((a) => !a.startsWith("-"));
      for (const p of ops) add(p, sub === "rm" ? "delete" : "modify");
    }
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** gh commands that bring other commits' files into the working tree. */
const VCS_GH = /(?:^|[\s;&|(])gh\s+pr\s+(?:checkout|merge)\b/;
/** A git word and its `-C` and `-c` options. */
const VCS_GIT = /(?:^|[\s;&|(])git(?:\s+(?:-C|-c)\s+\S+)*/g;
/** git subcommands that bring other commits' files into the working tree, read right after a git word's options. */
const VCS_SUB = /\s+(?:pull|merge|rebase|cherry-pick|revert|am|reset|switch|checkout|stash\s+(?:pop|apply)|worktree\s+add|submodule\s+update)\b/y;

/**
 * Whether a command runs git (or gh) to bring other commits' files into the working tree. Each git
 * word's options are read once, so this takes time linear in the command.
 */
function importsCommits(command: string): boolean {
  if (VCS_GH.test(command)) return true;
  VCS_GIT.lastIndex = 0;
  for (let m = VCS_GIT.exec(command); m; m = VCS_GIT.exec(command)) {
    VCS_SUB.lastIndex = VCS_GIT.lastIndex;
    if (VCS_SUB.test(command)) return true;
  }
  return false;
}

export type ShellDiffOrigin = "edit" | "named" | "vcs" | "unattributed";

/**
 * Where a file in a shell call's dirty-tree diff (Claude Code's bashEditDiff)
 * came from. named: the command names the file (its basename at a word
 * boundary, heredoc bodies included, or a write target or glob it resolves to);
 * vcs: a git command that imports other commits' files (pull, merge, rebase,
 * reset, checkout <ref>, …); unattributed: neither, such as a test run or
 * another agent writing to the same checkout meanwhile.
 */
export function commandOrigin(command: string, path: string, cwd?: string): Exclude<ShellDiffOrigin, "edit"> {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base && new RegExp(`(?:^|[^\\w.-])${escapeRe(base)}(?:$|[^\\w.-])`).test(command)) return "named";
  for (const w of shellWrites(command)) {
    const p = normalizeTracePath(w.path, cwd);
    if (p === path || (/[*?]/.test(p) && globRe(p).test(path))) return "named";
  }
  return importsCommits(stripHeredocs(command)) ? "vcs" : "unattributed";
}

/** commandOrigin of a file.change, or "edit" when an edit tool (not a shell) made it. `start` is the call's tool.start. */
export function shellDiffOrigin(change: AgentEvent, start: AgentEvent | undefined, cwd?: string): ShellDiffOrigin {
  const tool = str(change.payload.tool) ?? str(start?.payload.tool);
  if (!tool || !isShellCall(tool, start?.payload.input)) return "edit";
  const command = start ? shellCommand(str(start.payload.tool), start.payload.input) : undefined;
  if (command === undefined) return "unattributed";
  return commandOrigin(command, normalizeTracePath(str(change.payload.path) ?? "", cwd), cwd);
}
