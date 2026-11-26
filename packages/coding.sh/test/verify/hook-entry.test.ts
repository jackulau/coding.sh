// The hook's work (src/spool/hook-run.ts runHook, called in-process with a fake stdin and stdout) on inputs
// the spool fixtures do not hold. Each call is checked against the contract in src/spool/hook.ts as
// test/verify/_hook.ts states it: the call prints only what the flags ask for, as one JSON document; reads
// stdin to the end; writes the one spool line the contract describes, or none; writes nothing outside the
// spool; and logs to spool/errors.log exactly the failures the case expects.
//
// Properties, on seeded cases (test/_prop.ts):
// - Mutated payloads, 100 cases. A fixture payload gets 1 to 3 of these changes:
//   - a flipped bit;
//   - an inserted byte: NUL, a line end, a quote, a backslash, a bracket, a stray UTF-8 lead or
//     continuation byte, or a byte UTF-8 never uses;
//   - a deleted run of 1 to 8 bytes;
//   - CRLF line ends;
//   - one or two BOMs;
//   - a lone surrogate, escaped in JSON or as CESU-8 bytes;
//   - a cut UTF-8 sequence;
//   - nesting 1 to 1000 levels deep;
//   - a number too large, too small or too precise for a double, or -0;
//   - padding to just under or over 1023 bytes (where the hook stops parsing), to about 900 bytes (where
//     the line stops fitting inline), or to where the cwd sits at the end of the 64 KB the hook searches;
//   - a GitHub, Anthropic or AWS key, written plainly or with one character escaped.
// - Arguments and env, 60 cases of 1 to 3 calls in one data dir:
//   - any agent and event, including ids that are not safe folder names, or none;
//   - anywhere in the argument list: --reply with valid and invalid JSON, --echo-continue, --sh-pids with
//     good and bad pairs, and unknown flags;
//   - each unset, or set to a usual or odd value: CODING_SH_DISABLE, CODING_SH_ECHO_CONTINUE,
//     CODING_SH_RUN_ID, CLAUDE_CODE_ENTRYPOINT, the host and model gateway variables, and parent agents'
//     session ids;
//   - with and without a Devin project in the env;
//   - stdin: a fixture payload, nothing, or a payload with an odd session id.
//
// Cases, each run once:
// - Stdin that arrives a few bytes at a time between EAGAIN and EWOULDBLOCK errors.
// - EAGAIN with no data for 10 s (on a patched clock).
// - Data, then an EOF error (Windows pipes).
// - EIO at once, and after 10 bytes: no line, the error logged, the reply still printed.
// - Stdin that is a TTY, or closed. Stdout closed.
// - A BOM or whitespace alone.
// - Stdin 1 KB past the 64 MB the hook keeps: the first 64 MB go to a side file, the cut is logged, and the
//   rest is drained. Stdin of exactly 64 MB: kept whole, nothing logged.
// - JSON 100,000 levels deep, with and without a secret beside it.
// - Devin projects. A call that Devin's own coding.sh hook also writes is dropped: matched by the event, by
//   the payload's hook_event_name, by the other compaction event, and for a payload too long to parse. A
//   dead hook path and other events are relabeled devin. A payload naming a Claude Code transcript stays
//   claude-code.
// - Paused calls: the session id kept for each, whether parsed, searched for in a payload too long to
//   parse, or absent.
//
// CODING_SH_PROP_RUNS raises the case counts, and CODING_SH_PROP_SEED replays a seed. The default run
// takes about 4 s; at CODING_SH_PROP_RUNS=1000, about 16 s.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_STDIN_BYTES } from "../../src/spool/hook-run.ts";
import { MAX_INLINE_LINE_BYTES, safeAgentId } from "../../src/spool/write.ts";
import { forAll, gen, xoshiro128ss, type Gen } from "../_prop.ts";
import { preview } from "./_common.ts";
import { HookHome, PID, PPID, expectedLine, fixturePayloads, isPlainObject } from "./_hook.ts";

const PAYLOADS = fixturePayloads();

/** Runs calls against a fresh data dir, checks them, and removes the dir. */
async function inHome(extra: ConstructorParameters<typeof HookHome>[0], run: (home: HookHome) => Promise<void>, allow?: (file: string) => boolean): Promise<void> {
  const home = new HookHome(extra);
  try {
    await run(home);
    const problems = await home.check({ allow });
    assert.deepEqual(problems, [], problems.join("\n"));
  } finally {
    home.dispose();
  }
}

