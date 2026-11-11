#!/usr/bin/env node
// Performance budgets (docs/design/dogfood.md §3.5). Every benchmark runs in a temp
// HOME / CODING_SH_HOME, never against the live home.
//
//   node scripts/dogfood/bench.mjs [hook|ingest|store|help|viewer|replay|proxy|proxy-session|collector|harness-audit]... [--baseline <dist dir>] [--calls N] [--json] [--check [--tolerance <percent>]]
//
// `viewer` also runs `replay` (session replay through the viewer API).
// --check exits 1 when a result misses its budget in TARGETS (CI runs it for the proxy).
// --tolerance <percent> widens every budget for --check (CI's hook step uses 20).
//
// With --baseline, the hook, help and proxy-session benchmarks interleave the
// baseline build with the candidate (A B A B ...) and report a bootstrap CI on
// the median difference, so machine noise is paired. So does harness-audit, which
// needs the 3.6 GB store of bench-where.mjs: `--store <index.db>` reuses one
// (`bench-where.mjs gen <index.db> --memory`); without it the store is written to the
// temp dir first, which takes minutes.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { benchCollector } from "./bench-collector.mjs";
import { bootstrapMedianDiff, CLI, DIST, isolatedEnv, log, median, nearestRank, parseArgs, prng, quantile, REPO, round, sh, shAsync, tempDir } from "./lib/util.mjs";

export const TARGETS = {
  "perf.hook": { target: 10, unit: "ms", dir: "max" },
  "perf.hookP95": { target: 25, unit: "ms", dir: "max" },
  "perf.hook1mb": { target: 40, unit: "ms", dir: "max" },
  // The sh fast path agents run outside Windows (dist/hook.sh), over a bare `/bin/true` spawn.
  "perf.hookSh": { target: 3, unit: "ms", dir: "max" },
  "perf.hookShP95": { target: 5, unit: "ms", dir: "max" },
  "perf.ingest": { target: 5000, unit: "events/s", dir: "min" },
  "perf.storeSize": { target: 2.0, unit: "MB/1k events", dir: "max" },
  "perf.viewerTti": { target: 1000, unit: "ms", dir: "max" },
  "perf.help": { target: 200, unit: "ms", dir: "max" },
  // Replay of a 12k-event editing session: the step list, and the last step with its file rebuilt (both cold).
  "perf.replayIndex": { target: 1000, unit: "ms", dir: "max" },
  "perf.replayStep": { target: 300, unit: "ms", dir: "max" },
  "perf.proxyChunk": { target: 2, unit: "ms", dir: "max" },
  "perf.proxyTtfb": { target: 5, unit: "ms", dir: "max" },
  // 8 clients streaming 61-span OTLP/JSON requests to `coding.sh collector` (bench-collector.mjs).
  "perf.collectorSpans": { target: 5000, unit: "spans/s", dir: "min" },
  "perf.collectorP95": { target: 100, unit: "ms", dir: "max" },
  "perf.collectorRss": { target: 200, unit: "MB", dir: "max" },
  // `coding.sh harness audit` over every session of the bench-where.mjs store (3,600 sessions, 1.4M events, 3.6 GB).
  "perf.harnessAudit": { target: 1500, unit: "ms", dir: "max" },
  "perf.harnessAuditRss": { target: 200, unit: "MB", dir: "max" },
};
/**
 * Whether `value` meets its budget. `tolerance` (percent) widens it: CI's shared
 * runner measures the hook a few percent over the design budget with no change
 * in the code (main's own build included), so CI checks for a regression past
 * that margin rather than for the budget to the hundredth of a millisecond.
 */
export function meets(key, value, tolerance = 0) {
  const t = TARGETS[key];
  if (value === null || value === undefined || !t) return undefined;
  const f = tolerance / 100;
  return t.dir === "min" ? value >= t.target * (1 - f) : value <= t.target * (1 + f);
}

