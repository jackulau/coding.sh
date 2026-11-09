// Datasets: build, hash, dedupe, split, and (de)serialize as JSONL / CSV.
// A dataset value is immutable by convention: every operation returns a new
// Dataset with a recomputed version, so a version id always names exactly one
// set of cases.
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AgentEvent, Session } from "../schema/index.ts";
import { parseCsvObjects, stringifyCsv } from "./csv.ts";
import { canonicalJson, contentHash, hashUnit, shortHash } from "./hash.ts";
import { isCaseKind } from "./kinds.ts";
import { CASE_KINDS, SPLITS, type Case, type Dataset, type Split } from "./types.ts";

export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetError";
  }
}

/** Lowercase kebab slug; the dataset id and its directory name. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!s) throw new DatasetError(`dataset name ${JSON.stringify(name)} has no usable characters`);
  return s.slice(0, 80);
}

/** Hash identifying a case's content for dedupe: input + expected only. */
export function caseContentHash(c: Pick<Case, "input" | "expected">): string {
  return contentHash({ input: c.input ?? null, expected: c.expected });
}

function isSplit(v: unknown): v is Split {
  return typeof v === "string" && (SPLITS as readonly string[]).includes(v);
}

/** Validate and normalize a loose record into a Case (id defaults to a content hash). */
export function normalizeCase(raw: unknown, where = "case"): Case {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new DatasetError(`${where}: expected an object`);
  const r = raw as Record<string, unknown>;
  if (!("input" in r)) throw new DatasetError(`${where}: missing "input"`);
  const c: Case = { id: "", input: r.input };
  if (r.expected !== undefined) c.expected = r.expected;
  if (r.metadata !== undefined) {
    if (r.metadata === null || typeof r.metadata !== "object" || Array.isArray(r.metadata)) {
      throw new DatasetError(`${where}: "metadata" must be an object`);
    }
    c.metadata = r.metadata as Record<string, unknown>;
  }
  if (r.tags !== undefined) {
    if (!Array.isArray(r.tags) || !r.tags.every((t) => typeof t === "string")) throw new DatasetError(`${where}: "tags" must be strings`);
    c.tags = [...new Set(r.tags as string[])];
  }
  if (r.sourceSessionId !== undefined) {
    if (typeof r.sourceSessionId !== "string") throw new DatasetError(`${where}: "sourceSessionId" must be a string`);
    c.sourceSessionId = r.sourceSessionId;
  }
  if (r.split !== undefined && r.split !== null && r.split !== "") {
    if (!isSplit(r.split)) throw new DatasetError(`${where}: "split" must be one of ${SPLITS.join(", ")}`);
    c.split = r.split;
  }
  if (r.kind !== undefined && r.kind !== null && r.kind !== "") {
    if (!isCaseKind(r.kind)) throw new DatasetError(`${where}: "kind" must be one of ${CASE_KINDS.join(", ")}`);
    c.kind = r.kind;
  }
  if (r.id !== undefined && r.id !== null && r.id !== "") {
    if (typeof r.id !== "string" && typeof r.id !== "number") throw new DatasetError(`${where}: "id" must be a string`);
    c.id = String(r.id);
  } else {
    c.id = `c_${caseContentHash(c).slice(0, 16)}`;
  }
  return c;
}

