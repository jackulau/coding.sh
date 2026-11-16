import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
// bench.mjs times the built CLI. The gate and the Node 22 CI legs run the tests before any build.
const NO_DIST = !existsSync(join(ROOT, "packages", "coding.sh", "dist", "cli.mjs")) && "needs dist/cli.mjs: run npm run build in packages/coding.sh";

describe("dogfood and perf scripts run as the main module", () => {
  it("bench.mjs help --json prints results (fails on Windows with the file:// guard)", { skip: NO_DIST }, () => {
    const home = mkdtempSync(join(tmpdir(), "codingsh-main-"));
    try {
      const r = spawnSync(process.execPath, ["--no-warnings", join("scripts", "dogfood", "bench.mjs"), "help", "--json"], {
        cwd: ROOT,
        env: { ...process.env, CODING_SH_HOME: home },
        encoding: "utf8",
        timeout: 120_000,
      });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(typeof out.results.help["perf.help"], "number");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("no script still compares import.meta.url with file://${process.argv[1]}", () => {
    const guard = "file://${process.argv[1]}";
    const files = ["scripts/dogfood", "scripts/perf"].flatMap((d) =>
      readdirSync(join(ROOT, d)).filter((f) => f.endsWith(".mjs")).map((f) => join(ROOT, d, f)));
    assert.ok(files.length > 8);
    for (const f of files) assert.ok(!readFileSync(f, "utf8").includes(guard), `${f} has the file:// guard`);
  });
});
