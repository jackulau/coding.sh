// `coding.sh purge --literal <file>`: remove a leaked secret from a SQLite store
// after the fact, everywhere it was written: event payloads (with the full-text
// index kept in sync), session titles and stats, eval docs, labels, kv rows,
// blobs (rewritten under their new hash, with every ref repointed) and the raw
// spool. Then the FTS index is merged, the WAL checkpointed and the file VACUUMed,
// so the old bytes are gone from disk, not just unreferenced.
//
// The copies of the index an upgrade or `upgrade-store --restore` kept next to it
// (index.db.v<N>.bak, index.db.v<N>.undone) hold the value too, at a schema this
// code may not know. They are deleted, not rewritten (removeIndexCopies).
//
// Values are replaced with [redacted:purged]. Spool files keep their length (the
// value becomes asterisks) so ingest cursors, which are byte offsets, stay valid.
// Nothing here prints or returns a value; callers get counts.
//
// The llm cache (`exp run --record`) is gzipped JSONL: a recording that holds a
// value is rewritten whole, with each call's replay key kept. A file there that no
// replay reads (a torn recording, a temp file a crashed run left) is deleted.
//
// Snapshot repos (repos/) are read, never changed: a snapshot is named by its
// commit id in sessions and eval tasks, so rewriting one would break them, and
// dropping its objects would leave commits that can't be read. The repos that
// hold a value are named instead (snapshotRepos), for the user to delete.
//
// `--rule <regex>` first reads everywhere a purge writes (findRuleMatches) and
// turns each distinct match into a literal, so both paths scrub the same way.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { constants as zlibConstants, gunzipSync, gzipSync, inflateSync } from "node:zlib";
import { run as runGit } from "../core/git.ts";
import type { BlobStore } from "../core/types.ts";
import type { AgentEvent } from "../schema/index.ts";
import { errorText, searchableText } from "./common.ts";
import { loadSqlite, searchIndexOk } from "./sqlite.ts";
import { listIndexCopies } from "./upgrade.ts";

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
  /** The llm cache: recordings of model calls, rewritten when they hold a value (skipped when absent). */
  llmCache?: string;
  /** The folder of snapshot repos: read, never changed; the ones that hold a value are named (skipped when absent). */
  repos?: string;
  literals: readonly string[];
  /** Count only; change nothing. */
  dryRun?: boolean;
  /**
   * How long emptying the index's and the blob pack's WALs waits for other processes' reads
   * (default 5 s, and 10 s for the index checkpoint before VACUUM; when set, it bounds both).
   * Tests shorten it; the CLI takes it from CODING_SH_PURGE_WAIT_MS.
   */
  waitMs?: number;
}

export interface PurgeResult {
  /** Rows changed (or that would be), by what they are. */
  events: number;
  sessions: number;
  /** Scores (labels included), eval tasks, runs, bundles, datasets, experiments, judges and kv rows. */
  otherRows: number;
  blobs: number;
  /** Files masked in the spool, judge cache and eval run dirs. */
  files: number;
  /** Recordings of model calls (llm cache) rewritten without the values. */
  recordings: number;
  /** Files in the llm cache that no replay reads (a torn recording, a run's temp file) deleted because they hold a value. Absent when none. */
  recordingsDeleted?: number;
  /** Files in the llm cache that hold a value but could not be rewritten or deleted, as paths. Absent when none. */
  recordingsKept?: string[];
  /** Snapshot repos that hold a value, or could not be read. Purge does not change them. Absent when none. */
  snapshotRepos?: SnapshotRepo[];
  /** Raw files, recordings and snapshot objects over MAX_FILE_BYTES, left alone. Absent when none. */
  filesSkipped?: number;
  /** Saved session folds dropped (rebuilt on the next ingest). */
  foldsDropped: number;
  /** After the purge: PRAGMA integrity_check passed and the search index is sound (searchIndexOk). */
  integrity?: boolean;
  /**
   * Files where another process's open read kept the old bytes (in the file or its
   * WAL) past the wait: "index" (index.db), "blob pack" (blobs/pack.db). They stay
   * until that process closes the file and purge runs again. Absent when none.
   */
  oldBytesKept?: ("index" | "blob pack")[];
  /** Kept copies of the index deleted (or that would be), as paths: see removeIndexCopies. Absent when none. */
  copiesRemoved?: string[];
  /** Kept copies of the index that could not be deleted, as paths. They may hold the values. Absent when none. */
  copiesKept?: string[];
}

