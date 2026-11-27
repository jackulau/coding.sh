import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { after, describe, it } from "node:test";
import { MAX_DATE_MS } from "../../src/core/dates.ts";
import type { Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { renderSessionsMain } from "../../src/viewer/ssr.ts";
import { WorkApiError, workShow, workSnooze } from "../../src/viewer/work.ts";

const root = mkdtempSync(join(tmpdir(), "csh-viewer-range-"));
after(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-20T12:00:00Z");
const FAR = MAX_DATE_MS + 1;
const PAST = -MAX_DATE_MS - 1;

describe("viewer SSR and page date range handling", () => {
  it("renderSessionsMain leaves an out-of-range startedAt blank and keeps other sessions", () => {
    const mk = (id: string, startedAt: number): Session => ({
      id,
      agent: "claude-code",
      title: `Session ${id}`,
      startedAt,
      flags: [],
      stats: { events: 2, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 },
    });
    const html = renderSessionsMain([mk("far", FAR), mk("past", PAST), mk("ok", NOW - 300_000)], 3, NOW);
    assert.ok(html.includes("Session far"));
    assert.ok(html.includes("Session past"));
    assert.ok(html.includes("Session ok"));
    assert.ok(!html.includes("Invalid Date"), html);
    assert.ok(html.includes("5m ago"));
  });

  it("viewer ui/index.html helpers read out-of-range times as missing", () => {
    const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
    const slice = (from: string, to: string) => {
      const a = html.indexOf(from);
      const b = html.indexOf(to, a);
      assert.ok(a >= 0 && b > a, `markers ${from} .. ${to}`);
      return html.slice(a, b);
    };
    const code = [
      slice("const MAX_DATE_MS =", "function repoDir("),
      slice("function axisLabels(", "function sessionList("),
      slice("function ymd(", "function niceAxis("),
      "({ dateMs, isoMs, fmtLocale, fmtClockTime, fmtLocaleDate, fmtRel, fmtDate, fmtDay, fmtDayRange, axisLabels, ymd })",
    ].join("\n");
    const ui = runInNewContext(code, { Intl, Date, String, Number, Math, isFinite, RegExp }) as Record<string, (...a: unknown[]) => unknown>;
    for (const bad of [FAR, PAST, 1e300, NaN]) {
      assert.equal(ui.dateMs!(bad), undefined);
      assert.equal(ui.isoMs!(bad), undefined);
      assert.equal(ui.fmtLocale!(bad), "");
      assert.equal(ui.fmtClockTime!(bad), "");
      assert.equal(ui.fmtLocaleDate!(bad), "");
      assert.equal(ui.fmtRel!(bad), "");
      assert.equal(ui.fmtDate!(bad), "");
      assert.equal(ui.fmtDay!(bad), "");
      assert.equal(ui.fmtDayRange!(bad, NOW), "");
      assert.equal(ui.ymd!(bad), "");
    }
    assert.deepEqual(ui.axisLabels!([PAST, NOW]), ["", ui.fmtDay!(NOW)]);
    const farAxis = ui.axisLabels!([FAR, NOW]) as string[];
    assert.equal(farAxis[0], "");
    assert.ok(farAxis[1]!.length > 0);
    assert.equal(ui.isoMs!(NOW), new Date(NOW).toISOString());
    assert.ok(String(ui.fmtDate!(NOW)).length > 0);
    // All inline <time datetime> and started fact calls use isoMs rather than raw new Date(...).toISOString().
    assert.equal(html.includes(".toISOString()"), true);
    assert.equal((html.match(/\.toISOString\(\)/g) ?? []).length, 1);
  });
});

describe("viewer/work date range handling", () => {
  it("workShow sets out-of-range workflowAgent startedAt to null and workSnooze rejects out-of-range duration", async () => {
    const index = new MemoryIndexStore();
    const parent: Session = {
      id: "wf-parent",
      agent: "claude-code",
      cwd: "/work/demo",
      startedAt: NOW - 3600_000,
      flags: [],
      stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
    };
    const a1: Session = {
      id: "wf-a1",
      agent: "claude-code",
      cwd: "/work/demo",
      parent: { sessionId: parent.id, workflowId: "wf1", phase: "build", label: "far-agent" },
      startedAt: FAR,
      flags: [],
      stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
    };
    const a2: Session = {
      id: "wf-a2",
      agent: "claude-code",
      cwd: "/work/demo",
      parent: { sessionId: parent.id, workflowId: "wf1", phase: "build", label: "ok-agent" },
      startedAt: NOW - 120_000,
      endedAt: NOW - 60_000,
      flags: [],
      stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
    };
    await index.upsertSession(parent);
    await index.upsertSession(a1);
    await index.upsertSession(a2);

    const src = { overlay: join(root, "work.json"), now: () => NOW };
    const { workItemId, workflowRunKey } = await import("../../src/core/work.ts");
    const runItemId = workItemId(workflowRunKey(parent.id, "wf1"));
    const shown = (await workShow(index, src, runItemId, new URLSearchParams("since=7d"))) as { workflowAgents: { sessionId: string; startedAt: string | null }[] };
    const farAgent = shown.workflowAgents.find((a) => a.sessionId === a1.id)!;
    const okAgent = shown.workflowAgents.find((a) => a.sessionId === a2.id)!;
    assert.equal(farAgent.startedAt, null);
    assert.equal(okAgent.startedAt, new Date(a2.startedAt).toISOString());

    await assert.rejects(
      workSnooze(index, src, new URLSearchParams("since=7d"), { id: runItemId, duration: "999999999999999d" }),
      (e: unknown) => e instanceof WorkApiError && e.status === 400,
    );
  });
});
