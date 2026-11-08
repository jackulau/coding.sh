// coding.sh hook entry — THE hot path. Bundled to dist/hook.mjs and copied to
// ~/.coding.sh/bin/hook.mjs. Agents invoke it as:
//
//   node ~/.coding.sh/bin/hook.mjs <agent> <event> [--echo-continue | --reply '<json>']   < hook JSON on stdin
//
// Contract with the agent:
// - Exits 0, always. A capture bug must never block or fail the agent.
//   Failures go to ~/.coding.sh/spool/errors.log.
// - Prints NOTHING to stdout by default: several agents interpret hook stdout
//   (as JSON decisions, or as text injected into the model's context).
// - `--echo-continue` (or CODING_SH_ECHO_CONTINUE=1) prints exactly
//   `{"continue":true}` + "\n" for agents whose hook protocol requires a JSON
//   reply to proceed (e.g. some Cursor hook events). It is printed even when
//   capture is disabled or failed, so the agent always proceeds.
// - `--reply '<json>'` (or `--reply=<json>`) is the generic form: prints that
//   JSON document (compacted) + "\n", always, like --echo-continue. Adapters use
//   it for events whose protocol needs an answer. It must never be used to
//   answer a permission question with "allow": that would pre-empt the user's
//   own approval. Invalid JSON prints nothing (logged), which agents treat as
//   "no opinion" on non-permission events.
// - CODING_SH_DISABLE=1: drain stdin and exit without writing anything.
// - CODING_SH_HOME overrides the data dir; CODING_SH_RUN_ID is recorded as runId.
// - A host app's env marker (T3 Code, see ./host.ts) is recorded as host.
//
// Work done: read stdin (synchronously, capped at 64 MB; a TTY counts as empty),
// JSON.parse it when possible, and append one SpoolLine via appendSpool(). No
// network and no git work: the hook neither runs git nor reads .git. The repo
// and the HEAD a session started from are worked out at ingest, from the
// reflog (../core/repo-state.ts). The one child process: on end-of-turn/session
// events the hook starts a detached, lock-guarded `coding.sh ingest
// --background` and does not wait for it (./kick.ts).
//
// Imports: node:fs, node:path, node:os only (via ./write.ts, ./kick.ts and
// ../core/paths.ts, plus the pure ../integrations/gateway/ids.ts);
// node:child_process is loaded only when an ingest starts.
import { fstatSync, readSync, writeSync } from "node:fs";
import type { SpoolLine } from "../core/types.ts";
import { gatewayFromEnv } from "../integrations/gateway/ids.ts";
import { hostOf } from "./host.ts";
import { kickIngest, kickProxy } from "./kick.ts";
import { MAX_INLINE_LINE_BYTES, appendSpool, isDisabled, logSpoolError } from "./write.ts";

const MAX_STDIN_BYTES = 64 * 1024 * 1024;
/** Give up if stdin keeps returning EAGAIN (non-blocking pipe) with no data for this long. */
const EAGAIN_IDLE_MS = 10_000;

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function readStdin(): { text: string; truncated: boolean } {
  let isChar = false;
  try {
    isChar = fstatSync(0).isCharacterDevice();
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
      n = readSync(0, buf, 0, buf.length, null);
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

function main(): void {
  const env = process.env;
  const argv = process.argv.slice(2);
  const echo = argv.includes("--echo-continue") || env.CODING_SH_ECHO_CONTINUE === "1";
  let reply: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--reply") reply = argv[++i] ?? "";
    else if (a.startsWith("--reply=")) reply = a.slice("--reply=".length);
    else if (!a.startsWith("--")) pos.push(a);
  }
  const agent = pos[0] || "unknown";
  const event = pos[1] || "unknown";
  let captured = false;
  try {
    const { text, truncated } = readStdin();
    if (!isDisabled(env)) {
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
        pid: process.pid,
        ppid: process.ppid,
        cwd: typeof payloadCwd === "string" && payloadCwd ? payloadCwd : process.cwd(),
        raw: inlineable ? raw : undefined,
      };
      if (env.CODING_SH_RUN_ID) line.runId = env.CODING_SH_RUN_ID;
      const host = hostOf(env);
      if (host) line.host = host;
      // Hooks inherit the agent's env (Claude Code settings env included).
      const gateway = gatewayFromEnv(env);
      if (gateway) line.gateway = gateway;
      // Claude Code says how it was launched: `sdk-cli` for `claude -p`, `cli` in a terminal.
      if (agent === "claude-code" && env.CLAUDE_CODE_ENTRYPOINT) line.entrypoint = env.CLAUDE_CODE_ENTRYPOINT.slice(0, 64);
      appendSpool(line, env, { rawText: text });
      if (truncated) logSpoolError(new Error(`stdin truncated at ${MAX_STDIN_BYTES} bytes`), { agent, event }, env);
      captured = true;
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
      writeSync(1, out);
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
  process.exitCode = 0;
}

process.on("uncaughtException", (e) => {
  logSpoolError(e, { where: "uncaughtException" });
  process.exit(0);
});
main();
