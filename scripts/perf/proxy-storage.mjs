#!/usr/bin/env node
// What the proxy stores per session, and how long a call takes to read back:
// request bodies as whole documents (format 1) against message blocks (format 2,
// packages/coding.sh/src/proxy/blocks.ts). Both go through the real recorder
// into a real FsBlobStore (zstd), then every call is read back with loadCall
// and checked byte for byte against the other format.
//
//   node scripts/perf/proxy-storage.mjs --synthetic [--hours 2] [--calls 600] [--keep]
//   node scripts/perf/proxy-storage.mjs --store <CODING_SH_HOME of a capture> [--session <id>]
//   node scripts/perf/proxy-storage.mjs ... [--json]
//
// --synthetic builds Claude Code requests from the seeded long-session fixture
// (test/fixtures/longrun): every assistant turn is one model call that re-sends
// the conversation so far, reset at each compaction. --store re-records the
// proxied calls of a real capture (read with loadCall, either format), in order.
// Bytes are the compressed blob files; "on disk" rounds each file up to 4 KiB.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../../packages/coding.sh/src/core/config.ts";
import { pricesFor } from "../../packages/coding.sh/src/core/pricing.ts";
import { createRedactor } from "../../packages/coding.sh/src/core/redact.ts";
import { loadCall } from "../../packages/coding.sh/src/proxy/calls.ts";
import { createRecorder, storeWriter } from "../../packages/coding.sh/src/proxy/record.ts";
import { FsBlobStore } from "../../packages/coding.sh/src/store/fs-blobs.ts";
import { MemoryIndexStore } from "../../packages/coding.sh/src/store/memory.ts";
import { openStores } from "../../packages/coding.sh/src/store/factory.ts";
import { generateLongSession as generate } from "../../packages/coding.sh/test/fixtures/longrun/generate.ts";

const args = process.argv.slice(2);
const flag = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = args.includes("--json");
const tmp = mkdtempSync(join(tmpdir(), "csh-proxy-storage-"));
const SESSION = "5e55a0de-0000-4000-8000-0000000000aa";

/** Claude Code–shaped requests from the longrun fixture's transcript. */
function synthetic(hours, maxCalls) {
  const out = join(tmp, "longrun");
  generate({ out, hours, scale: 1, seed: 7 });
  const dir = join(out, "claude", "projects", "-work-longrun");
  const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
  const lines = readFileSync(join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const system = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: "text", text: `Working directory: /work/longrun\n${"Follow the repository conventions. ".repeat(200)}` }];
  const tools = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Task", "TodoWrite"].map((name) => ({ name, description: `${name} tool. ${"Details of how to call it. ".repeat(40)}`, input_schema: { type: "object", properties: { x: { type: "string" } } } }));
  const calls = [];
  let msgs = [];
  for (const l of lines) {
    if (l.type === "system" && l.subtype === "compact_boundary") {
      msgs = [];
      continue;
    }
    if (l.type !== "user" && l.type !== "assistant") continue;
    const m = l.message;
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (l.type === "assistant") {
      // The call that produced this turn sent everything before it.
      calls.push({ body: { model: m.model ?? "claude-opus-4-5", max_tokens: 32000, system, tools, messages: msgs.map((x, i) => (i === msgs.length - 1 ? { ...x, content: x.content.map((c, j) => (j === x.content.length - 1 ? { ...c, cache_control: { type: "ephemeral" } } : c)) } : x)), stream: true }, reply: { id: m.id, content: m.content, model: m.model, usage: m.usage } });
      if (calls.length >= maxCalls) break;
    }
    const prev = msgs.at(-1);
    if (prev && prev.role === m.role) msgs[msgs.length - 1] = { role: m.role, content: [...prev.content, ...content] };
    else msgs.push({ role: m.role, content });
  }
  return calls;
}

/** The proxied calls of a captured store, as recorded (any format). */
async function fromStore(home, session) {
  const env = { ...process.env, CODING_SH_HOME: resolve(home) };
  const config = defaultConfig(env);
  const { index, blobs } = await openStores(config, env);
  try {
    const ids = session ? [session] : (await index.listSessions({ limit: 1000 })).map((s) => s.id);
    const calls = [];
    for (const id of ids) {
      for (const e of await index.listEvents(id, { kinds: ["llm.call"] })) {
        if (e.source !== "proxy") continue;
        const l = await loadCall(blobs, e);
        if (l.request) calls.push({ body: l.request.body, path: l.request.path, api: l.request.api, provider: l.request.provider, sessionId: e.sessionId, reply: l.response?.body });
      }
    }
    return calls;
  } finally {
    await index.close();
  }
}

function filesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile() && !e.name.startsWith(".")) out.push(statSync(p).size);
  }
  return out;
}

async function recordAll(calls, blocks) {
  const root = join(tmp, blocks ? "blocks" : "whole");
  const blobs = new FsBlobStore(join(root, "blobs"));
  const index = new MemoryIndexStore();
  const cfg = defaultConfig({});
  const rec = createRecorder({ blobs, redactor: createRedactor({ redact: cfg.capture.redact, patterns: [], env: {} }), metadata: false, prices: pricesFor({}), write: storeWriter(index), blocks });
  const t0 = performance.now();
  let n = 0;
  for (const c of calls) {
    const buf = Buffer.from(JSON.stringify(c.body));
    rec.record({
      route: { provider: c.provider ?? "anthropic", api: c.api ?? "messages" },
      method: "POST",
      path: c.path ?? "/v1/messages",
      upstream: "https://api.anthropic.com",
      reqHeaders: { "user-agent": "claude-cli/2.1.319 (external, cli)", "x-coding-sh-session": c.sessionId ?? SESSION },
      reqBody: buf,
      reqBytes: buf.length,
      status: 200,
      resHeaders: { "content-type": "application/json" },
      result: { id: `msg_${n}`, body: c.reply ?? {} },
      resBytes: 0,
      stream: false,
      startedAt: 1_700_000_000_000 + n * 1000,
      endedAt: 1_700_000_000_500 + n++ * 1000,
    });
    await rec.flush();
  }
  const writeMs = performance.now() - t0;
  const sizes = filesUnder(join(root, "blobs"));
  const events = [];
  for (const s of await index.listSessions({ limit: 10_000 })) events.push(...(await index.listEvents(s.id, { kinds: ["llm.call"] })));
  events.sort((a, b) => a.ts - b.ts);
  const times = [];
  const bodies = [];
  for (const e of events) {
    const t = performance.now();
    const l = await loadCall(blobs, e);
    times.push(performance.now() - t);
    bodies.push(JSON.stringify(l.request?.body));
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  return {
    calls: events.length,
    blobFiles: sizes.length,
    bytes: sizes.reduce((s, x) => s + x, 0),
    onDisk: sizes.reduce((s, x) => s + Math.ceil(x / 4096) * 4096, 0),
    writeMsPerCall: writeMs / Math.max(1, events.length),
    readMs: { mean: times.reduce((s, x) => s + x, 0) / Math.max(1, times.length), p50: q(0.5), p95: q(0.95), max: times.at(-1) },
    bodies,
  };
}

try {
  const store = flag("--store");
  const calls = store ? await fromStore(store, flag("--session")) : synthetic(Number(flag("--hours") ?? 2), Number(flag("--calls") ?? 600));
  if (!calls.length) throw new Error("no proxied calls with a stored request");
  const whole = await recordAll(calls, false);
  const blocks = await recordAll(calls, true);
  const same = whole.bodies.length === blocks.bodies.length && whole.bodies.every((b, i) => b === blocks.bodies[i] && b !== undefined);
  const strip = ({ bodies, ...r }) => r;
  const largest = Math.max(...calls.map((c) => Buffer.byteLength(JSON.stringify(c.body))));
  const report = { source: store ? `store ${store}` : `synthetic ${calls.length} calls`, calls: calls.length, largestRequestBytes: largest, identical: same, whole: strip(whole), blocks: strip(blocks), ratio: { bytes: whole.bytes / blocks.bytes, onDisk: whole.onDisk / blocks.onDisk } };
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    const kb = (n) => `${(n / 1024).toFixed(0)} KiB`;
    const ms = (n) => `${n.toFixed(2)} ms`;
    console.log(`${report.source}: ${calls.length} calls, largest request ${kb(largest)}, read back identical: ${same}`);
    for (const [name, r] of [["whole bodies (format 1)", whole], ["message blocks (format 2)", blocks]]) {
      console.log(`  ${name.padEnd(26)} ${kb(r.bytes).padStart(10)} in ${String(r.blobFiles).padStart(5)} files, ${kb(r.onDisk).padStart(10)} on disk; write ${ms(r.writeMsPerCall)}/call; read p50 ${ms(r.readMs.p50)} p95 ${ms(r.readMs.p95)} max ${ms(r.readMs.max)}`);
    }
    console.log(`  ${(report.ratio.bytes).toFixed(1)}× fewer bytes, ${(report.ratio.onDisk).toFixed(1)}× less on disk`);
  }
  process.exitCode = same ? 0 : 1;
} finally {
  if (!args.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
}
