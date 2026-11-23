// Re-parse: sessions stored by an older adapter parse get their rows rebuilt
// from the source they came from, so an upgrade fixes data already captured.
//
// Each adapter has a parse version (Adapter.parseVersion, default 1), bumped
// when a change alters the rows it stores for the same input. Ingest stamps a
// new session with it, and a session keeps the version it was created with as
// later events arrive (Session.parseVersion). A session whose version is older
// than its adapter's is stale.
//
// A session's rows come from up to three places, each rebuilt only when its
// source still exists, and never added where the session had none:
// - backfill rows (source transcript/backfill/store): re-read from the agent's
//   transcript, rollout or database (adapter.backfill over every file);
// - hook rows (source hook/wrapper, or one the spool's normalize gives):
//   re-normalized from the spool lines still on disk (gc keeps them
//   retention.keepSpoolDays, 7 by default), when those lines span the stored
//   hook rows' whole time range and every transcript they read rows from can
//   still be read (NormalizeContext.missing: a Stop line's model calls come
//   from the transcript it names, and an eval run's is deleted with its home);
// - anything else (OTel, SDK batches, gateway companions): kept as is.
// The two capture paths are then deduped as ingest does (message-copies.ts:
// live wins), and also by tool call id, which matches a transcript row to a
// hook row the old parse gave another id. A hook row's model call that the
// transcript has too takes the transcript copy's timing: the hook read only
// part of the same file. Where nothing could be re-read, the
// stored rows are only deduped that way ("hook-row dedupe") and the session is
// kept at its old version; why is stored under kv `reparse:kept:<id>`.
//
// Copies: an adapter's backfill reports a file it skips because it copies
// another session's (BackfillOpts.copied; Claude Code: a subagent transcript
// copied into another session's dir). A session stored from such a copy by an
// older parse, with only backfill rows and its owner in the index, is deleted
// (IndexStore.deleteSessions) rather than kept as "its transcript is gone".
//
// Readers never wait and never see a half-rebuilt session: transcripts and
// spool are read with no lock held, and each session is swapped in one
// transaction (IndexStore.replaceSessionEvents) under the ingest lock, held
// for at most LOCK_HOLD_MS at a time. Between holds, when a hook or a read
// left the ingest wake marker, the spool is ingested (onWake), so captures
// keep landing during a long re-parse and a read never waits for it. Blob
// puts go through a write-behind batch, flushed before any row is written.
// One re-parse runs at a time (`<data>/reparse.lock`); it is incremental: a
// session is stamped with the new version as it is rebuilt, so a re-parse
// cut short resumes with the sessions still stale. Memory is bounded: only
// stale sessions' events are buffered, flushed between transcript files once
// FLUSH_EVENTS pile up; a session whose transcript spans files flushed apart
// is rebuilt by the first flush and topped up by the later ones.
//
// Automatic runs (`ingest --background`, which reads and the viewer start when
// due) do the stale sessions once per set of adapter versions: a stamp of the
// versions is kept under the cursor REPARSE_CURSOR. `ingest --rebuild` does
// every session (optionally of some agents) now.
//
// Host links: a host adapter (T3 Code) links another agent's session to the
// host's thread by rows of its own (a host-link notification) in a session the
// other agent's adapter may have stored first. A session stored before those
// rows (an older import cut them off, and the host's file was then recorded as
// read) is the other agent's, so no host parse bump makes it stale. When a
// host's parse version differs from the one under relinkCursor (once on a store
// an older build stamped, never on a new one), and on `ingest --rebuild`, the
// re-parse reads the host's store and adds its rows to every stored session it
// links that is not the host's yet ("relinked"), as a fresh import would.
//
// Refold: when the fold stamp changes (core/sessions.ts foldStamp: the
// SESSION_FOLD_VERSION of how stats and flags are derived from stored events,
// and the shape of the fold state), an automatic run then folds every other
// session again from its stored rows, with no source re-read, under the same
// short lock holds. Its progress is kept (REFOLD_AFTER), so a cut-short pass
// resumes; the stamp it finished is kept under REFOLD_CURSOR, so a store last
// folded by another build is folded again once.
//
// Repricing: when the price table changed since stored costs were estimated
// (core/reprice.ts), a run reprices them, so opening the index does not wait
// for it (store/factory.ts). A session the run folds (a target, a session a
// host links, or a refolded session) has its events repriced right before that fold, in the
// same lock hold, so it is folded once; the other sessions get the pass, which
// refreshes the totals of those that changed, at the end of the run. The cursor
// is set only when every session was repriced, so a cut-short run does it again.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEvent, Session } from "../schema/index.ts";
import type { Adapter, BackfillFile, BlobStore, Config, IndexStore } from "./types.ts";
import { sha256Hex } from "./ids.ts";
import { acquireLock, wakeMarker, type Lock, type LockOptions } from "./lock.ts";
import { paths } from "./paths.ts";
import { pricesFor } from "./pricing.ts";
import { priceStamp, refreshTotals, REPRICE_CURSOR, repriceEvents, repricePending, repriceStored } from "./reprice.ts";
import { foldStamp, isBackfillEvent } from "./sessions.ts";
import { COPY_SLACK_MS, copyFilter, messageKey } from "./message-copies.ts";
import { listSpoolFiles, readSpoolFile } from "./spool-read.ts";
import { repoResolver } from "./repo-state.ts";
import { isWrapperLine } from "../adapters/more/wrapper.ts";
import { T3_AGENT } from "../spool/host.ts";
export { REFOLD_CURSOR } from "./ingest.ts";
import {
  backfillEvent,
  childLinker,
  childLinkKey,
  foldFailureMessage,
  normalizeContext,
  parseVersionFor,
  profileCache,
  recomputeSession,
  REFOLD_CURSOR,
  spoolNormalizer,
  toolDurationFiller,
  type FoldFailure,
  type IngestError,
} from "./ingest.ts";

