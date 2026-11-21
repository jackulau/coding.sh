// Spend budgets (src/budget): period bounds in local time, ids, the spend sum, the
// status line's part and its 60 s cache for week and month totals.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { budgetPart, budgetStatus, periodEnd, periodStart, readBudgets, rolledSpend, spendOf, statuslineBudget, statuslineStatuses, statusOf, upsertBudget, writeBudgets, type Budget } from "../../src/budget/index.ts";
import * as budgetCmd from "../../src/cli/commands/budget.ts";
import type { AgentEvent, IndexStore } from "../../src/core/types.ts";
import { budgetGuard } from "../../src/proxy/budget.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { mkSession, runCmd, sandbox } from "../cli/_cmd.ts";
import { removeTestDir } from "../_rm.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) removeTestDir(r);
});
function home(): NodeJS.ProcessEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-budget-")));
  roots.push(root);
  return { HOME: root, USERPROFILE: root, CODING_SH_HOME: join(root, ".coding.sh") };
}

const priced = (id: string, at: number, costUsd: number, extra: Parameters<typeof mkSession>[2] = {}) => mkSession(id, at, { ...extra, stats: { usage: { inputTokens: 1000, outputTokens: 100, costUsd, estimatedCostUsd: costUsd } } });
const budget = (b: Partial<Budget> = {}): Budget => ({ id: "day", period: "day", limitUsd: 1, createdAt: 0, ...b });

describe("periods", () => {
  // Wednesday 2026-11-18 15:30 local time.
  const now = new Date(2026, 10, 18, 15, 30).getTime();
  test("a day starts at local midnight and resets at the next one", () => {
    assert.equal(periodStart("day", now), new Date(2026, 10, 18).getTime());
    assert.equal(periodEnd("day", now), new Date(2026, 10, 19).getTime());
  });
  test("a week starts on Monday", () => {
    assert.equal(periodStart("week", now), new Date(2026, 10, 16).getTime());
    assert.equal(periodEnd("week", now), new Date(2026, 10, 23).getTime());
    // A Sunday belongs to the week that started six days before.
    const sunday = new Date(2026, 10, 22, 23, 0).getTime();
    assert.equal(periodStart("week", sunday), new Date(2026, 10, 16).getTime());
  });
  test("a month starts on the 1st and resets on the next 1st, across a year", () => {
    assert.equal(periodStart("month", now), new Date(2026, 10, 1).getTime());
    const dec = new Date(2026, 11, 31, 12).getTime();
    assert.equal(periodEnd("month", dec), new Date(2027, 0, 1).getTime());
  });
});

describe("budgets.json", () => {
  test("ids name the scope; the same scope updates its limit in place", () => {
    let r = upsertBudget([], { period: "day", limitUsd: 5 });
    assert.equal(r.budget.id, "day");
    r = upsertBudget(r.budgets, { period: "week", limitUsd: 50, agent: "codex" });
    assert.equal(r.budget.id, "week-codex");
    r = upsertBudget(r.budgets, { period: "day", limitUsd: 9 });
    assert.equal(r.replaced, true);
    assert.equal(r.budgets.length, 2);
    assert.equal(r.budgets.find((b) => b.id === "day")!.limitUsd, 9);
    // Another repo with the same name gets its own id.
    r = upsertBudget(r.budgets, { period: "month", limitUsd: 1, repo: "/a/web" });
    r = upsertBudget(r.budgets, { period: "month", limitUsd: 1, repo: "/b/web" });
    assert.deepEqual(r.budgets.map((b) => b.id), ["day", "week-codex", "month-web", "month-web-2"]);
  });

  test("written through a temp file and read back; a missing file is no budgets", () => {
    const env = home();
    assert.deepEqual(readBudgets(env), []);
    const b = budget({ limitUsd: 3 });
    writeBudgets([b], env);
    assert.deepEqual(readBudgets(env), [b]);
    const file = join(env.CODING_SH_HOME!, "budgets.json");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).budgets.length, 1);
  });

  test("a file that is not a budget list throws", () => {
    const env = home();
    writeBudgets([], env);
    writeFileSync(join(env.CODING_SH_HOME!, "budgets.json"), "[1,2]");
    assert.throws(() => readBudgets(env), /budgets/);
  });
});

