// coding.sh work: the queue as JSON and text, show, ack and snooze against a throwaway store,
// and the built command spawned on an imported workflow run (test/fixtures/workflows).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { UsageError } from "../../src/cli/args.ts";
import * as work from "../../src/cli/commands/work.ts";
import { CliError } from "../../src/cli/output.ts";
import { findCommand } from "../../src/cli/registry.ts";
import { STAGES, workItemId } from "../../src/core/work.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { CLI } from "../_cli.ts";
import { removeTestDir } from "../_rm.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const MIN = 60e3;
const now = Date.now();
type Extra = NonNullable<Parameters<typeof mkSession>[2]>;
const sess = (id: string, startAgo: number, extra: Extra = {}): Session => mkSession(id, now - startAgo, { cwd: "/work/demo", ...extra });

describe("work against a seeded store", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    const blocked = sess("blocked", 5 * MIN, {
      endedAt: undefined,
      title: "publish the package",
      stats: { latency: { wallMs: 4 * MIN }, waiting: { kind: "permission", at: now - 2 * MIN, toolUseId: "t1", text: "Claude needs your permission to use Bash" } } as Extra["stats"],
    });
    const sub = sess("blocked:sub:a1", 4 * MIN, { endedAt: undefined, parent: { sessionId: "blocked", subagentId: "a1" }, stats: { latency: { wallMs: 3 * MIN } } as Extra["stats"] });
    const review = sess("review", 30 * MIN, { title: "fix the flaky test", stats: { filesChanged: 1 } });
    const done = sess("done", 60 * MIN);
    const old = sess("old", 30 * 86400e3, { stats: { filesChanged: 1 } });
    const fileEvent = { id: "f1", sessionId: "review", agent: "claude-code", ts: now - 29 * MIN, kind: "file.change", payload: { path: "src/flaky.test.ts" } } as unknown as AgentEvent; // slop-allow chained-as: an event with only the fields the queue reads
    await sb.seed([blocked, sub, review, done, old], [fileEvent]);
  });
  after(() => sb.cleanup());

  test("--json lists what needs you, most urgent first, within the window", async () => {
    const r = await runCmd(work, sb, { json: true });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.counts, { blocked: 1, failed: 0, stalled: 0, turn: 0, review: 1 });
    assert.equal(r.json.needYou, 1);
    assert.equal(r.json.hidden, 1, "done is hidden; old is outside the 7d window");
    assert.deepEqual(r.json.items.map((i: { id: string }) => i.id), [workItemId("blocked"), workItemId("review")]);
    const [b] = r.json.items;
    assert.equal(b.bucket, "blocked");
    assert.equal(b.sessions, 2);
    assert.equal(b.waiting.kind, "permission");
    assert.equal(b.waiting.at, new Date(now - 2 * MIN).toISOString());
    const wide = await runCmd(work, sb, { json: true, flags: { since: "60d", all: true } });
    assert.equal(wide.json.items.length, 4);
  });

  test("the text view groups by bucket and names the next step", async () => {
    const r = await runCmd(work, sb, {});
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, /^Work {2}1 blocked on you · 1 ready for review {2}\(since 7d\)/);
    assert.match(r.stdout, /Blocked on you\n {2}w[0-9a-f]{6} {2}publish the package/);
    assert.match(r.stdout, /waiting on a permission prompt for 2m/);
    assert.match(r.stdout, /Ready for review/);
    assert.match(r.stdout + r.stderr, new RegExp(`(?:coding\\.sh|codingsh) work show ${workItemId("blocked")}`));
  });

  test("show gives the item by its id or a member session's id, with the files it changed", async () => {
    const r = await runCmd(work, sb, { action: "show", positionals: ["review"], json: true });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.equal(r.json.id, workItemId("review"));
    assert.deepEqual(r.json.files, ["src/flaky.test.ts"]);
    const sub = await runCmd(work, sb, { action: "show", positionals: ["blocked:sub:a1"], json: true });
    assert.equal(sub.json.id, workItemId("blocked"));
    assert.deepEqual(sub.json.sessions.map((s: { id: string }) => s.id), ["blocked", "blocked:sub:a1"]);
    const text = await runCmd(work, sb, { action: "show", positionals: [workItemId("blocked")] });
    assert.match(text.stdout, /Prompt +Claude needs your permission to use Bash/);
    const out = await runCmd(work, sb, { action: "show", positionals: ["old"], json: true });
    assert.equal(out.json?.id, workItemId("old"), "a session outside the window is still found by its id");
  });

  test("an unknown id exits 1; a missing id or a bad duration is a usage error", async () => {
    const r = await runCmd(work, sb, { action: "show", positionals: ["w000000"], json: true });
    assert.ok(r.error instanceof CliError);
    assert.equal(r.error.exitCode, 1);
    assert.equal(r.error.reason, "not_found");
    assert.ok((await runCmd(work, sb, { action: "ack" })).error instanceof UsageError);
    assert.ok((await runCmd(work, sb, { action: "snooze", positionals: ["review", "soon"] })).error instanceof UsageError);
    assert.ok((await runCmd(work, sb, { action: "snooze", positionals: ["review"] })).error instanceof UsageError);
  });

  test("ack hides the cause and keeps it in work.json; snooze hides the item for a while", async () => {
    const a = await runCmd(work, sb, { action: "ack", positionals: [workItemId("review")], json: true });
    assert.equal(a.error, undefined, a.error?.stack);
    assert.equal(a.json.acked, true);
    assert.equal(a.json.bucket, "review");
    assert.equal(a.json.now.hidden, "acked");
    const path = join(sb.env.CODING_SH_HOME!, "work.json");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).acks.review, [a.json.fingerprint]);
    const again = await runCmd(work, sb, { action: "ack", positionals: [workItemId("review")], json: true });
    assert.equal(again.json.acked, false);

    const z = await runCmd(work, sb, { action: "snooze", positionals: ["blocked", "2h"], json: true });
    assert.equal(z.error, undefined, z.error?.stack);
    assert.equal(z.json.bucket, "blocked");
    const left = await runCmd(work, sb, { json: true });
    assert.deepEqual(left.json.items, []);
    assert.equal(left.json.needYou, 0);
    const text = await runCmd(work, sb, {});
    assert.match(text.stdout, /Nothing needs you\. 3 items running, done, acknowledged or snoozed\./);
    assert.match(text.stdout + text.stderr, /(?:coding\.sh|codingsh) work --all/);
  });
});

