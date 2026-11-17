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
console.log("pages-summary " + JSON.stringify(out));
