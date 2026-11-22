// changedPaths must see a same-size edit made in the same second as the
// checkout. Copying the work tree's index with a fresh mtime made git trust
// the cached stat and miss it, so an honest fix was graded against the start
// tree (seen first with a fast agent under `compare --sequential --otel`).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { EvalTask } from "../../src/core/types.ts";
import { changedPaths, withIsolatedTree } from "../../src/runner/isolate.ts";
import { START_REF } from "../../src/runner/git.ts";

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(tmpdir(), "csh-isolate-no-gitconfig") } });
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
        await rm(dir, { recursive: true, force: true, maxRetries: 5 });
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
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

// On Windows a folder can't be renamed while a process has its current directory in it. An ingest
// started by another trial (`eval run --concurrency 2`) runs git in this trial's work folder to read
// its session's repo, so the swap below hit EBUSY and a trial the agent got right counted as failed.
describe("withIsolatedTree", () => {
  it("waits for a process that briefly holds the work folder", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-iso-busy-")));
    const work = join(root, "work");
    let holder: ReturnType<typeof spawn> | undefined;
    try {
      mkdirSync(work);
      git(work, "init", "-q");
      writeFileSync(join(work, "sum.js"), "module.exports = (a, b) => a - b;\n");
      git(work, "add", "-A");
      git(work, "commit", "-qm", "start");
      git(work, "update-ref", START_REF, "HEAD");
      cpSync(work, join(root, "start"), { recursive: true });
      writeFileSync(join(work, "sum.js"), "module.exports = (a, b) => a + b;\n");
      // A child whose current directory is the work folder, for 700 ms.
      const child = spawn(process.execPath, ["-e", "process.stdout.write('up'); setTimeout(() => {}, 700)"], { cwd: work, stdio: ["ignore", "pipe", "ignore"] });
      holder = child;
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", () => resolve());
        child.once("error", reject);
      });
      const task: EvalTask = { id: "busy", name: "busy", status: "draft", start: { repoRoot: work, snapshot: "", head: "" }, instruction: "", setup: [], verifier: { command: "node -e 0", hiddenFiles: {}, timeoutMs: 30_000 }, tags: [], createdAt: 0 };
      const dirs = { work, start: join(root, "start"), aside: join(root, "agent-tree"), verified: join(root, "verified") };
      const seen = await withIsolatedTree(dirs, { task, reuseStart: false, keepVerified: false }, async () => readFileSync(join(work, "sum.js"), "utf8"));
      assert.equal(seen, "module.exports = (a, b) => a + b;\n", "the verifier sees the agent's change");
      assert.equal(readFileSync(join(work, "sum.js"), "utf8"), "module.exports = (a, b) => a + b;\n", "the agent's tree is back in place");
    } finally {
      holder?.kill();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
