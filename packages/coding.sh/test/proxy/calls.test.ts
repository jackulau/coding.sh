// Reading logged model calls back: call references, the request re-inlined
// from its blobs, and diffCalls explaining a prompt cache miss by the first
// change in cache order (tools, system, messages). Through the real proxy into
// memory stores, the viewer's /api/calls, and the CLI against a temp store.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { printDiff } from "../../src/cli/commands/diff-calls.ts";
import { Output } from "../../src/cli/output.ts";
import { loadConfig } from "../../src/core/config.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { CallRefError, diffCalls, lineDiff, loadCall, previousCall, resolveCall } from "../../src/proxy/calls.ts";
import { recorderFor } from "../../src/proxy/index.ts";
import { startProxy } from "../../src/proxy/server.ts";
import { openStores } from "../../src/store/factory.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { anthropicStream, call, startTestProxy, startUpstream, type TestProxy, type Upstream } from "./_helpers.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const SECRET = "sk-ant-api03-CALLSCALLSCALLSCALLSCALLSCALLSCALLS-abcdefAA";
const SESSION = "7d2e4b1a-0c9f-4e8d-b3a2-1f0e9d8c7b6a";

const SYSTEM_1 = ["You are a careful coding agent.", "Run the tests before you say done.", "Today is 2026-11-06."].join("\n");
const SYSTEM_2 = ["You are a careful coding agent.", "Run the tests before you say done.", "Today is 2026-11-07."].join("\n");
const TOOLS = [
  { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
  { name: "Read", description: "Read a file", input_schema: { type: "object" } },
];
const GREP = { name: "Grep", description: "Search files", input_schema: { type: "object" } };
const u = (text: string, marker = false) => ({ role: "user", content: [{ type: "text", text, ...(marker ? { cache_control: { type: "ephemeral" } } : {}) }] });
const a = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

/** The five turns: a cache write, a hit, a system prompt edit, a new tool, and a moved cache marker (still a hit). */
const TURNS: { system: string; tools: unknown[]; messages: unknown[]; read: number; write: number }[] = [
  { system: SYSTEM_1, tools: TOOLS, messages: [u("fix the failing test", true)], read: 0, write: 4000 },
  { system: SYSTEM_1, tools: TOOLS, messages: [u("fix the failing test"), a("Looking."), u("go on", true)], read: 4000, write: 200 },
  { system: SYSTEM_2, tools: TOOLS, messages: [u("fix the failing test"), a("Looking."), u("go on"), a("Done."), u("and the docs", true)], read: 0, write: 4400 },
  { system: SYSTEM_2, tools: [...TOOLS, GREP], messages: [u("fix the failing test"), a("Looking."), u("go on"), a("Done."), u("and the docs"), a("Ok."), u("thanks", true)], read: 0, write: 4600 },
  { system: SYSTEM_2, tools: [...TOOLS, GREP], messages: [u("fix the failing test"), a("Looking."), u("go on"), a("Done."), u("and the docs"), a("Ok."), u("thanks"), a("Sure."), u("bye", true)], read: 4600, write: 100 },
];

let queue: { read: number; write: number }[] = [];
let up: Upstream;
before(async () => {
  up = await startUpstream((_req, res) => {
    const next = queue.shift() ?? { read: 0, write: 0 };
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_calls" });
    for (const s of anthropicStream({ text: "ok" })) res.write(s.replace('"cache_read_input_tokens":5000', `"cache_read_input_tokens":${next.read}`).replace('"cache_creation_input_tokens":300', `"cache_creation_input_tokens":${next.write}`));
    res.end();
  });
});
after(async () => {
  await up?.close();
});

/** Sends the five turns through a proxy at `base`, one at a time. */
async function sendTurns(base: string): Promise<void> {
  for (const t of TURNS) {
    queue.push({ read: t.read, write: t.write });
    const r = await call(base, {
      method: "POST",
      path: "/v1/messages?beta=true",
      headers: { "content-type": "application/json", "x-api-key": SECRET, "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.319 (external, cli)", "x-claude-code-session-id": SESSION },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, stream: true, system: [{ type: "text", text: t.system, cache_control: { type: "ephemeral" } }], tools: t.tools, messages: t.messages }),
    });
    assert.equal(r.status, 200);
  }
}

