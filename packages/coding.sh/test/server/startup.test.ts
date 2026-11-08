// serve waits for a database that is still starting: connection errors are retried, anything
// else fails at once. Found by the ClickHouse compose smoke test, where the image answers its
// health check from a temporary server and then refuses connections for about two seconds.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTransientConnectError, retryTransient } from "../../src/server/startup.ts";

const refused = () => Object.assign(new Error("connect ECONNREFUSED 172.18.0.2:8123"), { code: "ECONNREFUSED" });

describe("store startup retry", () => {
  it("knows connection errors from other failures, through causes and aggregates", () => {
    assert.ok(isTransientConnectError(refused()));
    assert.ok(isTransientConnectError(new TypeError("fetch failed", { cause: refused() })));
    assert.ok(isTransientConnectError(new AggregateError([refused()], "")));
    assert.ok(isTransientConnectError(Object.assign(new Error("the database system is starting up"), { code: "57P03" })));
    assert.ok(!isTransientConnectError(Object.assign(new Error('password authentication failed for user "coding"'), { code: "28P01" })));
    assert.ok(!isTransientConnectError(new Error("Code: 516. DB::Exception: coding: Authentication failed")));
    assert.ok(!isTransientConnectError(undefined));
  });

  it("retries until the store answers, and gives up at the deadline", async () => {
    let calls = 0;
    const seen: number[] = [];
    const v = await retryTransient(
      async () => {
        if (++calls < 3) throw new TypeError("fetch failed", { cause: refused() });
        return "open";
      },
      { timeoutMs: 1000, delayMs: 5, onRetry: (_e, n) => seen.push(n) },
    );
    assert.equal(v, "open");
    assert.deepEqual(seen, [1, 2]);

    const t0 = Date.now();
    await assert.rejects(retryTransient(async () => Promise.reject(refused()), { timeoutMs: 60, delayMs: 10 }), /ECONNREFUSED/);
    assert.ok(Date.now() - t0 < 1000);
  });

  it("fails at once on anything else", async () => {
    let calls = 0;
    await assert.rejects(
      retryTransient(
        async () => {
          calls++;
          throw new Error("password authentication failed");
        },
        { timeoutMs: 10_000, delayMs: 5 },
      ),
      /password/,
    );
    assert.equal(calls, 1);
  });
});
