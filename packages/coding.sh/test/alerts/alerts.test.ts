import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../../src/cli/args.ts";
import * as alertCmd from "../../src/cli/commands/alert.ts";
import { commandHelp } from "../../src/cli/main.ts";
import { findCommand } from "../../src/cli/registry.ts";
import { classify, recordDelivery, runAlertChecks } from "../../src/alerts/check.ts";
import { parseMeasure, readMeasure } from "../../src/alerts/measure.ts";
import { deliver, signatureHeaders, signBody, stderrLine } from "../../src/alerts/notify.ts";
import { type AlertDef, loadAlerts, MAX_FAILED_DELIVERIES, saveAlerts } from "../../src/alerts/store.ts";
import type { Score } from "../../src/core/types.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { removeTestDir } from "../_rm.ts";
import { mkSession, runCmd, type Sandbox, sandbox } from "../cli/_cmd.ts";

interface Post {
  body: string;
  signature: string | undefined;
  timestamp: string | undefined;
  signatureV2: string | undefined;
}

/** A local webhook: records each POST and answers `status()`. */
function listener(status: () => number = () => 200): Promise<{ server: Server; url: string; posts: Post[] }> {
  const posts: Post[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const h = (name: string) => req.headers[name] as string | undefined;
      posts.push({ body, signature: h("x-coding-sh-signature"), timestamp: h("x-coding-sh-timestamp"), signatureV2: h("x-coding-sh-signature-v2") });
      res.writeHead(status()).end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, posts })));
}

const close = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));

