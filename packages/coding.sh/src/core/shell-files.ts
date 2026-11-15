// Files a shell call writes, keyed the way Session.stats.filesChanged keys an
// edit tool's file.change: relative to the session's working directory, so a
// file edited both ways counts once. Conservative: a path counts only when the
// command names it literally and it resolves inside the working directory.
// Reads, deletes and paths behind a variable, a glob or a git branch name do not
// count. Pure: rules over strings, no I/O.
import { posix } from "node:path";
import { isShellTool, shellCommandOf } from "../adapters/_shared/tools.ts";
import { normalizeTracePath, shellWrites, simpleCommands } from "./shell-diff.ts";

const ABSOLUTE = /^(?:\/|[A-Za-z]:\/|~)/;

/** PowerShell cmdlets that write a file: the parameters that name it, and the ones that take a value (so it is not read as the path). */
const PS_WRITERS: Record<string, { path: readonly string[]; values: readonly string[] }> = {
  "set-content": { path: ["-path", "-literalpath", "-lp", "-pspath"], values: ["-value", "-encoding", "-stream", "-filter", "-include", "-exclude", "-credential", "-delimiter"] },
  "add-content": { path: ["-path", "-literalpath", "-lp", "-pspath"], values: ["-value", "-encoding", "-stream", "-filter", "-include", "-exclude", "-credential", "-delimiter"] },
  "out-file": { path: ["-filepath", "-path", "-literalpath", "-lp", "-pspath"], values: ["-inputobject", "-encoding", "-width"] },
};
/** Common parameters that take a value. */
const PS_COMMON = ["-erroraction", "-ea", "-warningaction", "-wa", "-informationaction", "-infa", "-errorvariable", "-ev", "-warningvariable", "-wv", "-outvariable", "-ov", "-outbuffer", "-ob", "-pipelinevariable", "-pv"];

/** A literal file path: no variable, glob, brace list or subshell, not a device, not a directory. */
function literalPath(p: string): boolean {
  if (!p || p.startsWith("-") || /[$`*?[\]{}()<>|]/.test(p) || p.endsWith("/") || p.endsWith("\\")) return false;
  if (/^\/dev\//.test(p) || /^(?:nul|con|prn|aux)(?:\.\w*)?$/i.test(p)) return false;
  return /[./\\]/.test(p) && p !== "." && p !== "..";
}

/** The file a PowerShell writer cmdlet names: its -Path (or -FilePath, -LiteralPath) value, else its first positional word. */
function psTarget(args: readonly string[], spec: { path: readonly string[]; values: readonly string[] }): string | undefined {
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("-")) {
      positional ??= a;
      continue;
    }
    // `-Path:a.txt` keeps the value in the same word.
    const colon = a.indexOf(":");
    const name = (colon > 0 ? a.slice(0, colon) : a).toLowerCase();
    if (spec.path.includes(name)) return colon > 0 ? a.slice(colon + 1) : args[i + 1];
    if (colon < 0 && (spec.values.includes(name) || PS_COMMON.includes(name))) i++;
  }
  return positional;
}

/**
 * Paths a shell command writes, from its text: `>` and `>>` targets (not
 * /dev/null or a file descriptor), `tee`, `sed -i`, `perl -i`, `truncate`, the
 * target of `cp` and `mv`, `git checkout|restore -- <path>`, and PowerShell's
 * Set-Content, Add-Content and Out-File. `powershell`: the command ran in
 * PowerShell, so a `\` in a path is a separator, not an escape.
 */
export function shellWrittenPaths(command: string, powershell = false): string[] {
  const out = new Set<string>();
  const cmds = simpleCommands(command);
  // `git checkout <name>` with no `--` may name a branch (feature/x), not a file.
  const gitNames = new Set<string>();
  for (const { cmd, args, dir } of cmds) {
    if (cmd !== "git" || args.includes("--")) continue;
    for (const a of args.slice(1)) if (!a.startsWith("-")) gitNames.add(dir && !ABSOLUTE.test(a) ? posix.join(dir, a) : a);
  }
  for (const w of shellWrites(command)) {
    if (w.op === "delete" || (w.op === "modify" && gitNames.has(w.path))) continue;
    if (literalPath(w.path)) out.add(w.path);
  }
  for (const { cmd, args, redirects, dir } of cmds) {
    const under = (p: string) => {
      const s = p.replace(/\\/g, "/");
      return dir && !ABSOLUTE.test(s) ? posix.join(dir, s) : s;
    };
    const spec = PS_WRITERS[cmd.toLowerCase()];
    if (spec) {
      const target = psTarget(args, spec);
      if (target && literalPath(target)) out.add(under(target));
    }
    // shellWrites keeps only `/`-separated redirect targets; PowerShell writes `> out\log.txt`.
    if (powershell) for (const r of redirects) if (r.path.includes("\\") && literalPath(r.path)) out.add(under(r.path));
  }
  return [...out];
}

/**
 * A written path as a filesChanged key: relative to `cwd` (after `workdir`, the
 * directory the call ran in, when it names one), or undefined when it falls
 * outside the working directory (a scratch file under /tmp, a dotfile in ~).
 */
export function writtenFileKey(path: string, cwd?: string, workdir?: string): string | undefined {
  let p = path.replace(/\\/g, "/");
  if (workdir && !ABSOLUTE.test(p)) p = posix.join(workdir.replace(/\\/g, "/"), p);
  p = normalizeTracePath(p, cwd);
  if (ABSOLUTE.test(p)) return undefined;
  p = posix.normalize(p);
  return p === "." || p === ".." || p.startsWith("../") ? undefined : p;
}

/**
 * The filesChanged keys of the files a shell tool call writes (shellWrittenPaths,
 * then writtenFileKey), or none for a call that is not a shell command.
 */
export function shellCallFiles(tool: unknown, input: unknown, cwd?: string): string[] {
  if (typeof tool !== "string" || !isShellTool(tool)) return [];
  const command = shellCommandOf(tool, input);
  if (!command) return [];
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const workdir = typeof i.workdir === "string" ? i.workdir : typeof i.cwd === "string" ? i.cwd : undefined;
  const keys = new Set<string>();
  for (const p of shellWrittenPaths(command, /powershell/i.test(tool))) {
    const k = writtenFileKey(p, cwd, workdir);
    if (k) keys.add(k);
  }
  return [...keys];
}
