// Local-first versioned prompt registry stored under <CODING_SH_HOME>/prompts/<slug>/:
//
//   <prompts>/<slug>/versions/v1.json   immutable version record (content, config, hash, createdAt)
//   <prompts>/<slug>/labels.json        mutable label pointers (latest, production, staging, ...)
//   <prompts>/<slug>/history.jsonl      version metadata log
//
// All writes use per-prompt locks and durable atomic replacement (tmp + fsync + rename).
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock } from "../core/lock.ts";
import { paths } from "../core/paths.ts";
import { canonicalJson, contentHash } from "../datasets/hash.ts";
import { writeFileDurable } from "../store/durable.ts";
import {
  PROMPT_ROLES,
  type PromptConfig,
  type PromptContent,
  type PromptDiff,
  type PromptDiffLine,
  type PromptLabels,
  type PromptListing,
  type PromptMessage,
  type PromptRole,
  type PromptVersion,
  type PromptVersionMeta,
  type PutPromptInput,
  type PutPromptResult,
  type RenderedPrompt,
  type RenderPromptOptions,
} from "./types.ts";

// ---------------------------------------------------------------- errors

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

export class PromptValidationError extends PromptError {
  constructor(message: string) {
    super(message);
    this.name = "PromptValidationError";
  }
}

export class PromptNotFoundError extends PromptError {
  constructor(message: string) {
    super(message);
    this.name = "PromptNotFoundError";
  }
}

export class PromptRenderError extends PromptError {
  readonly missing: string[];

  constructor(missing: readonly string[]) {
    const list = [...missing];
    super(`Missing required prompt variable${list.length === 1 ? "" : "s"}: ${list.join(", ")}`);
    this.name = "PromptRenderError";
    this.missing = list;
  }
}

// ---------------------------------------------------------------- validation

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_EXACT_RE = /^v([1-9]\d*)$/;
const VERSION_INPUT_RE = /^v?([1-9]\d*)$/;
const VERSION_LIKE_RE = /^v\d+$/i;
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

/** Validate a prompt slug strictly; rejects path traversal, slashes, spaces and empty names. */
export function validatePromptSlug(slug: string): string {
  if (typeof slug !== "string" || !slug) {
    throw new PromptValidationError("Prompt name must be a non-empty string");
  }
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\") || !SLUG_RE.test(slug)) {
    throw new PromptValidationError(
      `Invalid prompt name ${JSON.stringify(slug)}: use 1 to 80 letters, digits, '.', '_' or '-', starting with a letter or digit`,
    );
  }
  return slug;
}

/** Validate a label name strictly; rejects traversal, invalid chars and version-shaped names (v1, v2). */
export function validatePromptLabel(label: string): string {
  if (typeof label !== "string" || !label) {
    throw new PromptValidationError("Label must be a non-empty string");
  }
  if (label.includes("..") || label.includes("/") || label.includes("\\") || !LABEL_RE.test(label)) {
    throw new PromptValidationError(
      `Invalid label ${JSON.stringify(label)}: use 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit`,
    );
  }
  if (VERSION_LIKE_RE.test(label)) {
    throw new PromptValidationError(`Invalid label ${JSON.stringify(label)}: labels cannot match version names like v1`);
  }
  return label;
}

/** Validate and normalize a version reference ("v1" or "1" -> "v1"). */
export function normalizePromptVersion(version: string): string {
  if (typeof version !== "string" || !version) {
    throw new PromptValidationError("Version must be a non-empty string such as v1");
  }
  const m = VERSION_INPUT_RE.exec(version);
  if (!m) {
    throw new PromptValidationError(`Invalid version ${JSON.stringify(version)}: expected v1, v2, ...`);
  }
  const num = Number(m[1]);
  if (!Number.isSafeInteger(num) || num < 1) {
    throw new PromptValidationError(`Invalid version ${JSON.stringify(version)}: expected a positive version number`);
  }
  return `v${num}`;
}

function isPromptRole(v: unknown): v is PromptRole {
  return typeof v === "string" && (PROMPT_ROLES as readonly string[]).includes(v);
}

