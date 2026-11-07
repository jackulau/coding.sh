// A small SQLite store under a throwaway CODING_SH_HOME, and the CLI run against it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Label } from "../../src/core/types.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

export const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
export const T0 = Date.parse("2026-11-01T10:00:00Z");

export function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    agent: "claude-code",
    startedAt: T0,
    endedAt: T0 + 60_000,
    title: `session ${id}`,
    stats: { events: 2, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 } },
    flags: [],
    ...over,
  };
}

export function event(sessionId: string, n: number, over: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `${sessionId}-e${n}`, v: 0, sessionId, ts: T0 + n * 1000, agent: "claude-code", kind: "user.message", payload: { text: `hello ${n}` }, ...over };
}

export interface Seed {
  sessions?: Session[];
  events?: AgentEvent[];
  labels?: Label[];
}

/** Writes the rows into `<dataHome>/index.db` (the default store). */
export async function seed(dataHome: string, s: Seed): Promise<string> {
  const path = join(dataHome, "index.db");
  const store = await SqliteIndexStore.open(path);
  try {
    if (s.events?.length) await store.putEvents(s.events);
    for (const x of s.sessions ?? []) await store.upsertSession(x);
    for (const l of s.labels ?? []) await store.putLabel(l);
  } finally {
    await store.close();
  }
  return path;
}

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI from source with the test's env (HOME and CODING_SH_HOME already point at temp dirs). */
export function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}, input?: string): Run {
  const env = { ...process.env, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1", TZ: "UTC", ...extraEnv };
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", ...(input !== undefined ? { input } : {}) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function ok(args: string[], extraEnv: NodeJS.ProcessEnv = {}, input?: string): Run {
  const r = cli(args, extraEnv, input);
  assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  return r;
}
