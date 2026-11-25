// The backfill checks of adapter-transcript-*.test.ts: an agent's backfill over a copy of one of its fixture
// homes (test/fixtures/adapters), with one file of the copy changed at a time.
//
// Every file in a copy gets the same mtime, a day back, so each session in it reads as finished, and the
// backfill runs with no option but `copied`, so it reads every file on every run. A run's outcome is the
// events it yields, the copies it reports (BackfillOpts.copied) and what it threw, if it threw. Each
// outcome must hold events ingest keeps, each with a 64-hex id, no two alike (_events.ts eventProblems),
// and the backfill must not throw.
//
// A JSONL line is a record when it starts with "{" and parses to a JSON object. Its length n runs through
// the closing brace; a CR or spaces after it are not part of it. No prefix of a JSON object text short of
// its closing brace parses as JSON, so a reader that parses whole lines skips a record cut at any k in
// 1..n-1 as it skips a blank line, and the cuts at k = 1, n/2 and n-1 stand for all the others. Every
// backfill reads its transcripts whole, a line at a time, but one reader looks into a line that does not
// parse: claude-code's subagentOwner reads the first 64 KB of a subagent transcript, and when the file
// goes on past them, it takes a "sessionId" from the last line it read, cut short. checkLines asserts
// that each subagent transcript it changes is under 60 KB, so no cut or closed cut reaches that line.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ADAPTERS } from "../../src/adapters/index.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { FIXTURES, testCtx, tmpEnv } from "../adapters/_helpers.ts";
import { forAll, gen } from "../_prop.ts";
import { preview, stdinText } from "./_common.ts";
import { closeJson } from "./_cut.ts";
import { eventProblems, Problems } from "./_events.ts";

const byId = new Map(ADAPTERS.map((a) => [a.id, a]));

/** A fixture home: a folder an adapter's backfill reads, and the variable that points it there. */
export interface Home {
  agent: string;
  key: string;
  /** The fixture folder, under test/fixtures/adapters. */
  rel: string;
  /** Where in the home the fixture folder goes, when not at its root. */
  into?: string;
  /** Files copied inside the home first: [from, to], relative to the home. */
  copies?: [string, string][];
  /** The only files the checks change; every transcript and JSON file in the home when absent. */
  only?: string[];
  /** How the home differs from its fixture folder, when it does. */
  note?: string;
}

const claude = (rel: string, more: Partial<Home> = {}): Home => ({ agent: "claude-code", key: "CLAUDE_CONFIG_DIR", rel, ...more });
const codex = (rel: string, more: Partial<Home> = {}): Home => ({ agent: "codex", key: "CODEX_HOME", rel, ...more });

const OWNED = "projects/-work-demo/36d2966a-1c53-47f1-891d-aae1827d0e95/subagents/agent-a33e97aae0b87e2b4";
const COPIED = "projects/-work-demo/5c0ffee5-0000-4000-8000-000000000001/subagents/agent-a33e97aae0b87e2b4";
/** A subagent transcript Claude Code copied into another session's folder (a fork, a resumed workflow run): the backfill reports the copy and stores the owner's file. */
const withCopy = claude("claude-code/subagents/config", {
  copies: [
    [`${OWNED}.jsonl`, `${COPIED}.jsonl`],
    [`${OWNED}.meta.json`, `${COPIED}.meta.json`],
  ],
  only: [`${COPIED}.jsonl`],
  note: "with a subagent transcript copied into another session's folder",
});

