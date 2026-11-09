// `coding.sh purge --literal <file>`: remove a leaked secret from a SQLite store
// after the fact, everywhere it was written: event payloads (with the full-text
// index kept in sync), session titles and stats, eval docs, labels, kv rows,
// blobs (rewritten under their new hash, with every ref repointed) and the raw
// spool. Then the FTS index is merged, the WAL checkpointed and the file VACUUMed,
// so the old bytes are gone from disk, not just unreferenced.
//
// Values are replaced with [redacted:purged]. Spool files keep their length (the
// value becomes asterisks) so ingest cursors, which are byte offsets, stay valid.
// Nothing here prints or returns a value; callers get counts.
//
// `--rule <regex>` first reads everywhere a purge writes (findRuleMatches) and
// turns each distinct match into a literal, so both paths scrub the same way.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BlobStore } from "../core/types.ts";
import type { AgentEvent } from "../schema/index.ts";
import { storedSearchText } from "./common.ts";
import { loadSqlite, searchIndexOk } from "./sqlite.ts";

export const PURGE_MARKER = "[redacted:purged]";
/** Shorter literals would rewrite ordinary text. */
export const MIN_LITERAL_LENGTH = 8;
/** A rule that matches more distinct values than this is too broad to be one leaked secret. */
export const MAX_RULE_VALUES = 10_000;
/** Raw files above this size are neither scanned nor masked; the result counts them. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface PurgeOptions {
  /** The SQLite index file. */
  dbPath: string;
  blobs: BlobStore;
  /** Directories of raw files to mask in place: the spool, the judge cache, eval run dirs (skipped when absent). */
  fileDirs?: readonly string[];
  literals: readonly string[];
  /** Count only; change nothing. */
  dryRun?: boolean;
}

export interface PurgeResult {
  /** Rows changed (or that would be), by what they are. */
  events: number;
  sessions: number;
  /** Labels, eval tasks, runs, bundles, datasets, experiments, judges and kv rows. */
  otherRows: number;
  blobs: number;
  /** Files masked in the spool, judge cache and eval run dirs. */
  files: number;
  /** Raw files over MAX_FILE_BYTES, left alone. Absent when none. */
  filesSkipped?: number;
  /** Saved session folds dropped (rebuilt on the next ingest). */
  foldsDropped: number;
  /** After the purge: PRAGMA integrity_check passed and the search index is sound (searchIndexOk). */
  integrity?: boolean;
}

type Row = Record<string, unknown>;

/** The literal as it appears inside a JSON string. */
const jsonForm = (s: string): string => JSON.stringify(s).slice(1, -1);

/**
 * Positions of `needle` in `hay` that are not escaped: preceded by an even number
 * of backslashes. In JSON text, `\nabc` holds "nabc" as bytes but not as a value.
 */
function unescapedHits(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    let k = 0;
    while (i - k - 1 >= 0 && hay[i - k - 1] === "\\") k++;
    if (k % 2 === 0) out.push(i);
  }
  return out;
}

export class Scrubber {
  private readonly lits: string[];
  private readonly needles: string[];

  constructor(literals: readonly string[]) {
    // Longest first, so a literal that contains another is replaced whole.
    this.lits = [...new Set(literals)].sort((a, b) => b.length - a.length);
    this.needles = [...new Set(this.lits.flatMap((l) => [l, jsonForm(l)]))];
  }

  /** Raw and JSON-escaped forms, for SQL instr() prefilters. */
  get searchNeedles(): readonly string[] {
    return this.needles;
  }

  hit(s: string | null | undefined): boolean {
    return typeof s === "string" && this.needles.some((n) => s.includes(n));
  }

  text(s: string): string {
    let out = s;
    for (const l of this.lits) if (out.includes(l)) out = out.split(l).join(PURGE_MARKER);
    return out;
  }