/** Content version over the cases, independent of their order. */
export function datasetVersion(cases: readonly Case[]): string {
  const sorted = [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return shortHash(sorted.map((c) => JSON.parse(canonicalJson(c))));
}

export interface DedupeReport {
  cases: Case[];
  /** Dropped case id → id of the kept case with the same content. */
  duplicates: { dropped: string; kept: string }[];
}

/**
 * Drop cases whose input + expected match an earlier case. Tags merge into the
 * kept case so nothing a labeller attached is lost. Distinct contents that
 * share an id are an error: ids must name exactly one case.
 */
export function dedupeCases(cases: readonly Case[]): DedupeReport {
  const byHash = new Map<string, Case>();
  const byId = new Map<string, string>();
  const out: Case[] = [];
  const duplicates: { dropped: string; kept: string }[] = [];
  for (const c of cases) {
    const h = caseContentHash(c);
    const prev = byHash.get(h);
    if (prev) {
      duplicates.push({ dropped: c.id, kept: prev.id });
      if (c.tags?.length) prev.tags = [...new Set([...(prev.tags ?? []), ...c.tags])];
      if (c.kind && !prev.kind) prev.kind = c.kind;
      continue;
    }
    const otherHash = byId.get(c.id);
    if (otherHash !== undefined && otherHash !== h) throw new DatasetError(`duplicate case id ${JSON.stringify(c.id)} with different content`);
    const copy: Case = { ...c, ...(c.tags ? { tags: [...c.tags] } : {}) };
    byHash.set(h, copy);
    byId.set(c.id, h);
    out.push(copy);
  }
  return { cases: out, duplicates };
}

export interface CreateDatasetOpts {
  name: string;
  cases: readonly unknown[];
  description?: string;
  /** Default true. */
  dedupe?: boolean;
  createdAt?: number;
}

/** Build a Dataset from loose records: normalize, dedupe, hash. */
export function createDataset(opts: CreateDatasetOpts): Dataset & { duplicates: DedupeReport["duplicates"] } {
  const normalized = opts.cases.map((c, i) => normalizeCase(c, `case ${i + 1}`));
  const { cases, duplicates } = opts.dedupe === false ? checkIds(normalized) : dedupeCases(normalized);
  const ds: Dataset & { duplicates: DedupeReport["duplicates"] } = {
    id: slugify(opts.name),
    name: opts.name,
    version: datasetVersion(cases),
    cases,
    duplicates,
  };
  if (opts.description !== undefined) ds.description = opts.description;
  if (opts.createdAt !== undefined) ds.createdAt = opts.createdAt;
  return ds;
}

function checkIds(cases: Case[]): DedupeReport {
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new DatasetError(`duplicate case id ${JSON.stringify(c.id)}`);
    seen.add(c.id);
  }
  return { cases, duplicates: [] };
}

/** New dataset value with extra cases appended (deduped against existing ones). */
export function addCases(ds: Dataset, extra: readonly unknown[]): Dataset & { duplicates: DedupeReport["duplicates"] } {
  return createDataset({
    name: ds.name,
    cases: [...ds.cases, ...extra],
    ...(ds.description !== undefined ? { description: ds.description } : {}),
  });
}

// ---------------------------------------------------------------- splits

export type SplitRatios = Partial<Record<Split, number>>;
export const DEFAULT_SPLIT_RATIOS: Readonly<Record<Split, number>> = { train: 0.6, dev: 0.2, test: 0.2 };

/** Split a case id falls into for the given ratios and seed. Pure and stable. */
export function splitFor(caseId: string, ratios: SplitRatios = DEFAULT_SPLIT_RATIOS, seed = "coding.sh"): Split {
  const entries = SPLITS.map((s) => [s, ratios[s] ?? 0] as const).filter(([, r]) => r > 0);
  const total = entries.reduce((a, [, r]) => a + r, 0);
  if (!(total > 0) || entries.some(([, r]) => !Number.isFinite(r) || r < 0)) {
    throw new DatasetError("split ratios must be non-negative numbers with a positive sum");
  }
  const u = hashUnit("split", seed, caseId);
  let acc = 0;
  for (const [s, r] of entries) {
    acc += r / total;
    if (u < acc) return s;
  }
  return (entries[entries.length - 1] as readonly [Split, number])[0];
}

/**
 * Assign splits by hashing each case id, so a case's split never depends on
 * what else is in the dataset (adding cases never reshuffles old ones).
 * Existing splits are kept unless `overwrite`.
 */
export function assignSplits(ds: Dataset, opts: { ratios?: SplitRatios; seed?: string; overwrite?: boolean } = {}): Dataset {
  const cases = ds.cases.map((c) => (c.split && !opts.overwrite ? c : { ...c, split: splitFor(c.id, opts.ratios, opts.seed) }));
  return { ...ds, cases, version: datasetVersion(cases) };
}

export function filterSplit(ds: Dataset, split: Split | readonly Split[]): Case[] {
  const want = new Set<Split>(typeof split === "string" ? [split] : split);
  return ds.cases.filter((c) => c.split !== undefined && want.has(c.split));
}

// ---------------------------------------------------------------- JSONL

