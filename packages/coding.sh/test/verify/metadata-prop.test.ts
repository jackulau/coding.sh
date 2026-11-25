// Metadata mode (core/redact.ts toMetadata), checked on generated events. An event has the fields
// every event has and, each now and then, the others: the ids and timings, source, agentVersion,
// model, usage, runId, cwd, project, blobs, and a repo with a head (sometimes empty), a snapshot, a
// partial flag, a branch or a main worktree. The payload holds numbers and booleans under any key;
// strings of 0 to 260 characters under keys that keep short strings (tool, status, gateway, ...) or
// keys that hold content (text, command, path, ...); lists, objects and nulls under either; often
// toolNames, a list of tool names (now and then 125 to 175 of them) with longer strings, numbers,
// nulls and objects among them, or a name or an object instead of a list; often redaction counts,
// with entries that are not a kind and a whole count among them; and on some events a weights
// checkpoint: its kind, a note, and hashes of 64 hex digits in either case (sometimes with space
// around them), or values that are not hashes.
//
// The properties: the view is what the rules keep, and nothing else. The fields every event has
// come through; the ids and timings, source, agentVersion, model, usage and runId come through when
// present; the repo comes through as its head, snapshot and partial flag, with an empty root. In
// the payload: numbers and booleans, strings of 200 characters or fewer under the keys that keep
// them, the strings of 200 characters or fewer in a toolNames list (the first 128), the redaction
// counts that name a kind with a whole count of 0 or more, and on a notification, the checkpoint's
// hashes in lower case. The view of the view is the view, and the input is left as it was. The last
// test shows the property fails on a view that keeps lists under every key, keeps the repo root,
// drops a partial flag of false, keeps toolNames past 128, or keeps the checkpoint's hashes as they
// came.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 100); CODING_SH_PROP_SEED=s replays one. The last
// test reads neither.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { toMetadata } from "../../src/core/redact.ts";
import { WEIGHTS_CHECKPOINT_KIND } from "../../src/core/weights.ts";
import type { AgentEvent, EventKind, RepoState } from "../../src/schema/index.ts";
import { forAll, gen, PropertyFailure, type ForAllOptions, type Gen } from "../_prop.ts";

const RUNS = 100;

/** A field as it goes in, and as the view must hold it: `want` is DROPPED when the view has no such field. */
const DROPPED = Symbol("dropped");
type Slot = { key: string; value: unknown; want: unknown };

const str = (min: number, max: number): Gen<string> => gen.string({ alphabet: "abcxyzABCXYZ0189 -_./:@", minLength: min, maxLength: max });
const hex = (n: number): Gen<string> => gen.string({ alphabet: "0123456789abcdef", minLength: n, maxLength: n });
/** Present (the value) or absent (undefined), one each. */
const maybe = <T>(g: Gen<T>): Gen<T | undefined> => gen.frequency<T | undefined>([1, gen.constant(undefined)], [1, g]);
const SHORT = gen.frequency([6, str(0, 30)], [1, str(190, 200)]);
const LONG = str(201, 260);
const isShortString = (n: unknown): boolean => typeof n === "string" && n.length <= 200;

/** Payload keys whose strings the view keeps (core/redact.ts METADATA_STRING_KEYS). */
const KEEP_KEYS = ["tool", "toolUseId", "status", "stopReason", "provider", "api", "gateway", "hookEvent", "entrypoint", "errorType"];
/** Payload keys that hold content. */
const CONTENT_KEYS = ["text", "command", "path", "output", "prompt", "args", "input", "result", "description", "message", "url"];
const ANY_KEY = gen.pick([...KEEP_KEYS, ...CONTENT_KEYS, "ok", "passed", "exitCode", "ttftMs"]);

/** Lists (argv, paths, mixed), objects and nulls: content in any shape but a string. */
const CONTENT: Gen<unknown> = gen.frequency<unknown>(
  [3, gen.array(str(0, 20), { maxLength: 4 })],
  [1, gen.array(gen.oneOf<unknown>(str(0, 10), gen.int(0, 9), gen.constant(null)), { maxLength: 3 })],
  [2, gen.map(gen.tuple(str(0, 20), str(0, 20)), ([command, file]) => ({ command, file }))],
  [1, gen.constant(null)],
);
const ENTRY: Gen<Slot> = gen.frequency<Slot>(
  [3, gen.map(gen.tuple(ANY_KEY, gen.oneOf<unknown>(gen.int(-1000, 1000), gen.bool)), ([key, value]) => ({ key, value, want: value }))],
  [3, gen.map(gen.tuple(gen.pick(KEEP_KEYS), SHORT), ([key, value]) => ({ key, value, want: value }))],
  [1, gen.map(gen.tuple(gen.pick(KEEP_KEYS), LONG), ([key, value]) => ({ key, value, want: DROPPED }))],
  [2, gen.map(gen.tuple(gen.pick(CONTENT_KEYS), gen.oneOf(SHORT, LONG)), ([key, value]) => ({ key, value, want: DROPPED }))],
  [3, gen.map(gen.tuple(ANY_KEY, CONTENT), ([key, value]) => ({ key, value, want: DROPPED }))],
);

