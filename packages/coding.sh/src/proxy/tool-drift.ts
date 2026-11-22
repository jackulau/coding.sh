// `coding.sh harness tools`: every tool the agents were offered, read from the
// tools arrays the proxy stored (payload.toolsRef), with a hash of each tool's
// description and input schema. A tool whose description changes between
// sessions (an MCP server that rewrites its own description, a tampered
// package) shows more than one variant, or a hash that differs from the one
// pinned in <CODING_SH_HOME>/tool-pins.json. A tool first offered at or after
// the last pin (an MCP server that added it) has no pin and shows as "new",
// and a pinned tool the sessions since no longer offer shows as "removed".
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../core/paths.ts";
import type { BlobStore, IndexStore } from "../core/types.ts";

/** At most this many distinct tools arrays are read; the most recently used first. */
export const MAX_TOOL_BLOBS = 2000;

/** One tool across the window: the hashes of its latest definition, and how many it had. */
export interface ToolRow {
  /** The MCP server of an `mcp__<server>__<tool>` name, else "builtin". */
  server: string;
  tool: string;
  /** First 12 hex characters of the sha256 of the latest description ("" when it had none). */
  descSha: string;
  /** The same for the latest input schema as JSON (for a tool with no schema, the rest of its definition). */
  schemaSha: string;
  firstSeen: number;
  lastSeen: number;
  /** Sessions that were offered the tool (0 on a "removed" row no array in the window offers). */
  sessions: number;
  /** Distinct (description, schema) pairs seen. */
  variants: number;
  /** The pinned hashes, when the tool has a pin. */
  pinned?: { descSha: string; schemaSha: string; at: number };
  /**
   * Why --changed keeps it: "pin" (a definition since the pin, or the latest,
   * differs from it), "variants" (no pin, more than one variant), "new" (no
   * pin, first seen at or after the newest pin: a tool an agent gained),
   * "removed" (pinned, and the latest tools array of every session that called
   * the model since the pin leaves it out). Absent when none applies.
   */
  changed?: ToolChange;
  /**
   * On a changed row other than "removed": up to MAX_CHANGED_SESSIONS ids of
   * the sessions offered a definition other than the pinned one ("pin"), other
   * than the first one seen ("variants"), or any ("new"), the latest call first.
   */
  sessionIds?: string[];
}

export type ToolChange = "pin" | "variants" | "new" | "removed";

/** At most this many session ids on a changed row. */
export const MAX_CHANGED_SESSIONS = 20;

export interface ToolDrift {
  since: number;
  /** Model calls in the window whose tools array is stored. */
  calls: number;
  /** Proxy calls that sent tools but have no stored tools array (capture mode metadata). */
  callsWithoutTools: number;
  /** Distinct tools arrays referenced, and how many were read. */
  blobs: number;
  blobsRead: number;
  /** Tools arrays no longer in the blob store (gc removed them). */
  blobsMissing: number;
  /** More than MAX_TOOL_BLOBS distinct tools arrays: the oldest were not read. */
  capped: boolean;
  tools: ToolRow[];
}

export interface ToolPin {
  descSha: string;
  schemaSha: string;
  /** When it was pinned (ms). */
  at: number;
}

export type ToolPins = Record<string, ToolPin>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const sha12 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** "server/tool": the key of a tool in the pins file. */
export const toolKey = (r: { server: string; tool: string }): string => `${r.server}/${r.tool}`;

/** The server and tool of a tool name: `mcp__docs__search` is server docs, tool search. */
export function splitToolName(name: string): { server: string; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : { server: "builtin", tool: name };
}

/**
 * A tool definition in any API's shape (Anthropic `{name, description,
 * input_schema}`, Responses `{type: "function", name, parameters}`, Chat
 * `{type: "function", function: {...}}`), as its name and two hashes.
 */
export function toolHashes(t: unknown): { name: string; descSha: string; schemaSha: string } | undefined {
  if (!isObj(t)) return undefined;
  const def = isObj(t.function) ? t.function : t;
  const name = str(def.name) ?? str(t.name) ?? str(t.type);
  if (!name) return undefined;
  const description = typeof def.description === "string" ? def.description : "";
  let schema: unknown = def.input_schema ?? def.parameters;
  if (schema === undefined) {
    // A server tool (web_search_20250305) has no schema: its other fields define it.
    const rest: Record<string, unknown> = { ...def };
    delete rest.name;
    delete rest.description;
    schema = rest;
  }
  return { name, descSha: sha12(description), schemaSha: sha12(JSON.stringify(schema ?? null)) };
}

