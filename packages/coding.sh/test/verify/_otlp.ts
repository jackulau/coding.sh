// Shared by the OTLP receiver checks in this folder (otlp-*.test.ts). A case is one request (a route, a
// method, headers and a body) and the answers it allows. Each is posted in-process, as a "request" event on
// the server of a receiver (src/otel/receiver.ts startReceiver) over a store of its own, with a response
// that records what the receiver sends. Each case is checked against the receiver's contract:
//
// - The answer is one the case allows. A body changed from a fixture gets 200 when the decoders read it and
//   400 when they refuse it. The header and route cases get the answer their headers call for. No case
//   gets a 5xx or a destroyed response.
// - onError is never called: no throw reaches the receiver's catch-all, its store or onBatch.
// - A request answered 4xx leaves the store empty.
// - Every stored event passes ingest's check (core/ingest.ts validEvent), and its ts is in the Date range
//   (at most 8.64e15 ms either side of 0). Events and session rows hold only values JSON keeps as they
//   are: finite numbers, no BigInt, function or symbol, nothing nested past 200 deep. A session's startedAt
//   and endedAt are in the Date range. Events and sessions serialize to JSON.
// - On a SQLite store, the reads the CLI and the viewer make resolve, and what they give serializes to
//   JSON: listSessions, getSession, listEvents for each session (and each session with no row),
//   metricRows, mcpCalls, memoryEvents and search. The checks above apply to the events and sessions read
//   back.
//
// A case answered 4xx that called no store method hands its receiver on to the next case. The receiver
// refuses such a request before it hands it on (submit), so it keeps nothing of it. Every other case gets
// the next one a new receiver and store.
//
// The bodies come from the OTLP/JSON fixtures FIXTURES names and their protobuf encodings
// (test/otel/_encode.ts). A node's position is its path with array indexes left out, with an attribute
// named by its key. The 3,670 nodes of the fixtures sit at 1,602 positions.
//
// Each test file reads its bound, CODING_SH_MODEL_BOUND (0 when unset), and passes it to the cases it
// makes. At a bound n of 1 or more, the cases change the first n nodes at each position and the file posts
// every case. At 0 they change the first node at each position, and the file posts every 13th case from
// the first (SAMPLE, sampled) and each case its FIXED list names: the first case that showed each problem
// these checks have found.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import type { TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { validEvent } from "../../src/core/ingest.ts";
import { createRedactor } from "../../src/core/redact.ts";
import type { IndexStore } from "../../src/core/types.ts";
import { ProtoWriter } from "../../src/otel/proto.ts";
import { startReceiver, type Receiver } from "../../src/otel/receiver.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { encodeLogs, encodeTraces } from "../otel/_encode.ts";
import { MemBlobs, MemIndex } from "../otel/_memstore.ts";
import { gen, type Gen } from "../_prop.ts";
import { Problems } from "./_events.ts";

const ROOT = new URL("../../", import.meta.url);

/** One request and the answers it may get. */
export interface Case {
  /** Names the case in a problem: the fixture and what changed. */
  name: string;
  route: string;
  method?: string;
  headers: Record<string, string>;
  /** Read once, as the case is posted; a case jsonCase makes builds it then. */
  body: Buffer;
  allow: readonly number[];
}

/** The response the receiver's server is handed: it keeps the status and the body. */
class Answer extends EventEmitter {
  statusCode = 0;
  headersSent = false;
  shouldKeepAlive = true;
  destroyed = false;
  body = Buffer.alloc(0);
  readonly done: Promise<void>;
  private finish!: () => void;
  constructor() {
    super();
    this.done = new Promise((resolve) => (this.finish = resolve));
  }
  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  end(body?: Uint8Array | string): void {
    this.body = Buffer.from(body ?? []);
    this.finish();
    this.emit("close");
  }
  destroy(): void {
    this.destroyed = true;
    this.finish();
    this.emit("close");
  }
}

const ANSWER_MS = 60_000;

