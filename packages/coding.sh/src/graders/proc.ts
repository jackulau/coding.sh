// Spawn a user command (argv form, never a shell) with JSON on stdin, capture
// stdout/stderr, and kill the whole process group on timeout. Shared by the
// command grader and the command task so ANY agent or scorer in any language
// plugs in through the same, well-defined interface.
import { spawn } from "node:child_process";

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
}

export interface RunProcessOpts extends CommandSpec {
  stdin?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;

export function runProcess(opts: RunProcessOpts): Promise<ProcResult> {
  const started = Date.now();
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
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
      resolve({ exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 0, truncated: false, spawnError: (e as Error).message });
      return;
    }
    const kill = () => {
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already exited
      }
    };
    const timer = timeoutMs > 0 ? setTimeout(() => ((timedOut = true), kill()), timeoutMs) : undefined;
    const onAbort = () => kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

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

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL"); // reap leftover grandchildren
        } catch {
          // group already gone
        }
      }
      const r: ProcResult = {
        exitCode: timedOut ? null : exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        durationMs: Date.now() - started,
        truncated,
      };
      if (spawnError) r.spawnError = spawnError;
      resolve(r);
    };
    child.on("error", (e) => finish(null, null, e.message));
    child.on("close", (code, sig) => finish(code, sig));
  });
}

/** One-line description of how a process failed, for error fields. */
export function describeFailure(r: ProcResult, timeoutMs?: number): string {
  if (r.spawnError) return `could not start: ${r.spawnError}`;
  if (r.timedOut) return `timed out after ${timeoutMs ?? DEFAULT_TIMEOUT} ms`;
  const tail = r.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500);
  const how = r.signal ? `killed by ${r.signal}` : `exited ${r.exitCode}`;
  return tail ? `${how}: ${tail}` : how;
}

/** argv rendered for humans (quotes args with spaces). */
export function formatArgv(spec: Pick<CommandSpec, "command" | "args">): string {
  return [spec.command, ...(spec.args ?? [])].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}