describe("coding.sh alert", () => {
  let sb: Sandbox;
  let hook: Awaited<ReturnType<typeof listener>>;
  before(async () => {
    sb = sandbox();
    hook = await listener();
    const now = Date.now();
    await sb.seed([
      mkSession("fail-1", now - 3_600_000, { flags: ["repeated-tool-failure"] }),
      mkSession("fail-2", now - 7_200_000, { flags: ["tests-failed", "gateway:vercel"] }),
      mkSession("fail-3", now - 600_000, { agent: "codex" as never, flags: ["error-exit"] }),
    ]);
  });
  after(async () => {
    await close(hook.server);
    sb.cleanup();
  });

  it("sends one signed POST when failures cross the threshold, and none while the state holds", async () => {
    const add = await runCmd(alertCmd, sb, { action: "add", positionals: ["failures"], flags: { measure: "failure-rate", over: 0.5, window: "1d", notify: `webhook:${hook.url}` }, json: true });
    assert.equal(add.error, undefined, String(add.error));
    assert.equal(add.code, 0);
    const secret = (add.json as { secret: string }).secret;
    assert.match(secret, /^csh_whsec_[0-9a-f]{48}$/);

    const first = await runCmd(alertCmd, sb, { action: "check", json: true });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(hook.posts.length, 1);
    const post = hook.posts[0]!;
    const body = JSON.parse(post.body);
    assert.equal(body.alert, "failures");
    assert.equal(body.state, "ALERT");
    assert.equal(body.previous, "OK");
    assert.equal(body.value, 1);
    assert.equal(body.threshold, 0.5);
    assert.equal(body.window, "1d");
    assert.equal(body.by, undefined);
    assert.ok(!Number.isNaN(Date.parse(body.at)));
    assert.equal(post.signature, `sha256=${createHmac("sha256", secret).update(post.body).digest("hex")}`);
    // The timestamp is unix seconds, and the second signature covers "<timestamp>.<body>".
    assert.match(post.timestamp ?? "", /^\d+$/);
    assert.ok(Math.abs(Number(post.timestamp) - Date.now() / 1000) < 60, `timestamp ${post.timestamp} is now`);
    assert.equal(post.signatureV2, `sha256=${createHmac("sha256", secret).update(`${post.timestamp}.${post.body}`).digest("hex")}`);
    const results = (first.json as { alerts: { name: string; state: string; value: number; notified: number }[] }).alerts;
    assert.deepEqual(results.map((r) => [r.name, r.state, r.value, r.notified]), [["failures", "ALERT", 1, 1]]);

    const second = await runCmd(alertCmd, sb, { action: "check", json: true });
    assert.equal(second.code, 0);
    assert.equal(hook.posts.length, 1, "no change of state, no POST");
  });

  it("keeps alerts.json mode 600 and never prints the secret again", async () => {
    const file = join(sb.env.CODING_SH_HOME!, "alerts.json");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    const list = await runCmd(alertCmd, sb, { action: "list", json: true });
    assert.equal(list.code, 0);
    assert.doesNotMatch(list.stdout, /csh_whsec_/);
    const human = await runCmd(alertCmd, sb, { action: "list" });
    assert.match(human.stdout, /failures/);
    assert.match(human.stdout, /ALERT/);
    assert.doesNotMatch(human.stdout, /csh_whsec_/);
  });

  it("add tells how to check the timestamped signature, and that the old one alone does not stop a replay", async () => {
    const own = sandbox();
    try {
      const r = await runCmd(alertCmd, own, { action: "add", positionals: ["signed"], flags: { measure: "cost", over: 1, window: "1d", notify: "webhook:http://127.0.0.1:9/hook" } });
      assert.equal(r.code, 0, String(r.error));
      const text = r.stdout + r.stderr;
      assert.match(text, /X-Coding-Sh-Signature-V2: sha256=<HMAC-SHA256 of "<timestamp>\.<body>"/);
      assert.match(text, /X-Coding-Sh-Timestamp \(unix seconds\)/);
      assert.match(text, /more than 5 minutes/);
      assert.match(text, /X-Coding-Sh-Signature signs the body alone and does not stop a replay/);
    } finally {
      own.cleanup();
    }
  });

  it("splits by agent, one state and one notification per agent", async () => {
    const add = await runCmd(alertCmd, sb, { action: "add", positionals: ["per-agent"], flags: { measure: "sessions", by: "agent", over: 1, window: "1d", notify: `webhook:${hook.url}` }, json: true });
    assert.equal(add.code, 0, String(add.error));
    const before = hook.posts.length;
    const r = await runCmd(alertCmd, sb, { action: "check", json: true });
    const res = (r.json as { alerts: { name: string; groups: { agent: string; state: string; value: number }[] }[] }).alerts.find((a) => a.name === "per-agent")!;
    assert.deepEqual(res.groups.map((g) => [g.agent, g.state, g.value]), [["claude-code", "ALERT", 2], ["codex", "OK", 1]]);
    const sent = hook.posts.slice(before).map((p) => JSON.parse(p.body));
    assert.deepEqual(sent.map((b) => [b.alert, b.state, b.by]), [["per-agent", "ALERT", { agent: "claude-code" }]]);
  });

  it("refuses bad usage and a name that exists", async () => {
    const dup = await runCmd(alertCmd, sb, { action: "add", positionals: ["failures"], flags: { measure: "cost", over: 1, window: "1d", notify: "command:true" } });
    assert.match(String(dup.error), /exists/);
    for (const flags of [
      { measure: "latency", over: 1, window: "1d", notify: "command:true" },
      { measure: "failure-rate", over: 2, window: "1d", notify: "command:true" },
      { measure: "cost", over: 1, warn: 5, window: "1d", notify: "command:true" },
      { measure: "cost", over: 1, window: "1d", notify: "email:me" },
      { measure: "cost", over: 1, window: "1d", notify: "command:true", where: "nope:(" },
      { measure: "cost", window: "1d", notify: "command:true" },
    ]) {
      const r = await runCmd(alertCmd, sb, { action: "add", positionals: ["bad"], flags });
      const usage = r.error instanceof UsageError || (r.error as { exitCode?: number } | undefined)?.exitCode === 2;
      assert.ok(usage, `${JSON.stringify(flags)}: ${String(r.error)}`);
    }
    assert.equal(loadAlerts(join(sb.env.CODING_SH_HOME!, "alerts.json")).alerts.some((a) => a.name === "bad"), false);
  });

  it("rm removes an alert", async () => {
    const r = await runCmd(alertCmd, sb, { action: "rm", positionals: ["per-agent"] });
    assert.equal(r.code, 0);
    const missing = await runCmd(alertCmd, sb, { action: "rm", positionals: ["per-agent"] });
    assert.match(String(missing.error), /No alert named/);
  });
});

