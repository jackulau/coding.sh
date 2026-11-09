// perf.collectorSpans / perf.collectorP95 / perf.collectorRss: the OTLP
// collector under load. N clients post 61-span OTLP/JSON requests to
// `coding.sh collector`, one at a time each: an invoke_agent span with 30
// model calls and 30 tool calls under it (GenAI semantic conventions). Reports
// spans/s over the whole run, request latency percentiles and the collector's
// peak RSS. Runs in a temp HOME / CODING_SH_HOME.
//
// --sessions request (default): each request is a trace of its own, so a
// session of its own (an agent turn per request, as the telemetry audit
// measured). --sessions client: each client streams one long session (one
// gen_ai.conversation.id), which grows by 61 spans a request.
//
//   node scripts/dogfood/bench.mjs collector [--clients 8] [--seconds 15] [--sessions request|client] [--dist <dir>]
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { DIST, isolatedEnv, nearestRank, round, sh, tempDir } from "./lib/util.mjs";

const SPANS_PER_REQUEST = 61;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const hex = (n, width) => n.toString(16).padStart(width, "0").slice(-width);
const s = (key, v) => ({ key, value: { stringValue: v } });
const i = (key, v) => ({ key, value: { intValue: String(v) } });

/** One 61-span request: turn `seq` of client `client`'s session. */
export function collectorRequest(client, seq, t0Ms, sessions = "request") {
  const traceId = hex(client + 1, 8) + hex(seq + 1, 8) + "0".repeat(16);
  const conv = sessions === "client" ? `bench-conv-${client}` : `bench-conv-${client}-${seq}`;
  const base = BigInt(Math.round(t0Ms)) * 1_000_000n;
  const ns = (ms) => String(base + BigInt(ms) * 1_000_000n);
  const rootId = hex(client + 1, 4) + hex(seq + 1, 6) + "000001".slice(-6);
  const spans = [
    {
      traceId, spanId: rootId, name: "invoke_agent bench", kind: 1, startTimeUnixNano: ns(0), endTimeUnixNano: ns(6100),
      attributes: [s("gen_ai.operation.name", "invoke_agent"), s("gen_ai.agent.name", "bench"), s("gen_ai.conversation.id", conv)],
      status: {},
    },
  ];
  let n = 2;
  for (let k = 0; k < 30; k++) {
    const at = 1 + k * 200;
    const user = `step ${k} of turn ${seq}: read the file, then run the tests and report what failed. `.repeat(4);
    spans.push({
      traceId, spanId: hex(client + 1, 4) + hex(seq + 1, 6) + hex(n++, 6), parentSpanId: rootId, name: "chat claude-sonnet-4-5", kind: 3,
      startTimeUnixNano: ns(at), endTimeUnixNano: ns(at + 120),
      attributes: [
        s("gen_ai.operation.name", "chat"), s("gen_ai.provider.name", "anthropic"), s("gen_ai.request.model", "claude-sonnet-4-5"),
        s("gen_ai.response.model", "claude-sonnet-4-5"), s("gen_ai.conversation.id", conv),
        i("gen_ai.usage.input_tokens", 1200 + k), i("gen_ai.usage.output_tokens", 80), i("gen_ai.usage.cache_read.input_tokens", 1000),
        s("gen_ai.input.messages", JSON.stringify([{ role: "user", parts: [{ type: "text", content: user }] }])),
        s("gen_ai.output.messages", JSON.stringify([{ role: "assistant", parts: [{ type: "tool_call", id: `call_${seq}_${k}`, name: "read_file", arguments: { path: `src/file-${k}.ts` } }], finish_reason: "tool_call" }])),
      ],
      status: {},
    });
    spans.push({
      traceId, spanId: hex(client + 1, 4) + hex(seq + 1, 6) + hex(n++, 6), parentSpanId: rootId, name: "execute_tool read_file", kind: 1,
      startTimeUnixNano: ns(at + 130), endTimeUnixNano: ns(at + 190),
      attributes: [
        s("gen_ai.operation.name", "execute_tool"), s("gen_ai.tool.name", "read_file"), s("gen_ai.tool.call.id", `call_${seq}_${k}`),
        s("gen_ai.conversation.id", conv), s("gen_ai.tool.call.arguments", JSON.stringify({ path: `src/file-${k}.ts` })),
        s("gen_ai.tool.call.result", `export function f${k}() {\n  return ${k};\n}\n`.repeat(6)),
      ],
      status: {},
    });
  }
  return JSON.stringify({
    resourceSpans: [{ resource: { attributes: [s("service.name", "bench-agent")] }, scopeSpans: [{ scope: { name: "bench" }, spans }] }],
  });
}

