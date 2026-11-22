import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { UsageError } from "../../src/cli/args.ts";
import * as alertCmd from "../../src/cli/commands/alert.ts";
import { classify, recordDelivery } from "../../src/alerts/check.ts";
import { parseMeasure, readMeasure } from "../../src/alerts/measure.ts";
import { deliver, signBody } from "../../src/alerts/notify.ts";
import { type AlertDef, loadAlerts, MAX_FAILED_DELIVERIES } from "../../src/alerts/store.ts";
import type { Score } from "../../src/core/types.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { mkSession, runCmd, type Sandbox, sandbox } from "../cli/_cmd.ts";

interface Post {
  body: string;
  signature: string | undefined;
}

/** A local webhook: records each POST and answers `status()`. */
function listener(status: () => number = () => 200): Promise<{ server: Server; url: string; posts: Post[] }> {
  const posts: Post[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      posts.push({ body, signature: req.headers["x-coding-sh-signature"] as string | undefined });
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
});
