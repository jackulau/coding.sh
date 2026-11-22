// `coding.sh proxy --enforce-budget`: a billed call a budget over its limit applies to
// gets a 429 in its vendor's error shape, with Retry-After, and never reaches the
// upstream. Without the flag (no guard) the same call goes through.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { statusOf, type Budget, type BudgetStatus } from "../../src/budget/index.ts";
import { budgetGuard } from "../../src/proxy/budget.ts";
import { startProxy, type ProxyServer } from "../../src/proxy/server.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { mkSession } from "../cli/_cmd.ts";
import { cleanup, runLive, runSync, tmpHome } from "../cli/_run-cli.ts";
import { anthropicStream, call, startUpstream, type Upstream } from "./_helpers.ts";

const open: { close(): Promise<void> }[] = [];
after(async () => {
  for (const o of open) await o.close();
  cleanup();
});

const HOUR = 3_600_000;
const budget = (b: Partial<Budget> = {}): Budget => ({ id: "day", period: "day", limitUsd: 1, createdAt: 0, ...b });
/** A status `spend` against `b`, resetting in an hour (statusOf takes the period end from now). */
function over(b: Budget, spend: number, now: number): BudgetStatus {
  return { ...statusOf(b, spend, 1, now), resetsAt: now + HOUR };
}

async function upstream(): Promise<Upstream> {
  const up = await startUpstream((req, res) => {
    if (req.url.includes("chat/completions")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const s of anthropicStream({ text: "ok" })) res.write(s);
    res.end();
  });
  open.push(up);
  return up;
}

async function proxy(up: Upstream, load?: (now: number) => Promise<BudgetStatus[]>, extra: { errors?: Error[]; now?: () => number } = {}): Promise<ProxyServer> {
  const p = await startProxy({
    port: 0,
    upstreams: { anthropic: up.url, openai: up.url },
    budget: load ? budgetGuard({ load, now: extra.now, onError: (e) => extra.errors?.push(e) }) : undefined,
    onError: (e) => extra.errors?.push(e),
  });
  open.push(p);
  return p;
}

