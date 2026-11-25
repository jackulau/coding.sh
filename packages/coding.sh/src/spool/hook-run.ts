// The hook's work, as a function: ./hook.ts runs it with the process's own stdin, stdout, argv and
// env, and test/verify/hook-entry.test.ts runs it in-process on chosen stdin bytes. The contract
// is in ./hook.ts.
import type { SpoolLine } from "../core/types.ts";
import { gatewayFromEnv } from "../integrations/gateway/ids.ts";
import { devinHookAgent } from "./devin.ts";
import { needsRedaction } from "./gate.ts";
import { hostOf } from "./host.ts";
import { kickIngest, kickProxy } from "./kick.ts";
import { spawnedByFromEnv } from "./spawned.ts";
import { MAX_INLINE_LINE_BYTES, appendSpool, isDisabled, logSpoolError, payloadSessionId, recordDisabledSession, type RedactLine } from "./write.ts";

const fs = process.getBuiltinModule("node:fs");

export const MAX_STDIN_BYTES = 64 * 1024 * 1024;
/** A paused call's payload up to this size is parsed for its session id; a larger one is searched. */
const MAX_PARSE_BYTES = 1024 * 1024;
/** Give up if stdin keeps returning EAGAIN (non-blocking pipe) with no data for this long. */
const EAGAIN_IDLE_MS = 10_000;

/** What the hook reads and writes outside the data dir. */
export interface HookIO {
  env: NodeJS.ProcessEnv;
  /** Reads stdin into buf as readSync(0, buf) does: the bytes read, 0 at the end. */
  read(buf: Buffer): number;
  /** True when stdin is a TTY or /dev/null, so nothing is piped. Throws when stdin is closed. */
  isCharDevice(): boolean;
  /** Writes to stdout. */
  write(text: string): void;
  pid: number;
  ppid: number;
  cwd(): string;
}

/** The process's own stdin, stdout and env. */
export function processIO(): HookIO {
  return {
    env: process.env,
    read: (buf) => fs.readSync(0, buf, 0, buf.length, null),
    isCharDevice: () => fs.fstatSync(0).isCharacterDevice(),
    write: (text) => void fs.writeSync(1, text),
    pid: process.pid,
    ppid: process.ppid,
    cwd: () => process.cwd(),
  };
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function readStdin(io: HookIO): { text: string; truncated: boolean } {
  let isChar = false;
  try {
    isChar = io.isCharDevice();
  } catch {
    return { text: "", truncated: false }; // fd 0 closed
  }
  // TTY (or /dev/null): nobody is piping a payload; never block waiting for a human.
  if (isChar) return { text: "", truncated: false };

  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  const buf = Buffer.allocUnsafe(1 << 16);
  let idleSince = 0;
  for (;;) {
    let n: number;
    try {
      n = io.read(buf);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        const now = Date.now();
        if (!idleSince) idleSince = now;
        else if (now - idleSince > EAGAIN_IDLE_MS) break;
        Atomics.wait(sleeper, 0, 0, 2);
        continue;
      }
      if (code === "EOF") break; // Windows pipes
      throw e;
    }
    if (n === 0) break;
    idleSince = 0;
    if (truncated) continue; // keep draining so the writer never sees EPIPE
    const room = MAX_STDIN_BYTES - total;
    chunks.push(Buffer.from(buf.subarray(0, Math.min(n, room))));
    total += Math.min(n, room);
    if (n >= room) truncated = true;
  }
  let text = Buffer.concat(chunks, total).toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, truncated };
}

/** Best-effort top-level-ish "cwd" from a payload too large to parse. */
function sniffCwd(text: string): string | undefined {
  const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text.slice(0, 65536));
  if (!m || !m[1]) return undefined;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return undefined;
  }
}

/** The line as it is: what the redaction rules would return for a payload ./gate.ts passes. */
const asIs: RedactLine = (line, rawText) => ({ line, rawText });

/**
 * How to redact this payload: as it is when ./gate.ts finds nothing the rules would
 * replace, else with the rules of the user's config, imported now (hook-redact.mjs
 * beside the bundled hook, ./redact.ts from source). A failed import throws, and the
 * hook logs it and writes no line.
 */
async function lineRedactor(text: string, env: NodeJS.ProcessEnv): Promise<RedactLine> {
  if (!needsRedaction(text, env)) return asIs;
  const engine = new URL(import.meta.url.endsWith(".ts") ? "./redact.ts" : "./hook-redact.mjs", import.meta.url);
  const { spoolLineRedactor } = (await import(engine.href)) as typeof import("./redact.ts");
  return spoolLineRedactor(env);
}

