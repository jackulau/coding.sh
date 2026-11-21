// The IndexNow ping after a deploy (scripts/indexnow.mjs). A failed lookup or connection, a
// timeout, a 429 or a 5xx is tried again, so a short DNS outage on the runner does not lose the
// ping; any other answer comes back at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request, why } from "../scripts/indexnow.mjs";

const URL_ = "https://api.indexnow.org/indexnow";
const failed = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`getaddrinfo ${code} api.indexnow.org`), { code }) });

/** A fetch that gives `answers` in turn (an Error is thrown) and repeats the last one. */
function fake(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return new Response(a.body ?? null, { status: a.status });
  };
  return { fetch, calls };
}

const quiet = { waitMs: 0, log: () => {} };

test("a failed lookup is tried again, and the same request goes through once a lookup works", async () => {
  const { fetch, calls } = fake([failed("EAI_AGAIN"), failed("ENOTFOUND"), { status: 200, body: "ok" }]);
  const res = await request(URL_, { method: "POST", body: '{"host":"coding.sh"}' }, { fetch, ...quiet });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.url, URL_);
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.body, '{"host":"coding.sh"}');
    assert.ok(c.init.signal instanceof AbortSignal, "each try has a timeout");
  }
});

test("a 429 or a 5xx is tried again; a 4xx comes back at once", async () => {
  const busy = fake([{ status: 429 }, { status: 503 }, { status: 202 }]);
  assert.equal((await request(URL_, {}, { fetch: busy.fetch, ...quiet })).status, 202);
  assert.equal(busy.calls.length, 3);

  const refused = fake([{ status: 403, body: "key not valid" }]);
  const res = await request(URL_, {}, { fetch: refused.fetch, ...quiet });
  assert.equal(res.status, 403);
  assert.equal(refused.calls.length, 1);
});

test("after the last try, a 5xx comes back as the response and a thrown request as an error that says why", async () => {
  const down = fake([{ status: 502 }]);
  assert.equal((await request(URL_, {}, { fetch: down.fetch, tries: 3, ...quiet })).status, 502);
  assert.equal(down.calls.length, 3);

  const offline = fake([failed("EAI_AGAIN")]);
  await assert.rejects(request(URL_, {}, { fetch: offline.fetch, tries: 4, ...quiet }), {
    message: `${URL_}: lookup failed after 4 tries`,
  });
  assert.equal(offline.calls.length, 4);
});

test("each retry is logged with its reason, and the last try is not", async () => {
  const lines = [];
  const { fetch } = fake([failed("EAI_AGAIN"), { status: 500 }, failed("ECONNREFUSED")]);
  await assert.rejects(request(URL_, {}, { fetch, tries: 3, waitMs: 0, log: (l) => lines.push(l) }), /connection failed after 3 tries/);
  assert.deepEqual(lines, [
    `indexnow: ${URL_} lookup failed on try 1, retrying`,
    `indexnow: ${URL_} HTTP 500 on try 2, retrying`,
  ]);
});

test("why() says what failed in the smoke test's words", () => {
  assert.equal(why(failed("EAI_AGAIN")), "lookup failed");
  assert.equal(why(failed("ENOTFOUND")), "lookup failed");
  assert.equal(why(failed("ECONNREFUSED")), "connection failed");
  assert.equal(why(failed("ECONNRESET")), "connection failed");
  assert.equal(why(failed("UND_ERR_CONNECT_TIMEOUT")), "timed out");
  assert.equal(why(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "timed out");
  assert.equal(why(Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") })), "bad port");
  assert.equal(why(new Error("something else")), "something else");
});