const messages = JSON.stringify({ model: "claude-sonnet-4-5", stream: true, max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
const anthropicHeaders = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-x" };
const claudeCode = { ...anthropicHeaders, "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555" };

describe("proxy budget guard", () => {
  test("an over budget answers 429 with Retry-After and an Anthropic error; the upstream is never called", async () => {
    const up = await upstream();
    const p = await proxy(up, async (now) => [over(budget(), 1.5, now)]);
    const r = await call(p.url, { path: "/v1/messages", body: messages, headers: anthropicHeaders });
    assert.equal(r.status, 429);
    const retry = Number(r.headers["retry-after"]);
    assert.ok(retry > 3500 && retry <= 3600, String(r.headers["retry-after"]));
    // The Anthropic and OpenAI SDKs retry a 429 unless told not to, and the Anthropic one sleeps the whole Retry-After first.
    assert.equal(r.headers["x-should-retry"], "false");
    const body = JSON.parse(r.body.toString());
    assert.equal(body.type, "error");
    assert.equal(body.error.type, "rate_limit_error");
    assert.match(body.error.message, /budget "day" \(day\) is over its limit: \$1\.50 spent of \$1\.00 \(estimated\)\. It resets at /);
    assert.equal(body.error.budget.id, "day");
    assert.equal(body.error.budget.limitUsd, 1);
    assert.ok(Date.parse(body.error.budget.resetsAt) > Date.now());
    assert.equal(up.seen.length, 0);
  });

  test("without a guard the same call goes through", async () => {
    const up = await upstream();
    const p = await proxy(up);
    const r = await call(p.url, { path: "/v1/messages", body: messages, headers: anthropicHeaders });
    assert.equal(r.status, 200);
    assert.equal(up.seen.length, 1);
  });

  test("an OpenAI call gets OpenAI's error shape", async () => {
    const up = await upstream();
    const p = await proxy(up, async (now) => [over(budget({ id: "week", period: "week", limitUsd: 10 }), 12, now)]);
    const r = await call(p.url, { path: "/v1/chat/completions", body: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "hi" }] }), headers: { "content-type": "application/json", authorization: "Bearer sk-x" } });
    assert.equal(r.status, 429);
    const body = JSON.parse(r.body.toString());
    assert.equal(body.error.type, "insufficient_quota");
    assert.equal(body.error.code, "spend_limit_exceeded");
    assert.equal(body.error.budget.id, "week");
    assert.match(body.error.message, /\$12\.00 spent of \$10\.00/);
    assert.equal(r.headers["x-should-retry"], "false");
    assert.equal(up.seen.length, 0);
  });

  test("only budgets that apply block: another agent's, a repo's and one under its limit do not", async () => {
    const up = await upstream();
    const p = await proxy(up, async (now) => [over(budget({ id: "day-codex", agent: "codex" }), 5, now), over(budget({ id: "day-web", repo: "web" }), 5, now), over(budget({ id: "all", limitUsd: 10 }), 5, now)]);
    let r = await call(p.url, { path: "/v1/messages", body: messages, headers: claudeCode });
    assert.equal(r.status, 200);
    // A Codex call is the codex budget's.
    r = await call(p.url, { path: "/v1/responses", body: JSON.stringify({ model: "gpt-5", input: "hi" }), headers: { "content-type": "application/json", authorization: "Bearer sk-x", originator: "codex_cli_rs" } });
    assert.equal(r.status, 429);
    assert.equal(JSON.parse(r.body.toString()).error.budget.agent, "codex");
    assert.equal(up.seen.length, 1);
  });

  test("count_tokens is not billed and goes through", async () => {
    const up = await upstream();
    const p = await proxy(up, async (now) => [over(budget(), 2, now)]);
    const r = await call(p.url, { path: "/v1/messages/count_tokens", body: messages, headers: anthropicHeaders });
    assert.notEqual(r.status, 429);
    assert.equal(up.seen.length, 1);
  });

  test("spend is read at most every 30 s", async () => {
    const up = await upstream();
    let t = Date.now();
    let loads = 0;
    let spend = 0.5;
    const p = await proxy(up, async (now) => (loads++, [over(budget(), spend, now)]), { now: () => t });
    assert.equal((await call(p.url, { path: "/v1/messages", body: messages, headers: anthropicHeaders })).status, 200);
    spend = 2;
    t += 10_000;
    assert.equal((await call(p.url, { path: "/v1/messages", body: messages, headers: anthropicHeaders })).status, 200, "still the spend read 10 s ago");
    assert.equal(loads, 1);
    t += 25_000;
    assert.equal((await call(p.url, { path: "/v1/messages", body: messages, headers: anthropicHeaders })).status, 429);
    assert.equal(loads, 2);
  });

  test("spend that can't be read never stops a call", async () => {
    const up = await upstream();
    const errors: Error[] = [];
    const p = await proxy(
      up,
      async () => {
        throw new Error("store gone");
      },
      { errors },
    );
    const r = await call(p.url, { path: "/v1/messages", body: messages, headers: anthropicHeaders });
    assert.equal(r.status, 200);
    assert.equal(up.seen.length, 1);
    assert.ok(errors.some((e) => /store gone/.test(e.message)));
  });

  test("a read that fails stops no call and is tried again 30 s on, not on every call", async () => {
    const up = await upstream();
    const errors: Error[] = [];
    let t = Date.now();
    let loads = 0;
    let fail = false;
    const p = await proxy(
      up,
      async (now) => {
        loads++;
        if (fail) throw new Error("budgets.json has no budgets list");
        return [over(budget(), 2, now)];
      },
      { errors, now: () => t },
    );
    const send = async () => (await call(p.url, { path: "/v1/messages", body: messages, headers: anthropicHeaders })).status;
    assert.equal(await send(), 429);
    fail = true;
    t += 31_000;
    assert.deepEqual([await send(), await send(), await send()], [200, 200, 200], "nor does the spend read before the failure");
    assert.equal(loads, 2, "the failed read is kept for 30 s");
    assert.deepEqual(errors.map((e) => e.message), ["budgets can't be read, so none stops a call for 30 s: budgets.json has no budgets list"], "once a read, not once a call");
    fail = false;
    t += 31_000;
    assert.equal(await send(), 429);
    assert.equal(loads, 3);
  });

  test("a budget whose spend can't be read stops no call and is named once a read; one over its limit still blocks", async () => {
    const up = await upstream();
    const errors: Error[] = [];
    let t = Date.now();
    const unread = (now: number): BudgetStatus => ({ ...statusOf(budget(), 0, 0, now), resetsAt: now + HOUR, error: "store gone" });
    const p = await proxy(up, async (now) => [unread(now), over(budget({ id: "week", period: "week", limitUsd: 10 }), 12, now)], { errors, now: () => t });
    const send = () => call(p.url, { path: "/v1/messages", body: messages, headers: anthropicHeaders });
    const r = await send();
    assert.equal(r.status, 429);
    assert.equal(JSON.parse(r.body.toString()).error.budget.id, "week");
    assert.equal((await send()).status, 429);
    assert.deepEqual(errors.map((e) => e.message), ["budget day can't be read, so it stops no call: store gone"], "once a read, not once a call");
    t += 31_000;
    assert.equal((await send()).status, 429);
    assert.equal(errors.length, 2);
    assert.equal(up.seen.length, 0);
  });
});