/** Validate a chat prompt messages array. */
export function validatePromptMessages(raw: unknown): PromptMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PromptValidationError("Chat prompt messages must be a non-empty JSON array of { role, content } objects");
  }
  const out: PromptMessage[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new PromptValidationError(`Message ${i + 1}: expected an object with role and content`);
    }
    const rec = item as Record<string, unknown>;
    if (!isPromptRole(rec.role)) {
      throw new PromptValidationError(`Message ${i + 1}: role must be one of ${PROMPT_ROLES.join(", ")}`);
    }
    if (typeof rec.content !== "string") {
      throw new PromptValidationError(`Message ${i + 1}: content must be a string`);
    }
    out.push({ role: rec.role, content: rec.content });
  }
  return out;
}

/** Validate optional prompt model config JSON. */
export function validatePromptConfig(raw: unknown): PromptConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PromptValidationError("Prompt config must be a JSON object");
  }
  const rec = raw as Record<string, unknown>;
  if (rec.model !== undefined && (typeof rec.model !== "string" || !rec.model.trim())) {
    throw new PromptValidationError("config.model must be a non-empty string");
  }
  if (rec.temperature !== undefined && (typeof rec.temperature !== "number" || !Number.isFinite(rec.temperature) || rec.temperature < 0)) {
    throw new PromptValidationError("config.temperature must be a non-negative finite number");
  }
  if (rec.maxTokens !== undefined && (typeof rec.maxTokens !== "number" || !Number.isSafeInteger(rec.maxTokens) || rec.maxTokens < 1)) {
    throw new PromptValidationError("config.maxTokens must be a positive integer");
  }
  // Ensure the config round-trips through canonicalJson cleanly.
  let canonical: string;
  try {
    canonical = canonicalJson(rec);
  } catch (e) {
    throw new PromptValidationError(`Invalid prompt config: ${e instanceof Error ? e.message : String(e)}`);
  }
  return JSON.parse(canonical) as PromptConfig;
}

/** Canonical SHA-256 content hash over prompt type, content and optional config. */
export function promptContentHash(content: PromptContent, config?: PromptConfig): string {
  const payload: Record<string, unknown> =
    content.type === "text"
      ? { type: "text", template: content.template }
      : { type: "chat", messages: content.messages.map((m) => ({ role: m.role, content: m.content })) };
  if (config !== undefined) payload.config = config;
  return contentHash(payload);
}

// ---------------------------------------------------------------- variables & rendering

function collectVariables(text: string, into: Set<string>): void {
  for (const m of text.matchAll(VAR_RE)) {
    into.add(m[1]!);
  }
}

/** Deterministically extract sorted unique mustache-style {{var}} names from a prompt or template string. */
export function extractVariables(prompt: PromptContent | string): string[] {
  const vars = new Set<string>();
  if (typeof prompt === "string") {
    collectVariables(prompt, vars);
  } else if (prompt.type === "text") {
    collectVariables(prompt.template, vars);
  } else {
    for (const msg of prompt.messages) {
      collectVariables(msg.content, vars);
    }
  }
  return [...vars].sort();
}

/**
 * Single-pass template substitution. Replacement values are never re-scanned, so
 * substituting a value that contains "{{other}}" leaves "{{other}}" intact.
 */
export function renderTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
  opts: RenderPromptOptions = {},
): string {
  const missing = new Set<string>();
  const rendered = template.replace(VAR_RE, (match, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name]!;
    if (opts.allowMissing) return match;
    missing.add(name);
    return match;
  });
  if (missing.size > 0) {
    throw new PromptRenderError([...missing].sort());
  }
  return rendered;
}

/**
 * Render a text or chat prompt in a single pass.
 * Throws PromptRenderError when any required {{var}} is missing unless allowMissing is true.
 */
export function renderPrompt(
  prompt: PromptContent,
  vars: Readonly<Record<string, string>>,
  opts: RenderPromptOptions = {},
): RenderedPrompt {
  if (!opts.allowMissing) {
    const required = extractVariables(prompt);
    const missing = required.filter((name) => !Object.hasOwn(vars, name));
    if (missing.length > 0) {
      throw new PromptRenderError(missing);
    }
  }
  if (prompt.type === "text") {
    return { type: "text", text: renderTemplate(prompt.template, vars, opts) };
  }
  return {
    type: "chat",
    messages: prompt.messages.map((m) => ({
      role: m.role,
      content: renderTemplate(m.content, vars, opts),
    })),
  };
}

