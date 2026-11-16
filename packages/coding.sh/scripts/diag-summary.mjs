// DIAGNOSTICS ONLY (throwaway branch). Reads a trace directory and prints the browser timings:
//   node scripts/diag-summary.mjs <trace dir>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const rows = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".jsonl")) continue;
  for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {}
  }
}
rows.sort((a, b) => a.t - b.t);
const t0 = rows[0]?.t ?? 0;
const rel = (t) => ((t - t0) / 1000).toFixed(1).padStart(6);
const files = new Map();
for (const r of rows) if (r.ev === "proc-start" && Array.isArray(r.files) && r.files[0]) files.set(r.pid, String(r.files[0]).replace(/^.*[\\/]test[\\/]/, "").replace(/\\/g, "/"));
const name = (pid) => files.get(pid) ?? `pid ${pid}`;
console.log("== Chrome launches (time since the first trace line, file, ms to DevTools, ms to socket)");
for (const r of rows) if (r.ev === "chrome-ws") console.log(rel(r.t), name(r.pid), `ws ${r.ms} ms`);
console.log("== page loads (file, browser.page, Page.navigate ms, load ms)");
for (const r of rows) if (r.ev === "goto-done" || r.ev === "goto-timeout") console.log(rel(r.t), name(r.pid), `p${r.p}`, `nav ${r.navMs}`, r.ev === "goto-done" ? `load ${r.loadMs}${r.wouldFail ? "  WOULD FAIL" : ""}` : `TIMEOUT ${JSON.stringify(r.st)}`);
console.log("== slow things (waits over 400 ms that are not page loads, DevTools calls over 1 s, event-loop lag)");
for (const r of rows) {
  if (r.ev === "wait" && r.what !== "page load" && r.ms > 2000) console.log(rel(r.t), name(r.pid), `wait "${r.what}" ${r.ms} ms`);
  if (r.ev === "wait-timeout") console.log(rel(r.t), name(r.pid), `WAIT TIMEOUT "${r.what}" ${r.ms} ms`);
  if (r.ev === "cdp" && r.ms > 1000) console.log(rel(r.t), name(r.pid), `cdp ${r.m} ${r.ms} ms ${r.x ?? ""}`);
  if (r.ev === "lag" && r.ms > 1000 && files.has(r.pid)) console.log(rel(r.t), name(r.pid), `lag ${r.ms} ms`);
  if (r.ev === "explore-calls") console.log(rel(r.t), name(r.pid), JSON.stringify(r));
}
const hb = rows.filter((r) => r.ev === "hb");
const q = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
if (hb.length) {
  for (const k of ["cmdMs", "nodeMs", "fileMs", "dllMs"]) {
    const a = hb.map((r) => r[k]).filter((x) => typeof x === "number" && x >= 0);
    if (a.length) console.log(`heartbeat ${k}: n ${a.length} p50 ${q(a, 0.5)} p90 ${q(a, 0.9)} max ${q(a, 1)}`);
  }
  console.log("== heartbeat seconds with a slow probe (cmd > 500 ms, node > 1500 ms, file > 500 ms) or a late timer");
  for (const r of rows) {
    if (r.ev === "hb" && (r.cmdMs > 500 || r.nodeMs > 1500 || r.fileMs > 500 || r.dllMs > 50)) console.log(rel(r.t), JSON.stringify(r));
    if (r.ev === "hb-late" && r.ms > 500) console.log(rel(r.t), `timer late ${r.ms} ms`);
    if (r.ev === "hb-chrome" && r.ms > 3000) console.log(rel(r.t), `probe chrome ${r.ms} ms`);
  }
  const pc = rows.filter((r) => r.ev === "hb-chrome").map((r) => r.ms);
  if (pc.length) console.log(`probe chrome: n ${pc.length} p50 ${q(pc, 0.5)} p90 ${q(pc, 0.9)} max ${q(pc, 1)}`);
}
