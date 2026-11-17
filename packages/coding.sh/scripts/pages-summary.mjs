// THROWAWAY: prints the page loads of the Test step, with times relative to the machine's boot.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
let boot = 0;
try {
  boot = Date.parse(execFileSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"], { encoding: "utf8" }).trim().replace(/(\.\d{3})\d+/, "$1"));
} catch (e) {
  console.log("pages-summary: no boot time: " + e.message);
}
const file = process.env.CSH_PAGES;
const rows = file && existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.data) : [];
rows.sort((a, b) => a.at - a.ms - (b.at - b.ms));
const rel = (r) => Math.round((r.at - r.ms - boot) / 1000);
const seen = new Set();
const out = { boot: new Date(boot).toISOString(), now: Math.round((Date.now() - boot) / 1000), pages: rows.length, failed: rows.filter((r) => !r.ok).length, stepFirst: null, first: [], slow: [], laterP50: 0, laterMax: 0 };
const later = [];
for (const r of rows) {
  const row = { file: r.file, boot: rel(r), ms: r.ms, nav: r.navigateMs, checks: r.checks, slowest: r.slowestCheckMs, ok: r.ok };
  if (!out.stepFirst) out.stepFirst = row;
  if (!seen.has(r.pid)) {
    seen.add(r.pid);
    out.first.push(row);
  } else later.push(r.ms);
  if (r.ms >= 2000 || !r.ok) out.slow.push(row);
}
later.sort((a, b) => a - b);
out.laterP50 = later[later.length >> 1] ?? 0;
out.laterMax = later.at(-1) ?? 0;
// The pages that started inside the Storage Service window.
const inWin = rows.filter((r) => rel(r) >= 657 && rel(r) <= 706);
const firstPids = new Set();
const firstRows = rows.filter((r) => !firstPids.has(r.pid) && firstPids.add(r.pid));
const stat = (list) => {
  const ms = list.map((r) => r.ms).sort((a, b) => a - b);
  return { n: ms.length, p50: ms[ms.length >> 1] ?? 0, max: ms.at(-1) ?? 0, over2s: ms.filter((x) => x >= 2000).length, over5s: ms.filter((x) => x >= 5000).length, failed: list.filter((r) => !r.ok).length };
};
out.window = { all: stat(inWin), first: stat(inWin.filter((r) => firstRows.includes(r))) };
console.log("pages-summary " + JSON.stringify(out));

// The sampler's lines, in 10 s buckets from 600 to 770 s after boot.
const perf = process.env.CSH_PERF;
if (perf && existsSync(perf)) {
  const buckets = new Map();
  for (const l of readFileSync(perf, "utf8").split(/\r?\n/).filter(Boolean).slice(1)) {
    const c = l.split(",").map((x) => x.replace(/"/g, ""));
    const t = Date.parse(c[0].replace(/(\d+)\/(\d+)\/(\d+) /, "$3-$1-$2T") + "Z");
    const n = c.slice(1).map(Number);
    if (Number.isNaN(t) || n.length < 6 || n.some(Number.isNaN)) continue;
    const b = Math.floor((t - boot) / 10_000) * 10;
    if (b < 600 || b >= 770) continue;
    const a = buckets.get(b) ?? { n: 0, cpu: 0, queue: 0, read: 0, write: 0, pages: 0, secRead: 0 };
    a.n++; a.cpu += n[0]; a.queue += n[1]; a.read += n[2]; a.write += n[3]; a.pages += n[4]; a.secRead = Math.max(a.secRead, n[5]);
    buckets.set(b, a);
  }
  const line = [...buckets].sort((x, y) => x[0] - y[0]).map(([b, a]) => `${b}:cpu${Math.round(a.cpu / a.n)}% q${(a.queue / a.n).toFixed(1)} r${(a.read / a.n / 1e6).toFixed(1)}MB/s w${(a.write / a.n / 1e6).toFixed(1)}MB/s pg${Math.round(a.pages / a.n)}/s rd${Math.round(a.secRead * 1000)}ms`);
  console.log("perf-summary " + line.join(" | "));
} else console.log("perf-summary none");
