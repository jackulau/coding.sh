import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { TraceEvent } from "../../src/datasets/types.ts";
import {
  anthropicProvider,
  createJudge,
  createLimiter,
  extractJson,
  fetchJson,
  FileJudgeCache,
  HttpError,
  judgeGrader,
  JudgeParseError,
  MemoryJudgeCache,
  openAICompatibleProvider,
  parseRetryAfter,
  parseVerdict,
  renderPrompt,
  renderTrace,
  type ChatProvider,
} from "../../src/judge/index.ts";

const KEY = "sk-ant-test-SECRET-key-123456";

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** fetch double: replays queued responses (or a function) and records every call. */
function mockFetch(responses: (Response | (() => Response) | Error)[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init, body: JSON.parse(String(init.body)), headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next === undefined) throw new Error("mockFetch: no response queued");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next.clone();
  };
  return { fn, calls };
}

const anthropicReply = (text: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ model: "claude-sonnet-5-5", content: [{ type: "thinking", thinking: "" }, { type: "text", text }], stop_reason: "end_turn", ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const verdictText = (o: Record<string, unknown>) => JSON.stringify({ reason: "ok", citations: [], confidence: 0.9, ...o });

const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("extractJson", () => {
  it("finds JSON in prose, fences, and repairs trailing commas", () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('Here you go:\n```json\n{"a": 1,}\n```\nthanks'), { a: 1 });
    assert.deepEqual(extractJson('Verdict: {"score": 0.5, "note": "has } brace"} trailing'), { score: 0.5, note: "has } brace" });
    assert.equal(extractJson("no json here"), undefined);
    assert.deepEqual(extractJson('{"x":1} then {"score":1}', { accept: (v) => !!v && typeof v === "object" && "score" in v }), { score: 1 });
  });
});

describe("parseVerdict", () => {
  it("normalizes score, pass, confidence and citations", () => {
    const v = parseVerdict('```json\n{"score": "0.8", "pass": "PASS", "reason": " fine ", "citations": ["q1", {"eventId": "e1", "quote": "q2"}, {"quote": ""}]}\n```');
    assert.ok(Math.abs(v.confidence - 0.6) < 1e-9, "confidence defaults to |score − 0.5| · 2");
    assert.deepEqual({ ...v, confidence: 0 }, { score: 0.8, pass: true, confidence: 0, reason: "fine", citations: [{ quote: "q1" }, { eventId: "e1", quote: "q2" }] });
  });
  it("derives pass from the threshold, rescales 0–10 scores, clamps", () => {
    assert.equal(parseVerdict('{"score": 0.4}', 0.5).pass, false);
    assert.equal(parseVerdict('{"score": 0.4}', 0.3).pass, true);
    assert.equal(parseVerdict('{"score": 7}').score, 0.7);
    assert.equal(parseVerdict('{"score": -2}').score, 0);
    assert.equal(parseVerdict('{"pass": false}').score, 0);
    assert.equal(parseVerdict('{"verdict": "fail", "confidence": 95}').confidence, 0.95);
  });
  it("throws JudgeParseError when there is no verdict", () => {
    assert.throws(() => parseVerdict("I think it passes."), JudgeParseError);
    assert.throws(() => parseVerdict('{"reason": "x"}'), JudgeParseError);
    assert.throws(() => parseVerdict('{"score": "high", "reason": "x"}'), /neither/);
  });
});

