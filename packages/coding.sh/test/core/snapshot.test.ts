import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { diffSnapshots, diffWorkdir, ensureShadow, materialize, shadowRepoPath, snapshot } from "../../src/core/snapshot.ts";
import { branch, head, isRepo, repoRoot, run } from "../../src/core/git.ts";
import { gitDirFingerprint, gitc, isolate, makeRepo, removeTmp, tmp, treeHash, write } from "../capture/_helpers.ts";

before(() => isolate());
after(() => removeTmp());

const shadowGit = (root: string, ...args: string[]) => gitc(root, "--git-dir", shadowRepoPath(root), ...args);

function dirtyRepo(): string {
  const root = makeRepo({
    "a.txt": "a1\n",
    "b.txt": "b1\n",
    "c.txt": "c1\n",
    ".gitignore": "*.log\nbuild/\n",
    "src/deep/x.ts": "export {};\n",
  });
  write(root, { "a.txt": "a2 unstaged\n", "b.txt": "b2 staged\n", "new.txt": "untracked\n", "x.log": "ignored\n", "build/out.js": "ignored\n" });
  gitc(root, "add", "b.txt");
  unlinkSync(join(root, "c.txt"));
  return root;
}

describe("git helpers", () => {
  test("repoRoot / isRepo / head / branch", async () => {
    const root = makeRepo({ "f.txt": "x" });
    mkdirSync(join(root, "sub"));
    assert.equal(await repoRoot(join(root, "sub")), root);
    assert.equal(await isRepo(root), true);
    assert.equal(await isRepo(tmp()), false);
    assert.equal(await repoRoot("/definitely/not/here"), undefined);
    assert.match(await head(root), /^[0-9a-f]{40}$/);
    assert.equal(await branch(root), "main");
    const unborn = makeRepo();
    assert.equal(await head(unborn), "");
    assert.equal(await branch(unborn), "main");
  });

  test("run reports useful errors and times out", async () => {
    const root = makeRepo({ "f.txt": "x" });
    await assert.rejects(run(["rev-parse", "nope^{commit}"], { cwd: root }), /git rev-parse nope\^\{commit\} failed with exit 128/);
    const r = await run(["rev-parse", "nope"], { cwd: root, allowFail: true });
    assert.notEqual(r.code, 0);
    await assert.rejects(run(["-c", "alias.slow=!sleep 5", "slow"], { cwd: root, timeoutMs: 200 }), /timed out after 200 ms/);
  });

  test("strips inherited GIT_DIR so helpers never hit the wrong repo", async () => {
    const a = makeRepo({ "f": "1" });
    const b = makeRepo({ "g": "2" });
    process.env.GIT_DIR = join(b, ".git");
    try {
      assert.equal(await repoRoot(a), a);
    } finally {
      delete process.env.GIT_DIR;
    }
  });
});

