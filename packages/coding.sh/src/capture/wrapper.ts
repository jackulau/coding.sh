// `coding.sh run -- <cmd>`: the universal capture fallback for agents without hooks.
//
//   snapshot(cwd) → spool session.start → spawn cmd (stdio inherited, TTY passthrough;
//   with stdoutToStderr the child's stdout goes to fd 2)
//   → snapshot(cwd) → spool one file.change per changed file → spool session.end
//
// Spool lines use the agent id `agentId` (default "wrapper") and the same writer
// as the hook (appendSpool), so ingest handles them like any other agent. Every
// line's raw payload carries `sessionId`, a UUID also exported to the child as
// CODING_SH_SESSION_ID. CODING_SH_RUN_ID passes through to the child and is
// recorded as runId.
//
// Raw payloads:
//   session.start: { sessionId, cmd, args, cwd, repo?: RepoState }
//   file.change:   { sessionId, path, op: "add"|"modify"|"delete", additions, deletions, binary? }
//   session.end:   { sessionId, exitCode, signal?, durationMs, error?, repo?: RepoState,
//                    startSnapshot?, endSnapshot?, patch? }   (large → side file via appendSpool)
//   llm.usage:     { sessionId, seq, model?, usage: Usage, sessionCostUsd? }   (Aider only: one per
//                    model reply, read from Aider's analytics log while it runs; see aider.ts)
//
// Signals: SIGTERM/SIGHUP/SIGQUIT received by the wrapper are forwarded to the
// child. SIGINT is forwarded too, except when stdin is a TTY: then Ctrl-C has
// already reached the child through the terminal's foreground process group, and
// forwarding it again would look like a double Ctrl-C (which many agents treat as
// "force quit"). The wrapper itself never dies of these signals; it waits for the
// child and returns its status.
//
// Capture failures (snapshot, spool I/O) are logged to spool/errors.log and never
// change the command's exit code.
import type { ChildProcess } from "node:child_process";
import { spawn } from "../core/spawn.ts";
import { randomUUID } from "node:crypto";
import { trackChild } from "../core/children.ts";
import { constants } from "node:os";
import { isatty } from "node:tty";
import type { SpoolLine } from "../core/types.ts";
import { gatewayFromEnv } from "../integrations/gateway/ids.ts";
import type { RepoState } from "../schema/index.ts";
import { redactArgv } from "../core/redact.ts";
import { diffSnapshots, snapshot } from "../core/snapshot.ts";
import type { DiffResult, SnapshotOptions } from "../core/snapshot.ts";
import { appendSpool, isDisabled, logSpoolError } from "../spool/write.ts";
import { aiderUsageTap } from "./aider.ts";
import type { AiderUsageRecord, AiderUsageTap } from "./aider.ts";

export interface WrapRunOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  /** Extra env for the child, merged over process.env. Also used to resolve CODING_SH_HOME. */
  env?: Record<string, string | undefined>;
  agentId?: string;
  snapshot?: Pick<SnapshotOptions, "maxFiles" | "timeoutMs">;
  /**
   * Send the child's stdout to the wrapper's stderr (fd 2) instead of its stdout.
   * Used by `run --json` so stdout carries only the one JSON result document.
   */
  stdoutToStderr?: boolean;
}

export interface WrapRunResult {
  exitCode: number;
  signal?: NodeJS.Signals;
  durationMs: number;
  sessionId: string;
  start?: RepoState;
  end?: RepoState;
  diff?: DiffResult;
  /** Why the command could not start (e.g. "foo: spawn foo ENOENT"). Set only when exitCode is 126/127 from a spawn failure. */
  error?: string;
}

const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

/** Run `cmd` under capture and return its exit code (128 + signo when killed by a signal; 127 when it couldn't start). */
export async function wrapRun(opts: WrapRunOptions): Promise<number> {
  return (await wrapRunDetailed(opts)).exitCode;
}