interface Seen {
  firstSeen: number;
  lastSeen: number;
  /** Session id -> its latest call (ms). */
  sessions: Map<string, number>;
}

const seen = (): Seen => ({ firstSeen: Infinity, lastSeen: -Infinity, sessions: new Map() });

function addSession(into: Seen, id: string, ts: number): void {
  const at = into.sessions.get(id);
  if (at === undefined || ts > at) into.sessions.set(id, ts);
}

function merge(into: Seen, from: Seen): void {
  into.firstSeen = Math.min(into.firstSeen, from.firstSeen);
  into.lastSeen = Math.max(into.lastSeen, from.lastSeen);
  for (const [s, ts] of from.sessions) addSession(into, s, ts);
}

/** The sessions of `from`, the latest call first, at most MAX_CHANGED_SESSIONS. */
function sessionIds(from: Iterable<Seen>): string[] {
  const all = seen();
  for (const v of from) merge(all, v);
  return [...all.sessions]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CHANGED_SESSIONS)
    .map(([id]) => id);
}

/**
 * Every tool offered in the proxy calls at or after `since`: each stored tools
 * array (payload.toolsRef) is read once, the most recently used first, up to
 * `maxBlobs`. `pins` marks the tools --changed keeps.
 */
export async function toolDrift(index: IndexStore, blobs: BlobStore, o: { since: number; pins?: ToolPins; maxBlobs?: number; signal?: AbortSignal }): Promise<ToolDrift> {
  const maxBlobs = o.maxBlobs ?? MAX_TOOL_BLOBS;
  const refs = new Map<string, Seen>();
  let calls = 0;
  let callsWithoutTools = 0;
  // Session id -> its latest call with a stored tools array, and that array.
  const latestBySession = new Map<string, { ts: number; ref: string }>();
  // A session that started before the window can still have calls in it: keep any not ended before it.
  for (const s of await index.listSessions()) {
    o.signal?.throwIfAborted();
    if (s.startedAt < o.since && s.endedAt !== undefined && s.endedAt < o.since) continue;
    for (const e of await index.listEvents(s.id, { kinds: ["llm.call"] })) {
      if (e.ts < o.since) continue;
      const ref = str(e.payload.toolsRef);
      if (!ref) {
        if (e.source === "proxy" && ((typeof e.payload.toolCount === "number" && e.payload.toolCount > 0) || e.payload.toolsHash !== undefined)) callsWithoutTools++;
        continue;
      }
      calls++;
      let r = refs.get(ref);
      if (!r) refs.set(ref, (r = seen()));
      r.firstSeen = Math.min(r.firstSeen, e.ts);
      r.lastSeen = Math.max(r.lastSeen, e.ts);
      addSession(r, e.sessionId, e.ts);
      const last = latestBySession.get(e.sessionId);
      if (!last || e.ts >= last.ts) latestBySession.set(e.sessionId, { ts: e.ts, ref });
    }
  }
  const ordered = [...refs].sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  const toRead = ordered.slice(0, maxBlobs);
  // tool key -> variant key (descSha:schemaSha) -> where it was seen.
  const tools = new Map<string, { server: string; tool: string; variants: Map<string, Seen> }>();
  let blobsRead = 0;
  let blobsMissing = 0;
  // Tools array -> the tool keys it offers, for every array read.
  const refKeys = new Map<string, Set<string>>();
  for (const [ref, where] of toRead) {
    o.signal?.throwIfAborted();
    const text = await blobs.getText(ref).catch(() => undefined);
    if (text === undefined) {
      blobsMissing++;
      continue;
    }
    blobsRead++;
    let list: unknown;
    try {
      list = JSON.parse(text);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    const keys = new Set<string>();
    refKeys.set(ref, keys);
    for (const t of list) {
      const h = toolHashes(t);
      if (!h) continue;
      const { server, tool } = splitToolName(h.name);
      const key = toolKey({ server, tool });
      keys.add(key);
      let row = tools.get(key);
      if (!row) tools.set(key, (row = { server, tool, variants: new Map() }));
      const vk = `${h.descSha}:${h.schemaSha}`;
      let v = row.variants.get(vk);
      if (!v) row.variants.set(vk, (v = seen()));
      merge(v, where);
    }
  }
  const pins = o.pins ?? {};
  // The last `harness tools pin`: a tool with no pin first seen since then is new. With no pins, nothing is.
  const newestPin = Object.values(pins).reduce((m, p) => Math.max(m, p.at), -Infinity);
  // A pinned tool is gone when sessions called the model at or after its pin,
  // each of their latest tools arrays was read, and none offers it. A session
  // whose latest array was not read (capped, gc) leaves it undecided.
  const removedSince = (key: string, at: number): boolean => {
    let any = false;
    for (const last of latestBySession.values()) {
      if (last.ts < at) continue;
      const keys = refKeys.get(last.ref);
      if (!keys || keys.has(key)) return false;
      any = true;
    }
    return any;
  };
  const rows: ToolRow[] = [];
  for (const [key, t] of tools) {
    const all = seen();
    let latest: [string, Seen] | undefined;
    for (const entry of t.variants) {
      merge(all, entry[1]);
      if (!latest || entry[1].lastSeen > latest[1].lastSeen) latest = entry;
    }
    const [descSha, schemaSha] = latest![0].split(":") as [string, string];
    const row: ToolRow = { server: t.server, tool: t.tool, descSha, schemaSha, firstSeen: all.firstSeen, lastSeen: all.lastSeen, sessions: all.sessions.size, variants: t.variants.size };
    const pin = Object.hasOwn(pins, key) ? pins[key] : undefined;
    if (pin) {
      row.pinned = { descSha: pin.descSha, schemaSha: pin.schemaSha, at: pin.at };
      const pinKey = `${pin.descSha}:${pin.schemaSha}`;
      const differs = latest![0] !== pinKey || [...t.variants].some(([vk, v]) => vk !== pinKey && v.lastSeen >= pin.at);
      if (removedSince(key, pin.at)) row.changed = "removed";
      else if (differs) {
        row.changed = "pin";
        row.sessionIds = sessionIds([...t.variants].filter(([vk]) => vk !== pinKey).map(([, v]) => v));
      }
    } else if (newestPin > -Infinity && all.firstSeen >= newestPin) {
      row.changed = "new";
      row.sessionIds = sessionIds(t.variants.values());
    } else if (t.variants.size > 1) {
      row.changed = "variants";
      let first: [string, Seen] | undefined;
      for (const entry of t.variants) if (!first || entry[1].firstSeen < first[1].firstSeen) first = entry;
      row.sessionIds = sessionIds([...t.variants].filter(([vk]) => vk !== first![0]).map(([, v]) => v));
    }
    rows.push(row);
  }
  // A pinned tool no array in the window offers, though sessions called the model since its pin.
  if (refs.size <= maxBlobs) {
    for (const [key, pin] of Object.entries(pins)) {
      const slash = key.indexOf("/");
      if (tools.has(key) || slash < 0 || !removedSince(key, pin.at)) continue;
      const pinned = { descSha: pin.descSha, schemaSha: pin.schemaSha, at: pin.at };
      rows.push({ server: key.slice(0, slash), tool: key.slice(slash + 1), descSha: pin.descSha, schemaSha: pin.schemaSha, firstSeen: pin.at, lastSeen: pin.at, sessions: 0, variants: 0, pinned, changed: "removed" });
    }
  }
  rows.sort((a, b) => Number(!!b.changed) - Number(!!a.changed) || a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool));
  return { since: o.since, calls, callsWithoutTools, blobs: refs.size, blobsRead, blobsMissing, capped: refs.size > maxBlobs, tools: rows };
}