/** Cursor holding the stamp of the adapter versions the last automatic re-parse covered. */
export const REPARSE_CURSOR = "reparse:stamp";
/** kv: why a session was kept at its old parse version. */
export const reparseKeptKey = (sessionId: string): string => `reparse:kept:${sessionId}`;
/** Cursor holding the parse version of a host adapter whose store the last re-parse linked stored sessions from. */
export const relinkCursor = (host: string): string => `reparse:relink:${host}`;
/** kv: JSON summary of the last re-parse (when, counts, first errors). */
export const REPARSE_LAST = "reparse:last";
/** kv: `{ v, id }` of an unfinished refold: sessions up to id (in id order) are done. */
const REFOLD_AFTER = "reparse:fold-after";
/** Refolded sessions between progress saves. */
const REFOLD_SAVE_EVERY = 100;

/** Buffered transcript events that trigger a flush at the next file boundary. */
const FLUSH_EVENTS = 20_000;
/** Longest ingest-lock hold while sessions are written (at least one session per hold). */
const LOCK_HOLD_MS = 1_000;
/** Slack when checking that spool lines span the stored hook rows. */
const SPAN_SLACK_MS = 60_000;
const MAX_ERRORS = 100;
/** Host adapters: their rows in another agent's session give it to the host (spool/host.ts). */
const HOSTS = [T3_AGENT];
/**
 * Adapters whose source files are named by the session they hold (Claude Code: `<id>.jsonl` or
 * `<id>/subagents/...`; Codex: `rollout-<time>-<id>.jsonl`). A re-parse reads only the files whose
 * path names a session it rebuilds; the others are skipped unread, so the cost follows the sessions
 * to rebuild and not the size of the agent's whole history (tens of thousands of transcripts).
 */
