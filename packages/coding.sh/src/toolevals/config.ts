// Tool-eval definitions (§13): `[toolevals]` in the committed coding.sh.toml,
// tasks under evals/toolevals/<target>/tasks/*.toml or tasks.jsonl, variants
// under evals/toolevals/<target>/variants/. A `heldoutDir` may live outside
// the repo so agents improving the target cannot read those tasks.
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseToml, type TomlTable } from "../core/toml.ts";
import { callsSpecProblems } from "./calls.ts";
import { DEFAULT_USAGE_PATTERNS } from "./tap/cli.ts";
import type { Budget, Check, Driver, Prices, StateAssertion, Target, ToolTask, Variant } from "./types.ts";

export const CONFIG_FILE = "coding.sh.toml";

export interface DriverConfig {
  baseUrl?: string;
  apiKeyEnv?: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  flags?: string[];
}

export interface ToolEvalsConfig {
  targets: Map<string, Target>;
  variants: Map<string, Map<string, Variant>>;
  tasks: ToolTask[];
  heldoutDir?: string;
  confirmAboveUsd: number;
  /** Estimated USD per trial when a task sets no cost budget (for the cost gate). */
  trialUsdEstimate: number;
  prices: Prices;
  drivers: Record<string, DriverConfig>;
  /** Rewriter model for description compression (`model:<provider>/<model>`). */
  rewriter?: string;
  /** Per-target load problems (bad task files etc.), reported instead of thrown. */
  problems: string[];
}

export class ToolEvalsConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ToolEvalsConfigError";
  }
}

const isTable = (v: unknown): v is TomlTable => typeof v === "object" && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isTable(v)) for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
};
const numOr = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function parseTarget(name: string, t: TomlTable, where: string): Target {
  const base = { name, docs: strs(t.docs), docsUrls: strs(t.docsUrls), env: Object.keys(strMap(t.env)).length ? strMap(t.env) : undefined };
  const kind = t.kind;
  if (kind === "cli") {
    const command = strs(t.command);
    const bin = typeof t.bin === "string" ? t.bin : undefined;
    if (!bin || !command?.length) throw new ToolEvalsConfigError(`${where}: cli target ${name} needs bin and command`);
    return {
      ...base,
      kind: "cli",
      bin,
      command,
      usageExitCodes: Array.isArray(t.usageExitCodes) ? (t.usageExitCodes as unknown[]).filter((x): x is number => typeof x === "number") : [2],
      usagePatterns: strs(t.usagePatterns) ?? DEFAULT_USAGE_PATTERNS,
      helpCrawl: t.helpCrawl !== false,
    };
  }
  if (kind === "mcp") {
    const docTools = strs(t.docTools);
    const validationPatterns = strs(t.validationPatterns);
    const extra = { ...(docTools ? { docTools } : {}), ...(validationPatterns ? { validationPatterns } : {}) };
    if (t.transport === "http" || (t.transport === undefined && typeof t.url === "string")) {
      if (typeof t.url !== "string") throw new ToolEvalsConfigError(`${where}: mcp target ${name} needs url`);
      const headers = strMap(t.headers);
      return { ...base, ...extra, kind: "mcp", transport: "http", url: t.url, ...(Object.keys(headers).length ? { headers } : {}) };
    }
    const command = strs(t.command);
    if (!command?.length) throw new ToolEvalsConfigError(`${where}: mcp target ${name} needs command (stdio) or url (http)`);
    return { ...base, ...extra, kind: "mcp", transport: "stdio", command };
  }
  if (kind === "http") {
    if (typeof t.baseUrl !== "string") throw new ToolEvalsConfigError(`${where}: http target ${name} needs baseUrl`);
    const auth = isTable(t.auth) && typeof t.auth.header === "string" && typeof t.auth.env === "string" ? { header: t.auth.header, env: t.auth.env } : undefined;
    return {
      ...base,
      kind: "http",
      baseUrl: t.baseUrl,
      ...(typeof t.openapi === "string" ? { openapi: t.openapi } : {}),
      ...(auth ? { auth } : {}),
      ...(typeof t.urlEnv === "string" ? { urlEnv: t.urlEnv } : {}),
    };
  }
  throw new ToolEvalsConfigError(`${where}: target ${name} has unknown kind ${JSON.stringify(kind)} (cli, mcp or http)`);
}

