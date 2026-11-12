// weightsEdit: one `notification` event with payload.kind "weights.edit" (docs/reference/api.md).
//
// These mirror packages/sdk-python/tests/test_weights.py case for case. Most read the batch the
// SDK posts to a fake ingest endpoint. The parity tests check those batches against
// test/fixtures/weights-edit.json, which the Python SDK's tests check too. The last test starts a
// real `coding.sh serve` on a temp CODING_SH_HOME and reads the event back, redacted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { flush, init, shutdown, span, stats, trace, weightsDelta, weightsEdit, withSession, type WeightsArray, type WeightsEdit } from "../src/index.ts";
import { _reset } from "../src/client.ts";
import { MAX_TEXT_BYTES } from "../src/util.ts";
import { type FakeServe, startFakeServe } from "./helpers/fake-serve.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "..", "coding.sh", "src", "cli", "main.ts");
const A = "a".repeat(64);
const B = "b".repeat(64);
// Built in pieces so push protection does not flag the test file.
const FAKE_TOKEN = ["ghp_", "0123456789", "abcdefghij", "ABCDEFGHIJ", "klmnop"].join("");

/** An event as the SDK posted it, before the server parsed it. */
interface Wire {
  id: string;
  kind: string;
  sessionId: string;
  traceId: string;
  spanId: string;
  parentId?: string;
  parentSpanId?: string;
  turnId?: string;
  payload: Record<string, unknown>;
}

interface Fixture {
  edit: WeightsEdit;
  payload: Record<string, unknown>;
  volatilePayloadKeys: string[];
  ignoredEventKeys: string[];
  scenarios: Record<string, { sessionId: string | null; parent: string | null; events: { kind: string; keys: string[]; payload?: Record<string, unknown> }[] }>;
  delta: { base: WeightsArray; edited: WeightsArray; result: unknown };
}

// What both SDKs must send for the same edit. A missing fixture fails every test in this file.
const fx = JSON.parse(readFileSync(join(here, "fixtures", "weights-edit.json"), "utf8")) as Fixture;

let serve: FakeServe;
let mark = 0;
before(async () => {
  serve = await startFakeServe();
});
after(async () => {
  assert.deepEqual(serve.rejected, [], "the real server parser accepts every SDK event");
  await serve.close();
});
beforeEach(() => start());
afterEach(async () => {
  await shutdown(1000);
});

function start(opts: Parameters<typeof init>[0] = {}): void {
  _reset();
  init({ url: serve.url, flushIntervalMs: 5, ...opts });
  mark = serve.requests.length;
}

/** The events posted since start(), in the order they were sent. */
async function posted(): Promise<Wire[]> {
  assert.equal(await flush(), true, "flush timed out");
  return serve.requests
    .slice(mark)
    .filter((r) => r.path === "/v1/ingest" && r.status === 200)
    .flatMap((r) => (r.body as { events: Wire[] }).events);
}

const byKind = (events: Wire[], kind: string) => events.filter((e) => e.kind === kind);

function one<T>(list: T[]): T {
  assert.equal(list.length, 1);
  return list[0]!;
}

const edit = (over: Record<string, unknown> = {}): boolean =>
  weightsEdit({ tensor: "layers.3.mlp.down_proj.weight", shape: [4, 8], changed: 12, l2: 0.25, maxAbs: 0.1, baseSha256: A, editedSha256: B, ...over } as WeightsEdit);

/** Runs fn and returns what it sent to console.warn. */
async function warnings(fn: () => unknown): Promise<string[]> {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return warns;
}

test("one notification with the payload", async () => {
  assert.equal(edit({ note: "rank-1 patch" }), true);
  const events = await posted();
  assert.deepEqual(one(byKind(events, "notification")).payload, {
    kind: "weights.edit",
    tensor: "layers.3.mlp.down_proj.weight",
    shape: [4, 8],
    changed: 12,
    l2: 0.25,
    maxAbs: 0.1,
    baseSha256: A,
    editedSha256: B,
    note: "rank-1 patch",
  });
  assert.equal(byKind(events, "session.start").length, 1, "a session of its own");
  // The Python SDK sends `source`; here the server fills it in. Both are stored as "sdk".
  assert.equal(one(serve.events().filter((e) => e.kind === "notification" && e.sessionId === events[0]!.sessionId)).source, "sdk");
});

