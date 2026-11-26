// Each adapter's normalize on truncations of every payload the spool fixtures carry.
//
// Inputs: the lines of test/fixtures/adapters/**/*.spool.jsonl, each read by the adapter ingest hands it to
// (its agent's, or the wrapper's for a `coding.sh run` line), with ${FIXTURES} expanded as the adapter tests
// expand it. A payload cut to its first k bytes is stored as the hook stores it (src/spool/hook.ts): the JSON
// its UTF-8 text parses to, else the text. Every fixture payload is a JSON object, so each cut short of the
// whole payload reaches the adapter as text. A payload too long for the line goes to a side file, which
// ingest reads back the same way (core/spool-read.ts).
//
// Properties:
// - For every cut, normalize resolves to events that ingest keeps (core/ingest.ts validEvent), each with a
//   64-hex id, no two with the same one.
// - The same for every cut closed into JSON (_cut.ts closeJson): the payload with every field from the cut
//   on missing, at any depth, and the string or number the cut fell in shortened.
// - A line with a cut payload changes no other line's events: among a fixture file's lines, with lines of
//   cut payloads put in at seeded places, each line gives the events it gives without them.
//
// Bounds, by CODING_SH_MODEL_BOUND (0 when unset): at 0, the cuts of each payload of n bytes at k = 0, 1,
// n/2, n - 1 and n and every 13th k, each also closed, and the FIXED cuts below; the third property runs 3
// seeded cases per fixture file. At 1, every cut (k = 0..n) of every payload and every distinct closed cut,
// and 30 seeded cases per fixture file. At n of 2 or more, also every payload with a run of 1 to n - 1 bytes
// deleted at any offset. CODING_SH_PROP_RUNS raises the seeded cases. At every bound a cut that ends inside
// the fixture root in a path is left out: closed, it would name a directory above test/fixtures, which an
// adapter may read. The default run is about 7,300 cuts, 6,000 closed cuts and 84 cases; it takes about 2 s.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { sep } from "node:path";
import { after, before, test } from "node:test";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { isWrapperLine } from "../../src/adapters/more/wrapper.ts";
import type { Adapter, SpoolLine } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { FIXTURES, loadSpool, testCtx, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { forAll, gen } from "../_prop.ts";
import { modelBound, preview, stdinText } from "./_common.ts";
import { closeJson, storedPayload } from "./_cut.ts";
import { eventProblems, Problems } from "./_events.ts";

const bound = modelBound(process.env.CODING_SH_MODEL_BOUND);

/** At bound 0 the cuts of a payload are k = 0, 1, n/2, n - 1 and n, every SAMPLE-th k, and the FIXED ones. */
const SAMPLE = 13;

/**
 * Cuts bound 0 checks too, each the first input bound 1 found a problem with: [fixture file, line, the text the
 * cut ends with].
 */
const FIXED: [string, number, string][] = [
  // Closed, it is a subagent stop whose transcript path names no file.
  ["cursor/hooks.spool.jsonl", 8, '"agent_transcript_path":"/'],
];

/** The cuts of a payload of n bytes that `bound` checks, ascending; `fixed` are the FIXED cuts of the payload. */
function cutsOf(n: number, fixed: number[]): number[] {
  if (bound >= 1) return Array.from({ length: n + 1 }, (_, k) => k);
  const ks = new Set([0, 1, n >> 1, n - 1, n, ...fixed]);
  for (let k = SAMPLE; k <= n; k += SAMPLE) ks.add(k);
  return [...ks].filter((k) => k >= 0 && k <= n).sort((a, b) => a - b);
}

const byId = new Map(ADAPTERS.map((a) => [a.id, a]));
/** The adapter ingest hands a line to (core/ingest.ts spoolNormalizer); none for a line it skips. */
const adapterOf = (line: SpoolLine): Adapter | undefined => byId.get(line.agent) ?? (isWrapperLine(line) ? byId.get("wrapper") : undefined);

/** The fixture root as it appears in a payload: as is in a text payload, JSON-escaped in an object's text. */
const ROOTS = [...new Set([FIXTURES, JSON.stringify(FIXTURES).slice(1, -1)])].map((r) => Buffer.from(r));

interface Fixture {
  file: string;
  lines: SpoolLine[];
  /** Each line's payload, as the agent piped it to the hook. */
  payloads: Buffer[];
  /** Where each payload holds the fixture root: [start, end) byte ranges. */
  roots: [number, number][][];
}

const fixtures: Fixture[] = readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
  .map((f) => f.split(sep).join("/"))
  .filter((f) => f.endsWith(".spool.jsonl"))
  .sort()
  .map((file) => {
    const lines = loadSpool(file);
    const payloads = lines.map((l) => Buffer.from(typeof l.raw === "string" ? l.raw : JSON.stringify(l.raw ?? null)));
    const roots = payloads.map((p) => {
      const spans: [number, number][] = [];
      for (const root of ROOTS) for (let at = p.indexOf(root); at >= 0; at = p.indexOf(root, at + 1)) spans.push([at, at + root.length]);
      return spans;
    });
    return { file, lines, payloads, roots };
  });

/** A cut at k ends inside the fixture root. */
const insideRoot = (spans: [number, number][], k: number) => spans.some(([a, b]) => a < k && k < b);

async function check(problems: Problems, line: SpoolLine, where: string): Promise<void> {
  const adapter = adapterOf(line);
  // No adapter reads it: ingest skips the line and reports it.
  if (!adapter) return;
  let events: unknown;
  try {
    events = await adapter.normalize(line, testCtx().ctx);
  } catch (e) {
    problems.add(`${adapter.id}.normalize threw: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`, where);
    return;
  }
  for (const p of eventProblems(events, "the same line")) problems.add(`${adapter.id}.normalize: ${p}`, where);
}

let env: TmpEnv;
before(() => {
  env = tmpEnv();
});
after(() => env.restore());

test("every adapter keeps its contract on cuts of every spool fixture payload, as stored and closed", async (t) => {
  const problems = new Problems();
  let cuts = 0;
  let closed = 0;
  let deleted = 0;
  let fixedFound = 0;
  for (const f of fixtures) {
    for (const [i, line] of f.lines.entries()) {
      const bytes = f.payloads[i]!;
      const spans = f.roots[i]!;
      const where = (what: string, input: Buffer) => `${f.file} line ${i + 1}, ${what}: ${preview(input)}`;
      const fixed = FIXED.filter(([file, n]) => file === f.file && n === i + 1).map(([, , end]) => {
        const at = bytes.indexOf(end);
        assert.ok(at >= 0, `${f.file} line ${i + 1} holds no ${end}`);
        fixedFound++;
        return at + Buffer.byteLength(end);
      });
      const seen = new Set<string>();
      for (const k of cutsOf(bytes.length, fixed)) {
        if (insideRoot(spans, k)) continue;
        const cut = bytes.subarray(0, k);
        await check(problems, { ...line, raw: storedPayload(cut) }, where(`first ${k} bytes`, cut));
        cuts++;
        if (k === bytes.length) continue;
        const text = closeJson(stdinText(cut));
        if (text === undefined || seen.has(text)) continue;
        seen.add(text);
        await check(problems, { ...line, raw: JSON.parse(text) }, where(`first ${k} bytes closed`, Buffer.from(text)));
        closed++;
      }
      for (let len = 1; len < bound; len++) {
        for (let at = 0; at + len <= bytes.length; at++) {
          if (spans.some(([a, b]) => at < b && at + len > a)) continue;
          const input = Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + len)]);
          await check(problems, { ...line, raw: storedPayload(input) }, where(`${len} bytes deleted at ${at}`, input));
          deleted++;
        }
      }
    }
  }
  const payloads = fixtures.reduce((n, f) => n + f.lines.length, 0);
  t.diagnostic(`${cuts} cuts, ${closed} closed cuts and ${deleted} deletions over ${payloads} payloads in ${fixtures.length} files`);
  assert.equal(fixedFound, FIXED.length, "a FIXED cut names a line no fixture has");
  assert.deepEqual(problems.list(), [], "normalize broke its contract");
});