function parseBudget(v: unknown): Budget {
  const b: Budget = {};
  if (!isTable(v)) return b;
  for (const k of ["turns", "tokens", "wallMs", "costUsd"] as const) if (typeof v[k] === "number") b[k] = v[k];
  return b;
}

function parseCheck(c: unknown, where: string): Check {
  if (!isTable(c)) throw new ToolEvalsConfigError(`${where}: check must be a table`);
  switch (c.kind) {
    case "command":
      if (typeof c.run !== "string") throw new ToolEvalsConfigError(`${where}: command check needs run`);
      return { kind: "command", run: c.run, ...(typeof c.timeoutMs === "number" ? { timeoutMs: c.timeoutMs } : {}), ...(isTable(c.hiddenFiles) ? { hiddenFiles: strMap(c.hiddenFiles) } : {}) };
    case "state": {
      if (!Array.isArray(c.assert)) throw new ToolEvalsConfigError(`${where}: state check needs assert = [...]`);
      const assert = c.assert.map((a): StateAssertion => {
        if (!isTable(a)) throw new ToolEvalsConfigError(`${where}: state assertion must be a table`);
        if (typeof a.file === "string") {
          return {
            file: a.file,
            ...(typeof a.exists === "boolean" ? { exists: a.exists } : {}),
            ...(typeof a.contains === "string" ? { contains: a.contains } : {}),
            ...(typeof a.regex === "string" ? { regex: a.regex } : {}),
            ...(typeof a.jsonPath === "string" ? { jsonPath: a.jsonPath } : {}),
            ...("equals" in a ? { equals: a.equals } : {}),
          };
        }
        if (typeof a.command === "string") {
          return {
            command: a.command,
            ...(typeof a.stdoutContains === "string" ? { stdoutContains: a.stdoutContains } : {}),
            ...(typeof a.jsonPath === "string" ? { jsonPath: a.jsonPath } : {}),
            ...("equals" in a ? { equals: a.equals } : {}),
          };
        }
        throw new ToolEvalsConfigError(`${where}: state assertion needs file or command`);
      });
      return { kind: "state", assert };
    }
    case "output": {
      const normalize = strs(c.normalize)?.filter((x): x is "trim" | "lower" | "collapse-ws" => x === "trim" || x === "lower" || x === "collapse-ws");
      return {
        kind: "output",
        ...(typeof c.equals === "string" ? { equals: c.equals } : {}),
        ...(strs(c.contains) ? { contains: strs(c.contains) } : typeof c.contains === "string" ? { contains: [c.contains] } : {}),
        ...(typeof c.regex === "string" ? { regex: c.regex } : {}),
        ...(typeof c.jsonPath === "string" ? { jsonPath: c.jsonPath } : {}),
        ...("jsonEquals" in c ? { jsonEquals: c.jsonEquals } : {}),
        ...(normalize ? { normalize } : {}),
      };
    }
    case "judge":
      if (typeof c.judge !== "string" || typeof c.rubric !== "string") throw new ToolEvalsConfigError(`${where}: judge check needs judge and rubric`);
      return { kind: "judge", judge: c.judge, rubric: c.rubric };
    case "calls": {
      const problems = callsSpecProblems(c);
      if (problems.length) throw new ToolEvalsConfigError(`${where}: calls check ${problems.join("; ")}`);
      const matches = (v: unknown) => (v as TomlTable[]).map((m) => ({ tool: m.tool as string, ...(isTable(m.args) ? { args: m.args as Record<string, unknown> } : {}) }));
      return {
        kind: "calls",
        ...(c.must !== undefined ? { must: matches(c.must) } : {}),
        ...(c.mustNot !== undefined ? { mustNot: matches(c.mustNot) } : {}),
        ...(typeof c.max === "number" ? { max: c.max } : {}),
        ...(c.order !== undefined ? { order: c.order as string[] } : {}),
      };
    }
    default:
      throw new ToolEvalsConfigError(`${where}: unknown check kind ${JSON.stringify(c.kind)}`);
  }
}

