// Guard: this plugin builds against `coding.sh/store` and tests against
// `coding.sh/store/conformance`. If a package.json rewrite drops either export,
// fail here with a clear message instead of a confusing resolve error.
// Reads package.json only, so it runs even when the exports are missing. Then
// checks that coding.sh/store is this repo's, not another install's.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

it("coding.sh exports ./store and ./store/conformance for store plugins", () => {
  const pkgPath = createRequire(import.meta.url).resolve("coding.sh/package.json");
  const exports = JSON.parse(readFileSync(pkgPath, "utf8")).exports ?? {};
  for (const sub of ["./store", "./store/conformance"]) {
    assert.ok(exports[sub], `${pkgPath} is missing the "${sub}" export. Store plugins (coding.sh-store-postgres, coding.sh-store-s3) need it; see docs/PRODUCTION.md §3.1.`);
  }
});

/**
 * Whether `got` (a path or file: URL) is `want` or inside it, after resolving
 * symlinks where the path exists. "/r/coding.sh-old" is not inside "/r/coding.sh".
 */
export function inTree(got: string, want: string): boolean {
  // The nearest parent that exists is resolved, so a link to a tree whose dist/ is not built yet still counts.
  const real = (p: string): string => {
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
  assert.equal(inTree(resolve("/r/packages/coding.sh/src/store/plugin-api.ts"), tree), true);
  assert.equal(inTree(tree, tree), true);
  assert.equal(inTree(pathToFileURL(resolve("/r/packages/coding.sh/dist/store.mjs")).href, tree), true);
  assert.equal(inTree(resolve("/r/x/../packages/coding.sh/src/a.ts"), tree), true);
  assert.equal(inTree(resolve("/r/packages/coding.sh-old/src/store/plugin-api.ts"), tree), false);
  assert.equal(inTree(resolve("/r/packages/store-postgres/node_modules/coding.sh/dist/store.mjs"), tree), false);
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
  // A registry copy in this package's node_modules would test the plugin against another coding.sh.
  const tree = fileURLToPath(new URL("../../coding.sh/", import.meta.url));
  for (const spec of ["coding.sh/store", "coding.sh/store/conformance"]) {
    const got = import.meta.resolve(spec);
    assert.ok(inTree(got, tree), `${spec} resolves to ${got}, outside ${tree}. Link this repo's coding.sh (npm install ../coding.sh) before testing the plugin.`);
    // Linked but not built: the resolved file is this tree's dist/, which does not exist yet.
    const file = got.startsWith("file:") ? fileURLToPath(got) : got;
    assert.ok(existsSync(file), `${spec} resolves to ${file}, which is not built yet. Build coding.sh first: npm run build -w coding.sh`);
  }
});