/** Every fixture home with transcripts, in the parts adapter-transcript-1..6.test.ts check, each about as long to run. */
export const LINE_PARTS: readonly (readonly Home[])[] = [
  [claude("claude-code/real/config"), claude("claude-code/edge/config")],
  [claude("claude-code/subagents/config"), claude("claude-code/config")],
  [claude("claude-code/hooks-real/config"), claude("harness/claude-runs-codex/home/.claude")],
  [claude("claude-code/unapproved/config"), claude("claude-code/fork/config"), withCopy],
  [claude("claude-code/fallback/config"), codex("codex/home"), codex("codex/cut")],
  [
    codex("codex/skill"),
    codex("codex/code-mode", { into: "sessions/2026/11/01" }),
    codex("harness/claude-runs-codex/home/.codex"),
    { agent: "cursor", key: "CURSOR_CONFIG_DIR", rel: "cursor/config" },
    { agent: "antigravity", key: "HOME", rel: "antigravity/home" },
    { agent: "antigravity", key: "HOME", rel: "antigravity/paired/home" },
    { agent: "antigravity", key: "HOME", rel: "antigravity/db-home" },
    { agent: "copilot-cli", key: "COPILOT_HOME", rel: "copilot-cli/home/.copilot" },
    { agent: "copilot-cli", key: "COPILOT_HOME", rel: "copilot-cli/real/home/.copilot" },
    { agent: "droid", key: "HOME", rel: "droid/home" },
    { agent: "droid", key: "HOME", rel: "droid/real/home" },
    { agent: "gemini-cli", key: "GEMINI_CLI_HOME", rel: "gemini-cli/home" },
    { agent: "gemini-cli", key: "GEMINI_CLI_HOME", rel: "gemini-cli/paired/home" },
    { agent: "pi", key: "PI_CODING_AGENT_DIR", rel: "pi/agent" },
    { agent: "pi", key: "PI_CODING_AGENT_DIR", rel: "pi/real/home/.pi/agent" },
  ],
];

/** Every fixture home with JSON files a backfill reads, in the parts adapter-transcript-json-1 and -2.test.ts check. */
export const JSON_PARTS: readonly (readonly Home[])[] = [
  [claude("claude-code/config"), claude("claude-code/subagents/config"), claude("claude-code/fork/config"), claude("claude-code/hooks-real/config")],
  [
    { agent: "droid", key: "HOME", rel: "droid/home" },
    { agent: "droid", key: "HOME", rel: "droid/real/home" },
    { agent: "gemini-cli", key: "GEMINI_CLI_HOME", rel: "gemini-cli/home" },
    { agent: "opencode", key: "XDG_DATA_HOME", rel: "opencode/data" },
  ],
];

/** How a problem names a home. */
const labelOf = (home: Home): string => (home.note ? `${home.rel} ${home.note}` : home.rel);

/** At bound 0 a transcript's records checked are its first, its last and every SAMPLE-th; a JSON file's cuts are k = 1, n/2, n - 1 and every SAMPLE-th k. */
const SAMPLE = 13;

/**
 * Records bound 0 checks too, each holding the first input bound 1 found a problem with: [the home's label, the
 * transcript, the line, the text the cut ends with]. The record is checked as bound 1 checks it, and also cut
 * where the text ends.
 */
const FIXED_LINES: [string, string, number, string][] = [
  // The copy with its first line cut short, so the session that owns it is read from the next line.
  [labelOf(withCopy), `${COPIED}.jsonl`, 1, "{"],
];

/** Cuts bound 0 checks too, each the first input bound 1 found a problem with: [the home's label, the JSON file, the text the cut ends with]. */
const FIXED_JSON: [string, string, string][] = [
  // Closed, it is a second session file with the id of the session in ses_v1.json.
  ["opencode/data", "opencode/storage/session/prj_1/ses_v1c.json", '"id": "ses_v1'],
];

for (const [home, file] of [...FIXED_LINES, ...FIXED_JSON]) {
  if (![...LINE_PARTS, ...JSON_PARTS].flat().some((h) => labelOf(h) === home)) throw new Error(`a FIXED cut names ${home} ${file}, and no part has that home`);
}

/** Where the FIXED cuts of `piece` end: after the text `of` gives for each entry that names the piece. Each entry used goes into `used`. */
function fixedEnds<E>(entries: E[], of: (e: E) => string | undefined, piece: Buffer, where: string, used: Set<E>): number[] {
  const out: number[] = [];
  for (const e of entries) {
    const text = of(e);
    if (text === undefined) continue;
    const i = piece.indexOf(text);
    assert.ok(i >= 0, `${where} holds no ${text}`);
    used.add(e);
    out.push(i + Buffer.byteLength(text));
  }
  return out;
}

/** The FIXED entries of the homes a check covers. */
const fixedOf = <E extends [string, ...unknown[]]>(entries: E[], homes: readonly Home[]): E[] => entries.filter(([home]) => homes.some((h) => labelOf(h) === home));

/** What one backfill run gave. */
export interface Outcome {
  events: AgentEvent[];
  copied: [string, string][];
  threw?: string;
}