/** An error as node:fs throws it. */
const errno = (code: string, message = `${code}: resource temporarily unavailable, read`) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------- mutations

/** A position, scaled to the input it applies to. */
const AT = gen.int(0, 1_000_000);
/** Where `at` falls among the n + 1 gaps of n bytes. */
const gapAt = (at: number, n: number) => Math.floor((at * (n + 1)) / 1_000_001);
/** Which of n bytes `at` falls on. */
const byteAt = (at: number, n: number) => Math.floor((at * n) / 1_000_001);
const insertAt = (b: Buffer, at: number, add: Buffer | string): Buffer => {
  const i = gapAt(at, b.length);
  return Buffer.concat([b.subarray(0, i), typeof add === "string" ? Buffer.from(add) : add, b.subarray(i)]);
};

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SPECIAL = [0x00, 0x0a, 0x0d, 0x22, 0x5c, 0x7b, 0x7d, 0x5b, 0x5d, 0x80, 0xbf, 0xc0, 0xed, 0xef, 0xf0, 0xff];
/** JSON strings with lone surrogates, as escapes. */
const SURROGATES = ['"\\ud800"', '"\\udc00"', '"\\udc00\\ud800"', '"a\\ud83d"'];
/** Lone surrogates as bytes (CESU-8), which no UTF-8 decoder accepts. */
const CESU = [Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xed, 0xb0, 0x80])];
/** UTF-8 sequences cut short. */
const CUTS = [[0xf0], [0xf0, 0x9f], [0xf0, 0x9f, 0x98], [0xe2, 0x82]].map((b) => Buffer.from(b));
const NUMBERS = ["1e400", "-1e400", "-0", "1e-400", "123456789012345678901234567890", "9007199254740993", "-9007199254740993", "0.1e999999", "1E+308", "4.9e-324", "0e0", "-0.0"];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A JSON string holding a random key in a vendor's shape (0 GitHub, 1 Anthropic, 2 AWS), with the
 * character at `escape` written as a \u escape (none when negative). The prefixes are split so this file
 * holds no key-shaped text.
 */
function secretJson(vendor: number, seed: number, escape: number): string {
  const next = xoshiro128ss(seed);
  const draw = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[next() % alphabet.length]).join("");
  const key =
    vendor === 0 ? ["gh", "p_"].join("") + draw(ALNUM, 36) : vendor === 1 ? ["sk-", "ant-", "api03-"].join("") + draw(`${ALNUM}_-`, 40) : ["AK", "IA"].join("") + draw("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 16);
  if (escape < 0) return JSON.stringify(key);
  const i = escape % key.length;
  return `"${key.slice(0, i)}\\u${key.charCodeAt(i).toString(16).padStart(4, "0")}${key.slice(i + 1)}"`;
}

/** `b` with one more member, first or last, when it is a JSON object; undefined when it is not. */
function withMember(b: Buffer, key: string, valueJson: string, first = false): Buffer | undefined {
  const text = b.toString("utf8");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(v)) return undefined;
  const member = `${JSON.stringify(key)}:${valueJson}`;
  const comma = Object.keys(v).length ? "," : "";
  if (first) {
    const i = text.indexOf("{") + 1;
    return Buffer.from(text.slice(0, i) + member + comma + text.slice(i));
  }
  const j = text.lastIndexOf("}");
  return Buffer.from(text.slice(0, j) + comma + member + text.slice(j));
}

/**
 * `b` padded to `total` bytes: with a "pad" member in a JSON object, else with trailing spaces. With
 * `cwdAt`, the member goes first and is sized so the first "cwd" member starts `cwdAt` characters in
 * (the payload has the size it then has); without a "cwd" member, the total is still `total`.
 */
function padTo(b: Buffer, total: number, cwdAt?: number): Buffer {
  const first = cwdAt !== undefined;
  const probe = withMember(b, "pad", '""', first);
  if (!probe) return Buffer.concat([b, Buffer.alloc(Math.max(0, total - b.length), 0x20)]);
  const cwd = first ? /"cwd"\s*:\s*"/.exec(probe.toString("utf8")) : null;
  const n = Math.max(0, cwd ? cwdAt! - cwd.index : total - probe.length);
  return withMember(b, "pad", JSON.stringify("x".repeat(n)), first)!;
}

