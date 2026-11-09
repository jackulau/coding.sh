// Z-14: the canary-model re-test (K7). A fake runner plays the agent: whether a
// task passes depends on the bundle's model and its CLAUDE.md text.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HarnessBundle } from "../../src/core/types.ts";
import { canaryBundle, canaryCheck, canaryRefusal, canaryStage, canaryWanted, removedCount, subtractiveNote, type CanaryArmsRun } from "../../src/refine/canary.ts";
import { bundleId } from "../../src/runner/bundle.ts";

const SAFETY = "Never use the deploy token outside deploy/.";
const STYLE = "Prefer short functions.";
const BASE_MD = `# Project\n${SAFETY}\n${STYLE}\n`;
const CUT_MD = `# Project\n${STYLE}\n`;
const ADDED_MD = `# Project\n${SAFETY}\n${STYLE}\nRun the tests before you finish.\n`;
const LOOP = "big-model";
const CANARY = "small-model";
const TASKS = ["t1", "t2", "t3", "t4", "t5", "t6"];

/** Blob ref → text, so the fake agent can read the harness it was given. */
const blobs = new Map<string, string>();
function bundle(name: string, md: string, agent = "claude-code", flags: string[] = []): HarnessBundle {
  const ref = `blob-${blobs.size}`;
  blobs.set(ref, md);
  const body = { name, agent, model: LOOP, flags, env: {}, files: { "CLAUDE.md": ref }, remove: [] };
  return { id: bundleId(body), ...body, createdAt: 0 } as HarnessBundle;
}

/** The fake agent: the big model passes everything; the small one needs the safety line for t1 and t2. */
type Agent = (model: string | undefined, md: string, task: string, attempt: number) => boolean;
const needsSafety: Agent = (model, md, task) => model !== CANARY || !["t1", "t2"].includes(task) || md.includes(SAFETY);

function runner(agent: Agent, o: { k?: number; skipAfter?: number } = {}) {
  const calls: { base: HarnessBundle; cand: HarnessBundle }[] = [];
  const run = async (base: HarnessBundle, cand: HarnessBundle): Promise<CanaryArmsRun> => {
    calls.push({ base, cand });
    const k = o.k ?? 3;
    const arm = (b: HarnessBundle) => new Map(TASKS.map((t) => [t, Array.from({ length: k }, (_, i) => agent(b.model, blobs.get(b.files["CLAUDE.md"]!)!, t, i))]));
    return { experimentId: `exp_${calls.length}`, cancelled: false, skipped: o.skipAfter ?? 0, spentUsd: 0.5, outcomes: { base: arm(base), cand: arm(cand) } };
  };
  return { run, calls };
}

const stage = (cand: HarnessBundle, base: HarnessBundle, x: Partial<Parameters<typeof canaryStage>[0]> & Pick<Parameters<typeof canaryStage>[0], "runArms">) =>
  canaryStage({ verdict: "keep", reasons: ["pass held within the margin"], removed: removedCount([{ path: "CLAUDE.md", text: blobs.get(base.files["CLAUDE.md"]!)! }], [{ path: "CLAUDE.md", text: blobs.get(cand.files["CLAUDE.md"]!)! }]), policy: "subtractive", model: CANARY, base, cand, ...x });

