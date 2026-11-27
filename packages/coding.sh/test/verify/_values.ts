// The checks of adapter-values-*.test.ts: an agent's backfill over a copy of one of its fixture homes
// (_transcript.ts Copy), with one value of one record changed to a value of another type, or removed.
//
// A record is a JSONL line that holds a JSON object (_transcript.ts recordLength), or a whole JSON file. Its
// values are its members and array items, at most DEPTH keys and indexes deep. A change sets one value to one
// of VALUES that differs from it as JSON, or removes it; removing an array item moves the items after it up.
// The record is written back as JSON.stringify writes it, every other value as JSON.parse read it: a line in
// place of the old one, with what followed its closing brace kept, and a JSON file indented by two spaces
// when it held more than one line.
//
// After each change the backfill must not throw, and must yield events ingest keeps, each with a 64-hex id,
// no two alike (_events.ts eventProblems), unless the change can make the file hold one thing twice; such a
// change is checked with the ids allowed to repeat. A value set to what another record of the same file
// holds at the same path can make the two records one, as two Antigravity steps with one step_index are one
// step. A change to the key of a record the file holds twice (TWICE) makes it two records with the same tool
// calls, as a Gemini CLI message written twice becomes two messages that hold one tool call.
//
// The check sees what a backfill yields, not what it leaves out: an error an adapter catches itself is not
// seen, as when the Claude Code backfill skips a file it cannot convert, or Codex keeps the events it
// converted before the error.
//
// A change's name is its agent, the record's kind, the path with its indexes left out, and the new value. A
// JSONL record's kind is the strings at type, payload.type, kind, role and message.role; a JSON file is a
// kind of its own. At a bound b, a part checks the first b changes of each name, in the order of its homes,
// their files, the records in a file, the values in a record (each before the values inside it) and VALUES.
// At 0, it checks every SAMPLE-th of the changes bound 1 checks, from the first.
import assert from "node:assert/strict";
import { type Copy, eachHome, type Home, JSON_PARTS, LINE_PARTS, segments } from "./_transcript.ts";

const REMOVED = Symbol("removed");
/** What a change sets a value to, or REMOVED. */
const VALUES: readonly unknown[] = [null, 0, -1, 1e308, -1e308, "", "x", true, [], [null], {}, REMOVED];
/** How deep a changed value may be, in keys and indexes. */
const DEPTH = 8;
/** At bound 0 a part checks every SAMPLE-th of the changes bound 1 checks. */
const SAMPLE = 13;
/** The keys under which an agent's files may hold one record twice: Gemini CLI writes a message again under its id when the message changes. */
const TWICE: Readonly<Record<string, readonly string[]>> = { "gemini-cli": ["id"] };

const keyOf = (home: Home): string => JSON.stringify(home);
const LINE_HOMES = new Set(LINE_PARTS.flat().map(keyOf));
const JSON_HOMES = new Set(JSON_PARTS.flat().map(keyOf));

/** The homes in LINE_PARTS and JSON_PARTS of the agents `keep` names, each once, in order. */
function homesOf(keep: (agent: string) => boolean): Home[] {
  const out = new Map<string, Home>();
  for (const home of [...LINE_PARTS.flat(), ...JSON_PARTS.flat()]) {
    if (keep(home.agent) && !out.has(keyOf(home))) out.set(keyOf(home), home);
  }
  return [...out.values()];
}

/** The homes adapter-values-1..3.test.ts check: Claude Code's, Codex's and every other agent's, so each part runs about as long. */
export const VALUE_PARTS: readonly (readonly Home[])[] = [
  homesOf((a) => a === "claude-code"),
  homesOf((a) => a === "codex"),
  homesOf((a) => a !== "claude-code" && a !== "codex"),
];

type Path = (string | number)[];

/** Every value in `v` at most DEPTH keys and indexes deep, with its path, each before the values inside it. */
function members(v: unknown, path: Path = [], out: [Path, unknown][] = []): [Path, unknown][] {
  if (path.length >= DEPTH) return out;
  if (Array.isArray(v)) {
    v.forEach((x: unknown, i) => {
      out.push([[...path, i], x]);
      members(x, [...path, i], out);
    });
  } else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push([[...path, k], x]);
      members(x, [...path, k], out);
    }
  }
  return out;
}

/** A copy of `record` with the value at `path` set to `value`, or removed. */
function changed(record: unknown, path: Path, value: unknown): unknown {
  const copy: unknown = JSON.parse(JSON.stringify(record));
  let o = copy as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (value === REMOVED) {
    if (Array.isArray(o)) o.splice(last as number, 1);
    else delete o[last];
  } else {
    // Defined rather than assigned, so a member named __proto__ stays a member.
    Object.defineProperty(o, last, { value: JSON.parse(JSON.stringify(value)), writable: true, enumerable: true, configurable: true });
  }
  return copy;
}

/** A path as text, `message.content[0].text`, or with `exact` false, `message.content[].text`. */
const pathText = (path: Path, exact = true): string => path.map((k, i) => (typeof k === "number" ? `[${exact ? k : ""}]` : i ? `.${k}` : k)).join("");