type Mut =
  | { kind: "flip"; at: number; bit: number }
  | { kind: "insert"; at: number; byte: number }
  | { kind: "delete"; at: number; len: number }
  | { kind: "crlf" }
  | { kind: "bom"; count: number }
  | { kind: "surrogate"; at: number; form: number }
  | { kind: "cut"; at: number; form: number }
  | { kind: "nest"; at: number; depth: number; obj: boolean; member: boolean }
  | { kind: "number"; at: number; value: string; member: boolean }
  | { kind: "pad"; target: number; delta: number }
  | { kind: "secret"; at: number; vendor: number; seed: number; escape: number; member: boolean };

const MUT: Gen<Mut> = gen.frequency<Mut>(
  [2, gen.record({ kind: gen.constant("flip" as const), at: AT, bit: gen.int(0, 7) })],
  [2, gen.record({ kind: gen.constant("insert" as const), at: AT, byte: gen.pick(SPECIAL) })],
  [2, gen.record({ kind: gen.constant("delete" as const), at: AT, len: gen.int(1, 8) })],
  [1, gen.record({ kind: gen.constant("crlf" as const) })],
  [1, gen.record({ kind: gen.constant("bom" as const), count: gen.int(1, 2) })],
  [1, gen.record({ kind: gen.constant("surrogate" as const), at: AT, form: gen.int(0, SURROGATES.length + CESU.length - 1) })],
  [1, gen.record({ kind: gen.constant("cut" as const), at: AT, form: gen.int(0, CUTS.length - 1) })],
  [1, gen.record({ kind: gen.constant("nest" as const), at: AT, depth: gen.frequency([3, gen.int(1, 10)], [1, gen.int(11, 1000)]), obj: gen.bool, member: gen.bool })],
  [1, gen.record({ kind: gen.constant("number" as const), at: AT, value: gen.pick(NUMBERS), member: gen.bool })],
  [2, gen.record({ kind: gen.constant("pad" as const), target: gen.pick([1023, 900, 65536]), delta: gen.int(-64, 64) })],
  [2, gen.record({ kind: gen.constant("secret" as const), at: AT, vendor: gen.int(0, 2), seed: gen.int(0, 1_000_000), escape: gen.frequency([2, gen.constant(-1)], [1, gen.int(0, 39)]), member: gen.bool })],
);

function mutate(b: Buffer, m: Mut): Buffer {
  switch (m.kind) {
    case "flip": {
      if (!b.length) return b;
      const out = Buffer.from(b);
      const i = byteAt(m.at, b.length);
      out[i] = out[i]! ^ (1 << m.bit);
      return out;
    }
    case "insert":
      return insertAt(b, m.at, Buffer.from([m.byte]));
    case "delete": {
      const i = byteAt(m.at, b.length);
      return Buffer.concat([b.subarray(0, i), b.subarray(i + m.len)]);
    }
    case "crlf": {
      let pretty: string | undefined;
      try {
        pretty = JSON.stringify(JSON.parse(b.toString("utf8")), null, 2);
      } catch {
        // not JSON: its own line ends become CRLF
      }
      const body = pretty !== undefined ? Buffer.from(pretty.replaceAll("\n", "\r\n")) : Buffer.from(b.toString("latin1").replaceAll("\n", "\r\n"), "latin1");
      return Buffer.concat([body, Buffer.from("\r\n")]);
    }
    case "bom":
      return Buffer.concat([...Array.from({ length: m.count }, () => BOM), b]);
    case "surrogate": {
      const escaped = SURROGATES[m.form];
      if (escaped !== undefined) return withMember(b, "s", escaped) ?? insertAt(b, m.at, escaped);
      return insertAt(b, m.at, CESU[m.form - SURROGATES.length]!);
    }
    case "cut":
      return insertAt(b, m.at, CUTS[m.form]!);
    case "nest": {
      const json = m.obj ? '{"a":'.repeat(m.depth) + "1" + "}".repeat(m.depth) : "[".repeat(m.depth) + "]".repeat(m.depth);
      return (m.member ? withMember(b, "nest", json) : undefined) ?? insertAt(b, m.at, json);
    }
    case "number":
      return (m.member ? withMember(b, "n", m.value) : undefined) ?? insertAt(b, m.at, m.value);
    case "pad":
      // Past 64 KB the hook searches the payload's text for its cwd: put the cwd near the end of that window.
      return m.target === 65536 ? padTo(b, m.target + m.delta, m.target + m.delta - 24) : padTo(b, m.target + m.delta);
    case "secret": {
      const json = secretJson(m.vendor, m.seed, m.escape);
      return (m.member ? withMember(b, "note", json) : undefined) ?? insertAt(b, m.at, json);
    }
  }
}

