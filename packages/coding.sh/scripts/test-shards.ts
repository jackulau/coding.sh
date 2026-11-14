// Splits the test files into CI shards of about equal run time. node --test-shard splits by file
// count, so one shard could get every slow CLI test and run minutes past its siblings.
// scripts/test-durations.json holds each file's time from a CI run (milliseconds, the sum of its
// top-level tests). A file it does not list counts as the median file. Stale entries are ignored.
//
// Refresh the times from a CI run's artifacts (the Linux Node 24 legs upload them):
//   gh run download <run id> -p 'test-durations-*' -D /tmp/td
//   node scripts/test-shards.ts merge /tmp/td/*/*.json
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DURATIONS = new URL("./test-durations.json", import.meta.url);

/** Every test file under `dir`, as sorted paths relative to `root` with forward slashes. */
export function testFiles(root: string, dir = "test"): string[] {
  return readdirSync(join(root, dir), { recursive: true })
    .map((f) => `${dir}/${String(f).replaceAll("\\", "/")}`)
    .filter((f) => f.endsWith(".test.ts"))
    .sort();
}

export function readDurations(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(DURATIONS, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The files of shard `index` (1-based) of `total`. Longest file first, each to the shard with the
 * least time so far; ties go to the lower shard. Every file lands in exactly one shard.
 */
export function shardFiles(files: string[], durations: Record<string, number | undefined>, index: number, total: number): string[] {
  const known = files.map((f) => durations[f]).filter((d): d is number => typeof d === "number").sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 1;
  const weight = (f: string): number => durations[f] ?? median;
  const order = [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const load: number[] = Array(total).fill(0);
  const out: string[] = [];
  for (const f of order) {
    let s = 0;
    for (let i = 1; i < total; i++) if (load[i]! < load[s]!) s = i;
    load[s] = load[s]! + weight(f);
    if (s === index - 1) out.push(f);
  }
  return out.sort();
}

/**
 * One table from several reporter outputs, keeping the higher time when two list a file. A test
 * defined outside a test file (a shared suite in src/) is reported under that file and left out.
 */
export function mergeDurations(objects: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of objects) {
    for (const [f, ms] of Object.entries(o)) if (f.endsWith(".test.ts")) out[f] = Math.max(out[f] ?? 0, Math.round(ms));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...paths] = process.argv.slice(2);
  if (cmd !== "merge" || paths.length === 0) {
    console.error("usage: node scripts/test-shards.ts merge <durations.json>...");
    process.exit(2);
  }
  const merged = mergeDurations(paths.map((p) => JSON.parse(readFileSync(p, "utf8"))));
  writeFileSync(DURATIONS, `${JSON.stringify(merged, null, 1)}\n`);
  console.log(`${Object.keys(merged).length} files written to scripts/test-durations.json`);
}