async function post(rx: Receiver, c: Case): Promise<Answer> {
  const req = Object.assign(Readable.from([c.body]), { headers: { host: "127.0.0.1", ...c.headers }, url: c.route, method: c.method ?? "POST" });
  const res = new Answer();
  rx.server.emit("request", req, res);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${ANSWER_MS / 1000} s to ${c.name}`)), ANSWER_MS)));
  try {
    await Promise.race([res.done, late]);
  } finally {
    clearTimeout(timer);
  }
  return res;
}

export type StoreKind = "mem" | "sqlite";

interface Rig {
  store: MemIndex | SqliteIndexStore;
  rx: Receiver;
  /** Store methods called so far. */
  calls: number;
  errors: string[];
}

// The redactor holds its rules and nothing of what it redacted, so one serves every receiver.
const redactor = createRedactor();

async function openRig(kind: StoreKind): Promise<Rig> {
  const store = kind === "mem" ? new MemIndex() : await SqliteIndexStore.open(":memory:");
  const rig = { store, calls: 0, errors: [] as string[] } as Rig;
  const counted = new Proxy(store, {
    get(target, key) {
      const v: unknown = Reflect.get(target, key, target);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        rig.calls++;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as IndexStore;
  rig.rx = await startReceiver({ port: 0, store: counted, blobs: new MemBlobs(), redactor, onError: (e) => rig.errors.push(`${e.name}: ${e.message}`) });
  return rig;
}

/** A problem's kind: hex ids and numbers made alike, so one cause counts once. */
const kindOf = (s: string): string => s.replace(/\b[0-9a-f]{16,}\b/g, "<id>").replace(/\d+/g, "N").slice(0, 200);

export const MAX_DATE_MS = 8.64e15;

/** Values in `v` JSON does not keep as they are: a number that is not finite, a BigInt, a function or a symbol, or nesting past 200. */
function oddValues(v: unknown, path: string, out: string[], depth = 0): void {
  if (out.length >= 3) return;
  if (depth > 200) out.push(`${path} is nested past 200`);
  else if (typeof v === "number") {
    if (!Number.isFinite(v)) out.push(`${path} is ${v}`);
  } else if (typeof v === "bigint" || typeof v === "function" || typeof v === "symbol") out.push(`${path} is a ${typeof v}`);
  else if (Array.isArray(v)) v.forEach((x, i) => oddValues(x, `${path}[${i}]`, out, depth + 1));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) oddValues(x, `${path}.${k}`, out, depth + 1);
}

function serializes(v: unknown, what: string, out: string[]): void {
  try {
    JSON.stringify(v);
  } catch (err) {
    out.push(`${what} does not serialize: ${(err as Error).message}`);
  }
}

/** What is wrong with stored events and session rows. */
export function rowProblems(events: readonly AgentEvent[], sessions: readonly Session[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const problem = validEvent(e);
    if (problem) out.push(`an event ingest drops: ${problem}`);
    if (typeof e.ts === "number" && Math.abs(e.ts) > MAX_DATE_MS) out.push(`a ${e.kind} event's ts is out of the Date range`);
    const odd: string[] = [];
    oddValues(e, `event ${e.kind}`, odd);
    out.push(...odd);
    serializes(e, `a ${e.kind} event`, out);
  }
  for (const s of sessions) {
    for (const k of ["startedAt", "endedAt"] as const) {
      const t = s[k];
      if (typeof t === "number" && Math.abs(t) > MAX_DATE_MS) out.push(`a session's ${k} is out of the Date range`);
    }
    const odd: string[] = [];
    oddValues(s, "session", odd);
    out.push(...odd);
    serializes(s, "a session", out);
  }
  return out;
}

/** The SQLite store's reads, each of which must resolve to something that serializes; gives the events and sessions read. */
async function readBack(store: SqliteIndexStore, out: string[]): Promise<{ events: AgentEvent[]; sessions: Session[] }> {
  const read = async <T>(what: string, f: () => Promise<T>): Promise<T | undefined> => {
    try {
      const v = await f();
      JSON.stringify(v);
      return v;
    } catch (err) {
      out.push(`${what} failed: ${(err as Error).message}`);
      return undefined;
    }
  };
  const sessions = (await read("listSessions", () => store.listSessions({}))) ?? [];
  const orphans = (await read("sessionsWithoutRow", () => store.sessionsWithoutRow())) ?? [];
  const ids = [...new Set([...sessions.map((s) => s.id), ...orphans.map((o) => o.sessionId)])];
  const events: AgentEvent[] = [];
  for (const id of ids) events.push(...((await read("listEvents", () => store.listEvents(id))) ?? []));
  for (const s of sessions) await read("getSession", () => store.getSession(s.id));
  await read("metricRows", () => store.metricRows({}));
  await read("mcpCalls", () => store.mcpCalls({}));
  await read("memoryEvents", () => store.memoryEvents(ids));
  await read("search", () => store.search("the"));
  return { events, sessions };
}

export interface RunStats {
  cases: number;
  /** Cases by answer ("destroyed" for a destroyed response). */
  answers: Record<string, number>;
  receivers: number;
}

/**
 * Posts each case and records in `problems` each way it breaks the contract (the file's header lists it).
 * The cases are made as they are posted, so a generator of thousands holds one body at a time.
 */