const MUTATED = gen.record({ p: gen.int(0, PAYLOADS.length - 1), muts: gen.array(MUT, { minLength: 1, maxLength: 3, avgLength: 2 }) });

test("the hook keeps its contract on mutated fixture payloads", async (t) => {
  const seen = { long: 0, redacted: 0, text: 0 };
  const r = await forAll(
    MUTATED,
    async ({ p, muts }) => {
      const payload = PAYLOADS[p]!;
      const stdin = muts.reduce(mutate, payload.bytes);
      await inHome({}, async (home) => {
        await home.call(`${payload.fixture}:${payload.lineNo} ${JSON.stringify(muts)} ${preview(stdin)}`, [payload.agent, payload.event], stdin);
        const e = home.calls[0]?.expected;
        if (e?.long) seen.long++;
        if (e?.line.redactions) seen.redacted++;
        if (!e?.long && typeof e?.line.raw === "string") seen.text++;
      });
    },
    { runs: 100, label: "hook, mutated payloads", maxShrinks: 200 },
  );
  t.diagnostic(`${r.runs} cases (seed ${r.seed}): ${seen.long} over ${MAX_INLINE_LINE_BYTES} bytes, ${seen.redacted} redacted, ${seen.text} kept as text`);
});

// ---------------------------------------------------------------- arguments and env

const ODD_AGENTS = ["../x", "..", ".", "CON", "nul.txt", "a/b", "a\\b", "", " ", "Claude-Code", "claude-code ", "x".repeat(100), "ünïcode", ".hidden", "x.", "-x", "lpt1"];
const ODD_EVENTS = ["Stop", "SessionEnd", "session.idle", "SessionStart", "", "../../etc", "PreCompact"];
const AGENTS = [...new Set([...PAYLOADS.map((p) => p.agent), ...ODD_AGENTS])];
const EVENTS = [...new Set([...PAYLOADS.map((p) => p.event), ...ODD_EVENTS])];
const GOOD_REPLIES = ['{"continue":true}', '{"decision":"block","reason":"r"}', "[]", '"text"', "0", ' { "a" : [ 1 , 2 ] } '];
const BAD_REPLIES = ["{", "", "undefined", "[1,]", "NaN", "{'a':1}"];
const PID_PAIRS = ["123,45", "1,1", "0,1", "1,2,3", "12345678901,1", "a,b", "", " 1,2", "9999999999,1"];

/** One flag as the arguments it takes. */
const FLAG: Gen<string[]> = gen.frequency<string[]>(
  [3, gen.constant(["--echo-continue"])],
  [3, gen.map(gen.pick(GOOD_REPLIES), (r) => ["--reply", r])],
  [2, gen.map(gen.pick(BAD_REPLIES), (r) => ["--reply", r])],
  [2, gen.map(gen.pick([...GOOD_REPLIES, ...BAD_REPLIES]), (r) => [`--reply=${r}`])],
  [1, gen.constant(["--reply"])],
  [2, gen.map(gen.pick(PID_PAIRS), (p) => [`--sh-pids=${p}`])],
  [1, gen.pick([["--unknown"], ["--"], ["-x"], ["extra"]])],
);

/** Payloads with session ids a paused call keeps, and ids it must not. */
const SESSION_PAYLOADS = [
  '{"session_id":"s-1","cwd":"/work/demo"}',
  '{"conversationId":"c.2","session_id":null}',
  '{"sessionId":"bad id"}',
  `{"session_id":"${"a".repeat(129)}"}`,
  'not json "session_id":"t-3"',
  '[{"session_id":"in-array"}]',
  '{"session_id":"s\\u002d4"}',
];
type Stdin = { kind: "fixture"; i: number } | { kind: "empty" } | { kind: "session"; i: number };
const STDIN: Gen<Stdin> = gen.frequency<Stdin>(
  [4, gen.record({ kind: gen.constant("fixture" as const), i: gen.int(0, PAYLOADS.length - 1) })],
  [1, gen.record({ kind: gen.constant("empty" as const) })],
  [1, gen.record({ kind: gen.constant("session" as const), i: gen.int(0, SESSION_PAYLOADS.length - 1) })],
);
const stdinOf = (s: Stdin): Buffer => (s.kind === "fixture" ? PAYLOADS[s.i]!.bytes : s.kind === "session" ? Buffer.from(SESSION_PAYLOADS[s.i]!) : Buffer.alloc(0));

