import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MAX_DATE_MS } from "../../src/core/dates.ts";
import { emptyOverlay, readOverlay } from "../../src/core/work-overlay.ts";
import { buildWorkQueue, workJson } from "../../src/core/work.ts";
import type { Session } from "../../src/schema/index.ts";

const root = mkdtempSync(join(tmpdir(), "csh-work-range-"));
after(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-11-20T12:00:00Z");
const FAR = MAX_DATE_MS + 1;

const session = (id: string, startedAt: number, waitingAt: number): Session => ({
  id,
  agent: "claude-code",
  cwd: "/work/demo",
  startedAt,
  flags: [],
  stats: { events: 4, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0, waiting: { kind: "permission", at: waitingAt, toolUseId: "t1" } },
});

describe("work overlay and queue date range handling", () => {
  it("readOverlay leaves out snoozes whose until time falls outside the Date range and keeps valid ones", () => {
    const file = join(root, "work.json");
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        acks: {},
        snoozes: {
          "s-far": { until: FAR, bucket: "blocked" },
          "s-ok": { until: NOW + 3600_000, bucket: "blocked" },
        },
      }),
    );
    const o = readOverlay(file);
    assert.equal(o.snoozes["s-far"], undefined);
    assert.equal(o.snoozes["s-ok"]?.until, NOW + 3600_000);
  });

  it("buildWorkQueue and workJson handle an out-of-range snooze and session time while keeping other items", () => {
    const sFar = session("s-far", FAR, FAR);
    const sOk = session("s-ok", NOW - 300_000, NOW - 60_000);
    const overlay = emptyOverlay();
    overlay.snoozes[sFar.id] = { until: 1e300, bucket: "blocked" };

    const q = buildWorkQueue([sFar, sOk], { now: NOW, overlay, all: true });
    assert.equal(q.items.length, 2);
    const farItem = q.items.find((i) => i.primaryId === sFar.id)!;
    const okItem = q.items.find((i) => i.primaryId === sOk.id)!;
    assert.equal(farItem.next, "snoozed");
    assert.equal(okItem.bucket, "blocked");

    const doc = workJson(q, { since: NOW - 86_400_000, limit: 10 }) as { items: Record<string, unknown>[] };
    const farJson = doc.items.find((i) => i.sessionId === sFar.id)!;
    const okJson = doc.items.find((i) => i.sessionId === sOk.id)!;
    assert.equal("startedAt" in farJson, false);
    assert.equal(okJson.startedAt, new Date(sOk.startedAt).toISOString());
  });
});