/** The pins in tool-pins.json; none when the file is missing or unreadable as pins. */
export function readToolPins(env: NodeJS.ProcessEnv = process.env): ToolPins {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(paths(env).toolPins, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const tools = isObj(doc) && isObj(doc.tools) ? doc.tools : {};
  const out: ToolPins = {};
  for (const [k, v] of Object.entries(tools)) {
    if (isObj(v) && typeof v.descSha === "string" && typeof v.schemaSha === "string" && typeof v.at === "number") out[k] = { descSha: v.descSha, schemaSha: v.schemaSha, at: v.at };
  }
  return out;
}

/**
 * Pins the latest hashes of every row over the pins already there (tools not
 * in `rows` keep theirs). A "removed" row is not pinned: its pin is dropped,
 * which accepts that the tool is gone.
 */
export function writeToolPins(rows: readonly ToolRow[], env: NodeJS.ProcessEnv = process.env, now = Date.now()): ToolPins {
  const pins = { ...readToolPins(env) };
  for (const r of rows) {
    if (r.changed === "removed") delete pins[toolKey(r)];
    else pins[toolKey(r)] = { descSha: r.descSha, schemaSha: r.schemaSha, at: now };
  }
  const sorted: ToolPins = {};
  for (const k of Object.keys(pins).sort()) sorted[k] = pins[k]!;
  // Written beside the file, then renamed over it: a reader never sees half a file.
  const file = paths(env).toolPins;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ v: 1, tools: sorted }, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return sorted;
}
