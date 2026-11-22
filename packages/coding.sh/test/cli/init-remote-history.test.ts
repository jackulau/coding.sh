// `coding.sh init --remote` sends the sessions that start after it and none from before: not from
// the history import init runs, and not from a later `coding.sh ingest` that reads what the hook
// spooled earlier. A sink with a new name and no `since` still sends the history, for those who want
// it. Real fixture transcripts and hook lines, a stub `coding.sh serve`.
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { run as ingest } from "../../src/cli/commands/ingest.ts";
import { run as init } from "../../src/cli/commands/init.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { loadConfig } from "../../src/core/config.ts";
import type { SpoolLine } from "../../src/core/types.ts";
import { utcDay } from "../../src/spool/write.ts";
import { FIXTURES, loadSpool, tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

const KEY = ["csh_ik_", "h".repeat(43)].join("");
/** What the stub server was sent: the events and session rows of every batch (the key check's empty batch has none). */
const got: { events: { sessionId: string }[]; sessions: { id: string }[] } = { events: [], sessions: [] };
let server: Server;
let url = "";
before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const ok = req.url === "/v1/ingest" && req.method === "POST" && req.headers.authorization === `Bearer ${KEY}`;
      if (ok) {
        const b = JSON.parse(body) as { events?: { sessionId: string }[]; sessions?: { id: string }[] };
        got.events.push(...(b.events ?? []));
        got.sessions.push(...(b.sessions ?? []));
      }
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(ok ? '{"accepted":0,"inserted":0,"rejected":[]}' : '{"error":"no"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

let t: TmpEnv;
const SET = ["CODING_SH_HOOK_SOURCE", "CODING_SH_NO_AUTO_INGEST", "NO_UPDATE_NOTIFIER"];
/** Appends hook lines to the spool, each in its UTC day's file, as the hook writes them. */
function spool(lines: SpoolLine[]): void {
  for (const l of lines) {
    const file = join(t.dataHome, "spool", l.agent, `${utcDay(l.ts)}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(l)}\n`);
  }
}
beforeEach(() => {
  t = tmpEnv();
  process.env.PATH = join(t.root, "nobin"); // no agent binaries: agents are named with --agent
  process.env.NO_UPDATE_NOTIFIER = "1";
  process.env.CODING_SH_NO_AUTO_INGEST = "1"; // never start a detached ingest from a test
  process.env.CLAUDE_CONFIG_DIR = join(t.home, ".claude");
  process.env.CODEX_HOME = join(t.home, ".codex");
  const hook = join(t.root, "dist", "hook.mjs");
  writeFile(hook, "// hook\n");
  process.env.CODING_SH_HOOK_SOURCE = hook;
  // Sessions already on this machine: the transcripts each agent keeps, and what the hook spooled.
  cpSync(join(FIXTURES, "claude-code", "config", "projects"), join(process.env.CLAUDE_CONFIG_DIR, "projects"), { recursive: true });
  cpSync(join(FIXTURES, "codex", "home", "sessions"), join(process.env.CODEX_HOME, "sessions"), { recursive: true });
  spool(loadSpool("claude-code/hooks.spool.jsonl"));
  got.events.length = 0;
  got.sessions.length = 0;
});
afterEach(() => {
  for (const k of SET) delete process.env[k];
  t.restore();
});

async function cli<T>(command: typeof init, flags: CommandContext["flags"]): Promise<T> {
  const cap = { stdout: "", stderr: "" };
  const env = { ...process.env, NO_COLOR: "1", CI: "" };
  const out = new Output({ json: true, env, stdout: { write: (s: string) => ((cap.stdout += s), true), isTTY: false }, stderr: { write: (s: string) => ((cap.stderr += s), true), isTTY: false }, stdin: { isTTY: false } });
  const code = await command({ flags, positionals: [], rest: [], out, env, cwd: t.home, debug: false, signal: new AbortController().signal });
  assert.equal(code, 0, cap.stderr);
  return JSON.parse(cap.stdout) as T;
}

interface IngestJson {
  spool: { events: number; sinks: { name: string; sent: number; ok: boolean }[] };
}
const sentSessions = () => [...new Set([...got.events.map((e) => e.sessionId), ...got.sessions.map((s) => s.id)])].sort();

test("init --remote sends the sessions that start after it, and none from before", async () => {
  const started = Date.now();
  const done = await cli<{ import: { sessions: number } }>(init, { remote: url, key: KEY, agent: ["claude-code", "codex"], yes: true, mcp: false });
  assert.ok(done.import.sessions > 0, "the history was imported into the local store");
  assert.deepEqual(sentSessions(), [], "the import inside init sent past sessions");

  // A later ingest reads what the hook spooled before init --remote: still nothing goes out.
  const later = await cli<IngestJson>(ingest, {});
  assert.ok(later.spool.events > 0, "the spooled session was stored locally");
  assert.deepEqual(sentSessions(), [], "a later ingest sent past sessions");
  assert.deepEqual(later.spool.sinks, [{ name: "team", sent: 0, ok: true }]);

  // A session that starts now is sent.
  const fresh = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const now = Date.now();
  const lines = loadSpool("claude-code/hooks.spool.jsonl").slice(0, 2);
  spool(lines.map((l, i) => ({ ...l, ts: now + i, raw: { ...(l.raw as Record<string, unknown>), session_id: fresh, transcript_path: join(t.root, "none.jsonl") } })));
  const next = await cli<IngestJson>(ingest, {});
  assert.deepEqual(sentSessions(), [fresh]);
  assert.ok(got.events.length > 0 && got.sessions.length > 0);
  assert.deepEqual(next.spool.sinks, [{ name: "team", sent: got.events.length, ok: true }]);

  // The start time is on the sink, so it holds for every later run; running init again keeps it.
  const config = join(t.dataHome, "config.toml");
  const since = loadConfig({ env: process.env, file: config }).sinks[0]?.since;
  assert.ok(since !== undefined && since >= started - 1000 && since <= now, `since ${since}`);
  const text = readFileSync(config, "utf8");
  await cli(init, { remote: url, key: KEY, agent: ["claude-code", "codex"], yes: true, mcp: false, import: false });
  assert.equal(readFileSync(config, "utf8"), text);

  // Sending the history on purpose: a sink with a new name and no since, then ingest --backfill.
  const before = sentSessions();
  writeFileSync(config, text.replace(/^name = "team"/m, 'name = "team-history"').replace(/^since = .*\r?\n/m, ""));
  assert.equal(loadConfig({ env: process.env, file: config }).sinks[0]?.since, undefined);
  await cli(ingest, { backfill: true });
  const all = sentSessions();
  assert.equal(all.length, before.length + done.import.sessions, `every past session is sent now: ${all.join(" ")}`);
});