describe("proxy calls: refs, load and diff", () => {
  let t: TestProxy;
  let calls: AgentEvent[] = [];
  before(async () => {
    t = await startTestProxy(up.url);
    await sendTurns(t.proxy.url);
    await t.recorder.flush();
    calls = await t.index.listEvents(SESSION, { kinds: ["llm.call"] });
  });
  after(async () => {
    await t?.close();
  });

  it("logs each turn as a call in the agent's session", () => {
    assert.equal(calls.length, 5);
    assert.deepEqual(calls.map((e) => e.usage?.cacheReadTokens), [0, 4000, 0, 0, 4600]);
  });

  it("resolves an id, an id prefix, <session>#n, #-1 and latest#n", async () => {
    const third = calls[2]!;
    assert.equal((await resolveCall(t.index, third.id)).id, third.id);
    assert.equal((await resolveCall(t.index, third.id.slice(0, 12))).id, third.id);
    assert.equal((await resolveCall(t.index, `${SESSION}#3`)).id, third.id);
    assert.equal((await resolveCall(t.index, `${SESSION.slice(0, 8)}#1`)).id, calls[0]!.id);
    assert.equal((await resolveCall(t.index, `${SESSION}#-1`)).id, calls[4]!.id);
    assert.equal((await resolveCall(t.index, "latest#2")).id, calls[1]!.id);
  });

  it("refuses short prefixes, missing calls and bad call numbers", async () => {
    await assert.rejects(resolveCall(t.index, calls[0]!.id.slice(0, 4)), (e: unknown) => e instanceof CallRefError && e.reason === "not_found" && /at least 6/.test(e.message));
    await assert.rejects(resolveCall(t.index, `${SESSION}#9`), (e: unknown) => e instanceof CallRefError && /has 5 model calls; no #9/.test(e.message));
    await assert.rejects(resolveCall(t.index, `${SESSION}#x`), /call number/);
    await assert.rejects(resolveCall(t.index, "nosuchsession#1"), /Can't find session/);
    await assert.rejects(resolveCall(t.index, "ffffffffffff"), /Can't find call/);
  });

  it("<session>#n counts the proxy's calls when the transcript logged the same turns too", async () => {
    const index = new MemoryIndexStore();
    const ev = (id: string, ts: number, source?: string): AgentEvent => ({ id, v: 0, sessionId: "s2", ts, agent: "claude-code", kind: "llm.call", payload: {}, ...(source ? { source } : {}) });
    const events = [ev("transcript-1", 1, "transcript"), ev("proxycall-1", 2, "proxy"), ev("transcript-2", 3, "transcript"), ev("proxycall-2", 4, "proxy")];
    await index.putEvents(events);
    await index.upsertSession(buildSession(events));
    assert.equal((await resolveCall(index, "s2#1")).id, "proxycall-1");
    assert.equal((await resolveCall(index, "s2#-1")).id, "proxycall-2");
    assert.equal((await previousCall(index, await resolveCall(index, "s2#2")))?.id, "proxycall-1");
  });

  it("names the candidates when a prefix is ambiguous", async () => {
    const index = new MemoryIndexStore();
    const ev = (id: string): AgentEvent => ({ id, v: 0, sessionId: "s1", ts: 1, agent: "claude-code", kind: "llm.call", payload: {} });
    await index.putEvents([ev("abcdef01aaaa"), ev("abcdef02bbbb")]);
    await assert.rejects(resolveCall(index, "abcdef"), (e: unknown) => e instanceof CallRefError && e.reason === "ambiguous" && e.candidates.length === 2);
    assert.equal((await resolveCall(index, "abcdef02")).id, "abcdef02bbbb");
  });

  it("re-inlines the system prompt and tools the event keeps in blobs, and never the API key", async () => {
    const l = await loadCall(t.blobs, calls[0]!);
    assert.ok(l.request, "the request was stored");
    assert.equal(l.request!.api, "messages");
    assert.deepEqual((l.request!.body.system as { text: string }[])[0]!.text, SYSTEM_1);
    assert.deepEqual((l.request!.body.tools as { name: string }[]).map((x) => x.name), ["Bash", "Read"]);
    assert.equal(l.info?.system, SYSTEM_1);
    assert.equal(l.response?.status, 200);
    assert.ok(!JSON.stringify(l).includes(SECRET));
  });

  it("a call that extends the previous one and reads its cache: a hit, no cause", async () => {
    const d = diffCalls(await loadCall(t.blobs, calls[0]!), await loadCall(t.blobs, calls[1]!));
    assert.equal(d.content, "full");
    assert.equal(d.tools.same, true);
    assert.equal(d.system.same, true);
    assert.deepEqual(d.messages, { a: 1, b: 3, shared: 1, rewritten: false }, "the moved cache_control marker is not a change");
    assert.equal(d.cache.reused, true);
    assert.equal(d.cache.cause, undefined);
  });

  it("a system prompt edit: a miss, explained by the first changed line", async () => {
    const d = diffCalls(await loadCall(t.blobs, calls[1]!), await loadCall(t.blobs, calls[2]!));
    assert.equal(d.system.same, false);
    assert.deepEqual(d.system.lines?.filter((l) => l.op !== " "), [{ op: "-", text: "Today is 2026-11-06." }, { op: "+", text: "Today is 2026-11-07." }]);
    assert.equal(d.cache.reused, false);
    assert.equal(d.cache.expected, 4200);
    assert.match(d.cache.cause ?? "", /^the system prompt changed \(first change: - Today is 2026-11-06\.\)/);
    // The date sits on the last line: almost all of the prefix before it stays cacheable, so no move-to-end hint.
    assert.equal(d.system.firstChangeLine, 3);
    assert.ok(d.system.wastedPrefixFrac! > 0 && d.system.wastedPrefixFrac! < 0.05, String(d.system.wastedPrefixFrac));
    assert.doesNotMatch(d.cache.cause ?? "", /move dynamic content/);
  });

  it("a system prompt edit near the top: the share re-billed after it, and the move-to-end hint", async () => {
    const [x, y] = [await loadCall(t.blobs, calls[1]!), await loadCall(t.blobs, calls[2]!)];
    const rules = Array.from({ length: 40 }, (_, i) => `Rule ${i}: keep the change small and run the tests.`);
    const top = (date: string) => [`Today is ${date}.`, ...rules].join("\n");
    const d = diffCalls({ ...x, info: { ...x.info!, system: top("2026-11-06") } }, { ...y, info: { ...y.info!, system: top("2026-11-07") } });
    assert.equal(d.cache.reused, false);
    assert.equal(d.system.firstChangeLine, 1);
    assert.ok(d.system.wastedPrefixFrac! > 0.95, String(d.system.wastedPrefixFrac));
    assert.match(d.cache.cause ?? "", /^the system prompt changed \(first change: - Today is 2026-11-06\.\); ~(9[5-9]|100)% of the system prompt came after this change and was re-billed; move dynamic content \(timestamps, session ids\) to the end of the system prompt/);

    // The same edit moved to the bottom: a small share and no hint.
    const bottom = (date: string) => [...rules, `Today is ${date}.`].join("\n");
    const low = diffCalls({ ...x, info: { ...x.info!, system: bottom("2026-11-06") } }, { ...y, info: { ...y.info!, system: bottom("2026-11-07") } });
    assert.equal(low.system.firstChangeLine, 41);
    assert.ok(low.system.wastedPrefixFrac! < 0.01, String(low.system.wastedPrefixFrac));
    assert.doesNotMatch(low.cache.cause ?? "", /move dynamic content/);

    // diff-calls prints the share on the System row and the hint on the Why row.
    let text = "";
    printDiff(new Output({ json: false, noColor: true, env: {}, stdout: { write: (x: string) => (text += x), isTTY: false }, stdin: { isTTY: false } }), d);
    assert.match(text, /^System {4}changed from line 1 \(9\d% of a's system prompt comes after the change\)$/m);
    assert.match(text, /^Why {7}the system prompt changed .*move dynamic content \(timestamps, session ids\) to the end/m);

    // Unchanged system prompts carry neither field.
    const same = diffCalls(x, { ...y, info: { ...y.info!, system: x.info!.system } });
    assert.equal(same.system.firstChangeLine, undefined);
    assert.equal(same.system.wastedPrefixFrac, undefined);
  });

  it("a new tool: a miss, blamed on the tools before the system prompt", async () => {
    const d = diffCalls(await loadCall(t.blobs, calls[2]!), await loadCall(t.blobs, calls[3]!));
    assert.deepEqual(d.tools.added, ["Grep"]);
    assert.equal(d.system.same, true);
    assert.match(d.cache.cause ?? "", /tool definitions changed \(added Grep\)/);
    const hit = diffCalls(await loadCall(t.blobs, calls[3]!), await loadCall(t.blobs, calls[4]!));
    assert.equal(hit.cache.reused, true);
  });

  it("the model, a rewritten history and a long gap are causes too", async () => {
    const [x, y] = [await loadCall(t.blobs, calls[1]!), await loadCall(t.blobs, calls[2]!)];
    const withModel = diffCalls(x, { ...y, event: { ...y.event, model: "claude-opus-4-5" } });
    assert.match(withModel.cache.cause ?? "", /^the model changed/);
    const sameSystem = { ...y, info: { ...y.info!, system: x.info!.system } };
    const rewritten = diffCalls(x, { ...sameSystem, info: { ...sameSystem.info, messages: [u("something else")] } });
    assert.match(rewritten.cache.cause ?? "", /history was rewritten from message 1/);
    const late = diffCalls(x, { ...sameSystem, event: { ...y.event, ts: x.event.ts + 20 * 60_000 } });
    assert.match(late.cache.cause ?? "", /20 min passed/);
  });
});

describe("proxy calls: metadata mode", () => {
  it("compares hashes and tool names when no content was stored", async () => {
    const t = await startTestProxy(up.url, { config: { mode: "metadata" } });
    try {
      await sendTurns(t.proxy.url);
      await t.recorder.flush();
      const calls = await t.index.listEvents(SESSION, { kinds: ["llm.call"] });
      const [l2, l3, l4] = await Promise.all([calls[1]!, calls[2]!, calls[3]!].map((e) => loadCall(t.blobs, e)));
      assert.equal(l3!.request, undefined);
      const sys = diffCalls(l2!, l3!);
      assert.equal(sys.content, "metadata");
      assert.equal(sys.system.same, false);
      assert.match(sys.system.a ?? "", /^[0-9a-f]{16}$/);
      assert.match(sys.cache.cause ?? "", /^the system prompt changed$/);
      assert.equal(sys.system.firstChangeLine, undefined, "no content, no line");
      assert.equal(sys.system.wastedPrefixFrac, undefined, "no content, no fraction");
      const tools = diffCalls(l3!, l4!);
      assert.deepEqual(tools.tools.added, ["Grep"]);
    } finally {
      await t.close();
    }
  });
});

describe("lineDiff", () => {
  it("keeps changes with two lines of context and marks gaps", () => {
    const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const b = a.replace("line 10", "line ten");
    const d = lineDiff(a, b)!;
    assert.deepEqual(d.map((l) => l.op + l.text), [" line 8", " line 9", "-line 10", "+line ten", " line 11", " line 12"]);
    const two = lineDiff(a, b.replace("line 1\n", "line one\n"))!;
    assert.ok(two.some((l) => l.text === "…"), "a gap between distant changes");
  });

  it("gives up on huge inputs", () => {
    const big = (s: string) => Array.from({ length: 50 }, (_, i) => `${s}${i}`).join("\n");
    assert.equal(lineDiff(big("a"), big("b"), 2, 10), undefined);
  });
});

describe("viewer /api/calls", () => {
  let t: TestProxy;
  let v: Viewer;
  let calls: AgentEvent[] = [];
  before(async () => {
    t = await startTestProxy(up.url);
    await sendTurns(t.proxy.url);
    await t.recorder.flush();
    calls = await t.index.listEvents(SESSION, { kinds: ["llm.call"] });
    v = await startViewer({ index: t.index, blobs: t.blobs, port: 0, token: "test-token" });
  });
  after(async () => {
    await v?.close();
    await t?.close();
  });
  // A fresh connection per request, as in test/query/where-surfaces.test.ts: CLI runs block this event loop.
  const get = (path: string) => fetch(`http://127.0.0.1:${v.port}${path}`, { headers: { authorization: "Bearer test-token", connection: "close" } });

  it("returns the call with its request and response", async () => {
    const r = await get(`/api/calls/${calls[2]!.id}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { call: AgentEvent; request: { body: { system: { text: string }[] } }; response: { status: number } };
    assert.equal(body.call.id, calls[2]!.id);
    assert.equal(body.request.body.system[0]!.text, SYSTEM_2);
    assert.equal(body.response.status, 200);
  });

  it("diffs a call with the one before it, or with ?with=", async () => {
    const d = (await (await get(`/api/calls/${calls[2]!.id}/diff`)).json()) as { a: { id: string }; cache: { cause: string } };
    assert.equal(d.a.id, calls[1]!.id);
    assert.match(d.cache.cause, /system prompt changed/);
    const w = (await (await get(`/api/calls/${calls[4]!.id}/diff?with=${calls[0]!.id}`)).json()) as { a: { id: string }; tools: { added: string[] } };
    assert.equal(w.a.id, calls[0]!.id);
    assert.deepEqual(w.tools.added, ["Grep"]);
  });

  it("404s the first call's diff and unknown calls", async () => {
    assert.equal((await get(`/api/calls/${calls[0]!.id}/diff`)).status, 404);
    assert.equal((await get("/api/calls/ffffffffffffffff")).status, 404);
    assert.equal((await get(`/api/calls/${calls[0]!.id}/nope`)).status, 404);
  });
});

describe("CLI: show <call> and diff-calls", () => {
  let root = "";
  let env: NodeJS.ProcessEnv = {};
  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-calls-")));
    env = { PATH: process.env.PATH, HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
    const config = loadConfig(env);
    const stores = await openStores(config);
    const recorder = recorderFor({ config, index: stores.index, blobs: stores.blobs, env: {} });
    const proxy = await startProxy({ port: 0, upstreams: { anthropic: up.url, openai: up.url }, recorder });
    try {
      await sendTurns(proxy.url);
      await recorder.flush();
    } finally {
      await proxy.close();
      await stores.index.close();
      await stores.blobs.close?.();
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", timeout: 60_000 });

  it("diff-calls <session>#3 explains the miss against the call before it", () => {
    const r = cli("diff-calls", `${SESSION}#3`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^System {4}changed from line 3 \(2% of a's system prompt comes after the change\)$/m);
    assert.match(r.stdout, /- Today is 2026-11-06\./);
    assert.match(r.stdout, /\+ Today is 2026-11-07\./);
    assert.match(r.stdout, /^Cache {5}miss: b read 0 of the 4.2k a cached, and wrote 4.4k/m);
    assert.match(r.stdout, /^Why {7}the system prompt changed/m);
  });

  it("diff-calls --json and two named calls", () => {
    const r = cli("diff-calls", `${SESSION}#3`, `${SESSION}#4`, "--json");
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout) as { data?: { tools: { added: string[] } }; tools?: { added: string[] } };
    assert.deepEqual((d.data ?? d).tools!.added, ["Grep"]);
  });

  it("diff-calls on a session's first call says to name two", () => {
    const r = cli("diff-calls", `${SESSION}#1`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /first model call of its session/);
  });

  it("show <call> prints the system prompt, tools and cache", () => {
    const r = cli("show", `${SESSION}#-1`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Session {3}7d2e4b1a-0c9f-4e8d-b3a2-1f0e9d8c7b6a/m);
    assert.match(r.stdout, /^System {4}\d+ chars, 3 lines/m);
    assert.match(r.stdout, /Today is 2026-11-07\./);
    assert.match(r.stdout, /^Tools {5}3 .*Bash, Read, Grep/m);
    assert.match(r.stdout, /cache read 4.6k write 100 \(98% hit\)/);
    assert.ok(!r.stdout.includes(SECRET));
  });
});
