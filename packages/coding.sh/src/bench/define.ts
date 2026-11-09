// Benchmark definition files: where they live, how they parse, and the
// template `bench new` writes.
//
//   ./bench/<name>.toml                 project benchmarks (searched from cwd upward)
//   ~/.coding.sh/benchmarks/<name>.toml user benchmarks
//   ~/.coding.sh/benchmarks/<name>/runs one BenchRun JSON per run (src/bench/store.ts)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { paths } from "../core/paths.ts";
import { parseToml, stringifyToml, type TomlTable } from "../core/toml.ts";
import { contentHash } from "../datasets/hash.ts";
import type { GraderSpec } from "../graders/index.ts";
import { SOURCE_KINDS, type AnchorSpec, type BenchDef, type ContenderSpec, type SourceSpec, type Visibility } from "./types.ts";

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export class BenchDefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchDefError";
  }
}

export function benchHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).root, "benchmarks");
}

export function checkName(name: string): string {
  if (!NAME_RE.test(name)) throw new BenchDefError(`benchmark name ${JSON.stringify(name)} must be lowercase letters, digits, ".", "_" or "-" (max 63)`);
  return name;
}

/** ./bench directories from cwd up to the filesystem root, nearest first. */
function projectDirs(cwd: string): string[] {
  const out: string[] = [];
  let d = resolve(cwd);
  for (;;) {
    const b = join(d, "bench");
    if (existsSync(b)) out.push(b);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/** The file for a benchmark name (or a path to a .toml), or undefined. */
export function findDefinition(ref: string, opts: { cwd: string; env?: NodeJS.ProcessEnv }): string | undefined {
  if (ref.endsWith(".toml")) {
    const p = resolve(opts.cwd, ref);
    return existsSync(p) ? p : undefined;
  }
  if (!NAME_RE.test(ref)) return undefined;
  for (const d of [...projectDirs(opts.cwd), benchHome(opts.env)]) {
    const p = join(d, `${ref}.toml`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface DefinitionListing {
  name: string;
  file: string;
  scope: "project" | "user";
  error?: string;
  def?: BenchDef;
}

/** Every definition visible from cwd; a nearer file shadows a farther one with the same name. */
export function listDefinitions(opts: { cwd: string; env?: NodeJS.ProcessEnv }): DefinitionListing[] {
  const seen = new Map<string, DefinitionListing>();
  const dirs: [string, "project" | "user"][] = [...projectDirs(opts.cwd).map((d) => [d, "project"] as [string, "project"]), [benchHome(opts.env), "user"]];
  for (const [dir, scope] of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".toml"));
    } catch {
      continue;
    }
    for (const f of names.sort()) {
      const name = f.slice(0, -5);
      if (!NAME_RE.test(name) || seen.has(name)) continue;
      const file = join(dir, f);
      try {
        seen.set(name, { name, file, scope, def: loadDefinition(file) });
      } catch (e) {
        seen.set(name, { name, file, scope, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** ./bench/<name>.toml runs from the project root (the folder holding bench/); any other file from its own folder. */
export function baseDirOf(file: string): string {
  const d = dirname(resolve(file));
  return basename(d) === "bench" ? dirname(d) : d;
}

// ---------------------------------------------------------------- parsing

function isTable(v: unknown): v is TomlTable {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function strField(t: TomlTable, k: string, where: string, required = false): string | undefined {
  const v = t[k];
  if (v === undefined) {
    if (required) throw new BenchDefError(`${where}: missing "${k}"`);
    return undefined;
  }
  if (typeof v !== "string" || !v.trim()) throw new BenchDefError(`${where}: "${k}" must be a non-empty string`);
  return v;
}

function intField(t: TomlTable, k: string, where: string, dflt: number, min = 1): number {
  const v = t[k];
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new BenchDefError(`${where}: "${k}" must be an integer of at least ${min}`);
  return v;
}

function strList(t: TomlTable, k: string, where: string): string[] | undefined {
  const v = t[k];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new BenchDefError(`${where}: "${k}" must be a list of strings`);
  return v as string[];
}

function parseSource(raw: unknown): SourceSpec {
  if (!isTable(raw)) throw new BenchDefError('missing [source] table, e.g. [source] kind = "command" command = "node gen.mjs"');
  const kind = raw.kind;
  if (typeof kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new BenchDefError(`[source] kind must be one of ${SOURCE_KINDS.join(", ")}`);
  }
  const s = { ...raw } as Record<string, unknown>;
  switch (kind) {
    case "command":
      strField(raw, "command", "[source]", true);
      break;
    case "github": {
      const repo = strField(raw, "repo", "[source]", true)!;
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new BenchDefError(`[source] repo must look like owner/name, got ${JSON.stringify(repo)}`);
      if (s.type !== undefined && !["issues", "prs", "both"].includes(String(s.type))) throw new BenchDefError('[source] type must be "issues", "prs" or "both"');
      if (s.state !== undefined && !["open", "closed", "all"].includes(String(s.state))) throw new BenchDefError('[source] state must be "open", "closed" or "all"');
      strList(raw, "labels", "[source]");
      break;
    }
    case "urls": {
      const sm = s.sitemap;
      if (sm !== undefined && typeof sm !== "string" && !(Array.isArray(sm) && sm.every((x) => typeof x === "string"))) throw new BenchDefError("[source] sitemap must be a URL or a list of URLs");
      strList(raw, "urls", "[source]");
      if (sm === undefined && s.file === undefined && s.urls === undefined) throw new BenchDefError("[source] urls needs sitemap, file or urls");
      for (const k of ["include", "exclude"]) {
        const re = strField(raw, k, "[source]");
        if (re !== undefined) {
          try {
            new RegExp(re);
          } catch (e) {
            throw new BenchDefError(`[source] ${k} is not a valid regex: ${(e as Error).message}`);
          }
        }
      }
      break;
    }
    case "dataset":
      strField(raw, "dataset", "[source]", true);
      if (s.split !== undefined && !["train", "dev", "test"].includes(String(s.split))) throw new BenchDefError('[source] split must be "train", "dev" or "test"');
      break;
    case "sessions":
      if (s.select !== undefined && !["failed", "flagged", "any"].includes(String(s.select))) throw new BenchDefError('[source] select must be "failed", "flagged" or "any"');
      break;
  }
  return s as unknown as SourceSpec;
}

function parseContender(raw: unknown, i: number): ContenderSpec {
  const where = `[[contenders]] #${i + 1}`;
  if (!isTable(raw)) throw new BenchDefError(`${where}: expected a table`);
  const name = strField(raw, "name", where, true)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,62}$/.test(name)) throw new BenchDefError(`${where}: name ${JSON.stringify(name)} must be letters, digits or . _ @ : + - (max 63)`);
  const kind = raw.kind ?? (raw.command !== undefined ? "command" : raw.url !== undefined ? "http" : raw.agent !== undefined ? "agent" : undefined);
  if (kind === "command") strField(raw, "command", `contender ${name}`, true);
  else if (kind === "http") {
    const url = strField(raw, "url", `contender ${name}`, true)!;
    if (!/^https?:\/\//.test(url)) throw new BenchDefError(`contender ${name}: url must start with http:// or https://`);
  } else if (kind === "agent") strField(raw, "agent", `contender ${name}`, true);
  else throw new BenchDefError(`contender ${name}: kind must be "command", "http" or "agent"`);
  if (raw.costPerRun !== undefined && (typeof raw.costPerRun !== "number" || raw.costPerRun < 0)) throw new BenchDefError(`contender ${name}: costPerRun must be a number of USD`);
  if (raw.timeoutMs !== undefined) throw new BenchDefError(`contender ${name}: set timeoutMs at the top of the file so every contender gets the same limit`);
  if (raw.retries !== undefined) throw new BenchDefError(`contender ${name}: set retries at the top of the file so every contender gets the same policy`);
  if (raw.version !== undefined && typeof raw.version !== "string") throw new BenchDefError(`contender ${name}: version must be a string`);
  if (raw.axes !== undefined) {
    if (!isTable(raw.axes)) throw new BenchDefError(`contender ${name}: axes must be a table, e.g. axes = { model = "gpt-5", harness = "my-agent" }`);
    for (const [k, v] of Object.entries(raw.axes)) {
      if (k !== "model" && k !== "harness") throw new BenchDefError(`contender ${name}: axes takes model and harness, not ${JSON.stringify(k)}`);
      if (typeof v !== "string" || !v.trim()) throw new BenchDefError(`contender ${name}: axes.${k} must be a non-empty string`);
    }
  }
  return { ...raw, kind } as unknown as ContenderSpec;
}

/** Keys that don't change what is measured: history doesn't break when they change. */
const NOT_PROTOCOL = new Set(["contenders", "description", "reference", "budget_usd", "budgetUsd", "visibility", "window", "seedKeyEnv"]);

function parseAnchor(raw: unknown, where: string): AnchorSpec | undefined {
  if (raw === undefined) return undefined;
  if (!isTable(raw)) throw new BenchDefError(`${where}: [anchor] must be a table, e.g. [anchor] cases = 30`);
  const version = raw.version ?? "1";
  if ((typeof version !== "string" || !version.trim()) && typeof version !== "number") throw new BenchDefError(`${where}: [anchor] version must be a string or number`);
  for (const k of Object.keys(raw)) if (k !== "cases" && k !== "version") throw new BenchDefError(`${where}: [anchor] takes cases and version, not ${JSON.stringify(k)}`);
  return { cases: intField(raw, "cases", `${where} [anchor]`, 30), version: String(version) };
}

/** Parse and validate a definition. `file` anchors relative paths. */
export function parseDefinition(text: string, file: string): BenchDef {
  const t = parseToml(text, file);
  const where = file;
  const name = checkName(strField(t, "name", where, true)!);
  const contendersRaw = t.contenders;
  if (!Array.isArray(contendersRaw) || contendersRaw.length < 2) throw new BenchDefError(`${where}: needs at least two [[contenders]]`);
  const contenders = contendersRaw.map(parseContender);
  const names = new Set<string>();
  for (const c of contenders) {
    if (names.has(c.name)) throw new BenchDefError(`${where}: two contenders are named ${JSON.stringify(c.name)}`);
    names.add(c.name);
  }
  const gradersRaw = t.graders ?? [];
  if (!Array.isArray(gradersRaw) || !gradersRaw.every(isTable)) throw new BenchDefError(`${where}: graders must be [[graders]] tables`);
  for (const [i, g] of gradersRaw.entries()) if (typeof (g as TomlTable).kind !== "string") throw new BenchDefError(`${where}: [[graders]] #${i + 1} needs a kind, e.g. kind = "exact"`);
  const source = parseSource(t.source);
  if (source.kind === "sessions" && contenders.some((c) => c.kind === "agent")) {
    throw new BenchDefError(
      `${where}: a sessions source can't be paired with agent contenders yet. A session case needs the repo as it was when the session started, and a bench agent would get an empty folder. Use coding.sh eval for session replays, or compare command/HTTP contenders on these cases.`,
    );
  }
  const budget = t.budget_usd ?? t.budgetUsd;
  if (budget !== undefined && (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0)) throw new BenchDefError(`${where}: budget_usd must be a number of USD (0 or more)`);
  const visibility = t.visibility ?? (source.kind === "github" || source.kind === "urls" ? "public" : "private");
  if (visibility !== "public" && visibility !== "private") throw new BenchDefError(`${where}: visibility must be "public" or "private"`);
  const reference = t.reference ?? contenders[0]!.name;
  if (typeof reference !== "string" || !names.has(reference)) throw new BenchDefError(`${where}: reference must name one of the contenders (${[...names].join(", ")})`);
  const seed = t.seed === undefined ? "date" : t.seed;
  if (typeof seed !== "string" && typeof seed !== "number") throw new BenchDefError(`${where}: seed must be "date", "run", "secret" or a fixed value`);
  const seedKeyEnv = strField(t, "seedKeyEnv", where);
  if (seedKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(seedKeyEnv)) throw new BenchDefError(`${where}: seedKeyEnv must be an env var name like BENCH_SEED_KEY`);
  if (seedKeyEnv !== undefined && seed !== "secret") throw new BenchDefError(`${where}: seedKeyEnv only applies with seed = "secret"`);
  const anchor = parseAnchor(t.anchor, where);
  if (t.fresh !== undefined && typeof t.fresh !== "boolean") throw new BenchDefError(`${where}: fresh must be true or false`);
  const def: BenchDef = {
    name,
    cases: intField(t, "cases", where, 50),
    seed: String(seed),
    fresh: t.fresh === undefined ? true : (t.fresh as boolean),
    trials: intField(t, "trials", where, 1),
    concurrency: intField(t, "concurrency", where, 4),
    timeoutMs: intField(t, "timeoutMs", where, 300_000, 1),
    retries: intField(t, "retries", where, 3, 0),
    window: intField(t, "window", where, 28, 2),
    visibility: visibility as Visibility,
    reference,
    source,
    contenders,
    graders: gradersRaw as unknown as GraderSpec[],
    file,
    baseDir: baseDirOf(file),
    hash: contentHash(t),
    // Protocol: everything that decides what is measured and how, minus who is measured, labels and analysis settings.
    protocolHash: contentHash(Object.fromEntries(Object.entries(t).filter(([k]) => !NOT_PROTOCOL.has(k)))),
    // axes are grid labels, not part of what is measured: changing them keeps the contender's history.
    contenderHashes: Object.fromEntries((contendersRaw as TomlTable[]).map((c, i) => [contenders[i]!.name, contentHash(Object.fromEntries(Object.entries(c).filter(([k]) => k !== "axes")))])),
  };
  if (budget !== undefined) def.budgetUsd = budget as number;
  if (def.seed === "secret") def.seedKeyEnv = seedKeyEnv ?? "CODING_SH_BENCH_SEED_KEY";
  if (anchor) def.anchor = anchor;
  for (const k of ["maxPerHost", "maxPerOrg"] as const) if (t[k] !== undefined) def[k] = intField(t, k, where, 1);
  const description = strField(t, "description", where);
  if (description) def.description = description;
  const dedupeBy = strField(t, "dedupeBy", where);
  if (dedupeBy) def.dedupeBy = dedupeBy;
  const stratify = strField(t, "stratify", where);
  if (stratify) def.stratify = stratify;
  return def;
}

export function loadDefinition(file: string): BenchDef {
  return parseDefinition(readFileSync(file, "utf8"), file);
}

// ---------------------------------------------------------------- template

export interface NewOpts {
  name: string;
  source: SourceSpec;
  contenders: ContenderSpec[];
  graders: GraderSpec[];
  cases?: number;
  description?: string;
}

/** TOML for `bench new`, with short comments on the fields people change. */
export function renderDefinition(o: NewOpts): string {
  const head = [
    `# coding.sh benchmark. Each run samples fresh cases from [source], freezes them as a`,
    `# dataset version, runs every contender on the same set in random order, and grades.`,
    `#   coding.sh bench run ${o.name}      coding.sh bench report ${o.name}`,
    `# Guide: https://github.com/jackulau/coding.sh/blob/main/docs/guides/benchmarks.md`,
    "",
  ].join("\n");
  const top: Record<string, unknown> = { name: o.name };
  if (o.description) top.description = o.description;
  top.cases = o.cases ?? 50;
  const settings = stringifyToml(top);
  const knobs = [
    `seed = "date"      # "date": new sample each UTC day; "run": new every run; "secret": unpredictable, verifiable later`,
    `fresh = true       # never reuse a case an earlier run tested`,
    `# stratify = "metadata.category"   # balance the sample across this field`,
    `# dedupeBy = "metadata.url"        # what counts as "the same case" (default: content hash)`,
    `trials = 1`,
    `concurrency = 4`,
    `timeoutMs = 300000  # one limit for every contender's calls`,
    `retries = 3        # retries after a rate limit, 5xx or network error (with backoff), same for everyone; failures are never retried`,
    `# budget_usd = 5   # refuse to start above this estimate and stop at it (needed for bench schedule)`,
    `# maxPerHost = 3   # at most this many cases from one metadata.host (maxPerOrg: metadata.org)`,
    `# reference = "${o.contenders[0]?.name ?? "a"}"   # history shows each contender's gap to this one`,
    `# window = 28      # counted runs pooled for each gap's window estimate`,
    "",
    "",
  ].join("\n");
  const body = stringifyToml({ source: o.source, contenders: o.contenders, ...(o.graders.length ? { graders: o.graders } : {}) });
  const anchorHint = `\n# A fixed set rerun every day next to the fresh cases, so a moving score can be\n# told apart from moving cases. Bump version to pick a new set.\n# [anchor]\n# cases = 30\n# version = 1\n`;
  const graderHint = o.graders.length ? "" : `\n# No graders: a case passes when the contender answers without an error.\n# [[graders]]\n# kind = "contains"\n# value = "…"\n`;
  return `${head}${settings}${knobs}${body}${graderHint}${anchorHint}`;
}