// ---------------------------------------------------------------- unified diff

function promptToLines(p: PromptVersion, includeConfig: boolean): string[] {
  const lines: string[] = [];
  if (includeConfig && p.config !== undefined) {
    lines.push("[config]");
    lines.push(...JSON.stringify(p.config, null, 2).split("\n"));
  }
  if (p.type === "text") {
    const body = p.template.replace(/\r\n/g, "\n").split("\n");
    if (includeConfig && p.config !== undefined) lines.push("[text]");
    lines.push(...body);
  } else {
    for (const m of p.messages) {
      lines.push(`[${m.role}]`);
      lines.push(...m.content.replace(/\r\n/g, "\n").split("\n"));
    }
  }
  return lines;
}

const MAX_LCS_CELLS = 4_000_000;

function computeLineOps(a: readonly string[], b: readonly string[]): PromptDiffLine[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: PromptDiffLine[] = [];
  for (let i = 0; i < prefix; i++) out.push({ kind: "context", line: a[i]! });

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  if (midA.length === 0) {
    for (const line of midB) out.push({ kind: "add", line });
  } else if (midB.length === 0) {
    for (const line of midA) out.push({ kind: "remove", line });
  } else if ((midA.length + 1) * (midB.length + 1) > MAX_LCS_CELLS) {
    for (const line of midA) out.push({ kind: "remove", line });
    for (const line of midB) out.push({ kind: "add", line });
  } else {
    const m = midA.length;
    const n = midB.length;
    const cols = n + 1;
    const dp = new Int32Array((m + 1) * cols);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)]! + 1;
        } else {
          const down = dp[(i + 1) * cols + j]!;
          const right = dp[i * cols + (j + 1)]!;
          dp[i * cols + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        out.push({ kind: "context", line: midA[i]! });
        i++;
        j++;
      } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + (j + 1)]!) {
        out.push({ kind: "remove", line: midA[i]! });
        i++;
      } else {
        out.push({ kind: "add", line: midB[j]! });
        j++;
      }
    }
    while (i < m) out.push({ kind: "remove", line: midA[i++]! });
    while (j < n) out.push({ kind: "add", line: midB[j++]! });
  }

  for (let i = a.length - suffix; i < a.length; i++) out.push({ kind: "context", line: a[i]! });
  return out;
}