describe("work snooze in text", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([
      sess("asks", 5 * MIN, { endedAt: undefined, stats: { latency: { wallMs: 4 * MIN }, waiting: { kind: "permission", at: now - 2 * MIN, toolUseId: "t1" } } as Extra["stats"] }),
      sess("changed", 30 * MIN, { stats: { filesChanged: 1 } }),
    ]);
  });
  after(() => sb.cleanup());

  test("a blocked item says nothing brings it back sooner; a review item names the buckets that do", async () => {
    const b = await runCmd(work, sb, { action: "snooze", positionals: ["asks", "2h"] });
    assert.equal(b.error, undefined, b.error?.stack);
    assert.match(b.stdout + b.stderr, /Nothing is more urgent than blocked on you, so it stays hidden until then, even if it waits on you again\./);
    assert.doesNotMatch(b.stdout + b.stderr, /more urgent bucket than/);
    const r = await runCmd(work, sb, { action: "snooze", positionals: ["changed", "2h"] });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout + r.stderr, /It comes back sooner if it moves to a more urgent bucket than ready for review\./);
  });
});

describe("work --stage", () => {
  let sb: Sandbox;
  const running = (id: string, extra: Extra = {}) => sess(id, 5 * MIN, { endedAt: undefined, ...extra, stats: { latency: { wallMs: 4 * MIN }, ...extra.stats } as Extra["stats"] });
  before(async () => {
    sb = sandbox();
    await sb.seed([
      running("editing", { title: "add the parser", stats: { filesChanged: 2 } }),
      running("reading", { title: "map the codebase" }),
      sess("asks", 3 * MIN, { endedAt: undefined, stats: { latency: { wallMs: MIN }, waiting: { kind: "permission", at: now - 2 * MIN, toolUseId: "t1" } } as Extra["stats"] }),
      sess("changed", 20 * MIN, { title: "fix the flaky test", stats: { filesChanged: 1 } }),
      sess("failed", 10 * MIN, { stats: { testsFailed: 2 } }),
      sess("finished", 40 * MIN),
    ]);
  });
  after(() => sb.cleanup());

  test("--json gives each item's stage, kind and evidence, and counts every stage, hidden items too", async () => {
    const r = await runCmd(work, sb, { json: true, flags: { all: true } });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.deepEqual(r.json.stages, { planning: 1, executing: 1, review: 2, approval: 1, done: 1 });
    const by = Object.fromEntries(r.json.items.map((i: { id: string }) => [i.id, i]));
    const pick = (id: string) => [by[workItemId(id)].stage, by[workItemId(id)].kind ?? null];
    assert.deepEqual(pick("editing"), ["executing", "change"]);
    assert.deepEqual(pick("reading"), ["planning", null]);
    assert.deepEqual(pick("asks"), ["approval", null]);
    assert.deepEqual(pick("changed"), ["review", "change"]);
    assert.deepEqual(pick("failed"), ["review", "research"]);
    assert.deepEqual(pick("finished"), ["done", "research"]);
    assert.equal(by[workItemId("editing")].stageWhy, "running 5m, changed 2 files");
    const plain = await runCmd(work, sb, { json: true });
    assert.deepEqual(plain.json.stages, r.json.stages, "without --all the counts still cover hidden items");
  });

  test("--stage executing --json lists only the running item that changed a file", async () => {
    const r = await runCmd(work, sb, { json: true, flags: { stage: ["executing"] } });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.deepEqual(r.json.items.map((i: { id: string }) => i.id), [workItemId("editing")]);
    assert.equal(r.json.items[0].hidden, "running");
  });

  test("--stage takes a comma list and lists the done items the queue hides", async () => {
    const done = await runCmd(work, sb, { json: true, flags: { stage: "done" } });
    assert.deepEqual(done.json.items.map((i: { id: string }) => i.id), [workItemId("finished")]);
    const two = await runCmd(work, sb, { json: true, flags: { stage: ["approval", "planning"] } });
    assert.deepEqual(two.json.items.map((i: { id: string }) => i.id).sort(), [workItemId("asks"), workItemId("reading")].sort());
  });

  test("an unknown stage is a usage error that suggests the stage meant", async () => {
    const r = await runCmd(work, sb, { json: true, flags: { stage: ["reveiw"] } });
    assert.ok(r.error instanceof UsageError);
    assert.equal(r.error.suggestion, "--stage review");
  });

  test("the text view shows the stage counts and each item's stage; show prints the stage and its evidence", async () => {
    const r = await runCmd(work, sb, {});
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, /^Work .*\nStages {2}1 planning · 1 executing · 2 review · 1 approval · 1 done\n/);
    assert.match(r.stdout, /fix the flaky test {2}review · change {2}/);
    const none = await runCmd(work, sb, { flags: { stage: "done", repo: "/nowhere" } });
    assert.match(none.stdout, /No items in done since 7d\./);
    const show = await runCmd(work, sb, { action: "show", positionals: ["editing"] });
    assert.match(show.stdout, /Stage +executing · change: running 5m, changed 2 files/);
  });

  test("the registry offers the stages the core knows", () => {
    const flag = findCommand("work")!.flags!.find((f) => f.name === "stage");
    assert.deepEqual(flag?.choices, [...STAGES]);
  });
});

