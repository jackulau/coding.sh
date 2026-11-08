import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { GIT_HEAD_EVENT, readGitHead } from "../../src/spool/githead.ts";
import { gitc, isolate, makeRepo, removeTmp, tmp } from "../capture/_helpers.ts";
import { cpuMs } from "../helpers-timing.ts";

before(() => {
  isolate();
});
after(() => removeTmp());

/** What git itself says for `cwd`: the same shape readGitHead returns. */
function gitSays(cwd: string): { root: string; head: string; branch?: string } {
  const root = gitc(cwd, "rev-parse", "--show-toplevel");
  let head = "";
  try {
    head = gitc(cwd, "rev-parse", "--verify", "-q", "HEAD");
  } catch {
    // unborn branch
  }
  let branch: string | undefined;
  try {
    branch = gitc(cwd, "symbolic-ref", "--short", "-q", "HEAD");
  } catch {
    // detached
  }
  return branch === undefined ? { root, head } : { root, head, branch };
}

describe("readGitHead matches git", () => {
  test("a normal repo, and a subdirectory of it", () => {
    const root = makeRepo({ "a.txt": "a\n", "sub/dir/b.txt": "b\n" });
    const r = readGitHead(root);
    assert.deepEqual(r, gitSays(root));
    assert.match(r!.head, /^[0-9a-f]{40}$/);
    assert.equal(r!.branch, "main");
    assert.deepEqual(readGitHead(join(root, "sub", "dir")), gitSays(join(root, "sub", "dir")));
  });

  test("a branch only in packed-refs", () => {
    const root = makeRepo({ "a.txt": "a\n" });
    gitc(root, "branch", "feature/x-old");
    writeFileSync(join(root, "a.txt"), "b\n");
    gitc(root, "commit", "-qam", "two");
    gitc(root, "checkout", "-q", "-b", "feature/x");
    gitc(root, "pack-refs", "--all");
    // An unsorted file where a longer ref starting with the same name comes first.
    const packed = join(root, ".git", "packed-refs");
    const [header, ...lines] = readFileSync(packed, "utf8").split("\n").filter(Boolean);
    lines.sort((a, b) => Number(b.includes("x-old")) - Number(a.includes("x-old")));
    writeFileSync(packed, [header!.replace(" sorted", ""), ...lines].join("\n") + "\n");
    assert.match(readFileSync(packed, "utf8"), /x-old\n.*refs\/heads\/feature\/x\n/s);
    assert.deepEqual(readGitHead(root), gitSays(root));
    assert.equal(readGitHead(root)!.branch, "feature/x");
    assert.equal(readGitHead(root)!.head, gitc(root, "rev-parse", "HEAD"));
  });

  test("a detached HEAD has no branch", () => {
    const root = makeRepo({ "a.txt": "a\n" });
    writeFileSync(join(root, "a.txt"), "b\n");
    gitc(root, "commit", "-qam", "two");
    gitc(root, "checkout", "-q", "--detach", "HEAD~1");
    const r = readGitHead(root);
    assert.deepEqual(r, gitSays(root));
    assert.equal(r!.branch, undefined);
  });

  test("a linked worktree reads its own HEAD and the shared refs", () => {
    const root = makeRepo({ "a.txt": "a\n" });
    const wt = join(tmp("csh-wt-"), "wt");
    gitc(root, "worktree", "add", "-q", "-b", "side", wt);
    writeFileSync(join(wt, "a.txt"), "side\n");
    gitc(wt, "commit", "-qam", "side");
    const r = readGitHead(wt);
    assert.deepEqual(r, gitSays(wt));
    assert.equal(r!.root, wt);
    assert.equal(r!.branch, "side");
    assert.notEqual(r!.head, readGitHead(root)!.head);
    gitc(root, "pack-refs", "--all");
    assert.deepEqual(readGitHead(wt), gitSays(wt));
  });

  test("a submodule resolves to the submodule, not the superproject", () => {
    const lib = makeRepo({ "lib.txt": "lib\n" });
    const sup = makeRepo({ "top.txt": "top\n" });
    gitc(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    const sub = join(sup, "vendor", "lib");
    const r = readGitHead(sub);
    assert.deepEqual(r, gitSays(sub));
    assert.equal(r!.root, sub);
    assert.equal(r!.head, gitc(lib, "rev-parse", "HEAD"));
  });

  test("an unborn branch gives head \"\" and the branch", () => {
    const root = makeRepo();
    assert.deepEqual(readGitHead(root), { root, head: "", branch: "main" });
    assert.deepEqual(readGitHead(root), gitSays(root));
  });
});

describe("readGitHead outside a readable repo", () => {
  test("a cwd outside any repo, or missing, gives undefined", () => {
    assert.equal(readGitHead(tmp("csh-norepo-")), undefined);
    assert.equal(readGitHead(join(tmp("csh-norepo-"), "does", "not", "exist")), undefined);
    assert.equal(readGitHead(""), undefined);
  });

  test("a corrupt HEAD, a dangling gitdir file or a reftable placeholder gives undefined and never throws", () => {
    const root = makeRepo({ "a.txt": "a\n" });
    writeFileSync(join(root, ".git", "HEAD"), "garbage\n");
    assert.equal(readGitHead(root), undefined);
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
    assert.equal(readGitHead(root), undefined);
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/../../../etc/passwd\n");
    assert.equal(readGitHead(root), undefined);
    const dangling = tmp("csh-dangling-");
    writeFileSync(join(dangling, ".git"), "gitdir: /nowhere/at/all\n");
    assert.equal(readGitHead(dangling), undefined);
    const odd = tmp("csh-odd-");
    mkdirSync(join(odd, ".git", "HEAD"), { recursive: true }); // HEAD is a directory
    assert.equal(readGitHead(odd), undefined);
  });
});

test("GIT_HEAD_EVENT matches session-start and prompt events only", () => {
  for (const e of ["SessionStart", "UserPromptSubmit", "beforeSubmitPrompt", "sessionStart", "session.start", "session_start"]) assert.ok(GIT_HEAD_EVENT.test(e), e);
  for (const e of ["PostToolUse", "PreToolUse", "Stop", "SessionEnd", "notify"]) assert.ok(!GIT_HEAD_EVENT.test(e), e);
});

test("soft microbenchmark: a 1 MB packed-refs read costs about one scan of the file, not many", () => {
  const root = makeRepo({ "a.txt": "a\n" });
  gitc(root, "pack-refs", "--all");
  const head = gitc(root, "rev-parse", "HEAD");
  const packed = join(root, ".git", "packed-refs");
  const [header, ...rest] = readFileSync(packed, "utf8").split("\n");
  // Refs sorting before refs/heads/main, so the scan finds main last.
  const filler: string[] = [];
  for (let i = 0; filler.length * 60 < 1 << 20; i++) filler.push(`${head} refs/heads/a-${String(i).padStart(8, "0")}`);
  writeFileSync(packed, [header, ...filler, ...rest].join("\n"));
  assert.deepEqual(readGitHead(root), gitSays(root));
  // CPU, not wall time, and against a baseline measured in the same process: reading the 1 MB file
  // once and scanning it for the branch is the irreducible cost, so this cancels a slow or loaded
  // core. The bound is deliberately loose (10x, 5 ms floor): the regressions worth catching here —
  // re-reading the file in a loop, scanning it in O(n^2) over thousands of refs — are hundreds of
  // times a single scan, not a few. The end-to-end hook budget is the bench's perf.hookStart.
  const med = (fn: () => void) => Array.from({ length: 200 }, () => cpuMs(fn)).sort((a, b) => a - b)[100]!;
  const baseline = med(() => readFileSync(packed, "utf8").indexOf(" refs/heads/main"));
  const actual = med(() => readGitHead(root));
  assert.ok(actual < Math.max(5, baseline * 10), `readGitHead ${actual.toFixed(3)} ms CPU vs one scan ${baseline.toFixed(3)} ms`);
});
