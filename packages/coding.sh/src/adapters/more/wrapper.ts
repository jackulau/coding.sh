// Tier C: `coding.sh run -- <cmd>` capture for agents without hooks.
//
// src/capture/wrapper.ts spools, under the agent id given to `run` (default
// "wrapper"):
//   session.start  { sessionId, cmd, args, cwd, repo? }
//   file.change    { sessionId, path, op, additions, deletions, binary? }   (pre/post snapshot diff)
//   session.end    { sessionId, exitCode, signal?, durationMs, error?, repo?, startSnapshot?, endSnapshot?, patch? }
// and, if a future wrapper tees output, stdout/stderr chunks:
//   stdout|stderr  { sessionId, text|chunk|data }
// "process.start"/"process.end" are accepted as aliases of session.start/end.
//
// normalizeWrapperLine is exported so any adapter (aider, or a hooked agent run
// under `coding.sh run --agent <id>`) can delegate these lines here.
import type { Adapter, AgentRunOutput, DetectResult, FileChange, NormalizeContext, RunSpec, SpoolLine } from "../../core/types.ts";
import type { AgentEvent, RepoState } from "../../schema/index.ts";
import { Emitter, attachRaw, clip, isObj, num, parseTestSummary, rawBlob, runEnv, spawnAgent, spoolIdParts, str, toRunOutput } from "./_util.ts";
import type { Json } from "./_util.ts";
import { redactArgv } from "../../core/redact.ts";

const START = new Set(["session.start", "process.start"]);
const END = new Set(["session.end", "process.end"]);
const CHUNK = new Set(["stdout", "stderr", "output", "process.stdout", "process.stderr"]);

/** True for spool event names the capture wrapper writes. */
export function isWrapperEvent(event: string): boolean {
  return START.has(event) || END.has(event) || CHUNK.has(event) || event === "file.change";
}

/**
 * True for a line the capture wrapper wrote (`coding.sh run --agent <id> -- …`)
 * into a hooked agent's spool: a wrapper event name and no hook_event_name
 * (hook payloads always carry one; their event names never collide).
 */
export function isWrapperLine(line: SpoolLine): boolean {
  return isWrapperEvent(line.event) && !(isObj(line.raw) && typeof line.raw.hook_event_name === "string");
}

function repoOf(v: unknown): RepoState | undefined {
  if (!isObj(v) || typeof v.root !== "string" || typeof v.head !== "string") return undefined;
  const r: RepoState = { root: v.root, head: v.head };
  if (typeof v.snapshot === "string") r.snapshot = v.snapshot;
  if (v.partial === true) r.partial = true;
  if (typeof v.branch === "string") r.branch = v.branch;
  return r;
}

/** Session id for a wrapper line: the wrapper's UUID, else a stable per-process fallback. */
export function wrapperSessionId(line: SpoolLine, ctx: NormalizeContext): string {
  const raw = isObj(line.raw) ? line.raw : {};
  return str(raw.sessionId) ?? str(raw.session_id) ?? `wrapper-${ctx.id("wrapper-session", line.agent, line.pid, line.cwd).slice(0, 24)}`;
}