export async function runCases(cases: Iterable<Case>, problems: Problems, kind: StoreKind = "mem"): Promise<RunStats> {
  const stats: RunStats = { cases: 0, answers: {}, receivers: 0 };
  let rig: Rig | undefined;
  try {
    for (const c of cases) {
      if (!rig) {
        rig = await openRig(kind);
        stats.receivers++;
      }
      const calls = rig.calls;
      const errors = rig.errors.length;
      const res = await post(rig.rx, c);
      stats.cases++;
      const answer = res.destroyed ? "destroyed" : String(res.statusCode);
      stats.answers[answer] = (stats.answers[answer] ?? 0) + 1;
      if (res.destroyed) problems.add("the response was destroyed", c.name);
      else if (!c.allow.includes(res.statusCode)) problems.add(kindOf(`answered ${res.statusCode}: ${res.body.toString("utf8").slice(0, 160)}`), c.name);
      const refused = !res.destroyed && res.statusCode >= 400 && res.statusCode < 500;
      if (refused && rig.calls === calls && rig.errors.length === errors) continue;
      // The receiver finishes its writes as it closes; the store is read after that.
      const done = rig;
      rig = undefined;
      try {
        await done.rx.close();
        for (const e of done.errors.slice(errors)) problems.add(kindOf(`onError: ${e}`), c.name);
        const out: string[] = [];
        const rows = done.store instanceof MemIndex ? { events: [...done.store.events.values()].map((r) => r.event), sessions: [...done.store.sessions.values()] } : await readBack(done.store, out);
        if (refused && (rows.events.length || rows.sessions.length)) out.push(`a request answered ${res.statusCode} left rows in the store`);
        out.push(...rowProblems(rows.events, rows.sessions));
        for (const p of out) problems.add(kindOf(p), c.name);
      } finally {
        await done.store.close();
      }
    }
  } finally {
    if (rig) {
      await rig.rx.close();
      await rig.store.close();
    }
  }
  return stats;
}

/** Answers and their counts, for a test's diagnostic. */
export const answerList = (answers: Record<string, number>): string =>
  Object.entries(answers)
    .map(([a, n]) => `${a} x${n}`)
    .join(", ");

/** One line for a test's diagnostic. */
export const summary = (s: RunStats): string => `${s.cases} requests to ${s.receivers} receivers; answers ${answerList(s.answers)}`;

/** Posts each case; fails with each problem found, by kind, with the first case that showed it. */
export async function checkCases(t: TestContext, cases: Iterable<Case>, kind: StoreKind = "mem"): Promise<void> {
  const problems = new Problems();
  const stats = await runCases(cases, problems, kind);
  t.diagnostic(summary(stats));
  assert.deepEqual(problems.list(), []);
}

/** Posts one case and fails with each problem it shows; adds its answer to `answers`. A seeded check runs it for each value. */
export async function checkOne(c: Case, kind: StoreKind, answers: Record<string, number>): Promise<void> {
  const problems = new Problems();
  const stats = await runCases([c], problems, kind);
  for (const [a, n] of Object.entries(stats.answers)) answers[a] = (answers[a] ?? 0) + n;
  assert.deepEqual(problems.list(), []);
}

/** At bound 0 a check posts every SAMPLE-th of its cases, from the first. */
export const SAMPLE = 13;

/**
 * The cases a check posts at `bound`: every one at 1 or more. At 0, every SAMPLE-th from the first, and
 * each case `fixed` names; it throws when a name in `fixed` matches no case, so a renamed case is noticed.
 */
export function* sampled(cases: Iterable<Case>, bound: number, fixed: readonly string[] = []): Generator<Case> {
  if (bound >= 1) {
    yield* cases;
    return;
  }
  const left = new Set(fixed);
  let i = 0;
  for (const c of cases) {
    if (left.delete(c.name) || i % SAMPLE === 0) yield c;
    i++;
  }
  if (left.size) throw new Error(`no case is named ${[...left].map((n) => JSON.stringify(n)).join(", ")}`);
}

/** The names in `fixed` of cases made from the fixture `name`. */
export const fixedFor = (fixed: readonly string[], name: string): string[] => fixed.filter((n) => n.startsWith(`${name} `));

// ---------------------------------------------------------------- fixtures and positions

/** The OTLP/JSON fixtures, under test/fixtures. */
export const FIXTURES = [
  "otel/claude-code-agents-logs.json",
  "otel/claude-code-logs.json",
  "otel/claude-code-traces.json",
  "otel/codex-agents-logs.json",
  "otel/devin-logs.json",
  "otel/genai-semconv-agents.json",
  "otel/genai-semconv.json",
  "otel/openinference.json",
  "otel/vercel-ai.json",
  "otel/agent-runs/turn.json",
  "adapters/copilot-cli/otel/otlp/000-traces.json",
  "adapters/copilot-cli/otel/otlp/001-traces.json",
] as const;

export interface Fixture {
  name: string;
  text: string;
  doc: unknown;
  /** The same request as protobuf. */
  pb: Buffer;
  route: string;
}

export function loadFixture(name: string): Fixture {
  const text = readFileSync(new URL(`test/fixtures/${name}`, ROOT), "utf8");
  const doc = JSON.parse(text) as Record<string, unknown>;
  const logs = "resourceLogs" in doc;
  return { name, text, doc, pb: Buffer.from(logs ? encodeLogs(doc) : encodeTraces(doc)), route: logs ? "/v1/logs" : "/v1/traces" };
}