/** Pure line-by-line unified diff between two prompt versions. */
export function diffPrompts(
  a: PromptVersion,
  b: PromptVersion,
  opts: { fromRef?: string; toRef?: string; context?: number } = {},
): PromptDiff {
  const fromRef = opts.fromRef ?? a.version;
  const toRef = opts.toRef ?? b.version;
  const ctxLines = opts.context ?? 3;
  const includeConfig = a.config !== undefined || b.config !== undefined;
  const linesA = promptToLines(a, includeConfig);
  const linesB = promptToLines(b, includeConfig);
  const ops = computeLineOps(linesA, linesB);

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "remove") removed++;
  }

  if (added === 0 && removed === 0) {
    return {
      slug: a.slug,
      from: { ref: fromRef, version: a.version, hash: a.hash },
      to: { ref: toRef, version: b.version, hash: b.hash },
      identical: true,
      added: 0,
      removed: 0,
      lines: [],
      unified: "",
    };
  }

  // Group changed ops into unified diff hunks with surrounding context lines.
  const changedIdx: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind !== "context") changedIdx.push(i);
  }
  const hunks: [number, number][] = [];
  for (const idx of changedIdx) {
    const start = Math.max(0, idx - ctxLines);
    const end = Math.min(ops.length - 1, idx + ctxLines);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      hunks.push([start, end]);
    }
  }

  // Track 1-based line numbers in A and B at every op index.
  const lineNumA: number[] = [];
  const lineNumB: number[] = [];
  let la = 1;
  let lb = 1;
  for (const op of ops) {
    lineNumA.push(la);
    lineNumB.push(lb);
    if (op.kind !== "add") la++;
    if (op.kind !== "remove") lb++;
  }

  const fromHeader = fromRef === a.version ? `${a.slug}@${a.version}` : `${a.slug}@${fromRef} (${a.version})`;
  const toHeader = toRef === b.version ? `${b.slug}@${b.version}` : `${b.slug}@${toRef} (${b.version})`;
  const unifiedLines = [`--- ${fromHeader}`, `+++ ${toHeader}`];
  const emitted: PromptDiffLine[] = [];

  for (const [start, end] of hunks) {
    const slice = ops.slice(start, end + 1);
    const countA = slice.filter((o) => o.kind !== "add").length;
    const countB = slice.filter((o) => o.kind !== "remove").length;
    const startA = countA === 0 ? Math.max(0, lineNumA[start]! - 1) : lineNumA[start]!;
    const startB = countB === 0 ? Math.max(0, lineNumB[start]! - 1) : lineNumB[start]!;
    unifiedLines.push(`@@ -${startA},${countA} +${startB},${countB} @@`);
    for (const op of slice) {
      emitted.push(op);
      const prefix = op.kind === "add" ? "+" : op.kind === "remove" ? "-" : " ";
      unifiedLines.push(`${prefix}${op.line}`);
    }
  }

  return {
    slug: a.slug,
    from: { ref: fromRef, version: a.version, hash: a.hash },
    to: { ref: toRef, version: b.version, hash: b.hash },
    identical: false,
    added,
    removed,
    lines: emitted,
    unified: unifiedLines.join("\n") + "\n",
  };
}

// ---------------------------------------------------------------- file store

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

function parseHistory(text: string | undefined): PromptVersionMeta[] {
  const out: PromptVersionMeta[] = [];
  const seen = new Set<string>();
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let entry: PromptVersionMeta;
    try {
      entry = JSON.parse(line) as PromptVersionMeta;
    } catch {
      continue;
    }
    if (typeof entry?.version !== "string" || seen.has(entry.version)) continue;
    seen.add(entry.version);
    out.push(entry);
  }
  return out;
}

function sortLabels(labels: PromptLabels): PromptLabels {
  const out: PromptLabels = {};
  for (const key of Object.keys(labels).sort()) {
    out[key] = labels[key]!;
  }
  return out;
}

export class FilePromptStore {
  readonly promptsDir: string;

  constructor(opts: { dir?: string; root?: string; env?: NodeJS.ProcessEnv } = {}) {
    if (opts.dir) {
      this.promptsDir = opts.dir;
    } else if (opts.root) {
      this.promptsDir = join(opts.root, "prompts");
    } else {
      this.promptsDir = paths(opts.env).prompts;
    }
  }

  private promptDir(slug: string): string {
    return join(this.promptsDir, validatePromptSlug(slug));
  }

  private versionPath(slug: string, version: string): string {
    return join(this.promptDir(slug), "versions", `${normalizePromptVersion(version)}.json`);
  }

  private labelsPath(slug: string): string {
    return join(this.promptDir(slug), "labels.json");
  }

  private historyPath(slug: string): string {
    return join(this.promptDir(slug), "history.jsonl");
  }

