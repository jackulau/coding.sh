// AE-2: per-task reflection (fixed / regressed / still failing) read from the
// ledger and fed to the next proposal prompt. Strictly additive: without it the
// prompt is byte for byte what it was.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Session } from "../../src/schema/index.ts";
import { flagFindings } from "../../src/refine/findings.ts";
import { preservation, stillFailingTasks, type ArmOutcomes } from "../../src/refine/keep.ts";
import { appendLedger, LEDGER_VERSION, preservationEntry, readLedger, rejectedEdits, type TestEntry } from "../../src/refine/ledger.ts";
import { PROPOSER_SYSTEM, proposalPrompt, REFLECTION_RULE } from "../../src/refine/propose.ts";

const dir = mkdtempSync(join(tmpdir(), "csh-reflect-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const runs = (spec: Record<string, string>): Map<string, boolean[]> => new Map(Object.entries(spec).map(([id, s]) => [id, [...s].map((c) => c === "1")]));
const arms = (base: Record<string, string>, cand: Record<string, string>): ArmOutcomes => ({ base: runs(base), cand: runs(cand) });

const entry = (id: string, round: number, extra: Partial<TestEntry>): TestEntry => ({
  op: "test",
  id,
  round,
  at: `2026-11-0${round}T00:00:00.000Z`,
  candidate: { label: id, source: "proposal", files: [{ path: "AGENTS.md", sha: "x" }], added: [`line from ${id}`] },
  base: [],
  verdict: "reject",
  stage: "dev",
  reasons: ["dev: Don't ship"],
  guardTasks: [],
  cost: { usd: 0, unpriced: 0 },
  ...extra,
});

const target = { path: "AGENTS.md", text: "Keep answers short.\n" };
const findings = flagFindings([{ id: "a", startedAt: 0, flags: ["no-verification"], stats: { toolCalls: 3 } } as unknown as Session]);

describe("stillFailingTasks and preservation", () => {
  it("lists tasks neither arm ever passed", () => {
    const a = arms({ t1: "000", t2: "111", t3: "000", t4: "100" }, { t1: "011", t2: "000", t3: "000", t4: "000" });
    assert.deepEqual(stillFailingTasks(a), ["t3"]);
    const p = preservation({ dev: a });
    assert.deepEqual(p.stillFailing, ["t3"]);
    const e = preservationEntry(p);
    assert.deepEqual({ fixed: e.fixed, regressed: e.regressed, stillFailing: e.stillFailing, basis: e.basis }, { fixed: ["t1"], regressed: ["t2", "t4"], stillFailing: ["t3"], basis: "dev" });
  });
});

describe("reflection in the proposer prompt", () => {
  it("a round that fixed t1, regressed t2 and left t3 failing lists those ids, read from the ledger", () => {
    const d = join(dir, "two-rounds");
    const p1 = preservationEntry(preservation({ dev: arms({ t1: "000", t2: "111", t3: "000" }, { t1: "111", t2: "000", t3: "000" }) }));
    appendLedger(d, entry("r_1111111111", 1, { v: LEDGER_VERSION, preservation: p1 }));
    appendLedger(d, entry("r_2222222222", 2, { v: LEDGER_VERSION, verdict: "keep", stage: "done", preservation: preservationEntry(preservation({ dev: arms({ t4: "000" }, { t4: "111" }) })) }));
    const rejected = rejectedEdits(readLedger(d));
    assert.deepEqual(rejected.map((r) => r.id), ["r_1111111111"], "kept rounds are not rejected edits");
    const p = proposalPrompt({ findings, target, protectedLines: [], rejected });
    assert.match(p.user, /What your earlier edits changed, per task[^\n]*\n- r_1111111111: fixed t1; still failing t3; regressed t2/);
    assert.ok(p.system.includes(REFLECTION_RULE), "the system prompt says to help the still-failing tasks");
    assert.match(p.system, /never bring back what made a task regress/);
  });

  it("an old (v1) entry without the fields loads and gives no reflection; the prompt is byte for byte the old one", () => {
    const d = join(dir, "old");
    appendLedger(d, entry("r_3333333333", 1, { preservation: { gained: 1, lost: 0, regressed: [], R: 0, reasons: [] } }));
    const rejected = rejectedEdits(readLedger(d));
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.fixed, undefined);
    const withOld = proposalPrompt({ findings, target, protectedLines: [], rejected });
    const plain = proposalPrompt({ findings, target, protectedLines: [], rejected: [{ id: "r_3333333333", verdict: "reject", reasons: ["dev: Don't ship"], added: ["line from r_3333333333"] }] });
    assert.equal(withOld.user, plain.user);
    assert.equal(withOld.system, PROPOSER_SYSTEM);
    assert.doesNotMatch(withOld.user, /earlier edits changed/);
  });

  it("an empty ledger gives exactly the prompt it gave before", () => {
    const none = proposalPrompt({ findings, target, protectedLines: [], rejected: rejectedEdits(readLedger(join(dir, "missing"))) });
    const before = proposalPrompt({ findings, target, protectedLines: [] });
    assert.deepEqual(none, before);
    assert.equal(before.system, PROPOSER_SYSTEM);
  });

  it("caps long id lists and keeps redaction", () => {
    const many = Array.from({ length: 14 }, (_, i) => `task-${i}`);
    const key = ["sk-ant-api03-", "B".repeat(40)].join("");
    const p = proposalPrompt({ findings, target, protectedLines: [], rejected: [{ id: "r_4444444444", verdict: "reject", reasons: [], added: [], stillFailing: [...many, key] }] });
    assert.match(p.user, /still failing task-0, [^\n]* \+5 more/);
    assert.ok(!p.user.includes(key));
  });
});