/** A toolNames item and whether the view keeps it. */
type Item = [value: unknown, kept: boolean];
const NAME: Gen<Item> = gen.map(gen.pick(["Bash", "Read", "Edit", "Grep", "mcp__docs__search"]), (n) => [n, true]);
const ODD_ITEM: Gen<Item> = gen.frequency<Item>(
  [1, gen.map(str(190, 200), (n) => [n, true])],
  [1, gen.map(LONG, (n) => [n, false])],
  [1, gen.map(gen.oneOf<unknown>(gen.int(0, 9), gen.constant(null), gen.constant({ name: "Bash" })), (n) => [n, false])],
);
const toolNames = (items: Item[]): Slot => ({ key: "toolNames", value: items.map(([n]) => n), want: items.filter(([, kept]) => kept).map(([n]) => n).slice(0, 128) });
const TOOL_NAMES: Gen<Slot> = gen.frequency<Slot>(
  [5, gen.map(gen.array(gen.frequency([3, NAME], [1, ODD_ITEM]), { maxLength: 6 }), toolNames)],
  [1, gen.map(gen.array(gen.frequency([6, NAME], [1, ODD_ITEM]), { minLength: 125, maxLength: 175, avgLength: 150 }), toolNames)],
  [2, gen.map(gen.oneOf<unknown>(gen.pick(["Bash", "Read"]), gen.constant({ Bash: true })), (value) => ({ key: "toolNames", value, want: DROPPED }))],
);

/** A redaction count entry and whether the view keeps it: a kind and a whole count of 0 or more. */
type Count = [kind: string, n: unknown, kept: boolean];
const COUNT: Gen<Count> = gen.frequency<Count>(
  [4, gen.map(gen.tuple(gen.pick(["github-token", "secret-field", "email", "aws-access-key"]), gen.int(0, 5)), ([k, n]) => [k, n, true])],
  [1, gen.map(gen.tuple(gen.pick(["Bad Key", "", "UPPER", "a".repeat(65)]), gen.int(0, 5)), ([k, n]) => [k, n, false])],
  [1, gen.map(gen.tuple(gen.pick(["github-token", "email"]), gen.pick<unknown>([-1, 1.5, "2", null])), ([k, n]) => [k, n, false])],
);
const REDACTIONS: Gen<Slot> = gen.map(gen.array(COUNT, { maxLength: 3 }), (entries) => {
  const want: Record<string, unknown> = {};
  for (const [k, n, kept] of entries) {
    if (kept) want[k] = n;
    else delete want[k];
  }
  return { key: "redactions", value: Object.fromEntries(entries.map(([k, n]) => [k, n])), want };
});

/** A hash as it goes in, and as a checkpoint holds it: undefined when it is not a hash. */
type Hash = [value: string, lower: string | undefined];
const HASH: Gen<Hash> = gen.frequency<Hash>(
  [4, gen.map(gen.tuple(gen.string({ alphabet: "0123456789abcdefABCDEF", minLength: 64, maxLength: 64 }), gen.pick(["", " ", "\n"])), ([h, pad]) => [pad + h + pad, h.toLowerCase()])],
  [1, gen.map(gen.pick(["", "abc123", "g".repeat(64), "a".repeat(63)]), (s) => [s, undefined])],
);
type Checkpoint = { sha: Hash; base: Hash | undefined };
const CHECKPOINT: Gen<Checkpoint> = gen.record({ sha: HASH, base: maybe(HASH) });

/** The checkpoint's payload fields: its hashes come through, in lower case, on a notification whose sha256 is a hash. */
function checkpointSlots(kind: EventKind, c: Checkpoint): Slot[] {
  const on = kind === "notification" && c.sha[1] !== undefined;
  const slots: Slot[] = [
    { key: "kind", value: WEIGHTS_CHECKPOINT_KIND, want: WEIGHTS_CHECKPOINT_KIND },
    { key: "sha256", value: c.sha[0], want: on ? c.sha[1] : DROPPED },
    { key: "note", value: "saved after step 100", want: DROPPED },
  ];
  if (c.base) slots.push({ key: "baseSha256", value: c.base[0], want: on && c.base[1] !== undefined ? c.base[1] : DROPPED });
  return slots;
}

