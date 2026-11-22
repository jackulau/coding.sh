// Session.stats.prs (core/sessions.ts foldPrs): the pull requests a session's own tool calls opened,
// merged, closed or linked, with no network call, and WorkItem.prs (core/work.ts itemPrs), the union
// over an item's sessions with the newest state per PR.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSession, PRS_ALL_MAX, PRS_MAX } from "../../src/core/sessions.ts";
import { buildWorkQueue, itemPrs, workItemJson } from "../../src/core/work.ts";
import { bash, CREATED, ev, PR12, prSessions, session, T0, tool } from "./_prs.ts";

describe("Session.stats.prs", () => {
  test("gh pr create's printed URL is an opened PR; gh pr merge on the same number makes it merged", () => {
    const { opener, merger } = prSessions();
    assert.equal(opener.stats.prs?.length, 1);
    const [opened] = opener.stats.prs!;
    assert.deepEqual({ ...opened, at: undefined }, { url: PR12, repo: "acme/widgets", number: 12, state: "opened", at: undefined });
    assert.ok(opened!.at > T0);
    assert.deepEqual(merger.stats.prs?.map((p) => [p.url, p.repo, p.number, p.state]), [[PR12, "acme/widgets", 12, "merged"]]);
  });

  test("a hook's { stdout, stderr } result is read like a transcript's text", () => {
    const id = "tu-hook";
    const s = buildSession([
      ev("hook", "session.start", {}),
      ev("hook", "tool.start", { tool: "Bash", toolUseId: id, input: { command: "git push && gh pr create --fill" } }),
      ev("hook", "tool.end", { tool: "Bash", toolUseId: id, output: { stdout: PR12, stderr: "To https://github.com/acme/widgets.git\n   1a2b3c4..5d6e7f8  fix -> fix", interrupted: false } }),
    ]);
    assert.deepEqual(s.stats.prs?.map((p) => [p.url, p.state]), [[PR12, "opened"]]);
  });

  test("a session that touched no PR has no prs field", () => {
    const s = session("plain", bash("plain", "npm test", "ok 1 - parses"), bash("plain", "gh pr list", "12  Fix the parser  fix-parser  OPEN"), bash("plain", "git push", "Everything up-to-date"));
    assert.equal("prs" in s.stats, false);
  });

  test("the last state the session saw wins, and a link never replaces another state", () => {
    const s = session("s",
      bash("s", "gh pr create --fill", CREATED),
      tool("s", "mcp__t3-code__watch_pull_request", { url: PR12 }, "watching"),
      bash("s", "gh pr close 12 --comment 'not needed'", "✓ Closed pull request acme/widgets#12 (Fix the parser)"),
      bash("s", "gh pr reopen 12", "✓ Reopened pull request acme/widgets#12 (Fix the parser)"));
    assert.deepEqual(s.stats.prs?.map((p) => [p.number, p.state]), [[12, "opened"]]);
    const merged = session("m", bash("m", "gh pr create --fill", CREATED), bash("m", "gh pr merge --squash", "✓ Squashed and merged pull request acme/widgets#12 (Fix the parser)"), bash("m", "gh pr view 12", `title: Fix the parser\n${PR12}`));
    assert.deepEqual(merged.stats.prs?.map((p) => [p.number, p.state]), [[12, "merged"]]);
  });

  test("an --auto merge that only queued is linked, a failed merge changes nothing, and a create of an existing PR links it", () => {
    const s = session("s",
      bash("s", "gh pr merge 7 --auto --squash -R acme/widgets", "! Pull request acme/widgets#7 will be automatically merged via squash when all requirements are met"),
      bash("s", "gh pr merge 8 --repo acme/widgets", "X Pull request acme/widgets#8 is not mergeable: the merge commit cannot be cleanly created.", false),
      bash("s", "gh pr create --fill", `a pull request for branch "fix" into branch "main" already exists:\nhttps://github.com/acme/widgets/pull/9`, false));
    assert.deepEqual(s.stats.prs?.map((p) => [p.number, p.state, p.url]), [[7, "linked", "https://github.com/acme/widgets/pull/7"], [9, "linked", "https://github.com/acme/widgets/pull/9"]]);
  });

  test("the repo comes from --repo, a push's remote, or gh's merge line; a number with none has no URL", () => {
    const pushed = session("p", bash("p", "git push", "To git@github.com:acme/api.git\n   1a2b3c4..5d6e7f8  main -> main"), bash("p", "gh pr merge 4", "")); // slop-allow personal-data: an SSH remote, not an email
    assert.deepEqual(pushed.stats.prs, [{ url: "https://github.com/acme/api/pull/4", repo: "acme/api", number: 4, state: "merged", at: pushed.stats.prs![0]!.at }]);
    const flag = session("f", bash("f", "gh pr close 5 --repo=acme/api", ""));
    assert.equal(flag.stats.prs?.[0]?.url, "https://github.com/acme/api/pull/5");
    const bare = session("b", bash("b", "gh pr merge 6 --rebase", ""));
    assert.deepEqual(bare.stats.prs?.map((p) => ({ ...p, at: 0 })), [{ number: 6, state: "merged", at: 0 }]);
  });

  test("a host tool that links PRs and a push that prints a PR URL name them as linked", () => {
    const s = session("h",
      tool("h", "mcp__t3-code__link_pull_request", { repository: "acme/widgets", number: 21 }, "linked"),
      tool("h", "mcp__t3-code__link_pull_requests", { urls: ["https://github.com/acme/widgets/pull/22", "https://example.com/not-a-pr"] }, "linked"),
      bash("h", "git push origin fix", "remote: Create a pull request for 'fix' on GitHub by visiting:\nremote:   https://github.com/acme/widgets/pull/new/fix\nremote: View pull request https://github.com/acme/widgets/pull/23\n"));
    assert.deepEqual(s.stats.prs?.map((p) => [p.number, p.state]), [[21, "linked"], [22, "linked"], [23, "linked"]]);
  });

  test("PR URLs in what a call printed (release notes, a PR body) link nothing; the gh pr view on the same line links its PR", () => {
    const notes = "## v0.1.0\n- Add agent spans (https://github.com/acme/semconv/pull/126)\n- Rename attributes (https://github.com/acme/semconv/pull/217)\n";
    const s = session("r", bash("r", "gh api repos/acme/semconv/releases/tags/v0.1.0 --jq .body | head -80; gh pr view 740 --repo acme/semconv --json files --jq '[.files[].path]'", `${notes}["docs/spans.md"]\n`));
    assert.deepEqual(s.stats.prs?.map((p) => [p.url, p.state]), [["https://github.com/acme/semconv/pull/740", "linked"]]);
    const body = session("b", bash("b", "gh pr view 9 --json body --jq .body", "Follows https://github.com/acme/widgets/pull/3"));
    assert.deepEqual(body.stats.prs?.map((p) => p.number), [9]);
  });

  test("a view's --repo is not the session's repo: a later merge by number names no other project's PR", () => {
    const s = session("v", bash("v", "gh pr view 63477 -R other/tool --json title", "{}"), bash("v", "gh pr merge 4 --squash", ""));
    assert.deepEqual(s.stats.prs?.map((p) => [p.number, p.repo, p.state]), [[63477, "other/tool", "linked"], [4, undefined, "merged"]]);
  });

  test("a stopped call counts nothing, and the list keeps the newest PRS_MAX it only linked", () => {
    const stopped = session("x", bash("x", "gh pr merge 3 -R acme/widgets", "[Request interrupted by user for tool use]", false));
    assert.equal(stopped.stats.prs, undefined);
    const many = session("y", ...Array.from({ length: PRS_MAX + 3 }, (_, i) => bash("y", `gh pr view ${i + 1} -R acme/widgets`, "")));
    assert.equal(many.stats.prs?.length, PRS_MAX);
    assert.equal(many.stats.prs?.[0]?.number, 4);
  });

  test("an orchestrator that merged more than PRS_MAX PRs keeps every merge, and drops PRs it only viewed first", () => {
    const n = PRS_MAX + 17;
    const merges = Array.from({ length: n }, (_, i) => bash("o", `gh pr merge ${133 + i} --repo acme/widgets --merge`, ""));
    const views = Array.from({ length: PRS_MAX + 2 }, (_, i) => bash("o", `gh pr view ${500 + i} -R acme/widgets`, ""));
    const s = session("o", ...merges.slice(0, 5), ...views, ...merges.slice(5));
    const prs = s.stats.prs!;
    assert.deepEqual(prs.filter((p) => p.state === "merged").map((p) => p.number), Array.from({ length: n }, (_, i) => 133 + i));
    assert.deepEqual(prs.filter((p) => p.state === "linked").map((p) => p.number), Array.from({ length: PRS_MAX }, (_, i) => 502 + i));
    assert.equal(prs.find((p) => p.number === 133)?.url, "https://github.com/acme/widgets/pull/133");
    assert.ok(PRS_ALL_MAX >= 10 * PRS_MAX);
  });

  test("folding in two appends gives what one fold gives", async () => {
    const { foldSession, sessionOf, sessionState } = await import("../../src/core/sessions.ts");
    const events = [ev("z", "session.start", {}), ...bash("z", "gh pr create --fill", CREATED), ...bash("z", "gh pr merge 12", "")];
    const st = sessionState();
    for (const e of events.slice(0, 2)) foldSession(st, e);
    const copy = structuredClone(st);
    for (const e of events.slice(2)) foldSession(copy, e);
    assert.deepEqual(sessionOf(copy).stats.prs?.map((p) => p.state), ["merged"]);
  });
});