// OTLP exporters keep their connection open between requests.
const keepAlive = new http.Agent({ keepAlive: true });

function post(port, body) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/traces", method: "POST", agent: keepAlive, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on("end", () => (res.statusCode === 200 ? resolve(performance.now() - t0) : reject(new Error(`collector answered ${res.statusCode}`))));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (m) return Number(m[1]) / 1024;
  } catch {}
  const r = sh("ps", ["-o", "rss=", "-p", String(pid)]);
  const kb = Number(String(r.stdout).trim());
  return Number.isFinite(kb) && kb > 0 ? kb / 1024 : undefined;
}

/** The collector's CPU time so far in ms (Linux /proc; undefined elsewhere). */
function cpuMs(pid) {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return ((Number(f[11]) + Number(f[12])) * 1000) / 100;
  } catch {
    return undefined;
  }
}

export async function benchCollector({ dist = DIST, clients = 8, seconds = 15, warmupSeconds = 2, sessions = "request" } = {}) {
  const root = tempDir("cs-bench-collector-");
  const env = isolatedEnv(root);
  const port = await freePort();
  const proc = spawn(process.execPath, [join(dist, "cli.mjs"), "collector", "--port", String(port)], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
  try {
    const deadline = Date.now() + 30_000;
    while (!err.includes("Ready on")) {
      if (proc.exitCode !== null) throw new Error(`collector exited ${proc.exitCode}: ${err.slice(0, 300)}`);
      if (Date.now() > deadline) throw new Error(`collector did not start: ${err.slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const seqs = Array(clients).fill(0);
    const t0Ms = Date.now();
    const loop = async (c, untilMs, lat) => {
      while (performance.now() < untilMs) lat.push(await post(port, collectorRequest(c, seqs[c]++, t0Ms + seqs[c] * 10_000, sessions)));
    };
    const warm = [];
    const warmEnd = performance.now() + warmupSeconds * 1000;
    await Promise.all(Array.from({ length: clients }, (_, c) => loop(c, warmEnd, warm)));
    const lat = [];
    let peak = rssMb(proc.pid) ?? 0;
    const sampler = setInterval(() => (peak = Math.max(peak, rssMb(proc.pid) ?? 0)), 200);
    const cpu0 = cpuMs(proc.pid);
    const start = performance.now();
    await Promise.all(Array.from({ length: clients }, (_, c) => loop(c, start + seconds * 1000, lat)));
    const elapsed = (performance.now() - start) / 1000;
    const cpu1 = cpuMs(proc.pid);
    clearInterval(sampler);
    peak = Math.max(peak, rssMb(proc.pid) ?? 0);
    lat.sort((a, b) => a - b);
    return {
      "perf.collectorSpans": Math.round((lat.length * SPANS_PER_REQUEST) / elapsed),
      "perf.collectorP95": round(nearestRank(lat, 95), 1),
      "perf.collectorRss": round(peak, 0),
      detail: { clients, sessions, seconds: round(elapsed, 1), requests: lat.length, spansPerRequest: SPANS_PER_REQUEST, p50Ms: round(nearestRank(lat, 50), 1), p99Ms: round(nearestRank(lat, 99), 1), maxMs: round(lat.at(-1), 1), warmupRequests: warm.length, ...(cpu0 !== undefined && cpu1 !== undefined ? { cpuMsPer1kSpans: round(((cpu1 - cpu0) * 1000) / (lat.length * SPANS_PER_REQUEST), 1) } : {}) },
    };
  } finally {
    proc.kill("SIGINT");
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r)));
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