export async function wrapRunDetailed(opts: WrapRunOptions): Promise<WrapRunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const args = opts.args ?? [];
  const agent = opts.agentId ?? "wrapper";
  const sessionId = randomUUID();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  env.CODING_SH_SESSION_ID = sessionId;
  const disabled = isDisabled(env);
  const runId = env.CODING_SH_RUN_ID;
  const gateway = gatewayFromEnv(env);
  const snapOpts: SnapshotOptions = { ...opts.snapshot, env };

  const spool = (event: string, raw: Record<string, unknown>, ts = Date.now()) => {
    if (disabled) return;
    try {
      const line: SpoolLine = { v: 0, agent, event, ts, pid: process.pid, cwd, raw: { sessionId, ...raw } };
      if (runId) line.runId = runId;
      if (gateway) line.gateway = gateway;
      appendSpool(line, env);
    } catch (e) {
      logSpoolError(e, { agent, event, where: "wrapper" }, env);
    }
  };
  const snap = async (when: string): Promise<RepoState | undefined> => {
    if (disabled) return undefined;
    try {
      return await snapshot(cwd, { ...snapOpts, message: `coding.sh ${when} ${sessionId}` });
    } catch (e) {
      logSpoolError(e, { agent, event: `snapshot.${when}`, where: "wrapper" }, env);
      return undefined;
    }
  };

  const start = await snap("start");
  // Secret flag values (--openai-api-key X) never reach the spool; ingest redacts them again.
  spool("session.start", { cmd: opts.cmd, args: redactArgv(args), cwd, repo: start });

  const t0 = Date.now();
  // Aider prints usage to the terminal it owns; read the copies it writes to disk instead.
  const tap: AiderUsageTap | undefined = agent === "aider" && !disabled ? aiderUsageTap({ args, cwd, env, gitRoot: start?.root, startedAt: t0 }) : undefined;
  Object.assign(env, tap?.env);
  let seq = 0;
  const spoolUsage = (records: AiderUsageRecord[]) => {
    for (const r of records) spool("llm.usage", { seq: seq++, ...(r.model ? { model: r.model } : {}), usage: r.usage, ...(r.sessionCostUsd ? { sessionCostUsd: r.sessionCostUsd } : {}) }, r.ts);
  };
  const timer = tap ? setInterval(() => spoolUsage(tap.poll()), 1000) : undefined;
  timer?.unref();
  const { exitCode, signal, error } = await new Promise<{ exitCode: number; signal?: NodeJS.Signals; error?: string }>((resolve) => {
    // isatty(0), not process.stdin: touching process.stdin would open a reader on the TTY the child owns.
    const stdinIsTTY = isatty(0);
    // Handlers go in before the spawn: a SIGTERM landing between spawn() and
    // process.on() would otherwise kill the wrapper by default and orphan the child.
    let child: ChildProcess | undefined;
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const sig of FORWARDED) {
      const h = () => {
        if (sig === "SIGINT" && stdinIsTTY) return; // child already got it from the TTY
        try {
          child?.kill(sig);
        } catch {
          // child gone
        }
      };
      handlers.set(sig, h);
      process.on(sig, h);
    }
    child = spawn(opts.cmd, args, { cwd, env, stdio: opts.stdoutToStderr ? ["inherit", 2, "inherit"] : "inherit" });
    // If the wrapper itself dies hard (uncaught error, process.exit), take the child with it.
    trackChild(child);
    const cleanup = () => {
      for (const [sig, h] of handlers) process.removeListener(sig, h);
    };
    child.on("error", (e: NodeJS.ErrnoException) => {
      cleanup();
      resolve({ exitCode: e.code === "ENOENT" ? 127 : 126, error: `${opts.cmd}: ${e.message}` });
    });
    child.on("exit", (code, sig) => {
      cleanup();
      if (sig) resolve({ exitCode: 128 + (constants.signals[sig] ?? 0), signal: sig });
      else resolve({ exitCode: code ?? 1 });
    });
  });
  const durationMs = Date.now() - t0;
  if (timer) clearInterval(timer);
  if (tap) spoolUsage(tap.close());

  const end = await snap("end");
  let diff: DiffResult | undefined;
  if (start?.snapshot && end?.snapshot && start.root === end.root) {
    try {
      diff = await diffSnapshots(start.root, start.snapshot, end.snapshot, env);
    } catch (e) {
      logSpoolError(e, { agent, event: "diff", where: "wrapper" }, env);
    }
  }
  for (const f of diff?.files ?? []) {
    spool("file.change", { path: f.path, op: f.status, additions: f.additions, deletions: f.deletions, ...(f.binary ? { binary: true } : {}) });
  }
  spool("session.end", {
    exitCode,
    ...(signal ? { signal } : {}),
    durationMs,
    ...(error ? { error } : {}),
    repo: end,
    startSnapshot: start?.snapshot,
    endSnapshot: end?.snapshot,
    ...(diff && diff.patch ? { patch: diff.patch } : {}),
  });
  const result: WrapRunResult = { exitCode, durationMs, sessionId };
  if (signal) result.signal = signal;
  if (start) result.start = start;
  if (end) result.end = end;
  if (diff) result.diff = diff;
  if (error) result.error = error;
  return result;
}