/** A snapshot repo under repos/ that holds a value: purge names it and leaves it as it is. */
export interface SnapshotRepo {
  /** The repo's folder. Deleting it removes the snapshots of `root`; the next snapshot starts a new one. */
  path: string;
  /** The folder it snapshots, from its coding.sh-root file. Absent when unknown, or when the path itself holds a value. */
  root?: string;
  /** Git could not read it, so it may hold a value. */
  unreadable?: true;
}

/**
 * Deletes the copies of the index kept next to `dbPath` by a migration (`.v<N>.bak`) or by
 * `upgrade-store --restore` (`.v<N>.undone`); ./upgrade.ts listIndexCopies names them. A copy
 * holds every event as it was, the purged values included, and is at a schema this code may
 * not know how to rewrite, so it goes whole. A purge that kept one would report a clean store
 * with the value still on disk beside it, and `upgrade-store --restore` would bring it back.
 * A copy another process keeps open on Windows can't be deleted: it is reported, not skipped.
 */
export function removeIndexCopies(dbPath: string, dryRun = false): Pick<PurgeResult, "copiesRemoved" | "copiesKept"> {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const path of dbPath === ":memory:" ? [] : listIndexCopies(dbPath)) {
    try {
      if (!dryRun) rmSync(path, { force: true });
      removed.push(path);
    } catch {
      kept.push(path);
    }
  }
  const out: Pick<PurgeResult, "copiesRemoved" | "copiesKept"> = {};
  if (removed.length) out.copiesRemoved = removed;
  if (kept.length) out.copiesKept = kept;
  return out;
}

type Row = Record<string, unknown>;

/** The literal as it appears inside a JSON string. */
const jsonForm = (s: string): string => JSON.stringify(s).slice(1, -1);

/** `s`, then JSON-escaped once, twice, … `times` over: a JSON string inside a JSON string. */
function escapes(s: string, times: number): string[] {
  const out = [s];
  let cur = s;
  for (let i = 0; i < times; i++) out.push((cur = jsonForm(cur)));
  return [...new Set(out)];
}

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
  /** Each literal raw and escaped up to three times: a tool call's JSON arguments, in a reply, in a recording's JSON line. */
  private readonly deep: string[];

  constructor(literals: readonly string[]) {
    // Longest first, so a literal that contains another is replaced whole.
    this.lits = [...new Set(literals)].sort((a, b) => b.length - a.length);
    this.needles = [...new Set(this.lits.flatMap((l) => escapes(l, 1)))];
    this.deep = [...new Set(this.lits.flatMap((l) => escapes(l, 3)))];
  }

  /** Raw and JSON-escaped forms, for SQL instr() prefilters. */
  get searchNeedles(): readonly string[] {
    return this.needles;
  }

  hit(s: string | null | undefined): boolean {
    return typeof s === "string" && this.needles.some((n) => s.includes(n));
  }

  /**
   * Whether text, or bytes as UTF-8, hold a value: raw or JSON-escaped up to three times,
   * whatever precedes it. For data purge deletes or reports rather than rewrites, and to test
   * a rewrite before and after.
   */
  holds(data: string | Uint8Array): boolean {
    if (typeof data === "string") return this.deep.some((n) => data.includes(n));
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return this.deep.some((n) => b.includes(n));
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

  /** Byte-level replace for blobs (any encoding of the literal as UTF-8), raw and JSON-escaped up to `depth` times. */
  bytes(buf: Uint8Array, depth = 1): Uint8Array | undefined {
    const text = Buffer.from(buf).toString("latin1");
    let out = text;
    for (const l of this.lits) {
      for (const form of escapes(l, depth)) {
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

// ---- the llm cache: one gzipped JSONL file per case-trial, a line per recorded call (src/llmcache/store.ts).

/** A gzip file's content: "big" past MAX_FILE_BYTES, undefined when it is not gzip. `partial` keeps what a torn file holds. */
function gunzipped(buf: Buffer, partial = false): Buffer | "big" | undefined {
  try {
    return gunzipSync(buf, { maxOutputLength: MAX_FILE_BYTES, ...(partial ? { finishFlush: zlibConstants.Z_SYNC_FLUSH } : {}) });
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "big" : undefined;
  }
}

/**
 * One recorded call without the values; undefined when nothing changed. The replay key, a hash
 * of the request, is kept, so the recording still replays. A body stored as base64 (bytes that
 * are not UTF-8) that holds a value is emptied, as the proxy empties one that echoes a credential.
 */
function scrubEntry(e: Record<string, unknown>, scrub: Scrubber): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let body = false;
  let other = false;
  for (const [k, v] of Object.entries(e)) {
    let next = v;
    if (k === "body" && typeof v === "string") {
      if (e.bodyEncoding === "base64") next = scrub.holds(Buffer.from(v, "base64")) ? "" : v;
      else {
        // Up to twice escaped: a string in a tool call's JSON arguments, which the reply holds as a JSON string.
        const clean = scrub.bytes(Buffer.from(v, "utf8"), 2);
        if (clean) next = Buffer.from(clean).toString("utf8");
      }
      body = next !== v;
    } else if (k !== "key") {
      next = scrub.value(v);
      other ||= JSON.stringify(next) !== JSON.stringify(v);
    }
    const name = scrub.text(k);
    other ||= name !== k;
    Object.defineProperty(out, name, { value: next, enumerable: true, writable: true, configurable: true });
  }
  if (!body && !other) return undefined;
  if (body) {
    if (out.body === "") delete out.bodyEncoding;
    out.redacted = true;
  }
  return out;
}

/**
 * A recording's text without the values, line by line; undefined when nothing changed. A line
 * that is not JSON (a torn end, where replay stops) and holds a value becomes the marker, which
 * is not JSON either, so replay still stops there.
 */
function scrubRecording(text: string, scrub: Scrubber): string | undefined {
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!scrub.holds(line) && !line.includes('"bodyEncoding"')) return line;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      if (!scrub.holds(line)) return line;
      changed = true;
      return PURGE_MARKER;
    }
    let next: string | undefined;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const e = scrubEntry(v as Record<string, unknown>, scrub);
      if (e) next = JSON.stringify(e);
    } else {
      const s = JSON.stringify(scrub.value(v));
      if (s !== JSON.stringify(v)) next = s;
    }
    if (next === undefined) return line;
    changed = true;
    return next;
  });
  return changed ? lines.join("\n") : undefined;
}

