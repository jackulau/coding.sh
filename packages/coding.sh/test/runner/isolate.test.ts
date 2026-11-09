// changedPaths must see a same-size edit made in the same second as the
// checkout. Copying the work tree's index with a fresh mtime made git trust
// the cached stat and miss it, so an honest fix was graded against the start
// tree (seen first with a fast agent under `compare --sequential --otel`).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { changedPaths } from "../../src/runner/isolate.ts";
import { START_REF } from "../../src/runner/git.ts";

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull } });
  assert.equal(r.status, 0, `${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

describe("changedPaths", () => {
  it("sees a same-size edit made right after the checkout (racy git)", async () => {
    for (let i = 0; i < 2; i++) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "csh-racy-")));
      try {
        git(dir, "init", "-q");
        writeFileSync(join(dir, "sum.js"), "module.exports = (a, b) => a - b;\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", "start");
        git(dir, "update-ref", START_REF, "HEAD");
        // Same size, same second: only the content differs.
        writeFileSync(join(dir, "sum.js"), "module.exports = (a, b) => a + b;\n");
        // The grade comes a second later: an index copied then with a fresh mtime would make git trust the stale stat.
        const sec = Math.floor(statSync(join(dir, ".git", "index")).mtimeMs / 1000);
        while (Math.floor(Date.now() / 1000) <= sec) await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(await changedPaths(dir), [{ path: "sum.js", kind: "modify" }], `round ${i}`);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  });

  it("lists adds and deletes", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "csh-racy-")));
    try {
      git(dir, "init", "-q");
      writeFileSync(join(dir, "a.txt"), "a\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "start");
      git(dir, "update-ref", START_REF, "HEAD");
      rmSync(join(dir, "a.txt"));
      writeFileSync(join(dir, "b.txt"), "b\n");
      assert.deepEqual(
        (await changedPaths(dir)).sort((x, y) => x.path.localeCompare(y.path)),
        [
          { path: "a.txt", kind: "delete" },
          { path: "b.txt", kind: "add" },
        ],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