describe("spend", () => {
  const now = new Date(2026, 10, 18, 15, 30).getTime();
  const today = new Date(2026, 10, 18, 9).getTime();
  const yesterday = new Date(2026, 10, 17, 9).getTime();

  test("sums the period's sessions, subagents too, as usage does; over at the limit", async () => {
    const index = new MemoryIndexStore();
    await index.upsertSession(priced("a", today, 0.7));
    await index.upsertSession(priced("a:sub:x", today + 1000, 0.5, { parent: { sessionId: "a" } } as never));
    await index.upsertSession(priced("old", yesterday, 10));
    const s = await budgetStatus(index, budget(), now);
    assert.equal(s.spendUsd, 1.2);
    assert.equal(s.sessions, 2);
    assert.equal(s.over, true);
    assert.equal(s.percent, 120);
    assert.equal(s.resetsAt, new Date(2026, 10, 19).getTime());
    // The week holds yesterday too.
    assert.equal((await budgetStatus(index, budget({ period: "week" }), now)).spendUsd, 11.2);
  });

  test("an agent or repo budget counts only its sessions", async () => {
    const index = new MemoryIndexStore();
    await index.upsertSession(priced("c", today, 2, { agent: "codex", cwd: "/work/api" }));
    await index.upsertSession(priced("d", today, 3, { agent: "claude-code", cwd: "/work/demo/src", repo: { root: "/work/demo" } } as never));
    assert.equal((await budgetStatus(index, budget({ agent: "codex" }), now)).spendUsd, 2);
    assert.equal((await budgetStatus(index, budget({ repo: "demo" }), now)).spendUsd, 3);
    assert.equal((await budgetStatus(index, budget({ repo: "/work/demo" }), now)).spendUsd, 3);
    assert.equal(spendOf(await index.listSessions(), budget({ repo: "api" }), now).spendUsd, 2);
  });

  test("a session with no cost adds nothing", async () => {
    const index = new MemoryIndexStore();
    await index.upsertSession(mkSession("free", today));
    const s = await budgetStatus(index, budget(), now);
    assert.equal(s.spendUsd, 0);
    assert.equal(s.over, false);
  });
});

describe("status line part", () => {
  const now = new Date(2026, 10, 18, 15, 30).getTime();
  test("shows the highest budget only once it passes 80%", () => {
    assert.equal(budgetPart([statusOf(budget(), 0.8, 1, now)]), undefined);
    assert.equal(budgetPart([statusOf(budget(), 0.82, 1, now), statusOf(budget({ id: "w", period: "week", limitUsd: 10 }), 9.5, 1, now)]), "budget 95%");
    assert.equal(budgetPart([statusOf(budget(), 1.3, 1, now)]), "budget 130%");
    assert.equal(budgetPart([]), undefined);
  });

  test("day budgets use today's sessions; week and month reuse a total for 60 s", async () => {
    const env = home();
    const index = new MemoryIndexStore();
    const today = new Date(2026, 10, 18, 9).getTime();
    await index.upsertSession(priced("a", today, 4));
    const week = budget({ id: "week", period: "week", limitUsd: 5 });
    const first = await statuslineStatuses(index, [week], [], env, now);
    assert.equal(first[0]!.spendUsd, 4);
    assert.ok(existsSync(join(env.CODING_SH_HOME!, "budget-spend.json")));
    // A new session within 60 s is not read yet; after 60 s it is.
    await index.upsertSession(priced("b", today + 1, 1));
    assert.equal((await statuslineStatuses(index, [week], [], env, now + 30_000))[0]!.spendUsd, 4);
    assert.equal((await statuslineStatuses(index, [week], [], env, now + 61_000))[0]!.spendUsd, 5);
    // A day budget reads the list it is given, not the cache.
    const day = await statuslineStatuses(index, [budget({ limitUsd: 10 })], [priced("x", today, 9)], env, now);
    assert.equal(day[0]!.percent, 90);
  });

  test("statuslineBudget reads nothing without budgets and names the top one", async () => {
    const env = home();
    const index = new MemoryIndexStore();
    assert.equal(await statuslineBudget(index, env, periodStart("day")), undefined);
    await index.upsertSession(priced("a", Date.now(), 0.9));
    writeBudgets([budget()], env);
    const r = await statuslineBudget(index, env, periodStart("day"));
    assert.equal(r?.part, "budget 90%");
    assert.equal(r?.status.budget.id, "day");
  });
});

