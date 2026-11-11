// Fake bins from test/_bin.ts run the same inside a "type": "module" package
// (a TMPDIR in a checkout of this repo) as in a bare temp dir: a bin that uses
// require and one that uses import both load.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { nodeBin } from "../_bin.ts";

const root = mkdtempSync(join(tmpdir(), "csh-fake-bin-"));
after(() => rmSync(root, { recursive: true, force: true }));

describe("nodeBin under a type: module package", () => {
  it("runs a CommonJS bin and an ES module bin", () => {
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    const bin = join(root, "pkg", "bin");
    mkdirSync(bin, { recursive: true });
    const cjs = nodeBin(bin, "cjs-tool", 'const { join } = require("node:path");\nprocess.stdout.write(join("a", "b"));\n');
    const esm = nodeBin(bin, "esm-tool", 'import { join } from "node:path";\nprocess.stdout.write(join("c", "d"));\n');
    for (const [p, want] of [[cjs, join("a", "b")], [esm, join("c", "d")]] as const) {
      const r = spawnSync(process.execPath, ["--no-warnings", p], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, want);
    }
  });
});