/** One hook call: reads the payload, appends its spool line, prints the reply the flags ask for. */
export async function runHook(argv: string[], io: HookIO): Promise<void> {
  const env = io.env;
  const echo = argv.includes("--echo-continue") || env.CODING_SH_ECHO_CONTINUE === "1";
  let reply: string | undefined;
  let pid = io.pid;
  let ppid = io.ppid;
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--reply") reply = argv[++i] ?? "";
    else if (a.startsWith("--reply=")) reply = a.slice("--reply=".length);
    else if (a.startsWith("--sh-pids=")) {
      const m = /^([1-9]\d{0,9}),([1-9]\d{0,9})$/.exec(a.slice("--sh-pids=".length));
      if (m) [pid, ppid] = [Number(m[1]), Number(m[2])];
    } else if (!a.startsWith("--")) pos.push(a);
  }
  const agent = pos[0] || "unknown";
  const event = pos[1] || "unknown";
  let captured = false;
  try {
    const { text, truncated } = readStdin(io);
    if (isDisabled(env)) {
      // Paused: no line. The session id is kept so ingest and backfill leave the session out.
      let raw: unknown;
      if (!truncated && Buffer.byteLength(text) <= MAX_PARSE_BYTES) {
        try {
          raw = JSON.parse(text);
        } catch {
          // not JSON: no session id to keep
        }
      }
      const sid = payloadSessionId(raw, raw === undefined ? text : "");
      if (sid) recordDisabledSession(sid, env);
    } else {
      // Payloads that can't fit inline anyway are not parsed: they go to a side
      // file verbatim and ingest parses them later.
      const inlineable = !truncated && Buffer.byteLength(text) <= MAX_INLINE_LINE_BYTES;
      let raw: unknown = text;
      if (inlineable && text) {
        try {
          raw = JSON.parse(text);
        } catch {
          raw = text;
        }
      }
      const payloadCwd = raw && typeof raw === "object" ? (raw as { cwd?: unknown }).cwd : inlineable ? undefined : sniffCwd(text);
      const line: SpoolLine = {
        v: 0,
        agent,
        event,
        ts: Date.now(),
        pid,
        ppid,
        cwd: typeof payloadCwd === "string" && payloadCwd ? payloadCwd : io.cwd(),
        raw: inlineable ? raw : undefined,
      };
      // Devin runs Claude Code's hooks too: the call is Devin's, or a copy of a line Devin's own hook writes.
      const devin = agent === "claude-code" && env.DEVIN_PROJECT_DIR ? devinHookAgent(event, raw, text, env, line.cwd) : undefined;
      if (devin === "devin") line.agent = "devin";
      if (devin !== "drop") {
        if (env.CODING_SH_RUN_ID) line.runId = env.CODING_SH_RUN_ID;
        const host = hostOf(env);
        if (host) line.host = host;
        // Hooks inherit the agent's env (Claude Code settings env included).
        const gateway = gatewayFromEnv(env);
        if (gateway) line.gateway = gateway;
        // Claude Code says how it was launched: `sdk-cli` for `claude -p`, `cli` in a terminal.
        if (line.agent === "claude-code" && env.CLAUDE_CODE_ENTRYPOINT) line.entrypoint = env.CLAUDE_CODE_ENTRYPOINT.slice(0, 64);
        // Started from another agent's shell tool: that agent's session id is in the env (./spawned.ts).
        const spawnedBy = spawnedByFromEnv(env);
        if (spawnedBy) line.spawnedBy = spawnedBy;
        appendSpool(line, env, { rawText: text, redact: await lineRedactor(text, env) });
        if (truncated) logSpoolError(new Error(`stdin truncated at ${MAX_STDIN_BYTES} bytes`), { agent: line.agent, event }, env);
        captured = true;
      }
    }
  } catch (e) {
    logSpoolError(e, { agent, event }, env);
  }
  let out: string | undefined = echo ? '{"continue":true}\n' : undefined;
  if (reply !== undefined) {
    try {
      out = JSON.stringify(JSON.parse(reply)) + "\n";
    } catch (e) {
      logSpoolError(new Error(`--reply is not valid JSON: ${(e as Error).message}`), { agent, event }, env);
    }
  }
  if (out) {
    try {
      io.write(out);
    } catch {
      // stdout closed: nothing to do.
    }
  }
  // After the reply, so the agent is never kept waiting on the spawn.
  if (captured) {
    try {
      kickIngest(event, env);
    } catch (e) {
      logSpoolError(e, { agent, event, where: "kickIngest" }, env);
    }
  }
  // Even with capture off: an agent routed through the proxy needs it running.
  try {
    kickProxy(event, env);
  } catch (e) {
    logSpoolError(e, { agent, event, where: "kickProxy" }, env);
  }
}