function hookPayload(bytes, cwd) {
  const filler = "x".repeat(Math.max(0, bytes - 400));
  return JSON.stringify({ session_id: "bench-0000", transcript_path: "/nonexistent", cwd, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_bench", tool_input: { command: "ls -la" }, tool_response: { stdout: filler, stderr: "", interrupted: false }, duration_ms: 12 });
}

/** A work tree whose branch is only in a 1 MB packed-refs: a SessionStart hook that read .git (0.1.3 did) pays for it here. */
function fakeRepo(dir) {
  const head = "0123456789abcdef0123456789abcdef01234567";
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(join(dir, "src", "deep"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  const refs = ["# pack-refs with: peeled fully-peeled sorted"];
  for (let i = 0; refs.length * 60 < 1 << 20; i++) refs.push(`${head} refs/heads/a-${String(i).padStart(8, "0")}`);
  refs.push(`${head} refs/heads/main`);
  writeFileSync(join(dir, ".git", "packed-refs"), refs.join("\n") + "\n");
  return join(dir, "src", "deep");
}

function timeSpawn(cmd, args, env, input) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { env, input, stdio: ["pipe", "ignore", "pipe"] });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`${args.join(" ")} exited ${r.status}: ${String(r.stderr).slice(0, 300)}`);
  return ms;
}

/**
 * perf.hook: hook spawn overhead over a bare `node -e ""`, median and p95, plus a 1 MB payload.
 * perf.hookSh: the sh fast path (`/bin/sh dist/hook.sh`, what agents run outside Windows) over a
 * bare `/bin/true`, median and p95, with a 600-byte payload (inline) and a 2 KB one (side file).
 */
export function benchHook({ dist = DIST, baseline, n = 50, warmup = 5 } = {}) {
  const root = tempDir("cs-bench-hook-");
  try {
    const env = isolatedEnv(root);
    mkdirSync(env.HOME, { recursive: true });
    const small = hookPayload(2048, root);
    const big = hookPayload(1 << 20, root);
    const hook = (d, payload) => timeSpawn(process.execPath, [join(d, "hook.mjs"), "claude-code", "PostToolUse"], env, payload);
    const bare = () => timeSpawn(process.execPath, ["-e", ""], env, "");
    for (let i = 0; i < warmup; i++) {
      bare();
      hook(dist, small);
      if (baseline) hook(baseline, small);
    }
    const node = [];
    const cand = [];
    const base = [];
    const candBig = [];
    const baseBig = [];
    for (let i = 0; i < n; i++) {
      node.push(bare());
      cand.push(hook(dist, small));
      if (baseline) base.push(hook(baseline, small));
    }
    for (let i = 0; i < Math.max(10, n / 5); i++) {
      candBig.push(hook(dist, big));
      if (baseline) baseBig.push(hook(baseline, big));
    }
    // SessionStart inside a repo: the hook must do no git work there, so this should cost what perf.hook does.
    const startPayload = JSON.stringify({ session_id: "bench-0000", cwd: fakeRepo(join(root, "repo")), hook_event_name: "SessionStart", source: "startup" });
    const start = (d) => timeSpawn(process.execPath, [join(d, "hook.mjs"), "claude-code", "SessionStart"], { ...env, CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_PROXY_AUTOSTART: "1" }, startPayload);
    const candStart = [];
    const baseStart = [];
    for (let i = 0; i < n; i++) {
      candStart.push(start(dist));
      if (baseline) baseStart.push(start(baseline));
    }
    // The sh fast path, interleaved with /bin/true so machine noise hits both alike.
    const shHook = existsSync(join(dist, "hook.sh")) && process.platform !== "win32";
    const tiny = hookPayload(600, root);
    const trueBin = existsSync("/bin/true") ? "/bin/true" : "/usr/bin/true";
    const shRun = (payload) => timeSpawn("/bin/sh", [join(dist, "hook.sh"), "claude-code", "PostToolUse"], env, payload);
    const truth = [];
    const shTiny = [];
    const shSmall = [];
    if (shHook) {
      for (let i = 0; i < warmup; i++) {
        timeSpawn(trueBin, [], env, "");
        shRun(tiny);
      }
      for (let i = 0; i < n * 4; i++) {
        truth.push(timeSpawn(trueBin, [], env, ""));
        shTiny.push(shRun(tiny));
        shSmall.push(shRun(small));
      }
    }
    const nodeMed = median(node);
    const spoolFiles = existsSync(join(env.CODING_SH_HOME, "spool")) ? walkCount(join(env.CODING_SH_HOME, "spool")) : 0;
    const out = {
      "perf.hook": round(median(cand) - nodeMed, 1),
      "perf.hookP95": round(quantile(cand, 0.95) - quantile(node, 0.95), 1),
      "perf.hook1mb": round(median(candBig) - nodeMed, 1),
      "perf.hookStart": round(median(candStart) - nodeMed, 1),
      ...(shHook
        ? {
            "perf.hookSh": round(median(shTiny) - median(truth), 2),
            "perf.hookShP95": round(quantile(shTiny, 0.95) - quantile(truth, 0.95), 2),
            "perf.hookSh2kb": round(median(shSmall) - median(truth), 2),
            "perf.hookSh2kbP95": round(quantile(shSmall, 0.95) - quantile(truth, 0.95), 2),
            shDetail: { n: n * 4, trueMedianMs: round(median(truth), 2), trueP95Ms: round(quantile(truth, 0.95), 2), shMedianMs: round(median(shTiny), 2), shP95Ms: round(quantile(shTiny, 0.95), 2), sh2kbMedianMs: round(median(shSmall), 2), sh2kbP95Ms: round(quantile(shSmall, 0.95), 2) },
          }
        : {}),
      detail: { n, warmup, nodeMedianMs: round(nodeMed, 1), hookMedianMs: round(median(cand), 1), hookP95Ms: round(quantile(cand, 0.95), 1), hook1mbMedianMs: round(median(candBig), 1), hookStartMedianMs: round(median(candStart), 1), spoolFilesWritten: spoolFiles },
    };
    if (baseline) {
      out.baseline = { "perf.hook": round(median(base) - nodeMed, 1), "perf.hook1mb": round(median(baseBig) - nodeMed, 1), "perf.hookStart": round(median(baseStart) - nodeMed, 1) };
      const d = bootstrapMedianDiff(base, cand);
      const ds = bootstrapMedianDiff(baseStart, candStart);
      out.paired = { "perf.hook": { diff: round(d.diff, 2), ci: d.ci.map((x) => round(x, 2)) }, "perf.hookStart": { diff: round(ds.diff, 2), ci: ds.ci.map((x) => round(x, 2)) } };
    }
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function walkCount(dir) {
  let c = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) c += e.isDirectory() ? walkCount(join(dir, e.name)) : 1;
  return c;
}
function apparent(p) {
  if (!existsSync(p)) return { bytes: 0, files: 0 };
  const st = statSync(p);
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };
  const acc = { bytes: 0, files: 0 };
  for (const name of readdirSync(p)) {
    const r = apparent(join(p, name));
    acc.bytes += r.bytes;
    acc.files += r.files;
  }
  return acc;
}
/** Bytes on disk (allocated blocks), which is what the budget counts. */
function duBytes(p) {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.blocks ? st.blocks * 512 : st.size;
  let s = 0;
  for (const name of readdirSync(p)) s += duBytes(join(p, name));
  return s;
}

/** Synthetic claude-code spool corpus: `sessions` sessions of `perSession` events each. */
export function writeCorpus(home, { events = 100_000, perSession = 500, day = Date.now() - 86_400_000 } = {}) {
  const spool = join(home, "spool", "claude-code");
  mkdirSync(spool, { recursive: true });
  const sessions = Math.ceil(events / perSession);
  const cwd = join(home, "..", "repo");
  let written = 0;
  const ids = [];
  for (let s = 0; s < sessions && written < events; s++) {
    const pid = 50_000 + s;
    const sid = `00000000-0000-4000-8000-${String(s).padStart(12, "0")}`;
    ids.push(sid);
    let t = day + s * 60_000;
    const rows = [];
    const line = (event, raw) => {
      rows.push(JSON.stringify({ v: 0, agent: "claude-code", event, ts: t, pid, ppid: pid - 1, cwd, raw: { session_id: sid, hook_event_name: event, cwd, ...raw } }));
      t += 7;
    };
    const budget = Math.min(perSession, events - written);
    line("SessionStart", { source: "startup" });
    line("UserPromptSubmit", { prompt: `synthetic task ${s}: refactor module ${s % 37} and run the tests` });
    let k = 0;
    while (rows.length < budget - 2) {
      const id = `toolu_${s}_${k}`;
      const cmd = k % 3 === 0 ? { command: `npm test -- --grep case${k}` } : { file_path: `${cwd}/src/mod${k % 53}.ts` };
      const name = k % 3 === 0 ? "Bash" : "Read";
      line("PreToolUse", { tool_name: name, tool_use_id: id, tool_input: cmd });
      if (rows.length >= budget - 2) break;
      const stdout = `line ${k} `.repeat(30 + (k % 50));
      if (k % 17 === 5) line("PostToolUseFailure", { tool_name: name, tool_use_id: id, tool_input: cmd, error: `Error: case${k} failed\n${stdout.slice(0, 200)}`, duration_ms: 40 + (k % 900) });
      else line("PostToolUse", { tool_name: name, tool_use_id: id, tool_input: cmd, tool_response: { stdout, stderr: "" }, duration_ms: 20 + (k % 700) });
      k++;
    }
    line("Stop", { last_assistant_message: `done with ${s}` });
    line("SessionEnd", { reason: "exit" });
    writeFileSync(join(spool, `${new Date(day).toISOString().slice(0, 10)}.${pid}.jsonl`), rows.join("\n") + "\n");
    written += rows.length;
  }
  return { events: written, sessions: ids };
}

/** Ingest one fresh synthetic corpus and return the timing plus store sizes. */
function runIngestOnce(cliPath, events, day) {
  const root = tempDir("cs-bench-ingest-");
  try {
    const env = isolatedEnv(root);
    mkdirSync(env.HOME, { recursive: true });
    const corpus = writeCorpus(env.CODING_SH_HOME, { events, day });
    const spoolBytes = duBytes(join(env.CODING_SH_HOME, "spool"));
    const r = sh(process.execPath, [cliPath, "ingest", "--json"], { env });
    if (r.code !== 0) throw new Error(`ingest exited ${r.code}: ${r.stderr.slice(0, 400)}`);
    let ingested;
    try {
      const j = JSON.parse(r.stdout);
      ingested = j.spool?.events ?? j.events;
    } catch {}
    const home = env.CODING_SH_HOME;
    const idx = readdirSync(home).filter((f) => f.startsWith("index.db")).reduce((a, f) => a + duBytes(join(home, f)), 0);
    const blobs = duBytes(join(home, "blobs"));
    const blobsApparent = apparent(join(home, "blobs"));
    const count = ingested ?? corpus.events;
    return { ms: r.ms, count, ingested, corpus, spoolBytes, idx, blobs, blobsApparent };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * perf.ingest + perf.storeSize over one synthetic corpus. With `baseline`, the
 * candidate and baseline builds ingest an identical corpus (same `day`) in
 * `pairs` interleaved runs (B C B C ...), each into a fresh home, and the paired
 * result is a bootstrap CI on the events/s difference, so machine noise on a
 * loaded host cancels out (never report an unpaired absolute from a loaded host).
 */
export function benchIngest({ cli = CLI, baseline, events = 100_000, pairs = 8 } = {}) {
  const day = 1_730_000_000_000; // fixed, so both builds see byte-identical spool files
  const one = (cliPath) => runIngestOnce(cliPath, events, day);
  if (!baseline) {
    const r = one(cli);
    return {
      "perf.ingest": Math.round(r.count / (r.ms / 1000)),
      "perf.storeSize": round((r.idx + r.blobs) / 1e6 / (r.count / 1000), 3),
      detail: { events: r.corpus.events, ingested: r.ingested, sessions: r.corpus.sessions.length, ingestMs: Math.round(r.ms), spoolMB: round(r.spoolBytes / 1e6, 1), indexMB: round(r.idx / 1e6, 2), blobsMB: round(r.blobs / 1e6, 2), blobsApparentMB: round(r.blobsApparent.bytes / 1e6, 2), blobFiles: r.blobsApparent.files, corpus: "synthetic only (the redacted copy of the live last 7 days is not included)" },
    };
  }
  const baseCli = join(baseline, "cli.mjs");
  const candMs = [];
  const baseMs = [];
  let last;
  let lastBase;
  one(cli); // warmup (fills OS cache, JIT)
  for (let i = 0; i < pairs; i++) {
    const b = one(baseCli);
    const c = one(cli);
    baseMs.push(b.ms);
    candMs.push(c.ms);
    last = c;
    lastBase = b;
  }
  const eps = (ms) => Math.round(last.count / (ms / 1000));
  const candEps = candMs.map(eps);
  const baseEps = baseMs.map(eps);
  const d = bootstrapMedianDiff(baseEps, candEps);
  const storeSize = (r) => round((r.idx + r.blobs) / 1e6 / (r.count / 1000), 3);
  return {
    "perf.ingest": median(candEps),
    "perf.storeSize": storeSize(last),
    baseline: { "perf.ingest": median(baseEps), "perf.storeSize": storeSize(lastBase) },
    paired: { "perf.ingest": { diff: round(d.diff, 1), ci: d.ci.map((x) => round(x, 1)), unit: "events/s (candidate − baseline)" } },
    detail: { pairs, events: last.corpus.events, candIngestMedianMs: round(median(candMs), 0), baseIngestMedianMs: round(median(baseMs), 0), indexMB: round(last.idx / 1e6, 2), blobsMB: round(last.blobs / 1e6, 2), blobFiles: last.blobsApparent.files, baseIndexMB: round(lastBase.idx / 1e6, 2), baseBlobsMB: round(lastBase.blobs / 1e6, 2), baseBlobFiles: lastBase.blobsApparent.files },
  };
}

/** perf.help: median of 20 `--help` runs. */
export function benchHelp({ cli = CLI, baseline, n = 20 } = {}) {
  const root = tempDir("cs-bench-help-");
  try {
    const env = isolatedEnv(root);
    mkdirSync(env.HOME, { recursive: true });
    const run = (c) => timeSpawn(process.execPath, [c, "--help"], env, "");
    run(cli);
    const cand = [];
    const base = [];
    for (let i = 0; i < n; i++) {
      cand.push(run(cli));
      if (baseline) base.push(run(join(baseline, "cli.mjs")));
    }
    const out = { "perf.help": round(median(cand), 1), detail: { n, p95: round(nearestRank(cand, 95), 1) } };
    if (baseline) {
      const d = bootstrapMedianDiff(base, cand);
      out.paired = { "perf.help": { diff: round(d.diff, 2), ci: d.ci.map((x) => round(x, 2)) } };
    }
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- proxy overhead

/**
 * perf.proxyChunk / perf.proxyTtfb: what `coding.sh proxy` adds to a streamed
 * Anthropic call. A local upstream streams `chunks` SSE events `gapMs` apart; the
 * client calls it directly and through the proxy, interleaved (A B A B ...), on
 * keep-alive connections. Per chunk: arrival time minus the upstream's write time
 * (one process, one clock); TTFB: request sent to first body byte. The overhead is
 * the proxy median minus the direct median, with a paired bootstrap CI.
 */
export async function benchProxy({ cli = CLI, n = 60, warmup = 5, chunks = 20, gapMs = 2 } = {}) {
  const root = tempDir("cs-bench-proxy-");
  const writes = new Map();
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      const id = String(req.headers["x-bench-id"]);
      const at = [];
      writes.set(id, at);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: `msg_${id}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 1200, cache_read_input_tokens: 9000, output_tokens: 1 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      for (let i = 0; i < chunks; i++) {
        await sleep(gapMs);
        at[i] = performance.now();
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: `chunk ${i} ${"lorem ipsum dolor sit amet ".repeat(3)}` } });
      }
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: chunks * 12 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upUrl = `http://127.0.0.1:${upstream.address().port}`;
  let proxy;
  try {
    const env = isolatedEnv(root);
    mkdirSync(env.HOME, { recursive: true });
    const port = await new Promise((r) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => r(p));
      });
    });
    proxy = spawn(process.execPath, [cli, "proxy", "--quiet", "--port", String(port), "--anthropic-upstream", upUrl], { env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proxy.stderr.on("data", (d) => (err += d));
    const proxyUrl = `http://127.0.0.1:${port}`;
    await waitFor(() => fetch(`${proxyUrl}/__codingsh/health`).then((r) => r.ok, () => false), 20_000, `proxy health (${err.slice(0, 300)})`);

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const body = JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, stream: true, system: "You are a benchmark.", messages: [{ role: "user", content: "stream something" }] });
    let seq = 0;
    const call = (base) =>
      new Promise((resolve, reject) => {
        const id = `${seq++}`;
        const arrive = [];
        let ttfb;
        const t0 = performance.now();
        const req = http.request(`${base}/v1/messages`, { method: "POST", agent, headers: { "content-type": "application/json", "x-api-key": "sk-ant-bench", "anthropic-version": "2023-06-01", "x-bench-id": id, "content-length": Buffer.byteLength(body) } }, (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (d) => {
            const now = performance.now();
            ttfb ??= now - t0;
            buf += d;
            for (const m of buf.matchAll(/"text":"chunk (\d+) /g)) arrive[Number(m[1])] ??= now;
            buf = buf.slice(Math.max(0, buf.lastIndexOf("\n\n")));
          });
          res.on("end", () => {
            const at = writes.get(id) ?? [];
            writes.delete(id);
            if (res.statusCode !== 200 || arrive.length !== chunks) return reject(new Error(`${base}: status ${res.statusCode}, ${arrive.length}/${chunks} chunks`));
            resolve({ ttfb, chunk: median(arrive.map((t, i) => t - at[i])) });
          });
        });
        req.on("error", reject);
        req.end(body);
      });

    for (let i = 0; i < warmup; i++) {
      await call(upUrl);
      await call(proxyUrl);
    }
    const direct = [];
    const proxied = [];
    for (let i = 0; i < n; i++) {
      direct.push(await call(upUrl));
      proxied.push(await call(proxyUrl));
    }
    agent.destroy();
    const pick = (xs, k) => xs.map((x) => x[k]);
    const chunk = bootstrapMedianDiff(pick(direct, "chunk"), pick(proxied, "chunk"));
    const ttfb = bootstrapMedianDiff(pick(direct, "ttfb"), pick(proxied, "ttfb"));
    return {
      "perf.proxyChunk": round(chunk.diff, 2),
      "perf.proxyTtfb": round(ttfb.diff, 2),
      paired: { "perf.proxyChunk": { diff: round(chunk.diff, 3), ci: chunk.ci.map((x) => round(x, 3)) }, "perf.proxyTtfb": { diff: round(ttfb.diff, 3), ci: ttfb.ci.map((x) => round(x, 3)) } },
      detail: { n, warmup, chunks, gapMs, directChunkMs: round(median(pick(direct, "chunk")), 3), proxyChunkMs: round(median(pick(proxied, "chunk")), 3), directTtfbMs: round(median(pick(direct, "ttfb")), 3), proxyTtfbMs: round(median(pick(proxied, "ttfb")), 3), proxyTtfbP95Ms: round(quantile(pick(proxied, "ttfb"), 0.95), 3) },
    };
  } finally {
    proxy?.kill("SIGINT");
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(() => r()));
    await sleep(300);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ---------------------------------------------------------------- proxy over a long session

/** A free loopback port. */
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

/**
 * Message i of a Claude Code–like conversation: a prompt, then tool calls and
 * their results, some of them long (over the 2 KiB that gets a blob of its own).
 */
function sessionMessage(i, rnd) {
  if (i === 0) return { role: "user", content: [{ type: "text", text: "fix the failing tests and keep going" }] };
  if (i % 2 === 1) return { role: "assistant", content: [{ type: "text", text: `step ${i}` }, { type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: `npm test -- --grep case${i}` } }] };
  const len = rnd() < 0.15 ? 2048 + Math.floor(rnd() * 6144) : 200 + Math.floor(rnd() * 800);
  return { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i - 1}`, content: `line ${i} ${"output of the tool ".repeat(Math.ceil(len / 18)).slice(0, len)}` }] };
}

/**
 * perf.proxyRecord: how long `coding.sh proxy` takes to store a call (from the
 * end of the response until the session row counts it) in the last quarter of a
 * long Claude Code–like session, where every call re-sends the conversation so
 * far (reset every `compactEvery` calls, as a compaction does). The recording
 * runs after the response, on the proxy's one thread, so it is what a
 * concurrent stream or the agent's next call can wait on. With --baseline, both
 * builds run side by side, each with its own store, in alternating order, and
 * each quarter of the session gets a paired bootstrap CI on the median difference.
 */
export async function benchProxySession({ cli = CLI, baseline, calls = 1000, compactEvery = 200 } = {}) {
  const root = tempDir("cs-bench-proxy-session-");
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const id = String(req.headers["x-bench-id"]);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: `msg_${id}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 1200, cache_read_input_tokens: 90000, output_tokens: 1 } } });
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "running the tests" } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upUrl = `http://127.0.0.1:${upstream.address().port}`;
  const { DatabaseSync } = await import("node:sqlite");
  const session = "5e55a0de-0000-4000-8000-0000000000bb";
  const targets = [];
  try {
    for (const [name, file] of [["candidate", cli], ...(baseline ? [["baseline", join(baseline, "cli.mjs")]] : [])]) {
      const env = isolatedEnv(join(root, name));
      mkdirSync(env.HOME, { recursive: true });
      const port = await freePort();
      const proc = spawn(process.execPath, [file, "proxy", "--quiet", "--port", String(port), "--anthropic-upstream", upUrl], { env, stdio: ["ignore", "ignore", "pipe"] });
      const t = { name, proc, url: `http://127.0.0.1:${port}`, db: join(env.CODING_SH_HOME, "index.db"), err: "", record: [], ttfb: [] };
      proc.stderr.on("data", (d) => (t.err += d));
      targets.push(t);
      await waitFor(() => fetch(`${t.url}/__codingsh/health`).then((r) => r.ok, () => false), 20_000, `${name} proxy health (${t.err.slice(0, 300)})`);
    }
    const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
    const send = (t, body, id) =>
      new Promise((resolve, reject) => {
        const t0 = performance.now();
        let ttfb;
        const headers = { "content-type": "application/json", "x-api-key": "sk-ant-bench", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.319 (external, cli)", "x-claude-code-session-id": session, "x-bench-id": id, "content-length": Buffer.byteLength(body) };
        const req = http.request(`${t.url}/v1/messages`, { method: "POST", agent, headers }, (res) => {
          res.on("data", () => (ttfb ??= performance.now() - t0));
          res.on("end", () => (res.statusCode === 200 ? resolve({ ttfb, end: performance.now() }) : reject(new Error(`${t.name}: status ${res.statusCode}`))));
        });
        req.on("error", reject);
        req.end(body);
      });
    /** Waits until the session row counts `n` model calls; ms since `since`. */
    const recorded = async (t, n, since) => {
      for (const deadline = performance.now() + 30_000; performance.now() < deadline; ) {
        try {
          t.conn ??= new DatabaseSync(t.db, { readOnly: true });
          const row = t.conn.prepare("SELECT json_extract(stats, '$.latency.llmCalls') AS n FROM sessions WHERE id = ?").get(session);
          if ((row?.n ?? 0) >= n) return performance.now() - since;
        } catch {
          // The proxy has not created its store yet.
        }
        await new Promise((r) => setImmediate(r));
      }
      throw new Error(`${t.name}: call ${n} not recorded within 30 s (${t.err.slice(0, 300)})`);
    };
    const rnd = prng(7);
    let messages = [];
    for (let k = 0; k < calls; k++) {
      if (k % compactEvery === 0) messages = [sessionMessage(0, rnd)];
      const last = messages.at(-1);
      const sent = [...messages.slice(0, -1), { ...last, content: last.content.map((c) => ({ ...c, cache_control: { type: "ephemeral" } })) }];
      const system = [{ type: "text", text: `You are Claude Code. ${"Follow the repository conventions. ".repeat(200)}` }];
      const tools = ["Bash", "Read", "Edit", "Write", "Grep"].map((name) => ({ name, description: `${name} tool. ${"How to call it. ".repeat(40)}`, input_schema: { type: "object" } }));
      const body = JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 32000, stream: true, system, tools, messages: sent });
      for (const t of k % 2 ? [...targets].reverse() : targets) {
        const r = await send(t, body, `${t.name}_${k}`);
        t.ttfb.push(r.ttfb);
        t.record.push(await recorded(t, k + 1, r.end));
      }
      // The reply and the tool's result join the conversation the next call sends.
      messages.push(sessionMessage(messages.length, rnd), sessionMessage(messages.length + 1, rnd));
    }
    agent.destroy();
    const quarters = (xs) => [0, 1, 2, 3].map((q) => xs.slice(Math.floor((q * xs.length) / 4), Math.floor(((q + 1) * xs.length) / 4)));
    const summary = (t) => ({ recordMsByQuarter: quarters(t.record).map((x) => round(median(x), 2)), recordP95Ms: round(quantile(t.record, 0.95), 2), ttfbMs: round(median(t.ttfb), 2) });
    const [cand, base] = targets;
    const out = { "perf.proxyRecord": round(median(quarters(cand.record)[3]), 2), detail: { calls, compactEvery, ...summary(cand) } };
    if (base) {
      out.baseline = { "perf.proxyRecord": round(median(quarters(base.record)[3]), 2), ...summary(base) };
      // Candidate minus baseline: negative is faster.
      const paired = (a, b, digits) => {
        const d = bootstrapMedianDiff(a, b);
        return { diff: round(d.diff, digits), ci: d.ci.map((x) => round(x, digits)) };
      };
      out.paired = {
        recordByQuarter: quarters(cand.record).map((c, q) => paired(quarters(base.record)[q], c, 2)),
        ttfb: paired(base.ttfb, cand.ttfb, 3),
      };
    }
    return out;
  } finally {
    for (const t of targets) {
      t.conn?.close();
      t.proc.kill("SIGINT");
    }
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(() => r()));
    await sleep(300);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ---------------------------------------------------------------- viewer TTI