describe("alert next steps", () => {
  // A sandbox with no SHELL or MSYSTEM is PowerShell or cmd on Windows, where only codingsh runs.
  const BIN = process.platform === "win32" ? "codingsh" : "coding.sh";
  it("name codingsh in PowerShell and coding.sh in Git Bash", async () => {
    for (const [extra, bin] of [[{}, BIN], [{ MSYSTEM: "MINGW64" }, "coding.sh"]] as const) {
      const sb = sandbox(extra);
      try {
        const empty = await runCmd(alertCmd, sb, { action: "list" });
        assert.ok(empty.stderr.includes(`${bin} alert add failures --measure failure-rate --over 0.5 --window 1d --notify webhook:https://example.com/hook`), empty.stderr);
        const added = await runCmd(alertCmd, sb, { action: "add", positionals: ["spend"], flags: { measure: "cost", over: 1, window: "1d", notify: "command:true" } });
        assert.ok(added.stderr.includes(`${bin} alert test spend`), added.stderr);
        const dup = await runCmd(alertCmd, sb, { action: "add", positionals: ["spend"], flags: { measure: "cost", over: 1, window: "1d", notify: "command:true" } });
        assert.deepEqual(dup.error?.next, ["Remove it first:", `${bin} alert rm spend`]);
        const missing = await runCmd(alertCmd, sb, { action: "rm", positionals: ["nope"] });
        assert.deepEqual(missing.error?.next, ["List the alerts:", `${bin} alert list`]);
      } finally {
        sb.cleanup();
      }
    }
  });
});

/** A session score, as `coding.sh score` writes one. */
function score(sessionId: string, name: string, dataType: Score["dataType"], value: Score["value"], ts: number): Score {
  return { id: `${sessionId}-${name}-${ts}`, target: "session", targetId: sessionId, sessionId, name, dataType, value, source: "judge", by: "test", ts };
}

describe("alert on a score (--measure score:<name> --under)", () => {
  let sb: Sandbox;
  let hook: Awaited<ReturnType<typeof listener>>;
  before(async () => {
    sb = sandbox();
    hook = await listener();
    const now = Date.now();
    await sb.seed([mkSession("h-1", now - 3_600_000), mkSession("h-2", now - 7_200_000, { agent: "codex" as never }), mkSession("h-3", now - 600_000), mkSession("h-old", now - 3 * 86_400_000)]);
    const index = await SqliteIndexStore.open(join(sb.env.CODING_SH_HOME!, "index.db"));
    try {
      for (const id of ["h-1", "h-2", "h-3"]) await index.putScore!(score(id, "helpful", "numeric", 0.2, now - 300_000));
      // Outside the window, another name, and a categorical value: none count.
      await index.putScore!(score("h-old", "helpful", "numeric", 1, now - 3 * 86_400_000 + 1000));
      await index.putScore!(score("h-1", "correct", "numeric", 1, now - 300_000));
      await index.putScore!(score("h-3", "helpful", "categorical", "yes", now - 200_000));
    } finally {
      await index.close();
    }
  });
  after(async () => {
    await close(hook.server);
    sb.cleanup();
  });

  it("posts one ALERT with the mean score and direction under", async () => {
    const add = await runCmd(alertCmd, sb, { action: "add", positionals: ["low"], flags: { measure: "score:helpful", under: 0.5, window: "1d", notify: `webhook:${hook.url}` }, json: true });
    assert.equal(add.error, undefined, String(add.error));
    assert.equal((add.json as { alert: AlertDef }).alert.direction, "under");
    const r = await runCmd(alertCmd, sb, { action: "check", json: true });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(hook.posts.length, 1);
    const body = JSON.parse(hook.posts[0]!.body);
    assert.equal(body.state, "ALERT");
    assert.ok(Math.abs(body.value - 0.2) < 1e-9, String(body.value));
    assert.equal(body.threshold, 0.5);
    assert.equal(body.direction, "under");
    assert.deepEqual(Object.keys(body), ["alert", "state", "previous", "value", "threshold", "direction", "window", "at"]);
    const human = await runCmd(alertCmd, sb, { action: "list" });
    assert.match(human.stdout, /< 0\.5/);
  });

  it("splits a score by agent; an over alert's body has no direction", async () => {
    const before = hook.posts.length;
    const add = await runCmd(alertCmd, sb, { action: "add", positionals: ["high"], flags: { measure: "score:helpful", over: 0.1, by: "agent", window: "1d", notify: `webhook:${hook.url}` }, json: true });
    assert.equal(add.code, 0, String(add.error));
    const r = await runCmd(alertCmd, sb, { action: "check", json: true });
    const res = (r.json as { alerts: { name: string; groups: { agent: string; value: number }[] }[] }).alerts.find((a) => a.name === "high")!;
    assert.deepEqual(res.groups.map((g) => [g.agent, g.value]), [["claude-code", 0.2], ["codex", 0.2]]);
    const sent = hook.posts.slice(before).map((p) => JSON.parse(p.body));
    assert.equal(sent.length, 2);
    for (const b of sent) assert.equal("direction" in b, false);
  });

  it("refuses --under with --over or --warn, and a --warn-under not above --under (exit 2)", async () => {
    for (const flags of [
      { measure: "score:helpful", under: 0.5, over: 1, window: "1d", notify: "command:true" },
      { measure: "score:helpful", under: 0.5, warn: 0.2, window: "1d", notify: "command:true" },
      { measure: "score:helpful", "warn-under": 0.7, over: 1, window: "1d", notify: "command:true" },
      { measure: "score:helpful", under: 0.5, "warn-under": 0.4, window: "1d", notify: "command:true" },
      { measure: "score:", under: 0.5, window: "1d", notify: "command:true" },
    ]) {
      const r = await runCmd(alertCmd, sb, { action: "add", positionals: ["bad"], flags });
      assert.ok(r.error instanceof UsageError, `${JSON.stringify(flags)}: ${String(r.error)}`);
    }
    const ok = await runCmd(alertCmd, sb, { action: "add", positionals: ["warned"], flags: { measure: "score:helpful", under: 0.5, "warn-under": 0.7, window: "1d", notify: "command:true" }, json: true });
    assert.equal(ok.code, 0, String(ok.error));
    assert.equal((ok.json as { alert: AlertDef }).alert.warn, 0.7);
  });
});

