#!/usr/bin/env node
// Performance budgets (docs/design/dogfood.md §3.5). Every benchmark runs in a temp
// HOME / CODING_SH_HOME, never against the live home.
//
//   node scripts/dogfood/bench.mjs [hook|ingest|store|help|viewer|replay]... [--baseline <dist dir>] [--json]
//
// `viewer` also runs `replay` (session replay through the viewer API).
//
// With --baseline, the hook and help benchmarks interleave the baseline build
// with the candidate (A B A B ...) and report a bootstrap CI on the median
// difference, so machine noise is paired.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { bootstrapMedianDiff, CLI, DIST, isolatedEnv, log, median, nearestRank, parseArgs, quantile, round, sh, shAsync, tempDir } from "./lib/util.mjs";

export const TARGETS = {
  "perf.hook": { target: 10, unit: "ms", dir: "max" },
  "perf.hookP95": { target: 25, unit: "ms", dir: "max" },
  "perf.hook1mb": { target: 40, unit: "ms", dir: "max" },
  "perf.ingest": { target: 5000, unit: "events/s", dir: "min" },
  "perf.storeSize": { target: 2.0, unit: "MB/1k events", dir: "max" },
  "perf.viewerTti": { target: 1000, unit: "ms", dir: "max" },
  "perf.help": { target: 200, unit: "ms", dir: "max" },
  // Replay of a 12k-event editing session: the step list, and the last step with its file rebuilt (both cold).
  "perf.replayIndex": { target: 1000, unit: "ms", dir: "max" },
  "perf.replayStep": { target: 300, unit: "ms", dir: "max" },
};
export function meets(key, value) {
  const t = TARGETS[key];
  if (value === null || value === undefined || !t) return undefined;
  return t.dir === "min" ? value >= t.target : value <= t.target;
}

function hookPayload(bytes, cwd) {
  const filler = "x".repeat(Math.max(0, bytes - 400));
  return JSON.stringify({ session_id: "bench-0000", transcript_path: "/nonexistent", cwd, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_bench", tool_input: { command: "ls -la" }, tool_response: { stdout: filler, stderr: "", interrupted: false }, duration_ms: 12 });
}

function timeSpawn(cmd, args, env, input) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { env, input, stdio: ["pipe", "ignore", "pipe"] });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`${args.join(" ")} exited ${r.status}: ${String(r.stderr).slice(0, 300)}`);
  return ms;
}

/** perf.hook: hook spawn overhead over a bare `node -e ""`, median and p95, plus a 1 MB payload. */
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
    const nodeMed = median(node);
    const spoolFiles = existsSync(join(env.CODING_SH_HOME, "spool")) ? walkCount(join(env.CODING_SH_HOME, "spool")) : 0;
    const out = {
      "perf.hook": round(median(cand) - nodeMed, 1),
      "perf.hookP95": round(quantile(cand, 0.95) - quantile(node, 0.95), 1),
      "perf.hook1mb": round(median(candBig) - nodeMed, 1),
      detail: { n, warmup, nodeMedianMs: round(nodeMed, 1), hookMedianMs: round(median(cand), 1), hookP95Ms: round(quantile(cand, 0.95), 1), hook1mbMedianMs: round(median(candBig), 1), spoolFilesWritten: spoolFiles },
    };
    if (baseline) {
      out.baseline = { "perf.hook": round(median(base) - nodeMed, 1), "perf.hook1mb": round(median(baseBig) - nodeMed, 1) };
      const d = bootstrapMedianDiff(base, cand);
      out.paired = { "perf.hook": { diff: round(d.diff, 2), ci: d.ci.map((x) => round(x, 2)) } };
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

/** perf.ingest + perf.storeSize over one synthetic corpus. */
export function benchIngest({ cli = CLI, events = 100_000 } = {}) {
  const root = tempDir("cs-bench-ingest-");
  try {
    const env = isolatedEnv(root);
    mkdirSync(env.HOME, { recursive: true });
    const corpus = writeCorpus(env.CODING_SH_HOME, { events });
    const spoolBytes = duBytes(join(env.CODING_SH_HOME, "spool"));
    const r = sh(process.execPath, [cli, "ingest", "--json"], { env });
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
    return {
      "perf.ingest": Math.round(count / (r.ms / 1000)),
      "perf.storeSize": round((idx + blobs) / 1e6 / (count / 1000), 3),
      detail: { events: corpus.events, ingested, sessions: corpus.sessions.length, ingestMs: Math.round(r.ms), spoolMB: round(spoolBytes / 1e6, 1), indexMB: round(idx / 1e6, 2), blobsMB: round(blobs / 1e6, 2), blobsApparentMB: round(blobsApparent.bytes / 1e6, 2), blobFiles: blobsApparent.files, corpus: "synthetic only (the redacted copy of the live last 7 days is not included)" },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    browser = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync", "--metrics-recording-only", "--mute-audio", "about:blank"], { stdio: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    const [port, path] = (await waitFor(() => existsSync(portFile) && readFileSync(portFile, "utf8").trim().split("\n").length >= 2 && readFileSync(portFile, "utf8"), 20_000, "chrome devtools port")).trim().split("\n");
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
  return { results: out, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2), { booleans: ["json"] });
  const which = args._.length ? args._ : ["hook", "ingest", "help", "viewer"];
  const baseline = args.baseline ? resolve(args.baseline) : undefined;
  const r = await runBenches(which, { baseline, events: args.events ? Number(args.events) : undefined });
  process.stdout.write(JSON.stringify(r, null, args.json ? 0 : 2) + "\n");
  process.exitCode = Object.keys(r.errors).length ? 1 : 0;
}
