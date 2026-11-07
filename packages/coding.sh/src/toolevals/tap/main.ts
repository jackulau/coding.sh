#!/usr/bin/env node
// Standalone tap entry (§12: `tap cli|mcp|http`, internal and hidden from help).
// Intended to become dist/tap.mjs; until the bundle has that entry it runs
// from source: `node src/toolevals/tap/main.ts mcp --log tap.jsonl -- node server.js`.
//
//   mcp  --log <tap.jsonl> [--variant <variant.json>] [--doc-tool <name>]... -- <server argv>
//        Runs the MCP tap on this process's stdio, spawning the real server.
//   cli  --log <tap.jsonl> --out <dir> --bin <name> [--usage-exit <n>]... -- <real argv>
//        Writes a CLI shim to <dir>/<bin>.
//   http --log <tap.jsonl> --base <url> [--openapi <file>]
//        Starts the HTTP tap and prints its URL on stdout.
import { readFileSync } from "node:fs";
import type { Variant } from "../types.ts";
import { DEFAULT_USAGE_PATTERNS, writeCliShim } from "./cli.ts";
import { openapiPaths, startHttpTap } from "./http-proxy.ts";
import { bridgeStdio, McpTap, tapWriter } from "./mcp-proxy.ts";

function parse(argv: string[]): { flags: Map<string, string[]>; rest: string[] } {
  const flags = new Map<string, string[]>();
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") return { flags, rest: argv.slice(i + 1) };
    if (a.startsWith("--")) {
      const v = argv[i + 1] ?? "";
      flags.set(a.slice(2), [...(flags.get(a.slice(2)) ?? []), v]);
      i++;
    }
  }
  return { flags, rest: [] };
}

export async function tapMain(argv: string[]): Promise<number> {
  const [mode, ...tail] = argv;
  const { flags, rest } = parse(tail);
  const one = (k: string) => flags.get(k)?.[0];
  const log = one("log");
  if (!log) {
    process.stderr.write("tap: --log <file> is required\n");
    return 2;
  }
  if (mode === "mcp") {
    if (!rest.length) {
      process.stderr.write("tap mcp: missing -- <server argv>\n");
      return 2;
    }
    const vf = one("variant");
    const variant = vf ? (JSON.parse(readFileSync(vf, "utf8")) as Variant) : { name: "base" };
    const record = tapWriter(log);
    const tap = new McpTap({ variant, docTools: flags.get("doc-tool"), record });
    await bridgeStdio(tap, { input: process.stdin, output: process.stdout }, { command: rest }, { record });
    return 0;
  }
  if (mode === "cli") {
    const out = one("out");
    const bin = one("bin");
    if (!out || !bin || !rest.length) {
      process.stderr.write("tap cli: --out <dir> --bin <name> -- <real argv> are required\n");
      return 2;
    }
    const p = await writeCliShim(out, bin, {
      command: rest,
      env: {},
      tapLog: log,
      usageExitCodes: (flags.get("usage-exit") ?? ["2"]).map(Number),
      usagePatterns: flags.get("usage-pattern") ?? DEFAULT_USAGE_PATTERNS,
    });
    process.stdout.write(p + "\n");
    return 0;
  }
  if (mode === "http") {
    const base = one("base");
    if (!base) {
      process.stderr.write("tap http: --base <url> is required\n");
      return 2;
    }
    const oa = one("openapi");
    const templates = oa ? openapiPaths(JSON.parse(readFileSync(oa, "utf8"))) : [];
    const h = await startHttpTap({ target: { kind: "http", name: "http", baseUrl: base }, variant: { name: "base" }, tapLog: log, templates });
    process.stdout.write(h.url + "\n");
    await new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()));
    await h.close();
    return 0;
  }
  process.stderr.write("usage: tap cli|mcp|http --log <file> …\n");
  return 2;
}

const entry = process.argv[1] ?? "";
if (/tap[\\/]main\.ts$|tap\.mjs$/.test(entry)) {
  tapMain(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`tap: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