test("joins the current trace", async () => {
  trace(
    "edit-run",
    () => {
      edit();
      edit({ tensor: "lm_head.weight" });
    },
    { sessionId: "conv-1" },
  );
  const events = await posted();
  assert.deepEqual(byKind(events, "notification").map((n) => n.sessionId), ["conv-1", "conv-1"]);
  assert.equal(byKind(events, "session.start").length, 1);
});

test("metadata mode drops the note only", async () => {
  start({ capture: "metadata" });
  edit({ note: "free text" });
  const p = one(byKind(await posted(), "notification")).payload;
  assert.ok(!("note" in p));
  assert.equal(p.changed, 12);
  assert.equal(p.tensor, "layers.3.mlp.down_proj.weight", "the tensor's name is not free text");
});

test("invalid values are dropped, not thrown", async () => {
  const bad: Record<string, unknown>[] = [
    { changed: -1 },
    { changed: true },
    { changed: 2.5 },
    { changed: 33 }, // more than 4 * 8 weights
    { changed: "12" },
    { changed: 12n },
    { changed: Number.NaN },
    { changed: 2 ** 53, shape: [2 ** 53] }, // not an integer JavaScript can hold exactly
    { l2: -0.1 },
    { l2: Number.NaN },
    { l2: "0.25" },
    { maxAbs: Number.POSITIVE_INFINITY },
    { maxAbs: undefined },
    { baseSha256: "abc" },
    { editedSha256: "g".repeat(64) },
    { shape: [4, -1] },
    { shape: [4, 8.5] },
    { shape: "4x8" },
    { shape: new Int32Array([4, 8]) },
    { shape: [4, , 8] }, // a hole is not an integer
    { shape: Array.from({ length: 17 }, () => 1) },
    { tensor: "" },
    { tensor: null },
    { baseSha256: A + "\n" }, // a trailing newline is not 64 hex characters
  ];
  const warns = await warnings(() => {
    for (const over of bad) assert.equal(edit(over), false, JSON.stringify(Object.keys(over)));
    // A call from plain JavaScript can pass anything.
    const untyped = weightsEdit as (edit: unknown) => boolean;
    for (const arg of [undefined, null, "edit", 5]) assert.equal(untyped(arg), false, String(arg));
  });
  assert.equal(warns.length, 1);
  assert.deepEqual(byKind(await posted(), "notification"), []);
});

test("an empty tensor and a scalar are valid shapes", async () => {
  assert.equal(edit({ shape: [], changed: 1 }), true, "no dimensions: one weight");
  assert.equal(edit({ shape: [0, 3], changed: 0 }), true);
  assert.equal(edit({ shape: [4, 8], changed: 32 }), true, "every weight changed");
  await warnings(() => assert.equal(edit({ shape: [0, 3], changed: 1 }), false));
  assert.deepEqual(byKind(await posted(), "notification").map((n) => n.payload.shape), [[], [0, 3], [4, 8]]);
});

test("uppercase sha is lowercased", async () => {
  assert.equal(edit({ baseSha256: "A".repeat(64) }), true);
  assert.equal(one(byKind(await posted(), "notification")).payload.baseSha256, A);
});

test("returns false when disabled", () => {
  _reset();
  init({ url: serve.url, disabled: true });
  assert.equal(edit(), false);
});

test("a valid edit is silent when disabled; an invalid one still warns, as in Python", async () => {
  _reset();
  init({ url: serve.url, disabled: true });
  assert.deepEqual(await warnings(() => assert.equal(edit(), false)), []);
  const warns = await warnings(() => assert.equal(edit({ tensor: "" }), false));
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /tensor must be a non-empty string/);
});

test("returns false without a URL", () => {
  _reset();
  init({ url: "" });
  assert.equal(edit(), false);
});

test("returns false after shutdown", async () => {
  assert.equal(edit(), true);
  await shutdown(2000);
  const warns = await warnings(() => assert.equal(edit(), false));
  assert.deepEqual(warns, [], "no warning: nothing is wrong with the edit");
});

test("returns false when the queue is full", async () => {
  start({ maxQueue: 1, flushIntervalMs: 60_000 });
  // The trace's session.start takes the one slot.
  await warnings(() => trace("full", () => assert.equal(edit(), false)));
  assert.equal(stats().queued, 1);
});