  /**
   * Create a new immutable prompt version (or reuse the latest when content and config match)
   * and move any requested labels to it.
   */
  async putPrompt(input: PutPromptInput): Promise<PutPromptResult> {
    const slug = validatePromptSlug(input.name);
    let content: PromptContent;
    if (input.type === "text") {
      if (typeof input.template !== "string" || input.template.length === 0) {
        throw new PromptValidationError("Text prompt template must be a non-empty string");
      }
      content = { type: "text", template: input.template };
    } else {
      content = { type: "chat", messages: validatePromptMessages(input.messages) };
    }

    const config = input.config !== undefined ? validatePromptConfig(input.config) : undefined;
    const requestedLabels: string[] = [];
    for (const rawLabel of input.labels ?? []) {
      const valid = validatePromptLabel(rawLabel);
      if (valid !== "latest" && !requestedLabels.includes(valid)) {
        requestedLabels.push(valid);
      }
    }

    const hash = promptContentHash(content, config);
    const variables = extractVariables(content);
    const dir = this.promptDir(slug);
    await mkdir(join(dir, "versions"), { recursive: true });

    const lock = await acquireLock(join(dir, ".lock"));
    try {
      const labelsFile = this.labelsPath(slug);
      const historyFile = this.historyPath(slug);
      const rawLabels = (await readJson<PromptLabels>(labelsFile)) ?? {};
      const labels: PromptLabels = { ...rawLabels };
      const history = parseHistory(await readText(historyFile));

      const latestName = labels.latest;
      const latestVersion = latestName ? await readJson<PromptVersion>(this.versionPath(slug, latestName)) : undefined;

      // Deduplicate identical consecutive writes against latest.
      if (latestVersion && latestVersion.hash === hash) {
        let labelsChanged = false;
        for (const lbl of requestedLabels) {
          if (labels[lbl] !== latestVersion.version) {
            labels[lbl] = latestVersion.version;
            labelsChanged = true;
          }
        }
        const sorted = sortLabels(labels);
        if (labelsChanged) {
          await writeFileDurable(labelsFile, JSON.stringify(sorted, null, 2) + "\n");
        }
        return { created: false, version: latestVersion, labels: sorted };
      }

      const maxFromHistory = history.reduce((max, h) => (h.versionNumber > max ? h.versionNumber : max), 0);
      const maxFromLatest = latestVersion?.versionNumber ?? 0;
      const nextNum = Math.max(maxFromHistory, maxFromLatest) + 1;
      const version = `v${nextNum}`;
      const createdAt = input.now ?? Date.now();

      const base = {
        slug,
        name: slug,
        version,
        versionNumber: nextNum,
        hash,
        createdAt,
        variables,
      };
      const stored: PromptVersion =
        content.type === "text"
          ? { ...base, type: "text", template: content.template }
          : { ...base, type: "chat", messages: content.messages };
      if (config !== undefined) stored.config = config;
      if (input.note !== undefined && input.note !== "") stored.note = input.note;

      await writeFileDurable(this.versionPath(slug, version), JSON.stringify(stored, null, 2) + "\n");

      const meta: PromptVersionMeta = {
        version,
        versionNumber: nextNum,
        hash,
        type: stored.type,
        createdAt,
      };
      if (stored.note !== undefined) meta.note = stored.note;
      history.push(meta);
      await writeFileDurable(historyFile, history.map((h) => JSON.stringify(h) + "\n").join(""));

      labels.latest = version;
      for (const lbl of requestedLabels) {
        labels[lbl] = version;
      }
      const sorted = sortLabels(labels);
      await writeFileDurable(labelsFile, JSON.stringify(sorted, null, 2) + "\n");

      return { created: true, version: stored, labels: sorted };
    } finally {
      lock.release();
    }
  }

  /** Fetch a prompt version by explicit version or label (default label: "latest"). */
  async getPrompt(slug: string, opts: { version?: string; label?: string } = {}): Promise<PromptVersion | undefined> {
    const id = validatePromptSlug(slug);
    if (opts.version !== undefined && opts.label !== undefined) {
      throw new PromptValidationError("Specify either version or label, not both");
    }
    if (opts.version !== undefined) {
      const ver = normalizePromptVersion(opts.version);
      return readJson<PromptVersion>(this.versionPath(id, ver));
    }
    const label = validatePromptLabel(opts.label ?? "latest");
    const labels = await this.getLabels(id);
    const target = labels[label];
    if (!target) return undefined;
    return readJson<PromptVersion>(this.versionPath(id, target));
  }

  /** Resolve a version name ("v1") or label ("production", "latest") to a PromptVersion. */
  async resolveRef(slug: string, ref: string): Promise<PromptVersion | undefined> {
    const id = validatePromptSlug(slug);
    if (typeof ref !== "string" || !ref) {
      throw new PromptValidationError("Reference must be a version (v1) or label (production)");
    }
    if (VERSION_EXACT_RE.test(ref)) {
      return this.getPrompt(id, { version: ref });
    }
    const label = validatePromptLabel(ref);
    return this.getPrompt(id, { label });
  }

