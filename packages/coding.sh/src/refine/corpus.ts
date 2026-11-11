// The run corpus `refine distill` hands a coding agent (AD-3, CASD): raw
// episodes as tables and transcripts, never summaries, so the agent measures
// the corpus itself with code. Deterministic (the same input writes the same
// bytes), redacted through src/core/redact.ts, and path-safe.
//
//   episodes.jsonl                 one row per episode (a run or a session)
//   tool_calls.jsonl               one row per tool call, with ≤500-char previews
//   episodes/<episode>/transcript.md   the full redacted timeline, capped
//   prompt/                        copies of the current harness files (the brief says read-only)
//   SCHEMA.md                      what each field means
//
// Source: an experiment's runs (cancelled, superseded and infrastructure-error
// runs left out), or captured sessions (pass is null; flags carry the signal).
// Runs of held-out tasks (tagged split:dev, split:test, split:heldout or
// refine:heldout) are never written: the gate that later tests the skill runs
// on them, and a skill distilled from them would be scored on its own source.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRedactor, type Redactor } from "../core/redact.ts";
import type { AgentEvent, IndexStore, RunResult, Session } from "../core/types.ts";
import { eventText } from "../judge/prompt.ts";
import { safePath } from "./ledger.ts";
import type { HarnessText } from "./protect.ts";

export const HELD_OUT_TAGS = ["split:dev", "split:test", "split:heldout", "refine:heldout"] as const;
export const PREVIEW_CHARS = 500;
export const MAX_BYTES_PER_EPISODE = 200_000;

export const isHeldOut = (tags: readonly string[] | undefined): boolean => (tags ?? []).some((t) => (HELD_OUT_TAGS as readonly string[]).includes(t.toLowerCase()));

export interface EpisodeRow {
  episode: string;
  sessionId: string | null;
  taskId?: string;
  task?: string;
  tags?: string[];
  bundle?: string;
  attempt?: number;
  /** null for a captured session (no verifier). */
  pass: boolean | null;
  verifierExit?: number | null;
  tamper?: boolean;
  error?: string;
  agent: string;
  model: string | null;
  durationMs: number;
  turns: number | null;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd?: number;
  flags: string[];
}

export interface ToolCallRow {
  episode: string;
  seq: number;
  ts: number;
  tool: string;
  ok: boolean | null;
  inputPreview: string;
  inputSha: string;
  outputBytes: number;
  outputPreview: string;
}

export type CorpusSource = { kind: "experiment"; experimentId: string } | { kind: "sessions"; since: number; repo?: string; agents?: readonly string[]; limit?: number };

export interface CorpusOptions {
  index: Pick<IndexStore, "listRuns" | "getTask" | "getSession" | "listEvents" | "listSessions">;
  source: CorpusSource;
  dir: string;
  /** The current harness files, copied into prompt/. */
  prompt: readonly HarnessText[];
  redactor?: Redactor;
  maxBytesPerEpisode?: number;
}

export interface CorpusResult {
  dir: string;
  episodes: number;
  /** Failing runs, or flagged sessions. */
  failures: number;
  /** Over runs with a verdict; null for sessions. */
  passRate: number | null;
  /** Held-out tasks whose runs were left out, and how many runs that was. */
  leftOut: { tasks: string[]; runs: number };
  /** Runs left out for saying nothing about the harness. */
  skipped: { cancelled: number; superseded: number; infra: number };
  /** Episodes whose transcript hit the cap. */
  truncated: number;
}