describe("score measure", () => {
  const now = Date.now();
  const def = (over: Partial<AlertDef> = {}): AlertDef => ({ name: "s", measure: "score:helpful", over: 0.5, direction: "under", window: "1d", notify: { kind: "command", command: "true" }, createdAt: 0, states: {}, delivery: { failures: 0 }, ...over });

  it("averages numeric and boolean session scores; null with sessions but no score", async () => {
    const index = new MemoryIndexStore();
    await index.upsertSession(mkSession("a", now - 1000));
    await index.upsertSession(mkSession("b", now - 2000));
    await index.upsertSession(mkSession("c", now - 3000, { agent: "codex" as never }));
    await index.putScore(score("a", "helpful", "boolean", true, now - 500));
    await index.putScore(score("b", "helpful", "numeric", 0.5, now - 500));
    await index.putScore(score("b", "helpful", "text", "fine", now - 400));
    const r = await readMeasure(index, def(), now);
    assert.equal(r.values.get(""), 0.75);
    const byAgent = await readMeasure(index, def({ by: "agent" }), now);
    assert.deepEqual([...byAgent.values].sort(), [["claude-code", 0.75], ["codex", null]]);
    const where = await readMeasure(index, def({ where: "agent:codex" }), now);
    assert.equal(where.values.get(""), null);
  });
});

