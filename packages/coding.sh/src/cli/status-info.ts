// What `coding.sh status` and the MCP status tool both say about a home and its store: the
// update the update checker's cache names (read only, no network), how old the index is, and
// when each agent last captured a session. The MCP server imports this module; the CLI never
// imports the MCP server.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../core/context.ts";
import { indexAge, indexAgeField, type IndexAge } from "../core/ingest-health.ts";
import type { Session } from "../core/types.ts";
import { iso, lastActivity } from "../mcp/data.ts";
import { isNewer } from "../update/semver.ts";
import { version } from "./meta.ts";
import { nextStepBin } from "./next-steps.ts";

type Obj = Record<string, unknown>;

function readUpdateCache(file: string): Obj | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Update availability from the cache the update checker keeps (no network here).
 * `command` names the CLI the way the user's shell runs it (nextStepBin of `env`:
 * for the MCP server, the environment the agent started it with).
 */
export function updateInfo(home: string, current = version(), env: NodeJS.ProcessEnv = process.env): Obj {
  const c = readUpdateCache(join(home, "update.json"));
  const latest = typeof c?.latest === "string" ? c.latest : undefined;
  const available = isNewer(latest, current);
  const install = typeof c?.install === "string" ? c.install : undefined;
  return {
    current,
    latest,
    available,
    checkedAt: typeof c?.checkedAt === "number" ? iso(c.checkedAt) : undefined,
    url: available && typeof c?.url === "string" ? c.url : undefined,
    install: available && install ? `npm install -g ${install}` : undefined,
    command: available ? `${nextStepBin(env)} update` : undefined,
  };
}

/**
 * The index's age (core/ingest-health.ts). A store named by --store or CODING_SH_STORE_URL is
 * filled elsewhere, so this home's record says nothing about it: undefined then, as `coding.sh
 * work` does.
 */
export function storeIndexAge(ctx: Pick<Context, "storeOverridden" | "paths">, now = Date.now()): IndexAge | undefined {
  return ctx.storeOverridden ? undefined : indexAge(ctx.paths.root, now);
}

/** `index: { updatedAt, stale?, ageMs }`, absent without a record. */
export function indexField(age: IndexAge | undefined): { index?: Obj } {
  const f = indexAgeField(age);
  return f.index && age ? { index: { ...f.index, ageMs: age.ageMs } } : {};
}

/** One agent's last capture: its session that was active last. `at` is that session's last activity. */
export interface LastCapture {
  agent: string;
  at?: string;
  sessionId: string;
  shortId: string;
}

/**
 * Agent names in code unit order, as `last24h.agents` sorts them. Not localeCompare: its first call
 * loads the ICU collator, about 10 ms that `coding.sh status` would pay on every run.
 */
export const byAgent = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/**
 * One row per agent, sorted by agent: the session with the latest activity (lastActivity) among
 * `sessions` that started at or after `since`, subagents included. Both callers pass the sessions
 * readWorkQueue read for the work window (core/work.ts WORK_WINDOW_MS, 7 days), so status reads
 * them once; that read also holds parents that started before `since`, which are skipped here.
 */
export function lastCaptures(sessions: readonly Session[], since: number, shortId: (id: string) => string): LastCapture[] {
  const last = new Map<string, Session>();
  for (const s of sessions) {
    if (s.startedAt < since) continue;
    const prev = last.get(s.agent);
    if (!prev || lastActivity(s) > lastActivity(prev)) last.set(s.agent, s);
  }
  return [...last]
    .sort((x, y) => byAgent(x[0], y[0]))
    .map(([agent, s]) => ({ agent, at: iso(lastActivity(s)), sessionId: s.id, shortId: shortId(s.id) }));
}