describe("snapshot", () => {
  test("captures staged, unstaged, deleted and untracked; excludes ignored", async () => {
    const root = dirtyRepo();
    const s = await snapshot(root);
    assert.ok(s?.snapshot);
    assert.equal(s.root, root);
    assert.equal(s.head, gitc(root, "rev-parse", "HEAD"));
    assert.equal(s.branch, "main");
    assert.equal(s.partial, false);
    const files = shadowGit(root, "ls-tree", "-r", "--name-only", s.snapshot).split("\n").sort();
    assert.deepEqual(files, [".gitignore", "a.txt", "b.txt", "new.txt", "src/deep/x.ts"]);
    assert.equal(shadowGit(root, "show", `${s.snapshot}:a.txt`), "a2 unstaged");
    assert.equal(shadowGit(root, "show", `${s.snapshot}:b.txt`), "b2 staged");
    assert.equal(shadowGit(root, "show", `${s.snapshot}:new.txt`), "untracked");
    assert.equal(shadowGit(root, "rev-parse", `${s.snapshot}^`), s.head);
    assert.equal(shadowGit(root, "rev-parse", `refs/snapshots/${s.snapshot}`), s.snapshot);
  });

  test("never touches the user's refs, index, stash, config or objects", async () => {
    const root = dirtyRepo();
    write(root, { "stashme.txt": "s" });
    gitc(root, "add", "stashme.txt");
    gitc(root, "stash", "push", "-q", "-m", "keep");
    write(root, { "a.txt": "a3\n", "more.txt": "m\n" });
    gitc(root, "add", "a.txt");
    const fp = () => ({
      git: gitDirFingerprint(join(root, ".git")),
      refs: gitc(root, "for-each-ref"),
      stash: gitc(root, "stash", "list"),
      status: gitc(root, "--no-optional-locks", "status", "--porcelain=v2", "--untracked-files=all"),
    });
    const before1 = fp();
    const s1 = await snapshot(root);
    const s2 = await snapshot(join(root, "src"));
    assert.ok(s1?.snapshot && s2?.snapshot);
    assert.deepEqual(fp(), before1);
  });

  test("unborn repo (no commits)", async () => {
    const root = makeRepo();
    write(root, { "hello.txt": "hi\n", "dir/a": "a" });
    gitc(root, "add", "dir/a");
    const s = await snapshot(root);
    assert.ok(s?.snapshot);
    assert.equal(s.head, "");
    assert.equal(s.branch, "main");
    assert.equal(shadowGit(root, "rev-list", "--count", s.snapshot), "1");
    assert.deepEqual(shadowGit(root, "ls-tree", "-r", "--name-only", s.snapshot).split("\n").sort(), ["dir/a", "hello.txt"]);
    const empty = makeRepo();
    const e = await snapshot(empty);
    assert.ok(e?.snapshot);
    assert.equal(shadowGit(empty, "ls-tree", "-r", e.snapshot), "");
  });

  test("nested cwd resolves to the repo root; non-repos return undefined", async () => {
    const root = dirtyRepo();
    const s = await snapshot(join(root, "src", "deep"));
    assert.equal(s?.root, root);
    assert.equal(shadowGit(root, "show", `${s?.snapshot}:new.txt`), "untracked");
    assert.equal(await snapshot(tmp()), undefined);
    assert.equal(await snapshot("/no/such/dir"), undefined);
  });

  test("partial fallback when over maxFiles: tracked changes only", async () => {
    const root = dirtyRepo();
    const s = await snapshot(root, { maxFiles: 3 });
    assert.ok(s?.snapshot);
    assert.equal(s.partial, true);
    const files = shadowGit(root, "ls-tree", "-r", "--name-only", s.snapshot).split("\n").sort();
    assert.deepEqual(files, [".gitignore", "a.txt", "b.txt", "src/deep/x.ts"]);
    assert.equal(shadowGit(root, "show", `${s.snapshot}:a.txt`), "a2 unstaged");
    // untracked count alone crossing the limit also triggers partial
    const s2 = await snapshot(root, { maxFiles: 5 });
    assert.equal(s2?.partial, true);
    const s3 = await snapshot(root, { maxFiles: 6 });
    assert.equal(s3?.partial, false);
  });

  test("linked worktree uses the common object store", async () => {
    const root = makeRepo({ "f.txt": "1\n" });
    const wt = join(tmp(), "wt");
    gitc(root, "worktree", "add", "-q", "-b", "feature", wt);
    write(wt, { "f.txt": "2\n", "u.txt": "u\n" });
    const s = await snapshot(wt);
    assert.ok(s?.snapshot);
    assert.equal(s.branch, "feature");
    const alt = readFileSync(join(shadowRepoPath(s.root), "objects", "info", "alternates"), "utf8").trim();
    assert.equal(alt, join(root, ".git", "objects"));
    assert.equal(gitc(s.root, "--git-dir", shadowRepoPath(s.root), "show", `${s.snapshot}:f.txt`), "2");
  });

  test("ensureShadow is idempotent and concurrent snapshots are safe", async () => {
    const root = dirtyRepo();
    const a = await ensureShadow(root);
    const b = await ensureShadow(root);
    assert.equal(a, b);
    assert.ok(existsSync(join(a, "HEAD")));
    const all = await Promise.all([snapshot(root), snapshot(root), snapshot(root)]);
    const shas = new Set(all.map((s) => s?.snapshot));
    assert.equal(all.every((s) => s?.snapshot), true);
    // same tree; commit shas may differ only by timestamp
    const trees = new Set(all.map((s) => shadowGit(root, "rev-parse", `${s?.snapshot}^{tree}`)));
    assert.equal(trees.size, 1);
    assert.ok(shas.size >= 1);
  });
});