  /** Return all mutable labels for a prompt (empty object when the prompt does not exist). */
  async getLabels(slug: string): Promise<PromptLabels> {
    const id = validatePromptSlug(slug);
    const raw = await readJson<PromptLabels>(this.labelsPath(id));
    return raw ? sortLabels(raw) : {};
  }

  /** Return version metadata in creation order. */
  async listVersions(slug: string): Promise<PromptVersionMeta[]> {
    const id = validatePromptSlug(slug);
    return parseHistory(await readText(this.historyPath(id)));
  }

  /** List all stored prompts sorted by slug. */
  async listPrompts(): Promise<PromptListing[]> {
    const entries = (await listDir(this.promptsDir)).sort();
    const out: PromptListing[] = [];
    for (const slug of entries) {
      if (!SLUG_RE.test(slug) || slug.includes("..")) continue;
      const labels = await this.getLabels(slug);
      const latestName = labels.latest;
      if (!latestName) continue;
      const latest = await readJson<PromptVersion>(this.versionPath(slug, latestName));
      if (!latest) continue;
      const history = await this.listVersions(slug);
      const updatedAt = history.length > 0 ? history[history.length - 1]!.createdAt : latest.createdAt;
      out.push({
        slug,
        name: latest.name,
        type: latest.type,
        latest: latest.version,
        versions: history.length || latest.versionNumber,
        labels,
        updatedAt,
      });
    }
    return out;
  }

  /** Point a mutable label at an existing immutable version. */
  async setLabel(slug: string, label: string, version: string): Promise<{ version: string; labels: PromptLabels }> {
    const id = validatePromptSlug(slug);
    const lbl = validatePromptLabel(label);
    if (lbl === "latest") {
      throw new PromptValidationError('Cannot manually move reserved label "latest"');
    }
    const ver = normalizePromptVersion(version);
    const dir = this.promptDir(id);
    const existing = await readJson<PromptVersion>(this.versionPath(id, ver));
    if (!existing) {
      const labels = await this.getLabels(id);
      if (!labels.latest) {
        throw new PromptNotFoundError(`Prompt ${JSON.stringify(id)} not found`);
      }
      throw new PromptNotFoundError(`Version ${ver} not found for prompt ${JSON.stringify(id)}`);
    }

    const lock = await acquireLock(join(dir, ".lock"));
    try {
      const labelsFile = this.labelsPath(id);
      const labels = { ...((await readJson<PromptLabels>(labelsFile)) ?? {}) };
      labels[lbl] = ver;
      const sorted = sortLabels(labels);
      await writeFileDurable(labelsFile, JSON.stringify(sorted, null, 2) + "\n");
      return { version: ver, labels: sorted };
    } finally {
      lock.release();
    }
  }

  /** Remove a mutable label from a prompt. */
  async deleteLabel(slug: string, label: string): Promise<{ labels: PromptLabels }> {
    const id = validatePromptSlug(slug);
    const lbl = validatePromptLabel(label);
    if (lbl === "latest") {
      throw new PromptValidationError('Cannot delete reserved label "latest"');
    }
    const dir = this.promptDir(id);
    const existingLabels = await readJson<PromptLabels>(this.labelsPath(id));
    if (!existingLabels || !existingLabels.latest) {
      throw new PromptNotFoundError(`Prompt ${JSON.stringify(id)} not found`);
    }

    const lock = await acquireLock(join(dir, ".lock"));
    try {
      const labelsFile = this.labelsPath(id);
      const labels = { ...((await readJson<PromptLabels>(labelsFile)) ?? {}) };
      if (!Object.hasOwn(labels, lbl)) {
        throw new PromptNotFoundError(`Label ${JSON.stringify(lbl)} not found on prompt ${JSON.stringify(id)}`);
      }
      delete labels[lbl];
      const sorted = sortLabels(labels);
      await writeFileDurable(labelsFile, JSON.stringify(sorted, null, 2) + "\n");
      return { labels: sorted };
    } finally {
      lock.release();
    }
  }
}