const CHROME_CANDIDATES = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
export function findChrome() {
  return CHROME_CANDIDATES.find((p) => existsSync(p));
}
export function findLighthouse() {
  const r = sh("sh", ["-c", "command -v lighthouse"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Minimal CDP client over Node's global WebSocket. */
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("cdp: websocket error"));
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else for (const l of listeners) l(msg);
  };
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      }),
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

/**
 * perf.viewerTti. Lighthouse `interactive` when the lighthouse CLI is installed;
 * otherwise a Chrome DevTools proxy, labeled as such: time from navigation start
 * to the later of DOMContentLoaded and the end of the last long task, after a
 * 2 s quiet window with the session timeline rendered (Lighthouse's definition
 * uses a 5 s quiet window and network quiescence too).
 */
export async function benchViewer({ cli = CLI, events = 5000, runs = 3 } = {}) {
  const chrome = findChrome();
  const lighthouse = findLighthouse();
  if (!chrome && !lighthouse) return { "perf.viewerTti": null, skipped: "no Chrome and no lighthouse CLI" };
  const root = tempDir("cs-bench-viewer-");
  let server;
  let browser;
  try {
    const env = isolatedEnv(root);
    mkdirSync(env.HOME, { recursive: true });
    const corpus = writeCorpus(env.CODING_SH_HOME, { events, perSession: events });
    server = spawn(process.execPath, [cli, "ui", "--no-open", "--port", "0", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    server.stdout.on("data", (d) => (buf += d));
    const info = await waitFor(() => {
      try {
        return JSON.parse(buf.trim().split("\n")[0]);
      } catch {
        return undefined;
      }
    }, 60_000, "viewer url");
    const url = `${info.url}#/s/${encodeURIComponent(corpus.sessions[0])}`;
    // `ui` indexes the spool after it starts listening: measure the page, not the import.
    const token = new URL(info.url).searchParams.get("t");
    await waitFor(async () => {
      const r = await fetch(new URL(`/api/sessions/${encodeURIComponent(corpus.sessions[0])}`, info.url), { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      return r?.ok && (await r.json()).stats?.events >= corpus.events;
    }, 120_000, "corpus indexed");
    if (lighthouse) {
      const vals = [];
      for (let i = 0; i < runs; i++) {
        const r = sh(lighthouse, [url, "--only-audits=interactive", "--output=json", "--quiet", "--chrome-flags=--headless=new"], { env });
        vals.push(JSON.parse(r.stdout).audits.interactive.numericValue);
      }
      return { "perf.viewerTti": Math.round(median(vals)), method: "lighthouse interactive", detail: { runs: vals.map(Math.round), events: corpus.events } };
    }
    const profile = join(root, "chrome");
    // Chrome will not start as root without --no-sandbox (the desk's WSL runs benches as root).
    const sandbox = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
    browser = spawn(chrome, ["--headless=new", ...sandbox, "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync", "--metrics-recording-only", "--mute-audio", "--use-mock-keychain", "--password-store=basic", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    let chromeErr = "";
    browser.stderr.on("data", (d) => (chromeErr = (chromeErr + d).slice(-2000)));
    const portFile = join(profile, "DevToolsActivePort");
    const portText = await waitFor(() => existsSync(portFile) && readFileSync(portFile, "utf8").trim().split("\n").length >= 2 && readFileSync(portFile, "utf8"), 20_000, "chrome devtools port").catch((e) => {
      throw new Error(`${e.message}; chrome stderr: ${chromeErr.trim().split("\n").slice(-3).join(" | ") || "(none)"}`);
    });
    const [port, path] = portText.trim().split("\n");
    const c = await cdp(`ws://127.0.0.1:${port}${path}`);
    const vals = [];
    const detail = [];
    for (let i = 0; i < runs + 1; i++) {
      const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
      const s = (m, p) => c.send(m, p, sessionId);
      await s("Page.enable");
      await s("Runtime.enable");
      await s("Network.enable");
      await s("Network.setCacheDisabled", { cacheDisabled: true });
      await s("Page.addScriptToEvaluateOnNewDocument", { source: "window.__lt=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push(e.startTime+e.duration)}).observe({type:'longtask',buffered:true})}catch{}" });
      await s("Page.navigate", { url });
      const evalJs = async (expr) => (await s("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
      // Rendered: the session view lists its steps (the timeline's rows, a virtual list).
      await waitFor(() => evalJs(`document.readyState==='complete' && document.querySelectorAll('#steps .st').length > 20`), 30_000, "timeline render");
      let lastLt = -1;
      let quietSince = Date.now();
      await waitFor(async () => {
        const lt = await evalJs("window.__lt.length? Math.max(...window.__lt) : 0");
        if (lt !== lastLt) {
          lastLt = lt;
          quietSince = Date.now();
        }
        return Date.now() - quietSince > 2000;
      }, 60_000, "quiet window");
      const r = await evalJs("(()=>{const n=performance.getEntriesByType('navigation')[0];const lt=window.__lt.length?Math.max(...window.__lt):0;return {dcl:n.domContentLoadedEventEnd,load:n.loadEventEnd,lastLongTask:lt,longTasks:window.__lt.length,nodes:document.getElementsByTagName('*').length}})()");
      const tti = Math.max(r.dcl, r.lastLongTask);
      if (i > 0) {
        vals.push(tti);
        detail.push({ tti: Math.round(tti), ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)])) });
      }
      await c.send("Target.closeTarget", { targetId });
    }
    c.close();
    return { "perf.viewerTti": Math.round(median(vals)), method: "cdp-proxy (max(DCL, last long task) after a 2 s quiet window; lighthouse not installed)", detail: { runs: detail, events: corpus.events } };
  } finally {
    server?.kill("SIGINT");
    browser?.kill("SIGTERM");
    await sleep(300);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

// ---------------------------------------------------------------- replay

/**
 * One claude-code session that edits: 40 files, each written once (about 6 KB, so the
 * content sits in a blob), then edited, read and tested in turn. Every edit matches, so
 * the last step's file is rebuilt through its whole chain of edits.
 */
export function writeReplayCorpus(home, { events = 12_000, files = 40, lines = 300, day = Date.now() - 86_400_000 } = {}) {
  const spool = join(home, "spool", "claude-code");
  mkdirSync(spool, { recursive: true });
  const sid = "00000000-0000-4000-8000-00000000beef";
  const cwd = join(home, "..", "repo");
  const pid = 60_000;
  const rows = [];
  let t = day;
  const line = (event, raw) => {
    rows.push(JSON.stringify({ v: 0, agent: "claude-code", event, ts: t, pid, ppid: pid - 1, cwd, raw: { session_id: sid, hook_event_name: event, cwd, ...raw } }));
    t += 250;
  };
  const vals = Array.from({ length: files }, () => new Array(lines).fill(0));
  const written = new Array(files).fill(false);
  const call = (name, input, response) => {
    const id = `toolu_r${rows.length}`;
    line("PreToolUse", { tool_name: name, tool_use_id: id, tool_input: input });
    line("PostToolUse", { tool_name: name, tool_use_id: id, tool_input: input, tool_response: response, duration_ms: 30 });
  };
  line("SessionStart", { source: "startup" });
  line("UserPromptSubmit", { prompt: "refactor every module and keep the tests green" });
  let edits = 0;
  for (let k = 0; rows.length < events - 3; k++) {
    const f = k % files;
    const path = `${cwd}/src/mod${f}.ts`;
    const text = () => vals[f].map((v, i) => `export const v${i} = ${v}; // mod${f}`).join("\n") + "\n";
    if (!written[f]) {
      written[f] = true;
      call("Write", { file_path: path, content: text() }, { type: "create", filePath: path });
    } else if (k % 7 === 3) {
      call("Bash", { command: `npm test -- mod${f}` }, { stdout: `ok ${k}\n`.repeat(20), stderr: "" });
    } else if (k % 11 === 5) {
      call("Read", { file_path: path }, { type: "text", file: { filePath: path, content: text() } });
    } else {
      const i = (k * 31) % lines;
      const before = `export const v${i} = ${vals[f][i]};`;
      vals[f][i]++;
      call("Edit", { file_path: path, old_string: before, new_string: `export const v${i} = ${vals[f][i]};` }, { filePath: path });
      edits++;
    }
  }
  line("Stop", { last_assistant_message: "done" });
  writeFileSync(join(spool, `${new Date(day).toISOString().slice(0, 10)}.${pid}.jsonl`), rows.join("\n") + "\n");
  return { events: rows.length, session: sid, edits, files };
}

/**
 * Replay on a 12k-event editing session, through the viewer's HTTP API: the cold step
 * list (events read, steps built), the last step with its file rebuilt through every edit
 * (cold, then warm), a middle step, and the whole-session range. Each a median of `runs`
 * fresh viewer processes for the cold numbers.
 */
export async function benchReplay({ cli = CLI, events = 12_000, runs = 3 } = {}) {
  const root = tempDir("cs-bench-replay-");
  const servers = [];
  try {
    const env = isolatedEnv(root);
    mkdirSync(env.HOME, { recursive: true });
    const corpus = writeReplayCorpus(env.CODING_SH_HOME, { events });
    const ing = sh(process.execPath, [cli, "ingest", "--json"], { env });
    if (ing.code !== 0) throw new Error(`ingest exited ${ing.code}: ${ing.stderr.slice(0, 400)}`);
    const samples = { index: [], lastCold: [], lastWarm: [], mid: [], range: [] };
    let steps = 0;
    let lastFile;
    for (let i = 0; i < runs; i++) {
      const server = spawn(process.execPath, [cli, "ui", "--no-open", "--port", "0", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
      servers.push(server);
      let buf = "";
      server.stdout.on("data", (d) => (buf += d));
      const info = await waitFor(() => {
        try {
          return JSON.parse(buf.trim().split("\n")[0]);
        } catch {
          return undefined;
        }
      }, 60_000, "viewer url");
      const u = new URL(info.url);
      const token = u.searchParams.get("t");
      const base = `${u.origin}/api/sessions/${encodeURIComponent(corpus.session)}/replay`;
      const get = async (q) => {
        const t0 = performance.now();
        const r = await fetch(base + q, { headers: { authorization: `Bearer ${token}` } });
        const body = await r.json();
        if (!r.ok) throw new Error(`replay${q}: ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
        return { ms: performance.now() - t0, body };
      };
      const idx = await get("");
      samples.index.push(idx.ms);
      steps = idx.body.steps.length;
      const last = [...idx.body.steps].reverse().find((s) => s.files?.some((f) => f.op !== "read"));
      lastFile = last.files[0].path;
      const q = `?step=${last.n}&file=${encodeURIComponent(lastFile)}`;
      const cold = await get(q);
      if (cold.body.file.content === undefined) throw new Error(`replay lost ${lastFile}: ${cold.body.file.why}`);
      samples.lastCold.push(cold.ms);
      samples.lastWarm.push((await get(q)).ms);
      samples.mid.push((await get(`?step=${Math.floor(steps / 2)}`)).ms);
      samples.range.push((await get(`?from=1&to=${steps}`)).ms);
      server.kill("SIGINT");
    }
    const med = (xs) => Math.round(median(xs));
    return {
      "perf.replayIndex": med(samples.index),
      "perf.replayStep": med(samples.lastCold),
      detail: {
        events: corpus.events, steps, edits: corpus.edits, files: corpus.files, runs,
        indexMs: samples.index.map(Math.round), lastStepColdMs: samples.lastCold.map(Math.round), lastStepWarmMs: med(samples.lastWarm),
        midStepMs: med(samples.mid), wholeRangeMs: med(samples.range), lastFile,
      },
    };
  } finally {
    for (const s of servers) s.kill("SIGINT");
    await sleep(300);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * perf.harnessAudit, perf.harnessAuditRss: `coding.sh harness audit --since 90d --json` over the store
 * bench-where.mjs writes with --memory, every session in the window. The median wall time of n runs after
 * one that warms the file cache, with the bootstrap 95% CI of that median, and the highest peak RSS of any
 * run (the process's own ru_maxrss, written on exit by a preload). The store is only read: nothing waits in
 * the temp home's spool and background ingest is off.
 */
export function benchHarnessAudit({ cli = CLI, baseline, store, n = 7, events, sessions } = {}) {
  const root = tempDir("csh-bench-audit-");
  try {
    const env = isolatedEnv(root, { CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_UPDATE_CHECK: "1", NO_COLOR: "1" });
    mkdirSync(env.CODING_SH_HOME, { recursive: true });
    const db = join(env.CODING_SH_HOME, "index.db");
    if (store) symlinkSync(resolve(store), db);
    else {
      const size = [];
      if (events) size.push("--events", String(events));
      if (sessions) size.push("--sessions", String(sessions));
      const gen = sh(process.execPath, ["--no-warnings", join(REPO, "scripts", "dogfood", "bench-where.mjs"), "gen", db, "--memory", ...size], { env });
      if (gen.code !== 0) throw new Error(`bench-where gen exited ${gen.code}: ${gen.stderr.slice(-300)}`);
    }
    const preload = join(root, "rss.cjs");
    const rssFile = join(root, "rss.txt");
    writeFileSync(preload, `process.on("exit", () => { try { require("node:fs").writeFileSync(${JSON.stringify(rssFile)}, String(process.resourceUsage().maxRSS)); } catch {} });\n`);
    let report;
    const once = (path) => {
      const r = sh(process.execPath, ["--no-warnings", "--require", preload, path, "harness", "audit", "--since", "90d", "--json"], { env, cwd: root });
      if (r.code !== 0) throw new Error(`harness audit exited ${r.code}: ${r.stderr.slice(-300)}`);
      report = JSON.parse(r.stdout);
      return { ms: r.ms, rssMb: Number(readFileSync(rssFile, "utf8")) / 1024 };
    };
    const base = baseline ? join(baseline, "cli.mjs") : undefined;
    once(cli);
    const candReport = report;
    if (base) once(base);
    const baseReport = report;
    const cand = [];
    const baseRuns = [];
    for (let i = 0; i < n; i++) {
      if (base) baseRuns.push(once(base));
      cand.push(once(cli));
    }
    const ms = cand.map((r) => r.ms);
    // `since` is the time of the run, so it differs between two runs of one build.
    const stable = (r) => JSON.stringify({ ...r, since: undefined });
    // The median against itself shifted to zero: the bootstrap CI of one sample's median.
    const ci = bootstrapMedianDiff(ms.map(() => 0), ms).ci;
    const out = {
      "perf.harnessAudit": round(median(ms), 0),
      "perf.harnessAuditRss": round(Math.max(...cand.map((r) => r.rssMb)), 0),
      detail: { n, ci95: ci.map((x) => round(x, 0)), minMs: round(Math.min(...ms), 0), maxMs: round(Math.max(...ms), 0), sessions: candReport.sessions, files: candReport.totals?.files, storeMB: Math.round(statSync(store ? resolve(store) : db).size / 1e6) },
    };
    if (base) {
      const baseMs = baseRuns.map((r) => r.ms);
      const d = bootstrapMedianDiff(baseMs, ms);
      out.baseline = { "perf.harnessAudit": round(median(baseMs), 0), "perf.harnessAuditRss": round(Math.max(...baseRuns.map((r) => r.rssMb)), 0), sameReport: stable(baseReport) === stable(candReport) };
      out.paired = { "perf.harnessAudit": { diff: round(d.diff, 0), ci: d.ci.map((x) => round(x, 0)), unit: "ms (candidate − baseline)" } };
    }
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runBenches(which = ["hook", "ingest", "help", "viewer"], opts = {}) {
  const out = {};
  const errors = {};
  const step = async (name, fn) => {
    const t0 = performance.now();
    try {
      const r = await fn();
      out[name] = r;
      log(`bench ${name}: ${JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k.startsWith("perf."))))} (${Math.round(performance.now() - t0)} ms)`);
    } catch (e) {
      errors[name] = e.message;
      log(`bench ${name}: error ${e.message}`);
    }
  };
  if (which.includes("hook")) await step("hook", () => benchHook(opts));
  if (which.includes("ingest") || which.includes("store")) await step("ingest", () => benchIngest(opts));
  if (which.includes("help")) await step("help", () => benchHelp(opts));
  if (which.includes("viewer")) await step("viewer", () => benchViewer(opts));
  if (which.includes("viewer") || which.includes("replay")) await step("replay", () => benchReplay({ ...opts, events: opts.replayEvents }));
  if (which.includes("proxy")) await step("proxy", () => benchProxy(opts));
  if (which.includes("proxy-session")) await step("proxy-session", () => benchProxySession(opts));
  if (which.includes("collector")) await step("collector", () => benchCollector({ ...(opts.clients ? { clients: opts.clients } : {}), ...(opts.seconds ? { seconds: opts.seconds } : {}), ...(opts.dist ? { dist: opts.dist } : {}), ...(opts.sessions ? { sessions: opts.sessions } : {}) }));
  if (which.includes("harness-audit")) await step("harness-audit", () => benchHarnessAudit({ baseline: opts.baseline || undefined, store: opts.store || undefined, n: opts.runs || undefined, events: opts.events || undefined, sessions: opts.sessions || undefined }));
  return { results: out, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2), { booleans: ["json", "check"] });
  const which = args._.length ? args._ : ["hook", "ingest", "help", "viewer"];
  const baseline = args.baseline ? resolve(args.baseline) : undefined;
  const r = await runBenches(which, { baseline, events: args.events ? Number(args.events) : undefined, calls: args.calls ? Number(args.calls) : undefined, pairs: args.pairs ? Number(args.pairs) : undefined, clients: args.clients ? Number(args.clients) : undefined, seconds: args.seconds ? Number(args.seconds) : undefined, dist: args.dist ? resolve(args.dist) : undefined, sessions: args.sessions, store: args.store, runs: args.runs ? Number(args.runs) : undefined });
  process.stdout.write(JSON.stringify(r, null, args.json ? 0 : 2) + "\n");
  const tolerance = args.tolerance ? Number(args.tolerance) : 0;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    log(`--tolerance takes a percentage of 0 or more, got ${args.tolerance}`);
    process.exit(2);
  }
  const missed = Object.values(r.results).flatMap((x) => Object.entries(x).filter(([k, v]) => k.startsWith("perf.") && meets(k, v, tolerance) === false));
  for (const [k, v] of missed) log(`over budget: ${k} ${v} ${TARGETS[k].unit} (target ${TARGETS[k].dir === "max" ? "≤" : "≥"} ${TARGETS[k].target}${tolerance ? `, ${tolerance}% tolerance` : ""})`);
  process.exitCode = Object.keys(r.errors).length || (args.check && missed.length) ? 1 : 0;
}