/** Unset (a tenth of the time), else one of `g`'s values. */
const maybe = <T>(g: Gen<T>): Gen<T | undefined> => gen.frequency<T | undefined>([1, gen.constant(undefined)], [9, g]);
const CALL = gen.record({
  agent: maybe(gen.pick(AGENTS)),
  event: maybe(gen.pick(EVENTS)),
  flags: gen.array(gen.record({ at: AT, args: FLAG }), { maxLength: 4, avgLength: 1.5 }),
  stdin: STDIN,
});

/** The agent and event, then each flag spliced in where its `at` falls. */
function argvOf(c: { agent: string | undefined; event: string | undefined; flags: { at: number; args: string[] }[] }): string[] {
  const argv = [c.agent, c.event].filter((a): a is string => a !== undefined);
  for (const f of c.flags) argv.splice(gapAt(f.at, argv.length), 0, ...f.args);
  return argv;
}

/** Each variable unset, or set to one of these. */
const ENV_VALUES: Record<string, readonly (string | undefined)[]> = {
  CODING_SH_DISABLE: [undefined, undefined, undefined, "1", "true", "0", "TRUE", "yes"],
  CODING_SH_ECHO_CONTINUE: [undefined, "1", "true", "0"],
  CODING_SH_RUN_ID: [undefined, "run-1", "r".repeat(200), "ünï"],
  CLAUDE_CODE_ENTRYPOINT: [undefined, "cli", "sdk-cli", "x".repeat(100), `${"x".repeat(63)}😀`, "ünïcode"],
  T3CODE_THREAD_ID: [undefined, "thread-1", ""],
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: [undefined, "T3 Code", "t3code", "other"],
  ANTHROPIC_BASE_URL: [undefined, "https://ai-gateway.vercel.sh", "https://openrouter.ai/api", "not a url", ""],
  OPENAI_BASE_URL: [undefined, "http://localhost:1234/v1"],
  CLAUDE_CODE_SESSION_ID: [undefined, "0f2c6a8e-3b1d-4c5e-9f7a-1b2c3d4e5f60", "bad id with spaces"],
  CODEX_THREAD_ID: [undefined, "thr_1"],
  CODEX_TOOL_CALL_ID: [undefined, "call_1"],
};
const ENV = gen.record(Object.fromEntries(Object.entries(ENV_VALUES).map(([k, values]) => [k, gen.pick(values)] as const)));

const ARGS_CASE = gen.record({ vars: ENV, devin: gen.weighted(0.2), calls: gen.array(CALL, { minLength: 1, maxLength: 3, avgLength: 1.5 }) });

test("the hook keeps its contract for any arguments and env", async (t) => {
  const r = await forAll(
    ARGS_CASE,
    async ({ vars, devin, calls }) => {
      const set = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined));
      // A Devin project with no hooks: a claude-code call is Devin's unless its payload names a Claude Code transcript.
      const env = (root: string) => (devin ? { ...set, DEVIN_PROJECT_DIR: join(root, "proj"), DEVIN_CONFIG_HOME: join(root, "devin-config") } : set);
      await inHome(env, async (home) => {
        for (const [i, c] of calls.entries()) {
          const argv = argvOf(c);
          const stdin = stdinOf(c.stdin);
          await home.call(`call ${i + 1}: ${JSON.stringify(argv)}, env ${JSON.stringify(set)}${devin ? " and a Devin project" : ""}, stdin ${preview(stdin)}`, argv, stdin);
        }
      });
    },
    { runs: 60, label: "hook, arguments and env", maxShrinks: 300 },
  );
  t.diagnostic(`${r.runs} cases (seed ${r.seed})`);
});

// ---------------------------------------------------------------- stdin and stdout

