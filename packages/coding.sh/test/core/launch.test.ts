// Headless sessions (`claude -p`, `codex exec`, an Agent SDK) are told apart from
// interactive ones: stats.launch, from the start's entrypoint (Claude Code) or
// originator and launch source (Codex), on real captures and live hook lines.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { codex } from "../../src/adapters/codex.ts";
import { toMetadata } from "../../src/core/redact.ts";
import { buildSession, launchOf } from "../../src/core/sessions.ts";
import type { SpoolLine } from "../../src/core/types.ts";
import { matchesSession } from "../../src/query/match.ts";
import { parseWhere } from "../../src/query/where.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { collect, FIXTURES, testCtx, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";

const sessions = (events: AgentEvent[]) => {
  const ids = [...new Set(events.map((e) => e.sessionId))];
  return new Map(ids.map((id) => [id, buildSession(events.filter((e) => e.sessionId === id))]));
};

describe("launchOf", () => {
  it("reads Claude Code's entrypoint and Codex's originator and launch source", () => {
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{ entrypoint: "sdk-cli" }, "headless"],
      [{ entrypoint: "sdk-ts" }, "headless"],
      [{ entrypoint: "sdk-py" }, "headless"],
      [{ entrypoint: "cli" }, "interactive"],
      [{ entrypoint: "claude-vscode" }, "interactive"],
      [{ entrypoint: "mystery" }, undefined],
      [{ originator: "codex_exec", launch: "exec" }, "headless"],
      [{ launch: "mcp" }, "headless"],
      [{ originator: "codex_sdk_ts" }, "headless"],
      [{ originator: "codex_cli_rs", launch: "cli" }, "interactive"],
      [{ launch: "vscode" }, "interactive"],
      [{ originator: "t3code" }, undefined],
      [{ source: "startup" }, undefined],
      [{}, undefined],
    ];
    for (const [p, want] of cases) assert.equal(launchOf(p), want, JSON.stringify(p));
  });
});

describe("stats.launch", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
  });
  after(() => env.restore());

  it("real `claude -p` transcripts are headless", async () => {
    for (const dir of ["real", "hooks-real"]) {
      process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", dir, "config");
      const all = sessions(await collect(claudeCode.backfill!(testCtx().ctx)));
      assert.ok(all.size > 0);
      for (const s of all.values()) assert.equal(s.stats.launch, "headless", `${dir} ${s.id}`);
    }
  });

  it("Codex rollouts: codex exec is headless, the TUI interactive", async () => {
    process.env.CODEX_HOME = join(FIXTURES, "codex", "home");
    const all = sessions(await collect(codex.backfill!(testCtx().ctx)));
    assert.equal(all.get("0193aaaa-1111-7222-8333-444455556666")?.stats.launch, "headless");
    assert.equal(all.get("0193cccc-1111-7222-8333-444455556666")?.stats.launch, "interactive");
  });

  it("live: a Claude Code SessionStart hook line carries the entrypoint", async () => {
    const { ctx } = testCtx();
    const line = (entrypoint?: string): SpoolLine => ({ v: 0, agent: "claude-code", event: "SessionStart", ts: 1_800_000_000_000, pid: 1, cwd: "/work/demo", raw: { session_id: `s-${entrypoint}`, hook_event_name: "SessionStart", source: "startup" }, ...(entrypoint ? { entrypoint } : {}) });
    const launch = async (entrypoint?: string) => buildSession(await claudeCode.normalize(line(entrypoint), ctx)).stats.launch;
    assert.equal(await launch("sdk-cli"), "headless");
    assert.equal(await launch("cli"), "interactive");
    assert.equal(await launch(undefined), undefined, "absent when the hook did not say");
  });

  it("live: a Codex SessionStart hook reads the launch from the rollout's session_meta", async () => {
    const { ctx } = testCtx();
    const rollout = join(FIXTURES, "codex", "home", "sessions", "2026", "11", "01", "rollout-2026-11-01T10-00-00-0193aaaa-1111-7222-8333-444455556666.jsonl");
    const line: SpoolLine = { v: 0, agent: "codex", event: "SessionStart", ts: 1_800_000_000_000, pid: 1, cwd: "/work/demo", raw: { session_id: "0193aaaa-1111-7222-8333-444455556666", hook_event_name: "SessionStart", source: "startup", transcript_path: rollout } };
    const events = await codex.normalize(line, ctx);
    const start = events.find((e) => e.kind === "session.start")!;
    assert.deepEqual([start.payload.originator, start.payload.launch], ["codex_exec", "exec"]);
    assert.equal(buildSession(events).stats.launch, "headless");
    // Metadata mode keeps it.
    assert.equal(buildSession(events.map(toMetadata)).stats.launch, "headless");
    const missing = await codex.normalize({ ...line, raw: { ...(line.raw as object), transcript_path: "/nonexistent/rollout.jsonl" } }, ctx);
    assert.equal(buildSession(missing).stats.launch, undefined);
  });

  it("--where launch:headless matches on stats.launch", () => {
    const s = buildSession([{ id: "e1", v: 0, sessionId: "s", ts: 1, agent: "claude-code", kind: "session.start", payload: { entrypoint: "sdk-cli" } }]);
    const match = (q: string) => matchesSession(parseWhere(q).root, s, () => []);
    assert.ok(match("launch:headless"));
    assert.ok(!match("launch:interactive"));
    assert.ok(match("-launch:interactive"));
  });
});