export type Path = (string | number)[];

export interface Node {
  path: Path;
  value: unknown;
  position: string;
}

function* nodes(v: unknown, path: Path = [], position = ""): Generator<Node> {
  yield { path, value: v, position };
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const x: unknown = v[i];
      const key = x && typeof x === "object" && typeof (x as { key?: unknown }).key === "string" ? (x as { key: string }).key : "";
      yield* nodes(x, [...path, i], `${position}[${key}]`);
    }
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) yield* nodes(x, [...path, k], `${position}.${k}`);
  }
}

/** Every node of `doc`, in document order. */
export const allNodes = (doc: unknown): Node[] => [...nodes(doc)];

/** The first `bound` nodes at each position of `doc` (the first one at bound 0), in document order. */
export function positions(doc: unknown, bound: number): Node[] {
  const keep = Math.max(1, bound);
  const seen = new Map<string, number>();
  const out: Node[] = [];
  for (const n of nodes(doc)) {
    const k = seen.get(n.position) ?? 0;
    if (k >= keep) continue;
    seen.set(n.position, k + 1);
    out.push(n);
  }
  return out;
}

export function setAt(doc: unknown, path: Path, value: unknown): unknown {
  if (!path.length) return value;
  const out = structuredClone(doc) as Record<string | number, unknown>;
  let o = out;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  o[path.at(-1)!] = value;
  return out;
}

export function deleteAt(doc: unknown, path: Path): unknown {
  const out = structuredClone(doc) as Record<string | number, unknown>;
  let o = out;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  const k = path.at(-1)!;
  if (Array.isArray(o)) o.splice(k as number, 1);
  else delete o[k];
  return out;
}

/** Stands for the number 1e400 in a document: JSON.parse reads it as Infinity, and no JS value writes it. */
export const PAST_DOUBLE = "\u0000 1e400";
const PAST_DOUBLE_JSON = JSON.stringify(PAST_DOUBLE);

/** A document's JSON text, with 1e400 where PAST_DOUBLE is. */
export const jsonText = (doc: unknown): string => JSON.stringify(doc).replaceAll(PAST_DOUBLE_JSON, "1e400");

const show = (v: unknown): string => jsonText(v).slice(0, 60);

const JSON_TYPE = { "content-type": "application/json" };
const PROTO_TYPE = { "content-type": "application/x-protobuf" };

/** A JSON request made from `f`, with the body `doc` gives. It calls `doc` when the body is read, so a case a sample leaves out costs only its name. */
export const jsonCase = (f: Fixture, name: string, doc: () => unknown): Case => ({
  name: `${f.name} ${name}`,
  route: f.route,
  headers: JSON_TYPE,
  allow: [200, 400],
  get body() {
    return Buffer.from(jsonText(doc()));
  },
});

// ---------------------------------------------------------------- JSON cases

/** In place of a node: each JSON type, a number past what a double holds, past 2^64 (as protojson writes a 64-bit integer, a string) and a negative one. */
export const VALUES: readonly unknown[] = [null, true, "", "x", [], {}, -1, 1e300, "99999999999999999999999", PAST_DOUBLE];

/** Each of VALUES in place of each node `positions` gives at `bound`, and that node left out. */
export function* valueCases(f: Fixture, bound: number): Generator<Case> {
  for (const n of positions(f.doc, bound)) {
    const at = JSON.stringify(n.path);
    for (const v of VALUES) if (!isDeepStrictEqual(v, n.value)) yield jsonCase(f, `${at} = ${show(v)}`, () => setAt(f.doc, n.path, v));
    if (n.path.length) yield jsonCase(f, `${at} left out`, () => deleteAt(f.doc, n.path));
  }
}

/** In place of an attribute value (an OTLP AnyValue). */
export const ANY_VALUES: readonly unknown[] = [
  { stringValue: "" },
  { stringValue: "{}" },
  { stringValue: "[]" },
  { stringValue: '[{"role":"assistant","content":[{"type":"text","text":5}]}]' },
  { intValue: "9007199254740993" },
  { intValue: "-1" },
  { intValue: 1e300 },
  { doubleValue: "NaN" },
  { doubleValue: "-Infinity" },
  { doubleValue: PAST_DOUBLE },
  { doubleValue: -1 },
  { boolValue: true },
  { arrayValue: { values: [{ stringValue: "a" }] } },
  { kvlistValue: { values: [{ key: "a", value: { stringValue: "b" } }] } },
  { bytesValue: "AAEC" },
  {},
];

const isAnyValue = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((k) => k.endsWith("Value"));

/** Each of ANY_VALUES in place of each attribute value `positions` gives at `bound`. */
export function* anyCases(f: Fixture, bound: number): Generator<Case> {
  for (const n of positions(f.doc, bound)) {
    if (!isAnyValue(n.value)) continue;
    for (const a of ANY_VALUES) yield jsonCase(f, `${JSON.stringify(n.path)} = ${show(a)}`, () => setAt(f.doc, n.path, a));
  }
}