const PATH_KEYED = new Set(["claude-code", "codex"]);
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Longest session id matched as plain text in a path (a longer one is another adapter's, such as a T3 thread id). */
const MAX_PLAIN_KEY = 80;

/** A test for whether a source file's path names one of these sessions (a child session is named by its parent's id). */
export function pathNamesSession(sessionIds: Iterable<string>): (path: string) => boolean {
  const uuids = new Set<string>();
  const plain: string[] = [];
  for (const id of sessionIds) {
    const root = id.split(":sub:")[0]!.toLowerCase();
    if (UUID_ONLY.test(root)) uuids.add(root);
    else if (root.length <= MAX_PLAIN_KEY) plain.push(root);
  }
  return (path) => {
    const lower = path.toLowerCase();
    for (const m of lower.matchAll(UUID_G)) if (uuids.has(m[0])) return true;
    return plain.some((k) => lower.includes(k));
  };
}
/** Capture-path sources ingest gives hook and wrapper lines. Rows with no source predate the field (hooks only). */
const SPOOL_SOURCES = new Set(["hook", "wrapper"]);

/** Positive int that changes whenever any adapter's parse version does. */
export function parseStamp(adapters: ReadonlyMap<string, Adapter>): number {
  const pairs = [...adapters.values()].map((a) => `${a.id}:${a.parseVersion ?? 1}`).sort();
  return parseInt(sha256Hex(pairs.join("\n")).slice(0, 12), 16) || 1;
}

export interface ReparseProgress {
  phase: "spool" | "transcripts" | "sessions" | "refold" | "reprice";
  /** Agent whose transcripts are being read (phase "transcripts"). */
  agent?: string;
  /**
   * Sessions done so far, of `total` (phase "refold": sessions refolded, of those to refold;
   * phase "reprice": sessions the repricing pass at the end looked at, of those the run did not reprice before).
   */
  done: number;
  total: number;
}

export interface ReparseOptions {
  config: Config;
  index: IndexStore;
  blobs: BlobStore;
  adapters: Map<string, Adapter>;
  env?: NodeJS.ProcessEnv;
  /** Spool directory (default paths(env).spool). */
  spoolDir?: string;
  /** Every session (`ingest --rebuild`), not only those stored by an older parse. */
  all?: boolean;
  /** Only sessions of these agents (the session's agent or the agent a host ran). */
  agents?: string[];
  onProgress?: (p: ReparseProgress) => void;
  /** One re-parse at a time (default paths(env).reparseLock, no wait: busy throws LockBusyError). false = none. */
  runLock?: false | (LockOptions & { path?: string });
  /** Held while sessions are written (default `<spoolDir>/.ingest.lock` when the spool dir exists, wait 30 s). false = none. */
  ingestLock?: false | (LockOptions & { path?: string });
  /** Run between ingest-lock holds while the lock's wake marker is set (a hook or a read has spool lines waiting): an ingest. */
  onWake?: () => Promise<void>;
  now?: () => number;
}

export interface KeptSession {
  id: string;
  agent: string;
  reason: string;
}

export interface ReparseResult {
  /** Sessions looked at. */
  sessions: number;
  /** Rebuilt from their transcript or spool (all of it that still exists). */
  reparsed: number;
  /** Kept at their old version: nothing to re-read them from. Stored rows still deduped. */
  kept: number;
  keptSessions: KeptSession[];
  /** Deleted: the adapter now reports them as copies of another stored session. */
  copiesRemoved: number;
  /** Sessions of another agent that a host's store links, given the host's rows they lacked (its link). */
  relinked: number;
  /** Rows deleted and inserted. */
  removed: number;
  inserted: number;
  /** Sessions folded again from their stored rows because the fold stamp changed. */
  refolded: number;
  errors: IngestError[];
}

const versionOf = (adapters: ReadonlyMap<string, Adapter>, agent: string) => parseVersionFor(adapters, agent);

/** Sessions stored by an older parse than their adapter's (unset = not adapter-made, never stale). */
async function staleSessions(index: IndexStore, adapters: ReadonlyMap<string, Adapter>) {
  return (await index.listSessions({})).filter((s) => {
    const v = versionOf(adapters, s.agent);
    // 0: created by the proxy and not parsed by an adapter yet (ingest stamps it).
    return v !== undefined && s.parseVersion !== undefined && s.parseVersion !== 0 && s.parseVersion < v;
  });
}

/** Host adapters whose parse version is not the one the last re-parse linked stored sessions with. */
async function hostsBehind(index: IndexStore, adapters: ReadonlyMap<string, Adapter>): Promise<Adapter[]> {
  const out: Adapter[] = [];
  for (const id of HOSTS) {
    const a = adapters.get(id);
    if (a?.backfill && (await index.getCursor(relinkCursor(id))) !== (a.parseVersion ?? 1)) out.push(a);
  }
  return out;
}

/**
 * True when stale sessions wait for an automatic re-parse, stored sessions for
 * a refold, a host's changed parse for a pass over its links, or stored costs
 * for the repricing an open of this index left to the run (store/factory.ts).
 * A few cursor reads while the adapter versions match the last run's stamp and
 * the fold version its refold; otherwise a scan of the session rows, and the
 * stamp is set right away when none is stale.
 */
export async function reparseDue(index: IndexStore, adapters: ReadonlyMap<string, Adapter>): Promise<boolean> {
  if (!index.replaceSessionEvents) return false;
  if (await repricePending(index)) return true;
  if ((await index.getCursor(REFOLD_CURSOR)) !== foldStamp()) {
    if ((await index.listSessions({ limit: 1 })).length) return true;
    await index.setCursor(REFOLD_CURSOR, foldStamp());
  }
  const stamp = parseStamp(adapters);
  const last = await index.getCursor(REPARSE_CURSOR);
  const behind = await hostsBehind(index, adapters);
  if (behind.length) {
    // A store no re-parse has stamped yet was imported by these hosts' parse: nothing in it predates their links.
    if (last !== 0 && (await index.listSessions({ limit: 1 })).length) return true;
    for (const a of behind) await index.setCursor(relinkCursor(a.id), a.parseVersion ?? 1);
  }
  if (last === stamp) return false;
  if ((await staleSessions(index, adapters)).length) return true;
  await index.setCursor(REPARSE_CURSOR, stamp);
  return false;
}

/** Natural key of one tool call's row, shared by its hook and transcript copies whatever ids the parse gave them. */
function callKey(e: AgentEvent): string | undefined {
  const id = e.payload.toolUseId;
  if (typeof id !== "string" || !id) return undefined;
  if (e.kind === "tool.start" || e.kind === "tool.end" || e.kind === "test.result") return `${e.kind}\u0000${id}`;
  if (e.kind === "file.change" && typeof e.payload.path === "string") return `${e.kind}\u0000${id}\u0000${e.payload.path}`;
  return undefined;
}

/** JSON with sorted keys and no undefined fields: equal for a row and its stored copy. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

/** A read-only index over one session's rows, for the copy filter and duration filler. */
function viewOf(rows: AgentEvent[]): IndexStore {
  const sorted = rows.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);
  const listEvents = async (sessionId: string, o: { kinds?: string[] } = {}) => sorted.filter((e) => e.sessionId === sessionId && (!o.kinds?.length || o.kinds.includes(e.kind)));
  return { listEvents } as unknown as IndexStore;
}