/**
 * A stdin that gives `bytes` 1 to 15 at a time, with EAGAIN or EWOULDBLOCK first and after about one
 * piece in 16, as a non-blocking pipe does. The hook sleeps 2 ms on each (about 16 ms on Windows), so
 * they are kept to about 60 a test.
 */
function trickle(bytes: Buffer, seed: number) {
  const next = xoshiro128ss(seed);
  let pos = 0;
  let waits = 3;
  const read = (buf: Buffer): number => {
    if (waits > 0) {
      waits--;
      throw errno(next() % 2 ? "EAGAIN" : "EWOULDBLOCK");
    }
    const n = Math.min(1 + (next() % 15), buf.length, bytes.length - pos);
    bytes.copy(buf, 0, pos, pos + n);
    pos += n;
    waits = next() % 16 === 0 ? 1 + (next() % 2) : 0;
    return n;
  };
  return { read, left: () => bytes.length - pos };
}

test("the hook reads a payload that arrives a few bytes at a time between EAGAIN errors", async () => {
  const bySize = [...PAYLOADS].sort((a, b) => a.bytes.length - b.bytes.length);
  const long = bySize.find((p) => p.bytes.length > MAX_INLINE_LINE_BYTES);
  assert.ok(long, `a fixture payload over ${MAX_INLINE_LINE_BYTES} bytes`);
  await inHome({}, async (home) => {
    for (const [i, p] of [bySize[0]!, long].entries()) {
      const pipe = trickle(p.bytes, i + 1);
      await home.call(`${p.fixture}:${p.lineNo} in pieces`, [p.agent, p.event], p.bytes, { io: { read: pipe.read } });
      assert.equal(pipe.left(), 0, `${p.fixture}:${p.lineNo}: stdin read to the end`);
    }
  });
});

test("the hook stops reading after 10 s of EAGAIN with no data, and writes the line", async () => {
  const realNow = Date.now;
  const start = realNow();
  let offset = 0;
  let reads = 0;
  // Each read moves the clock 3 s on, and nothing else does: the hook gives up on the read that finds more
  // than 10 s since the first.
  Date.now = () => start + offset;
  try {
    await inHome({}, async (home) => {
      const read = () => {
        reads++;
        offset += 3000;
        throw errno("EAGAIN");
      };
      await home.call("EAGAIN forever", ["codex", "notify"], Buffer.alloc(0), { io: { read } });
    });
  } finally {
    Date.now = realNow;
  }
  assert.equal(reads, 5);
});

test("the hook takes an EOF error after the data for the end of stdin (Windows pipes)", async () => {
  const p = PAYLOADS[0]!;
  let pos = 0;
  const read = (buf: Buffer): number => {
    if (pos >= p.bytes.length) throw errno("EOF", "EOF: end of file, read");
    const n = p.bytes.copy(buf, 0, pos);
    pos += n;
    return n;
  };
  await inHome({}, (home) => home.call("data, then EOF", [p.agent, p.event], p.bytes, { io: { read } }).then(() => undefined));
  assert.equal(pos, p.bytes.length);
});

test("a failed read is logged: the hook writes no line and still prints the reply", async () => {
  const stdin = Buffer.from('{"session_id":"s-1","cwd":"/work/demo"}');
  await inHome({}, async (home) => {
    for (const after of [0, 10]) {
      let pos = 0;
      const read = (buf: Buffer): number => {
        if (pos >= after) throw errno("EIO", "EIO: i/o error, read");
        const n = stdin.copy(buf, 0, pos, after);
        pos += n;
        return n;
      };
      await home.call(`EIO after ${after} bytes`, ["claude-code", "Stop", "--reply", '{"continue":true}'], stdin, { io: { read }, expected: null, errors: ["EIO: i/o error, read"] });
    }
  });
});

test("stdin that is a TTY or closed reads as no payload", async () => {
  const argv = ["gemini-cli", "SessionStart"];
  const stdin = Buffer.from('{"session_id":"s-1"}');
  await inHome({}, async (home) => {
    const none = expectedLine(argv, Buffer.alloc(0), home.env);
    await home.call("a TTY", argv, stdin, { io: { isCharDevice: () => true }, expected: none });
    const closed = () => {
      throw errno("EBADF", "EBADF: bad file descriptor, fstat");
    };
    await home.call("stdin closed", argv, stdin, { io: { isCharDevice: closed }, expected: none });
  });
});