  /** Deep-scrubs strings (and object keys) in a JSON value. */
  value(v: unknown, depth = 0): unknown {
    if (typeof v === "string") return this.text(v);
    if (depth > 200 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => this.value(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) Object.defineProperty(out, this.text(k), { value: this.value(x, depth + 1), enumerable: true, writable: true, configurable: true });
    return out;
  }

  /** JSON text in, JSON text out (text that is not JSON is scrubbed as text). */
  json(s: string): string {
    try {
      return JSON.stringify(this.value(JSON.parse(s)));
    } catch {
      return this.text(s);
    }
  }

  /** Same-length masking of every unescaped raw or JSON-escaped occurrence. Returns the byte ranges to overwrite. */
  maskRanges(buf: Buffer): { start: number; length: number }[] {
    const text = buf.toString("latin1"); // one char per byte, so indexes are byte offsets
    const ranges: { start: number; length: number }[] = [];
    for (const n of this.needles) {
      const bytes = Buffer.from(n, "utf8").toString("latin1");
      for (const i of unescapedHits(text, bytes)) ranges.push({ start: i, length: bytes.length });
    }
    return ranges;
  }

  /** Byte-level replace for blobs (any encoding of the literal as UTF-8). */
  bytes(buf: Uint8Array): Uint8Array | undefined {
    const text = Buffer.from(buf).toString("latin1");
    let out = text;
    for (const l of this.lits) {
      for (const form of l === jsonForm(l) ? [l] : [l, jsonForm(l)]) {
        const b = Buffer.from(form, "utf8").toString("latin1");
        const hits = unescapedHits(out, b);
        if (!hits.length) continue;
        let next = "";
        let at = 0;
        for (const i of hits) {
          next += out.slice(at, i) + PURGE_MARKER;
          at = i + b.length;
        }
        out = next + out.slice(at);
      }
    }
    return out === text ? undefined : Buffer.from(out, "latin1");
  }
}

/**
 * Every regular file under `dir` (recursively). Symlinks are not followed, and a
 * `.git` directory (in an eval run's work tree) is skipped: its objects are
 * compressed, so a mask could only corrupt them.
 */
function* filesUnder(dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== ".git") yield* filesUnder(p);
    } else if (ent.isFile() && !ent.name.endsWith(".lock")) yield p;
  }
}

/** Raw files purge reads, and how many it leaves alone for their size. */
function rawFiles(dirs: readonly string[] | undefined): { files: string[]; skipped: number } {
  const files: string[] = [];
  let skipped = 0;
  for (const dir of dirs ?? []) {
    if (!existsSync(dir)) continue;
    for (const f of filesUnder(dir)) {
      const size = statSync(f).size;
      if (size > MAX_FILE_BYTES) skipped++;
      else if (size > 0) files.push(f);
    }
  }
  return { files, skipped };
}