const INNER_VALUES: readonly unknown[] = [null, true, 5, "", "x", [], {}, { toString: 1 }];

/** For each string `positions` gives at `bound` that holds a JSON object or array: each of INNER_VALUES in place of each node of that document. */
export function* innerCases(f: Fixture, bound: number): Generator<Case> {
  for (const n of positions(f.doc, bound)) {
    if (typeof n.value !== "string" || !/^\s*[[{]/.test(n.value)) continue;
    let inner: unknown;
    try {
      inner = JSON.parse(n.value);
    } catch {
      continue;
    }
    for (const m of allNodes(inner)) {
      for (const v of INNER_VALUES) {
        if (isDeepStrictEqual(v, m.value)) continue;
        yield jsonCase(f, `${JSON.stringify(n.path)} holding ${JSON.stringify(m.path)} = ${show(v)}`, () => setAt(f.doc, n.path, JSON.stringify(setAt(inner, m.path, v))));
      }
    }
  }
}

/** Keys of Object.prototype and others a reader may look up on an object it built from attributes. */
export const PROTO_KEYS = ["toString", "valueOf", "__proto__", "constructor", "hasOwnProperty", "toJSON", "then"] as const;
const POISON = { kvlistValue: { values: PROTO_KEYS.map((key) => ({ key, value: { intValue: 1 } })) } };
const KEY_VALUES: readonly unknown[] = [{ stringValue: "x" }, { intValue: 1 }, POISON, { arrayValue: { values: [POISON] } }];

/**
 * For each attribute list `positions` gives at `bound` (attributes, or a kvlistValue's values): an attribute
 * named by each of PROTO_KEYS with each of KEY_VALUES added, and each attribute's value made a kvlist of
 * those keys.
 */
export function* keyCases(f: Fixture, bound: number): Generator<Case> {
  for (const n of positions(f.doc, bound)) {
    const last = n.path.at(-1);
    if (!Array.isArray(n.value) || !(last === "attributes" || (last === "values" && n.path.at(-2) === "kvlistValue"))) continue;
    const list = n.value as unknown[];
    const at = JSON.stringify(n.path);
    for (const key of PROTO_KEYS) for (const value of KEY_VALUES) yield jsonCase(f, `${at} + ${key} = ${show(value)}`, () => setAt(f.doc, n.path, [...list, { key, value }]));
    for (let i = 0; i < list.length; i++) {
      if (!list[i] || typeof list[i] !== "object") continue;
      for (const value of KEY_VALUES.slice(2)) yield jsonCase(f, `${JSON.stringify([...n.path, i, "value"])} = ${show(value)}`, () => setAt(f.doc, [...n.path, i, "value"], value));
    }
  }
}

// ---------------------------------------------------------------- protobuf cases

/** The encoding cut to each length short of its own. */
export function* prefixCases(f: Fixture): Generator<Case> {
  for (let k = 0; k < f.pb.length; k++) yield { name: `${f.name} as protobuf cut to ${k} bytes`, route: f.route, headers: PROTO_TYPE, body: f.pb.subarray(0, k), allow: [200, 400] };
}

/** Each byte of the encoding set to 0x00 and 0xff, and with its low and its high bit flipped. */
export function* byteCases(f: Fixture): Generator<Case> {
  for (let i = 0; i < f.pb.length; i++) {
    const b = f.pb[i]!;
    for (const m of new Set([0x00, 0xff, b ^ 0x01, b ^ 0x80])) {
      if (m === b) continue;
      const body = Buffer.from(f.pb);
      body[i] = m;
      yield { name: `${f.name} as protobuf with byte ${i} set to 0x${m.toString(16)}`, route: f.route, headers: PROTO_TYPE, body, allow: [200, 400] };
    }
  }
}

// ---------------------------------------------------------------- header and route cases

const ROUTES = ["/v1/traces", "/v1/logs", "/v1/metrics", "/api/public/otel/v1/traces"];

/** The fixture with each content type and encoding, sent to each route, with each Host, Origin and method. */
export function* headerCases(f: Fixture): Generator<Case> {
  const J = "application/json";
  const P = "application/x-protobuf";
  const body = Buffer.from(f.text);
  const pb = f.pb;
  const list: [string, Partial<Case> & { headers: Record<string, string>; body: Buffer }, number[]][] = [
    ["with a charset", { headers: { "content-type": `${J}; charset=utf-8` }, body }, [200]],
    ["as application/protobuf", { headers: { "content-type": "application/protobuf" }, body: pb }, [200]],
    ["as text/plain", { headers: { "content-type": "text/plain" }, body }, [415]],
    ["with no content type", { headers: {}, body }, [415]],
    ["gzipped", { headers: { "content-type": J, "content-encoding": "gzip" }, body: gzipSync(body) }, [200]],
    ["as deflated protobuf", { headers: { "content-type": P, "content-encoding": "deflate" }, body: deflateSync(pb) }, [200]],
    ["as brotli", { headers: { "content-type": J, "content-encoding": "br" }, body: brotliCompressSync(body) }, [200]],
    ["said to be gzipped and not", { headers: { "content-type": J, "content-encoding": "gzip" }, body }, [400]],
    ["said to be brotli and not", { headers: { "content-type": J, "content-encoding": "br" }, body }, [400]],
    ["with content-encoding compress", { headers: { "content-type": J, "content-encoding": "compress" }, body }, [415]],
    ["gzipped and cut to 40 bytes", { headers: { "content-type": J, "content-encoding": "gzip" }, body: gzipSync(body).subarray(0, 40) }, [400]],
    ["as JSON said to be protobuf", { headers: { "content-type": P }, body }, [200, 400]],
    ["as protobuf said to be JSON", { headers: { "content-type": J }, body: pb }, [400]],
    ["from Host evil.example", { headers: { "content-type": J, host: "evil.example" }, body }, [403]],
    ["from Host localhost:4318", { headers: { "content-type": J, host: "localhost:4318" }, body }, [200]],
    ["from Host [::1]:4318", { headers: { "content-type": J, host: "[::1]:4318" }, body }, [200]],
    ["from Origin https://evil.example", { headers: { "content-type": J, origin: "https://evil.example" }, body }, [403]],
    ["from Origin http://localhost:5173", { headers: { "content-type": J, origin: "http://localhost:5173" }, body }, [200]],
    ["with GET", { method: "GET", headers: { "content-type": J }, body }, [405]],
    ["with PUT", { method: "PUT", headers: { "content-type": J }, body }, [405]],
    ["with OPTIONS", { method: "OPTIONS", headers: { "content-type": J }, body }, [204]],
    ["to its route with a query", { route: `${f.route}?a=1`, headers: { "content-type": J }, body }, [200]],
    ["to its route with a trailing slash", { route: `${f.route}/`, headers: { "content-type": J }, body }, [404]],
    ["to /v2/traces", { route: "/v2/traces", headers: { "content-type": J }, body }, [404]],
  ];
  for (const [what, c, allow] of list) yield { name: `${f.name} ${what}`, route: f.route, ...c, allow };
  for (const r of ROUTES) {
    if (r === f.route) continue;
    yield { name: `${f.name} to ${r}`, route: r, headers: { "content-type": J }, body, allow: [200] };
    yield { name: `${f.name} as protobuf to ${r}`, route: r, headers: { "content-type": P }, body: pb, allow: [200, 400] };
  }
}

/** Each case sent to /v1/metrics instead, which checks a body and keeps nothing of it. */
export function* toMetrics(cases: Iterable<Case>): Generator<Case> {
  for (const c of cases) yield { ...c, name: `${c.name}, to /v1/metrics`, route: "/v1/metrics" };
}

/** Each of VALUES as a metrics body, as its resourceMetrics, and as the first of them. */
export function* metricsCases(): Generator<Case> {
  for (const v of VALUES) {
    for (const doc of [v, { resourceMetrics: v }, { resourceMetrics: [v] }]) {
      yield { name: `the metrics body ${show(doc)}`, route: "/v1/metrics", headers: JSON_TYPE, body: Buffer.from(jsonText(doc)), allow: [200, 400] };
    }
  }
}

/** Bodies past the 16 MiB limit, as sent and once inflated. */
export function* limitCases(): Generator<Case> {
  const big = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
  yield { name: "a body of 16 MiB and a byte", route: "/v1/traces", headers: JSON_TYPE, body: big, allow: [413] };
  yield { name: "a gzipped body that inflates to 16 MiB and a byte", route: "/v1/traces", headers: { ...JSON_TYPE, "content-encoding": "gzip" }, body: gzipSync(big), allow: [413] };
}

// ---------------------------------------------------------------- deep and timed cases

const span = (attrs: unknown[], start = "1700000000000000000"): { resourceSpans: unknown[] } => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "deep" } }] },
      scopeSpans: [{ scope: { name: "s" }, spans: [{ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", parentSpanId: "00f067aa0ba902b7", name: "chat m", kind: 3, startTimeUnixNano: start, endTimeUnixNano: "1700000001000000000", attributes: attrs }] }],
    },
  ],
});

