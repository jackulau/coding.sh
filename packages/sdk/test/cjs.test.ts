// The built package loads with require() (a CommonJS app on Node 22+), including where the
// runtime has no global WebCrypto: the module has no top-level await, so require(esm) works.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let out = "";
before(() => {
  out = mkdtempSync(join(tmpdir(), "csh-sdk-cjs-"));
  const tsc = createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json"), "--outDir", join(out, "dist")], { encoding: "utf8", cwd: root });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  writeFileSync(join(out, "dist", "package.json"), '{"type":"module"}');
});
after(() => rmSync(out, { recursive: true, force: true }));

const loadWith = (prelude: string) =>
  spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "-e",
      `${prelude}
      const sdk = require(${JSON.stringify(join(out, "dist", "index.js"))});
      setTimeout(() => {
        const id = sdk.trace("t", (t) => t.traceId);
        process.stdout.write(JSON.stringify({ trace: typeof sdk.trace, id }));
      }, 50);`,
    ],
    { encoding: "utf8", env: { PATH: dirname(process.execPath), CODING_SH_DISABLED: "1" }, timeout: 30_000 },
  );

test("require() of the built package loads and exposes trace", () => {
  const r = loadWith("");
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.trace, "function");
  assert.match(doc.id, /^[0-9a-f]{32}$/);
});

test("it also loads without a global crypto", () => {
  const r = loadWith(`Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).id, /^[0-9a-f]{32}$/);
});

test("it also loads with neither a global crypto nor process.getBuiltinModule", () => {
  const r = loadWith(`Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true }); process.getBuiltinModule = undefined;`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).id, /^[0-9a-f]{32}$/);
});