describe("coding.sh proxy --enforce-budget (CLI)", () => {
  test("blocks a call over `budget set day 1` with 429 and Retry-After; without the flag it goes through", async () => {
    const up = await upstream();
    const h = tmpHome({ CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_UPDATE_CHECK: "1" });
    const index = await SqliteIndexStore.open(join(h.env.CODING_SH_HOME!, "index.db"));
    await index.migrate();
    await index.upsertSession(mkSession("s1", Date.now() - 60_000, { stats: { usage: { inputTokens: 1, outputTokens: 1, costUsd: 1.4, estimatedCostUsd: 1.4 } } }));
    await index.close();
    const set = runSync(["budget", "set", "day", "1"], h.env);
    assert.equal(set.status, 0, set.stderr);

    const url = async (args: string[]) => {
      const live = runLive(["proxy", "--port", "0", "--anthropic-upstream", up.url, ...args], h.env);
      const line = await live.waitFor(/http:\/\/127\.0\.0\.1:\d+/);
      return { live, url: line };
    };
    const enforced = await url(["--enforce-budget"]);
    await enforced.live.waitFor(/Enforcing budgets/);
    const r = await call(enforced.url, { path: "/v1/messages", body: messages, headers: anthropicHeaders });
    assert.equal(r.status, 429, r.body.toString());
    assert.ok(Number(r.headers["retry-after"]) >= 1);
    assert.match(JSON.parse(r.body.toString()).error.message, /budget "day"/);
    assert.equal(up.seen.length, 0, "the upstream stub is never reached");
    enforced.live.child.kill();

    const plain = await url([]);
    const ok = await call(plain.url, { path: "/v1/messages", body: messages, headers: anthropicHeaders });
    assert.equal(ok.status, 200);
    assert.equal(up.seen.length, 1);
    plain.live.child.kill();
  });

  test("never reads a --where budget: one whose query no longer parses is not named, and the day budget over its limit blocks", async () => {
    const up = await upstream();
    const h = tmpHome({ CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_UPDATE_CHECK: "1" });
    const index = await SqliteIndexStore.open(join(h.env.CODING_SH_HOME!, "index.db"));
    await index.migrate();
    await index.upsertSession(mkSession("s1", Date.now() - 60_000, { stats: { usage: { inputTokens: 1, outputTokens: 1, costUsd: 1.4, estimatedCostUsd: 1.4 } } }));
    await index.close();
    // A query stored before the grammar changed: reading its spend would fail.
    const budgets = [
      { id: "day-w0ld000", period: "day", limitUsd: 1, where: "bogus:1", createdAt: 0 },
      { id: "day", period: "day", limitUsd: 1, createdAt: 0 },
    ];
    writeFileSync(join(h.env.CODING_SH_HOME!, "budgets.json"), JSON.stringify({ budgets }));
    const live = runLive(["proxy", "--port", "0", "--anthropic-upstream", up.url, "--enforce-budget"], h.env);
    const url = await live.waitFor(/http:\/\/127\.0\.0\.1:\d+/);
    await live.waitFor(/Enforcing budgets/);
    const r = await call(url, { path: "/v1/messages", body: messages, headers: anthropicHeaders });
    assert.equal(r.status, 429, r.body.toString());
    assert.match(JSON.parse(r.body.toString()).error.message, /budget "day"/);
    // The block's line comes after anything the read printed.
    await live.waitFor(/blocked a call/);
    assert.doesNotMatch(live.err.join(""), /day-w0ld000|bogus/);
    assert.equal(up.seen.length, 0);
    live.child.kill();
  });

  test("a budgets.json that stops parsing while the proxy runs is read once in 30 s and stops no call", async () => {
    const up = await upstream();
    const h = tmpHome({ CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_UPDATE_CHECK: "1" });
    const set = runSync(["budget", "set", "day", "1"], h.env);
    assert.equal(set.status, 0, set.stderr);
    const live = runLive(["proxy", "--port", "0", "--anthropic-upstream", up.url, "--enforce-budget"], h.env);
    const url = await live.waitFor(/http:\/\/127\.0\.0\.1:\d+/);
    await live.waitFor(/Enforcing budgets/);
    writeFileSync(join(h.env.CODING_SH_HOME!, "budgets.json"), JSON.stringify({ nope: 1 }));
    for (let i = 0; i < 3; i++) assert.equal((await call(url, { path: "/v1/messages", body: messages, headers: anthropicHeaders })).status, 200);
    assert.equal(up.seen.length, 3);
    const lines = (re: RegExp) => live.err.join("").split("\n").filter((l) => re.test(l));
    // Each call's line comes after anything its budget check printed.
    for (let i = 0; i < 400 && lines(/ messages \S+ 200 /).length < 3; i++) await sleep(25);
    assert.equal(lines(/ messages \S+ 200 /).length, 3, live.err.join(""));
    const failed = lines(/has no "budgets" list/);
    assert.equal(failed.length, 1, live.err.join(""));
    assert.match(failed[0]!, /budgets can't be read, so none stops a call for 30 s: /);
    live.child.kill();
  });
});