/** One task from a parsed TOML table or JSONL object. */
export function parseTask(t: TomlTable | Record<string, unknown>, source: string, defaults: { target?: string; suiteDir?: string } = {}): ToolTask {
  const where = source;
  const id = typeof t.id === "string" ? t.id : undefined;
  const instruction = typeof t.instruction === "string" ? t.instruction : typeof t.input === "string" ? t.input : undefined;
  if (!id) throw new ToolEvalsConfigError(`${where}: task needs id`);
  if (!instruction?.trim()) throw new ToolEvalsConfigError(`${where}: task ${id} needs instruction`);
  const target = typeof t.target === "string" ? t.target : defaults.target;
  if (!target) throw new ToolEvalsConfigError(`${where}: task ${id} needs target`);
  const split = t.split === "heldout" ? "heldout" : "dev";
  const setup = isTable(t.setup) ? t.setup : {};
  const checksRaw = Array.isArray(t.check) ? t.check : Array.isArray(t.checks) ? t.checks : [];
  const task: ToolTask = {
    id,
    target,
    split,
    tags: strs(t.tags) ?? [],
    instruction,
    setup: { commands: strs(setup.commands) ?? [], files: strMap(setup.files), env: strMap(setup.env) },
    checks: checksRaw.map((c, i) => parseCheck(c, `${where} check ${i + 1}`)),
    budget: parseBudget(t.budget),
    status: t.status === "draft" ? "draft" : t.status === "validated" ? "validated" : "draft",
    source,
  };
  const reference = strs(t.reference);
  if (reference) task.reference = reference;
  if (isTable(t.expect) && typeof t.expect.minTargetCalls === "number") task.expect = { minTargetCalls: t.expect.minTargetCalls };
  if (defaults.suiteDir) task.suiteDir = defaults.suiteDir;
  return task;
}

/** The by-hand edit `markTaskValidated` makes, for messages when it can't. */
export const VALIDATED_EDIT = 'status = "validated"';

/**
 * Record a passed validation in the task's own file: sets top-level
 * `status = "validated"` in its TOML, or `"status": "validated"` on its JSONL
 * line. Everything else in the file is left as written; a TOML edit is
 * re-parsed and only kept when the task is otherwise unchanged. Returns
 * whether the file changed; throws with the reason when it can't be edited.
 */
