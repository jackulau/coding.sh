import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBusy, loadSqlite, retryOnBusy, switchToWal, withoutBusyRetry } from "../../src/store/sqlite-open.ts";

const busy = (code: number): Error => Object.assign(new Error("database is locked"), { errcode: code });

describe("busy retry", () => {
  it("treats extended SQLITE_BUSY codes as busy", () => {
    assert.ok(isBusy(busy(5)));
    assert.ok(isBusy(busy(261))); // SQLITE_BUSY_RECOVERY
    assert.ok(isBusy(busy(517))); // SQLITE_BUSY_SNAPSHOT
    assert.ok(!isBusy(busy(19)));
  });

  it("switchToWal retries an extended busy code", async () => {
    let n = 0;
    const db = { exec: () => { if (n++ < 3) throw busy(261); } };
    await switchToWal(db as never);
    assert.equal(n, 4);
  });

  it("retries exec and statement calls that fail with a lock error, then succeeds", async () => {
    const { DatabaseSync } = await loadSqlite();
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE t (a)");
    let execFails = 2;
    let getFails = 2;
    const origExec = raw.exec.bind(raw);
    const origPrepare = raw.prepare.bind(raw);
    const fake = new Proxy(raw, {
      get(t, p) {
        if (p === "exec") return (sql: string) => { if (execFails-- > 0) throw busy(261); return origExec(sql); };
        if (p === "prepare") return (sql: string) => {
          const st = origPrepare(sql);
          return new Proxy(st, { get(s, q) { const v = Reflect.get(s, q, s); if (q === "get") return (...a: unknown[]) => { if (getFails-- > 0) throw busy(5); return (v as (...x: unknown[]) => unknown).apply(s, a); }; return typeof v === "function" ? v.bind(s) : v; } });
        };
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const db = retryOnBusy(fake as never);
    db.exec("INSERT INTO t VALUES (7)");
    assert.equal((db.prepare("SELECT a FROM t").get() as { a: number }).a, 7);
    assert.equal(execFails, -1);
    assert.equal(getFails, -1);
    raw.close();
  });

  it("gives up after its budget and does not retry inside withoutBusyRetry", async () => {
    const { DatabaseSync } = await loadSqlite();
    const raw = new DatabaseSync(":memory:");
    let calls = 0;
    const fake = new Proxy(raw, {
      get(t, p) {
        if (p === "exec") return () => { calls++; throw busy(5); };
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const db = retryOnBusy(fake as never, 100);
    assert.throws(() => db.exec("SELECT 1"), isBusy);
    assert.ok(calls > 1);
    calls = 0;
    assert.throws(() => withoutBusyRetry(db, () => db.exec("SELECT 1")), isBusy);
    assert.equal(calls, 1);
    raw.close();
  });
});