export async function normalizeWrapperLine(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  const raw: Json = isObj(line.raw) ? line.raw : { text: typeof line.raw === "string" ? line.raw : undefined };
  const sessionId = wrapperSessionId(line, ctx);
  const cwd = str(raw.cwd) ?? line.cwd;
  const em = new Emitter(ctx, { agent: line.agent, sessionId, ts: line.ts, cwd, runId: line.runId }, spoolIdParts(line, sessionId, ctx));
  const repo = repoOf(raw.repo);
  const ev = line.event;

  if (START.has(ev)) {
    const args = redactArgv(Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : []);
    const c = await clip(ctx, args);
    em.push("session.start", { source: "wrapper", cmd: str(raw.cmd), args: c.value }, { ...(repo ? { repo } : {}), ...(c.blob ? { blobs: [c.blob] } : {}) });
  } else if (ev === "file.change") {
    const path = str(raw.path);
    if (path) {
      const op = raw.op === "add" || raw.op === "delete" ? raw.op : "modify";
      em.push("file.change", { path, op, additions: num(raw.additions), deletions: num(raw.deletions), binary: raw.binary === true ? true : undefined });
    }
  } else if (END.has(ev)) {
    const exitCode = num(raw.exitCode);
    const durationMs = num(raw.durationMs);
    const signal = str(raw.signal);
    const blobs: string[] = [];
    if (typeof raw.patch === "string" && raw.patch) blobs.push(await ctx.blob(raw.patch));
    const error = str(raw.error);
    if (error) em.push("error", { message: error, exitCode });
    em.push(
      "session.end",
      {
        reason: signal ? `signal:${signal}` : exitCode === 0 ? "exit" : exitCode === undefined ? undefined : `exit:${exitCode}`,
        exitCode,
        signal,
        startSnapshot: str(raw.startSnapshot),
        endSnapshot: str(raw.endSnapshot),
        patch: blobs.length ? true : undefined,
      },
      { ...(durationMs !== undefined ? { durationMs } : {}), ...(repo ? { repo } : {}), blobs },
    );
  } else if (CHUNK.has(ev)) {
    const text = str(raw.text) ?? str(raw.chunk) ?? str(raw.data);
    if (text) {
      const stream = ev.includes("stderr") || raw.stream === "stderr" ? "stderr" : "stdout";
      const c = await clip(ctx, text, 2048);
      em.push("notification", { kind: "output", stream, text: c.value }, c.blob ? { blobs: [c.blob] } : {});
      const tr = parseTestSummary(text);
      if (tr) em.push("test.result", { ...tr, source: "output" });
    }
  } else {
    return [];
  }
  // Spool lines from before the wrapper redacted argv can still carry --api-key values.
  const kept = Array.isArray(raw.args) ? { ...raw, args: redactArgv(raw.args) } : line.raw;
  return attachRaw(em.events, await rawBlob(ctx, kept));
}

/** Split "cmd --flag 'quoted arg'" respecting simple quotes (for `wrapper` run flags given as one string). */
function splitCommand(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export const wrapperAdapter: Adapter = {
  id: "wrapper",
  displayName: "Any command (coding.sh run --)",
  tier: "C",
  // 2 (0.1.2): secret-named argv flags redacted.
  parseVersion: 2,
  async detect(): Promise<DetectResult> {
    return { installed: true, hooked: false, notes: ["Built in: capture any agent with `coding.sh run -- <cmd>`. Nothing to install."] };
  },
  async install(): Promise<FileChange[]> {
    return [];
  },
  async uninstall(): Promise<FileChange[]> {
    return [];
  },
  normalize(line, ctx) {
    return normalizeWrapperLine(line, ctx);
  },
  /**
   * Headless run of an arbitrary command: spec.flags is the command line
   * (["my-agent", "--yes"] or one string "my-agent --yes"); the instruction is
   * appended as the last argument. "{instruction}" in a flag is substituted instead.
   */
  async run(spec: RunSpec): Promise<AgentRunOutput> {
    const argv = spec.flags.length === 1 ? splitCommand(spec.flags[0]!) : [...spec.flags];
    const bin = argv.shift();
    if (!bin) return { exitCode: 127, timedOut: false, durationMs: 0, stdoutTail: "", stderrTail: "wrapper: no command given (put it in the bundle's flags)" };
    let substituted = false;
    const args = argv.map((a) => (a.includes("{instruction}") ? ((substituted = true), a.replaceAll("{instruction}", spec.instruction)) : a));
    if (!substituted) args.push(spec.instruction);
    const r = await spawnAgent({ bin, args, cwd: spec.cwd, stdoutFile: spec.stdoutFile, env: runEnv(spec), timeoutMs: spec.timeoutMs });
    return toRunOutput(r, undefined, undefined);
  },
};