/** Overwrites matches in place, same length, without truncating: a hook appending meanwhile loses nothing. */
function maskFile(path: string, scrub: Scrubber, dryRun: boolean): boolean {
  const ranges = scrub.maskRanges(readFileSync(path));
  if (!ranges.length) return false;
  if (dryRun) return true;
  const fd = openSync(path, "r+");
  try {
    for (const r of ranges) writeSync(fd, Buffer.alloc(r.length, "*"), 0, r.length, r.start);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** JSON-holding columns, by table; others are plain text. */
const OTHER_TABLES: { table: string; key: string; json: string[]; text: string[] }[] = [
  { table: "labels", key: "id", json: [], text: ["note"] },
  { table: "tasks", key: "id", json: ["doc", "tags"], text: ["name"] },
  { table: "runs", key: "id", json: ["doc"], text: [] },
  { table: "bundles", key: "id", json: ["doc"], text: ["name"] },
  { table: "datasets", key: "rowid", json: ["doc"], text: ["note", "name"] },
  { table: "experiments", key: "id", json: ["doc"], text: ["name"] },
  { table: "judges", key: "id", json: ["doc"], text: [] },
];

const instrAny = (cols: string[], needles: readonly string[]): string => cols.flatMap((c) => needles.map(() => `instr(${c}, ?) > 0`)).join(" OR ");
const params = (cols: string[], needles: readonly string[]): string[] => cols.flatMap(() => [...needles]);

/** Rewrites blobs holding a repointed ref until none does (at most a few levels: message → page → document). */
async function repointNested(blobs: BlobStore, refs: readonly string[], repoint: Map<string, string>, oldRefs: string[]): Promise<void> {
  let frontier = new Map(repoint);
  for (let level = 0; frontier.size && level < 8; level++) {
    const next = new Map<string, string>();
    for (const ref of refs) {
      const cur = repoint.get(ref) ?? ref;
      const text = await blobs.getText(cur).catch(() => undefined);
      if (text === undefined || ![...frontier.keys()].some((f) => text.includes(f))) continue;
      let t = text;
      for (const [from, to] of frontier) t = t.replaceAll(from, to);
      const fresh = await blobs.put(t);
      if (fresh === cur) continue;
      if (cur !== ref) oldRefs.push(cur);
      else oldRefs.push(ref);
      repoint.set(ref, fresh);
      next.set(cur, fresh);
      if (cur !== ref) next.set(ref, fresh);
    }
    frontier = next;
  }
}

export async function purgeLiterals(o: PurgeOptions): Promise<PurgeResult> {
  for (const l of o.literals) if (l.length < MIN_LITERAL_LENGTH) throw new Error(`a literal is shorter than ${MIN_LITERAL_LENGTH} characters; it would rewrite ordinary text`);
  const scrub = new Scrubber(o.literals);
  const needles = scrub.searchNeedles;
  const dry = o.dryRun === true;
  const result: PurgeResult = { events: 0, sessions: 0, otherRows: 0, blobs: 0, files: 0, foldsDropped: 0 };
  const { DatabaseSync } = await loadSqlite();
  const db: DatabaseSync = new DatabaseSync(o.dbPath);
  db.exec("PRAGMA busy_timeout = 10000");
  const touchedSessions = new Set<string>();
  try {
    // ---- blobs first: their new refs are written with the rows below, in one transaction.
    const repoint = new Map<string, string>();
    const oldRefs: string[] = [];
    const refs: string[] = [];
    for await (const ref of o.blobs.list()) refs.push(ref); // listed up front: puts below add refs
    for (const ref of refs) {
      const data = await o.blobs.get(ref);
      if (!data) continue;
      const clean = scrub.bytes(data);
      if (!clean) continue;
      result.blobs++;
      if (dry) continue;
      const next = await o.blobs.put(clean);
      if (next !== ref) repoint.set(ref, next), oldRefs.push(ref);
    }
    // Blobs that point at a rewritten blob (a proxied request's message pages
    // and document, proxy/blocks.ts) are rewritten to its new ref, level by level.
    if (!dry) await repointNested(o.blobs, refs, repoint, oldRefs);

    const run = () => {
      // External-content FTS: a row's old text must be deleted before the row changes, the new text indexed after.
      const ftsDelete = db.prepare("INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', ?, ?)");
      const ftsInsert = db.prepare("INSERT INTO events_fts(rowid, text) SELECT rowid, text FROM events WHERE rowid = ? AND text IS NOT NULL AND text <> ''");
      const update = db.prepare("UPDATE events SET payload = ?, search_extra = ?, cwd = ? WHERE rowid = ?");
      // ---- events: payload, search text and cwd, with the FTS row replaced.
      const cols = ["payload", "search_extra", "cwd"];
      const rows = db.prepare(`SELECT rowid AS rid, session_id, kind, payload, search_extra, cwd, text FROM events WHERE ${instrAny(cols, needles)}`).all(...params(cols, needles)) as Row[];
      for (const r of rows) {
        result.events++;
        touchedSessions.add(String(r.session_id));
        if (dry) continue;
        const payload = scrub.value(JSON.parse(String(r.payload))) as Record<string, unknown>;
        const searchExtra = r.search_extra === null ? null : (storedSearchText({ kind: r.kind, payload } as AgentEvent) ?? null);
        if (typeof r.text === "string" && r.text !== "") ftsDelete.run(r.rid as number, r.text);
        update.run(JSON.stringify(payload), searchExtra, typeof r.cwd === "string" ? scrub.text(r.cwd) : null, r.rid as number);
        ftsInsert.run(r.rid as number);
      }

      // ---- refs to rewritten blobs: events.blobs, and ref-valued strings in payloads and eval docs.
      for (const [from, to] of repoint) {
        const swap = (v: unknown): unknown => (v === from ? to : Array.isArray(v) ? v.map(swap) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v);
        for (const r of db.prepare("SELECT rowid AS rid, session_id, blobs, payload, text FROM events WHERE instr(blobs, ?) > 0 OR instr(payload, ?) > 0").all(from, from) as Row[]) {
          touchedSessions.add(String(r.session_id));
          if (typeof r.text === "string" && r.text !== "") ftsDelete.run(r.rid as number, r.text);
          db.prepare("UPDATE events SET blobs = ?, payload = ? WHERE rowid = ?").run(
            typeof r.blobs === "string" ? JSON.stringify(swap(JSON.parse(r.blobs))) : null,
            JSON.stringify(swap(JSON.parse(String(r.payload)))),
            r.rid as number,
          );
          ftsInsert.run(r.rid as number);
        }
        for (const t of ["tasks", "runs", "bundles", "experiments", "datasets"]) db.prepare(`UPDATE ${t} SET doc = replace(doc, ?, ?) WHERE instr(doc, ?) > 0`).run(from, to, from);
      }

      // ---- sessions: title, cwd, stats (derail details quote commands), repo, parent.
      const scols = ["title", "cwd", "stats", "repo", "parent"];
      for (const r of db.prepare(`SELECT rowid AS rid, id, title, cwd, stats, repo, parent FROM sessions WHERE ${instrAny(scols, needles)}`).all(...params(scols, needles)) as Row[]) {
        result.sessions++;
        touchedSessions.add(String(r.id));
        if (dry) continue;
        const t = (v: unknown) => (typeof v === "string" ? scrub.text(v) : null);
        const j = (v: unknown) => (typeof v === "string" ? scrub.json(v) : null);
        db.prepare("UPDATE sessions SET title = ?, cwd = ?, stats = ?, repo = ?, parent = ? WHERE rowid = ?").run(t(r.title), t(r.cwd), j(r.stats) ?? "{}", j(r.repo), j(r.parent), r.rid as number);
      }

      // ---- eval docs, labels and the rest.
      for (const { table, key, json, text } of OTHER_TABLES) {
        const all = [...json, ...text];
        for (const r of db.prepare(`SELECT ${key} AS k, ${all.join(", ")} FROM ${table} WHERE ${instrAny(all, needles)}`).all(...params(all, needles)) as Row[]) {
          result.otherRows++;
          if (dry) continue;
          const sets = all.map((c) => `${c} = ?`).join(", ");
          const values = all.map((c) => (typeof r[c] !== "string" ? (r[c] as null) : json.includes(c) ? scrub.json(r[c] as string) : scrub.text(r[c] as string)));
          db.prepare(`UPDATE ${table} SET ${sets} WHERE ${key} = ?`).run(...values, r.k as string);
        }
      }

      // ---- kv: saved folds holding the value (or of a touched session) are dropped; other values scrubbed.
      for (const r of db.prepare(`SELECT key, value FROM kv WHERE ${instrAny(["value"], needles)}`).all(...needles) as Row[]) {
        const k = String(r.key);
        if (k.startsWith("fold:")) {
          touchedSessions.add(k.slice(5));
          continue;
        }
        result.otherRows++;
        if (!dry) db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(typeof r.value === "string" ? scrub.json(r.value) : PURGE_MARKER, k);
      }
      const dropFold = db.prepare("DELETE FROM kv WHERE key = ?");
      for (const id of touchedSessions) {
        if (dry) {
          if (db.prepare("SELECT 1 FROM kv WHERE key = ?").get(`fold:${id}`)) result.foldsDropped++;
        } else result.foldsDropped += Number(dropFold.run(`fold:${id}`).changes);
      }
    };

    if (dry) run();
    else {
      db.exec("BEGIN IMMEDIATE");
      try {
        run();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      // The rows point at the new blobs now; the old ones go.
      for (const ref of oldRefs) await o.blobs.delete(ref);
    }

    // ---- raw files: hook payloads not yet (or already) ingested, cached judge prompts, eval run dirs.
    const raw = rawFiles(o.fileDirs);
    for (const f of raw.files) if (maskFile(f, scrub, dry)) result.files++;
    if (raw.skipped) result.filesSkipped = raw.skipped;

    if (!dry) {
      // Merge FTS segments (dropping deleted tokens), then rewrite the file so freed pages keep nothing.
      db.exec("INSERT INTO events_fts(events_fts) VALUES ('optimize')");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const ok = (db.prepare("PRAGMA integrity_check").get() as Row | undefined)?.integrity_check === "ok";
      result.integrity = ok && searchIndexOk(db);
    }
  } finally {
    db.close();
  }
  return result;
}

export interface RuleScanOptions {
  dbPath: string;
  blobs: BlobStore;
  fileDirs?: readonly string[];
  rules: readonly RegExp[];
}

export interface RuleScan {
  /** Distinct matches of MIN_LITERAL_LENGTH characters or more: the values to purge. */
  values: string[];
  /** Distinct shorter matches, left alone (they would rewrite ordinary text). */
  short: number;
}

/** More than MAX_RULE_VALUES distinct matches: the rule describes ordinary text, not a secret. */
export class RuleTooBroad extends Error {
  constructor() {
    super(`a rule matched more than ${MAX_RULE_VALUES} distinct values`);
    this.name = "RuleTooBroad";
  }
}

/** Calls `f` with every string in a JSON value, object keys included. */
function eachString(v: unknown, f: (s: string) => void, depth = 0): void {
  if (typeof v === "string") return f(v);
  if (depth > 200 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) for (const x of v) eachString(x, f, depth + 1);
  else for (const [k, x] of Object.entries(v as Record<string, unknown>)) f(k), eachString(x, f, depth + 1);
}

/**
 * Every distinct value the rules match where a purge writes: event payloads, session
 * columns, the other tables, kv rows, blobs and raw files. JSON columns are matched
 * on their decoded strings, blobs and raw files on their bytes as UTF-8. Read-only.
 */
export async function findRuleMatches(o: RuleScanOptions): Promise<RuleScan> {
  const rules = o.rules.map((r) => new RegExp(r.source, r.flags.includes("g") ? r.flags : `${r.flags}g`));
  const values = new Set<string>();
  const short = new Set<string>();
  const scan = (s: string): void => {
    for (const re of rules) {
      for (const m of s.matchAll(re)) {
        const v = m[0];
        if (v.length >= MIN_LITERAL_LENGTH) {
          values.add(v);
          if (values.size > MAX_RULE_VALUES) throw new RuleTooBroad();
        } else if (v) short.add(v);
      }
    }
  };
  const scanJson = (s: unknown): void => {
    if (typeof s !== "string") return;
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      return scan(s);
    }
    eachString(v, scan);
  };
  const text = (s: unknown): void => {
    if (typeof s === "string") scan(s);
  };

  const { DatabaseSync } = await loadSqlite();
  const db: DatabaseSync = new DatabaseSync(o.dbPath, { readOnly: true });
  try {
    for (const r of db.prepare("SELECT payload, cwd FROM events").iterate() as Iterable<Row>) scanJson(r.payload), text(r.cwd);
    for (const r of db.prepare("SELECT title, cwd, stats, repo, parent FROM sessions").iterate() as Iterable<Row>) {
      text(r.title), text(r.cwd), scanJson(r.stats), scanJson(r.repo), scanJson(r.parent);
    }
    for (const { table, json, text: cols } of OTHER_TABLES) {
      for (const r of db.prepare(`SELECT ${[...json, ...cols].join(", ")} FROM ${table}`).iterate() as Iterable<Row>) {
        for (const c of json) scanJson(r[c]);
        for (const c of cols) text(r[c]);
      }
    }
    for (const r of db.prepare("SELECT value FROM kv WHERE key NOT LIKE 'fold:%'").iterate() as Iterable<Row>) scanJson(r.value);
  } finally {
    db.close();
  }
  for await (const ref of o.blobs.list()) {
    const data = await o.blobs.get(ref);
    if (data) scan(Buffer.from(data).toString("utf8"));
  }
  for (const f of rawFiles(o.fileDirs).files) scan(readFileSync(f, "utf8"));
  return { values: [...values], short: short.size };
}