describe("materialize / diff", () => {
  test("round-trip: materialized dir equals the snapshotted worktree (minus ignored)", async () => {
    const root = dirtyRepo();
    write(root, { "bin/run.sh": "#!/bin/sh\necho hi\n" });
    chmodSync(join(root, "bin/run.sh"), 0o755);
    symlinkSync("a.txt", join(root, "link-to-a"));
    const s = await snapshot(root);
    assert.ok(s);
    const dest = join(tmp(), "task");
    const m = await materialize(s, dest);
    const ignored = (rel: string) => rel.endsWith(".log") || rel === "build" || rel.startsWith("build/");
    assert.deepEqual(treeHash(m.dir), treeHash(root, ignored));
    assert.equal(gitc(m.dir, "status", "--porcelain"), "");
    assert.equal(gitc(m.dir, "rev-list", "--count", "HEAD"), "1");
    assert.equal(gitc(m.dir, "log", "-1", "--format=%s"), "coding.sh task start");
    assert.equal(gitc(m.dir, "rev-parse", "refs/coding.sh/start"), m.startCommit);
    // no alternates: the task repo cannot reach the user's history
    assert.equal(existsSync(join(m.dir, ".git", "objects", "info", "alternates")), false);
    await assert.rejects(materialize(s, dest), /not empty/);
  });

  test("materialize from head when there is no snapshot", async () => {
    const root = makeRepo({ "only.txt": "committed\n" });
    write(root, { "only.txt": "dirty\n" });
    const m = await materialize({ root, head: gitc(root, "rev-parse", "HEAD") }, join(tmp(), "d"));
    assert.equal(readFileSync(join(m.dir, "only.txt"), "utf8"), "committed\n");
  });

  test("diffSnapshots: statuses, numstat and an applicable patch", async () => {
    const root = makeRepo({ "keep.txt": "same\n", "mod.txt": "1\n2\n3\n", "gone.txt": "bye\n", "img.bin": "\x00\x01\x02" });
    const s1 = await snapshot(root);
    write(root, { "mod.txt": "1\nTWO\n3\n4\n", "added.txt": "new\nfile\n", "img.bin": "\x00\x09\x02\x03" });
    unlinkSync(join(root, "gone.txt"));
    const s2 = await snapshot(root);
    assert.ok(s1?.snapshot && s2?.snapshot);
    const d = await diffSnapshots(root, s1.snapshot, s2.snapshot);
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ["added.txt", "gone.txt", "img.bin", "mod.txt"]);
    assert.deepEqual(byPath["mod.txt"], { path: "mod.txt", status: "modify", additions: 2, deletions: 1 });
    assert.deepEqual(byPath["added.txt"], { path: "added.txt", status: "add", additions: 2, deletions: 0 });
    assert.deepEqual(byPath["gone.txt"], { path: "gone.txt", status: "delete", additions: 0, deletions: 1 });
    assert.equal(byPath["img.bin"]?.binary, true);
    // applying the patch to a materialized s1 yields s2
    const m1 = await materialize(s1, join(tmp(), "m1"));
    const m2 = await materialize(s2, join(tmp(), "m2"));
    const pf = join(tmp(), "patch.diff");
    writeFileSync(pf, d.patch);
    gitc(m1.dir, "apply", "--binary", pf);
    assert.deepEqual(treeHash(m1.dir), treeHash(m2.dir));
    // unborn side diffs against the empty tree
    const d0 = await diffSnapshots(root, "", s1.snapshot);
    assert.equal(d0.files.every((f) => f.status === "add"), true);
    assert.equal(d0.files.length, 4);
  });

  test("diffWorkdir: tracked + untracked vs start, ignores ignored, survives agent commits", async () => {
    const root = makeRepo({ "a.txt": "a\n", "b.txt": "b\n", ".gitignore": "node_modules/\n" });
    const s = await snapshot(root);
    assert.ok(s);
    const m = await materialize(s, join(tmp(), "w"));
    assert.deepEqual((await diffWorkdir(m.dir)).files, []);
    write(m.dir, { "a.txt": "a\nmore\n", "new/file.ts": "x\n", "node_modules/pkg/index.js": "junk" });
    rmSync(join(m.dir, "b.txt"));
    gitc(m.dir, "add", "a.txt");
    gitc(m.dir, "commit", "-q", "-m", "agent commit");
    const indexBefore = readFileSync(join(m.dir, ".git", "index"));
    const d = await diffWorkdir(m.dir);
    assert.deepEqual(
      d.files.map((f) => `${f.status} ${f.path} +${f.additions} -${f.deletions}`).sort(),
      ["add new/file.ts +1 -0", "delete b.txt +0 -1", "modify a.txt +1 -0"],
    );
    assert.match(d.patch, /\+more/);
    assert.deepEqual(readFileSync(join(m.dir, ".git", "index")), indexBefore);
  });
});

describe("performance", () => {
  test("5k-file repo snapshot < 2 s", { timeout: 120_000 }, async () => {
    const root = makeRepo();
    for (let d = 0; d < 50; d++) {
      mkdirSync(join(root, `dir${d}`));
      for (let f = 0; f < 100; f++) writeFileSync(join(root, `dir${d}`, `f${f}.txt`), `file ${d}/${f}\n`.repeat(20));
    }
    gitc(root, "add", "-A");
    gitc(root, "commit", "-q", "-m", "5k");
    write(root, { "dir0/f0.txt": "changed\n", "untracked.txt": "u\n" });
    let t = performance.now();
    const cold = await snapshot(root);
    const coldMs = performance.now() - t;
    t = performance.now();
    const warm = await snapshot(root);
    const warmMs = performance.now() - t;
    console.log(`# snapshot 5k files: first ${coldMs.toFixed(0)} ms, second ${warmMs.toFixed(0)} ms`);
    assert.equal(cold?.partial, false);
    assert.ok(warm?.snapshot);
    assert.ok(coldMs < 2000, `first snapshot took ${coldMs} ms`);
    assert.ok(warmMs < 2000, `second snapshot took ${warmMs} ms`);
    // fresh clone without a warm index (stat cache empty) still within budget
    const m = await materialize(cold!, join(tmp(), "big"));
    rmSync(join(m.dir, ".git", "index"));
    t = performance.now();
    const noIndex = await snapshot(m.dir);
    const noIndexMs = performance.now() - t;
    console.log(`# snapshot 5k files without index: ${noIndexMs.toFixed(0)} ms`);
    assert.equal(noIndex?.partial, false);
    assert.ok(noIndexMs < 2000, `no-index snapshot took ${noIndexMs} ms`);
  });
});
