// Schema v9: labels move into scores, and the labels view reads them back.
// Existing labels round-trip and judge calibration gives the same report.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Label } from "../../src/core/types.ts";
import type { Split } from "../../src/datasets/types.ts";
import { calibrate, labelsFromCore, type JudgedCase } from "../../src/judge/calibrate.ts";
import { labelToScore, scoreToLabel } from "../../src/scores/labels.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { loadSqlite, MIGRATIONS, SqliteIndexStore } from "../../src/store/sqlite.ts";

const root = mkdtempSync(join(tmpdir(), "csh-scores-mig-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** 60 cases over three splits, two labellers on some, skips and notes, a few criteria. */
function fixture(): { labels: Label[]; verdicts: JudgedCase[]; splits: Record<string, Split> } {
  const labels: Label[] = [];
  const verdicts: JudgedCase[] = [];
  const splits: Record<string, Split> = {};
  for (let i = 0; i < 60; i++) {
    const id = `sess-${String(i).padStart(2, "0")}`;
    const split: Split = i < 36 ? "test" : i < 48 ? "dev" : "train";
    splits[id] = split;
    const human = i % 5 !== 0 && i % 7 !== 3;
    const judge = i % 4 === 0 ? !human : human;
    verdicts.push({ caseId: id, pass: judge, score: judge ? 0.8 : 0.2, confidence: i % 9 === 0 ? 0.95 : 0.5, reason: `r${i}` });
    labels.push({ id: `l-${i}-a`, sessionId: id, criterion: "correct", value: human ? "pass" : "fail", by: "alice", ts: 1000 + i, ...(i % 6 === 0 ? { note: `note ${i}, with "quotes"` } : {}) });
    if (i % 3 === 0) labels.push({ id: `l-${i}-b`, sessionId: id, criterion: "correct", value: i % 12 === 0 ? (human ? "fail" : "pass") : human ? "pass" : "fail", by: "bob", ts: 2000 + i });
    if (i % 10 === 0) labels.push({ id: `l-${i}-s`, sessionId: id, criterion: "correct", value: "skip", by: "carol", ts: 3000 + i, note: "" });
    if (i % 8 === 0) labels.push({ id: `l-${i}-o`, sessionId: id, criterion: "outcome", value: i % 16 ? "pass" : "fail", by: "alice", ts: 4000 + i });
  }
  return { labels, verdicts, splits };
}

/** The calibration report, without the times it was made at. */
const report = (labels: readonly Label[], f: ReturnType<typeof fixture>) =>
  JSON.parse(JSON.stringify(calibrate({ judge: { id: "correct@1", tunedOn: ["train", "dev"], criterion: "correct" }, labels: labelsFromCore(labels), verdicts: f.verdicts, splits: f.splits, seed: 7, bootstrapIters: 500, minN: 10 })), (k, v) => (k === "ts" ? undefined : v));

/** A store at schema v8 (labels as a table), with these labels written the way v8 wrote them. */
async function v8Store(path: string, labels: readonly Label[]): Promise<void> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const m of MIGRATIONS.filter((m) => m.version <= 8)) {
    db.exec(m.sql);
    m.after?.(db);
    db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
  }
  const insert = db.prepare("INSERT INTO labels (id, session_id, criterion, value, note, by, ts) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const l of labels) insert.run(l.id, l.sessionId, l.criterion, l.value, l.note ?? null, l.by, l.ts);
  db.close();
}

describe("labels as scores", () => {
  it("labelToScore and scoreToLabel round-trip every label shape", () => {
    const shapes: Label[] = [
      { id: "a", sessionId: "s", criterion: "outcome", value: "pass", by: "me", ts: 1 },
      { id: "b", sessionId: "s", criterion: "judge:x", value: "fail", note: "", by: "me", ts: 2 },
      { id: "c", sessionId: "s", criterion: "outcome", value: "skip", note: "unsure", by: "you", ts: 3 },
      { id: "d", sessionId: "s", caseId: "case-1", criterion: "correct", value: "fail", by: "me", ts: 4 },
    ];
    for (const l of shapes) assert.deepEqual(scoreToLabel(labelToScore(l)), l);
    assert.equal(labelToScore(shapes[2]!).dataType, "categorical");
    assert.equal(scoreToLabel({ ...labelToScore(shapes[0]!), source: "judge" }), undefined, "only people give labels");
    assert.equal(scoreToLabel({ id: "n", target: "session", targetId: "s", sessionId: "s", name: "q", dataType: "numeric", value: 1, source: "human", by: "me", ts: 1 }), undefined);
    assert.equal(scoreToLabel({ id: "n", target: "event", targetId: "e", sessionId: "s", name: "q", dataType: "boolean", value: true, source: "human", by: "me", ts: 1 }), undefined);
  });

  it("migrating a v8 store moves labels into scores; they round-trip through listLabels and the labels view", async () => {
    const f = fixture();
    const path = join(root, "v8-labels.db");
    await v8Store(path, f.labels);
    const s = await SqliteIndexStore.open(path);
    try {
      const sorted = [...f.labels].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
      assert.deepEqual(await s.listLabels(), sorted);
      assert.deepEqual(await s.listLabels({ sessionId: "sess-00" }), sorted.filter((l) => l.sessionId === "sess-00"));
      assert.deepEqual(await s.listLabels({ criterion: "outcome" }), sorted.filter((l) => l.criterion === "outcome"));
      const scores = await s.listScores({ limit: 1000 });
      assert.equal(scores.length, f.labels.length);
      assert.deepEqual(scores.find((x) => x.id === "l-0-a"), labelToScore(f.labels.find((l) => l.id === "l-0-a")!));
      assert.deepEqual(new Set(scores.map((x) => `${x.source}/${x.dataType}`)), new Set(["human/boolean", "human/categorical"]));
      // New labels go through the same path.
      const fresh: Label = { id: "new", sessionId: "sess-01", caseId: "c-1", criterion: "correct", value: "fail", by: "dan", ts: 9999 };
      await s.putLabel(fresh);
      assert.deepEqual((await s.listLabels({ sessionId: "sess-01" })).at(-1), fresh);
    } finally {
      await s.close();
    }
    // SQL over labels keeps working: same columns as the v8 table, plus case_id.
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare("SELECT * FROM labels WHERE session_id = 'sess-00' ORDER BY ts, id").all();
      assert.deepEqual(rows.map((r) => ({ ...r })), f.labels.filter((l) => l.sessionId === "sess-00").sort((a, b) => a.ts - b.ts).map((l) => ({ id: l.id, session_id: l.sessionId, criterion: l.criterion, value: l.value, note: l.note ?? null, by: l.by, ts: l.ts, case_id: null })));
      assert.equal((db.prepare("SELECT type FROM sqlite_schema WHERE name = 'labels'").get() as { type: string }).type, "view");
    } finally {
      db.close();
    }
  });

  it("judge calibration gives the same report from migrated labels, a fresh sqlite store and the memory store", async () => {
    const f = fixture();
    const before = report(f.labels, f);
    assert.ok(before.n >= 10 && Number.isFinite(before.kappa), "the fixture is big enough to calibrate");
    const path = join(root, "v8-calibrate.db");
    await v8Store(path, f.labels);
    const migrated = await SqliteIndexStore.open(path);
    const fresh = await SqliteIndexStore.open(":memory:");
    const mem = new MemoryIndexStore();
    try {
      for (const st of [fresh, mem]) for (const l of f.labels) await st.putLabel(l);
      for (const st of [migrated, fresh, mem]) {
        assert.deepEqual(report(await st.listLabels(), f), before, st.kind);
        assert.deepEqual(report(await st.listLabels({ criterion: "correct" }), f), before, `${st.kind} by criterion`);
      }
    } finally {
      await migrated.close();
      await fresh.close();
    }
  });
});
