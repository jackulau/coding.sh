// Pull requests of the item's own repo when its sessions ran in a linked worktree (QA Q2.8): the
// worktree's folder has another name than the repo, so the item's repo is named by its main
// checkout (RepoState.main). `work` and `work show` print `#N` for that repo's PRs, opened or
// only linked, as they do in the main checkout, and still name another repo's PRs in full.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as work from "../../src/cli/commands/work.ts";
import { workItemId } from "../../src/core/work.ts";
import type { PullRequestRef } from "../../src/schema/index.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const MIN = 60e3;
const NOW = Date.now();
const MAIN = "/work/demo";
// Worktrees an agent made for its tasks: their folders are not named after the repo.
const PARSER = "/work/worktrees/fix-parser";
const LEXER = "/work/worktrees/fix-lexer";

const pr = (repo: string, number: number, state: PullRequestRef["state"], at: number): PullRequestRef => ({ url: `https://github.com/${repo}/pull/${number}`, repo, number, state, at });
const inWorktree = (root: string, branch: string) => ({ cwd: root, repo: { root, main: MAIN, head: "", branch } });

const SESSIONS = [
  mkSession("wt-mixed", NOW - 60 * MIN, { ...inWorktree(PARSER, "fix-parser"), stats: { filesChanged: 1, prs: [pr("owner/demo", 7, "opened", NOW - 50 * MIN), pr("owner/demo", 8, "linked", NOW - 49 * MIN), pr("owner/other", 9, "opened", NOW - 48 * MIN)] } }),
  mkSession("wt-own", NOW - 120 * MIN, { ...inWorktree(LEXER, "fix-lexer"), stats: { filesChanged: 1, prs: [pr("owner/demo", 10, "opened", NOW - 110 * MIN), pr("owner/demo", 11, "linked", NOW - 109 * MIN)] } }),
  mkSession("main-co", NOW - 180 * MIN, { cwd: MAIN, repo: { root: MAIN, head: "", branch: "main" }, stats: { filesChanged: 1, prs: [pr("owner/demo", 12, "opened", NOW - 170 * MIN)] } }),
];

describe("pull requests of items whose sessions ran in a linked worktree", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed(SESSIONS);
  });
  after(() => sb.cleanup());

  test("work prints the repo's own PRs as #N, opened or linked, and another repo's as owner/name#N", async () => {
    const r = await runCmd(work, sb, {});
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, /PRs #7, owner\/other#9 open; #8 linked/);
    assert.match(r.stdout, /PRs #10 open; #11 linked/);
    assert.match(r.stdout, /PR #12 open/);
    assert.doesNotMatch(r.stdout, /owner\/demo#/);
  });

  test("work show names them the same way", async () => {
    const r = await runCmd(work, sb, { action: "show", positionals: ["wt-mixed"] });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, /^ +PRs +#7 open, #8 linked, owner\/other#9 open$/m);
    assert.match(r.stdout, /^ +#8 +linked +https:\/\/github\.com\/owner\/demo\/pull\/8 /m);
    assert.match(r.stdout, /^ +owner\/other#9 +open +https:\/\/github\.com\/owner\/other\/pull\/9 /m);
  });

  test("--json gives repoMain for a worktree item, and none for an item in the main checkout", async () => {
    const r = await runCmd(work, sb, { json: true, flags: { all: true } });
    assert.equal(r.error, undefined, r.error?.stack);
    const item = (id: string) => r.json.items.find((i: { id: string }) => i.id === workItemId(id));
    assert.equal(item("wt-mixed").repo, PARSER);
    assert.equal(item("wt-mixed").repoMain, MAIN);
    assert.equal(item("wt-own").repoMain, MAIN);
    assert.equal(item("main-co").repo, MAIN);
    assert.equal("repoMain" in item("main-co"), false);
  });
});
