// coding.sh run -- <cmd> [args...]: run any agent under the capture wrapper.
// Exits with the child's exit code (128+n when it died from signal n).
import { constants } from "node:os";
import { basename } from "node:path";
import { wrapRunDetailed } from "../../capture/wrapper.ts";
import { loadConfig } from "../../core/config.ts";
import { str } from "../common.ts";
import { duration } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** Agents with no hooks (tier C) are captured only by this wrapper, so their sessions carry their own id. */
async function agentFor(cmd: string): Promise<string> {
  const { getAdapter } = await import("../../adapters/index.ts");
  const a = getAdapter(basename(cmd).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase());
  return a?.tier === "C" ? a.id : "wrapper";
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const [cmd, ...args] = c.rest;
  const config = loadConfig({ env: c.env, cwd: c.cwd });
  const r = await wrapRunDetailed({
    cmd: cmd!,
    args,
    cwd: c.cwd,
    env: c.env,
    agentId: str(c.flags.agent) ?? (await agentFor(cmd!)),
    // --json: stdout is reserved for the single result document, so the child's stdout goes to stderr.
    ...(out.json ? { stdoutToStderr: true } : {}),
    ...(config.snapshot.enabled ? { snapshot: { maxFiles: config.snapshot.maxFiles, timeoutMs: config.snapshot.timeoutMs } } : {}),
  });
  const code = r.signal ? 128 + ((constants.signals as Record<string, number>)[r.signal] ?? 0) : r.exitCode;
  if (out.json) {
    out.data({ sessionId: r.sessionId, exitCode: r.exitCode, signal: r.signal ?? null, durationMs: r.durationMs, filesChanged: r.diff?.files.length ?? null, error: r.error ?? null });
  } else if (r.error) {
    out.fail(`${r.error}${r.exitCode === 127 ? " (command not found)" : ""}`);
    out.note(`Session ${r.sessionId} recorded (exit ${r.exitCode})`);
  } else {
    out.ok(`Captured session ${r.sessionId} (the command ran ${duration(r.durationMs)}, exit ${r.signal ?? r.exitCode})`);
  }
  return code;
}
