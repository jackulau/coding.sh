// Time to the first session row, with and without the server-drawn first paint
// (src/viewer/ssr.ts), on Chrome's Slow 4G profile and a 4x slower CPU.
// Interleaved pairs in random order, the paired difference with a 95% bootstrap
// interval. Not a test: run it by hand on an idle machine.
//
//   CODING_SH_TEST_CHROME=… node --no-warnings test/viewer/bench-first-row.ts [pairs] [--json]
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser } from "./browser.ts";
import { FakeBlobs } from "./fakes.ts";

const pairs = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 20);
const json = process.argv.includes("--json");
const chrome = findChrome();
if (!chrome) throw new Error("no Chrome: set CODING_SH_TEST_CHROME");

// 300 sessions of a few events each, over the last 30 days.
const index = new MemoryIndexStore();
const now = Date.now();
for (let k = 0; k < 300; k++) {
  const t = now - k * 2.4 * 3_600_000;
  const id = `bench-${String(k).padStart(3, "0")}`;
  const base = { v: 0, sessionId: id, agent: k % 3 ? "claude-code" : "codex", cwd: "/work/demo" } as const;
  const evs = [
    { ...base, id: id + "-0", ts: t, kind: "session.start", payload: {} },
    { ...base, id: id + "-1", ts: t + 1000, kind: "user.message", payload: { text: `Fix the failing test in module ${k}` } },
    { ...base, id: id + "-2", ts: t + 2000, kind: "tool.start", payload: { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } } },
    { ...base, id: id + "-3", ts: t + 9000, kind: "tool.end", payload: { tool: "Bash", toolUseId: "t1", ok: k % 7 !== 0, output: "ok" } },
    { ...base, id: id + "-4", ts: t + 12000, kind: "assistant.message", payload: { text: "Fixed." } },
    { ...base, id: id + "-5", ts: t + 13000, kind: "session.end", payload: {} },
  ] as unknown as AgentEvent[];
  await index.putEvents(evs);
  await index.upsertSession(buildSession(evs));
}

const base = { index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "bench" }) as any };
const arms: Record<"ssr" | "plain", Viewer> = { ssr: await startViewer(base), plain: await startViewer({ ...base, serverRender: false }) };
const browser = await launchBrowser(chrome);

// Chrome DevTools "Slow 4G": 562.5 ms latency, 1.44 Mbps down, 675 kbps up.
const SLOW_4G = { offline: false, latency: 562.5, downloadThroughput: (1.44 * 1024 * 1024) / 8, uploadThroughput: (675 * 1024) / 8 };
const MARK = `(() => {
  const seen = () => document.querySelector("main .row");
  const done = () => { if (window.__firstRow === undefined) requestAnimationFrame(() => { window.__firstRow = performance.now(); }); };
  new MutationObserver((_, o) => { if (seen()) { o.disconnect(); done(); } }).observe(document, { childList: true, subtree: true });
})();`;

async function once(arm: "ssr" | "plain"): Promise<number> {
  const v = arms[arm];
  const p = await browser.newPage();
  try {
    await p.goto(v.url); // the token for a cookie, unthrottled
    await p.send("Network.enable");
    await p.send("Network.setCacheDisabled", { cacheDisabled: true });
    await p.send("Network.emulateNetworkConditions", SLOW_4G);
    await p.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await p.send("Page.addScriptToEvaluateOnNewDocument", { source: MARK });
    await p.goto(`http://127.0.0.1:${v.port}/?run=${Math.random().toString(36).slice(2)}#/`);
    await p.waitFor("window.__firstRow !== undefined", "first row", 60_000);
    return (await p.eval("window.__firstRow")) as number;
  } finally {
    await p.close();
  }
}

const diffs: number[] = [];
const runs: { ssr: number[]; plain: number[] } = { ssr: [], plain: [] };
await once("ssr");
await once("plain"); // warm both servers
for (let i = 0; i < pairs; i++) {
  const order: ("ssr" | "plain")[] = Math.random() < 0.5 ? ["ssr", "plain"] : ["plain", "ssr"];
  const got: Record<string, number> = {};
  for (const a of order) got[a] = await once(a);
  runs.ssr.push(got.ssr!);
  runs.plain.push(got.plain!);
  diffs.push(got.plain! - got.ssr!);
  if (!json) process.stderr.write(`pair ${i + 1}/${pairs}: plain ${got.plain!.toFixed(0)} ms, ssr ${got.ssr!.toFixed(0)} ms\n`);
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const boots: number[] = [];
for (let b = 0; b < 10_000; b++) boots.push(mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(Math.random() * diffs.length)]!)));
boots.sort((a, b) => a - b);
const ci = [boots[Math.floor(0.025 * boots.length)]!, boots[Math.floor(0.975 * boots.length)]!];
const out = {
  pairs,
  profile: "Slow 4G (562.5 ms, 1.44 Mbps) + 4x CPU",
  plainMedianMs: Math.round(median(runs.plain)),
  ssrMedianMs: Math.round(median(runs.ssr)),
  meanSavedMs: Math.round(mean(diffs)),
  ci95Ms: ci.map(Math.round),
  excludesZero: ci[0]! > 0 || ci[1]! < 0,
};
console.log(json ? JSON.stringify(out) : out);
await browser.close();
await arms.ssr.close();
await arms.plain.close();
