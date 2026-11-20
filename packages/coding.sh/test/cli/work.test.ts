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
import { workItemId } from "../../src/core/work.ts";
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
    assert.match(r.stdout + r.stderr, new RegExp(`coding\\.sh work show ${workItemId("blocked")}`));
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
    assert.match(text.stdout + text.stderr, /coding\.sh work --all/);
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
  });
});
