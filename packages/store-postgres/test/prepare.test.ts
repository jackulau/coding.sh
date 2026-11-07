// Regression (QA J6): after `npm ci` + `npm run build -w coding.sh`, the CLI's
// `--store postgres://` failed with store_unavailable, because the workspace
// symlink pointed at a dist/ nobody had built. The package must build itself on
// `prepare`, and what that produces must load by name from the core package the
// way factory.ts does it (`import("coding.sh-store-postgres")`, no source condition).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"));

it("package.json builds dist on prepare, so npm ci leaves a loadable plugin", () => {
  assert.match(pkg.scripts?.prepare ?? "", /scripts\/build\.mjs/, "coding.sh-store-postgres needs a prepare script that builds dist/ (main points at it)");
  assert.match(pkg.scripts.prepare, /--soft/, "prepare must use --soft so a build problem never fails npm install");
});

it("the prepare build produces main and loads by name from coding.sh", () => {
  const [cmd, ...args] = pkg.scripts.prepare.split(/\s+/);
  assert.equal(cmd, "node");
  const r = spawnSync(process.execPath, args, { cwd: pkgDir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const target of [pkg.main, pkg.exports["."]]) {
    assert.ok(existsSync(resolve(pkgDir, target)), `${target} missing after prepare: ${r.stdout}${r.stderr}`);
  }
  // Resolve from the core package, as the CLI does; plain node, no --conditions=source.
  const corePkg = resolve(pkgDir, "../coding.sh");
  const probe = spawnSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", "const m = await import('coding.sh-store-postgres'); console.log(typeof m.indexStore, typeof m.blobStore);"],
    { cwd: corePkg, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), "function function");
});
