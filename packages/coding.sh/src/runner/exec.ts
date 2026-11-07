// Shell execution with a hard timeout that kills the whole process group, so a
// hung `npm test` (or an agent's grandchildren) cannot outlive the run.
import { spawn } from "node:child_process";

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface ExecOpts {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Bytes of stdout/stderr to keep (from the end). */
  tailBytes?: number;
  stdin?: string;
}

const DEFAULT_TAIL = 8 * 1024;

class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.max * 2 && this.chunks.length > 1) {
      this.size -= (this.chunks.shift() as Buffer).length;
    }
  }
  text(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - this.max)).toString("utf8");
  }
}

/** Run a command (argv form, no shell). Never rejects for non-zero exit. */
export function execFileTail(file: string, args: string[], opts: ExecOpts): Promise<ExecResult> {
  const started = Date.now();
  const max = opts.tailBytes ?? DEFAULT_TAIL;
  return new Promise((resolve) => {
    const out = new Tail(max);
    const err = new Tail(max);
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const kill = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, opts.timeoutMs)
        : undefined;
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    const finish = (exitCode: number | null, extraErr?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Reap any background grandchildren left in the group.
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // group already empty
        }
      }
      resolve({
        exitCode: timedOut ? null : exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdoutTail: out.text(),
        stderrTail: extraErr ? `${err.text()}${extraErr}` : err.text(),
      });
    };
    child.on("error", (e) => finish(127, `\n${e.message}`));
    child.on("close", (code) => finish(code));
  });
}

/** Run a shell command line via /bin/sh -c. */
export function sh(command: string, opts: ExecOpts): Promise<ExecResult> {
  return execFileTail("/bin/sh", ["-c", command], opts);
}

/** Environment for setup/verifier commands: inherit, force non-interactive test runners, no git trace2 side effects. */
export function commandEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, CI: process.env.CI ?? "1", GIT_TRACE2_EVENT: "0", ...extra };
}