test("warns once per process", async () => {
  const warns = await warnings(() => {
    edit({ changed: -1 });
    edit({ changed: -2 });
    edit({ l2: -1 });
    init({ url: serve.url, flushIntervalMs: 5 }); // a second init() is the same process
    edit({ changed: -3 });
  });
  assert.equal(warns.filter((w) => w.includes("weightsEdit dropped")).length, 1);
  assert.match(warns[0]!, /^\[coding\.sh\] weightsEdit dropped an event: changed must be a non-negative integer, got -1$/);
});

test("a note that is not a string is dropped with a warning", async () => {
  const warns = await warnings(() => {
    assert.equal(edit({ note: 5 }), true);
    assert.equal(edit({ note: { text: "x" } }), true);
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /note/);
  const notes = byKind(await posted(), "notification");
  assert.equal(notes.length, 2);
  for (const n of notes) {
    assert.ok(!("note" in n.payload));
    assert.equal(n.payload.changed, 12);
  }
});

test("an empty or missing note is left out without a warning", async () => {
  const warns = await warnings(() => {
    for (const note of ["", null, undefined]) assert.equal(edit({ note }), true);
  });
  assert.deepEqual(warns, []);
  for (const n of byKind(await posted(), "notification")) assert.ok(!("note" in n.payload));
});

test("a long tensor name or note is cut like every other SDK string", async () => {
  const long = "x".repeat(MAX_TEXT_BYTES + 10);
  assert.equal(edit({ tensor: long, note: long }), true);
  const p = one(byKind(await posted(), "notification")).payload;
  assert.equal((p.tensor as string).length, MAX_TEXT_BYTES);
  assert.equal((p.note as string).length, MAX_TEXT_BYTES);
  assert.equal(p.truncated, true);
});

test("inside withSession", async () => {
  withSession("run-7", () => {
    edit();
    edit({ tensor: "b" });
  });
  assert.deepEqual(byKind(await posted(), "notification").map((n) => n.sessionId), ["run-7", "run-7"]);
});

test("inside a span links to it", async () => {
  trace("run", () => span("tool", "patch", () => void edit()));
  const events = await posted();
  const note = one(byKind(events, "notification"));
  const tool = one(byKind(events, "tool.start"));
  assert.equal(note.parentId, tool.id);
  assert.equal(note.parentSpanId, tool.spanId);
});

test("an edit after an await still joins the trace", async () => {
  await trace("run", async () => {
    await new Promise((r) => setTimeout(r, 1));
    edit();
  });
  const events = await posted();
  assert.equal(one(byKind(events, "notification")).parentId, one(byKind(events, "session.start")).id);
});

test("server down never throws", async () => {
  const dead = await startFakeServe();
  const url = dead.url;
  await dead.close();
  _reset();
  init({ url, flushIntervalMs: 5 });
  await warnings(async () => {
    assert.equal(edit(), true, "queued; delivery fails in the background");
    assert.equal(await flush(200), false);
    await shutdown(200);
  });
});

// ---------------------------------------------------------------- weightsDelta

test("weightsDelta", () => {
  assert.deepEqual(weightsDelta([[1, 2], [3, 4]], [[1, 2], [3, 7]]), { shape: [2, 2], changed: 1, l2: 3, maxAbs: 3 });
  assert.deepEqual(weightsDelta([0, 0, 0], [3, 0, -4]), { shape: [3], changed: 2, l2: 5, maxAbs: 4 });
  assert.throws(() => weightsDelta([1, 2], [[1, 2]]), RangeError);
});

test("weightsDelta edges", () => {
  assert.deepEqual(weightsDelta([], []), { shape: [0], changed: 0, l2: 0, maxAbs: 0 });
  assert.deepEqual(weightsDelta([[], []], [[], []]).shape, [2, 0]);
  assert.equal(weightsDelta([0, 1, 2], [0, 1, 5]).changed, 1);
  assert.deepEqual(weightsDelta(new Float32Array(0), []).shape, [0]);
  let deep: WeightsArray = [1];
  for (let i = 1; i < 16; i++) deep = [deep];
  assert.deepEqual(weightsDelta(deep, deep), { shape: Array.from({ length: 16 }, () => 1), changed: 0, l2: 0, maxAbs: 0 });
});

test("weightsDelta reads typed arrays", () => {
  assert.deepEqual(weightsDelta(new Float32Array([0, 0, 0]), new Float32Array([3, 0, -4])), { shape: [3], changed: 2, l2: 5, maxAbs: 4 });
  assert.deepEqual(weightsDelta([new Float64Array([1, 2]), new Float64Array([3, 4])], [[1, 2], [3, 7]]), { shape: [2, 2], changed: 1, l2: 3, maxAbs: 3 });
  assert.deepEqual(weightsDelta(new Int8Array([1, 2]), new Uint16Array([1, 4])), { shape: [2], changed: 1, l2: 2, maxAbs: 2 });
  assert.throws(() => weightsDelta(new Float32Array([Number.NaN]), new Float32Array([1])), RangeError);
});

test("weightsDelta throws on bad input", () => {
  let deep: unknown = [1];
  for (let i = 0; i < 16; i++) deep = [deep]; // 17 levels
  const gen = (function* () {
    yield 1;
  })();
  const bad: [unknown, unknown, typeof TypeError | typeof RangeError][] = [
    [[1, [2]], [1, [2]], RangeError],
    [[[1], 2], [[1], 2], RangeError],
    [[[], [1]], [[], [1]], RangeError],
    [["a"], ["a"], TypeError],
    [[null], [null], TypeError],
    [[true], [true], TypeError],
    [[1n], [1n], TypeError],
    [[1, , 3], [1, 2, 3], TypeError], // a hole is not a number
    [new BigInt64Array(1), new BigInt64Array(1), TypeError],
    [null, null, TypeError],
    [undefined, [1], TypeError],
    [5, 5, TypeError],
    ["ab", "ab", TypeError],
    [gen, [1], TypeError],
    [{ length: 1, 0: 1 }, [1], TypeError],
    [new DataView(new ArrayBuffer(8)), [1], TypeError],
    [[Number.NaN], [1], RangeError],
    [[1], [Number.POSITIVE_INFINITY], RangeError],
    [deep, deep, RangeError],
    [[1, 2], [1], RangeError],
  ];
  for (const [a, b, kind] of bad) assert.throws(() => weightsDelta(a as WeightsArray, b as WeightsArray), kind, JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))?.slice(0, 40));
});

