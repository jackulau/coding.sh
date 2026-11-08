// Shell commands and the files they touch: the command of a tool call, the
// files it writes (shellWrites), and whether a file a shell call's dirty-tree
// diff reports was written by that command (shellDiffOrigin). Pure: rules over
// strings, no I/O.
import { posix } from "node:path";
import type { AgentEvent } from "../schema/index.ts";

/** Repo-relative, forward slashes, no leading "./". macOS `/private/var/…` and `/var/…` are one root. */
export function normalizeTracePath(p: string, cwd?: string): string {
  const unprivate = (x: string) => x.replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, "");
  let s = unprivate(p.replace(/\\/g, "/"));
  const root = cwd ? unprivate(cwd.replace(/\\/g, "/").replace(/\/+$/, "")) : undefined;
  if (root && (s === root || s.startsWith(`${root}/`))) s = s.slice(root.length + 1);
  return s.replace(/^(?:\.\/)+/, "");
}

/** The shell command of a tool call's input, unless it is a patch passed as `command` (Codex apply_patch). */
export function shellCommand(tool: string | undefined, input: unknown): string | undefined {
  if (tool && /patch/i.test(tool)) return undefined;
  let cmd: string | undefined;
  if (typeof input === "string") cmd = input;
  else if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["command", "cmd", "script", "commandLine"]) {
      const v = o[k];
      if (typeof v === "string") cmd = v;
      else if (Array.isArray(v) && v.every((x) => typeof x === "string")) cmd = (v.length >= 3 && /(^|\/)(ba|z|)sh$/.test(v[0] as string) && /^-\w*c$/.test(v[1] as string) ? v.slice(2) : v).join(" ");
      if (cmd !== undefined) break;
    }
  }
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

/**
 * Files a shell command writes or removes: `sed -i`, `perl -pi`, `>`/`>>`,
 * `tee`, `rm`, `mv`, `cp`, `truncate`, `git checkout|restore -- <path>`, `git rm`.
 * Heredoc bodies are skipped. Best effort: what it can't parse it leaves out.
 */
export function shellWrites(command: string): ShellWrite[] {
  const out: ShellWrite[] = [];
  /** Set by `cd <dir>` earlier in the command: later relative paths are under it. */
  let dir: string | undefined;
  const under = (path: string) => (dir && !/^(?:\/|[A-Za-z]:[\\/]|~)/.test(path) ? posix.join(dir, path) : path);
  const add = (path: string, op: ShellWrite["op"], renamedTo?: string) => {
    // After `cd $DIR` relative paths are unknowable.
    if (!pathLike(path) || path.startsWith("/dev/") || (dir?.includes("$") && !/^(?:\/|[A-Za-z]:[\\/]|~)/.test(path))) return;
    out.push({ path: under(path), op, ...(renamedTo !== undefined ? { renamedTo: under(renamedTo) } : {}) });
  };
  const text = stripHeredocs(command).replace(/\d*>&\d+|<<-?\s*(['"]?)[\w.-]+\1/g, " ").replace(/&>/g, ">");
  for (const seg of text.split(/&&|\|\||[;|&\n]/)) {
    const words = (seg.match(WORD) ?? []).map(unquote);
    // Redirections write their target wherever they sit.
    const rest: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i] as string;
      const r = /^\d*(>>?)(.*)$/.exec(w);
      if (r) {
        const target = r[2] || words[++i];
        if (target) add(target, r[1] === ">>" ? "append" : "create");
      } else rest.push(w);
    }
    while (rest.length && (/^[A-Za-z_]\w*=/.test(rest[0] as string) || ["sudo", "command", "env", "time", "nohup"].includes(rest[0] as string))) rest.shift();
    const cmd = (rest[0] ?? "").replace(/^.*\//, "");
    const args = rest.slice(1);
    const operands = (skipValueOf: readonly string[] = []) => {
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
    };
    if ((cmd === "cd" || cmd === "pushd") && args[0] && !args[0].startsWith("-")) {
      const to = args[0].replace(/\\/g, "/");
      dir = dir && !/^(?:\/|[A-Za-z]:\/|~)/.test(to) ? posix.join(dir, to) : to;
    } else if (cmd === "sed" && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) {
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

const SHELL_TOOLS = new Set(["bash", "shell", "shell_command", "exec_command", "local_shell", "local_shell_call", "run_terminal_cmd", "terminal", "command_execution", "run_shell_command", "execute_command", "powershell"]);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** git (and gh) commands that bring other commits' files into the working tree. */
const VCS =
  /(?:^|[\s;&|(])git(?:\s+(?:-C|-c)\s+\S+)*\s+(?:pull|merge|rebase|cherry-pick|revert|am|reset|switch|checkout|stash\s+(?:pop|apply)|worktree\s+add|submodule\s+update)\b|(?:^|[\s;&|(])gh\s+pr\s+(?:checkout|merge)\b/;

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
  return VCS.test(stripHeredocs(command)) ? "vcs" : "unattributed";
}

/** commandOrigin of a file.change, or "edit" when an edit tool (not a shell) made it. `start` is the call's tool.start. */
export function shellDiffOrigin(change: AgentEvent, start: AgentEvent | undefined, cwd?: string): ShellDiffOrigin {
  const tool = str(change.payload.tool) ?? str(start?.payload.tool);
  if (!tool || !SHELL_TOOLS.has(tool.toLowerCase())) return "edit";
  const command = start ? shellCommand(str(start.payload.tool), start.payload.input) : undefined;
  if (command === undefined) return "unattributed";
  return commandOrigin(command, normalizeTracePath(str(change.payload.path) ?? "", cwd), cwd);
}