describe("--where budgets", () => {
  /** The session.start event an OTel trace's user and environment attributes land on. */
  const start = (sessionId: string, ts: number, payload: Record<string, unknown>): AgentEvent => ({ id: `${sessionId}-start`, v: 0, sessionId, ts, agent: "otel", kind: "session.start", payload }) as AgentEvent;

  test("budget set --where gives one user a budget of their own; status says which is over", async () => {
    const sb = sandbox();
    try {
      const t = Math.max(periodStart("day"), Date.now() - 60_000);
      await sb.seed(
        [
          priced("o-u1", t, 0.9, { agent: "otel" as never }),
          // A subagent of u1's session: it has no user of its own and counts with its parent.
          priced("o-u1:sub", t, 0.3, { agent: "otel" as never, parent: { sessionId: "o-u1" } } as never),
          priced("o-u2", t, 0.4, { agent: "otel" as never }),
        ],
        [start("o-u1", t, { user: "u1" }), start("o-u2", t, { user: "u2" })],
      );
      for (const where of ["user:u1", "user:u2"]) {
        const r = await runCmd(budgetCmd, sb, { action: "set", positionals: ["day", "1"], flags: { where }, json: true });
        assert.equal(r.error, undefined, String(r.error));
        assert.match((r.json as { budget: Budget }).budget.id, /^day-w[0-9a-f]{6}$/);
      }
      // The same query again changes the limit in place.
      const again = await runCmd(budgetCmd, sb, { action: "set", positionals: ["day", "1"], flags: { where: "user:u1" }, json: true });
      assert.equal((again.json as { outcome: string }).outcome, "updated");
      await runCmd(budgetCmd, sb, { action: "set", positionals: ["day", "5"], json: true });
      const st = await runCmd(budgetCmd, sb, { action: "status", json: true });
      assert.equal(st.error, undefined, String(st.error));
      const rows = (st.json as { budgets: { id: string; where?: string; spendUsd: number; over: boolean; sessions: number }[] }).budgets;
      assert.deepEqual(rows.map((b) => [b.where, b.spendUsd, b.over, b.sessions]), [["user:u1", 1.2, true, 1], ["user:u2", 0.4, false, 1], [undefined, 1.6, false, 3]]);
      assert.equal("where" in rows[2]!, false, "status --json names where only when set");
      const list = await runCmd(budgetCmd, sb, { action: "list" });
      assert.match(list.stdout, /user:u1/);
      const human = await runCmd(budgetCmd, sb, { action: "status" });
      assert.match(human.stdout, /where user:u2/);
    } finally {
      sb.cleanup();
    }
  });

  test("a --where query that does not parse exits 2 and sets nothing", async () => {
    const sb = sandbox();
    try {
      const r = await runCmd(budgetCmd, sb, { action: "set", positionals: ["day", "1"], flags: { where: "cost>>" } });
      assert.equal((r.error as { exitCode?: number } | undefined)?.exitCode, 2, String(r.error));
      assert.deepEqual(readBudgets(sb.env), []);
    } finally {
      sb.cleanup();
    }
  });

  test("the status line matches a session-key --where day budget on today's sessions, with no store read", async () => {
    const env = home();
    const now = new Date(2026, 10, 18, 15, 30).getTime();
    const t = new Date(2026, 10, 18, 9).getTime();
    const today = [
      priced("opus", t, 0.6, { model: "claude-opus-4-1" }),
      priced("opus:sub", t + 1, 0.3, { model: "claude-haiku-4-5", parent: { sessionId: "opus" } } as never),
      priced("sonnet", t, 5, { model: "claude-sonnet-4-5" }),
    ];
    const index = new Proxy({} as IndexStore, {
      get: (_, k) => (k === "then" ? undefined : () => assert.fail(`the status line read the store (${String(k)})`)),
    });
    const opus = budget({ id: "day-opus", where: "model:claude-opus-*" });
    const statuses = await statuslineStatuses(index, [opus, budget({ id: "day-user", where: "user:u1" }), budget({ id: "week-opus", period: "week", where: "model:claude-opus-*" })], today, env, now);
    assert.deepEqual(statuses.map((s) => [s.budget.id, s.spendUsd, s.sessions]), [["day-opus", 0.9, 1]]);
    assert.equal(budgetPart(statuses), "budget 90%");
  });

  test("rolledSpend adds a match's subagents and survives a loop of parents", () => {
    const rows = [
      { id: "a", costUsd: 1 },
      { id: "a1", parent: "a", costUsd: 2 },
      { id: "a2", parent: "a1", costUsd: 4 },
      { id: "b", costUsd: 8 },
      { id: "x", parent: "y", costUsd: 16 },
      { id: "y", parent: "x", costUsd: 32 },
    ];
    assert.deepEqual(rolledSpend(rows, (id) => id === "a"), { spendUsd: 7, sessions: 1 });
    assert.deepEqual(rolledSpend(rows, (id) => id === "a1" || id === "b"), { spendUsd: 14, sessions: 2 });
    assert.deepEqual(rolledSpend(rows, (id) => id === "x"), { spendUsd: 48, sessions: 1 });
  });

  test("proxy --enforce-budget skips a --where budget over its limit", async () => {
    const now = new Date(2026, 10, 18, 15, 30).getTime();
    const route = { provider: "anthropic", api: "messages" } as const;
    const where = budgetGuard({ load: async () => [statusOf(budget({ id: "day-u1", where: "user:u1" }), 5, 1, now)], now: () => now });
    assert.equal(await where.check(route, {}), undefined);
    const plain = budgetGuard({ load: async () => [statusOf(budget(), 5, 1, now)], now: () => now });
    assert.equal((await plain.check(route, {}))?.status.budget.id, "day");
  });
});