test("weightsDelta feeds weightsEdit", async () => {
  assert.equal(weightsEdit({ tensor: "w", baseSha256: A, editedSha256: B, ...weightsDelta([[0, 1]], [[0.5, 1]]) }), true);
  assert.deepEqual(one(byKind(await posted(), "notification")).payload, { kind: "weights.edit", tensor: "w", shape: [1, 2], changed: 1, l2: 0.5, maxAbs: 0.5, baseSha256: A, editedSha256: B });
});

// ---------------------------------------------------------------- parity with the Python SDK

type Run = (edit: () => void, sessionId: string | null) => void;

// One entry per scenario in the fixture; test_weights.py has the same list. The functions return
// nothing, so no span records an output the Python `with` block would not have.
const SCENARIOS: Record<string, Run> = {
  alone: (edit) => edit(),
  withSession: (edit, sid) => withSession(sid!, edit),
  trace: (edit) => trace("run", edit),
  traceWithSessionId: (edit, sid) => trace("run", edit, { sessionId: sid! }),
  toolSpan: (edit) => trace("run", () => span("tool", "patch", edit)),
  stepSpan: (edit) => trace("run", () => span("step", "patch", edit)),
};

test("every scenario in the fixture runs here", () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), Object.keys(fx.scenarios).sort());
});

