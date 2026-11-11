import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP, postpack, prepack, restoreManifest } from "../../scripts/pack-manifest.mjs";

const PKG = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const REQUIRE_DIST = ["1", "true", "yes"].includes(String(process.env.CODING_SH_REQUIRE_DIST ?? "").toLowerCase());
const BUILT = existsSync(join(PKG, "dist", "schema.mjs"));
const SOURCE_ENTRIES = ["./store", "./store/conformance", "./eve", "./server", "./judge"];

/** Every file an exports map points at, under every condition. */
function targets(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (node && typeof node === "object") return Object.values(node).flatMap(targets);
  return [];
}

/** A copy of the package to pack, so a pack never rewrites the working package.json other tests read. */
function stage(dir: string): string {
  const pkg = join(dir, "pkg");
  mkdirSync(join(pkg, "scripts"), { recursive: true });
  for (const f of ["package.json", "README.md", "LICENSE", "scripts/pack-manifest.mjs"]) cpSync(join(PKG, f), join(pkg, f));
  cpSync(join(PKG, "dist"), join(pkg, "dist"), { recursive: true });
  return pkg;
}

function pack(cwd: string, dir: string, args: string[]) {
  // The pack runs prepack and postpack, so it needs its own home and cache.
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, CODING_SH_HOME: join(dir, ".coding.sh"), npm_config_cache: join(dir, "cache") };
  return spawnSync("npm", ["pack", ...args], { cwd, encoding: "utf8", env, shell: process.platform === "win32" });
}

it("the working package.json keeps its source conditions for development", () => {
  const exportsMap = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).exports;
  for (const sub of SOURCE_ENTRIES) {
    assert.match(String(exportsMap[sub]?.source), /^\.\/src\/.+\.ts$/, `${sub} has a source condition`);
    assert.ok(existsSync(join(PKG, exportsMap[sub].source)), `${sub}'s source file exists`);
  }
  assert.ok(!existsSync(join(PKG, BACKUP)), `no ${BACKUP} is left from a pack`);
});

it("prepack and postpack keep the manifest when dist is deleted in between, and refuse to lose it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-manifest-unit-"));
  try {
    const original = readFileSync(join(PKG, "package.json"), "utf8");
    const manifest = join(dir, "package.json");
    writeFileSync(manifest, original);
    // prepack, the build wipes dist, postpack: the backup lives outside dist.
    prepack(dir);
    assert.ok(!/"source"/.test(readFileSync(manifest, "utf8")), "prepack drops the source conditions");
    rmSync(join(dir, "dist"), { recursive: true, force: true });
    postpack(dir);
    assert.equal(readFileSync(manifest, "utf8"), original);
    // A second postpack has no backup: it fails instead of passing silently.
    assert.throws(() => postpack(dir), /is missing/);
    // Two packs that overlap: the second prepack fails and the backup stays the original.
    prepack(dir);
    assert.throws(() => prepack(dir), /already exists/);
    postpack(dir);
    assert.equal(readFileSync(manifest, "utf8"), original);
    // A pack that stopped before postpack: the next build puts the manifest back.
    prepack(dir);
    assert.equal(restoreManifest(dir), true);
    assert.equal(readFileSync(manifest, "utf8"), original);
    assert.equal(restoreManifest(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the packed package names no export target the tarball lacks", { skip: !BUILT && !REQUIRE_DIST && "dist is not built" }, () => {
  assert.ok(BUILT, "dist is not built: npm run build");
  const dir = mkdtempSync(join(tmpdir(), "pack-exports-"));
  try {
    const pkg = stage(dir);
    const before = readFileSync(join(pkg, "package.json"), "utf8");
    const r = pack(pkg, dir, ["--json", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(pkg, "package.json"), "utf8"), before, "postpack restores package.json");
    assert.ok(!existsSync(join(pkg, BACKUP)), "postpack removes its backup");
    const packed = new Set((JSON.parse(r.stdout)[0].files as { path: string }[]).map((f) => f.path));
    const missing = targets(JSON.parse(before).exports)
      .map((t) => t.replace(/^\.\//, ""))
      .filter((t) => !packed.has(t));
    // The "source" conditions point into src/, which is not published: prepack drops them.
    assert.deepEqual(missing.filter((t) => !t.startsWith("src/")), [], "export targets missing from the tarball");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the packed package.json drops the source conditions", { skip: !BUILT && !REQUIRE_DIST && "dist is not built" }, () => {
  assert.ok(BUILT, "dist is not built: npm run build");
  const dir = mkdtempSync(join(tmpdir(), "pack-manifest-"));
  try {
    const pkg = stage(dir);
    const r = pack(pkg, dir, ["--silent", "--pack-destination", dir]);
    assert.equal(r.status, 0, r.stderr);
    const tgz = r.stdout.trim().split("\n").pop()!;
    const t = spawnSync("tar", ["-xzOf", join(dir, tgz), "package/package.json"], { encoding: "utf8" });
    assert.equal(t.status, 0, t.stderr);
    const exportsMap = JSON.parse(t.stdout).exports;
    assert.ok(!/"source"/.test(JSON.stringify(exportsMap)), "no source condition in the published exports");
    assert.ok(exportsMap["./store"].default, "the other conditions stay");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
