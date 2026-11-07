// Shell execution with a hard timeout that kills the whole process group, so a
// hung `npm test` (or an agent's grandchildren) cannot outlive the run.
import { spawn } from "node:child_process";
import { supervise } from "../core/children.ts";

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
  /** Kill the process group on abort (default: the ambient signal, see core/children.ts). */
  signal?: AbortSignal;
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
  const out = new Tail(max);
  const err = new Tail(max);
  const group = process.platform !== "win32";
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    detached: group,
  });
  child.stdout?.on("data", (b: Buffer) => out.push(b));
  child.stderr?.on("data", (b: Buffer) => err.push(b));
  child.stdin?.on("error", () => {}); // the child may exit without reading stdin
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  return supervise(child, { group, timeoutMs: opts.timeoutMs, signal: opts.signal }).then((r) => {
    const extraErr = r.error ? `\n${r.error.message}` : "";
    return {
      exitCode: r.error ? 127 : r.code,
      timedOut: r.timedOut,
      durationMs: Date.now() - started,
      stdoutTail: out.text(),
      stderrTail: `${err.text()}${extraErr}`,
    };
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