describe("work and work show agree on one item", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    // Two sessions of one item changed a.ts: the list counts it once, as show does.
    const root = sess("multi", 115 * MIN, { title: "two agents", stats: { filesChanged: 2, testsFailed: 2 } });
    const sub = sess("multi:sub:a1", 114 * MIN, { parent: { sessionId: "multi", subagentId: "a1" }, stats: { filesChanged: 2 } });
    const ev = (id: string, sessionId: string, path: string) => ({ id, sessionId, agent: "claude-code", ts: now - 113 * MIN, kind: "file.change", payload: { path } }) as unknown as AgentEvent; // slop-allow chained-as: an event with only the fields the queue reads
    const wait = sess("waits", 2 * MIN, { endedAt: undefined, stats: { latency: { wallMs: MIN }, waiting: { kind: "permission", at: now - 27e3, toolUseId: "t1" } } as Extra["stats"] });
    await sb.seed([root, sub, wait], [ev("e1", "multi", "a.ts"), ev("e2", "multi", "b.ts"), ev("e3", "multi:sub:a1", "a.ts"), ev("e4", "multi:sub:a1", "c.ts")]);
  });
  after(() => sb.cleanup());

  test("a path two sessions changed counts once in the list, as in work show", async () => {
    const list = await runCmd(work, sb, { json: true, flags: { all: true } });
    assert.equal(list.error, undefined, list.error?.stack);
    const row = list.json.items.find((i: { id: string }) => i.id === workItemId("multi"));
    const show = await runCmd(work, sb, { action: "show", positionals: ["multi"], json: true });
    assert.equal(show.json.filesChanged, 3);
    assert.equal(row.filesChanged, show.json.filesChanged);
  });

  test("work show splits the main session's own files-changed count, the one show reports, from the item's", async () => {
    const show = await runCmd(work, sb, { action: "show", positionals: ["multi"], json: true });
    assert.deepEqual([show.json.filesChanged, show.json.sessionFilesChanged, show.json.sessionId], [3, 2, "multi"]);
    const text = await runCmd(work, sb, { action: "show", positionals: ["multi"] });
    assert.match(text.stdout, /Files +3 files changed across 2 sessions; the main session changed 2/);
    // One session: one number, no split.
    const one = await runCmd(work, sb, { action: "show", positionals: ["waits"], json: true });
    assert.equal(one.json.sessionFilesChanged, undefined);
  });

  test("one instant reads the same in Why and Started, and a wait under a minute reads in seconds", async () => {
    const r = await runCmd(work, sb, { action: "show", positionals: ["multi"] });
    assert.equal(r.error, undefined, r.error?.stack);
    const why = /Why +ended (\S+) ago/.exec(r.stdout)?.[1];
    const last = /last active (\S+) ago/.exec(r.stdout)?.[1];
    assert.ok(why && last, r.stdout);
    assert.equal(why, last);
    const w = await runCmd(work, sb, { action: "show", positionals: ["waits"] });
    assert.match(w.stdout, /waiting on a permission prompt for \d+s/);
    assert.doesNotMatch(w.stdout, /for 0m/);
  });
});

