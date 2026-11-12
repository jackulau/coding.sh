// Guard: this plugin tests against `coding.sh/store/conformance` (test/conformance.js).
// Check that it is this repo's coding.sh, not another install's: a registry copy in
// node_modules would test the plugin against a different suite.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Whether `got` (a path or file: URL) is `want` or inside it, after resolving
 * symlinks where the path exists. "/r/coding.sh-old" is not inside "/r/coding.sh".
 * @param {string} got
 * @param {string} want
 */
export function inTree(got, want) {
  // The nearest parent that exists is resolved, so a link to a tree whose dist/ is not built yet still counts.
  /** @param {string} p @returns {string} */
  const real = (p) => {
    const abs = resolve(p);
    if (existsSync(abs)) return realpathSync(abs);
    const up = dirname(abs);
    return up === abs ? abs : join(real(up), basename(abs));
  };
  const rel = relative(real(want), real(got.startsWith("file:") ? fileURLToPath(got) : got));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

it("inTree: inside, the tree itself, file: URLs; not a sibling with the same prefix or another install", () => {
  const tree = resolve("/r/packages/coding.sh");
  assert.equal(inTree(resolve("/r/packages/coding.sh/src/store/conformance.ts"), tree), true);
  assert.equal(inTree(tree, tree), true);
  assert.equal(inTree(pathToFileURL(resolve("/r/packages/coding.sh/dist/store-conformance.mjs")).href, tree), true);
  assert.equal(inTree(resolve("/r/x/../packages/coding.sh/src/a.ts"), tree), true);
  assert.equal(inTree(resolve("/r/packages/coding.sh-old/src/store/conformance.ts"), tree), false);
  assert.equal(inTree(resolve("/r/packages/blob-s3/node_modules/coding.sh/dist/store-conformance.mjs"), tree), false);
  assert.equal(inTree(resolve("/r/packages"), tree), false);
});

it("inTree follows a link to a tree whose dist/ is not built yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "intree-"));
  try {
    mkdirSync(join(dir, "coding.sh"));
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(join(dir, "coding.sh"), join(dir, "node_modules", "coding.sh"), "junction");
    assert.equal(inTree(join(dir, "node_modules", "coding.sh", "dist", "store.mjs"), join(dir, "coding.sh")), true);
    assert.equal(inTree(join(dir, "node_modules", "other", "dist", "store.mjs"), join(dir, "coding.sh")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("coding.sh/store resolves into this repo", () => {
  const tree = fileURLToPath(new URL("../../coding.sh/", import.meta.url));
  let got;
  try {
    got = import.meta.resolve("coding.sh/store/conformance");
  } catch {
    // Not installed or not exported: test/conformance.js falls back to this repo's source.
    got = new URL("../../coding.sh/src/store/conformance.ts", import.meta.url).href;
  }
  assert.ok(inTree(got, tree), `coding.sh/store/conformance resolves to ${got}, outside ${tree}. Link this repo's coding.sh (npm install ../coding.sh) before testing the plugin.`);
});
