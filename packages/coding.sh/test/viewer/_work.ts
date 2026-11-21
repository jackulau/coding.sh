// A small work queue for the viewer's Work page tests: one item in each bucket, a hidden
// done item and one outside the 7-day window. Times are whole minutes before `now`, so
// the "for 2m" in a reason only changes when a run takes 30 seconds between reads.
import type { Session } from "../../src/core/types.ts";
import { mkSession } from "../cli/_cmd.ts";

const MIN = 60e3;
type Extra = NonNullable<Parameters<typeof mkSession>[2]>;
type Stats = Extra["stats"];

export function workSessions(now: number): Session[] {
  const s = (id: string, startAgo: number, extra: Extra = {}): Session => mkSession(id, now - startAgo, { cwd: "/work/demo", ...extra });
  return [
    s("blocked", 5 * MIN, {
      endedAt: undefined,
      title: "publish the package",
      stats: { latency: { wallMs: 4 * MIN }, usage: { costUsd: 1.25 }, waiting: { kind: "permission", at: now - 2 * MIN, toolUseId: "t1", text: "Claude needs your permission to use Bash" } } as Stats,
    }),
    s("blocked:sub:a1", 4 * MIN, { endedAt: undefined, parent: { sessionId: "blocked", subagentId: "a1" }, stats: { latency: { wallMs: 3 * MIN } } as Stats }),
    s("failed", 50 * MIN, { agent: "codex", cwd: "/work/api", title: "migrate the tests", endedAt: now - 20 * MIN, stats: { testsFailed: 2 } as Stats }),
    s("stalled", 90 * MIN, { endedAt: undefined, cwd: "/work/api", title: "refactor the parser", stats: { latency: { wallMs: 50 * MIN } } as Stats }),
    s("turn", 25 * MIN, { title: "explain the cache", endedAt: now - 10 * MIN, stats: { waiting: { kind: "turn", at: now - 10 * MIN } } as Stats }),
    s("review", 30 * MIN, { agent: "gemini-cli", title: "fix the flaky test", stats: { filesChanged: 1 } }),
    s("done", 60 * MIN, { title: "read the docs" }),
    s("old", 30 * 86400e3, { stats: { filesChanged: 1 } }),
  ];
}
