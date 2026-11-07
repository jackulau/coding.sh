// Shared fixtures for bench tests: a temp project with a seeded case
// generator and two command contenders (one right, one wrong on some cases).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDefinition } from "../../src/bench/define.ts";
import type { BenchDef } from "../../src/bench/types.ts";

const roots: string[] = [];

export function cleanup(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export interface Project {
  root: string;
  env: NodeJS.ProcessEnv;
  file: string;
  def(extra?: string): BenchDef;
  write(name: string, text: string): string;
}

// Prints 40 arithmetic cases; which numbers depends on the seed, so every day is new.
export const GEN = `import { createHash } from "node:crypto";
const seed = process.env.CODING_SH_BENCH_SEED ?? "x";
const h = (s) => parseInt(createHash("sha256").update(seed + s).digest("hex").slice(0, 8), 16);
const cats = ["add", "big", "neg"];
for (let i = 0; i < 40; i++) {
  const cat = cats[i % 3];
  let a = h("a" + i) % 100, b = h("b" + i) % 100;
  if (cat === "big") { a *= 1000; b *= 1000; }
  if (cat === "neg") a = -a;
  console.log(JSON.stringify({ input: { a, b }, expected: a + b, metadata: { category: cat } }));
}
`;

const read = `const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));`;
export const GOOD = `${read}\nprocess.stdout.write(JSON.stringify({ output: input.a + input.b, usage: { costUsd: 0.002, inputTokens: 30, outputTokens: 4 }, model: "good-1" }));\n`;
// Crashes on negative a below -50, is off by one on big numbers.
export const BAD = `${read}\nif (input.a < -50) { console.error("boom"); process.exit(3); }\nconst big = Math.abs(input.a) >= 1000;\nprocess.stdout.write(JSON.stringify({ output: input.a + input.b + (big ? 1 : 0), usage: { costUsd: 0.0005 } }));\n`;

export function project(toml?: string): Project {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-bench-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(root, "bench"), { recursive: true });
  mkdirSync(home, { recursive: true });
  const write = (name: string, text: string) => {
    const p = join(root, name);
    writeFileSync(p, text);
    return p;
  };
  write("gen.mjs", GEN);
  write("good.cjs", GOOD);
  write("bad.cjs", BAD);
  const file = join(root, "bench", "arith.toml");
  const base =
    toml ??
    `name = "arith"
cases = 12
concurrency = 3
[source]
kind = "command"
command = "node gen.mjs"
[[contenders]]
name = "good"
command = "node good.cjs"
[[contenders]]
name = "bad"
command = "node bad.cjs"
[[graders]]
kind = "exact"
`;
  writeFileSync(file, base);
  const env: NodeJS.ProcessEnv = { HOME: home, CODING_SH_HOME: join(home, ".coding.sh"), PATH: process.env.PATH, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_RETRY_BASE_MS: "0" };
  return {
    root,
    env,
    file,
    write,
    def(extra = "") {
      // Top-level keys go before the first table.
      const text = extra ? base.replace("[source]", `${extra}\n[source]`) : base;
      writeFileSync(file, text);
      return parseDefinition(text, file);
    },
  };
}

export const day = (d: string) => Date.parse(`${d}T06:15:00Z`);
