// Headless driver plumbing: spawn (argv, no shell) in its own process group,
// hard timeout that kills the group, stdout parsed as JSONL as it streams,
// and bounded stdout/stderr tails.
import { spawn } from "node:child_process";
import type { AgentRunOutput, RunSpec } from "../../core/types.ts";

const DEFAULT_TAIL = 16 * 1024;

class Tail {
  private chunks: string[] = [];
  private size = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(s: string): void {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.max * 2 && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }
  text(): string {
    const all = this.chunks.join("");
    return all.slice(Math.max(0, all.length - this.max));
  }
}

export interface HeadlessOpts {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  /** Called for every stdout line that parses as JSON. */
  onJson?: (value: unknown) => void;
  stdin?: string;
  tailBytes?: number;
}

export type HeadlessResult = Pick<AgentRunOutput, "exitCode" | "timedOut" | "durationMs" | "stdoutTail" | "stderrTail">;

/** Spawns the agent; never rejects (spawn errors become exit 127 + stderr note). */
export function runHeadless(o: HeadlessOpts): Promise<HeadlessResult> {
  const started = Date.now();
  const max = o.tailBytes ?? DEFAULT_TAIL;
  return new Promise((resolve) => {
    const out = new Tail(max);
    const err = new Tail(max);
    let buf = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(o.bin, o.args, {
      cwd: o.cwd,
      env: o.env as NodeJS.ProcessEnv,
      stdio: [o.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const killGroup = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = o.timeoutMs > 0 ? setTimeout(() => ((timedOut = true), killGroup()), o.timeoutMs) : undefined;
    const feed = (line: string) => {
      if (!o.onJson) return;
      const t = line.trim();
      if (!t.startsWith("{") && !t.startsWith("[")) return;
      try {
        o.onJson(JSON.parse(t));
      } catch {
        // not JSON
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (s: string) => {
      out.push(s);
      buf += s;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        feed(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 64 * 1024 * 1024) buf = ""; // pathological unterminated line
    });
    child.stderr?.on("data", (s: string) => err.push(s));
    if (o.stdin !== undefined) child.stdin?.end(o.stdin);
    const finish = (code: number | null, note?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (buf) feed(buf);
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL"); // reap leftover grandchildren
        } catch {
          // group already empty
        }
      }
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        durationMs: Date.now() - started,
        stdoutTail: out.text(),
        stderrTail: note ? `${err.text()}\n${note}` : err.text(),
      });
    };
    child.on("error", (e) => finish(127, e.message));
    child.on("close", (code) => finish(code));
  });
}

/** Process env for a run: inherited env + spec env + CODING_SH_RUN_ID (always last). */
export function runEnv(spec: RunSpec, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, ...extra, ...spec.env, CODING_SH_RUN_ID: spec.runId };
}

/** True when `flags` already contains `name` (as "--x" or "--x=v"). */
export function hasFlag(flags: string[], ...names: string[]): boolean {
  return flags.some((f) => names.some((n) => f === n || f.startsWith(`${n}=`)));
}
