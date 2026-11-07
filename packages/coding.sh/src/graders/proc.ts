// Spawn a user command (argv form, never a shell) with JSON on stdin, capture
// stdout/stderr, and kill the whole process group on timeout. Shared by the
// command grader and the command task so ANY agent or scorer in any language
// plugs in through the same, well-defined interface.
import { spawn } from "node:child_process";
import { supervise } from "../core/children.ts";

export interface CommandSpec {
  /** Executable (resolved on PATH). */
  command: string;
  args?: string[];
  cwd?: string;
  /** Extra environment variables (merged over the parent's environment). */
  env?: Record<string, string>;
  /** Default 60 s. 0 disables the timeout. */
  timeoutMs?: number;
}

export interface ProcResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** stdout or stderr exceeded maxOutputBytes and was cut. */
  truncated: boolean;
  /** Set when the process could not be started (ENOENT, EACCES, …). */
  spawnError?: string;
  /** The abort signal fired before the process exited (it was killed). */
  aborted?: boolean;
}

export interface RunProcessOpts extends CommandSpec {
  stdin?: string;
  maxOutputBytes?: number;
  /** Kill the process group on abort (default: the ambient signal, see core/children.ts). */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;

export function runProcess(opts: RunProcessOpts): Promise<ProcResult> {
  const started = Date.now();
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let truncated = false;
  const detached = process.platform !== "win32";
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached,
      windowsHide: true,
    });
  } catch (e) {
    return Promise.resolve({ exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 0, truncated: false, spawnError: (e as Error).message });
  }
  child.stdout?.on("data", (b: Buffer) => {
    if (outBytes + b.length > max) {
      truncated = true;
      const room = max - outBytes;
      if (room > 0) out.push(b.subarray(0, room));
      outBytes = max;
      return;
    }
    out.push(b);
    outBytes += b.length;
  });
  child.stderr?.on("data", (b: Buffer) => {
    if (errBytes + b.length > max) {
      truncated = true;
      return;
    }
    err.push(b);
    errBytes += b.length;
  });
  // The child may exit without reading stdin; EPIPE is not our failure.
  child.stdin?.on("error", () => {});
  child.stdin?.end(opts.stdin ?? "");
  return supervise(child, { group: detached, timeoutMs, signal: opts.signal }).then((s) => {
    const r: ProcResult = {
      exitCode: s.code,
      signal: s.signal,
      timedOut: s.timedOut,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
      durationMs: Date.now() - started,
      truncated,
    };
    if (s.error) r.spawnError = s.error.message;
    if (s.aborted) r.aborted = true;
    return r;
  });
}

/** One-line description of how a process failed, for error fields. */
export function describeFailure(r: ProcResult, timeoutMs?: number): string {
  if (r.spawnError) return `could not start: ${r.spawnError}`;
  if (r.timedOut) return `timed out after ${timeoutMs ?? DEFAULT_TIMEOUT} ms`;
  if (r.aborted) return "aborted";
  const tail = r.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500);
  const how = r.signal ? `killed by ${r.signal}` : `exited ${r.exitCode}`;
  return tail ? `${how}: ${tail}` : how;
}

/** argv rendered for humans (quotes args with spaces). */
export function formatArgv(spec: Pick<CommandSpec, "command" | "args">): string {
  return [spec.command, ...(spec.args ?? [])].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}