/** One JSON object per line; blank lines ignored; errors carry the line number. */
export function parseJsonl(text: string): unknown[] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: unknown[] = [];
  const lines = s.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new DatasetError(`invalid JSON on line ${i + 1}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function stringifyJsonl(records: readonly unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}

/** Cases as JSONL (one case per line, fields in a stable order). */
export function datasetToJsonl(ds: Pick<Dataset, "cases">): string {
  return stringifyJsonl(ds.cases.map(orderCase));
}

function orderCase(c: Case): Record<string, unknown> {
  const o: Record<string, unknown> = { id: c.id, input: c.input };
  if (c.expected !== undefined) o.expected = c.expected;
  if (c.split !== undefined) o.split = c.split;
  if (c.kind !== undefined) o.kind = c.kind;
  if (c.tags !== undefined) o.tags = c.tags;
  if (c.metadata !== undefined) o.metadata = c.metadata;
  if (c.sourceSessionId !== undefined) o.sourceSessionId = c.sourceSessionId;
  return o;
}

// ---------------------------------------------------------------- CSV

export interface CsvCaseOpts {
  /** Parse cells that start with `{` or `[` as JSON. Default true. */
  parseJson?: boolean;
  /** Separator for the `tags` column. Default ";". */
  tagSeparator?: string;
  delimiter?: string;
}

function cell(v: string, parseJson: boolean): unknown {
  if (parseJson) {
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.parse(t);
      } catch {
        return v;
      }
    }
  }
  return v;
}

/**
 * CSV → case records. Columns: `input` (or `input.<key>` columns, which build
 * an object), `expected` (or `expected.<key>`), `id`, `split`, `kind`, `tags`,
 * `sourceSessionId`, `metadata.<key>`. Unknown columns go to metadata.
 */
export function casesFromCsv(text: string, opts: CsvCaseOpts = {}): unknown[] {
  const parseJson = opts.parseJson ?? true;
  const sep = opts.tagSeparator ?? ";";
  const rows = parseCsvObjects(text, opts.delimiter ? { delimiter: opts.delimiter } : {});
  return rows.map((row, i) => {
    const rec: Record<string, unknown> = {};
    const input: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    const metadata: Record<string, unknown> = {};
    let hasInputObj = false;
    let hasExpectedObj = false;
    for (const [k, v] of Object.entries(row)) {
      if (k === "input") rec.input = cell(v, parseJson);
      else if (k === "expected") {
        if (v !== "") rec.expected = cell(v, parseJson);
      } else if (k === "id") rec.id = v;
      else if (k === "split") rec.split = v.trim();
      else if (k === "kind") rec.kind = v.trim();
      else if (k === "sourceSessionId") {
        if (v !== "") rec.sourceSessionId = v;
      } else if (k === "tags") {
        const tags = v.split(sep).map((t) => t.trim()).filter(Boolean);
        if (tags.length) rec.tags = tags;
      } else if (k.startsWith("input.")) {
        hasInputObj = true;
        input[k.slice(6)] = cell(v, parseJson);
      } else if (k.startsWith("expected.")) {
        hasExpectedObj = true;
        expected[k.slice(9)] = cell(v, parseJson);
      } else if (k.startsWith("metadata.")) {
        if (v !== "") metadata[k.slice(9)] = cell(v, parseJson);
      } else if (k !== "" && v !== "") metadata[k] = cell(v, parseJson);
    }
    if (hasInputObj) {
      if ("input" in rec) throw new DatasetError(`CSV row ${i + 2}: both "input" and "input.*" columns`);
      rec.input = input;
    }
    if (hasExpectedObj) {
      if ("expected" in rec) throw new DatasetError(`CSV row ${i + 2}: both "expected" and "expected.*" columns`);
      rec.expected = expected;
    }
    if (!("input" in rec)) throw new DatasetError(`CSV row ${i + 2}: no "input" column`);
    if (Object.keys(metadata).length) rec.metadata = metadata;
    return rec;
  });
}

function toCell(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Cases → CSV with columns id,input,expected,split,[kind,]tags,sourceSessionId,metadata.* (kind only when a case has one). */
export function datasetToCsv(ds: Pick<Dataset, "cases">, opts: { tagSeparator?: string } = {}): string {
  const sep = opts.tagSeparator ?? ";";
  const metaKeys = [...new Set(ds.cases.flatMap((c) => Object.keys(c.metadata ?? {})))].sort();
  const kinds = ds.cases.some((c) => c.kind);
  const header = ["id", "input", "expected", "split", ...(kinds ? ["kind"] : []), "tags", "sourceSessionId", ...metaKeys.map((k) => `metadata.${k}`)];
  const rows = ds.cases.map((c) => [
    c.id,
    toCell(c.input),
    toCell(c.expected),
    c.split ?? "",
    ...(kinds ? [c.kind ?? ""] : []),
    (c.tags ?? []).join(sep),
    c.sourceSessionId ?? "",
    ...metaKeys.map((k) => toCell(c.metadata?.[k])),
  ]);
  return stringifyCsv([header, ...rows]);
}

// ---------------------------------------------------------------- files

export type DatasetFormat = "jsonl" | "csv" | "json";

export function formatFromPath(path: string): DatasetFormat {
  const ext = extname(path).toLowerCase();
  if (ext === ".jsonl" || ext === ".ndjson") return "jsonl";
  if (ext === ".csv") return "csv";
  if (ext === ".json") return "json";
  throw new DatasetError(`cannot infer dataset format from ${JSON.stringify(basename(path))}; use .jsonl, .csv or .json`);
}

/** Parse dataset text in the given format into case records. */
export function parseCases(text: string, format: DatasetFormat, csv: CsvCaseOpts = {}): unknown[] {
  if (format === "jsonl") return parseJsonl(text);
  if (format === "csv") return casesFromCsv(text, csv);
  const v: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object" && Array.isArray((v as { cases?: unknown }).cases)) return (v as { cases: unknown[] }).cases;
  throw new DatasetError("JSON dataset must be an array of cases or { cases: [...] }");
}

/** Load a dataset file (.jsonl / .csv / .json). Name defaults to the file's basename. */
export async function loadDatasetFile(
  path: string,
  opts: { name?: string; format?: DatasetFormat; csv?: CsvCaseOpts; dedupe?: boolean } = {},
): Promise<Dataset & { duplicates: DedupeReport["duplicates"] }> {
  const format = opts.format ?? formatFromPath(path);
  const text = await readFile(path, "utf8");
  const name = opts.name ?? basename(path, extname(path));
  return createDataset({ name, cases: parseCases(text, format, opts.csv), ...(opts.dedupe === false ? { dedupe: false } : {}) });
}

export function serializeDataset(ds: Pick<Dataset, "cases">, format: DatasetFormat): string {
  if (format === "jsonl") return datasetToJsonl(ds);
  if (format === "csv") return datasetToCsv(ds);
  return JSON.stringify(ds.cases.map(orderCase), null, 2) + "\n";
}

// ---------------------------------------------------------------- sessions

function eventText(e: Pick<AgentEvent, "payload">): string | undefined {
  const p = e.payload ?? {};
  if (typeof p.text === "string") return p.text;
  if (typeof p.content === "string") return p.content;
  return undefined;
}

export interface CaseFromSessionOpts {
  /** Store the session's final answer as `expected` (a golden case). Default false: stored as metadata.output. */
  asExpected?: boolean;
  tags?: string[];
  split?: Split;
  id?: string;
}

/**
 * Harvest a case from a captured session: the first user message is the input
 * and the last assistant message the output. By default the output is kept as
 * `metadata.output` — a session's answer is evidence, not ground truth, until a
 * human promotes it with `asExpected`.
 */
export function caseFromSession(session: Session, events: readonly AgentEvent[], opts: CaseFromSessionOpts = {}): Case {
  // Stable order: by timestamp, ties keep capture order.
  const sorted = events.map((e, i) => [e, i] as const).sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1]).map(([e]) => e);
  const firstUser = sorted.find((e) => e.kind === "user.message" && eventText(e) !== undefined);
  if (!firstUser) throw new DatasetError(`session ${session.id} has no user message to use as input`);
  let lastAssistant: AgentEvent | undefined;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i] as AgentEvent;
    if (e.kind === "assistant.message" && eventText(e) !== undefined) {
      lastAssistant = e;
      break;
    }
  }
  const output = lastAssistant ? eventText(lastAssistant) : undefined;
  const metadata: Record<string, unknown> = { agent: session.agent, startedAt: session.startedAt, inputEventId: firstUser.id };
  if (session.model) metadata.model = session.model;
  if (session.title) metadata.title = session.title;
  if (lastAssistant) metadata.outputEventId = lastAssistant.id;
  if (output !== undefined && !opts.asExpected) metadata.output = output;
  const raw: Record<string, unknown> = {
    input: eventText(firstUser),
    metadata,
    sourceSessionId: session.id,
    tags: [...new Set([...(opts.tags ?? []), `agent:${session.agent}`])],
  };
  if (opts.asExpected) {
    if (output === undefined) throw new DatasetError(`session ${session.id} has no assistant message to use as expected output`);
    raw.expected = output;
  }
  if (opts.split) raw.split = opts.split;
  raw.id = opts.id ?? `s_${shortHash({ session: session.id, input: raw.input })}`;
  return normalizeCase(raw, `session ${session.id}`);
}