const KINDS: EventKind[] = ["tool.start", "tool.end", "llm.call", "notification", "user.message", "session.start", "error", "span"];
const KIND_AND_CHECKPOINT: Gen<[EventKind, Checkpoint | undefined]> = gen.frequency<[EventKind, Checkpoint | undefined]>(
  [3, gen.map(gen.pick(KINDS), (k) => [k, undefined])],
  [1, gen.tuple(gen.frequency<EventKind>([3, gen.constant("notification")], [1, gen.pick(KINDS)]), CHECKPOINT)],
);

/** The optional event fields, and whether the view keeps them. */
const OPTIONAL: [key: string, value: Gen<unknown>, kept: boolean][] = [
  ["turnId", str(1, 12), true],
  ["parentId", str(1, 12), true],
  ["durationMs", gen.int(0, 100_000), true],
  ["traceId", hex(32), true],
  ["spanId", hex(16), true],
  ["parentSpanId", hex(16), true],
  ["subagentId", str(1, 12), true],
  ["source", gen.pick(["hook", "transcript", "otel-span", "wrapper"]), true],
  ["agentVersion", gen.pick(["1.0.0", "2.3.4"]), true],
  ["model", gen.pick(["claude-opus-5-5", "gpt-5", "m"]), true],
  ["usage", gen.map(gen.tuple(gen.int(0, 5000), gen.int(0, 5000), maybe(gen.int(0, 9000))), ([inputTokens, outputTokens, cacheReadTokens]) => (cacheReadTokens === undefined ? { inputTokens, outputTokens } : { inputTokens, outputTokens, cacheReadTokens })), true],
  ["runId", str(1, 12), true],
  ["cwd", gen.pick(["/work/demo", "/home/user/project"]), false],
  ["project", gen.pick(["demo", "app"]), false],
  ["blobs", gen.array(hex(64), { minLength: 1, maxLength: 2 }), false],
];

/** A repo as it goes in, and as the view holds it: its head, snapshot and partial flag, with an empty root. */
const REPO: Gen<[RepoState, RepoState]> = gen.map(
  gen.tuple(gen.frequency([4, hex(40)], [1, gen.constant("")]), maybe(hex(40)), maybe(gen.bool), maybe(gen.constant("main")), maybe(gen.constant("/work/main"))),
  ([head, snapshot, partial, branch, main]) => {
    const repo: RepoState = { root: "/work/demo", head };
    const want: RepoState = { root: "", head };
    if (snapshot !== undefined) repo.snapshot = want.snapshot = snapshot;
    if (partial !== undefined) repo.partial = want.partial = partial;
    if (branch !== undefined) repo.branch = branch;
    if (main !== undefined) repo.main = main;
    return [repo, want];
  },
);

type MetaCase = { event: AgentEvent; want: AgentEvent };
const CASE: Gen<MetaCase> = gen.map(
  gen.tuple(
    KIND_AND_CHECKPOINT,
    gen.array(ENTRY, { maxLength: 6 }),
    maybe(TOOL_NAMES),
    maybe(REDACTIONS),
    gen.tuple(...OPTIONAL.map(([, g]) => maybe(g))),
    gen.frequency([1, gen.constant(undefined)], [2, REPO]),
  ),
  ([[kind, checkpoint], entries, names, counts, optional, repo]) => {
    // A later field under the same key replaces an earlier one, in the payload and in what the view keeps.
    const fields = [...entries];
    if (names) fields.push(names);
    if (counts) fields.push(counts);
    if (checkpoint) fields.push(...checkpointSlots(kind, checkpoint));
    const slots = new Map<string, Slot>();
    for (const s of fields) slots.set(s.key, s);
    const payload = Object.fromEntries([...slots.values()].map((s) => [s.key, s.value]));
    const wantPayload = Object.fromEntries([...slots.values()].filter((s) => s.want !== DROPPED).map((s) => [s.key, s.want]));
    const event: AgentEvent = { id: "e1", v: 0, sessionId: "s1", ts: 1_700_000_000_000, agent: "claude-code", kind, payload };
    const want: AgentEvent = { ...event, payload: wantPayload };
    OPTIONAL.forEach(([key, , kept], i) => {
      const v = optional[i];
      if (v === undefined) return;
      Object.assign(event, { [key]: v });
      if (kept) Object.assign(want, { [key]: v });
    });
    if (repo) [event.repo, want.repo] = repo;
    return { event, want };
  },
);