/** Attributes whose string value a mapper parses as JSON. */
export const JSON_KEYS = ["gen_ai.output.messages", "gen_ai.input.messages", "gen_ai.completion", "gen_ai.prompt", "output.value", "input.value", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "ai.response.object", "llm.input_messages.0.message.content"];

const nest = (n: number, open: string, close: string, mid: string): string => open.repeat(n) + mid + close.repeat(n);

/** A chat span with each of JSON_KEYS holding a document nested `depth` deep, in five shapes. */
export function* deepCases(depths: readonly number[]): Generator<Case> {
  const shapes = [['{"kwargs":', "}", "1"], ['{"message":', "}", "1"], ["[", "]", "1"], ['{"a":', "}", "1"], ['{"content":', "}", '"t"']] as const;
  for (const depth of depths) {
    for (const [open, close, mid] of shapes) {
      for (const key of JSON_KEYS) {
        const attrs = [{ key: "gen_ai.operation.name", value: { stringValue: "chat" } }, { key, value: { stringValue: nest(depth, open, close, mid) } }];
        yield { name: `a span whose ${key} holds ${open} nested ${depth} deep`, route: "/v1/traces", headers: JSON_TYPE, body: Buffer.from(JSON.stringify(span(attrs))), allow: [200, 400] };
      }
    }
  }
}

