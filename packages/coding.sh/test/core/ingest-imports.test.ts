// What a read command loads before it reads: the spool ingest (core/ingest.ts), which runs when
// hooks left new lines (cli/common.ts autoIngest), and the reparse check (core/reparse.ts), which
// every read starts. Neither loads the OTLP receiver: the two names the ingest shares with it
// (InsertedEvents, traceKvKey) live in otel/ingest-shared.ts. An ESM import of node:http makes
// Node load its bundled HTTP client (undici) as well, which costs a read tens of milliseconds.
//
// The walk follows static imports, side-effect imports and re-exports of local files: what loads
// with a module. It does not follow import(), and type-only imports and re-exports are erased.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const LOADS = [
  /^import\s+(?!type\s)[^;]*?\sfrom\s+"([^"]+)"/gm, // import x from, import { x } from, import * as x from
  /^import\s+"([^"]+)"/gm, // import "./x.ts"
  /^export\s+(?!type\s)(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+"([^"]+)"/gm, // export { x } from, export * from
];

/** The local files (relative to the package, with /) and the built-ins that load with `entry`. */
function staticLoads(entry: string): { files: Set<string>; builtins: Set<string> } {
  const files = new Set<string>();
  const builtins = new Set<string>();
  const walk = (file: string): void => {
    const rel = relative(PKG_ROOT, file).replace(/\\/g, "/");
    if (files.has(rel)) return;
    files.add(rel);
    const src = readFileSync(file, "utf8");
    for (const re of LOADS)
      for (const m of src.matchAll(re)) {
        const spec = m[1]!;
        if (spec.startsWith(".")) walk(join(dirname(file), spec));
        else builtins.add(spec.replace(/^node:/, ""));
      }
  };
  walk(join(PKG_ROOT, entry));
  return { files, builtins };
}

for (const entry of ["src/core/ingest.ts", "src/core/reparse.ts"]) {
  test(`${entry} loads no part of the OTLP receiver and not node:http`, () => {
    const { files, builtins } = staticLoads(entry);
    // The walk reaches the ingest, the session fold and the shared module.
    for (const f of ["src/core/ingest.ts", "src/core/sessions.ts", "src/otel/ingest-shared.ts"]) assert.ok(files.has(f), `${f} not reached: ${[...files].join(", ")}`);
    for (const f of ["src/otel/receiver.ts", "src/otel/map.ts", "src/otel/proto.ts"]) assert.ok(!files.has(f), `${entry} loads ${f}`);
    for (const b of ["http", "https", "http2"]) assert.ok(!builtins.has(b), `${entry} loads node:${b} (${[...builtins].join(", ")})`);
  });
}

test("the receiver and the span mapping still export the names the ingest shares", async () => {
  const at = (f: string) => import(pathToFileURL(join(PKG_ROOT, f)).href);
  const shared = await at("src/otel/ingest-shared.ts");
  assert.equal((await at("src/otel/receiver.ts")).InsertedEvents, shared.InsertedEvents);
  assert.equal((await at("src/otel/map.ts")).traceKvKey, shared.traceKvKey);
  assert.equal(shared.traceKvKey("abc"), "otel-trace:abc");
});