describe("work show, ack and snooze take a prefix of an item id", () => {
  let sb: Sandbox;
  // The items of s12 and s58 have ids that share their first 4 characters; no other id starts as review's does.
  const [a, b] = ["s12", "s58"];
  before(async () => {
    sb = sandbox();
    await sb.seed([sess(a, 20 * MIN, { title: "first of a pair" }), sess(b, 10 * MIN, { title: "second of a pair" }), sess("review", 30 * MIN, { title: "fix the flaky test", stats: { filesChanged: 1 } })]);
  });
  after(() => sb.cleanup());

  test("a prefix of 4 characters or more that one item's id starts with names that item", async () => {
    const id = workItemId("review");
    const r = await runCmd(work, sb, { action: "show", positionals: [id.slice(0, 4)], json: true });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.equal(r.json.id, id);
    const text = await runCmd(work, sb, { action: "show", positionals: [id.slice(0, 6)] });
    assert.equal(text.error, undefined, text.error?.stack);
    assert.match(text.stdout, new RegExp(`^${id} {2}fix the flaky test\\n`));
    const z = await runCmd(work, sb, { action: "snooze", positionals: [id.slice(0, 5), "2h"], json: true });
    assert.equal(z.error, undefined, z.error?.stack);
    assert.equal(z.json.id, id);
  });

  test("a prefix two items' ids share lists both, newest first, and exits 1", async () => {
    const prefix = workItemId(a).slice(0, 4);
    assert.equal(workItemId(b).slice(0, 4), prefix, "the pair's ids share a prefix");
    const r = await runCmd(work, sb, { action: "show", positionals: [prefix] });
    assert.ok(r.error instanceof CliError, String(r.error));
    assert.equal(r.error.exitCode, 1);
    assert.equal(r.error.reason, "ambiguous");
    assert.match(r.error.message, new RegExp(`^Work item id prefix "${prefix}" is ambiguous\\. It matches:\\n {2}${workItemId(b)} {2}claude-code {2}\\d+m ago {2}second of a pair\\n {2}${workItemId(a)} {2}claude-code {2}\\d+m ago {2}first of a pair$`));
    assert.deepEqual(r.error.next, ["Pass one of these ids, more of the id, or list work items:", "coding.sh work --all --since 7d"]);
    const data = r.error.data as { candidates: { id: string; agent: string; startedAt: string; title: string | null }[]; more: boolean };
    assert.deepEqual(data, {
      candidates: [
        { id: workItemId(b), agent: "claude-code", startedAt: new Date(now - 10 * MIN).toISOString(), title: "second of a pair" },
        { id: workItemId(a), agent: "claude-code", startedAt: new Date(now - 20 * MIN).toISOString(), title: "first of a pair" },
      ],
      more: false,
    });
    const ack = await runCmd(work, sb, { action: "ack", positionals: [prefix], json: true });
    assert.equal(ack.error?.reason, "ambiguous");
  });

  test("a shorter prefix, or one no item's id starts with, is not found", async () => {
    const short = await runCmd(work, sb, { action: "show", positionals: [workItemId("review").slice(0, 3)] });
    assert.ok(short.error instanceof CliError, String(short.error));
    assert.equal(short.error.reason, "not_found");
    assert.match(short.error.message, /^Can't find work item "w[0-9a-f]{2}" since 7d \(an id prefix needs at least 4 characters\)$/);
    assert.ok(![a, b, "review"].some((s) => workItemId(s).startsWith("w000")), "no id starts with w000");
    const miss = await runCmd(work, sb, { action: "show", positionals: ["w000"] });
    assert.ok(miss.error instanceof CliError, String(miss.error));
    assert.equal(miss.error.reason, "not_found");
    assert.equal(miss.error.message, `Can't find work item "w000" since 7d`);
  });
});

describe("the CLI on an imported workflow run", () => {
  const PROJECTS = fileURLToPath(new URL("../fixtures/workflows/claude-code-running/projects", import.meta.url));
  const ROOT = "5a1d7c3e-0b2f-4c6d-9e8f-1a2b3c4d5e6f";
  let root = "";
  let env: NodeJS.ProcessEnv = {};
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: root, env, encoding: "utf8" });
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-work-")));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    env = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(root, "data"), XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), PATH: process.env.PATH, NO_COLOR: "1", CI: "1", CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1" };
    const r = cli(["workflows", "import", PROJECTS, "--json"]);
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => removeTestDir(root));

  test("the run's agents form one item, keyed by the root transcript that is not stored", () => {
    const r = cli(["work", "--json", "--all", "--since", "2000-01-01"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.items.length, 1);
    assert.equal(doc.items[0].id, workItemId(ROOT));
    assert.equal(doc.items[0].rootId, ROOT);
    assert.equal(existsSync(join(root, "data", "work.json")), false, "a read writes no overlay");
  });

  test("a bad flag value exits 2, and a typo of another command suggests it", () => {
    const bad = cli(["work", "--since", "yesterday-ish", "--json"]);
    assert.equal(bad.status, 2, bad.stderr);
    const typo = cli(["workfl"]);
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /workflow/);
    const stage = cli(["work", "--stage", "reveiw"]);
    assert.equal(stage.status, 2, stage.stderr);
    assert.match(stage.stderr, /--stage review/);
  });
});