/**
 * A hook row's llm.call with the timing of the transcript's copy (same id):
 * ts, durationMs, payload.ttftMs and payload.tokensPerSec, each set or absent
 * as the copy has it. The hook read the call from a window of the same
 * transcript; the backfill read all of it, so it knows the call's start
 * whenever any read does (an older parse may have timed it from a line
 * written mid-response).
 */
function withCallTiming(row: AgentEvent, copy: AgentEvent): AgentEvent {
  const { ttftMs: _t, tokensPerSec: _s, ...payload } = row.payload;
  const out: AgentEvent = { ...row, ts: copy.ts, payload: { ...payload, ...pick(copy.payload, ["ttftMs", "tokensPerSec"]) } };
  if (copy.durationMs !== undefined) out.durationMs = copy.durationMs;
  else delete out.durationMs;
  return out;
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Hook rows (`spoolSources`) whose model call the transcript has too, with the transcript copy's timing (withCallTiming). */
function withTranscriptTiming(live: AgentEvent[], transcript: AgentEvent[], spoolSources: ReadonlySet<string>): AgentEvent[] {
  const copies = new Map(transcript.filter((e) => e.kind === "llm.call").map((e) => [e.id, e]));
  if (!copies.size) return live;
  return live.map((e) => {
    const copy = e.kind === "llm.call" && (e.source === undefined || spoolSources.has(e.source)) ? copies.get(e.id) : undefined;
    return copy ? withCallTiming(e, copy) : e;
  });
}

/**
 * Drops live rows that repeat an earlier live row (same tool call; same prompt
 * or reply within COPY_SLACK_MS), then backfill rows a live row already has
 * (ingest's copy filter, tool call ids). Live wins, as at ingest.
 */
async function dedupe(live: AgentEvent[], backfill: AgentEvent[]): Promise<AgentEvent[]> {
  const keptLive: AgentEvent[] = [];
  const calls = new Set<string>();
  const messages = new Map<string, number[]>();
  const ids = new Set<string>();
  for (const e of [...live].sort((a, b) => a.ts - b.ts)) {
    if (ids.has(e.id)) continue;
    const call = callKey(e);
    if (call !== undefined && calls.has(call)) continue;
    const msg = messageKey(e);
    if (msg !== undefined && messages.get(msg)?.some((t) => Math.abs(t - e.ts) <= COPY_SLACK_MS)) continue;
    ids.add(e.id);
    if (call !== undefined) calls.add(call);
    if (msg !== undefined) messages.set(msg, [...(messages.get(msg) ?? []), e.ts]);
    keptLive.push(e);
  }
  const copies = copyFilter(viewOf(keptLive));
  const out = keptLive;
  for (const e of backfill) {
    if (ids.has(e.id)) continue;
    const call = callKey(e);
    if (call !== undefined && calls.has(call)) continue;
    if (await copies.isCopy(e)) continue;
    ids.add(e.id);
    out.push(e);
  }
  return out;
}

/** Re-parses stale sessions (or every session with `all`) from their transcripts and spool. */
/**
 * A re-derived row keeps the redaction counts its stored row has. After ingest the spool line
 * and its side file hold markers in place of the secrets (core/spool-scrub.ts), so a re-parse
 * finds only markers it can't count: without this the session would lose its Redacted row and
 * its secret-exposed flag.
 */
export function keepRedactionCounts(was: AgentEvent, fresh: AgentEvent): AgentEvent {
  const counted = was.payload?.redactions;
  if (!counted || typeof counted !== "object" || !Object.keys(counted).length) return fresh;
  const now = fresh.payload?.redactions;
  if (now && typeof now === "object" && Object.keys(now).length) return fresh;
  return { ...fresh, payload: { ...fresh.payload, redactions: counted } };
}

export async function reparse(opts: ReparseOptions): Promise<ReparseResult> {
  const { config, index, blobs, adapters } = opts;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const spoolDir = opts.spoolDir ?? paths(env).spool;
  const result: ReparseResult = { sessions: 0, reparsed: 0, kept: 0, keptSessions: [], copiesRemoved: 0, relinked: 0, removed: 0, inserted: 0, refolded: 0, errors: [] };
  const error = (e: IngestError) => {
    if (result.errors.length < MAX_ERRORS) result.errors.push(e);
  };
  if (!index.replaceSessionEvents) {
    error({ message: `the ${index.kind} index store can't replace a session's events; sessions were not re-parsed` });
    return result;
  }

  let runLock: Lock | undefined;
  if (opts.runLock !== false) {
    const lo = opts.runLock ?? {};
    const path = lo.path ?? paths(env).reparseLock;
    mkdirSync(dirname(path), { recursive: true });
    runLock = await acquireLock(path, { waitMs: 0, ...lo });
  }
  try {
    await run();
  } finally {
    runLock?.release();
  }
  return result;

  async function run(): Promise<void> {
    const stamp = parseStamp(adapters);
    const wanted = opts.agents?.length ? new Set(opts.agents) : undefined;
    // The parsers are the ones the last finished run used: what is still stale is what it kept (no source left), so only refold.
    const sameParsers = !opts.all && !wanted && (await index.getCursor(REPARSE_CURSOR)) === stamp;
    const targets = (opts.all ? await index.listSessions({}) : sameParsers ? [] : await staleSessions(index, adapters)).filter(
      (s) => versionOf(adapters, s.agent) !== undefined && (!wanted || wanted.has(s.agent) || (s.provider !== undefined && wanted.has(s.provider))),
    );
    result.sessions = targets.length;
    const done = new Set<string>();
    const failed = new Set<string>();
    const progress = (p: Omit<ReparseProgress, "done" | "total">) => opts.onProgress?.({ ...p, done: done.size + failed.size, total: targets.length });

    // Repricing (see the top of this file): due while the cursor holds another price table's stamp.
    const prices = pricesFor(config.pricing);
    const repricing = !!index.setEventCosts && (await index.getCursor(REPRICE_CURSOR)) !== priceStamp(prices);
    const targetRows = new Map(repricing ? targets.map((s) => [s.id, s]) : []);
    /** Sessions this run repriced, each right before its fold. */
    const repriced = new Set<string>();
    /** Of those, the ones whose costs changed and whose fold was not written yet. */
    const owed = new Set<string>();
    let repriceFailed = false;
    const reprice = async (s: Session | undefined): Promise<void> => {
      if (!repricing || !s || repriced.has(s.id)) return;
      repriced.add(s.id);
      try {
        if (await repriceEvents(index, s, prices)) owed.add(s.id);
      } catch (err) {
        repriceFailed = true;
        error({ message: `repricing the cost estimates of session ${s.id} failed: ${(err as Error).message}` });
      }
    };

    // Which sources to read: the adapters that made each target's backfill and hook rows.
    const agents = new Map(targets.map((s) => [s.id, s.agent]));
    const transcriptAdapters = new Set<string>();
    const spoolAdapters = new Set<string>();
    const fromTranscript = new Set<string>();
    for (const s of targets) {
      for (const e of await index.listEvents(s.id)) {
        const a = adapters.get(e.agent) ?? adapters.get("wrapper");
        if (!a) continue;
        if (isBackfillEvent(e)) {
          if (a.backfill) transcriptAdapters.add(a.id);
          fromTranscript.add(s.id);
        } else spoolAdapters.add(a.id);
      }
    }

    // Blob puts write behind (most are hits: the content is already stored); flushed before any row is written.
    const blobBatch = blobs.batch?.();
    const blobStore = blobBatch ?? blobs;

    // Hook rows: every spool line still on disk, re-normalized.
    const profileFor = profileCache(config, env, error);
    const spoolEvents = new Map<string, AgentEvent[]>();
    const spoolSources = new Set(SPOOL_SOURCES);
    // Sessions a line read rows for from a transcript that can't be read again: those rows can't be rebuilt.
    const unreadable = new Set<string>();
    if (spoolAdapters.size && existsSync(spoolDir)) {
      progress({ phase: "spool" });
      const normalize = spoolNormalizer({ adapters, blobs: blobStore, env, profileFor, error, excluded: () => {}, missing: (_path, sessionId) => void unreadable.add(sessionId) });
      for (const file of await listSpoolFiles(spoolDir)) {
        for await (const rec of readSpoolFile(spoolDir, file.path, 0, { onError: () => {} })) {
          const a = adapters.get(rec.line.agent) ?? (isWrapperLine(rec.line) ? adapters.get("wrapper") : undefined);
          if (!a || !spoolAdapters.has(a.id)) continue;
          for (const e of await normalize(rec.line, rec.source, rec.offset)) {
            if (!agents.has(e.sessionId)) continue;
            if (e.source !== undefined) spoolSources.add(e.source);
            const list = spoolEvents.get(e.sessionId);
            if (list) list.push(e);
            else spoolEvents.set(e.sessionId, [e]);
          }
        }
      }
    }

    // Hosts whose store is read to link other agents' sessions: a changed parse, a rebuild, or read anyway.
    const relinkHosts = new Set<string>();
    const behind = new Set((await hostsBehind(index, adapters)).map((a) => a.id));
    for (const h of HOSTS) {
      if (!adapters.get(h)?.backfill || !(opts.all || behind.has(h) || transcriptAdapters.has(h))) continue;
      relinkHosts.add(h);
      transcriptAdapters.add(h);
    }
    /** Stored sessions, not targets, that a host's rows are added to: another agent's, not the host's yet. */
    const unlinked = new Map<string, boolean>();
    const isUnlinked = async (sid: string, host: string): Promise<boolean> => {
      let v = unlinked.get(sid);
      if (v === undefined) {
        const s = agents.has(sid) ? undefined : await index.getSession(sid);
        v = !!s && s.agent !== host && (!wanted || wanted.has(host) || wanted.has(s.agent));
        unlinked.set(sid, v);
      }
      return v;
    };
    const relinked = new Set<string>();
    const hostFailed = new Set<string>();

    const linker = childLinker(index);
    const repo = repoResolver();
    /** Targets the adapters' backfills skipped as copies: session id -> the owner's session id. */
    const copies = new Map<string, string>();
    // A fold that throws leaves the session a row tagged fold:error (recomputeSession); reported here.
    const onFoldError = (f: FoldFailure) => error({ message: foldFailureMessage(f) });

    /** Adds the transcript rows a stored session lacks (deduped as at ingest) and folds it again; the rows added. */
    const topUp = async (id: string, stored: AgentEvent[], transcript: AgentEvent[]): Promise<number> => {
      const add = await dedupe(stored.filter((e) => !isBackfillEvent(e)), [...stored.filter(isBackfillEvent), ...transcript]);
      const have = new Set(stored.map((e) => e.id));
      const fresh = add.filter((e) => !have.has(e.id));
      if (!fresh.length) return 0;
      const r = await index.replaceSessionEvents!(id, [], await toolDurationFiller(viewOf([...stored, ...fresh]))(fresh));
      result.inserted += r.inserted;
      if (await recomputeSession(index, id, { linker, repo, onFoldError })) owed.delete(id);
      return r.inserted;
    };

    /** Rebuilds one session: transcript events read for it (undefined = none found) and its re-normalized spool events. */
    const rebuild = async (id: string, transcript: AgentEvent[] | undefined): Promise<void> => {
      const agent = agents.get(id);
      // Repriced before its rows are read, so a fold below counts the new costs.
      if (repricing && !repriced.has(id)) await reprice(agent !== undefined ? targetRows.get(id) : await index.getSession(id));
      const stored = await index.listEvents(id);
      // Not a target: a session a host links, given the host's rows it lacks.
      if (agent === undefined) {
        if (await topUp(id, stored, transcript ?? [])) relinked.add(id);
        return;
      }
      const version = versionOf(adapters, agent)!;
      // More of a transcript flushed apart: top the rebuilt session up.
      if (done.has(id)) {
        await topUp(id, stored, transcript ?? []);
        return;
      }
      done.add(id);
      // A copy of another session's transcript, stored by an older parse: its owner holds the same rows.
      const owner = transcript === undefined ? copies.get(id) : undefined;
      if (owner && index.deleteSessions && stored.length && stored.every(isBackfillEvent) && (await index.getSession(owner))) {
        result.removed += (await index.deleteSessions([id])).events;
        result.copiesRemoved++;
        owed.delete(id);
        await index.kvSet?.(reparseKeptKey(id), undefined);
        await index.kvSet?.(childLinkKey(id), undefined);
        return;
      }
      const bfRows = stored.filter(isBackfillEvent);
      const spoolRows = stored.filter((e) => !isBackfillEvent(e) && (e.source === undefined || spoolSources.has(e.source)));
      const otherRows = stored.filter((e) => !isBackfillEvent(e) && !(e.source === undefined || spoolSources.has(e.source)));
      const spool = spoolEvents.get(id) ?? [];
      const span = (rows: AgentEvent[]) => [Math.min(...rows.map((e) => e.ts)), Math.max(...rows.map((e) => e.ts))] as const;
      const replaceBf = bfRows.length > 0 && transcript !== undefined && transcript.length > 0;
      let replaceSpool = false;
      if (spoolRows.length && spool.length && !unreadable.has(id)) {
        const [from, to] = span(spoolRows);
        const [sFrom, sTo] = span(spool);
        replaceSpool = sFrom <= from + SPAN_SLACK_MS && sTo >= to - SPAN_SLACK_MS;
      }
      const live = withTranscriptTiming([...otherRows, ...(replaceSpool ? spool : spoolRows)], transcript ?? [], spoolSources);
      const final = await dedupe(live, replaceBf ? transcript : bfRows);
      const old = new Set(stored);
      const keep = new Set(final.filter((e) => old.has(e)).map((e) => e.id));
      // A re-derived row identical to the stored one stays (a second run writes nothing).
      const byId = new Map(stored.map((e) => [e.id, e]));
      const write: AgentEvent[] = [];
      // A scrubbed spool line gives its event a new id (the id hashes the line): its stored row
      // is found by kind and time to carry the redaction counts over.
      const counted = new Map<string, AgentEvent>();
      for (const e of stored) if (e.payload?.redactions && Object.keys(e.payload.redactions).length) counted.set(`${e.kind}|${e.ts}`, e);
      for (const fresh of await toolDurationFiller(viewOf(final))(final.filter((e) => !old.has(e)))) {
        const was = byId.get(fresh.id);
        const prior = was ?? counted.get(`${fresh.kind}|${fresh.ts}`);
        const e = prior ? keepRedactionCounts(prior, fresh) : fresh;
        if (was && canonical(was) === canonical(e)) keep.add(e.id);
        else write.push(e);
      }
      const remove = [...byId.keys()].filter((x) => !keep.has(x));
      const reparsed = replaceBf || replaceSpool;
      if (remove.length || write.length) {
        const r = await index.replaceSessionEvents!(id, remove, write);
        result.removed += r.removed;
        result.inserted += r.inserted;
      }
      if (await recomputeSession(index, id, reparsed ? { linker, repo, parseVersion: version, onFoldError } : { linker, repo, onFoldError })) owed.delete(id);
      if (reparsed) {
        result.reparsed++;
        await index.kvSet?.(reparseKeptKey(id), undefined);
        return;
      }
      const why: string[] = [];
      if (bfRows.length) why.push("its transcript is gone");
      if (spoolRows.length && unreadable.has(id)) why.length || why.push("the transcript its hook lines read is gone, or has grown past their turns");
      else if (spoolRows.length) why.push(spool.length ? "the spool lines left don't cover its hook rows" : "its spool lines were removed by gc (retention.keepSpoolDays)");
      if (!why.length) why.push("its rows were not made by an adapter (OTel or SDK)");
      const deduped = stored.length - final.length;
      const reason = `${why.join("; ")}${deduped > 0 ? `; ${deduped} duplicate row${deduped === 1 ? "" : "s"} removed` : ""}`;
      result.kept++;
      result.keptSessions.push({ id, agent, reason });
      await index.kvSet?.(reparseKeptKey(id), JSON.stringify({ version: version, reason, at: now() }));
    };

    // Writes run under the ingest lock, held LOCK_HOLD_MS at most; spool lines waiting are ingested between holds.
    const lockOpts = opts.ingestLock !== false && existsSync(spoolDir) ? opts.ingestLock ?? {} : undefined;
    const lockPath = lockOpts && (lockOpts.path ?? join(spoolDir, ".ingest.lock"));
    const underLock = async <T>(items: T[], each: (item: T) => Promise<void>) => {
      let i = 0;
      while (i < items.length) {
        const lock = lockPath ? await acquireLock(lockPath, lockOpts) : undefined;
        const until = now() + LOCK_HOLD_MS;
        try {
          do {
            lock?.assertHeld();
            await each(items[i++]!);
          } while (i < items.length && now() < until);
        } finally {
          lock?.release();
        }
        if (lockPath && opts.onWake && existsSync(wakeMarker(lockPath))) {
          await opts.onWake().catch((err: Error) => error({ message: `ingest between re-parse batches failed: ${err.message}` }));
        }
      }
    };
    const writeBatch = async (items: [string, AgentEvent[] | undefined][]) => {
      await blobBatch?.flush();
      await underLock(items, async ([id, transcript]) => {
        try {
          await rebuild(id, transcript);
        } catch (err) {
          failed.add(id);
          error({ message: `re-parse of session ${id} failed: ${(err as Error).message}` });
        }
        progress({ phase: "sessions" });
      });
    };

    // Backfill rows: each adapter's transcripts, every file, keeping only the targets' events.
    const ctxBase = profileFor(undefined);
    const metadata = ctxBase.config.capture.mode === "metadata";
    const ctx = normalizeContext(ctxBase, blobStore, metadata);
    const namesTarget = pathNamesSession(fromTranscript);
    for (const id of transcriptAdapters) {
      const adapter = adapters.get(id)!;
      progress({ phase: "transcripts", agent: id });
      const pending = new Map<string, AgentEvent[]>();
      let buffered = 0;
      // Events of the file being read: complete once the next file starts or the backfill ends.
      let current: AgentEvent[] = [];
      const settle = () => {
        for (const e of current) {
          const list = pending.get(e.sessionId);
          if (list) list.push(e);
          else pending.set(e.sessionId, [e]);
        }
        buffered += current.length;
        current = [];
      };
      const flush = async () => {
        const items = [...pending].filter(([sid]) => !failed.has(sid));
        pending.clear();
        buffered = 0;
        await writeBatch(items);
      };
      const changed = async (f: BackfillFile) => {
        settle();
        if (buffered >= FLUSH_EVENTS) await flush();
        // A file that names no session to rebuild is not parsed.
        return !PATH_KEYED.has(id) || namesTarget(f.path);
      };
      const relinking = relinkHosts.has(id);
      try {
        const copied = (sid: string, ownerId: string) => {
          if (fromTranscript.has(sid)) copies.set(sid, ownerId);
        };
        for await (const raw of adapter.backfill!(ctx, { changed, copied })) {
          if (!fromTranscript.has(raw.sessionId) && !(relinking && (await isUnlinked(raw.sessionId, id)))) continue;
          const ev = backfillEvent(raw, profileFor, metadata, env);
          if (typeof ev === "string") {
            if (ev !== "excluded") error({ message: `${id}: ${ev}` });
            continue;
          }
          current.push(ev);
        }
        settle();
      } catch (err) {
        // The file being read is incomplete: its sessions keep their rows.
        for (const e of current) failed.add(e.sessionId);
        current = [];
        hostFailed.add(id);
        error({ message: `${id}.backfill failed: ${(err as Error).message}` });
      }
      await flush();
    }

    async function refold(): Promise<void> {
      let after = "";
      try {
        const saved = JSON.parse((await index.kvGet?.(REFOLD_AFTER)) ?? "null") as { v?: number; id?: string } | null;
        if (saved?.v === foldStamp() && typeof saved.id === "string") after = saved.id;
      } catch {
        // unreadable progress: start over
      }
      const rows = (await index.listSessions({}))
        .filter((s) => s.id > after && !done.has(s.id) && !failed.has(s.id))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      let n = 0;
      opts.onProgress?.({ phase: "refold", done: 0, total: rows.length });
      await underLock(rows, async (s) => {
        const id = s.id;
        try {
          await reprice(s);
          if (await recomputeSession(index, id, { linker, repo, onFoldError })) {
            result.refolded++;
            owed.delete(id);
          }
        } catch (err) {
          error({ message: `refold of session ${id} failed: ${(err as Error).message}` });
        }
        n++;
        if (n % REFOLD_SAVE_EVERY === 0) await index.kvSet?.(REFOLD_AFTER, JSON.stringify({ v: foldStamp(), id }));
        opts.onProgress?.({ phase: "refold", done: n, total: rows.length });
      });
    }

    /**
     * The end of a repricing: a session whose costs changed and whose fold was not written (it
     * failed) gets its totals refreshed alone; then the pass runs over the sessions this run did
     * not reprice, refreshing the totals of those whose costs changed, and sets the cursor. Not
     * after a session's repricing failed: the cursor stays, so a later run does it again.
     */
    async function repriceRest(): Promise<void> {
      await underLock([...owed], async (id) => {
        try {
          await refreshTotals(index, id);
        } catch (err) {
          error({ message: `the cost totals of session ${id} were not refreshed: ${(err as Error).message}` });
        }
      });
      owed.clear();
      if (repriceFailed) return;
      try {
        await repriceStored(index, config.pricing, {
          each: underLock,
          skip: (id) => repriced.has(id),
          lock: false,
          onProgress: (n, total) => opts.onProgress?.({ phase: "reprice", done: n, total }),
        });
      } catch (err) {
        error({ message: `repricing stored cost estimates failed: ${(err as Error).message}` });
      }
    }

    // Everything not rebuilt from a transcript: spool only, or nothing left to read.
    await writeBatch(targets.filter((s) => !done.has(s.id) && !failed.has(s.id)).map((s) => [s.id, undefined]));

    // Refold: every session not rebuilt above (OTel and SDK sessions too), from its stored rows, once per fold stamp.
    if (!wanted && (await index.getCursor(REFOLD_CURSOR)) !== foldStamp()) {
      await refold();
      await index.setCursor(REFOLD_CURSOR, foldStamp());
      await index.kvSet?.(REFOLD_AFTER, undefined);
    }
    await linker.apply();
    result.relinked = relinked.size;

    if (!wanted) await index.setCursor(REPARSE_CURSOR, stamp);
    // A host pass that read the whole store links nothing more until the host's parse changes; one cut short runs again.
    const relinkFailed = [...failed].some((sid) => !agents.has(sid));
    for (const h of relinkHosts) if (!wanted && !hostFailed.has(h) && !relinkFailed) await index.setCursor(relinkCursor(h), adapters.get(h)!.parseVersion ?? 1);
    if (repricing) await repriceRest();
    await index.kvSet?.(REPARSE_LAST, JSON.stringify({ at: now(), all: !!opts.all, sessions: result.sessions, reparsed: result.reparsed, kept: result.kept, copiesRemoved: result.copiesRemoved, relinked: result.relinked, refolded: result.refolded, errors: result.errors.slice(0, 5) }));
  }
}
