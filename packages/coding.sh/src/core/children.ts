// Child process supervision shared by every spawn helper (runner/exec.ts,
// graders/proc.ts, adapters' runHeadless and spawnAgent):
//
// - Settle on 'exit', not 'close'. A command that exits but leaves a
//   background child holding stdout would otherwise look hung until its
//   timeout. On 'exit' the process group is SIGKILLed (which closes the pipes
//   the leftovers hold), then 'close' is awaited for at most a short grace.
// - Cancellation: an explicit AbortSignal, else the ambient one installed with
//   withAbortSignal(). The ambient signal reaches spawns made deep inside code
//   that takes no signal parameter (an adapter's run(), a sandbox setup step).
// - Every live child process group is registered and SIGKILLed on process
//   'exit', so a hard exit (a second Ctrl-C, process.exit) never orphans an
//   agent that keeps running, and spending, after the CLI is gone.
// - Scratch dirs (task work dirs, sandboxes) registered with removeOnExit are
//   deleted in the same hook, after the kill, when the abort never reached
//   the code that would have removed them.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { killTree } from "./spawn.ts";

const ambient = new AsyncLocalStorage<AbortSignal>();

/** Run `fn` with `signal` as the ambient abort signal for every child spawned inside it (sync or async). */
export function withAbortSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return signal ? ambient.run(signal, fn) : fn();
}

/** The ambient abort signal, if any (see withAbortSignal). */
export function currentAbortSignal(): AbortSignal | undefined {
  return ambient.getStore();
}

/** pid → whether it leads its own process group (spawned detached). */
const live = new Map<number, boolean>();
/** Scratch dirs to delete on a hard exit. */
const scratch = new Set<string>();
let exitHook = false;

/** On process 'exit' (synchronous): kill the live children first, so nothing still writes, then delete the scratch dirs. */
function onExit(): void {
  killLiveChildren();
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // best effort while exiting
    }
  }
  scratch.clear();
}

function installExitHook(): void {
  if (exitHook) return;
  exitHook = true;
  // 'exit' handlers must be synchronous; process.kill and rmSync are.
  process.on("exit", onExit);
}

/**
 * Deletes `dir` if the process exits while it is still registered. Call the
 * returned function once the dir is removed normally (or must be kept).
 */
export function removeOnExit(dir: string): () => void {
  scratch.add(dir);
  installExitHook();
  return () => {
    scratch.delete(dir);
  };
}

function sendTo(pid: number, group: boolean, sig: NodeJS.Signals): void {
  // Windows has no process groups or catchable signals: end the whole tree.
  if (process.platform === "win32") return killTree(pid);
  try {
    process.kill(group ? -pid : pid, sig);
  } catch {
    // already gone
  }
}

/** SIGKILL every live child (whole groups for detached ones). Returns how many were signalled. */
export function killLiveChildren(): number {
  const n = live.size;
  // One synchronous taskkill for all of them: this runs in the 'exit' handler.
  if (process.platform === "win32") killTree([...live.keys()], true);
  else for (const [pid, group] of live) sendTo(pid, group, "SIGKILL");
  live.clear();
  return n;
}

/** Number of children currently tracked (tests). */
export function liveChildCount(): number {
  return live.size;
}

function track(pid: number, group: boolean): void {
  live.set(pid, group);
  installExitHook();
}

/**
 * Registers a long-lived child that is not run through supervise() (an MCP
 * server behind a tap, a stdio relay), so a hard exit SIGKILLs it too. It is
 * dropped from the registry once it exits or fails to start.
 */
export function trackChild(child: ChildProcess, group = false): void {
  const pid = child.pid;
  if (pid === undefined) return;
  track(pid, group);
  const drop = () => live.delete(pid);
  child.once("exit", drop);
  child.once("error", drop);
}

export interface SuperviseOpts {
  /** The child was spawned detached and leads its own process group (POSIX). */
  group: boolean;
  /** Wall-clock limit; 0 or undefined disables it. */
  timeoutMs?: number;
  /** On timeout or abort send SIGTERM first and SIGKILL this many ms later; default SIGKILL at once (always on Windows). */
  termGraceMs?: number;
  /** Explicit cancellation; defaults to the ambient signal. */
  signal?: AbortSignal;
  /** After 'exit', how long to wait for the stdio pipes to close. Default 1000 ms. */
  closeGraceMs?: number;
}

export interface Settled {
  /** Exit code from 'exit' (null when killed by a signal, timed out, or never started). */
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** The abort signal fired before the child exited. */
  aborted: boolean;
  /** Spawn failure (ENOENT, EACCES, …). */
  error?: NodeJS.ErrnoException;
}

/** Watch a spawned child until it settles; never rejects. Callers keep their own stdout/stderr listeners. */
export function supervise(child: ChildProcess, o: SuperviseOpts): Promise<Settled> {
  return new Promise((resolve) => {
    const pid = child.pid;
    const group = o.group && pid !== undefined && process.platform !== "win32";
    let timedOut = false;
    let aborted = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const send = (sig: NodeJS.Signals) => {
      if (group || (process.platform === "win32" && pid !== undefined)) sendTo(pid!, group, sig);
      else {
        try {
          child.kill(sig);
        } catch {
          // gone
        }
      }
    };
    const stop = () => {
      // No SIGTERM to wait on under Windows: every kill there is already a tree kill.
      if (o.termGraceMs && o.termGraceMs > 0 && process.platform !== "win32") {
        send("SIGTERM");
        killTimer ??= setTimeout(() => send("SIGKILL"), o.termGraceMs);
      } else send("SIGKILL");
    };
    if (pid !== undefined) track(pid, group);
    const timer =
      o.timeoutMs && o.timeoutMs > 0
        ? setTimeout(() => {
            if (exited) return;
            timedOut = true;
            stop();
          }, o.timeoutMs)
        : undefined;
    const signal = o.signal ?? currentAbortSignal();
    const onAbort = () => {
      if (exited || settled) return;
      aborted = true;
      stop();
    };

    // After the child exits, its group can still be signalled on POSIX. On Windows the
    // tree is found from a live root, so there is nothing left to aim taskkill at
    // (and the pid may already be reused).
    const reapGroup = group && process.platform !== "win32";
    const finish = (r: { code: number | null; signal: NodeJS.Signals | null; error?: NodeJS.ErrnoException }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      if (reapGroup) sendTo(pid!, true, "SIGKILL"); // reap leftover grandchildren
      if (pid !== undefined) live.delete(pid);
      // A pipe still held by an escaped grandchild (own session) must not keep us alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      const s: Settled = { code: timedOut || aborted ? null : r.code, signal: r.signal, timedOut, aborted };
      if (r.error) s.error = r.error;
      resolve(s);
    };
    child.on("error", (e: NodeJS.ErrnoException) => finish({ code: null, signal: null, error: e }));
    child.on("exit", (code, sig) => {
      if (exited) return;
      exited = { code, signal: sig };
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // Kill what the child left behind so the pipes it holds close, then give 'close' a moment.
      if (reapGroup) sendTo(pid!, true, "SIGKILL");
      graceTimer = setTimeout(() => finish(exited!), o.closeGraceMs ?? 1000);
    });
    child.on("close", (code, sig) => finish(exited ?? { code, signal: sig }));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