describe("WorkItem.prs", () => {
  test("an item over the opening and the merging session has one PR, merged", () => {
    const { opener, merger } = prSessions(T0, true);
    assert.equal(merger.parent?.sessionId, "opener");
    const q = buildWorkQueue([opener, merger], { now: T0 + 3600e3, all: true });
    assert.equal(q.items.length, 1);
    const [item] = q.items;
    assert.deepEqual(item!.prs?.map((p) => [p.url, p.number, p.state]), [[PR12, 12, "merged"]]);
    const json = workItemJson(item!);
    assert.deepEqual(json.prs, [{ url: PR12, repo: "acme/widgets", number: 12, state: "merged", at: new Date(merger.stats.prs![0]!.at).toISOString() }]);
  });

  test("a merge another item's session ran reaches the item that opened the PR, which leaves the review queue", () => {
    const { events } = prSessions();
    // The opener changed a file; the merger is a separate root (an orchestrator), not its child.
    const opener = buildSession([...events.filter((e) => e.sessionId === "opener" && e.kind !== "session.end"), ev("opener", "file.change", { path: "src/parser.ts", op: "modify" }), ev("opener", "session.end", {})]);
    const merger = buildSession(events.filter((e) => e.sessionId === "merger"));
    const q = buildWorkQueue([opener, merger], { now: T0 + 3600e3, all: true });
    const item = q.items.find((i) => i.rootId === "opener")!;
    assert.deepEqual(item.prs?.map((p) => [p.url, p.state]), [[PR12, "merged"]]);
    assert.equal(item.bucket, undefined);
    assert.equal(item.hidden, "done");
    assert.match(item.reason, /PR #12 merged/);
    // Alone (the merge not stored), it is still open and waits for review.
    const alone = buildWorkQueue([opener], { now: T0 + 3600e3, all: true }).items[0]!;
    assert.deepEqual([alone.prs?.[0]?.state, alone.bucket], ["opened", "review"]);
    // A PR the item only viewed that merged elsewhere does not settle the item's own review.
    const viewer = buildSession([ev("view", "session.start", {}), ...bash("view", `gh pr view ${PR12}`, ""), ev("view", "file.change", { path: "a.ts", op: "modify" }), ev("view", "session.end", {})]);
    const v = buildWorkQueue([viewer, merger], { now: T0 + 3600e3, all: true }).items.find((i) => i.rootId === "view")!;
    assert.deepEqual([v.prs?.[0]?.state, v.bucket], ["merged", "review"]);
  });

  test("a PR only viewed in another repo than the item's is not the item's", () => {
    const repo = { root: "/work/widgets", head: "" };
    const s = buildSession([
      ev("x", "session.start", {}, { repo, cwd: "/work/widgets" }),
      ...bash("x", "gh pr view 63477 -R other/tool --json title", "{}"),
      ...bash("x", "gh pr view 3 -R acme/widgets", ""),
      ...bash("x", "gh pr merge 5 -R acme/lib", ""),
      ev("x", "session.end", {}),
    ]);
    assert.equal(s.stats.prs?.length, 3);
    const item = buildWorkQueue([s], { now: T0 + 3600e3, all: true }).items[0]!;
    assert.deepEqual(item.prs?.map((p) => [p.repo, p.number]).sort(), [["acme/lib", 5], ["acme/widgets", 3]]);
  });

  test("an item with no PR has no prs; one with no repo joins the PR of its number", () => {
    const plain = session("plain", bash("plain", "npm test", "ok"));
    assert.equal(itemPrs([plain]), undefined);
    assert.equal("prs" in workItemJson(buildWorkQueue([plain], { now: T0 + 3600e3, all: true }).items[0]!), false);
    const { opener } = prSessions();
    const bare = session("bare", bash("bare", "gh pr merge 12", ""));
    assert.equal(bare.stats.prs?.[0]?.repo, undefined);
    assert.deepEqual(itemPrs([opener, bare])?.map((p) => [p.url, p.state]), [[PR12, "merged"]]);
    // A later link does not undo the merge.
    const linker = session("l", tool("l", "mcp__t3-code__link_pull_request", { url: PR12 }));
    assert.deepEqual(itemPrs([opener, bare, linker])?.map((p) => p.state), ["merged"]);
  });
});
