// `coding.sh harness tools`: every tool the agents were offered, read from the
// tools arrays the proxy stored (payload.toolsRef), with a hash of each tool's
// description and input schema. A tool whose description changes between
// sessions (an MCP server that rewrites its own description, a tampered
// package) shows more than one variant, or a hash that differs from the one
// pinned in <CODING_SH_HOME>/tool-pins.json.
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
  /** Sessions that were offered the tool. */
  sessions: number;
  /** Distinct (description, schema) pairs seen. */
  variants: number;
  /** The pinned hashes, when the tool has a pin. */
  pinned?: { descSha: string; schemaSha: string; at: number };
  /** Why --changed keeps it: "pin" (a definition since the pin, or the latest, differs from it), "variants" (no pin, more than one variant). Absent when neither. */
  changed?: "pin" | "variants";
}

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
  sessions: Set<string>;
}

const seen = (): Seen => ({ firstSeen: Infinity, lastSeen: -Infinity, sessions: new Set() });

function merge(into: Seen, from: Seen): void {
  into.firstSeen = Math.min(into.firstSeen, from.firstSeen);
  into.lastSeen = Math.max(into.lastSeen, from.lastSeen);
  for (const s of from.sessions) into.sessions.add(s);
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
      r.sessions.add(e.sessionId);
    }
  }
  const ordered = [...refs].sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  const toRead = ordered.slice(0, maxBlobs);
  // tool key -> variant key (descSha:schemaSha) -> where it was seen.
  const tools = new Map<string, { server: string; tool: string; variants: Map<string, Seen> }>();
  let blobsRead = 0;
  let blobsMissing = 0;
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
    for (const t of list) {
      const h = toolHashes(t);
      if (!h) continue;
      const { server, tool } = splitToolName(h.name);
      const key = toolKey({ server, tool });
      let row = tools.get(key);
      if (!row) tools.set(key, (row = { server, tool, variants: new Map() }));
      const vk = `${h.descSha}:${h.schemaSha}`;
      let v = row.variants.get(vk);
      if (!v) row.variants.set(vk, (v = seen()));
      merge(v, where);
    }
  }
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
    const pin = o.pins?.[key];
    if (pin) {
      row.pinned = { descSha: pin.descSha, schemaSha: pin.schemaSha, at: pin.at };
      const pinKey = `${pin.descSha}:${pin.schemaSha}`;
      const differs = latest![0] !== pinKey || [...t.variants].some(([vk, v]) => vk !== pinKey && v.lastSeen >= pin.at);
      if (differs) row.changed = "pin";
    } else if (t.variants.size > 1) row.changed = "variants";
    rows.push(row);
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

/** Pins the latest hashes of every row over the pins already there (tools not in `rows` keep theirs). */
export function writeToolPins(rows: readonly ToolRow[], env: NodeJS.ProcessEnv = process.env, now = Date.now()): ToolPins {
  const pins = { ...readToolPins(env) };
  for (const r of rows) pins[toolKey(r)] = { descSha: r.descSha, schemaSha: r.schemaSha, at: now };
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