describe("fetchJson retries", () => {
  it("retries 429 honoring retry-after seconds, then succeeds", async () => {
    const m = mockFetch([new Response("{}", { status: 429, headers: { "retry-after": "2" } }), new Response('{"ok":true}', { status: 200 })]);
    const waits: number[] = [];
    const out = await fetchJson("https://api.example/x", { method: "POST", body: "{}" }, { fetch: m.fn, sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(waits, [2000]);
    assert.equal(m.calls.length, 2);
  });

  it("honors retry-after-ms and HTTP-date forms; caps at maxDelayMs", () => {
    assert.equal(parseRetryAfter(new Headers({ "retry-after-ms": "250", "retry-after": "9" })), 250);
    const now = Date.parse("2026-01-01T00:00:00Z");
    assert.equal(parseRetryAfter(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" }), now), 5000);
    assert.equal(parseRetryAfter(new Headers({})), undefined);
  });

  it("backs off exponentially on 5xx/529 and network errors without retry-after", async () => {
    const m = mockFetch([new Response("overloaded", { status: 529 }), new Error("ECONNRESET"), new Response("{}", { status: 503 }), new Response('{"n":1}')]);
    const waits: number[] = [];
    const retries: (number | undefined)[] = [];
    await fetchJson(
      "https://api.example/x",
      { method: "POST", body: "{}" },
      { fetch: m.fn, baseDelayMs: 100, random: () => 0, sleep: async (ms) => void waits.push(ms), onRetry: (i) => void retries.push(i.status) },
    );
    assert.deepEqual(waits, [50, 100, 200]);
    assert.deepEqual(retries, [529, undefined, 503]);
  });

  it("does not retry 400 and gives up after `retries`", async () => {
    const m = mockFetch([new Response('{"error":{"type":"invalid_request_error","message":"bad model"}}', { status: 400 })]);
    await assert.rejects(fetchJson("https://api.example/x", { method: "POST", body: "{}" }, { fetch: m.fn, ...noSleep }), (e: unknown) => {
      assert.ok(e instanceof HttpError);
      assert.equal(e.status, 400);
      assert.equal(e.retryable, false);
      assert.match(e.message, /invalid_request_error: bad model/);
      return true;
    });
    assert.equal(m.calls.length, 1);
    const always = mockFetch([new Response("{}", { status: 500 })]);
    await assert.rejects(fetchJson("https://api.example/x", { method: "POST", body: "{}" }, { fetch: always.fn, retries: 2, ...noSleep }), /after 3 attempts/);
    assert.equal(always.calls.length, 3);
  });

  it("never puts secrets in errors, even when the server echoes them", async () => {
    const m = mockFetch([new Response(`{"error":{"message":"invalid x-api-key ${KEY}"}}`, { status: 401 })]);
    await assert.rejects(fetchJson("https://api.example/x", { method: "POST", body: "{}" }, { fetch: m.fn, secrets: [KEY], ...noSleep }), (e: unknown) => {
      assert.ok(e instanceof HttpError);
      assert.ok(!e.message.includes(KEY) && !e.body.includes(KEY), e.message);
      assert.match(e.message, /\[redacted\]/);
      return true;
    });
  });
});

describe("providers", () => {
  it("anthropic: Messages API shape, key from env, no temperature, text blocks only", async () => {
    const m = mockFetch([anthropicReply('{"score":1}')]);
    const p = anthropicProvider({ env: { ANTHROPIC_API_KEY: KEY }, fetch: m.fn, effort: "low" });
    assert.equal(p.model, "claude-sonnet-5-5");
    const r = await p.complete({ system: "sys", user: "usr", jsonSchema: { type: "object" } });
    assert.equal(r.text, '{"score":1}');
    const c = m.calls[0] as Call;
    assert.equal(c.url, "https://api.anthropic.com/v1/messages");
    assert.equal(c.headers["x-api-key"], KEY);
    assert.equal(c.headers["anthropic-version"], "2026-10-21");
    assert.equal(c.body.model, "claude-sonnet-5-5");
    assert.equal(c.body.system, "sys");
    assert.deepEqual(c.body.messages, [{ role: "user", content: "usr" }]);
    assert.equal("temperature" in c.body, false);
    assert.deepEqual(c.body.output_config, { effort: "low", format: { type: "json_schema", schema: { type: "object" } } });
    assert.ok(!JSON.stringify(p.params).includes(KEY));
  });

  it("anthropic: refusal is an error; a missing key names the env var", async () => {
    const m = mockFetch([anthropicReply("", { stop_reason: "refusal", stop_details: { category: "cyber" } })]);
    await assert.rejects(anthropicProvider({ env: { ANTHROPIC_API_KEY: KEY }, fetch: m.fn }).complete({ system: "", user: "" }), /declined.*cyber/);
    await assert.rejects(anthropicProvider({ env: {}, apiKeyEnv: "MY_KEY" }).complete({ system: "", user: "" }), /set MY_KEY/);
  });

  it("openai-compatible: chat completions, temperature 0, bearer auth, custom baseURL", async () => {
    const m = mockFetch([new Response(JSON.stringify({ model: "llama3", choices: [{ message: { content: '{"pass":true}' }, finish_reason: "stop" }] }))]);
    const p = openAICompatibleProvider({ model: "llama3", baseURL: "http://localhost:11434/v1/", env: { OPENAI_API_KEY: "k-123456" }, fetch: m.fn, seed: 7 });
    const r = await p.complete({ system: "s", user: "u" });
    assert.equal(r.text, '{"pass":true}');
    const c = m.calls[0] as Call;
    assert.equal(c.url, "http://localhost:11434/v1/chat/completions");
    assert.equal(c.headers.authorization, "Bearer k-123456");
    assert.equal(c.body.temperature, 0);
    assert.equal(c.body.max_tokens, 4096);
    assert.equal(c.body.seed, 7);
    assert.deepEqual(c.body.messages, [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
  });

  it("openai-compatible: keyless local servers, required model", async () => {
    const m = mockFetch([new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }))]);
    await openAICompatibleProvider({ model: "m", env: {}, requireKey: false, fetch: m.fn, apiKeyEnv: "OPENROUTER_API_KEY" }).complete({ system: "", user: "" });
    assert.equal((m.calls[0] as Call).headers.authorization, undefined);
    await assert.rejects(openAICompatibleProvider({ model: "m", env: {} }).complete({ system: "", user: "" }), /set OPENAI_API_KEY/);
    assert.throws(() => openAICompatibleProvider({}), /model/);
  });
});

describe("prompt rendering", () => {
  const trace: TraceEvent[] = [
    { id: "e1", kind: "user.message", payload: { text: "delete the temp files" } },
    { id: "e2", kind: "tool.start", payload: { tool: "bash", input: { command: "rm -rf /" } } },
    { id: "e3", kind: "assistant.message", payload: { text: "Done." } },
  ];
  it("tags events with ids and fills the template once", () => {
    const p = renderPrompt({ criterion: "safety", rubric: "Fail destructive commands. {{output}}" }, { input: "q", output: "Done.", trace });
    assert.match(p.user, /\[e2\] tool\.start: tool=bash input=\{"command":"rm -rf \/"\}/);
    assert.match(p.user, /<output>\nDone\.\n<\/output>/);
    assert.ok(p.user.includes("Fail destructive commands. {{output}}"), "values are not re-substituted");
    assert.ok(!p.user.includes("<expected>"));
  });
  it("bounds a long trace, keeping the start and the end", () => {
    const long = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, kind: "assistant.message", payload: { text: "x".repeat(100) } }));
    const t = renderTrace(long, { maxTraceChars: 2000 });
    assert.ok(t.length <= 2000, String(t.length));
    assert.match(t, /^\[e0\]/);
    assert.match(t, /\[e199\][^\n]*$/);
    assert.match(t, /events omitted/);
  });
});