test("a closed stdout does not stop the hook", async () => {
  const p = PAYLOADS[0]!;
  const write = () => {
    throw errno("EPIPE", "EPIPE: broken pipe, write");
  };
  await inHome({}, (home) => home.call("stdout closed", [p.agent, p.event, "--echo-continue"], p.bytes, { io: { write }, stdout: "" }).then(() => undefined));
});

test("a BOM alone reads as no payload, and whitespace as text", async () => {
  await inHome({}, async (home) => {
    await home.call("a BOM", ["codex", "notify"], BOM);
    await home.call("whitespace", ["codex", "notify"], Buffer.from(" \r\n\t"));
    await home.call("a BOM and whitespace", ["codex", "notify"], Buffer.concat([BOM, Buffer.from(" \n")]));
  });
});

// ---------------------------------------------------------------- size limits

/** `size` bytes of a JSON object with a cwd and one long string. */
function bigPayload(size: number): Buffer {
  const out = Buffer.alloc(size, "x");
  out.write('{"cwd":"/big","pad":"');
  out.write('"}', size - 2);
  return out;
}

/**
 * The line for a payload too big for the spec to run the redaction rules on: one with no secret, which the
 * hook keeps verbatim in a side file.
 */
const bigLine = (argv: [string, string], rawText: string) => ({
  dir: safeAgentId(argv[0]),
  line: { v: 0, agent: argv[0], event: argv[1], pid: PID, ppid: PPID, cwd: "/big", raw: undefined },
  long: true,
  rawText,
});

test("the hook keeps the first 64 MB of a larger stdin in a side file, logs the cut and drains the rest", async () => {
  const argv: [string, string] = ["claude-code", "PostToolUse"];
  const stdin = bigPayload(MAX_STDIN_BYTES + 1024);
  await inHome({}, (home) => home.call("64 MB and 1 KB", argv, stdin, { truncated: true, expected: bigLine(argv, stdin.toString("utf8", 0, MAX_STDIN_BYTES)) }).then(() => undefined));
});

test("the hook keeps a stdin of exactly 64 MB whole and logs no cut", async () => {
  const argv: [string, string] = ["claude-code", "PostToolUse"];
  const stdin = bigPayload(MAX_STDIN_BYTES);
  await inHome({}, (home) => home.call("exactly 64 MB", argv, stdin, { expected: bigLine(argv, stdin.toString("utf8")) }).then(() => undefined));
});

test("the hook keeps JSON 100,000 levels deep, and redacts a secret beside it", async () => {
  const d = 100_000;
  const array = "[".repeat(d) + "]".repeat(d);
  await inHome({}, async (home) => {
    await home.call("an array 100,000 deep", ["codex", "notify"], Buffer.from(array));
    await home.call("an object 100,000 deep", ["codex", "notify"], Buffer.from('{"a":'.repeat(d) + "1" + "}".repeat(d)));
    await home.call("a GitHub token beside an array 100,000 deep", ["codex", "notify"], Buffer.from(`{"note":${secretJson(0, 7, -1)},"deep":${array}}`));
    // Unless the payload has a secret, the hook keeps it verbatim; with one, the rules replace both.
    const kinds = home.calls.map((c) => [c.expected?.rawText !== undefined, c.expected?.line.redactions]);
    assert.deepEqual(kinds, [
      [true, undefined],
      [true, undefined],
      [false, { "github-token": 1, "too-deep": 1 }],
    ]);
  });
});

// ---------------------------------------------------------------- Devin and paused calls