const sha16 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`);
const asText = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
/** A flag with a colon is a tag (gateway:vercel, skill:pdf), not a failure. */
const failureFlags = (flags: readonly string[] | undefined): string[] => [...new Set(flags ?? [])].filter((f) => !f.includes(":")).sort();

/** Tool calls of a session, start paired with end by toolUseId (redacted). */
function toolCalls(episode: string, events: readonly AgentEvent[], r: Redactor): ToolCallRow[] {
  const ends = new Map<string, AgentEvent>();
  for (const e of events) if (e.kind === "tool.end" && typeof e.payload.toolUseId === "string") ends.set(e.payload.toolUseId, e);
  const out: ToolCallRow[] = [];
  for (const e of events) {
    if (e.kind !== "tool.start") continue;
    const end = typeof e.payload.toolUseId === "string" ? ends.get(e.payload.toolUseId) : undefined;
    const input = r.string(asText(e.payload.input));
    const output = r.string(asText(end?.payload.output));
    out.push({
      episode,
      seq: out.length + 1,
      ts: e.ts,
      tool: String(e.payload.tool ?? "?"),
      ok: end ? end.payload.ok !== false : null,
      inputPreview: clip(input, PREVIEW_CHARS),
      inputSha: sha16(input),
      outputBytes: Buffer.byteLength(output),
      outputPreview: clip(output, PREVIEW_CHARS),
    });
  }
  return out;
}

/** The redacted timeline, capped at `max` bytes with a marker. */
function transcript(header: string, events: readonly AgentEvent[], r: Redactor, max: number): { text: string; truncated: boolean } {
  let text = `${header}\n`;
  for (const [i, e] of events.entries()) {
    const body = r.string(eventText({ id: e.id, kind: e.kind, payload: e.payload }));
    const block = `\n### ${i + 1}. ${e.kind}${e.subagentId ? ` (subagent ${e.subagentId})` : ""} at ${new Date(e.ts).toISOString()}\n\n${body}\n`;
    if (Buffer.byteLength(text) + Buffer.byteLength(block) > max) {
      return { text: `${text}\n…[truncated: ${events.length - i} more events]\n`, truncated: true };
    }
    text += block;
  }
  return { text, truncated: false };
}

export const SCHEMA_MD = `# Corpus schema

Every file here is data from earlier agent runs, redacted. Nothing is summarized.

## episodes.jsonl

One JSON object per line, one per episode (an eval run, or a captured session).

- episode: the episode id; its transcript is episodes/<episode>/transcript.md.
- sessionId: the captured session of the run, or null when none was captured.
- taskId, task, tags: the eval task (runs only).
- bundle: which harness the run used (runs only; an experiment can compare several).
- attempt: the attempt number of the task under that harness (runs only).
- pass: whether the task's verifier passed; null for a captured session, which has no verifier.
- verifierExit: the verifier's exit code (runs only).
- tamper: true when the run's diff edits, deletes or skips tests.
- error: why the run failed to start or finish, when it did.
- agent, model: who ran it.
- durationMs, turns, toolCalls, toolErrors, inputTokens, outputTokens, costUsd: the run's size and cost; null when unknown.
- flags: the session's detected problems (for example no-verification, retry-loop).

## tool_calls.jsonl

One JSON object per tool call, in order within an episode.

- episode, seq: the episode and the call's 1-based position in it.
- ts: start time, milliseconds since the epoch.
- tool: the tool name.
- ok: false when the call failed, null when it never finished.
- inputPreview, outputPreview: the first ${PREVIEW_CHARS} characters of the input (JSON) and output.
- inputSha: a hash of the whole input, to find exact duplicate calls.
- outputBytes: the size of the whole output.

## episodes/<episode>/transcript.md

The full timeline of the episode: every event with its kind, time and text, capped at a fixed size with a "truncated" marker.

## prompt/

The harness files the agent ran with now (CLAUDE.md, AGENTS.md, skills). Read-only.
`;

/** Everything a corpus holds at its top level. */
const CORPUS_ENTRIES: readonly string[] = ["episodes", "episodes.jsonl", "prompt", "SCHEMA.md", "tool_calls.jsonl"];
const SCHEMA_HEADING = SCHEMA_MD.slice(0, SCHEMA_MD.indexOf("\n"));

function startsWithSchemaHeading(file: string): boolean {
  try {
    return readFileSync(file, "utf8").startsWith(SCHEMA_HEADING);
  } catch {
    return false; // missing, or not a file
  }
}

/**
 * The entries of `dir` a corpus written there would replace: none for an empty
 * or new directory, the corpus entries of an earlier corpus. Throws for any
 * other non-empty directory. An earlier corpus is a directory that holds
 * nothing but corpus entries and whose SCHEMA.md opens with the corpus heading:
 * a file named SCHEMA.md next to other work is not one. Writes nothing.
 */