/** A length as protobuf writes it, by the writer the encoder uses. */
const varint = (n: number): number[] => Array.from(new ProtoWriter().varint(n).finish());

/**
 * The AnyValue `{ stringValue: "x" }` inside `depth` arrayValues, or kvlistValues with the key "a", as protobuf:
 * each level's length is worked out from the inside, then the bytes are written from the outside in, so no call
 * recurses and none copies a level into the one above it.
 */
function nestedProto(kind: "arrayValue" | "kvlistValue", depth: number): Uint8Array {
  // Field numbers from the .proto, each length-delimited (wire type 2): AnyValue string_value 1, array_value 5,
  // kvlist_value 6; ArrayValue and KeyValueList values 1; KeyValue key 1, value 2.
  const leaf = [0x0a, 0x01, 0x78];
  const heads: number[][] = [];
  let size = leaf.length;
  for (let i = 0; i < depth; i++) {
    let head: number[];
    if (kind === "arrayValue") {
      const list = 1 + varint(size).length + size;
      head = [0x2a, ...varint(list), 0x0a, ...varint(size)];
    } else {
      const kv = 3 + 1 + varint(size).length + size;
      const list = 1 + varint(kv).length + kv;
      head = [0x32, ...varint(list), 0x0a, ...varint(kv), 0x0a, 0x01, 0x61, 0x12, ...varint(size)];
    }
    heads.push(head);
    size += head.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (let i = heads.length - 1; i >= 0; i--) {
    out.set(heads[i]!, at);
    at += heads[i]!.length;
  }
  out.set(leaf, at);
  return out;
}

/**
 * A chat span with an attribute whose value is an arrayValue, or a kvlistValue, nested `depth` deep, as JSON
 * and as protobuf. Both decoders refuse nesting past 32 (src/otel/json.ts, src/otel/proto.ts).
 */
export function* nestedCases(depths: readonly number[]): Generator<Case> {
  const kinds = [
    ["arrayValue", '{"arrayValue":{"values":[', "]}}", (v: unknown) => ({ arrayValue: { values: [v] } })],
    ["kvlistValue", '{"kvlistValue":{"values":[{"key":"a","value":', "}]}}", (v: unknown) => ({ kvlistValue: { values: [{ key: "a", value: v }] } })],
  ] as const;
  const leaf = { stringValue: "x" };
  const marker = "\u0000 nested";
  for (const depth of depths) {
    for (const [kind, open, close, wrap] of kinds) {
      const attrs = (value: unknown) => [{ key: "gen_ai.operation.name", value: { stringValue: "chat" } }, { key: "x.nested", value }];
      // Built as text: JSON.stringify recurses, and the deepest of these would run out of stack.
      const text = JSON.stringify(span(attrs(marker))).replace(JSON.stringify(marker), nest(depth, open, close, JSON.stringify(leaf)));
      yield { name: `a span attribute that is an ${kind} nested ${depth} deep`, route: "/v1/traces", headers: JSON_TYPE, body: Buffer.from(text), allow: [200, 400] };
      // Built as bytes for the same reason: the protobuf encoder makes a few calls a level.
      const pb = encodeTraces(span(attrs(nestedProto(kind, depth))));
      if (depth <= 64) {
        let v: unknown = leaf;
        for (let i = 0; i < depth; i++) v = wrap(v);
        assert.deepEqual(pb, encodeTraces(span(attrs(v))), `an ${kind} nested ${depth} deep is the bytes the encoder writes`);
      }
      yield { name: `a span attribute that is an ${kind} nested ${depth} deep, as protobuf`, route: "/v1/traces", headers: PROTO_TYPE, body: Buffer.from(pb), allow: [200, 400] };
    }
  }
}

/** Times a fixed64 cannot hold, or that put a date out of range, as a span's start and a log's time. */
export const TIMES: readonly (string | number)[] = ["99999999999999999999999", "1e300", "-1e300", "-5", 1e300, "18446744073709551615", "8640000000000000000001"];

export function* timeCases(): Generator<Case> {
  for (const t of TIMES) {
    const s = span([{ key: "gen_ai.operation.name", value: { stringValue: "chat" } }], t as string);
    yield { name: `a span starting at ${t}`, route: "/v1/traces", headers: JSON_TYPE, body: Buffer.from(JSON.stringify(s)), allow: [200, 400] };
    for (const traced of [false, true]) {
      const rec: Record<string, unknown> = { timeUnixNano: t, body: { stringValue: "hello" }, attributes: [{ key: "event.name", value: { stringValue: "claude_code.user_prompt" } }] };
      if (traced) rec.traceId = "0af7651916cd43dd8448eb211c80319c";
      const logs = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] }, scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: [rec] }] }] };
      yield { name: `a Claude Code log at ${t}${traced ? " in a trace" : ""}`, route: "/v1/logs", headers: JSON_TYPE, body: Buffer.from(JSON.stringify(logs)), allow: [200, 400] };
    }
  }
}

