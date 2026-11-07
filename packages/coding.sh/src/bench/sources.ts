// Case generators. Each one returns the candidate pool for one run; sampling
// (src/bench/sample.ts) picks from it. Every source is read fresh on every
// run, which is what makes a benchmark dynamic.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseSince } from "../cli/args.ts";
import { which } from "../adapters/_shared/detect.ts";
import type { IndexStore } from "../core/types.ts";
import { caseFromSession, normalizeCase, slugify } from "../datasets/dataset.ts";
import { hashUnit, shortHash } from "../datasets/hash.ts";
import type { FileEvalStore } from "../datasets/store.ts";
import type { Case } from "../datasets/types.ts";
import { describeFailure, formatArgv, runProcess } from "../graders/proc.ts";
import { splitCommandLine } from "../experiments/task.ts";
import type { BenchDef, CommandSource, DatasetSource, GithubSource, SessionsSource, SourceSpec, UrlsSource } from "./types.ts";

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface SourceCtx {
  def: BenchDef;
  seed: string;
  date: string;
  runId: string;
  now: number;
  env: NodeJS.ProcessEnv;
  index?: IndexStore;
  evalStore?: FileEvalStore;
  fetch?: FetchFn;
  signal?: AbortSignal;
}

/** Human description of a source for records and reports (no secrets). */
export function sourceRef(s: SourceSpec): string {
  switch (s.kind) {
    case "command":
      return formatArgv({ command: s.command, ...(s.args ? { args: s.args } : {}) });
    case "sessions":
      return `${s.select ?? "failed"} sessions, last ${s.since ?? "7d"}${s.agent ? `, ${s.agent}` : ""}`;
    case "github":
      return `${s.repo} ${s.type ?? "issues"} (${s.state ?? "open"}), created in the last ${s.since ?? "7d"}`;
    case "urls": {
      const parts = [...(typeof s.sitemap === "string" ? [s.sitemap] : (s.sitemap ?? [])), ...(s.file ? [s.file] : []), ...(s.urls?.length ? [`${s.urls.length} listed URLs`] : [])];
      return parts.join(", ");
    }
    case "dataset":
      return `${s.dataset}@${s.version ?? "latest"}${s.split ? ` (${s.split})` : ""}`;
  }
}

export async function generateCases(ctx: SourceCtx): Promise<Case[]> {
  const s = ctx.def.source;
  switch (s.kind) {
    case "command":
      return commandCases(s, ctx);
    case "sessions":
      return sessionCases(s, ctx);
    case "github":
      return githubCases(s, ctx);
    case "urls":
      return urlCases(s, ctx);
    case "dataset":
      return datasetCases(s, ctx);
  }
}

// ---------------------------------------------------------------- command

/** Lines of JSON; an object with "input" is a case, anything else becomes {input: value}. */
export function casesFromJsonl(text: string, where: string): Case[] {
  const out: Case[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (!t) continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      throw new SourceError(`${where}: line ${i + 1} is not JSON: ${t.slice(0, 120)}`);
    }
    const raw = v && typeof v === "object" && !Array.isArray(v) && "input" in v ? v : { input: v };
    try {
      out.push(normalizeCase(raw, `${where}: line ${i + 1}`));
    } catch (e) {
      throw new SourceError((e as Error).message);
    }
  }
  return out;
}