export function corpusDirEntries(dir: string): string[] {
  const entries = existsSync(dir) ? readdirSync(dir) : [];
  if (!entries.length) return [];
  if (!entries.every((e) => CORPUS_ENTRIES.includes(e)) || !startsWithSchemaHeading(join(dir, "SCHEMA.md"))) {
    throw new Error(`${dir} is not empty and holds no corpus: pick an empty or new directory`);
  }
  return entries;
}

/** Removes an earlier corpus from `dir`, entry by entry; the directory itself and anything else are never removed. */
function prepareDir(dir: string): void {
  for (const e of corpusDirEntries(dir)) rmSync(join(dir, e), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const counted = (r: RunResult) => !r.cancelled && !r.superseded && !r.infra;

interface Episode {
  row: Omit<EpisodeRow, "episode">;
  header: string;
  events: AgentEvent[];
}

function sessionNumbers(s: Session | undefined): Pick<EpisodeRow, "turns" | "toolCalls" | "toolErrors" | "inputTokens" | "outputTokens"> {
  return {
    turns: s?.stats.turns ?? null,
    toolCalls: s?.stats.toolCalls ?? 0,
    toolErrors: s?.stats.toolErrors ?? 0,
    inputTokens: s?.stats.usage?.inputTokens ?? null,
    outputTokens: s?.stats.usage?.outputTokens ?? null,
  };
}

async function runEpisodes(o: CorpusOptions, experimentId: string, r: Redactor, result: CorpusResult): Promise<Episode[]> {
  const runs = await o.index.listRuns({ experimentId });
  const tasks = new Map<string, { name: string; tags: string[] } | undefined>();
  for (const id of new Set(runs.map((x) => x.taskId))) {
    const t = await o.index.getTask(id);
    tasks.set(id, t ? { name: t.name, tags: [...t.tags].sort() } : undefined);
  }
  const leftOut = new Set<string>();
  const kept: RunResult[] = [];
  for (const x of runs) {
    if (x.cancelled) result.skipped.cancelled++;
    else if (x.superseded) result.skipped.superseded++;
    else if (x.infra) result.skipped.infra++;
    if (!counted(x)) continue;
    if (isHeldOut(tasks.get(x.taskId)?.tags)) {
      leftOut.add(tasks.get(x.taskId)?.name ?? x.taskId);
      result.leftOut.runs++;
      continue;
    }
    kept.push(x);
  }
  result.leftOut.tasks = [...leftOut].sort();
  const key = (x: RunResult) => `${tasks.get(x.taskId)?.name ?? x.taskId}\u0000${x.bundleId}\u0000${String(x.attempt).padStart(6, "0")}\u0000${x.id}`;
  kept.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const out: Episode[] = [];
  for (const x of kept) {
    const s = x.sessionId ? await o.index.getSession(x.sessionId) : undefined;
    const events = x.sessionId ? await o.index.listEvents(x.sessionId) : [];
    const t = tasks.get(x.taskId);
    const usage = x.agent.usage;
    out.push({
      row: {
        sessionId: x.sessionId ?? null,
        taskId: x.taskId,
        ...(t ? { task: t.name, tags: t.tags } : {}),
        bundle: x.bundleId.slice(0, 12),
        attempt: x.attempt,
        pass: x.pass,
        verifierExit: x.verifierExit,
        ...(x.tamper ? { tamper: x.tamper.flagged } : {}),
        ...(x.error ? { error: r.string(clip(x.error, PREVIEW_CHARS)) } : {}),
        agent: String(s?.agent ?? "unknown"),
        model: s?.model ?? null,
        durationMs: Math.max(0, x.endedAt - x.startedAt),
        ...sessionNumbers(s),
        ...(usage?.inputTokens !== undefined && !s?.stats.usage ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined && !s?.stats.usage ? { outputTokens: usage.outputTokens } : {}),
        ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        flags: failureFlags(s?.flags),
      },
      header: `# ${t?.name ?? x.taskId}, attempt ${x.attempt}: ${x.pass ? "pass" : "fail"}${x.error ? ` (${r.string(clip(x.error, 200))})` : ""}`,
      events,
    });
  }
  return out;
}

const under = (dir: string, p: string | undefined): boolean => !!p && (p === dir || p.startsWith(`${dir.replace(/[\\/]+$/, "")}/`) || p.startsWith(`${dir.replace(/[\\/]+$/, "")}\\`));

async function sessionEpisodes(o: CorpusOptions, src: Extract<CorpusSource, { kind: "sessions" }>, r: Redactor): Promise<Episode[]> {
  const sessions = (await o.index.listSessions({ parentSessionId: null, runId: null, since: src.since, limit: src.limit ?? 2000 }))
    .filter((s) => s.startedAt >= src.since && !s.runId)
    .filter((s) => !src.agents?.length || src.agents.includes(String(s.agent)))
    .filter((s) => !src.repo || under(src.repo, s.repo?.root) || under(src.repo, s.cwd))
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const out: Episode[] = [];
  for (const s of sessions) {
    const events = await o.index.listEvents(s.id);
    out.push({
      row: {
        sessionId: s.id,
        pass: null,
        agent: String(s.agent),
        model: s.model ?? null,
        durationMs: Math.max(0, (s.endedAt ?? s.startedAt) - s.startedAt),
        ...sessionNumbers(s),
        ...(s.stats.usage?.costUsd !== undefined ? { costUsd: s.stats.usage.costUsd } : {}),
        flags: failureFlags(s.flags),
      },
      header: `# Session ${s.id} (${s.agent})${failureFlags(s.flags).length ? `: ${failureFlags(s.flags).join(", ")}` : ""}`,
      events,
    });
  }
  return out;
}

const line = (v: unknown): string => `${JSON.stringify(v)}\n`;

/** Writes the corpus to `o.dir` (an empty or new directory, or an earlier corpus, which is replaced). */
export async function writeCorpusDir(o: CorpusOptions): Promise<CorpusResult> {
  const r = o.redactor ?? createRedactor();
  const max = o.maxBytesPerEpisode ?? MAX_BYTES_PER_EPISODE;
  const result: CorpusResult = { dir: o.dir, episodes: 0, failures: 0, passRate: null, leftOut: { tasks: [], runs: 0 }, skipped: { cancelled: 0, superseded: 0, infra: 0 }, truncated: 0 };
  const eps = o.source.kind === "experiment" ? await runEpisodes(o, o.source.experimentId, r, result) : await sessionEpisodes(o, o.source, r);
  prepareDir(o.dir);
  const width = Math.max(4, String(eps.length).length);
  const episodes: string[] = [];
  const calls: string[] = [];
  for (const [i, ep] of eps.entries()) {
    const id = `ep${String(i + 1).padStart(width, "0")}`;
    episodes.push(line({ episode: id, ...ep.row }));
    for (const c of toolCalls(id, ep.events, r)) calls.push(line(c));
    const t = transcript(ep.header, ep.events, r, max);
    if (t.truncated) result.truncated++;
    const file = safePath(o.dir, `episodes/${id}/transcript.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, t.text);
  }
  writeFileSync(join(o.dir, "episodes.jsonl"), episodes.join(""));
  writeFileSync(join(o.dir, "tool_calls.jsonl"), calls.join(""));
  writeFileSync(join(o.dir, "SCHEMA.md"), SCHEMA_MD);
  mkdirSync(join(o.dir, "prompt"), { recursive: true });
  for (const f of [...o.prompt].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    let file: string;
    try {
      file = safePath(join(o.dir, "prompt"), f.path);
    } catch {
      continue; // an absolute or escaping path is not copied
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, r.string(f.text));
  }
  result.episodes = eps.length;
  const verdicts = eps.filter((e) => e.row.pass !== null);
  result.failures = eps.filter((e) => (e.row.pass === null ? e.row.flags.length > 0 : !e.row.pass)).length;
  result.passRate = verdicts.length ? verdicts.filter((e) => e.row.pass).length / verdicts.length : null;
  return result;
}
