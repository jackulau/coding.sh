import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MAX_DATE_MS } from "../../src/core/dates.ts";
import { writeCorpusDir } from "../../src/refine/corpus.ts";
import { flagFindings } from "../../src/refine/findings.ts";
import { flagMined } from "../../src/refine/mine.ts";
import { signalFindings, type SignalsDoc } from "../../src/refine/signals.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";

const root = mkdtempSync(join(tmpdir(), "csh-refine-range-"));
after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-01T10:00:00Z");
const FAR = MAX_DATE_MS + 1;

const flagged = (id: string, startedAt: number): Session => ({
  id,
  agent: "claude-code",
  startedAt,
  flags: ["looping"],
  stats: { events: 2, turns: 1, toolCalls: 2, toolErrors: 1, filesChanged: 0 },
});

describe("refine date range handling", () => {
  it("writeCorpusDir leaves out out-of-range event timestamps and keeps valid ones", async () => {
    const index = new MemoryIndexStore();
    const s = flagged("s-corp", T0);
    await index.upsertSession(s);
    const evs: AgentEvent[] = [
      { id: "e1", v: 0, sessionId: s.id, ts: FAR, agent: "claude-code", kind: "user.message", payload: { text: "far event" } },
      { id: "e2", v: 0, sessionId: s.id, ts: T0, agent: "claude-code", kind: "assistant.message", payload: { text: "ok event" } },
    ];
    await index.putEvents(evs);
    const dir = join(root, "corpus");
    await writeCorpusDir({ dir, index, source: { kind: "sessions", since: T0 - 1000 }, prompt: [] });
    const ep = readdirSync(join(dir, "episodes"))[0]!;
    const md = readFileSync(join(dir, "episodes", ep, "transcript.md"), "utf8");
    assert.ok(md.includes("### 1. assistant.message at 2026-11-01T10:00:00.000Z"), md);
    assert.ok(md.includes("### 2. user.message\n\n"), md);
  });

  it("flagFindings, flagMined and signalFindings leave out-of-range days out of the day count", () => {
    const ss = [flagged("s1", T0), flagged("s2", FAR), flagged("s3", -MAX_DATE_MS - 1)];
    const ff = flagFindings(ss);
    assert.equal(ff.length, 1);
    assert.equal(ff[0]!.support.sessions, 3);
    assert.equal(ff[0]!.support.days, 1);

    const mf = flagMined(ss);
    assert.equal(mf.length, 1);
    assert.equal(mf[0]!.support.sessions, 3);
    assert.equal(mf[0]!.support.days, 1);

    const comp = { type: "harness" as const, name: "a" };
    const doc: SignalsDoc = {
      version: 1,
      catalog: "c1",
      sessions: {
        s1: { agent: "claude-code", repo: "/work/demo", startedAt: T0, status: "problems" },
        s2: { agent: "claude-code", repo: "/work/demo", startedAt: 1e300, status: "problems" },
      },
      signals: [
        {
          id: "sig1",
          key: "k1",
          title: "Looping",
          component: comp,
          typeIds: ["loop"],
          natures: ["inefficiency"],
          status: "open",
          firstSeen: T0,
          lastSeen: T0,
          analyzedSinceLastSeen: 0,
          population: { affected: 2, analyzed: 2 },
          severity: { score: 50, level: "high", drivingNature: "inefficiency", parts: [], population: { affected: 2, analyzed: 2 } },
          occurrences: [
            { id: "o1", sessionId: "s1", component: comp, typeIds: ["loop"], nature: "inefficiency", factor: 1, explanation: "a", evidence: [] },
            { id: "o2", sessionId: "s2", component: comp, typeIds: ["loop"], nature: "inefficiency", factor: 1, explanation: "b", evidence: [] },
          ],
        },
      ],
    };
    const sf = signalFindings(doc);
    assert.equal(sf.length, 1);
    assert.equal(sf[0]!.support.sessions, 2);
    assert.equal(sf[0]!.support.days, 1);
  });
});