async function commandCases(s: CommandSource, ctx: SourceCtx): Promise<Case[]> {
  let command = s.command;
  let args = s.args;
  if (!args?.length && /\s/.test(command.trim())) [command, ...args] = splitCommandLine(command) as [string, ...string[]];
  const spec = { command, ...(args ? { args } : {}) };
  const r = await runProcess({
    ...spec,
    cwd: ctx.def.baseDir,
    timeoutMs: s.timeoutMs ?? 10 * 60_000,
    env: {
      ...(s.env ?? {}),
      CODING_SH_BENCH: ctx.def.name,
      CODING_SH_BENCH_SEED: ctx.seed,
      CODING_SH_BENCH_DATE: ctx.date,
      CODING_SH_BENCH_RUN_ID: ctx.runId,
      CODING_SH_BENCH_CASES: String(ctx.def.cases),
    },
    stdin: "",
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (r.spawnError || r.timedOut || r.exitCode !== 0) throw new SourceError(`source ${formatArgv(spec)}: ${describeFailure(r, s.timeoutMs ?? 10 * 60_000)}`);
  return casesFromJsonl(r.stdout, `source ${formatArgv(spec)}`);
}

// ---------------------------------------------------------------- sessions

async function sessionCases(s: SessionsSource, ctx: SourceCtx): Promise<Case[]> {
  if (!ctx.index) throw new SourceError("sessions source needs the coding.sh index");
  const since = parseSince(s.since ?? "7d", ctx.now);
  const select = s.select ?? "failed";
  // runId null: organic sessions only, never the benchmark's own agent runs.
  const sessions = await ctx.index.listSessions({ since, parentSessionId: null, runId: null, limit: s.limit ?? 500, ...(s.agent ? { agent: s.agent } : {}) });
  const out: Case[] = [];
  for (const ses of sessions) {
    const flags = ses.flags.filter((f) => !f.includes(":"));
    const failed = flags.length > 0 || ses.stats.toolErrors > 0 || (ses.stats.testsFailed ?? 0) > 0;
    if (select === "flagged" && !flags.length) continue;
    if (select === "failed" && !failed) continue;
    try {
      const c = caseFromSession(ses, await ctx.index.listEvents(ses.id));
      c.metadata = { ...(c.metadata ?? {}), flags, toolErrors: ses.stats.toolErrors, ...(ses.repo?.root ? { repo: ses.repo.root } : {}), createdAt: new Date(ses.startedAt).toISOString() };
      out.push(c);
    } catch {
      // a session with no user prompt can't be a case
    }
  }
  return out;
}

// ---------------------------------------------------------------- github

function githubToken(s: GithubSource, env: NodeJS.ProcessEnv): string | undefined {
  const named = s.tokenEnv ? env[s.tokenEnv] : undefined;
  if (named) return named;
  if (s.tokenEnv) throw new SourceError(`github source: env ${s.tokenEnv} is not set`);
  const t = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (t) return t;
  if (s.apiUrl) return undefined;
  const gh = which("gh", env);
  if (!gh) return undefined;
  try {
    return execFileSync(gh, ["auth", "token"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function githubCases(s: GithubSource, ctx: SourceCtx): Promise<Case[]> {
  const doFetch = ctx.fetch ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
  const api = (s.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const token = githubToken(s, ctx.env);
  // The window is on created_at: an old issue someone commented on yesterday is not a new case
  // (and may be in a model's training data). The API's `since` filters updated_at, so walk
  // newest-created first and stop at the window's edge instead.
  const since = parseSince(s.since ?? "7d", ctx.now);
  const type = s.type ?? "issues";
  const limit = s.limit ?? 200;
  const out: Case[] = [];
  let pastWindow = false;
  for (let page = 1; out.length < limit && page <= 20 && !pastWindow; page++) {
    const q = new URLSearchParams({ state: s.state ?? "open", per_page: "100", page: String(page), sort: "created", direction: "desc" });
    if (s.labels?.length) q.set("labels", s.labels.join(","));
    const url = `${api}/repos/${s.repo}/issues?${q}`;
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "coding.sh-bench", "x-github-api-version": "2022-11-28" };
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    } catch (e) {
      throw new SourceError(`github ${s.repo}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? " (set GITHUB_TOKEN, or log in with gh auth login)" : "";
      throw new SourceError(`github ${s.repo}: HTTP ${res.status}${hint}`);
    }
    const items = (await res.json()) as Record<string, unknown>[];
    if (!Array.isArray(items) || !items.length) break;
    for (const it of items) {
      const created = Date.parse(String(it.created_at ?? ""));
      if (Number.isFinite(created) && created < since) {
        pastWindow = true;
        break;
      }
      const isPr = !!it.pull_request;
      if ((type === "issues" && isPr) || (type === "prs" && !isPr)) continue;
      const number = Number(it.number);
      const kind = isPr ? "pr" : "issue";
      const htmlUrl = String(it.html_url ?? `https://github.com/${s.repo}/${isPr ? "pull" : "issues"}/${number}`);
      const labels = Array.isArray(it.labels) ? it.labels.map((l) => (typeof l === "string" ? l : String((l as { name?: unknown }).name ?? ""))).filter(Boolean) : [];
      out.push(
        normalizeCase({
          id: `gh_${s.repo.replace(/[^\w.-]/g, "_")}_${number}`,
          input: { title: String(it.title ?? ""), body: String(it.body ?? "").slice(0, 8000), url: htmlUrl, number, kind },
          // No author: reports never need a person's login.
          metadata: { url: htmlUrl, repo: s.repo, org: s.repo.split("/")[0], number, kind, labels, ...(Number.isFinite(created) ? { createdAt: new Date(created).toISOString() } : {}) },
        }),
      );
      if (out.length >= limit) break;
    }
    if (items.length < 100) break;
  }
  return out;
}

// ---------------------------------------------------------------- urls

const LOC = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i;
const LASTMOD = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i;

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** <url> and <sitemap> entries of a sitemap or sitemap index. */
export function parseSitemap(xml: string): { urls: { loc: string; lastmod?: string }[]; sitemaps: string[] } {
  const urls: { loc: string; lastmod?: string }[] = [];
  const sitemaps: string[] = [];
  for (const m of xml.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const loc = LOC.exec(m[2]!)?.[1];
    if (!loc) continue;
    if (m[1]!.toLowerCase() === "sitemap") sitemaps.push(decodeXml(loc));
    else {
      const lastmod = LASTMOD.exec(m[2]!)?.[1];
      urls.push({ loc: decodeXml(loc), ...(lastmod ? { lastmod } : {}) });
    }
  }
  return { urls, sitemaps };
}

async function fetchText(url: string, ctx: SourceCtx): Promise<string> {
  const doFetch = ctx.fetch ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
  let res: Response;
  try {
    res = await doFetch(url, { headers: { "user-agent": "coding.sh-bench" }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  } catch (e) {
    throw new SourceError(`sitemap ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new SourceError(`sitemap ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

async function urlCases(s: UrlsSource, ctx: SourceCtx): Promise<Case[]> {
  const limit = s.limit ?? 50_000;
  const since = s.since ? parseSince(s.since, ctx.now) : undefined;
  const include = s.include ? new RegExp(s.include) : undefined;
  const exclude = s.exclude ? new RegExp(s.exclude) : undefined;
  const found: { loc: string; lastmod?: string }[] = [];
  for (const u of s.urls ?? []) found.push({ loc: u });
  if (s.file) {
    const text = await readFile(resolve(ctx.def.baseDir, s.file), "utf8").catch((e: NodeJS.ErrnoException) => {
      throw new SourceError(`urls file ${s.file}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
    });
    for (const l of text.split("\n")) {
      const t = l.trim();
      if (t && !t.startsWith("#")) found.push({ loc: t });
    }
  }
  const queue = (typeof s.sitemap === "string" ? [s.sitemap] : (s.sitemap ?? [])).map((u) => ({ u, depth: 0 }));
  let fetched = 0;
  while (queue.length) {
    const { u, depth } = queue.shift()!;
    // A sitemap index with thousands of children: read 200 of them, chosen by seed (children
    // are shuffled before this cap, so the first sitemaps in the index aren't favoured).
    if (++fetched > 200) break;
    const sm = parseSitemap(await fetchText(u, ctx));
    found.push(...sm.urls);
    if (depth < 3) for (const child of [...sm.sitemaps].sort((a, b) => hashUnit(ctx.seed, a) - hashUnit(ctx.seed, b))) queue.push({ u: child, depth: depth + 1 });
  }
  // Same for the URL cap: rank by seed, then cut.
  const ranked = found.length > limit ? [...found].sort((a, b) => hashUnit(ctx.seed, a.loc) - hashUnit(ctx.seed, b.loc)) : found;
  const out: Case[] = [];
  for (const { loc, lastmod } of ranked) {
    if (out.length >= limit) break;
    let host: string;
    try {
      const url = new URL(loc);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      host = url.host;
    } catch {
      continue;
    }
    if (include && !include.test(loc)) continue;
    if (exclude && exclude.test(loc)) continue;
    if (since !== undefined && lastmod) {
      const t = Date.parse(lastmod);
      if (Number.isFinite(t) && t < since) continue;
    }
    out.push(normalizeCase({ id: `u_${shortHash(loc)}`, input: loc, metadata: { url: loc, host, org: orgOf(host), ...(lastmod ? { lastmod, createdAt: lastmod } : {}) } }));
  }
  return out;
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"]);

/** Registrable domain, roughly: docs.example.co.uk → example.co.uk (used by maxPerOrg). */
export function orgOf(host: string): string {
  const h = host.replace(/:\d+$/, "").toLowerCase();
  if (/^[\d.]+$/.test(h) || !h.includes(".")) return h;
  const parts = h.split(".");
  const n = parts.length >= 3 && parts.at(-1)!.length === 2 && SECOND_LEVEL.has(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-n).join(".");
}

export interface PageSnapshot {
  status: number;
  fetchedAt: string;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  error?: string;
}

/**
 * Fetch one page once, at freeze. The body goes to `put` (content-addressed)
 * and its hash into the case metadata, so the frozen set's sha256 pins what
 * the page said when the run started, and graders can compare against it.
 */
export async function snapshotPage(url: string, put: (body: Buffer) => Promise<string>, o: { fetch?: FetchFn; signal?: AbortSignal; now?: () => number; maxBytes?: number; timeoutMs?: number }): Promise<PageSnapshot> {
  const doFetch = o.fetch ?? ((u: string, i?: RequestInit) => globalThis.fetch(u, i));
  const fetchedAt = new Date((o.now ?? Date.now)()).toISOString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${o.timeoutMs ?? 30_000} ms`)), o.timeoutMs ?? 30_000);
  const onAbort = () => ctrl.abort(o.signal?.reason);
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await doFetch(url, { headers: { "user-agent": "coding.sh-bench" }, redirect: "follow", signal: ctrl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    const body = buf.length > (o.maxBytes ?? 5 * 1024 * 1024) ? buf.subarray(0, o.maxBytes ?? 5 * 1024 * 1024) : buf;
    const snap: PageSnapshot = { status: res.status, fetchedAt, sha256: await put(body), bytes: body.length };
    const ct = res.headers.get("content-type");
    if (ct) snap.contentType = ct.split(";")[0]!.trim();
    return snap;
  } catch (e) {
    return { status: 0, fetchedAt, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------- dataset

async function datasetCases(s: DatasetSource, ctx: SourceCtx): Promise<Case[]> {
  if (!ctx.evalStore) throw new SourceError("dataset source needs the eval store");
  const ds = await ctx.evalStore.getDataset(slugify(s.dataset), s.version ?? "latest");
  if (!ds) throw new SourceError(`dataset ${s.dataset}@${s.version ?? "latest"} not found (list them with coding.sh dataset list)`);
  return s.split ? ds.cases.filter((c) => c.split === s.split) : ds.cases;
}