const T = Math.floor(Date.now() / 1000) - 86_400;
let copies = 0;

/** A home copied to a temp folder, with at most one file changed from the fixture at a time. */
export class Copy {
  readonly home: Home;
  readonly dir: string;
  readonly label: string;
  /** The changed files may hold a record twice, so two events may share an id. */
  readonly repeats: boolean;
  /** Backfill runs so far. */
  runs = 0;
  readonly #problems: Problems;
  readonly #originals = new Map<string, Buffer>();
  readonly #outcomes = new Map<string, Outcome>();
  #changed: string | undefined;
  #stamp = 0;

  constructor(home: Home, root: string, problems: Problems, repeats = false) {
    this.home = home;
    this.repeats = repeats;
    this.label = labelOf(home);
    this.#problems = problems;
    copies++;
    this.dir = join(root, `home-${copies}`);
    const dst = home.into ? join(this.dir, home.into) : this.dir;
    mkdirSync(dst, { recursive: true });
    cpSync(join(FIXTURES, home.rel), dst, { recursive: true });
    for (const [from, to] of home.copies ?? []) {
      mkdirSync(dirname(join(this.dir, to)), { recursive: true });
      cpSync(join(this.dir, from), join(this.dir, to));
    }
    const files = readdirSync(this.dir, { recursive: true, encoding: "utf8" })
      .map((f) => f.split(sep).join("/"))
      .filter((f) => statSync(join(this.dir, f)).isFile());
    for (const f of files) {
      this.#originals.set(f, readFileSync(join(this.dir, f)));
      utimesSync(join(this.dir, f), T, T);
    }
  }

