import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, chmodSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { diffSnapshots, diffWorkdir, ensureShadow, materialize, shadowRepoPath, snapshot } from "../../src/core/snapshot.ts";
import { branch, head, isRepo, layout, repoRoot, run } from "../../src/core/git.ts";
import { gitDirFingerprint, gitc, isolate, makeRepo, removeTmp, tmp, treeHash, write } from "../capture/_helpers.ts";
import { median, timeMs } from "../helpers-timing.ts";

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

  // A default Windows TEMP can use an 8.3 short name (C:\Users\RUNNER~1); git prints long names.
  test("repoRoot and layout keep the caller's spelling of the root (8.3 short names)", { skip: process.platform !== "win32" && "8.3 short names exist only on Windows" }, async (t) => {
    const root = makeRepo({ "f.txt": "x" });
    const long = join(root, "a long directory name");
    mkdirSync(join(long, "sub"), { recursive: true });
    gitc(long, "init", "-q");
    const out = spawnSync("cmd.exe", ["/d", "/s", "/c", `for %I in ("${long}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true });
    const short = out.stdout.trim();
    if (!short || short.toLowerCase() === long.toLowerCase()) return t.skip("8.3 names are off on this volume");
    assert.equal(await repoRoot(join(short, "sub")), short);
    assert.equal((await layout(join(short, "sub")))?.root, short);
    assert.equal(await repoRoot(join(long, "sub")), long);
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

// A snapshot that runs past its time budget (2 s by default) falls back to tracked files only
// (partial). A loaded Windows runner can take that long even for these small repos, so the
// tests of what a snapshot holds give it a budget it never runs out of. The default budget is
// tested in "performance (5k files)" below, against plain git on the same machine.
const ROOMY = { timeoutMs: 120_000 };

describe("snapshot", () => {
  test("captures staged, unstaged, deleted and untracked; excludes ignored", async () => {
    const root = dirtyRepo();
    const s = await snapshot(root, ROOMY);
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
    const s1 = await snapshot(root, ROOMY);
    const s2 = await snapshot(join(root, "src"), ROOMY);
    assert.ok(s1?.snapshot && s2?.snapshot);
    assert.deepEqual(fp(), before1);
  });

  test("unborn repo (no commits)", async () => {
    const root = makeRepo();
    write(root, { "hello.txt": "hi\n", "dir/a": "a" });
    gitc(root, "add", "dir/a");
    const s = await snapshot(root, ROOMY);
    assert.ok(s?.snapshot);
    assert.equal(s.head, "");
    assert.equal(s.branch, "main");
    assert.equal(shadowGit(root, "rev-list", "--count", s.snapshot), "1");
    assert.deepEqual(shadowGit(root, "ls-tree", "-r", "--name-only", s.snapshot).split("\n").sort(), ["dir/a", "hello.txt"]);
    const empty = makeRepo();
    const e = await snapshot(empty, ROOMY);
    assert.ok(e?.snapshot);
    assert.equal(shadowGit(empty, "ls-tree", "-r", e.snapshot), "");
  });

  test("nested cwd resolves to the repo root; non-repos return undefined", async () => {
    const root = dirtyRepo();
    const s = await snapshot(join(root, "src", "deep"), ROOMY);
    assert.equal(s?.root, root);
    assert.equal(shadowGit(root, "show", `${s?.snapshot}:new.txt`), "untracked");
    assert.equal(await snapshot(tmp()), undefined);
    assert.equal(await snapshot("/no/such/dir"), undefined);
  });

  test("partial fallback when over maxFiles: tracked changes only", async () => {
    const root = dirtyRepo();
    const s = await snapshot(root, { ...ROOMY, maxFiles: 3 });
    assert.ok(s?.snapshot);
    assert.equal(s.partial, true);
    const files = shadowGit(root, "ls-tree", "-r", "--name-only", s.snapshot).split("\n").sort();
    assert.deepEqual(files, [".gitignore", "a.txt", "b.txt", "src/deep/x.ts"]);
    assert.equal(shadowGit(root, "show", `${s.snapshot}:a.txt`), "a2 unstaged");
    // untracked count alone crossing the limit also triggers partial
    const s2 = await snapshot(root, { ...ROOMY, maxFiles: 5 });
    assert.equal(s2?.partial, true);
    const s3 = await snapshot(root, { ...ROOMY, maxFiles: 6 });
    assert.equal(s3?.partial, false);
  });

  test("linked worktree uses the common object store", async () => {
    const root = makeRepo({ "f.txt": "1\n" });
    const wt = join(tmp(), "wt");
    gitc(root, "worktree", "add", "-q", "-b", "feature", wt);
    write(wt, { "f.txt": "2\n", "u.txt": "u\n" });
    const s = await snapshot(wt, ROOMY);
    assert.ok(s?.snapshot);
    assert.equal(s.branch, "feature");
    const alt = readFileSync(join(shadowRepoPath(s.root), "objects", "info", "alternates"), "utf8").trim();
    // Same directory; on Windows git may spell it with long names where tmp() has 8.3 ones.
    assert.equal(realpathSync.native(alt), realpathSync.native(join(root, ".git", "objects")));
    assert.equal(gitc(s.root, "--git-dir", shadowRepoPath(s.root), "show", `${s.snapshot}:f.txt`), "2");
  });

  test("ensureShadow is idempotent and concurrent snapshots are safe", async () => {
    const root = dirtyRepo();
    const a = await ensureShadow(root);
    const b = await ensureShadow(root);
    assert.equal(a, b);
    assert.ok(existsSync(join(a, "HEAD")));
    const all = await Promise.all([snapshot(root, ROOMY), snapshot(root, ROOMY), snapshot(root, ROOMY)]);
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
    // Git for Windows checks symlinks out as plain files (core.symlinks=false), so only POSIX round-trips one.
    if (process.platform !== "win32") symlinkSync("a.txt", join(root, "link-to-a"));
    const s = await snapshot(root, ROOMY);
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

  test("materializes one repo's commit into several dirs at once, before its shadow repo exists", async () => {
    const root = makeRepo({ "only.txt": "committed\n" });
    const sha = gitc(root, "rev-parse", "HEAD");
    assert.equal(existsSync(shadowRepoPath(root)), false);
    const ms = await Promise.all(Array.from({ length: 12 }, (_, i) => i).map((i) => materialize({ root, head: sha, snapshot: sha }, join(tmp(), `par-${i}`))));
    for (const m of ms) assert.equal(readFileSync(join(m.dir, "only.txt"), "utf8"), "committed\n");
  });

  test("materialize from head when there is no snapshot", async () => {
    const root = makeRepo({ "only.txt": "committed\n" });
    write(root, { "only.txt": "dirty\n" });
    const m = await materialize({ root, head: gitc(root, "rev-parse", "HEAD") }, join(tmp(), "d"));
    assert.equal(readFileSync(join(m.dir, "only.txt"), "utf8"), "committed\n");
  });

  test("diffSnapshots: statuses, numstat and an applicable patch", async () => {
    const root = makeRepo({ "keep.txt": "same\n", "mod.txt": "1\n2\n3\n", "gone.txt": "bye\n", "img.bin": "\x00\x01\x02" });
    const s1 = await snapshot(root, ROOMY);
    write(root, { "mod.txt": "1\nTWO\n3\n4\n", "added.txt": "new\nfile\n", "img.bin": "\x00\x09\x02\x03" });
    unlinkSync(join(root, "gone.txt"));
    const s2 = await snapshot(root, ROOMY);
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
    const s = await snapshot(root, ROOMY);
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

describe("performance (5k files)", () => {
  // Each budget is 2 s, or 3x what plain git takes at the same moment, on the same
  // machine, to hash the whole tree into a fresh index (`add -A`, then `write-tree`),
  // whichever is larger. A snapshot never does more than that plus a few small git
  // calls (with a seeded index it does much less), so load and slow disks stretch both
  // alike, and a regression that adds per-file work or extra passes over the tree fails.
  const GIT_TIMEOUT_MS = 120_000;
  const plainGitMs = (dir: string) =>
    median(
      [0, 1, 2].map(() => {
        const env = { ...process.env, GIT_INDEX_FILE: join(tmp(), "index") };
        return timeMs(() => {
          for (const args of [["add", "-A"], ["write-tree"]]) {
            const r = spawnSync("git", args, { cwd: dir, env, timeout: GIT_TIMEOUT_MS });
            assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.error?.message ?? r.stderr}`);
          }
        });
      }),
    );
  const budgetMs = (baseMs: number) => Math.max(2000, 3 * baseMs);
  const within = (label: string, ms: number, dir: string, baseMs?: number) => {
    if (ms < 2000) return;
    const base = baseMs ?? plainGitMs(dir);
    assert.ok(ms < budgetMs(base), `${label} took ${ms.toFixed(0)} ms; plain git add -A + write-tree into a fresh index took ${base.toFixed(0)} ms`);
  };

  // Building the repo (5k writes and a commit) is untimed, and on Windows runners, where a
  // virus scanner reads every new file, it alone can take minutes. It gets its own generous
  // limit, so the tests' limits cover only the work they measure.
  let root = "";
  before(
    () => {
      root = makeRepo();
      for (let d = 0; d < 50; d++) {
        mkdirSync(join(root, `dir${d}`));
        for (let f = 0; f < 100; f++) writeFileSync(join(root, `dir${d}`, `f${f}.txt`), `file ${d}/${f}\n`.repeat(20));
      }
      gitc(root, "add", "-A");
      gitc(root, "commit", "-q", "-m", "5k");
      write(root, { "dir0/f0.txt": "changed\n", "untracked.txt": "u\n" });
    },
    { timeout: process.platform === "win32" ? 900_000 : 300_000 },
  );

  test("first and second snapshot < 2 s (or 3x plain git on a loaded machine)", { timeout: 300_000 }, async () => {
    let t = performance.now();
    const cold = await snapshot(root);
    const coldMs = performance.now() - t;
    t = performance.now();
    const warm = await snapshot(root);
    const warmMs = performance.now() - t;
    console.log(`# snapshot 5k files: first ${coldMs.toFixed(0)} ms, second ${warmMs.toFixed(0)} ms`);
    assert.equal(cold?.partial, false);
    assert.ok(warm?.snapshot);
    within("first snapshot", coldMs, root);
    within("second snapshot", warmMs, root);
  });

  // Without the repo's index (a fresh clone: no stat cache) git reads and hashes all 5k
  // files. That is a constant handful of git calls, but on Windows (per-file open cost,
  // the virus scanner) it takes seconds, past the default 2 s snapshot budget, so the
  // snapshot gets the same budget as the check, measured from plain git first.
  test("snapshot without an index (fresh clone) < 2 s (or 3x plain git)", { timeout: 300_000 }, async () => {
    const index = join(root, ".git", "index");
    const aside = join(tmp(), "index");
    renameSync(index, aside);
    try {
      const base = plainGitMs(root);
      const t = performance.now();
      const noIndex = await snapshot(root, { timeoutMs: budgetMs(base) });
      const noIndexMs = performance.now() - t;
      console.log(`# snapshot 5k files without index: ${noIndexMs.toFixed(0)} ms (plain git ${base.toFixed(0)} ms)`);
      assert.equal(noIndex?.partial, false, `no-index snapshot ran out of its ${budgetMs(base).toFixed(0)} ms budget (plain git ${base.toFixed(0)} ms)`);
      assert.ok(noIndex?.snapshot);
      within("no-index snapshot", noIndexMs, root, base);
    } finally {
      renameSync(aside, index);
    }
  });
});