describe("canary stage (K7)", () => {
  it("rejects a kept candidate that fails a 3/3 baseline task under the canary", async () => {
    const A = bundle("h", BASE_MD);
    const B = bundle("h+r_cut", CUT_MD);
    const r = runner(needsSafety);
    const d = await stage(B, A, { runArms: r.run });
    assert.equal(r.calls.length, 1);
    assert.equal(d.verdict, "reject");
    assert.match(d.reasons.at(-1)!, /^canary-regression: small-model: hard regression on t1, t2/);
    assert.deepEqual(d.canary?.hardRegressions, ["t1", "t2"]);
    // The canary arms are their own bundles: same files, the canary model, ids unlike the loop's.
    const { base, cand } = r.calls[0]!;
    assert.equal(base.model, CANARY);
    assert.equal(base.name, "h@small-model");
    assert.notEqual(base.id, A.id);
    assert.notEqual(cand.id, B.id);
    assert.notEqual(base.id, cand.id);
    assert.deepEqual(base.files, A.files);
    assert.equal(d.canary?.base, base.id);
    assert.equal(d.canary?.experiment, "exp_1");
  });

  it("runs no stage 3 for an additive edit under the default policy, and does with --canary all", async () => {
    const A = bundle("h", BASE_MD);
    const B = bundle("h+r_add", ADDED_MD);
    const r = runner(needsSafety);
    const d = await stage(B, A, { runArms: r.run });
    assert.equal(r.calls.length, 0);
    assert.equal(d.ran, false);
    assert.equal(d.verdict, "keep");
    assert.deepEqual(d.reasons, ["pass held within the margin"]);
    const all = await stage(B, A, { runArms: r.run, policy: "all" });
    assert.equal(r.calls.length, 1);
    assert.equal(all.ran, true);
    assert.equal(all.verdict, "keep");
    assert.match(all.reasons.at(-1)!, /^canary-uninformative: small-model/);
  });

  it("keeps a subtractive edit tested without a canary, with a note", async () => {
    const A = bundle("h", BASE_MD);
    const B = bundle("h+r_cut", CUT_MD);
    const r = runner(needsSafety);
    const d = await canaryStage({ verdict: "keep", reasons: [], removed: 1, policy: "subtractive", base: A, cand: B, runArms: r.run });
    assert.equal(r.calls.length, 0);
    assert.equal(d.verdict, "keep");
    assert.deepEqual(d.reasons, [subtractiveNote(1)]);
    assert.match(d.reasons[0]!, /removes 1 existing line; a success-only gate cannot see masked safeguard loss; re-test with --canary-model <cheaper model>/);
  });

  it("keeps the decision and says canary-uninformative when both arms score 0% under the canary", async () => {
    const A = bundle("h", BASE_MD);
    const B = bundle("h+r_cut", CUT_MD);
    const r = runner((model) => model !== CANARY);
    const d = await stage(B, A, { runArms: r.run });
    assert.equal(d.verdict, "keep");
    assert.match(d.reasons.at(-1)!, /^canary-uninformative: small-model \(0 of 6 tasks differ/);
    assert.equal(d.canary?.verdict, "uninformative");
  });

  it("is inconclusive when the spend cap stops the canary", async () => {
    const A = bundle("h", BASE_MD);
    const B = bundle("h+r_cut", CUT_MD);
    const d = await stage(B, A, { runArms: runner(needsSafety, { skipAfter: 4 }).run });
    assert.equal(d.verdict, "inconclusive");
    assert.match(d.reasons.at(-1)!, /stopped at the spend cap with 4 runs not started; inconclusive/);
  });

  it("never runs stage 3 for a rejected or inconclusive candidate, or with --canary off", async () => {
    const A = bundle("h", BASE_MD);
    const B = bundle("h+r_cut", CUT_MD);
    const r = runner(needsSafety);
    for (const verdict of ["reject", "inconclusive"] as const) assert.equal((await stage(B, A, { runArms: r.run, verdict })).ran, false);
    const off = await stage(B, A, { runArms: r.run, policy: "off" });
    assert.equal(off.ran, false);
    assert.deepEqual(off.reasons, ["pass held within the margin"], "off: no note either");
    assert.equal(r.calls.length, 0);
  });
});

describe("canaryCheck", () => {
  const arms = (base: Record<string, string>, cand: Record<string, string>) => ({
    base: new Map(Object.entries(base).map(([t, s]) => [t, [...s].map((c) => c === "1")])),
    cand: new Map(Object.entries(cand).map(([t, s]) => [t, [...s].map((c) => c === "1")])),
  });
  it("fails on a pass-rate lower bound at or below -delta with no hard regression", () => {
    const k = canaryCheck("m", arms({ a: "110", b: "110", c: "110", d: "110", e: "011" }, { a: "100", b: "100", c: "100", d: "100", e: "011" }));
    assert.equal(k.hardRegressions.length, 0);
    assert.equal(k.verdict, "regression");
    assert.match(k.reason, /lower bound -\d+ pts at or below -10 pts/);
  });
  it("passes when the candidate holds and enough tasks differ", () => {
    const k = canaryCheck("m", arms({ a: "000", b: "000", c: "000", d: "111" }, { a: "111", b: "111", c: "111", d: "111" }));
    assert.equal(k.verdict, "pass");
    assert.deepEqual(k.discordant, { base: 0, cand: 3 });
  });
  it("fails when the candidate's passing runs tamper more than the base's", () => {
    const k = canaryCheck("m", arms({ a: "1" }, { a: "1" }), { tampered: { base: 0, cand: 2 } });
    assert.equal(k.verdict, "regression");
    assert.match(k.reason, /2 passing runs tampered with tests \(base: 0\)/);
  });
});

describe("canary support", () => {
  it("refuses clearly when the agent can't take another model", () => {
    assert.equal(canaryRefusal({ agent: "claude-code", flags: [] }, true), undefined);
    assert.match(canaryRefusal({ agent: "wrapper", flags: ["node", "agent.mjs"] }, true)!, /no \{model\} slot/);
    assert.equal(canaryRefusal({ agent: "wrapper", flags: ["node", "agent.mjs", "--model={model}"] }, true), undefined);
    assert.match(canaryRefusal({ agent: "amp", flags: [] }, true)!, /picks its own model/);
    assert.match(canaryRefusal({ agent: "claude-code", flags: [] }, false)!, /no headless driver/);
  });
  it("policy and counting", () => {
    assert.equal(canaryWanted("subtractive", 0), false);
    assert.equal(canaryWanted("subtractive", 2), true);
    assert.equal(canaryWanted("all", 0), true);
    assert.equal(canaryWanted("off", 9), false);
    assert.equal(removedCount([{ path: "a", text: "x\ny\n" }], [{ path: "a", text: "x\nz\n" }, { path: "b", text: "new\n" }]), 1);
    const b = bundle("h", BASE_MD);
    assert.equal(canaryBundle(b, CANARY).id, canaryBundle(b, CANARY).id, "stable ids");
  });
});