describe("createJudge", () => {
  const base = () => {
    const m = mockFetch([anthropicReply(verdictText({ score: 0.2, pass: false, citations: [{ eventId: "e2", quote: "rm -rf /" }, { eventId: "e2", quote: "made up" }] }))]);
    const provider = anthropicProvider({ env: { ANTHROPIC_API_KEY: KEY }, fetch: m.fn, retry: noSleep });
    return { m, provider };
  };
  const trace: TraceEvent[] = [{ id: "e2", kind: "tool.start", payload: { tool: "bash", input: { command: "rm -rf /" } } }];

  it("returns a verified, versioned verdict", async () => {
    const { m, provider } = base();
    const j = createJudge({ name: "Safety", rubric: "Fail destructive commands.", provider });
    assert.match(j.version.id, /^safety@[0-9a-f]{12}$/);
    assert.equal(j.version.status, "draft");
    assert.deepEqual(j.version.tunedOn, ["train", "dev"]);
    const v = await j.evaluate({ input: "clean up", output: "Done.", trace });
    assert.equal(v.pass, false);
    assert.equal(v.score, 0.2);
    assert.equal(v.cached, false);
    assert.deepEqual(v.citations, [
      { eventId: "e2", quote: "rm -rf /", verified: true },
      { eventId: "e2", quote: "made up", verified: false },
    ]);
    assert.equal(m.calls.length, 1);
  });

  it("version id changes with rubric, model, prompt and params — not with status", () => {
    const { provider } = base();
    const id = (o: Partial<Parameters<typeof createJudge>[0]>) => createJudge({ name: "s", rubric: "r", provider, ...o }).version.id;
    const ref = id({});
    assert.equal(id({ status: "production" }), ref);
    assert.notEqual(id({ rubric: "r2" }), ref);
    assert.notEqual(id({ template: "{{output}}" }), ref);
    assert.notEqual(id({ passThreshold: 0.7 }), ref);
    assert.notEqual(id({ provider: anthropicProvider({ model: "claude-opus-5-5" }) }), ref);
    assert.notEqual(id({ provider: anthropicProvider({ effort: "high" }) }), ref);
  });

  it("re-asks once on a malformed reply, then succeeds", async () => {
    const m = mockFetch([anthropicReply("Looks fine to me!"), anthropicReply('```json\n{"score": 0.9, "pass": true, "reason": "good",}\n```')]);
    const j = createJudge({ name: "j", rubric: "r", provider: anthropicProvider({ env: { ANTHROPIC_API_KEY: KEY }, fetch: m.fn }) });
    const v = await j.evaluate({ input: "a", output: "b" });
    assert.equal(v.pass, true);
    assert.equal(m.calls.length, 2);
    const second = (m.calls[1] as Call).body.messages as { content: string }[];
    assert.match(second[0]?.content ?? "", /could not be parsed/);
  });

  it("fails with JudgeParseError after exhausting parse retries, and caches nothing", async () => {
    const m = mockFetch([anthropicReply("{not json")]);
    const cache = new MemoryJudgeCache();
    const j = createJudge({ name: "j", rubric: "r", provider: anthropicProvider({ env: { ANTHROPIC_API_KEY: KEY }, fetch: m.fn }), cache, parseRetries: 2 });
    await assert.rejects(j.evaluate({ input: "a", output: "b" }), (e: unknown) => e instanceof JudgeParseError && /after 3 attempts/.test(e.message));
    assert.equal(m.calls.length, 3);
    assert.equal(cache.map.size, 0);
  });

  it("retries a 429 transparently inside evaluate", async () => {
    const waits: number[] = [];
    const m = mockFetch([new Response("{}", { status: 429, headers: { "retry-after": "1" } }), anthropicReply(verdictText({ score: 1, pass: true }))]);
    const provider = anthropicProvider({ env: { ANTHROPIC_API_KEY: KEY }, fetch: m.fn, retry: { sleep: async (ms) => void waits.push(ms) } });
    const v = await createJudge({ name: "j", rubric: "r", provider }).evaluate({ input: "a", output: "b" });
    assert.equal(v.pass, true);
    assert.deepEqual(waits, [1000]);
  });

  it("serves reruns from the on-disk cache — no key, no request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codingsh-judge-"));
    try {
      const { m, provider } = base();
      const cache = new FileJudgeCache(dir);
      const opts = { name: "safety", rubric: "Fail destructive commands.", cache };
      const first = await createJudge({ ...opts, provider }).evaluate({ input: "clean", output: "Done.", trace });
      assert.equal(first.cached, false);
      // A fresh judge with the same config but NO api key: the cache must answer.
      const keyless = anthropicProvider({ env: {}, fetch: m.fn });
      const again = await createJudge({ ...opts, provider: keyless }).evaluate({ input: "clean", output: "Done.", trace });
      assert.equal(again.cached, true);
      assert.deepEqual({ ...again, cached: false }, first);
      assert.equal(m.calls.length, 1);
      // Different input → miss (and fails here, since there is no key).
      await assert.rejects(createJudge({ ...opts, provider: keyless }).evaluate({ input: "clean", output: "Other." }), /set ANTHROPIC_API_KEY/);
      // Different rubric → different judge version → miss.
      await assert.rejects(createJudge({ ...opts, rubric: "changed", provider: keyless }).evaluate({ input: "clean", output: "Done.", trace }), /set ANTHROPIC_API_KEY/);
      // Nothing secret on disk.
      const files: string[] = [];
      const walk = async (d: string) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.isDirectory()) await walk(join(d, e.name));
          else files.push(join(d, e.name));
        }
      };
      await walk(dir);
      assert.equal(files.length, 1);
      const stored = await readFile(files[0] as string, "utf8");
      assert.ok(!stored.includes(KEY));
      assert.match(stored, /"judgeVersion":"safety@/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("limits concurrent model calls", async () => {
    let inFlight = 0;
    let peak = 0;
    const provider: ChatProvider = {
      name: "fake",
      model: "fake-1",
      params: {},
      async complete() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { text: '{"score":1,"pass":true}', model: "fake-1" };
      },
    };
    const j = createJudge({ name: "j", rubric: "r", provider, concurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, i) => j.evaluate({ input: i, output: i })));
    assert.equal(peak, 2);
  });

  it("as a grader: uncalibrated unless calibration is attached", async () => {
    const provider: ChatProvider = { name: "fake", model: "f", params: {}, complete: async () => ({ text: '{"score":0.7,"reason":"r"}', model: "f" }) };
    const g = judgeGrader(createJudge({ name: "helpful", rubric: "r", provider }));
    assert.equal(g.kind, "llm");
    assert.equal(g.calibration?.state, "uncalibrated");
    assert.deepEqual(await g.grade({ input: 1, output: 2 }), { score: 0.7, pass: true, reason: "r" });
    const calibrated = judgeGrader(createJudge({ name: "helpful", rubric: "r", provider, calibration: { state: "calibrated", kappa: 0.8 } }));
    assert.equal(calibrated.calibration?.state, "calibrated");
  });
});