describe("alert check with a broken target", () => {
  it("turns the target off after 5 failed deliveries, says so in list, and alert test turns it back on", async () => {
    const sb = sandbox();
    let status = 500;
    const hook = await listener(() => status);
    try {
      await sb.seed([mkSession("s1", Date.now() - 60_000, { flags: ["error-exit"] })]);
      const add = await runCmd(alertCmd, sb, { action: "add", positionals: ["f"], flags: { measure: "failure-rate", over: 0.5, window: "1h", notify: `webhook:${hook.url}` }, json: true });
      assert.equal(add.code, 0);
      const file = join(sb.env.CODING_SH_HOME!, "alerts.json");
      // Four failures recorded already: the next failed delivery is the fifth in a row.
      const doc = JSON.parse(readFileSync(file, "utf8"));
      doc.alerts[0].delivery = { failures: MAX_FAILED_DELIVERIES - 1, lastError: "earlier" };
      writeFileSync(file, JSON.stringify(doc));
      const r = await runCmd(alertCmd, sb, { action: "check", json: true });
      assert.equal(r.code, 0);
      const res = (r.json as { alerts: { failed: number; disabled: boolean; deliveryError: string }[] }).alerts[0]!;
      assert.equal(res.failed, 1);
      assert.equal(res.disabled, true);
      assert.match(res.deliveryError, /500/);
      assert.equal(hook.posts.length, 3, "3 tries");
      const list = await runCmd(alertCmd, sb, { action: "list" });
      assert.match(list.stdout, /\(disabled\)/);
      assert.match(list.stderr + list.stdout, /notifications are off after 5 failed deliveries/);

      const failedTest = await runCmd(alertCmd, sb, { action: "test", positionals: ["f"] });
      assert.match(String(failedTest.error), /failed after 3 tries/);
      status = 200;
      const ok = await runCmd(alertCmd, sb, { action: "test", positionals: ["f"], json: true });
      assert.equal(ok.code, 0, String(ok.error));
      assert.equal((ok.json as { reenabled: boolean }).reenabled, true);
      assert.equal(JSON.parse(hook.posts.at(-1)!.body).test, true);
      assert.equal(loadAlerts(file).alerts[0]!.delivery.disabledAt, undefined);
    } finally {
      await close(hook.server);
      sb.cleanup();
    }
  });

  // One failed session in the last hour: the first check moves the alert from OK to ALERT.
  async function brokenTarget(url: string): Promise<{ dir: string; file: string; index: MemoryIndexStore }> {
    const dir = mkdtempSync(join(tmpdir(), "alerts-resend-"));
    const file = join(dir, "alerts.json");
    const index = new MemoryIndexStore();
    await index.upsertSession(mkSession("s1", Date.now() - 60_000, { flags: ["error-exit"] }));
    const def: AlertDef = { name: "f", measure: "failure-rate", over: 0.5, window: "1h", notify: { kind: "webhook", url }, createdAt: 0, states: {}, delivery: { failures: 0 } };
    await saveAlerts(file, { v: 1, alerts: [def] });
    return { dir, file, index };
  }

  it("sends a change that was not delivered again on the next check, and keeps the new state", async () => {
    let status = 500;
    const hook = await listener(() => status);
    const t = await brokenTarget(hook.url);
    try {
      const first = (await runAlertChecks({ file: t.file, index: t.index, backoffMs: 1 }))[0]!;
      assert.deepEqual([first.state, first.failed, first.notified, hook.posts.length], ["ALERT", 1, 0, 3]);
      // alert list shows the state the alert is in, and when it entered it.
      const saved = loadAlerts(t.file).alerts[0]!.states[""]!;
      assert.deepEqual([saved.state, saved.lastDelivered], ["ALERT", "OK"]);
      const since = saved.since;

      status = 200;
      const second = (await runAlertChecks({ file: t.file, index: t.index, backoffMs: 1 }))[0]!;
      assert.deepEqual([second.notified, second.failed, hook.posts.length], [1, 0, 4]);
      assert.deepEqual(second.groups.map((g) => [g.state, g.previous, g.changed, g.lastDelivered]), [["ALERT", "ALERT", false, "OK"]]);
      const body = JSON.parse(hook.posts[3]!.body);
      assert.deepEqual([body.state, body.previous, body.test], ["ALERT", "OK", undefined]);
      const later = loadAlerts(t.file).alerts[0]!.states[""]!;
      assert.deepEqual([later.state, later.since, later.lastDelivered], ["ALERT", since, undefined]);

      const third = (await runAlertChecks({ file: t.file, index: t.index, backoffMs: 1 }))[0]!;
      assert.deepEqual([third.notified, hook.posts.length], [0, 4], "delivered once: not sent a third time");
    } finally {
      await close(hook.server);
      removeTestDir(t.dir);
    }
  });

  it("tells the target the change from the state it last got, and nothing once the state is back there", async () => {
    let status = 500;
    const hook = await listener(() => status);
    const dir = mkdtempSync(join(tmpdir(), "alerts-resend-"));
    const file = join(dir, "alerts.json");
    const index = new MemoryIndexStore();
    const now = Date.now();
    const later = now + 2 * 3_600_000;
    try {
      for (const id of ["s1", "s2"]) await index.upsertSession(mkSession(id, now - 60_000));
      await saveAlerts(file, { v: 1, alerts: [{ name: "n", measure: "sessions", warn: 1, over: 2, window: "1h", noData: "ok", notify: { kind: "webhook", url: hook.url }, createdAt: 0, states: {}, delivery: { failures: 0 } }] });
      const check = async (at: number) => (await runAlertChecks({ file, index, now: at, backoffMs: 1 }))[0]!;
      // OK to WARNING, not delivered; then WARNING to ALERT: the target still has OK.
      assert.deepEqual([(await check(now)).failed, hook.posts.length], [1, 3]);
      await index.upsertSession(mkSession("s3", now - 60_000));
      status = 200;
      const moved = await check(now);
      assert.deepEqual(moved.groups.map((g) => [g.state, g.previous, g.lastDelivered]), [["ALERT", "WARNING", "OK"]]);
      assert.deepEqual([moved.notified, JSON.parse(hook.posts.at(-1)!.body).previous, hook.posts.length], [1, "OK", 4]);

      // Two hours on the window is empty: ALERT to OK, not delivered. Back at ALERT, the
      // state the target has, there is nothing to send.
      status = 500;
      assert.deepEqual([(await check(later)).state, hook.posts.length], ["OK", 7]);
      for (const id of ["s4", "s5", "s6"]) await index.upsertSession(mkSession(id, later - 60_000));
      const back = await check(later);
      assert.deepEqual([back.state, back.notified, back.failed, hook.posts.length], ["ALERT", 0, 0, 7]);
      assert.equal(back.groups[0]!.lastDelivered, undefined);
      assert.equal(loadAlerts(file).alerts[0]!.states[""]!.lastDelivered, undefined);
    } finally {
      await close(hook.server);
      removeTestDir(dir);
    }
  });

  it("alert check says which change it sends again", async () => {
    const sb = sandbox();
    const hook = await listener();
    try {
      await sb.seed([mkSession("s1", Date.now() - 60_000, { flags: ["error-exit"] })]);
      const add = await runCmd(alertCmd, sb, { action: "add", positionals: ["f"], flags: { measure: "failure-rate", over: 0.5, window: "1h", notify: `webhook:${hook.url}` }, json: true });
      assert.equal(add.code, 0);
      // An earlier check moved the alert to ALERT and could not deliver it.
      const file = join(sb.env.CODING_SH_HOME!, "alerts.json");
      const doc = JSON.parse(readFileSync(file, "utf8"));
      doc.alerts[0].states = { "": { state: "ALERT", value: 1, since: Date.now() - 60_000, checkedAt: Date.now() - 60_000, lastDelivered: "OK" } };
      doc.alerts[0].delivery = { failures: 1, lastError: "POST → 500" };
      writeFileSync(file, JSON.stringify(doc));
      const r = await runCmd(alertCmd, sb, { action: "check" });
      assert.equal(r.code, 0, String(r.error));
      assert.match(r.stdout, /^f\s+ALERT\s.*\swas OK \(not delivered before\)$/m);
      assert.match(r.stderr + r.stdout, /Sent 1 notification\./);
      assert.deepEqual(hook.posts.map((p) => [JSON.parse(p.body).state, JSON.parse(p.body).previous]), [["ALERT", "OK"]]);
    } finally {
      await close(hook.server);
      sb.cleanup();
    }
  });

  it("stops sending a change again at the cut-off when the receiver never answers", async () => {
    let requests = 0;
    // Takes each POST and never answers it: each try times out.
    const server = createServer(() => void requests++);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const t = await brokenTarget(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`);
    try {
      const results = [];
      for (let i = 0; i < MAX_FAILED_DELIVERIES + 2; i++) results.push((await runAlertChecks({ file: t.file, index: t.index, backoffMs: 1, timeoutMs: 100 }))[0]!);
      assert.deepEqual(
        results.map((r) => [r.failed, r.skipped, r.disabled]),
        [...Array.from({ length: MAX_FAILED_DELIVERIES - 1 }, () => [1, 0, false]), [1, 0, true], [0, 1, true], [0, 1, true]],
      );
      assert.equal(requests, MAX_FAILED_DELIVERIES * 3, "3 tries a check until the target is turned off, then none");
      assert.match(results[0]!.deliveryError ?? "", /timed out/);
      const def = loadAlerts(t.file).alerts[0]!;
      assert.deepEqual([def.states[""]!.state, def.states[""]!.lastDelivered, def.delivery.failures], ["ALERT", "OK", MAX_FAILED_DELIVERIES]);
    } finally {
      server.closeAllConnections();
      await close(server);
      removeTestDir(t.dir);
    }
  });

  it("alert check exits 0 when there are no alerts or alerts.json is unreadable", async () => {
    const sb = sandbox();
    try {
      const none = await runCmd(alertCmd, sb, { action: "check", json: true });
      assert.equal(none.code, 0);
      assert.deepEqual(none.json, { alerts: [] });
      await sb.seed([]);
      writeFileSync(join(sb.env.CODING_SH_HOME!, "alerts.json"), "{not json");
      const bad = await runCmd(alertCmd, sb, { action: "check", json: true });
      assert.equal(bad.code, 0);
      assert.ok((bad.json as { error?: string }).error);
    } finally {
      sb.cleanup();
    }
  });
});

describe("alert parts", () => {
  const def = { over: 10, warn: 5 } as Pick<AlertDef, "over" | "warn" | "noData">;
  it("classifies values against --warn and --over, and no data by --no-data", () => {
    assert.equal(classify(def, 11, "OK"), "ALERT");
    assert.equal(classify(def, 10, "OK"), "WARNING");
    assert.equal(classify(def, 5, "OK"), "OK");
    assert.equal(classify(def, null, "ALERT"), "NO_DATA");
    assert.equal(classify({ ...def, noData: "ok" }, null, "ALERT"), "OK");
    assert.equal(classify({ ...def, noData: "alert" }, null, "OK"), "ALERT");
    assert.equal(classify({ ...def, noData: "keep" }, null, "WARNING"), "WARNING");
  });

  it("classifies an under alert below its thresholds", () => {
    const under = { over: 0.5, warn: 0.7, direction: "under" } as Pick<AlertDef, "over" | "warn" | "noData" | "direction">;
    assert.equal(classify(under, 0.2, "OK"), "ALERT");
    assert.equal(classify(under, 0.5, "OK"), "WARNING");
    assert.equal(classify(under, 0.7, "OK"), "OK");
    assert.equal(classify(under, null, "OK"), "NO_DATA");
  });

  it("parses measures", () => {
    assert.deepEqual(parseMeasure("cost"), { kind: "cost" });
    assert.deepEqual(parseMeasure("flag:repeated-tool-failure"), { kind: "flag", flag: "repeated-tool-failure" });
    assert.equal(parseMeasure("flag:"), undefined);
    assert.equal(parseMeasure("tokens"), undefined);
    assert.deepEqual(parseMeasure("score:helpful"), { kind: "score", name: "helpful" });
    assert.equal(parseMeasure("score: "), undefined);
  });

  // On Windows cmd.exe runs a command target, and notify-send is not there.
  it("an empty --notify command: gives an example that runs where the CLI runs", () => {
    const usage = (platform: NodeJS.Platform) => {
      try {
        alertCmd.parseTarget("command: ", platform);
      } catch (e) {
        assert.ok(e instanceof UsageError);
        return e.message;
      }
      assert.fail("no usage error");
    };
    assert.equal(usage("win32"), '--notify command: needs a command, e.g. command:"node C:\\alerts\\notify.mjs"');
    assert.equal(usage("linux"), '--notify command: needs a command, e.g. command:"notify-send coding.sh"');
    assert.equal(usage("darwin"), usage("linux"));
  });

  it("alert add --help shows a command target for Windows beside the notify-send one", () => {
    const alert = findCommand("alert")!;
    const help = commandHelp(alert, alert.actions!.find((a) => a.name === "add"), { heading: (s) => s, bold: (s) => s, faint: (s) => s });
    const examples = help.slice(help.indexOf("\nExamples\n")).split("\n");
    const at = (re: RegExp) => examples.findIndex((l) => re.test(l));
    assert.ok(at(/--notify command:"notify-send coding\.sh"$/) > 0, help);
    assert.equal(at(/--notify "command:node C:\\alerts\\notify\.mjs"$/), at(/notify-send/) + 1, help);
  });

  it("disables a target on the 5th failure in a row and resets on a success", () => {
    const a = { delivery: { failures: 0 } } as AlertDef;
    for (let i = 0; i < MAX_FAILED_DELIVERIES - 1; i++) recordDelivery(a, { ok: false, error: "x" }, 1);
    assert.equal(a.delivery.disabledAt, undefined);
    recordDelivery(a, { ok: false, error: "x" }, 2);
    assert.equal(a.delivery.disabledAt, 2);
    recordDelivery(a, { ok: true }, 3);
    assert.deepEqual(a.delivery, { failures: 0, lastOkAt: 3 });
  });

  it("retries a webhook with backoff and stops at the first success", async () => {
    let calls = 0;
    const fakeFetch = (async () => new Response(null, { status: ++calls < 3 ? 503 : 204 })) as typeof fetch;
    const d = await deliver({ kind: "webhook", url: "http://127.0.0.1:9/x" }, { alert: "a", state: "ALERT", previous: "OK", value: 1, threshold: 0, window: "1h", at: new Date(0).toISOString() }, { fetch: fakeFetch, backoffMs: 1 });
    assert.deepEqual(d, { ok: true, attempts: 3 });
    assert.match(signBody("k", "{}"), /^sha256=[0-9a-f]{64}$/);
  });

  it('signs the body alone, as before, and "<timestamp>.<body>" with the time it is sent', () => {
    const hmac = (data: string) => `sha256=${createHmac("sha256", "k").update(data).digest("hex")}`;
    assert.deepEqual(signatureHeaders("k", '{"a":1}', 1_700_000_000_999), {
      "X-Coding-Sh-Signature": hmac('{"a":1}'),
      "X-Coding-Sh-Timestamp": "1700000000",
      "X-Coding-Sh-Signature-V2": hmac('1700000000.{"a":1}'),
    });
  });

  it("gives a command the payload on stdin and fails on a non-zero exit", async () => {
    const sb = sandbox();
    try {
      const out = join(sb.root, "payload.json");
      const node = JSON.stringify(process.execPath);
      const script = JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(out)}, require('fs').readFileSync(0))`);
      const payload = { alert: "a", state: "ALERT" as const, previous: "OK" as const, value: 2, threshold: 1, window: "1d", at: new Date(0).toISOString() };
      const ok = await deliver({ kind: "command", command: `${node} -e ${script}` }, payload, { backoffMs: 1 });
      assert.deepEqual(ok, { ok: true, attempts: 1 });
      assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), payload);
      const bad = await deliver({ kind: "command", command: `${node} -e "process.exit(3)"` }, payload, { backoffMs: 1 });
      assert.equal(bad.ok, false);
      assert.equal(bad.attempts, 3);
      assert.match(bad.error!, /exited 3/);
    } finally {
      sb.cleanup();
    }
  });

  it("a failed command's error keeps the message cmd and PowerShell print first, not only the last line", async () => {
    const sb = sandbox();
    try {
      // What cmd prints for a program it can't find: the last line alone does not name it.
      const notFound = "'notify-send' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n";
      const file = join(sb.root, "fail.js");
      writeFileSync(file, `process.stderr.write(${JSON.stringify(notFound)}); process.exit(1);`);
      const payload = { alert: "a", state: "ALERT" as const, previous: "OK" as const, value: 2, threshold: 1, window: "1d", at: new Date(0).toISOString() };
      const d = await deliver({ kind: "command", command: `"${process.execPath}" "${file}"` }, payload, { backoffMs: 1, timeoutMs: 30_000 });
      assert.equal(d.error, "command exited 1: 'notify-send' is not recognized as an internal or external command, operable program or batch file.");
    } finally {
      sb.cleanup();
    }
  });

  it("a failed command's error keeps the last line of a long stderr, where a Python traceback names the problem", async () => {
    const sb = sandbox();
    try {
      // A deep traceback, longer than one read of the pipe, then the message on its own write.
      const frames = Array.from({ length: 3000 }, (_, i) => `  File "/work/demo/notify.py", line ${i + 1}, in step${i}\n`).join("");
      const file = join(sb.root, "fail.js");
      writeFileSync(file, `process.stderr.write(${JSON.stringify(`Traceback (most recent call last):\n${frames}`)}); setTimeout(() => { process.stderr.write("ValueError: no webhook set\\n"); process.exitCode = 1; }, 50);`);
      const payload = { alert: "a", state: "ALERT" as const, previous: "OK" as const, value: 2, threshold: 1, window: "1d", at: new Date(0).toISOString() };
      const d = await deliver({ kind: "command", command: `"${process.execPath}" "${file}"` }, payload, { backoffMs: 1, timeoutMs: 30_000 });
      assert.equal(d.error, "command exited 1: Traceback (most recent call last): … ValueError: no webhook set");
    } finally {
      sb.cleanup();
    }
  });

  it("stderrLine keeps all of a short stderr, and the first and last lines of a long one", () => {
    // PowerShell 5.1's Write-Error: the message, then the error record.
    const ps = "Write-Error boom; exit 3 : boom\r\n    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException\r\n    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException\r\n \r\n";
    assert.equal(stderrLine(ps), "Write-Error boom; exit 3 : boom + CategoryInfo : NotSpecified: (:) [Write-Error], WriteErrorException + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException");
    const traceback = ["Traceback (most recent call last):", ...Array.from({ length: 6 }, (_, i) => `  File "/work/demo/notify.py", line ${i + 1}, in step${i}`), "ValueError: no webhook set"].join("\n");
    assert.equal(stderrLine(traceback), "Traceback (most recent call last): … ValueError: no webhook set");
    assert.equal(stderrLine("x".repeat(300)), "x".repeat(200));
    assert.equal(stderrLine(" \r\n"), "");
  });
});
