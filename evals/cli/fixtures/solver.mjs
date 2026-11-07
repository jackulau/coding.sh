#!/usr/bin/env node
// Deterministic stand-in "agent" for fixture experiments: reads a case input
// like "17+25" on stdin and prints the sum. It answers wrong on a fixed,
// input-derived subset of cases so experiments have known pass rates.
//   --acc <0..1>   fraction of cases answered correctly (by input hash)
//   --fail <msg>   print msg on stderr and exit 1 (a broken run)
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const flag = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fail = flag("--fail");
if (fail) {
  process.stderr.write(fail + "\n");
  process.exit(1);
}
const acc = Number(flag("--acc") ?? "1");
let raw = "";
for await (const c of process.stdin) raw += c;
let input = raw.trim();
try {
  input = JSON.parse(input);
} catch {}
const [a, b] = String(input).split("+").map(Number);
const h = createHash("sha256").update(String(input)).digest().readUInt32BE(0) % 100;
process.stdout.write(String(h < Math.round(acc * 100) ? a + b : a + b + 1) + "\n");