/** The JSON text of `v` when it may be one of VALUES: a primitive, [], [null] or {}. */
function shortText(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.length === 0 || (v.length === 1 && v[0] === null) ? JSON.stringify(v) : undefined;
  if (v !== null && typeof v === "object") return Object.keys(v).length === 0 ? "{}" : undefined;
  return JSON.stringify(v);
}

const member = (v: unknown, k: string): unknown => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** A JSONL record's kind: the strings at type, payload.type, kind, role and message.role. */
const kindOf = (rec: unknown): string =>
  [member(rec, "type"), member(member(rec, "payload"), "type"), member(rec, "kind"), member(rec, "role"), member(member(rec, "message"), "role")].map(str).join("/");

/** A record of a file. */
interface Rec {
  /** How a problem names it. */
  at: string;
  kind: string;
  value: unknown;
  /** The file's bytes with the record written as `v`. */
  write: (v: unknown) => Buffer;
}

function recordsOf(copy: Copy, rel: string, ext: string): Rec[] {
  const bytes = copy.original(rel);
  if (ext === ".json") {
    let doc: unknown;
    try {
      doc = JSON.parse(bytes.toString("utf8"));
    } catch {
      assert.fail(`premise: ${copy.label} ${rel} is JSON`);
    }
    let n = bytes.length;
    while (n > 0 && (bytes[n - 1] === 0x20 || bytes[n - 1] === 0x09 || bytes[n - 1] === 0x0d || bytes[n - 1] === 0x0a)) n--;
    const indent = bytes.subarray(0, n).includes(0x0a) ? 2 : undefined;
    return [{ at: rel, kind: `file ${rel}`, value: doc, write: (v) => Buffer.concat([Buffer.from(JSON.stringify(v, null, indent)), bytes.subarray(n)]) }];
  }
  const out: Rec[] = [];
  for (const [i, seg] of segments(bytes).entries()) {
    const n = seg.len;
    if (n === undefined) continue;
    const value: unknown = JSON.parse(bytes.subarray(seg.start, seg.start + n).toString("utf8"));
    out.push({ at: `${rel} line ${i + 1}`, kind: kindOf(value), value, write: (v) => Buffer.concat([bytes.subarray(0, seg.start), Buffer.from(JSON.stringify(v)), bytes.subarray(seg.start + n)]) });
  }
  return out;
}

export interface ValueStats {
  files: number;
  records: number;
  /** Distinct change names. */
  names: number;
  /** Changes checked. */
  changes: number;
  /** Changes checked with the ids allowed to repeat. */
  repeats: number;
  /** Backfill runs. */
  runs: number;
}

/** Checks each of `homes` with the changes `bound` picks (see the header), then fails with every problem found. */
export async function checkValues(homes: readonly Home[], bound: number): Promise<ValueStats> {
  const stats: ValueStats = { files: 0, records: 0, names: 0, changes: 0, repeats: 0, runs: 0 };
  const seen = new Map<string, number>();
  let made = 0;
  const check = async (copy: Copy, rel: string, ext: string): Promise<void> => {
    const recs = recordsOf(copy, rel, ext);
    stats.files++;
    stats.records += recs.length;
    const values = recs.map((r) => members(r.value));
    // How many records of the file hold each value at each path.
    const held = new Map<string, Map<string, number>>();
    for (const list of values) {
      for (const [path, v] of list) {
        const text = shortText(v);
        if (text === undefined) continue;
        const p = pathText(path);
        const counts = held.get(p) ?? new Map<string, number>();
        held.set(p, counts.set(text, (counts.get(text) ?? 0) + 1));
      }
    }
    const keys = new Set(TWICE[copy.home.agent] ?? []);
    for (const [r, rec] of recs.entries()) {
      for (const [path, old] of values[r]!) {
        const was = shortText(old);
        const p = pathText(path);
        const twice = keys.has(p) && was !== undefined && (held.get(p)?.get(was) ?? 0) > 1;
        for (const value of VALUES) {
          const text = value === REMOVED ? undefined : JSON.stringify(value);
          if (text !== undefined && text === was) continue;
          const name = JSON.stringify([copy.home.agent, ext, rec.kind, pathText(path, false), text ?? "removed"]);
          const n = seen.get(name) ?? 0;
          if (n >= Math.max(bound, 1)) continue;
          seen.set(name, n + 1);
          if (bound === 0 && made++ % SAMPLE !== 0) continue;
          const repeats = twice || (text !== undefined && (held.get(p)?.get(text) ?? 0) > 0);
          const where = `${rec.at} ${p} ${text === undefined ? "removed" : `set to ${text}`}`;
          await copy.with(rel, rec.write(changed(rec.value, path, value)), where, repeats);
          stats.changes++;
          if (repeats) stats.repeats++;
        }
      }
    }
  };
  stats.runs = await eachHome(homes, async (copy) => {
    const key = keyOf(copy.home);
    for (const ext of [".jsonl", ".json"].filter((e) => (e === ".jsonl" ? LINE_HOMES : JSON_HOMES).has(key))) {
      for (const rel of copy.targets(ext)) await check(copy, rel, ext);
    }
  });
  stats.names = seen.size;
  return stats;
}