/** Each line's events, the lines normalized in order with one context, as the adapter tests do. */
async function normalizeAll(lines: SpoolLine[]): Promise<AgentEvent[][]> {
  const { ctx } = testCtx();
  const out: AgentEvent[][] = [];
  for (const line of lines) {
    const adapter = adapterOf(line);
    out.push(adapter ? await adapter.normalize(line, ctx) : []);
  }
  return out;
}

test("a line with a cut payload changes no other line's events", async (t) => {
  let cases = 0;
  for (const f of fixtures) {
    const n = f.lines.length;
    // Where a cut line goes (before line `at`, or last), which line's payload it cuts, and where (an index into that payload's cuts).
    const insertion = gen.tuple(gen.int(0, n), gen.int(0, n - 1), gen.nat(1 << 30));
    const r = await forAll(
      gen.array(insertion, { minLength: 1, maxLength: 2 * n + 2, avgLength: 3 }),
      async (inserted) => {
        const base = await normalizeAll(f.lines);
        const lines: SpoolLine[] = [];
        const good: number[] = [];
        for (let at = 0; at <= n; at++) {
          for (const [where, which, pick] of inserted) {
            if (where !== at) continue;
            const bytes = f.payloads[which]!;
            const ks = [...Array(bytes.length).keys()].filter((k) => !insideRoot(f.roots[which]!, k));
            lines.push({ ...f.lines[which]!, raw: storedPayload(bytes.subarray(0, ks[pick % ks.length])) });
          }
          if (at < n) {
            good.push(lines.length);
            lines.push(f.lines[at]!);
          }
        }
        const got = await normalizeAll(lines);
        for (let j = 0; j < n; j++) assert.deepEqual(got[good[j]!], base[j], `${f.file} line ${j + 1}`);
      },
      { runs: bound >= 1 ? 30 : 3, label: `cut lines among ${f.file}` },
    );
    cases += r.runs;
  }
  t.diagnostic(`${cases} cases over ${fixtures.length} fixture files`);
});