for (const [name, sc] of Object.entries(fx.scenarios)) {
  test(`the same events as the Python SDK: ${name}`, async () => {
    let queued = false;
    SCENARIOS[name]!(() => void (queued = weightsEdit(fx.edit)), sc.sessionId);
    assert.equal(queued, true);
    const events = await posted();
    const got = events.map((e) => ({
      kind: e.kind,
      keys: Object.keys(e).filter((k) => !fx.ignoredEventKeys.includes(k)).sort(),
      payload: Object.fromEntries(Object.entries(e.payload).map(([k, v]) => [k, fx.volatilePayloadKeys.includes(k) ? "<volatile>" : v])),
    }));
    assert.deepEqual(got, sc.events.map((e) => (e.kind === "notification" ? { ...e, payload: fx.payload } : e)));

    // One trace, one session, and the edit hangs off the event the fixture names.
    const first = events[0]!;
    const note = one(byKind(events, "notification"));
    assert.deepEqual([...new Set(events.map((e) => e.traceId))], [first.traceId]);
    assert.deepEqual([...new Set(events.map((e) => e.sessionId))], [sc.sessionId ?? first.sessionId]);
    if (sc.parent === null) assert.equal(note.spanId, first.spanId);
    else {
      const parent = one(byKind(events, sc.parent));
      assert.equal(note.parentId, parent.id);
      assert.equal(note.parentSpanId, parent.spanId);
      assert.notEqual(note.spanId, parent.spanId);
    }
    if (note.turnId !== undefined) assert.equal(note.turnId, note.traceId);
  });
}

test("the same delta as the Python SDK", () => {
  assert.deepEqual(weightsDelta(fx.delta.base, fx.delta.edited), fx.delta.result);
});

// ---------------------------------------------------------------- a real server

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
// The same condition as WeightsEditServerTest in test_weights.py.
const serveOk = existsSync(CLI) && (major > 22 || (major === 22 && minor >= 15));

test("round trip through a real coding.sh serve: the event comes back with the secret redacted", { skip: serveOk ? false : "needs node >= 22.15 and the core package" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "csh-sdk-weights-"));
  const ingest = "csh_ik_" + "w".repeat(43);
  const read = "csh_rk_" + "r".repeat(43);
  // Nothing the server reads or writes is the user's: every home it knows is under root.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    CODING_SH_HOME: join(root, "coding.sh"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    CURSOR_CONFIG_DIR: join(root, "cursor"),
    OPENCODE_CONFIG_DIR: join(root, "opencode"),
    OPENCODE_DB: join(root, "opencode.db"),
    CODING_SH_NO_AUTO_INGEST: "1",
    CODING_SH_INGEST_KEYS: `demo:${ingest}`,
    CODING_SH_READ_KEYS: `demo:${read}`,
    NODE_NO_WARNINGS: "1",
  };
  delete env.CODING_SH_DEV_REAL_STORE;
  const proc = spawn(process.execPath, ["--no-warnings", CLI, "serve", "--port", "0"], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(proc, "exit");
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += String(c)));
  try {
    const lines = createInterface({ input: proc.stdout });
    const url = await Promise.race([
      once(lines, "line").then(([l]) => String(l).trim()),
      exited.then(() => ""),
      new Promise<string>((r) => setTimeout(() => r(""), 30_000).unref()),
    ]);
    assert.match(url, /^http:\/\//, `serve did not start: ${stderr || url}`);
    _reset();
    init({ url, key: ingest, service: "weights-test", flushIntervalMs: 5 });
    assert.equal(weightsEdit({ tensor: `blocks.0.${FAKE_TOKEN}`, shape: [2, 3], changed: 2, l2: 0.5, maxAbs: 0.4, baseSha256: A, editedSha256: B, note: `deploy with ${FAKE_TOKEN}` }), true);
    assert.equal(await flush(5000), true);
    assert.equal(stats().failed, 0);

    let items: { kind: string; payload: Record<string, unknown> }[] = [];
    const until = Date.now() + 10_000;
    for (;;) {
      const res = await fetch(`${url}/api/events?limit=50`, { headers: { authorization: `Bearer ${read}` } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items?: typeof items } | typeof items;
      items = Array.isArray(body) ? body : (body.items ?? []);
      if (items.some((i) => i.kind === "notification") || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const e = one(items.filter((i) => i.kind === "notification"));
    const p = e.payload;
    assert.equal(p.kind, "weights.edit");
    assert.deepEqual([p.shape, p.changed, p.l2, p.maxAbs], [[2, 3], 2, 0.5, 0.4]);
    assert.deepEqual([p.baseSha256, p.editedSha256], [A, B]);
    assert.ok(!JSON.stringify(e).includes(FAKE_TOKEN));
    assert.equal(p.tensor, "blocks.0.[redacted:github-token]");
    assert.equal(p.note, "deploy with [redacted:github-token]");
  } finally {
    await shutdown(1000);
    proc.kill();
    // The store's files are open until the server exits; remove them only after it has.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000).unref())]);
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGKILL");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