type View = (e: AgentEvent) => AgentEvent;

/** The keys of `a` and `b` (and of their payloads, as payload.<key>) that differ. */
function differs(a: AgentEvent, b: AgentEvent): string[] {
  const keys = (x: object, y: object, pre: string): string[] =>
    [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => k !== "payload" && (Object.hasOwn(x, k) !== Object.hasOwn(y, k) || !isDeepStrictEqual((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]))).map((k) => pre + k);
  return [...keys(a, b, ""), ...keys(a.payload, b.payload, "payload.")];
}

/** Fails unless `view` leaves the event as it was, gives what the rules keep, and gives the same view of its view. */
function expectView(c: MetaCase, view: View): void {
  const before = structuredClone(c.event);
  const got = view(c.event);
  assert.deepEqual(c.event, before, "the input changed");
  assert.deepEqual(got, c.want, `the view differs from what the rules keep at ${differs(got, c.want).join(", ")}`);
  assert.deepEqual(view(got), got, `the view of the view differs at ${differs(view(got), got).join(", ")}`);
}

test("the metadata view of an event keeps what the rules keep and nothing else", async (t) => {
  const seen = { lists: 0, cut: 0, checkpoints: 0, partialFalse: 0 };
  await forAll(
    CASE,
    (c) => {
      expectView(c, toMetadata);
      const { payload } = c.event;
      seen.lists += Object.entries(payload).filter(([k, v]) => k !== "toolNames" && Array.isArray(v)).length;
      if (Array.isArray(payload.toolNames) && payload.toolNames.filter(isShortString).length > 128) seen.cut++;
      if (typeof c.want.payload.sha256 === "string") seen.checkpoints++;
      if (c.want.repo?.partial === false) seen.partialFalse++;
    },
    { runs: RUNS, label: "metadata" },
  );
  t.diagnostic(`${seen.lists} lists dropped, ${seen.cut} toolNames cut at 128, ${seen.checkpoints} checkpoints kept, ${seen.partialFalse} repos with partial false`);
});

test("the property fails on a view that keeps lists or the repo root, drops partial false, keeps toolNames past 128, or keeps hashes as they came", async (t) => {
  const after = (f: (out: AgentEvent, e: AgentEvent) => void): View => (e) => {
    const out = toMetadata(e);
    f(out, e);
    return out;
  };
  const mutants: [string, View, RegExp][] = [
    [
      "a view that keeps lists under every key",
      after((out, e) => {
        for (const [k, v] of Object.entries(e.payload)) if (Array.isArray(v)) out.payload[k] = v.filter(isShortString).slice(0, 128);
      }),
      /keep at payload\./,
    ],
    [
      "a view that keeps the repo root",
      after((out, e) => {
        if (out.repo && e.repo) out.repo.root = e.repo.root;
      }),
      /keep at repo$/m,
    ],
    [
      "a view that drops a partial flag of false",
      after((out) => {
        if (out.repo?.partial === false) delete out.repo.partial;
      }),
      /keep at repo$/m,
    ],
    [
      "a view that keeps toolNames past 128",
      after((out, e) => {
        if (Array.isArray(e.payload.toolNames)) out.payload.toolNames = e.payload.toolNames.filter(isShortString);
      }),
      /keep at payload\.toolNames$/m,
    ],
    [
      "a view that keeps the checkpoint's hashes as they came",
      after((out, e) => {
        if (typeof out.payload.sha256 === "string") out.payload.sha256 = e.payload.sha256;
      }),
      /keep at payload\.sha256$/m,
    ],
  ];
  for (const [label, view, why] of mutants) {
    const f = await failure(CASE, (c) => expectView(c, view), { env: {}, runs: 300, label });
    assert.match(f.cause instanceof Error ? f.cause.message : String(f.cause), why, label);
    t.diagnostic(`${label}: failed on case ${f.caseIndex + 1}`);
  }
});

/** The PropertyFailure forAll throws; fails when it throws none. */
async function failure<T>(g: Gen<T>, prop: (v: T) => void, opts: ForAllOptions): Promise<PropertyFailure> {
  try {
    await forAll(g, prop, opts);
  } catch (e) {
    if (e instanceof PropertyFailure) return e;
    throw e;
  }
  assert.fail(`${opts.label ?? "the property"} passed`);
}
