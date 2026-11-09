// `coding.sh export --evidence <dir>`: raw traces as a directory an agent (or a
// person) can browse with ls, cat and grep. A proposer that reads raw traces
// does much better than one that reads summaries (Meta-Harness, arXiv
// 2603.28052: median 50.0 with raw traces vs 34.9 with summaries).
//
//   <dir>/index.md                    every session: agent, title, tool calls, errors, flags
//   <dir>/<session>/index.md          the session's stats and a timeline, one line per event
//   <dir>/<session>/session.json      the Session row
//   <dir>/<session>/events.jsonl      every event, as stored
//   <dir>/<session>/tools/0001-bash.txt  one tool call: input and full output
//
// Everything written goes through the redactor first (stores are already
// redacted at ingest; this applies the current rules again). A tool output cut
// at ingest is read back whole from the blob store. Each file is capped, and the
// cut says how much was left out. Deterministic: the same index gives the same
// bytes (no export time, sessions by start time then id, paths from ids).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentEvent, Session } from "../schema/index.ts";
import type { BlobStore, IndexStore } from "./types.ts";
import type { Redactor } from "./redact.ts";
import { byTime } from "./sessions.ts";

/** Per tool-call file. */
export const EVIDENCE_MAX_FILE_BYTES = 200_000;
/** Per events.jsonl. */
export const EVIDENCE_MAX_EVENTS_BYTES = 5_000_000;

export interface EvidenceOptions {
  index: IndexStore;
  /** Where cut tool inputs and outputs are read back whole; without it the stored (cut) text is written. */
  blobs?: BlobStore;
  sessions: readonly Session[];
  dir: string;
  redactor: Redactor;
  maxFileBytes?: number;
  maxEventsBytes?: number;
}

export interface EvidenceResult {
  dir: string;
  sessions: number;
  files: number;
  bytes: number;
  /** Files cut at their cap. */
  cut: number;
}

/** A file or directory name from an id: safe characters only, with a short hash when anything was changed. */
export function safeName(id: string, max = 80): string {
  let s = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, (m) => "_".repeat(m.length));
  if (!s) s = "_";
  if (s === id && s.length <= max) return s;
  const h = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `${s.slice(0, max - 9)}-${h}`;
}

/** `rel` under `root`, refusing anything that would land outside it. */
export function safeJoin(root: string, ...rel: string[]): string {
  const base = resolve(root);
  const p = resolve(base, ...rel);
  const r = relative(base, p);
  if (r === "" || isAbsolute(r) || r.split(sep).includes("..")) throw new Error(`refusing to write outside ${base}: ${rel.join("/")}`);
  return p;
}

const enc = new TextEncoder();
const byteLength = (s: string): number => enc.encode(s).length;

/** `text` cut to `max` UTF-8 bytes (on a character boundary), with a note of what was left out. */
function capped(text: string, max: number): { text: string; cut: boolean } {
  const bytes = enc.encode(text);
  if (bytes.length <= max) return { text, cut: false };
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  const head = new TextDecoder().decode(bytes.subarray(0, end));
  return { text: `${head}\n… cut: ${bytes.length - end} more bytes\n`, cut: true };
}

const iso = (ms: number | undefined): string => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "");
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const oneLine = (s: string, max = 120): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
/** Markdown table cell: no pipes or newlines. */
const cell = (s: string): string => oneLine(s, 100).replace(/\|/g, "\\|");