  /** The files the checks change that end with `ext`, in path order (spool fixtures left out). */
  targets(ext: string): string[] {
    const files = this.home.only ?? [...this.#originals.keys()];
    return files.filter((f) => f.endsWith(ext) && !f.endsWith(".spool.jsonl")).sort();
  }

  original(rel: string): Buffer {
    const b = this.#originals.get(rel);
    if (!b) throw new Error(`${this.label} has no file ${rel}`);
    return b;
  }

  /** The outcome with `rel` holding `bytes` and every other file as copied. `where` names the input in a problem. */
  async with(rel: string, bytes: Buffer, where: string): Promise<Outcome> {
    const key = `${rel}\0${createHash("sha256").update(bytes).digest("hex")}`;
    const hit = this.#outcomes.get(key);
    if (hit) {
      this.#outcomes.delete(key);
      this.#outcomes.set(key, hit);
      return hit;
    }
    this.original(rel);
    if (this.#changed !== undefined && this.#changed !== rel) this.#write(this.#changed, this.original(this.#changed));
    this.#write(rel, bytes);
    this.#changed = rel;
    const out = await this.run(where);
    this.#outcomes.set(key, out);
    if (this.#outcomes.size > 64) this.#outcomes.delete(this.#outcomes.keys().next().value!);
    return out;
  }

  #write(rel: string, bytes: Buffer): void {
    const path = join(this.dir, rel);
    writeFileSync(path, bytes);
    utimesSync(path, T, T);
  }

  /** One backfill over the copy as it is now. */
  async run(where: string): Promise<Outcome> {
    const adapter = byId.get(this.home.agent);
    if (!adapter?.backfill) throw new Error(`${this.home.agent} has no backfill`);
    this.runs++;
    // The plugin index (adapters/_shared/claude-plugins.ts) is cached per config dir until installed_plugins.json's mtime changes.
    const plugins = join(this.dir, "plugins", "installed_plugins.json");
    if (existsSync(plugins)) {
      this.#stamp++;
      utimesSync(plugins, T, T + this.#stamp / 1000);
    }
    const events: AgentEvent[] = [];
    const copied: [string, string][] = [];
    const prev = process.env[this.home.key];
    process.env[this.home.key] = this.dir;
    let threw: string | undefined;
    try {
      for await (const e of adapter.backfill(testCtx().ctx, { copied: (s, o) => void copied.push([s, o]) })) events.push(e);
    } catch (e) {
      threw = e instanceof Error ? e.message.slice(0, 300) : String(e);
    } finally {
      if (prev === undefined) delete process.env[this.home.key];
      else process.env[this.home.key] = prev;
    }
    if (threw !== undefined) this.#problems.add(`${this.label}: the backfill threw: ${threw}`, where);
    for (const p of eventProblems(events, "the same backfill", this.repeats)) this.#problems.add(`${this.label}: ${p}`, where);
    return threw === undefined ? { events, copied } : { events, copied, threw };
  }
}

/** One LF-delimited piece of a file: [start, end) without the LF, and its record length when it holds a record. */
export interface Segment {
  start: number;
  end: number;
  len: number | undefined;
}

export function segments(bytes: Buffer): Segment[] {
  const out: Segment[] = [];
  for (let start = 0; start < bytes.length; ) {
    const lf = bytes.indexOf(0x0a, start);
    const end = lf < 0 ? bytes.length : lf;
    out.push({ start, end, len: recordLength(bytes.subarray(start, end)) });
    start = end + 1;
  }
  return out;
}

/** The bytes through the closing brace, when the piece starts with "{" and parses to a JSON object (spaces or a CR may follow). */
export function recordLength(piece: Buffer): number | undefined {
  let n = piece.length;
  while (n > 0 && (piece[n - 1] === 0x20 || piece[n - 1] === 0x09 || piece[n - 1] === 0x0d)) n--;
  if (n < 2 || piece[0] !== 0x7b || piece[n - 1] !== 0x7d) return undefined;
  try {
    const v: unknown = JSON.parse(piece.subarray(0, n).toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Where each top-level member of a JSON object text ends (the offset of the comma after it), the last member left out. */
export function memberEnds(text: Buffer): number[] {
  const ends: number[] = [];
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) depth++;
    else if (c === 0x7d || c === 0x5d) depth--;
    else if (c === 0x2c && depth === 1) ends.push(i);
  }
  return ends;
}

const short = (v: unknown): string => {
  const s = JSON.stringify(v) ?? "undefined";
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

/** The first place two values differ, as `path: a vs b`. */
function firstDiff(a: unknown, b: unknown, path: string): string {
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      if (!isDeepStrictEqual(ra[k], rb[k])) return firstDiff(ra[k], rb[k], `${path}.${k}`);
    }
  }
  return `${path}: ${short(a)} vs ${short(b)}`;
}

/** How two outcomes differ. */
export function describe(a: Outcome, b: Outcome): string {
  const parts: string[] = [];
  if (a.threw !== b.threw) parts.push(`threw ${short(a.threw)} vs ${short(b.threw)}`);
  if (!isDeepStrictEqual(a.copied, b.copied)) parts.push(`copied ${short(a.copied)} vs ${short(b.copied)}`);
  if (!isDeepStrictEqual(a.events, b.events)) {
    let i = 0;
    while (i < a.events.length && i < b.events.length && isDeepStrictEqual(a.events[i], b.events[i])) i++;
    const ea = a.events[i];
    const eb = b.events[i];
    const at = ea && eb ? firstDiff(ea, eb, `event ${i} (${ea.kind})`) : `event ${i}: ${ea ? ea.kind : "none"} vs ${eb ? eb.kind : "none"}`;
    parts.push(`${a.events.length} vs ${b.events.length} events; ${at}`);
  }
  return parts.join("; ");
}

function same(problems: Problems, copy: Copy, what: string, a: Outcome, b: Outcome, where: string): void {
  if (!isDeepStrictEqual(a, b)) problems.add(`${copy.label}: ${what}`, `${where}: ${describe(a, b)}`);
}

/** Every session `without` has, `got` must have too. */
function kept(problems: Problems, copy: Copy, what: string, got: Outcome, without: Outcome, where: string): void {
  const have = new Set(got.events.map((e) => e.sessionId));
  const lost = [...new Set(without.events.map((e) => e.sessionId))].filter((s) => !have.has(s));
  if (lost.length) problems.add(`${copy.label}: ${what}`, `${where}: lost ${short(lost)}`);
}

/** Checks a copy of each home under one temp root, then fails with every problem found. Returns the backfill runs. */
async function eachHome(homes: readonly Home[], check: (copy: Copy, problems: Problems) => Promise<void>, repeats = false): Promise<number> {
  const env = tmpEnv();
  const problems = new Problems();
  let runs = 0;
  try {
    for (const home of homes) {
      const copy = new Copy(home, env.root, problems, repeats);
      const base = await copy.run(`${copy.label} as copied`);
      const again = await copy.run(`${copy.label} as copied, again`);
      assert.equal(base.threw, undefined, `premise: the backfill of ${copy.label} as copied threw`);
      assert.ok(base.events.length > 0, `premise: the backfill of ${copy.label} as copied yields events`);
      assert.ok(isDeepStrictEqual(base, again), `premise: two backfills of ${copy.label} give the same outcome: ${describe(base, again)}`);
      await check(copy, problems);
      runs += copy.runs;
    }
  } finally {
    env.restore();
  }
  assert.deepEqual(problems.list(), [], "the backfill broke its contract");
  return runs;
}

export interface Stats {
  files: number;
  /** Record lines in the files. */
  records: number;
  /** Record lines checked. */
  lines: number;
  /** Cut offsets, each checked as a cut line and as a file that ends there. */
  cuts: number;
  /** Distinct closed cuts. */
  closed: number;
  /** Non-blank lines that are not records (not cut). */
  other: number;
  /** Backfill runs. */
  runs: number;
}

/**
 * For every record line L at offset s of every JSONL file F in each home, with n its length:
 * - F with L cut to k bytes (its line end kept) gives the outcome F gives with L blank;
 * - F cut at s + k gives the outcome F cut at s gives;
 * - F cut at s + n gives the outcome F cut just after L's line end gives;
 * - F with L cut to k bytes and closed (_cut.ts closeJson) gives an outcome with every session F has with L blank.
 * k runs over 1, n/2 and n-1, and at a `bound` b of 2 or more, b - 1 more offsets spread evenly over the
 * line. The closed cuts are also at k = 1 and at each top-level member's end, and each distinct closed line
 * is checked once. At bound 0 the records checked are F's first and last, every SAMPLE-th, and the
 * FIXED_LINES ones, each also cut where its entry's text ends.
 */
export async function checkLines(homes: readonly Home[], bound: number): Promise<Stats> {
  const stats: Stats = { files: 0, records: 0, lines: 0, cuts: 0, closed: 0, other: 0, runs: 0 };
  const fixed = fixedOf(FIXED_LINES, homes);
  const used = new Set<(typeof fixed)[number]>();
  stats.runs = await eachHome(homes, async (copy, problems) => {
    for (const rel of copy.targets(".jsonl")) {
      stats.files++;
      await fileLines(copy, rel, problems, stats, bound, fixed, used);
    }
  });
  assert.equal(used.size, fixed.length, "a FIXED_LINES entry names a record no transcript has");
  return stats;
}

async function fileLines(
  copy: Copy,
  rel: string,
  problems: Problems,
  stats: Stats,
  bound: number,
  fixed: (typeof FIXED_LINES)[number][],
  used: Set<(typeof FIXED_LINES)[number]>,
): Promise<void> {
  const bytes = copy.original(rel);
  if (copy.home.agent === "claude-code" && rel.includes("/subagents/")) {
    assert.ok(bytes.length < 60 * 1024, `premise: ${copy.label} ${rel} is under 60 KB, so subagentOwner reads all of it (see the header)`);
  }
  const segs = segments(bytes);
  const count = segs.filter((s) => s.len !== undefined).length;
  let r = -1;
  for (const [i, seg] of segs.entries()) {
    const n = seg.len;
    if (n === undefined) {
      if (bytes.subarray(seg.start, seg.end).toString("utf8").trim()) stats.other++;
      continue;
    }
    r++;
    stats.records++;
    const line = bytes.subarray(seg.start, seg.start + n);
    const at = `${rel} line ${i + 1}`;
    const pinned = fixedEnds(fixed, ([home, file, no, end]) => (home === copy.label && file === rel && no === i + 1 ? end : undefined), line, `${copy.label} ${at}`, used);
    if (bound === 0 && r % SAMPLE !== 0 && r !== count - 1 && !pinned.length) continue;
    stats.lines++;
    const before = bytes.subarray(0, seg.start);
    const after = bytes.subarray(seg.end);
    const ends = memberEnds(line);
    const extra = Math.max(0, bound - 1);
    const spread = Array.from({ length: extra }, (_, j) => Math.round(((j + 1) * n) / (extra + 1)));
    const ks = [...new Set([1, n >> 1, n - 1, ...spread, ...pinned])].filter((k) => k >= 1 && k < n).sort((a, b) => a - b);
    const head = await copy.with(rel, before, `${at} and every line after it removed`);
    const blank = await copy.with(rel, Buffer.concat([before, after]), `${at} left blank`);
    for (const k of ks) {
      const cut = line.subarray(0, k);
      const raw = await copy.with(rel, Buffer.concat([before, cut, after]), `${at} cut to ${k} bytes: ${preview(cut)}`);
      same(problems, copy, "a line cut short gives another outcome than the line left blank", raw, blank, `${at}, first ${k} bytes: ${preview(cut)}`);
      const torn = await copy.with(rel, bytes.subarray(0, seg.start + k), `${at} torn at ${k} bytes`);
      same(problems, copy, "a file that ends inside a line gives another outcome than the file without that line", torn, head, `${at}, first ${k} bytes`);
      stats.cuts++;
    }
    const whole = await copy.with(rel, bytes.subarray(0, seg.start + n), `${at} with nothing after it`);
    const through = await copy.with(rel, bytes.subarray(0, Math.min(seg.end + 1, bytes.length)), `${at} with only its line end after it`);
    same(problems, copy, "a file whose last line has no line end gives another outcome than with one", whole, through, at);
    const seen = new Set<string>();
    for (const k of [1, ...ends, ...ks]) {
      const text = closeJson(stdinText(line.subarray(0, k)));
      if (text === undefined || seen.has(text)) continue;
      seen.add(text);
      const where = `${at} cut to ${k} bytes and closed: ${preview(Buffer.from(text))}`;
      const closed = await copy.with(rel, Buffer.concat([before, Buffer.from(text), after]), where);
      kept(problems, copy, "a line with its last members missing loses a session the file has with the line blank", closed, blank, where);
      stats.closed++;
    }
  }
}

/**
 * For each JSONL file F in each home, seeded cases: 2 at a `bound` of 0 and 20 for each bound above
 * (CODING_SH_PROP_RUNS raises them). Lines cut short and closed cuts of F's records put in among F's lines
 * (or in place of one), and maybe a cut record at the end with no line end. F so changed gives the outcome
 * it gives with each line cut short left blank and nothing at the end. A closed cut put in next to the
 * record it was cut from holds that record's ids, so here two events may share an id.
 */
export async function checkMixes(homes: readonly Home[], bound: number): Promise<{ files: number; cases: number; runs: number }> {
  const runs = bound === 0 ? 2 : 20 * bound;
  let files = 0;
  let cases = 0;
  const backfills = await eachHome(
    homes,
    async (copy) => {
      for (const rel of copy.targets(".jsonl")) {
        const n = await mixes(copy, rel, runs);
        if (n) files++;
        cases += n;
      }
    },
    true,
  );
  return { files, cases, runs: backfills };
}

async function mixes(copy: Copy, rel: string, runs: number): Promise<number> {
  const bytes = copy.original(rel);
  const segs = segments(bytes);
  const records = segs.filter((s) => s.len !== undefined);
  if (!records.length) return 0;
  const m = segs.length;
  const LF = Buffer.from("\n");
  const cutOf = (which: number, pick: number) => {
    const r = records[which]!;
    return bytes.subarray(r.start, r.start + 1 + (pick % (r.len! - 1)));
  };
  // An edit: where it goes (before piece `at`, or last), whether it takes that piece's place, which record it cuts and where, and whether it closes the cut.
  const edit = gen.tuple(gen.int(0, m), gen.bool, gen.int(0, records.length - 1), gen.nat(1 << 30), gen.bool);
  const input = gen.tuple(gen.array(edit, { minLength: 1, maxLength: 6, avgLength: 2 }), gen.bool, gen.int(0, records.length - 1), gen.nat(1 << 30));
  const lastLf = bytes[bytes.length - 1] === 0x0a;
  const r = await forAll(
    input,
    async ([edits, torn, which, pick]) => {
      const variant: Buffer[] = [];
      const baseline: Buffer[] = [];
      const both = (b: Buffer) => {
        variant.push(b);
        baseline.push(b);
      };
      for (let at = 0; at <= m; at++) {
        let replaced = false;
        for (const [where, replace, w, p, closed] of edits) {
          if (where !== at) continue;
          if (replace && at < m) replaced = true;
          const cut = cutOf(w, p);
          if (closed) both(Buffer.from(`${closeJson(stdinText(cut)) ?? "{}"}\n`));
          else {
            variant.push(cut, LF);
            baseline.push(LF);
          }
        }
        if (at < m && !replaced) {
          const s = segs[at]!;
          both(bytes.subarray(s.start, Math.min(s.end + 1, bytes.length)));
          if (at === m - 1 && !lastLf) both(LF);
        }
      }
      if (torn) variant.push(cutOf(which, pick));
      const a = await copy.with(rel, Buffer.concat(variant), `${rel} with lines cut short put in`);
      const b = await copy.with(rel, Buffer.concat(baseline), `${rel} with blank lines put in`);
      assert.ok(isDeepStrictEqual(a, b), `${copy.label} ${rel}: ${describe(a, b)}`);
    },
    { runs, label: `cut lines among ${copy.label} ${rel}` },
  );
  return r.runs;
}

/** The cuts of a JSON file of n bytes that `bound` checks, ascending; `pinned` are the file's FIXED_JSON cuts. */
function jsonCuts(n: number, bound: number, pinned: number[]): number[] {
  if (bound >= 1) return Array.from({ length: Math.max(0, n - 1) }, (_, j) => j + 1);
  const ks = new Set([1, n >> 1, n - 1, ...pinned]);
  for (let k = SAMPLE; k < n; k += SAMPLE) ks.add(k);
  return [...ks].filter((k) => k >= 1 && k < n).sort((a, b) => a - b);
}

/**
 * For every JSON file F (n bytes through its last value) in each home, and every k in 1..n-1:
 * - F cut to k bytes gives the outcome F gives left empty;
 * - F cut to k bytes and closed gives an outcome with every session F has left empty (each distinct
 *   closed text once).
 * At a `bound` of 0, k runs over 1, n/2, n-1, every SAMPLE-th k and the FIXED_JSON cuts instead.
 */
export async function checkJsonFiles(homes: readonly Home[], bound: number): Promise<Stats> {
  const stats: Stats = { files: 0, records: 0, lines: 0, cuts: 0, closed: 0, other: 0, runs: 0 };
  const fixed = fixedOf(FIXED_JSON, homes);
  const used = new Set<(typeof fixed)[number]>();
  stats.runs = await eachHome(homes, async (copy, problems) => {
    for (const rel of copy.targets(".json")) {
      stats.files++;
      const bytes = copy.original(rel);
      assert.doesNotThrow(() => JSON.parse(bytes.toString("utf8")), `premise: ${copy.label} ${rel} is JSON`);
      let n = bytes.length;
      while (n > 0 && (bytes[n - 1] === 0x20 || bytes[n - 1] === 0x09 || bytes[n - 1] === 0x0d || bytes[n - 1] === 0x0a)) n--;
      const pinned = fixedEnds(fixed, ([home, file, end]) => (home === copy.label && file === rel ? end : undefined), bytes, `${copy.label} ${rel}`, used);
      const empty = await copy.with(rel, Buffer.alloc(0), `${rel} left empty`);
      const seen = new Set<string>();
      for (const k of jsonCuts(n, bound, pinned)) {
        const cut = bytes.subarray(0, k);
        const raw = await copy.with(rel, cut, `${rel} cut to ${k} bytes: ${preview(cut)}`);
        same(problems, copy, "a JSON file cut short gives another outcome than the file left empty", raw, empty, `${rel}, first ${k} bytes: ${preview(cut)}`);
        stats.cuts++;
        const text = closeJson(stdinText(cut));
        if (text === undefined || seen.has(text)) continue;
        seen.add(text);
        const where = `${rel} cut to ${k} bytes and closed: ${preview(Buffer.from(text))}`;
        const closed = await copy.with(rel, Buffer.from(text), where);
        kept(problems, copy, "a JSON file with its last members missing loses a session the file has left empty", closed, empty, where);
        stats.closed++;
      }
    }
  });
  assert.equal(used.size, fixed.length, "a FIXED_JSON entry names a file no home has");
  return stats;
}
