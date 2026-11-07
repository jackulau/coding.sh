// Helpers shared by command modules (loaded only after dispatch).
import { existsSync } from "node:fs";
import { openContext, type Context } from "../core/context.ts";
import type { EvalTask, Session } from "../core/types.ts";
import { UsageError, type FlagValue } from "./args.ts";
import { CliError } from "./output.ts";
import type { CommandContext } from "./types.ts";

export async function withContext<T>(c: CommandContext, fn: (ctx: Context) => Promise<T>): Promise<T> {
  let ctx: Context;
  try {
    ctx = await openContext({ env: c.env, cwd: c.cwd });
  } catch (e) {
    throw new CliError(`Couldn't open the coding.sh store: ${e instanceof Error ? e.message : String(e)}`, {
      reason: "store_unavailable",
      next: ["Check the [store] section of the config:", "coding.sh config path"],
    });
  }
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

/**
 * Drains pending hook events before a read so `sessions`/`show` see what was
 * just captured. Skips quietly when another ingest holds the lock.
 */
export async function autoIngest(ctx: Context): Promise<void> {
  // A remote store (--store / CODING_SH_STORE_URL) is read as is: never push this machine's spool into it.
  if (ctx.storeOverridden) return;
  if (existsSync(ctx.paths.spool)) {
    try {
      await ctx.ingest({ lock: { waitMs: 1500 } });
    } catch (e) {
      if ((e as Error).name !== "LockBusyError") throw e;
    }
  }
  await tailIngest(ctx);
}

/** Imports from adapters whose store is a capture path (Adapter.tail). Never fails a read. */
export async function tailIngest(ctx: Context): Promise<void> {
  try {
    const { ADAPTERS } = await import("../adapters/index.ts");
    const agents = ADAPTERS.filter((a) => a.tail?.()).map((a) => a.id);
    if (agents.length) await ctx.backfill({ agents });
    // Agents whose hooks are installed but not firing yet: their transcripts
    // are the capture path until they are (a fresh `init` with Codex).
    for (const a of ADAPTERS) {
      const t = a.tailWhenUnhooked?.();
      if (t) await ctx.backfill({ agents: [a.id], ...(t.since !== undefined ? { since: t.since } : {}) });
    }
  } catch {
    // a broken third-party store must not break `coding.sh sessions`
  }
}

/**
 * A task by id, else by its unique name (`eval new --name` is what users
 * remember; the id is a hash). Never prefix-matches.
 */
export async function resolveTask(ctx: Context, ref: string): Promise<EvalTask> {
  const byId = await ctx.index.getTask(ref);
  if (byId) return byId;
  const named = (await ctx.index.listTasks()).filter((t) => t.name === ref);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new CliError(`${named.length} tasks are named ${JSON.stringify(ref)}`, { reason: "ambiguous", next: ["Pass one of their ids:", ...named.map((t) => t.id)] });
  }
  throw new CliError(`Can't find task ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List tasks:", "coding.sh eval list"] });
}

/** Exact session id, or "latest" (newest top-level session). Never prefix-matches. */
export async function resolveSession(ctx: Context, id: string): Promise<Session> {
  if (id === "latest" || id === "last") {
    const [s] = await ctx.index.listSessions({ limit: 1, parentSessionId: null });
    if (!s) throw new CliError("No sessions captured yet", { reason: "not_found", next: ["Install capture hooks:", "coding.sh init"] });
    return s;
  }
  const s = await ctx.index.getSession(id);
  if (!s) throw new CliError(`Can't find session ${JSON.stringify(id)}`, { reason: "not_found", next: ["List sessions:", "coding.sh sessions"] });
  return s;
}

export function str(v: FlagValue): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function list(v: FlagValue): string[] {
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}

export function num(v: FlagValue): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** `--port` as a TCP port (0 = any free port), else a usage error. */
export function port(v: FlagValue, fallback: number): number {
  const p = num(v) ?? fallback;
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw new UsageError(`--port must be 0-65535, got ${p}`);
  return p;
}

/**
 * Consent for writes outside coding.sh's own data (agent configs): `--yes`,
 * or an interactive y/N. Non-interactive without --yes fails with
 * confirmation_required (exit 2) and writes nothing.
 */
export async function requireConsent(c: CommandContext, question: string, rerun: string, opts: { defaultYes?: boolean } = {}): Promise<void> {
  if (c.flags.yes === true) return;
  if (!c.out.interactive) {
    throw new UsageError(`${question.replace(/\?$/, "")} needs confirmation. Pass --yes to confirm`, { reason: "confirmation_required", suggestion: rerun });
  }
  if (!(await c.out.confirm(question, opts))) throw new CliError("Canceled. Nothing was changed", { reason: "canceled", exitCode: 130 });
}

/** Parses JSON from an inline string or a path to a .json file. */
export async function jsonArg(v: string, what: string): Promise<unknown> {
  const t = v.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t) as unknown;
    } catch (e) {
      throw new UsageError(`${what} is not valid JSON: ${(e as Error).message}`);
    }
  }
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(v, "utf8");
  } catch {
    throw new UsageError(`${what} must be JSON or a path to a JSON file; can't read ${JSON.stringify(v)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new UsageError(`${v} is not valid JSON: ${(e as Error).message}`);
  }
}

/** First line, whitespace-folded and cut to n chars. */
export function oneLine(s: string | undefined, n = 80): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function sessionJson(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    agent: s.agent,
    ...(s.provider ? { provider: s.provider } : {}),
    ...(s.project ? { project: s.project } : {}),
    title: s.title ?? null,
    model: s.model ?? null,
    cwd: s.cwd ?? null,
    repo: s.repo?.root ?? null,
    branch: s.repo?.branch ?? null,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: s.endedAt !== undefined ? new Date(s.endedAt).toISOString() : null,
    durationMs: s.endedAt !== undefined ? s.endedAt - s.startedAt : null,
    parentSessionId: s.parent?.sessionId ?? null,
    flags: s.flags,
    stats: s.stats,
  };
}