/** A string inside `v` that starts with `prefix` (a blob holding the JSON an output was cut from). */
function findString(v: unknown, prefix: string, depth = 0): string | undefined {
  if (typeof v === "string") return v.startsWith(prefix) ? v : undefined;
  if (depth > 16 || typeof v !== "object" || v === null) return undefined;
  for (const x of Object.values(v)) {
    const hit = findString(x, prefix, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function blobText(blobs: BlobStore | undefined, ref: string): Promise<string | undefined> {
  if (!blobs) return undefined;
  try {
    return await blobs.getText(ref);
  } catch {
    return undefined;
  }
}

/** A tool output whole: the stored text, or the blob it was cut from. */
async function fullOutput(blobs: BlobStore | undefined, end: AgentEvent): Promise<string | undefined> {
  const o = end.payload.output ?? end.payload.error;
  const text = typeof o === "string" ? o : o === undefined || o === null ? undefined : JSON.stringify(o, null, 2);
  if (text === undefined || !text.endsWith("…") || !end.blobs?.length) return text;
  const prefix = text.slice(0, -1);
  for (const ref of end.blobs) {
    const b = await blobText(blobs, ref);
    if (b === undefined) continue;
    if (b.startsWith(prefix)) return b;
    try {
      const hit = findString(JSON.parse(b), prefix);
      if (hit !== undefined) return hit;
    } catch {
      // not JSON
    }
  }
  return text;
}

/**
 * A tool input whole: the stored value, or the blob it was cut from. An event's
 * blobs can hold other things (a hook line too long to keep inline), so a blob
 * counts only when it fits: the stored preview string is its start, or the
 * stored object (strings cut, shape kept) has the same keys and was cut.
 */
async function fullInput(blobs: BlobStore | undefined, start: AgentEvent | undefined): Promise<unknown> {
  const input = start?.payload.input;
  if (!start?.blobs?.length || input === undefined || input === null) return input;
  const keys = (v: object) => Object.keys(v).sort().join("\u0000");
  const cutObject = typeof input === "object" && JSON.stringify(input).includes("…");
  if (typeof input !== "string" && !cutObject) return input;
  for (const ref of start.blobs) {
    const b = await blobText(blobs, ref);
    if (b === undefined) continue;
    if (typeof input === "string") {
      if (!input.endsWith("…") || !b.startsWith(input.slice(0, -1))) continue;
      try {
        return JSON.parse(b) as unknown;
      } catch {
        return b;
      }
    }
    try {
      const v = JSON.parse(b) as unknown;
      if (typeof v === "object" && v !== null && Array.isArray(v) === Array.isArray(input) && keys(v) === keys(input as object)) return v;
    } catch {
      // not JSON
    }
  }
  return input;
}

interface ToolCall {
  n: number;
  id?: string;
  tool: string;
  start?: AgentEvent;
  end?: AgentEvent;
  file: string;
}

/** Tool calls in order of first appearance: start and end by toolUseId, idless ones one per start (an idless end closes the oldest open idless start of its tool). */
function toolCalls(events: readonly AgentEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const open: ToolCall[] = [];
  const add = (tool: string, id?: string): ToolCall => {
    const n = calls.length + 1;
    const c: ToolCall = { n, tool, file: `tools/${String(n).padStart(4, "0")}-${safeName(tool.toLowerCase(), 40)}.txt`, ...(id ? { id } : {}) };
    calls.push(c);
    if (id) byId.set(id, c);
    return c;
  };
  for (const e of events) {
    if (e.kind !== "tool.start" && e.kind !== "tool.end") continue;
    const tool = str(e.payload.tool) ?? "tool";
    const id = str(e.payload.toolUseId) || undefined;
    let c = id ? byId.get(id) : undefined;
    if (!c && !id && e.kind === "tool.end") {
      const i = open.findIndex((x) => x.tool === tool);
      if (i >= 0) c = open.splice(i, 1)[0];
    }
    c ??= add(tool, id);
    if (e.kind === "tool.start") {
      c.start ??= e;
      if (!id) open.push(c);
    } else c.end ??= e;
  }
  return calls;
}

function toolFileText(c: ToolCall, input: unknown, output: string | undefined, redactor: Redactor): string {
  const end = c.end?.payload ?? {};
  const head: string[] = [`tool: ${c.tool}`];
  if (c.id) head.push(`toolUseId: ${c.id}`);
  if (c.start) head.push(`started: ${iso(c.start.ts)}`);
  if (c.end) head.push(`ended: ${iso(c.end.ts)}`);
  if (typeof end.ok === "boolean") head.push(`ok: ${end.ok}`);
  if (typeof end.exitCode === "number") head.push(`exitCode: ${end.exitCode}`);
  const ms = c.end?.durationMs ?? (typeof end.durationMs === "number" ? end.durationMs : undefined);
  if (typeof ms === "number") head.push(`durationMs: ${ms}`);
  if (end.interrupted === true) head.push("interrupted: true");
  const inputText = input === undefined ? "(not recorded)" : typeof input === "string" ? redactor.string(input) : JSON.stringify(redactor.value(input), null, 2);
  const outputText = output === undefined ? (c.end ? "(not recorded)" : "(no result: the call has no end event)") : redactor.string(output);
  return `${head.join("\n")}\n\n## input\n\n${inputText}\n\n## output\n\n${outputText}\n`;
}

/** What one timeline line says about an event, past its time and kind. */
function eventSummary(e: AgentEvent, redactor: Redactor): string {
  const p = e.payload;
  const tool = str(p.tool);
  let detail = "";
  if (e.kind === "tool.start") {
    const input = p.input;
    const cmd = input && typeof input === "object" ? (str((input as Record<string, unknown>).command) ?? str((input as Record<string, unknown>).file_path) ?? str((input as Record<string, unknown>).path)) : str(input);
    detail = cmd ?? (input === undefined ? "" : JSON.stringify(input));
  } else if (e.kind === "tool.end") detail = `${p.ok === false ? "failed" : "ok"}${typeof p.exitCode === "number" ? ` (exit ${p.exitCode})` : ""}${typeof p.output === "string" && p.output ? `: ${p.output}` : ""}`;
  else if (typeof p.text === "string") detail = p.text;
  else if (e.kind === "file.change") detail = `${str(p.op) ?? "change"} ${str(p.path) ?? ""}`;
  else if (e.kind === "test.result") detail = `${p.passed ?? 0} passed, ${p.failed ?? 0} failed`;
  else if (e.kind === "llm.call") detail = [e.model, e.usage?.inputTokens !== undefined ? `${e.usage.inputTokens} in` : "", e.usage?.outputTokens !== undefined ? `${e.usage.outputTokens} out` : ""].filter(Boolean).join(", ");
  const text = oneLine(redactor.string(detail));
  return [tool, text].filter(Boolean).join(" ");
}

function statsLine(s: Session): string {
  const st = s.stats;
  const parts = [`${st.events} events`, `${st.turns} turns`, `${st.toolCalls} tool calls`, `${st.toolErrors} tool errors`, `${st.filesChanged} files changed`];
  if (st.benignToolErrors) parts.push(`${st.benignToolErrors} benign tool failures`);
  if (st.interruptedToolCalls) parts.push(`${st.interruptedToolCalls} interrupted`);
  if (st.testsPassed !== undefined || st.testsFailed !== undefined) parts.push(`tests ${st.testsPassed ?? 0} passed / ${st.testsFailed ?? 0} failed`);
  if (st.usage?.costUsd !== undefined) parts.push(`$${st.usage.costUsd.toFixed(4)}`);
  return parts.join(", ");
}

const README = [
  "How to read this export:",
  "",
  "- Each session has a directory. Its `index.md` has the stats and a timeline, one line per event, linking each tool call to its file.",
  "- `tools/NNNN-<tool>.txt` holds one tool call: its input and its whole output (read back from the blob store when the index kept only the start).",
  "- `events.jsonl` holds every event as stored, one JSON object per line. `session.json` is the session row.",
  "- Everything was redacted before it was written. A file cut at its size cap ends with `… cut: N more bytes`.",
];

/** Writes the evidence tree for `sessions` under `dir` (created if missing). Files already there are replaced; others are left alone. */
export async function writeEvidence(o: EvidenceOptions): Promise<EvidenceResult> {
  const maxFile = o.maxFileBytes ?? EVIDENCE_MAX_FILE_BYTES;
  const maxEvents = o.maxEventsBytes ?? EVIDENCE_MAX_EVENTS_BYTES;
  const dir = resolve(o.dir);
  const r = o.redactor;
  const res: EvidenceResult = { dir, sessions: 0, files: 0, bytes: 0, cut: 0 };
  const write = (rel: string[], text: string, cap = maxFile) => {
    const c = capped(text, cap);
    const p = safeJoin(dir, ...rel);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, c.text);
    res.files++;
    res.bytes += byteLength(c.text);
    if (c.cut) res.cut++;
  };
  mkdirSync(dir, { recursive: true });
  const sessions = [...o.sessions].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const names = new Map(sessions.map((s) => [s.id, safeName(s.id)]));
  const rows: string[] = [];
  for (const s0 of sessions) {
    const s = r.value(s0);
    const name = names.get(s0.id)!;
    const events: AgentEvent[] = [];
    for (let offset = 0; ; offset += 2000) {
      const page = await o.index.listEvents(s0.id, { limit: 2000, offset });
      events.push(...page);
      if (page.length < 2000) break;
    }
    const sorted = byTime(events);
    write([name, "session.json"], `${JSON.stringify(s, null, 2)}\n`);

    // events.jsonl: whole lines up to the cap, then a line saying how many were left out.
    let jsonl = "";
    let size = 0;
    let left = 0;
    for (const e of sorted) {
      const line = `${JSON.stringify(r.event(e))}\n`;
      const n = byteLength(line);
      if (left || size + n > maxEvents) {
        left++;
        continue;
      }
      jsonl += line;
      size += n;
    }
    if (left) jsonl += `${JSON.stringify({ cut: true, eventsLeftOut: left })}\n`;
    write([name, "events.jsonl"], jsonl, Number.MAX_SAFE_INTEGER);
    if (left) res.cut++;

    const calls = toolCalls(sorted);
    const fileOf = new Map<AgentEvent, ToolCall>();
    for (const c of calls) {
      if (c.start) fileOf.set(c.start, c);
      if (c.end) fileOf.set(c.end, c);
      const input = await fullInput(o.blobs, c.start ?? (c.end?.payload.input !== undefined ? c.end : undefined));
      const output = c.end ? await fullOutput(o.blobs, c.end) : undefined;
      write([name, ...c.file.split("/")], toolFileText(c, input, output, r));
    }

    const lines: string[] = [`# ${cell(s.title ?? s.id)}`, ""];
    lines.push(`- id: \`${s.id}\``, `- agent: ${s.agent}${s.model ? ` (${s.model})` : ""}`, `- started: ${iso(s.startedAt)}`);
    if (s.endedAt !== undefined) lines.push(`- ended: ${iso(s.endedAt)}`);
    if (s.repo?.root) lines.push(`- repo: ${s.repo.root}${s.repo.branch ? ` (${s.repo.branch})` : ""}`);
    if (s.parent) lines.push(`- parent: ${names.has(s.parent.sessionId) ? `[${s.parent.sessionId}](../${names.get(s.parent.sessionId)}/index.md)` : `\`${s.parent.sessionId}\``}`);
    lines.push(`- stats: ${statsLine(s)}`);
    if (s.flags.length) lines.push(`- flags: ${s.flags.join(", ")}`);
    lines.push("", `Files: [session.json](session.json), [events.jsonl](events.jsonl), ${calls.length} tool call file${calls.length === 1 ? "" : "s"} in tools/.`, "", "## Timeline", "");
    const t0 = sorted[0]?.ts ?? s.startedAt;
    sorted.forEach((e, i) => {
      const c = fileOf.get(e);
      const at = `+${((e.ts - t0) / 1000).toFixed(3)}s`;
      const link = c ? ` → [${c.file}](${c.file})` : "";
      lines.push(`- ${String(i + 1).padStart(4, "0")} ${at} ${e.kind}${e.subagentId ? ` [${e.subagentId}]` : ""} ${eventSummary(e, r)}`.trimEnd() + link);
    });
    write([name, "index.md"], `${lines.join("\n")}\n`, maxEvents);
    rows.push(`| [${name}](${name}/index.md) | ${s.agent} | ${iso(s.startedAt)} | ${cell(s.title ?? "")} | ${s.stats.toolCalls} | ${s.stats.toolErrors} | ${s.flags.join(" ")} |`);
    res.sessions++;
  }
  const top = [`# coding.sh evidence: ${sessions.length} session${sessions.length === 1 ? "" : "s"}`, "", ...README, "", "| session | agent | started | title | tool calls | tool errors | flags |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows];
  write(["index.md"], `${top.join("\n")}\n`, Number.MAX_SAFE_INTEGER);
  return res;
}