export async function markTaskValidated(task: Pick<ToolTask, "id" | "source" | "status">): Promise<boolean> {
  if (task.status === "validated") return false;
  const line = /^(.*\.jsonl):(\d+)$/.exec(task.source);
  if (line) {
    const file = line[1]!;
    const text = await readFile(file, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const i = Number(line[2]) - 1;
    const obj = JSON.parse(lines[i] ?? "null") as unknown;
    if (!isTable(obj) || obj.id !== task.id) throw new ToolEvalsConfigError(`${task.source}: line no longer holds task ${task.id}`);
    obj.status = "validated";
    lines[i] = JSON.stringify(obj);
    await writeFile(file, lines.join(eol));
    return true;
  }
  if (!task.source.endsWith(".toml")) throw new ToolEvalsConfigError(`${task.source}: not a task file`);
  const text = await readFile(task.source, "utf8");
  const before = parseToml(text, task.source);
  if (before.id !== task.id) throw new ToolEvalsConfigError(`${task.source}: file no longer holds task ${task.id}`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  // Top-level keys live before the first [table] / [[array]] header.
  let top = lines.findIndex((l) => /^\s*\[/.test(l));
  if (top < 0) top = lines.length;
  const statusAt = lines.slice(0, top).findIndex((l) => /^\s*status\s*=/.test(l));
  if (statusAt >= 0) lines[statusAt] = VALIDATED_EDIT;
  else {
    const idAt = lines.slice(0, top).findIndex((l) => /^\s*id\s*=/.test(l));
    lines.splice(idAt + 1, 0, VALIDATED_EDIT);
  }
  const next = lines.join(eol);
  let after: TomlTable;
  try {
    after = parseToml(next, task.source);
  } catch {
    throw new ToolEvalsConfigError(`${task.source}: couldn't place the status line safely`);
  }
  const { status: _b, ...restBefore } = before;
  const { status: statusAfter, ...restAfter } = after;
  if (statusAfter !== "validated" || !isDeepStrictEqual(restBefore, restAfter)) throw new ToolEvalsConfigError(`${task.source}: couldn't place the status line safely`);
  await writeFile(task.source, next);
  return true;
}

async function loadTasksFrom(dir: string, target: string, problems: string[], forceSplit?: "heldout"): Promise<ToolTask[]> {
  const out: ToolTask[] = [];
  const push = (t: ToolTask) => out.push(forceSplit ? { ...t, split: forceSplit } : t);
  const tasksDir = join(dir, "tasks");
  if (existsSync(tasksDir)) {
    for (const f of (await readdir(tasksDir)).sort()) {
      const p = join(tasksDir, f);
      try {
        if (f.endsWith(".toml")) push(parseTask(parseToml(await readFile(p, "utf8"), p), p, { target, suiteDir: dir }));
        else if (f.endsWith(".jsonl")) for (const t of await jsonl(p, target, dir)) push(t);
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  const flat = join(dir, "tasks.jsonl");
  if (existsSync(flat)) {
    try {
      for (const t of await jsonl(flat, target, dir)) push(t);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

async function jsonl(p: string, target: string, suiteDir: string): Promise<ToolTask[]> {
  const out: ToolTask[] = [];
  const lines = (await readFile(p, "utf8")).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new ToolEvalsConfigError(`${p}:${i + 1}: ${(e as Error).message}`);
    }
    if (!isTable(obj)) throw new ToolEvalsConfigError(`${p}:${i + 1}: task must be an object`);
    out.push(parseTask(obj, `${p}:${i + 1}`, { target, suiteDir }));
  });
  return out;
}

/** Variant overrides file: `{"tool": "desc"}` or `{descriptions, paramDescriptions, hideTools}`. */
export function parseDescriptions(v: unknown): Pick<Variant, "descriptions" | "paramDescriptions" | "hideTools"> {
  if (!isTable(v)) return {};
  if (isTable(v.descriptions) || isTable(v.paramDescriptions) || Array.isArray(v.hideTools)) {
    const out: Pick<Variant, "descriptions" | "paramDescriptions" | "hideTools"> = {};
    if (isTable(v.descriptions)) out.descriptions = strMap(v.descriptions);
    if (isTable(v.paramDescriptions)) {
      out.paramDescriptions = {};
      for (const [tool, params] of Object.entries(v.paramDescriptions)) out.paramDescriptions[tool] = strMap(params);
    }
    const hide = strs(v.hideTools);
    if (hide) out.hideTools = hide;
    return out;
  }
  return { descriptions: strMap(v) };
}

async function loadVariants(dir: string, problems: string[]): Promise<Map<string, Variant>> {
  const out = new Map<string, Variant>([["base", { name: "base" }]]);
  const vdir = join(dir, "variants");
  if (!existsSync(vdir)) return out;
  for (const f of (await readdir(vdir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      if (f.isFile() && f.name.endsWith(".toml")) {
        const name = basename(f.name, ".toml");
        const t = parseToml(await readFile(join(vdir, f.name), "utf8"), join(vdir, f.name));
        const v: Variant = { ...(out.get(name) ?? {}), name };
        if (strs(t.command)) v.command = strs(t.command);
        if (isTable(t.env)) v.env = strMap(t.env);
        if (typeof t.url === "string") v.url = t.url;
        if (typeof t.bundle === "string") v.bundle = t.bundle;
        if (strs(t.hideTools)) v.hideTools = strs(t.hideTools);
        if (isTable(t.descriptions)) v.descriptions = strMap(t.descriptions);
        out.set(name, v);
      } else if (f.isDirectory()) {
        const p = join(vdir, f.name, "descriptions.json");
        if (!existsSync(p)) continue;
        const d = parseDescriptions(JSON.parse(await readFile(p, "utf8")) as unknown);
        out.set(f.name, { ...(out.get(f.name) ?? { name: f.name }), ...d, name: f.name });
      }
    } catch (e) {
      problems.push(`${join(vdir, f.name)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export async function loadToolEvals(repoRoot: string): Promise<ToolEvalsConfig> {
  const file = join(repoRoot, CONFIG_FILE);
  const doc = existsSync(file) ? parseToml(await readFile(file, "utf8"), file) : {};
  const te = isTable(doc.toolevals) ? doc.toolevals : {};
  const problems: string[] = [];
  const targets = new Map<string, Target>();
  if (isTable(te.targets)) for (const [name, t] of Object.entries(te.targets)) if (isTable(t)) targets.set(name, parseTarget(name, t, file));
  const heldoutDir = typeof te.heldoutDir === "string" ? (isAbsolute(te.heldoutDir) ? te.heldoutDir : resolve(repoRoot, te.heldoutDir)) : undefined;
  const variants = new Map<string, Map<string, Variant>>();
  const tasks: ToolTask[] = [];
  for (const name of targets.keys()) {
    const dir = join(repoRoot, "evals", "toolevals", name);
    variants.set(name, await loadVariants(dir, problems));
    tasks.push(...(await loadTasksFrom(dir, name, problems)));
    if (heldoutDir) tasks.push(...(await loadTasksFrom(join(heldoutDir, name), name, problems, "heldout")));
  }
  const prices: Prices = {};
  if (isTable(doc.prices)) {
    for (const [m, p] of Object.entries(doc.prices)) {
      if (isTable(p) && typeof p.input === "number" && typeof p.output === "number") {
        prices[m] = { input: p.input, output: p.output, ...(typeof p.cacheRead === "number" ? { cacheRead: p.cacheRead } : {}), ...(typeof p.cacheWrite === "number" ? { cacheWrite: p.cacheWrite } : {}) };
      }
    }
  }
  const drivers: Record<string, DriverConfig> = {};
  if (isTable(te.drivers)) {
    for (const [k, d] of Object.entries(te.drivers)) {
      if (!isTable(d)) continue;
      drivers[k] = {
        ...(typeof d.baseUrl === "string" ? { baseUrl: d.baseUrl } : {}),
        ...(typeof d.apiKeyEnv === "string" ? { apiKeyEnv: d.apiKeyEnv } : {}),
        ...(typeof d.system === "string" ? { system: d.system } : {}),
        ...(typeof d.maxOutputTokens === "number" ? { maxOutputTokens: d.maxOutputTokens } : {}),
        ...(typeof d.temperature === "number" ? { temperature: d.temperature } : {}),
        ...(strs(d.flags) ? { flags: strs(d.flags) } : {}),
      };
    }
  }
  return {
    targets,
    variants,
    tasks,
    ...(heldoutDir ? { heldoutDir } : {}),
    confirmAboveUsd: numOr(te.confirmAboveUsd, 5),
    trialUsdEstimate: numOr(te.trialUsdEstimate, 0.1),
    ...(typeof te.rewriter === "string" ? { rewriter: te.rewriter } : {}),
    prices,
    drivers,
    problems,
  };
}

/** `agent:claude-code`, `agent:codex:gpt-6-sol`, `model:anthropic/claude-sonnet-5-5`. */
export function parseDriver(s: string, cfg: Record<string, DriverConfig> = {}): Driver {
  const c = cfg[s] ?? {};
  if (s.startsWith("agent:")) {
    const [, agent, ...model] = s.split(":");
    if (!agent) throw new ToolEvalsConfigError(`driver ${JSON.stringify(s)}: missing agent id`);
    const m = model.join(":");
    return { kind: "agent", agent, ...(m ? { model: m } : {}), ...(c.flags ? { flags: c.flags } : {}) };
  }
  const m = /^model:(anthropic|openai|openai-chat)\/(.+)$/.exec(s);
  if (!m) throw new ToolEvalsConfigError(`driver ${JSON.stringify(s)} must be agent:<adapter>[:model] or model:<anthropic|openai|openai-chat>/<model>`);
  const provider = m[1] as "anthropic" | "openai" | "openai-chat";
  return {
    kind: "model",
    provider,
    model: m[2]!,
    apiKeyEnv: c.apiKeyEnv ?? (provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"),
    ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
    ...(c.system ? { system: c.system } : {}),
    ...(c.maxOutputTokens !== undefined ? { maxOutputTokens: c.maxOutputTokens } : {}),
    ...(c.temperature !== undefined ? { temperature: c.temperature } : {}),
  };
}
