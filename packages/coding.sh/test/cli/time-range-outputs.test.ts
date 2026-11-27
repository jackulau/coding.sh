import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MAX_DATE_MS } from "../../src/core/dates.ts";
import { resolveSession, sessionJson, windowJson, windowNote } from "../../src/cli/common.ts";
import { jobJson } from "../../src/cli/jobs.ts";
import { ago, CliError, localTime, Output } from "../../src/cli/output.ts";
import { clock } from "../../src/cli/commands/diff-calls.ts";
import * as harness from "../../src/cli/commands/harness.ts";
import { changeJson } from "../../src/cli/commands/improve.ts";
import { openContext } from "../../src/core/context.ts";
import { paths } from "../../src/core/paths.ts";
import { mkSession, runCmd, sandbox } from "./_cmd.ts";

const T0 = Date.parse("2026-11-01T10:00:00Z");
const FAR = MAX_DATE_MS + 1;
const PAST = -MAX_DATE_MS - 1;

describe("CLI output and common formatting date range handling", () => {
  it("localTime and ago return '-' for times outside the Date range and keep valid times", () => {
    for (const bad of [FAR, PAST, 1e300, -1e300, NaN]) {
      assert.equal(localTime(bad, T0), "-");
      assert.equal(ago(bad, { now: T0 }), "-");
    }
    assert.equal(ago(T0 - 30_000, { now: T0 }), "30s ago");
    assert.ok(localTime(T0, T0).length > 1);
  });

  it("sessionJson returns null for out-of-range startedAt/endedAt and keeps valid sessions intact", () => {
    const far = sessionJson(mkSession("s-far", FAR, { endedAt: 1e300 }));
    assert.equal(far.startedAt, null);
    assert.equal(far.endedAt, null);
    assert.equal(far.durationMs, null);
    const ok = sessionJson(mkSession("s-ok", T0, { endedAt: T0 + 2_000 }));
    assert.equal(ok.startedAt, "2026-11-01T10:00:00.000Z");
    assert.equal(ok.endedAt, "2026-11-01T10:00:02.000Z");
    assert.equal(ok.durationMs, 2_000);
  });

  it("windowJson and windowNote omit out-of-range bounds cleanly", () => {
    const j = windowJson({ since: FAR, until: PAST, local: true }, T0);
    assert.equal("since" in j, false);
    assert.equal("until" in j, false);
    assert.match(j.utcOffset, /^[+-]\d{2}:\d{2}$/);
    let stderr = "";
    const out = new Output({ stderr: { write: (s: string) => ((stderr += s), true), isTTY: false } });
    windowNote(out, { since: FAR, until: PAST, local: true });
    assert.equal(stderr, "");
  });

  it("resolveSession ambiguous candidate data returns null for an out-of-range startedAt and keeps valid ones", async () => {
    const sb = sandbox();
    try {
      await sb.seed([mkSession("shared-far", FAR), mkSession("shared-ok", T0)]);
      const ctx = await openContext({ env: sb.env });
      try {
        await assert.rejects(
          resolveSession(ctx, "shared-"),
          (e: unknown) => {
            assert.ok(e instanceof CliError);
            const candidates = (e.data as { candidates: { id: string; startedAt: string | null }[] }).candidates;
            assert.equal(candidates.length, 2);
            assert.equal(candidates.find((c) => c.id === "shared-far")!.startedAt, null);
            assert.equal(candidates.find((c) => c.id === "shared-ok")!.startedAt, "2026-11-01T10:00:00.000Z");
            return true;
          },
        );
      } finally {
        await ctx.close();
      }
    } finally {
      sb.cleanup();
    }
  });

  it("jobJson returns null for out-of-range createdAt and updatedAt", () => {
    const j = jobJson({
      header: {
        id: "j1",
        kind: "exp run",
        name: "demo",
        createdAt: FAR,
        updatedAt: PAST,
        concurrency: 1,
        sessions: [],
        config: { hash: "abcdef0123456789", spec: {} },
        refs: {},
      } as never,
      progress: { done: 1, total: 2, infra: 0, retries: 0, costUsd: 0, costKnown: false, activeMs: 100 },
      status: "incomplete",
    } as never);
    assert.equal(j.createdAt, null);
    assert.equal(j.updatedAt, null);
  });

  it("diff-calls clock returns '-' for out-of-range timestamps", () => {
    assert.equal(clock(FAR), "-");
    assert.equal(clock(PAST), "-");
    assert.match(clock(T0), /^\d{2}:\d{2}:\d{2}$/);
  });

  it("harness bundleJson and improve changeJson/groupJson return null for out-of-range times", () => {
    const b = harness.bundleJson({ id: "b1", name: "n", agent: "claude-code", flags: [], env: {}, files: {}, remove: [], createdAt: FAR });
    assert.equal(b.createdAt, null);

    const c = changeJson({
      change: { commit: "abc1234", short: "abc1234", at: FAR, subject: "Edit CLAUDE.md", files: ["CLAUDE.md"], added: [], removed: [] },
      verdict: "no-signal",
      reason: "few sessions",
      before: { sessions: 1, flagged: 1, flaggedSessions: [{ id: "s1", startedAt: PAST, flags: ["looping"] }] } as never,
      after: { sessions: 1, flagged: 1, flaggedSessions: [{ id: "s2", startedAt: T0, flags: ["looping"] }] } as never,
      rules: [],
    } as never);
    assert.equal(c.at, null);
    assert.equal(c.before.flaggedSessions[0]!.at, null);
    assert.equal(c.after.flaggedSessions[0]!.at, "2026-11-01T10:00:00.000Z");
  });
});

describe("harness tools JSON date range handling", () => {
  const sb = sandbox();
  after(() => sb.cleanup());

  it("returns null for out-of-range pinned.at and firstSeen/lastSeen while keeping valid tools", async () => {
    const now = Date.now();
    const s = mkSession("s-proxy", now - 60_000);
    mkdirSync(sb.env.CODING_SH_HOME!, { recursive: true });
    const ctx = await openContext({ env: sb.env });
    let toolsRef: string;
    try {
      toolsRef = await ctx.blobs.put(Buffer.from(JSON.stringify([{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }])));
    } finally {
      await ctx.close();
    }
    await sb.seed(
      [s],
      [
        {
          id: "call-1",
          v: 0,
          sessionId: s.id,
          ts: now - 30_000,
          agent: "claude-code",
          source: "proxy",
          kind: "llm.call",
          payload: { toolsRef },
        },
      ],
    );
    writeFileSync(
      paths(sb.env).toolPins,
      JSON.stringify({
        v: 1,
        tools: {
          "builtin/removed_tool": { descSha: "aaa", schemaSha: "bbb", at: PAST },
        },
      }),
    );
    const r = await runCmd(harness, sb, { action: "tools", json: true });
    assert.equal(r.error, undefined);
    assert.equal(r.code, 0);
    const tools = r.json.tools as { tool: string; firstSeen: string | null; pinned?: { at: string | null } }[];
    const removed = tools.find((t) => t.tool === "removed_tool")!;
    const active = tools.find((t) => t.tool === "read_file")!;
    assert.equal(removed.pinned?.at, null);
    assert.equal(removed.firstSeen, null);
    assert.equal(typeof active.firstSeen, "string");
  });
});