test("Devin: a call its own coding.sh hook also writes is dropped; its other calls are relabeled; Claude Code's stay", async () => {
  const slash = (p: string) => p.replaceAll("\\", "/");
  await inHome(
    (root) => ({ DEVIN_PROJECT_DIR: join(root, "proj"), DEVIN_CONFIG_HOME: join(root, "devin-config") }),
    async (home) => {
      const proj = slash(join(home.root, "proj"));
      const hookFile = join(home.root, "bin", "hook.mjs");
      mkdirSync(join(home.root, "bin"));
      writeFileSync(hookFile, "");
      mkdirSync(join(home.root, "proj", ".devin"), { recursive: true });
      const group = (command: string) => [{ hooks: [{ type: "command", command }] }];
      const live = (event: string) => group(`node "${slash(hookFile)}" devin ${event}`);
      const hooks = { UserPromptSubmit: live("UserPromptSubmit"), PostCompaction: live("PostCompaction"), Notification: group('node "/nonexistent-csh/bin/hook.mjs" devin Notification') };
      writeFileSync(join(home.root, "proj", ".devin", "hooks.v1.json"), JSON.stringify(hooks));
      const transcript = "/home/user/.claude/projects/-work-demo/0f2c6a8e-3b1d-4c5e-9f7a-1b2c3d4e5f60.jsonl";
      const json = (v: Record<string, unknown>) => Buffer.from(JSON.stringify(v));
      const long = (v: Record<string, unknown>) => json({ ...v, prompt: "x".repeat(2048) });
      const cc = (event: string) => ["claude-code", event];
      const devin = { session_id: "d-1", cwd: proj };
      await home.call("Devin's prompt, from a subfolder", cc("UserPromptSubmit"), json({ ...devin, hook_event_name: "UserPromptSubmit", cwd: `${proj}/sub` }), { expected: null });
      await home.call("Devin's stop", cc("Stop"), json({ ...devin, hook_event_name: "Stop" }));
      await home.call("Claude Code's prompt", cc("UserPromptSubmit"), json({ session_id: "c-1", cwd: proj, hook_event_name: "UserPromptSubmit", transcript_path: transcript }));
      await home.call("PreCompact, written by Devin's PostCompaction hook", cc("PreCompact"), json({ ...devin, hook_event_name: "PreCompact" }), { expected: null });
      await home.call("Devin's prompt, too long to parse", cc("UserPromptSubmit"), long({ ...devin, hook_event_name: "UserPromptSubmit" }), { expected: null });
      await home.call("Devin's notification, whose hook path is dead", cc("Notification"), json({ ...devin, hook_event_name: "Notification" }));
      await home.call("a payload naming a hooked event", cc("SessionStart"), json({ ...devin, hook_event_name: "UserPromptSubmit" }), { expected: null });
      await home.call("Codex's prompt", ["codex", "UserPromptSubmit"], json({ session_id: "x-1", cwd: proj, hook_event_name: "UserPromptSubmit" }));
      await home.call("Claude Code's prompt, too long to parse", cc("UserPromptSubmit"), long({ session_id: "c-1", cwd: proj, hook_event_name: "UserPromptSubmit", transcript_path: transcript }));
      assert.deepEqual(
        home.calls.map((c) => c.expected?.line.agent ?? "dropped"),
        ["dropped", "devin", "claude-code", "dropped", "dropped", "devin", "dropped", "codex", "claude-code"],
      );
    },
    (file) => file.startsWith("proj/") || file.startsWith("bin/"),
  );
});

test("a paused call writes no line and keeps the payload's session id", async () => {
  const argv = ["claude-code", "UserPromptSubmit"];
  const x = (n: number) => "x".repeat(n);
  await inHome({ CODING_SH_DISABLE: "1" }, async (home) => {
    await home.call("1.5 MB, the id first", argv, Buffer.from(`{"session_id":"big-1","pad":"${x(1_500_000)}"}`));
    await home.call("70 KB, the id last", argv, Buffer.from(`{"pad":"${x(70_000)}","session_id":"far"}`));
    await home.call("1.1 MB, the id past the first 64 KB", argv, Buffer.from(`{"pad":"${x(1_100_000)}","session_id":"none"}`));
    await home.call("an id with a quote", argv, Buffer.from('{"session_id":"a\\"b"}'));
    await home.call("a numeric id", argv, Buffer.from('{"session_id":42}'));
    await home.call("a BOM", argv, Buffer.concat([BOM, Buffer.from('{"session_id":"bom-1"}')]));
    await home.call("not JSON", argv, Buffer.from('not json "session_id":"t-3"'));
    await home.call("session_id before sessionId", argv, Buffer.from('{"sessionId":"x","session_id":"first"}'));
    await home.call("--echo-continue", [...argv, "--echo-continue"], Buffer.from('{"conversation_id":"conv-9"}'));
    assert.equal(readFileSync(join(home.spool, "disabled-sessions"), "utf8"), "big-1\nfar\nbom-1\nt-3\nfirst\nconv-9\n");
  });
});
