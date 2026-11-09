// X-11: the record/replay proxy against a stub upstream and a 3-call script.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { startLlmCache, type LlmCache, type LlmStats } from "../../src/llmcache/proxy.ts";
import { readRecording, recordingPath } from "../../src/llmcache/store.ts";
import { API_KEY, recordingTexts, startStub, threeCalls, tmp, type ScriptOpts, type Stub } from "./_stub.ts";

let stub: Stub;
let dir: string;
before(async () => {
  stub = await startStub();
  dir = tmp();
});
after(async () => {
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function withCache<T>(o: { mode: "record" | "replay"; source?: string; until?: number; warn?: string[] }, fn: (c: LlmCache) => Promise<T>): Promise<T> {
  const c = await startLlmCache({ mode: o.mode, dir, upstream: { anthropic: stub.url, openai: stub.url }, ...(o.source ? { source: o.source } : {}), ...(o.until !== undefined ? { until: o.until } : {}), onWarn: (m) => o.warn?.push(m) });
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

/** One case-trial of the script through a job: its replies, its stats and how many upstream calls it made. */
async function runScript(o: { mode: "record" | "replay"; expId: string; source?: string; until?: number; script?: ScriptOpts; caseId?: string; warn?: string[] }) {
  return withCache(o, async (c) => {
    const before = stub.calls();
    const job = await c.job({ expId: o.expId, caseId: o.caseId ?? "case-1", trial: 1 });
    const replies = await threeCalls(job.anthropicBaseUrl, o.script);
    const stats: LlmStats = await job.close();
    return { replies, stats, upstream: stub.calls() - before };
  });
}

describe("llm cache proxy", () => {
  let recorded: Awaited<ReturnType<typeof runScript>>;
  before(async () => {
    recorded = await runScript({ mode: "record", expId: "exp_rec" });
  });

  test("(1) record: every call goes upstream and lands in the recording", async () => {
    assert.equal(recorded.upstream, 3);
    assert.deepEqual(recorded.stats, { calls: 3, hits: 0, live: 3 });
    assert.ok(recorded.replies.every((r) => r.status === 200));
    const entries = await readRecording(recordingPath(dir, "exp_rec", "case-1", 1));
    assert.equal(entries?.length, 3);
    assert.deepEqual(entries!.map((e) => e.ordinal), [1, 2, 3]);
    assert.deepEqual(entries!.map((e) => e.body), recorded.replies.map((r) => r.text));
    assert.equal(entries![0]!.model, "claude-test");
    assert.deepEqual(entries![0]!.usage, { inputTokens: 11, outputTokens: 7 });
    assert.equal(new Set(entries!.map((e) => e.key)).size, 3);
  });

  test("(2) an unchanged replay makes 0 upstream calls and returns identical outputs", async () => {
    const r = await runScript({ mode: "replay", expId: "exp_rep", source: "exp_rec" });
    assert.equal(r.upstream, 0);
    assert.deepEqual(r.stats, { calls: 3, hits: 3, live: 0 });
    assert.deepEqual(r.replies.map((x) => x.text), recorded.replies.map((x) => x.text));
    // A replay records too, so it can be a source itself.
    const again = await runScript({ mode: "replay", expId: "exp_rep2", source: "exp_rep" });
    assert.equal(again.upstream, 0);
    assert.deepEqual(again.replies.map((x) => x.text), recorded.replies.map((x) => x.text));
  });

  test("(3) changing call 2 serves call 1 and runs calls 2 and 3 live: firstLiveOrdinal=2", async () => {
    const r = await runScript({ mode: "replay", expId: "exp_c2", source: "exp_rec", script: { second: "second, edited" } });
    assert.deepEqual(r.stats, { calls: 3, hits: 1, live: 2, firstLiveOrdinal: 2 });
    assert.equal(r.upstream, 2);
    assert.equal(r.replies[0]!.text, recorded.replies[0]!.text);
    assert.notEqual(r.replies[2]!.text, recorded.replies[2]!.text, "a miss sends every later call live, even one that would hit");
  });

  test("(4) a system-prompt edit and a moved cache_control still hit 100%", async () => {
    for (const script of [{ system: "A different system prompt, edited." }, { cacheAt: "first" as const }, { cacheAt: "none" as const }, { system: "edited", cacheAt: "first" as const }]) {
      const r = await runScript({ mode: "replay", expId: "exp_sys", source: "exp_rec", script });
      assert.deepEqual(r.stats, { calls: 3, hits: 3, live: 0 }, JSON.stringify(script));
      assert.equal(r.upstream, 0);
      assert.deepEqual(r.replies.map((x) => x.text), recorded.replies.map((x) => x.text));
    }
  });

  test("(5) --replay-until N serves calls 1..N and runs the rest live", async () => {
    const r = await runScript({ mode: "replay", expId: "exp_u1", source: "exp_rec", until: 1 });
    assert.deepEqual(r.stats, { calls: 3, hits: 1, live: 2, firstLiveOrdinal: 2 });
    const r0 = await runScript({ mode: "replay", expId: "exp_u0", source: "exp_rec", until: 0 });
    assert.deepEqual(r0.stats, { calls: 3, hits: 0, live: 3, firstLiveOrdinal: 1 });
    const r3 = await runScript({ mode: "replay", expId: "exp_u3", source: "exp_rec", until: 3 });
    assert.deepEqual(r3.stats, { calls: 3, hits: 3, live: 0 });
  });

  test("(6) SSE is teed through byte for byte and replayed byte for byte", async () => {
    // Straight to the stub, for the reference bytes of a stream.
    const direct = await threeCalls(stub.url, { stream: true });
    const rec = await runScript({ mode: "record", expId: "exp_sse", script: { stream: true } });
    for (const [i, r] of rec.replies.entries()) {
      assert.match(r.text, /^event: message_start\ndata: /);
      // Same shape as the direct stream (only the counter differs).
      assert.equal(r.text.replace(/\d+/g, "#"), direct[i]!.text.replace(/\d+/g, "#"));
    }
    const rep = await runScript({ mode: "replay", expId: "exp_sse2", source: "exp_sse", script: { stream: true } });
    assert.equal(rep.upstream, 0);
    for (const [i, r] of rep.replies.entries()) assert.ok(r.bytes.equals(rec.replies[i]!.bytes), `call ${i + 1} bytes differ`);
    const entries = await readRecording(recordingPath(dir, "exp_sse", "case-1", 1));
    assert.match(entries![0]!.contentType!, /text\/event-stream/);
    assert.deepEqual(entries![0]!.usage, { inputTokens: 11, outputTokens: 7 });
  });

  test("(7) a 500 is recorded but never replayed, and count_tokens passes through uncounted", async () => {
    const r = await withCache({ mode: "record" }, async (c) => {
      const job = await c.job({ expId: "exp_500", caseId: "case-1", trial: 1 });
      const post = (path: string, text: string) =>
        fetch(`${job.anthropicBaseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": API_KEY }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: text }] }) });
      const before = stub.hits.get("/v1/messages/count_tokens") ?? 0;
      const ct = await post("/v1/messages/count_tokens", "hello");
      assert.deepEqual(await ct.json(), { input_tokens: 42 });
      assert.equal((stub.hits.get("/v1/messages/count_tokens") ?? 0) - before, 1);
      assert.equal((await post("/v1/messages", "please-500")).status, 500);
      return job.close();
    });
    assert.deepEqual(r, { calls: 1, hits: 0, live: 1 });
    const rep = await withCache({ mode: "replay", source: "exp_500" }, async (c) => {
      const job = await c.job({ expId: "exp_500b", caseId: "case-1", trial: 1 });
      const before = stub.calls();
      const res = await fetch(`${job.anthropicBaseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": API_KEY }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "please-500" }] }) });
      assert.equal(res.status, 500);
      assert.equal(stub.calls() - before, 1, "the 500 went upstream again");
      return job.close();
    });
    assert.deepEqual(rep, { calls: 1, hits: 0, live: 1, firstLiveOrdinal: 1, upstreamErrors: 1 });
  });

  test("(8) concurrent jobs are isolated", async () => {
    await runScript({ mode: "record", expId: "exp_iso", caseId: "case-2", script: { second: "other case" } });
    const recA = (await readRecording(recordingPath(dir, "exp_rec", "case-1", 1)))!.map((e) => e.body);
    const recB = (await readRecording(recordingPath(dir, "exp_iso", "case-2", 1)))!;
    await withCache({ mode: "replay", source: "exp_rec" }, async (c) => {
      const before = stub.calls();
      const jobs = await Promise.all(Array.from({ length: 6 }, (_, i) => c.job({ expId: "exp_iso2", caseId: i % 2 ? "case-1" : "case-x", trial: 1 })));
      const out = await Promise.all(jobs.map((j) => threeCalls(j.anthropicBaseUrl)));
      const stats = await Promise.all(jobs.map((j) => j.close()));
      for (const [i, s] of stats.entries()) {
        if (i % 2) {
          assert.deepEqual(s, { calls: 3, hits: 3, live: 0 });
          assert.deepEqual(out[i]!.map((x) => x.text), recA);
        } else assert.deepEqual(s, { calls: 3, hits: 0, live: 3, firstLiveOrdinal: 1, missingSource: true });
      }
      assert.equal(stub.calls() - before, 9);
    });
    assert.equal(recB.length, 3);
  });

  test("(9) calls made in parallel replay in either order", async () => {
    const rec = await runScript({ mode: "record", expId: "exp_par", script: { parallel: "forward" } });
    const rep = await runScript({ mode: "replay", expId: "exp_par2", source: "exp_par", script: { parallel: "reversed" } });
    assert.equal(rep.upstream, 0);
    assert.deepEqual(rep.stats, { calls: 3, hits: 3, live: 0 });
    assert.deepEqual(rep.replies.map((x) => x.text), rec.replies.map((x) => x.text));
  });

  test("(12) a missing source runs fully live, with a warning", async () => {
    const warn: string[] = [];
    const r = await runScript({ mode: "replay", expId: "exp_ms", source: "exp_nothing", warn });
    assert.deepEqual(r.stats, { calls: 3, hits: 0, live: 3, firstLiveOrdinal: 1, missingSource: true });
    assert.equal(r.upstream, 3);
    assert.match(warn.join("\n"), /exp_nothing has no recording for case case-1 trial 1; running it live/);
  });

  test("no recording file contains the API key, even when the model echoes it", async () => {
    const r = await withCache({ mode: "record" }, async (c) => {
      const job = await c.job({ expId: "exp_key", caseId: "case-1", trial: 1 });
      const res = await fetch(`${job.anthropicBaseUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": API_KEY, authorization: `Bearer ${API_KEY}` }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "echo-key" }] }) });
      assert.match(await res.text(), new RegExp(API_KEY), "the client still gets the real bytes");
      return job.close();
    });
    assert.equal(r.calls, 1);
    // The key reached the upstream (credentials are forwarded) ...
    assert.ok(stub.headers.some((h) => h["x-api-key"] === API_KEY));
    // ... and no file in the cache holds it.
    const texts = recordingTexts(dir);
    assert.ok(texts.length > 5);
    for (const t of texts) assert.ok(!t.includes(API_KEY), "a recording holds the API key");
    const e = (await readRecording(recordingPath(dir, "exp_key", "case-1", 1)))![0]!;
    assert.equal(e.redacted, true);
    assert.match(e.body, /\[redacted:api-key\]/);
  });

  test("a reply the recording redacts still replays: the next call quotes the redacted text and hits", async () => {
    // Call 1's reply echoes the API key; call 2 carries that reply as the assistant turn, as an agent's next request does.
    const two = async (base: string) => {
      const post = (messages: unknown[]) =>
        fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": API_KEY }, body: JSON.stringify({ model: "m", max_tokens: 8, messages }) }).then((r) => r.text());
      const first = [{ role: "user", content: "echo-key please, and DB_PASSWORD=changeme123" }];
      const r1 = await post(first);
      const said = (JSON.parse(r1) as { content: { text: string }[] }).content[0]!.text;
      const r2 = await post([...first, { role: "assistant", content: said }, { role: "user", content: "next" }]);
      return [r1, r2];
    };
    const run = (mode: "record" | "replay", expId: string, source?: string) =>
      withCache({ mode, source }, async (c) => {
        const before = stub.calls();
        const job = await c.job({ expId, caseId: "case-1", trial: 1 });
        const replies = await two(job.anthropicBaseUrl);
        return { replies, stats: await job.close(), upstream: stub.calls() - before };
      });
    const rec = await run("record", "exp_redact");
    assert.equal(rec.upstream, 2);
    assert.match(rec.replies[0]!, new RegExp(API_KEY));
    const rep = await run("replay", "exp_redact_rep", "exp_redact");
    assert.equal(rep.upstream, 0, "an unchanged replay made upstream calls");
    assert.deepEqual(rep.stats, { calls: 2, hits: 2, live: 0 });
    assert.ok(!rep.replies[0]!.includes(API_KEY));
    assert.equal(rep.replies[1], rec.replies[1]);
    // A replay of the replay hits too.
    assert.equal((await run("replay", "exp_redact_rep2", "exp_redact_rep")).upstream, 0);
  });

  test("an unknown token and a non-loopback Host are refused", async () => {
    await withCache({ mode: "record" }, async (c) => {
      const res = await fetch(`${c.url}/llm/${"0".repeat(32)}/v1/messages`, { method: "POST", body: "{}" });
      assert.equal(res.status, 404);
      const job = await c.job({ expId: "exp_host", caseId: "c", trial: 1 });
      const http = await import("node:http");
      const status = await new Promise<number>((resolve, reject) => {
        const u = new URL(`${job.anthropicBaseUrl}/v1/messages`);
        const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end("{}");
      });
      assert.equal(status, 403);
      await job.close();
    });
  });

  test("OpenAI chat completions go through the job's /v1 base URL", async () => {
    const call = (base: string, sys: string) =>
      fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` }, body: JSON.stringify({ model: "gpt-test", messages: [{ role: "system", content: sys }, { role: "user", content: "hi" }] }) }).then((r) => r.text());
    const rec = await withCache({ mode: "record" }, async (c) => {
      const job = await c.job({ expId: "exp_oai", caseId: "c", trial: 1 });
      const t = await call(job.openaiBaseUrl, "sys A");
      await job.close();
      return t;
    });
    const rep = await withCache({ mode: "replay", source: "exp_oai" }, async (c) => {
      const job = await c.job({ expId: "exp_oai2", caseId: "c", trial: 1 });
      const t = await call(job.openaiBaseUrl, "sys B, edited");
      assert.deepEqual(await job.close(), { calls: 1, hits: 1, live: 0 });
      return t;
    });
    assert.equal(rep, rec);
  });

  test("proxy overhead is under 50 ms per call", async () => {
    const slow = await startStub({ delayMs: 20 });
    try {
      const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(20_000) }] });
      const post = (base: string) => fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": API_KEY }, body }).then((r) => r.arrayBuffer());
      const time = async (base: string, n: number) => {
        const t: number[] = [];
        for (let i = 0; i < n; i++) {
          const t0 = performance.now();
          await post(base);
          t.push(performance.now() - t0);
        }
        return t.sort((a, b) => a - b)[Math.floor(n / 2)]!;
      };
      const c = await startLlmCache({ mode: "record", dir, upstream: { anthropic: slow.url } });
      try {
        const job = await c.job({ expId: "exp_perf", caseId: "c", trial: 1 });
        await post(slow.url);
        await post(job.anthropicBaseUrl);
        const direct = await time(slow.url, 15);
        const proxied = await time(job.anthropicBaseUrl, 15);
        await job.close();
        assert.ok(proxied - direct < 50, `live overhead ${(proxied - direct).toFixed(1)} ms`);
      } finally {
        await c.close();
      }
      const r = await startLlmCache({ mode: "replay", source: "exp_perf", dir, upstream: { anthropic: slow.url } });
      try {
        const job = await r.job({ expId: "exp_perf2", caseId: "c", trial: 1 });
        const t0 = performance.now();
        for (let i = 0; i < 15; i++) await post(job.anthropicBaseUrl);
        const per = (performance.now() - t0) / 15;
        const s = await job.close();
        assert.equal(s.hits, 15);
        assert.ok(per < 50, `replay ${per.toFixed(1)} ms per call`);
      } finally {
        await r.close();
      }
    } finally {
      await slow.close();
    }
  });
});