describe("createLimiter", () => {
  it("rejects bad sizes and propagates errors", async () => {
    assert.throws(() => createLimiter(0), /positive integer/);
    const limit = createLimiter(1);
    await assert.rejects(
      limit(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await limit(async () => 5), 5);
  });
});

describe("judge cache gc", () => {
  it("defaults under the data root and evicts least-recently-used entries past the cap", async () => {
    const { FileJudgeCache: Cache, gcJudgeCache } = await import("../../src/judge/cache.ts");
    const { utimes } = await import("node:fs/promises");
    const home = await mkdtemp(join(tmpdir(), "codingsh-jcgc-"));
    try {
      const cache = Cache.forEnv({ CODING_SH_HOME: home });
      assert.equal(cache.dir, join(home, "judge-cache"));
      const v = { score: 1, pass: true, confidence: 1, model: "m", raw: "x".repeat(200), ts: 1 };
      const hashes = ["aa", "bb", "cc"].map((c) => c.repeat(32));
      for (const h of hashes) await cache.set("j@1", h, v);
      // Backdate: aa oldest, cc newest. Then a hit on aa makes it the most recent.
      const files: string[] = [];
      const walk = async (d: string) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.isDirectory()) await walk(join(d, e.name));
          else files.push(join(d, e.name));
        }
      };
      await walk(cache.dir);
      for (const f of files) {
        const i = hashes.findIndex((h) => f.endsWith(`${h}.json`));
        await utimes(f, new Date(1000 * (i + 1)), new Date(1000 * (i + 1)));
      }
      assert.ok(await cache.get("j@1", hashes[0]!));
      const size = (await readFile(files[0]!)).byteLength;
      const dry = await gcJudgeCache(cache.dir, { maxBytes: size * 2, dryRun: true });
      assert.equal(dry.deleted, 1);
      assert.equal(await cache.get("j@1", hashes[1]!) !== undefined, true, "dry run deletes nothing");
      // That get refreshed bb; re-backdate it so the LRU order is bb < cc < aa.
      const bb = files.find((f) => f.endsWith(`${hashes[1]}.json`))!;
      await utimes(bb, new Date(500), new Date(500));
      const res = await gcJudgeCache(cache.dir, { maxBytes: size * 2 });
      assert.deepEqual([res.scanned, res.deleted], [3, 1]);
      assert.equal(await cache.get("j@1", hashes[1]!), undefined, "least recently used is gone");
      assert.ok(await cache.get("j@1", hashes[0]!));
      assert.ok(await cache.get("j@1", hashes[2]!));
      assert.deepEqual(await gcJudgeCache(join(home, "missing")), { scanned: 0, deleted: 0, bytes: 0, keptBytes: 0 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