// ---------------------------------------------------------------- store cases

/** In place of a number: integers past 2^53 (which SQLite gives node only as a BigInt), past 2^64, and past what a double holds. */
export const STORE_VALUES: readonly unknown[] = [1e17, -1e17, "100000000000000000", "99999999999999999999999", 1e300, PAST_DOUBLE, -1];

const numeric = (v: unknown): boolean => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v));

/** Each of STORE_VALUES in place of each number or numeric string `positions` gives at `bound`. */
export function* storeCases(f: Fixture, bound: number): Generator<Case> {
  for (const n of positions(f.doc, bound)) {
    if (!numeric(n.value)) continue;
    for (const v of STORE_VALUES) yield jsonCase(f, `${JSON.stringify(n.path)} = ${show(v)}`, () => setAt(f.doc, n.path, v));
  }
}

/** The fixtures otlp-store-1.test.ts runs storeCases over; otlp-store-2.test.ts runs the rest of FIXTURES. */
export const STORE_PART_1: readonly (typeof FIXTURES)[number][] = [
  "adapters/copilot-cli/otel/otlp/001-traces.json",
  "otel/agent-runs/turn.json",
  "otel/claude-code-traces.json",
  "otel/claude-code-logs.json",
  "otel/devin-logs.json",
];

// ---------------------------------------------------------------- seeded cases

const POOL: readonly unknown[] = [...VALUES, ...ANY_VALUES, ...STORE_VALUES];

/** A change to one node: which node (an index into the fixture's nodes, taken modulo their count), and what goes there (undefined leaves it out). */
type Edit = [number, unknown];

const edit: Gen<Edit> = gen.tuple(gen.nat(1 << 20), gen.frequency<unknown>([3, gen.pick(POOL)], [2, gen.json({ maxDepth: 2 })], [1, gen.constant(undefined)]));

/** A fixture (by index into `fixtures`) with one to four of its nodes changed. */
export const jsonEdits = (fixtures: readonly Fixture[]): Gen<[number, Edit[]]> => gen.tuple(gen.int(0, fixtures.length - 1), gen.array(edit, { minLength: 1, maxLength: 4 }));

/** The case a jsonEdits value stands for. */
export function editedCase(fixtures: readonly Fixture[], [which, edits]: [number, Edit[]]): Case {
  const f = fixtures[which]!;
  let doc = f.doc;
  const names: string[] = [];
  for (const [at, value] of edits) {
    const all = allNodes(doc);
    const n = all[at % all.length]!;
    if (value === undefined) {
      if (!n.path.length) continue;
      doc = deleteAt(doc, n.path);
      names.push(`${JSON.stringify(n.path)} left out`);
    } else {
      doc = setAt(doc, n.path, value);
      names.push(`${JSON.stringify(n.path)} = ${show(value)}`);
    }
  }
  const edited = doc;
  return jsonCase(f, names.join(", ") || "as it is", () => edited);
}

/** A fixture's encoding (by index) with one to four bytes set, then cut to a length or not. */
export const byteEdits = (fixtures: readonly Fixture[]): Gen<[number, [number, number][], number | undefined]> =>
  gen.tuple(gen.int(0, fixtures.length - 1), gen.array(gen.tuple(gen.nat(1 << 20), gen.int(0, 255)), { minLength: 1, maxLength: 4 }), gen.frequency<number | undefined>([3, gen.constant(undefined)], [1, gen.nat(1 << 20)]));

export function bytesCase(fixtures: readonly Fixture[], [which, sets, cut]: [number, [number, number][], number | undefined]): Case {
  const f = fixtures[which]!;
  const body = Buffer.from(f.pb);
  for (const [at, b] of sets) body[at % body.length] = b;
  const k = cut === undefined ? body.length : cut % (body.length + 1);
  const what = sets.map(([at, b]) => `byte ${at % body.length} set to 0x${b.toString(16)}`).join(", ");
  return { name: `${f.name} as protobuf with ${what}${k < body.length ? `, cut to ${k} bytes` : ""}`, route: f.route, headers: PROTO_TYPE, body: body.subarray(0, k), allow: [200, 400] };
}