/** Replaces a file whole (a temp file, then a rename), keeping its mode and times. */
function replaceFile(file: string, data: Uint8Array, st: Stats): void {
  const tmp = `${file}.purge-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: st.mode & 0o777 });
    utimesSync(tmp, st.atimeMs / 1000, st.mtimeMs / 1000);
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the error that matters is the first one
    }
    throw e;
  }
}

/**
 * Rewrites the recordings under `dir` that hold a value, keeping each file's times (gc drops the
 * least recently used first). A file there that no replay reads (a recording cut short, the temp
 * file of a run that stopped before its rename) is deleted when it holds one. Returns how many
 * files it left unread for their size.
 */
function purgeLlmCache(dir: string | undefined, scrub: Scrubber, dry: boolean, result: PurgeResult): number {
  if (!dir || !existsSync(dir)) return 0;
  let skipped = 0;
  let deleted = 0;
  const kept: string[] = [];
  for (const f of filesUnder(dir)) {
    const st = statSync(f);
    if (st.size > MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    if (!st.size) continue;
    const buf = readFileSync(f);
    const whole = f.endsWith(".jsonl.gz") ? gunzipped(buf) : undefined;
    if (whole instanceof Buffer) {
      const clean = scrubRecording(whole.toString("utf8"), scrub);
      if (clean === undefined) continue;
      if (!dry) {
        try {
          replaceFile(f, gzipSync(Buffer.from(clean, "utf8")), st);
        } catch {
          kept.push(f);
          continue;
        }
      }
      result.recordings++;
      continue;
    }
    const part = whole ?? gunzipped(buf, true);
    if (part === "big") {
      skipped++;
      continue;
    }
    const text = (part ?? buf).toString("utf8");
    if (!scrub.holds(text) && scrubRecording(text, scrub) === undefined) continue;
    if (!dry) {
      try {
        rmSync(f, { force: true });
      } catch {
        kept.push(f);
        continue;
      }
    }
    deleted++;
  }
  if (deleted) result.recordingsDeleted = deleted;
  if (kept.length) result.recordingsKept = kept;
  return skipped;
}

// ---- snapshot repos (repos/): read, never written; see the top of this file.

/** The snapshot repos under `dir`: bare git repos, one per folder snapshotted. */
function snapshotRepoDirs(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "HEAD")))
    .map((e) => join(dir, e.name));
}

/** A loose git object's content (zlib of "<type> <size>\0<content>"): "big" past MAX_FILE_BYTES, undefined when it is not zlib. */
function looseObject(buf: Buffer): Buffer | "big" | undefined {
  try {
    const raw = inflateSync(buf, { maxOutputLength: MAX_FILE_BYTES + 64, finishFlush: zlibConstants.Z_SYNC_FLUSH });
    return raw.subarray(raw.indexOf(0) + 1);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "big" : undefined;
  }
}

/**
 * Reads `git cat-file --batch` output ("<oid> <type> <size>\n<content>\n" per object, or
 * "<oid> missing\n"): calls `visit` with each object's content, and `skip` for one over
 * MAX_FILE_BYTES, which it does not keep. Returns false, which stops git, once visit returns true.
 */
function catFileParser(visit: (buf: Buffer) => boolean, skip: () => void): (chunk: Buffer) => boolean {
  let pending: Buffer = Buffer.alloc(0);
  let need = -1; // bytes left of the current object and its newline; -1 while reading a header
  let keep: Buffer[] | undefined;
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length) {
      if (need < 0) {
        const nl = pending.indexOf(10);
        if (nl < 0) return true;
        const head = pending.subarray(0, nl).toString("latin1").split(" ");
        pending = pending.subarray(nl + 1);
        const size = Number(head[2]);
        if (head.length < 3 || !Number.isSafeInteger(size) || size < 0) continue; // "<oid> missing"
        need = size + 1;
        if (size > MAX_FILE_BYTES) {
          skip();
          keep = undefined;
        } else keep = [];
        continue;
      }
      const take = Math.min(need, pending.length);
      keep?.push(pending.subarray(0, take));
      pending = pending.subarray(take);
      need -= take;
      if (need === 0) {
        need = -1;
        const content = keep && Buffer.concat(keep);
        keep = undefined;
        if (content && visit(content.subarray(0, -1))) return false;
      }
    }
    return true;
  };
}

/** Calls `visit` with each object of a pack, read through git (a pack stores deltas), until it returns true. */
async function packObjects(repo: string, idx: string, visit: (buf: Buffer) => boolean, skip: () => void): Promise<boolean> {
  const env = { GIT_DIR: repo };
  const listed = await runGit(["show-index"], { cwd: repo, env, input: readFileSync(idx) });
  const oids = listed.stdout
    .split("\n")
    .map((l) => l.split(" ")[1] ?? "")
    .filter((oid) => /^[0-9a-f]{40,64}$/.test(oid));
  if (!oids.length) return false;
  let hit = false;
  let error: unknown;
  const parse = catFileParser((b) => {
    try {
      return (hit = visit(b));
    } catch (e) {
      error = e;
      return true;
    }
  }, skip);
  await runGit(["cat-file", "--batch"], { cwd: repo, env, input: oids.join("\n") + "\n", timeoutMs: 10 * 60_000, onStdout: parse });
  if (error) throw error;
  return hit;
}

/**
 * Calls `visit` with what a snapshot repo stores itself, until it returns true: each object
 * (loose ones inflated here, packed ones read through git) and its other files as they are.
 * The user's own objects, which it reads through alternates, are not visited.
 */
async function repoObjects(repo: string, visit: (buf: Buffer) => boolean, skip: () => void): Promise<boolean> {
  const packs: string[] = [];
  for (const f of filesUnder(repo)) {
    const [top, sub] = relative(repo, f).split(sep);
    if (top === "objects" && sub === "pack") {
      if (f.endsWith(".idx")) packs.push(f);
      continue;
    }
    const size = statSync(f).size;
    if (size > MAX_FILE_BYTES) {
      skip();
      continue;
    }
    if (!size) continue;
    const buf = readFileSync(f);
    const obj = top === "objects" && sub !== "info" ? looseObject(buf) : undefined;
    if (obj === "big") {
      skip();
      continue;
    }
    if (visit(obj ?? buf)) return true;
  }
  for (const idx of packs) if (await packObjects(repo, idx, visit, skip)) return true;
  return false;
}

/** The snapshot repos under `dir` that hold a value, or that could not be read, by path. */
async function snapshotReposHolding(dir: string | undefined, scrub: Scrubber, skip: () => void): Promise<SnapshotRepo[]> {
  const out: SnapshotRepo[] = [];
  for (const path of snapshotRepoDirs(dir)) {
    let unreadable = false;
    try {
      if (!(await repoObjects(path, (b) => scrub.holds(b), skip))) continue;
    } catch {
      unreadable = true;
    }
    let root: string | undefined;
    try {
      root = readFileSync(join(path, "coding.sh-root"), "utf8").trim() || undefined;
    } catch {
      // a repo from `eval import` keeps no root
    }
    out.push({ path, ...(root && !scrub.holds(root) ? { root } : {}), ...(unreadable ? { unreadable: true as const } : {}) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** JSON-holding columns, by table; others are plain text. */
const OTHER_TABLES: { table: string; key: string; json: string[]; text: string[] }[] = [
  { table: "scores", key: "id", json: [], text: ["comment", "string_value"] },
  { table: "score_configs", key: "id", json: ["doc"], text: [] },
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
  const result: PurgeResult = { events: 0, sessions: 0, otherRows: 0, blobs: 0, files: 0, recordings: 0, foldsDropped: 0 };
  let skipped = 0;
  // ---- snapshot repos, read before anything changes: named, never rewritten.
  const repos = await snapshotReposHolding(o.repos, scrub, () => skipped++);
  if (repos.length) result.snapshotRepos = repos;
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
      // Contentless FTS (sqlite.ts v10): a changed row's entry is dropped by rowid and its new search text indexed.
      const ftsDelete = db.prepare("DELETE FROM events_fts WHERE rowid = ?");
      const ftsInsert = db.prepare("INSERT INTO events_fts (rowid, text) VALUES (?, ?)");
      const reindex = (rid: number, kind: unknown, before: Record<string, unknown>, after: Record<string, unknown>) => {
        if (searchableText({ kind, payload: before } as AgentEvent) !== undefined) ftsDelete.run(rid);
        const text = searchableText({ kind, payload: after } as AgentEvent);
        if (text !== undefined) ftsInsert.run(rid, text);
      };
      // search_extra (a copy of tool text) is read by nothing since v10, so a changed row drops it.
      // events.error is a copy of payload.error (v11), so it is written again from the scrubbed payload.
      const update = db.prepare("UPDATE events SET payload = ?, cwd = ?, search_extra = NULL, error = ? WHERE rowid = ?");
      // ---- events: payload, plus cwd and search_extra in rows from before v10 that gc --compact has not emptied
      // yet, with the FTS row replaced.
      const cols = ["payload", "cwd", "search_extra"];
      const rows = db.prepare(`SELECT rowid AS rid, session_id, kind, payload, cwd FROM events WHERE ${instrAny(cols, needles)}`).all(...params(cols, needles)) as Row[];
      for (const r of rows) {
        result.events++;
        touchedSessions.add(String(r.session_id));
        if (dry) continue;
        const before = JSON.parse(String(r.payload)) as Record<string, unknown>;
        const payload = scrub.value(before) as Record<string, unknown>;
        update.run(JSON.stringify(payload), typeof r.cwd === "string" ? scrub.text(r.cwd) : null, errorText(payload), r.rid as number);
        reindex(r.rid as number, r.kind, before, payload);
      }
      // ---- cwds: one row per distinct path, shared by every event in it.
      for (const c of db.prepare(`SELECT id, path FROM cwds WHERE ${instrAny(["path"], needles)}`).all(...needles) as Row[]) {
        for (const r of db.prepare("SELECT session_id, count(*) AS n FROM events WHERE cwd_id = ? GROUP BY session_id").all(c.id as number) as Row[]) {
          result.events += Number(r.n);
          touchedSessions.add(String(r.session_id));
        }
        if (!dry) db.prepare("UPDATE cwds SET path = ? WHERE id = ?").run(scrub.text(String(c.path)), c.id as number);
      }

      // ---- refs to rewritten blobs: events.blobs, and ref-valued strings in payloads and eval docs.
      for (const [from, to] of repoint) {
        const swap = (v: unknown): unknown => (v === from ? to : Array.isArray(v) ? v.map(swap) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v);
        for (const r of db.prepare("SELECT rowid AS rid, session_id, kind, blobs, payload FROM events WHERE instr(blobs, ?) > 0 OR instr(payload, ?) > 0").all(from, from) as Row[]) {
          touchedSessions.add(String(r.session_id));
          const before = JSON.parse(String(r.payload)) as Record<string, unknown>;
          const payload = swap(before) as Record<string, unknown>;
          db.prepare("UPDATE events SET blobs = ?, payload = ?, error = ? WHERE rowid = ?").run(
            typeof r.blobs === "string" ? JSON.stringify(swap(JSON.parse(r.blobs))) : null,
            JSON.stringify(payload),
            errorText(payload),
            r.rid as number,
          );
          reindex(r.rid as number, r.kind, before, payload);
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
    skipped += raw.skipped;
    // ---- recordings of model calls (exp run --record or --replay).
    skipped += purgeLlmCache(o.llmCache, scrub, dry, result);
    if (skipped) result.filesSkipped = skipped;

    // ---- copies of the index kept by an upgrade or a restore: deleted whole, whatever the rows above held.
    Object.assign(result, removeIndexCopies(o.dbPath, dry));

    if (!dry) {
      // Merge FTS segments (dropping deleted tokens), then rewrite the file so freed pages keep nothing.
      // A checkpoint that a reader in another process keeps busy says so in its result row; it does not throw.
      const truncate = () => (db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined)?.busy === 0;
      db.exec("INSERT INTO events_fts(events_fts) VALUES ('optimize')");
      if (o.waitMs !== undefined) db.exec(`PRAGMA busy_timeout = ${o.waitMs}`);
      truncate();
      db.exec("VACUUM");
      db.exec(`PRAGMA busy_timeout = ${o.waitMs ?? 5000}`); // how long the checkpoint waits for readers
      const kept: ("index" | "blob pack")[] = [];
      if (!truncate()) kept.push("index");
      // The file store's pack keeps deleted rows' bytes in free pages and its WAL until it is rewritten.
      const pack = await (o.blobs as BlobStore & { compact?: (opts?: { waitMs?: number }) => Promise<{ readerHeld?: boolean }> }).compact?.({ waitMs: o.waitMs });
      if (pack?.readerHeld) kept.push("blob pack");
      if (kept.length) result.oldBytesKept = kept;
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
  llmCache?: string;
  repos?: string;
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
 * Every distinct value the rules match where a purge writes or looks: event payloads, session
 * columns, the other tables, kv rows, blobs, raw files, recordings of model calls and the
 * objects of snapshot repos. JSON columns and recorded calls are matched on their decoded
 * strings (a base64 body on its bytes as UTF-8), blobs, raw files and snapshot objects on
 * their bytes as UTF-8. A snapshot repo git can't read is passed over: the purge names it.
 * Read-only.
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
    for (const r of db.prepare("SELECT payload, cwd, search_extra FROM events").iterate() as Iterable<Row>) scanJson(r.payload), text(r.cwd), text(r.search_extra);
    for (const r of db.prepare("SELECT path FROM cwds").iterate() as Iterable<Row>) text(r.path);
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
  // A recording line by line: every string of the call but its replay key (a hash).
  const recording = (s: string): void => {
    for (const line of s.split("\n")) {
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        scan(line);
        continue;
      }
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        eachString(v, scan);
        continue;
      }
      const e = v as Record<string, unknown>;
      for (const [k, x] of Object.entries(e)) {
        if (k === "key") continue;
        scan(k);
        if (k === "body" && typeof x === "string" && e.bodyEncoding === "base64") scan(Buffer.from(x, "base64").toString("utf8"));
        else eachString(x, scan);
      }
    }
  };
  for (const f of o.llmCache && existsSync(o.llmCache) ? filesUnder(o.llmCache) : []) {
    const size = statSync(f).size;
    if (!size || size > MAX_FILE_BYTES) continue;
    const buf = readFileSync(f);
    const content = gunzipped(buf, true);
    if (content !== "big") recording((content ?? buf).toString("utf8"));
  }
  for (const repo of snapshotRepoDirs(o.repos)) {
    await repoObjects(repo, (b) => (scan(b.toString("utf8")), false), () => {}).catch((e: unknown) => {
      if (e instanceof RuleTooBroad) throw e;
    });
  }
  return { values: [...values], short: short.size };
}
