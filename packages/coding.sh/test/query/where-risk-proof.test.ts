// `--where` keys for supervision risk, unverified edits, and formal proof stats:
// parser + enum validation, exact parity between SqliteIndexStore and MemoryIndexStore
// (positive, negated, comma lists, numeric operators/ranges, sorting, facets), and
// end-to-end CLI coverage (`coding.sh sessions --where` and `coding.sh dataset mine --where`).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { PROOF_LANGS } from "../../src/core/proof.ts";
import type { IndexStore } from "../../src/core/types.ts";
import { SUPERVISION_RISKS } from "../../src/core/work.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { facetCounts, findSessions } from "../../src/query/run.ts";
import { KEYS, keyGuide, parseWhere, printWhere, QueryError } from "../../src/query/where.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, event, ok, seed, session, T0 } from "./_seed.ts";

const H = 3_600_000;

function stripAt(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripAt);
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (k !== "at") out[k] = stripAt(v);
    return out;
  }
  return x;
}

function riskProofFixture(repoRoot = "/work/proofs"): { sessions: Session[]; events: AgentEvent[] } {
  const repo = { root: repoRoot, head: "abc123", branch: "main" };
  const sessions: Session[] = [
    session("s-lean-high", {
      agent: "claude-code",
      cwd: repoRoot,
      repo,
      startedAt: T0,
      endedAt: T0 + 15 * 60_000,
      title: "Prove ring homomorphism lemma in Lean",
      stats: {
        events: 10,
        turns: 4,
        toolCalls: 9,
        toolErrors: 4,
        filesChanged: 2,
        verification: {
          checks: 6,
          passed: 1,
          failed: 5,
          maxUnverifiedEdits: 6,
          proof: {
            langs: ["lean"],
            checks: 6,
            passed: 1,
            failed: 5,
            escapeAdded: 2,
            escapeRemaining: 2,
            oscillatingChecks: 4,
          },
        },
        contextHygiene: {
          compactions: 1,
          deadEndStreak: 3,
          supervisionRisk: "high",
          riskReasons: ["unverified-edits", "tactic-oscillation"],
        },
      },
    }),
    session("s-lean-clean", {
      agent: "claude-code",
      cwd: repoRoot,
      repo,
      startedAt: T0 + H,
      endedAt: T0 + H + 8 * 60_000,
      title: "Prove list reversal involution in Lean",
      stats: {
        events: 8,
        turns: 3,
        toolCalls: 6,
        toolErrors: 0,
        filesChanged: 1,
        verification: {
          checks: 2,
          passed: 2,
          failed: 0,
          maxUnverifiedEdits: 1,
          proof: {
            langs: ["lean"],
            checks: 2,
            passed: 2,
            failed: 0,
          },
        },
      },
    }),
    session("s-rocq-dafny", {
      agent: "codex",
      cwd: repoRoot,
      repo,
      startedAt: T0 + 2 * H,
      endedAt: T0 + 2 * H + 12 * 60_000,
      title: "Verify sorting invariant in Rocq and Dafny",
      stats: {
        events: 9,
        turns: 3,
        toolCalls: 8,
        toolErrors: 2,
        filesChanged: 2,
        verification: {
          checks: 4,
          passed: 2,
          failed: 2,
          maxUnverifiedEdits: 3,
          proof: {
            langs: ["dafny", "rocq"],
            checks: 4,
            passed: 2,
            failed: 2,
            escapeAdded: 1,
            escapeRemaining: 1,
            oscillatingChecks: 2,
          },
        },
        contextHygiene: {
          supervisionRisk: "medium",
          riskReasons: ["tactic-oscillation"],
        },
      },
    }),
    session("s-med-nonproof", {
      agent: "claude-code",
      cwd: repoRoot,
      repo,
      startedAt: T0 + 3 * H,
      endedAt: T0 + 3 * H + 10 * 60_000,
      title: "Refactor parser pipeline with long edit streak",
      stats: {
        events: 10,
        turns: 4,
        toolCalls: 10,
        toolErrors: 2,
        filesChanged: 5,
        verification: {
          checks: 1,
          passed: 1,
          failed: 0,
          maxUnverifiedEdits: 5,
        },
        contextHygiene: {
          compactions: 1,
          postCompactionFailedRepeats: 1,
          supervisionRisk: "medium",
          riskReasons: ["unverified-edits", "post-compaction-repeats"],
        },
      },
    }),
    session("s-verified-zero", {
      agent: "codex",
      cwd: repoRoot,
      repo,
      startedAt: T0 + 4 * H,
      endedAt: T0 + 4 * H + 5 * 60_000,
      title: "Run test suite cleanly without edits",
      stats: {
        events: 6,
        turns: 2,
        toolCalls: 4,
        toolErrors: 0,
        filesChanged: 0,
        verification: {
          checks: 3,
          passed: 3,
          failed: 0,
          maxUnverifiedEdits: 0,
        },
      },
    }),
    session("s-plain", {
      agent: "gemini",
      cwd: repoRoot,
      repo,
      startedAt: T0 + 5 * H,
      endedAt: T0 + 5 * H + 2 * 60_000,
      title: "Explain architecture overview",
      stats: {
        events: 4,
        turns: 2,
        toolCalls: 1,
        toolErrors: 0,
        filesChanged: 0,
      },
    }),
  ];

  const events: AgentEvent[] = sessions.flatMap((s) => [
    event(s.id, 1, { agent: s.agent, ts: s.startedAt + 1000, kind: "user.message", payload: { text: `${s.title} with full verification` } }),
    event(s.id, 2, { agent: s.agent, ts: s.startedAt + 2000, kind: "assistant.message", payload: { text: `Completed work for ${s.id}.` } }),
  ]);
  return { sessions, events };
}

describe("risk and proof --where parser and validation", () => {
  test("enum keys stay aligned with SUPERVISION_RISKS, PROOF_LANGS, and keyGuide()", () => {
    assert.deepEqual(KEYS.get("risk")?.choices, SUPERVISION_RISKS);
    assert.deepEqual(KEYS.get("proof.lang")?.choices, PROOF_LANGS);
    const guide = new Map(keyGuide().map((g) => [g.name, g]));
    assert.deepEqual(guide.get("risk")?.values?.map((v) => v.value), [...SUPERVISION_RISKS]);
    assert.equal(guide.get("risk")?.facet, true);
    assert.equal(guide.get("risk.reason")?.facet, true);
    assert.deepEqual(guide.get("proof.lang")?.values?.map((v) => v.value), [...PROOF_LANGS]);
    assert.equal(guide.get("proof.lang")?.facet, true);
  });

  const valid: [string, string][] = [
    ["risk:high", "risk:high"],
    ["risk:medium", "risk:medium"],
    ["risk:medium,high", "risk:medium,high"],
    ["risk:HIGH", "risk:high"],
    ["-risk:high", "-risk:high"],
    ["risk.reason:tactic-oscillation", "risk.reason:tactic-oscillation"],
    ["risk.reason:tactic-oscillation,post-compaction-repeats", "risk.reason:tactic-oscillation,post-compaction-repeats"],
    ["risk.reason:*compaction*", "risk.reason:*compaction*"],
    ["-risk.reason:dead-end-loop", "-risk.reason:dead-end-loop"],
    ["proof.lang:lean", "proof.lang:lean"],
    ["proof.lang:Lean,ROCQ", "proof.lang:lean,rocq"],
    ["proof.lang:lean,rocq,dafny,verus,isabelle,tla,tlc", "proof.lang:lean,rocq,dafny,verus,isabelle,tla,tlc"],
    ["-proof.lang:lean", "-proof.lang:lean"],
    ["proof.escapes>0", "proof.escapes>0"],
    ["proof.escapes:0", "proof.escapes:0"],
    ["proof.escapes:1..3", "proof.escapes:1..3"],
    ["-proof.escapes>0", "-proof.escapes>0"],
    ["proof.oscillating>=2", "proof.oscillating>=2"],
    ["proof.oscillating<4", "proof.oscillating<4"],
    ["proof.oscillating:0", "proof.oscillating:0"],
    ["unverified.edits>=5", "unverified.edits>=5"],
    ["unverified.edits<=3", "unverified.edits<=3"],
    ["unverified.edits:0", "unverified.edits:0"],
    ["unverified.edits:2..6", "unverified.edits:2..6"],
    ["sort:-proof.escapes", "sort:-proof.escapes"],
    ["sort:-proof.oscillating", "sort:-proof.oscillating"],
    ["sort:-unverified.edits", "sort:-unverified.edits"],
  ];

  for (const [q, norm] of valid) {
    test(`parses and round-trips ${q}`, () => {
      const ast = parseWhere(q);
      assert.equal(printWhere(ast), norm);
      assert.deepEqual(stripAt(parseWhere(printWhere(ast))), stripAt(ast));
    });
  }

  const invalid: [string, string, number][] = [
    ["risk:low", "bad_value", 5],
    ["risk:none", "bad_value", 5],
    ["risk:critical", "bad_value", 5],
    ["risk:h*", "bad_value", 5],
    ["risk:medium,bogus", "bad_value", 12],
    ["risk>medium", "bad_value", 5],
    ["risk:", "bad_value", 5],
    ["proof.lang:python", "bad_value", 11],
    ["proof.lang:coq", "bad_value", 11],
    ["proof.lang:lean*", "bad_value", 11],
    ["proof.lang:lean,invalid", "bad_value", 16],
    ["proof.lang>lean", "bad_value", 11],
    ["proof.lang:", "bad_value", 11],
    ["risk.reason>tactic-oscillation", "bad_value", 12],
    ["risk.reason:", "bad_value", 12],
    ["proof.escapes:abc", "bad_value", 14],
    ["proof.escapes:>0", "bad_value", 14],
    ["proof.escapes:5..2", "bad_value", 14],
    ["proof.oscillating:abc", "bad_value", 18],
    ["proof.oscillating:>=2", "bad_value", 18],
    ["unverified.edits:abc", "bad_value", 17],
    ["unverified.edits:>=5", "bad_value", 17],
    ["unverified.edits:10..3", "bad_value", 17],
  ];

  for (const [q, reason, offset] of invalid) {
    test(`rejects invalid query ${q}`, () => {
      assert.throws(() => parseWhere(q), (e: unknown) => e instanceof QueryError && e.reason === reason && e.offset === offset);
    });
  }
});

describe("SQLite and MemoryIndexStore parity for risk and proof keys", () => {
  let dir = "";
  let sqlite: SqliteIndexStore;
  let memory: MemoryIndexStore;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "csh-where-risk-proof-"));
    sqlite = await SqliteIndexStore.open(join(dir, "index.db"));
    memory = new MemoryIndexStore();
    const { sessions, events } = riskProofFixture();
    for (const st of [sqlite, memory] as IndexStore[]) {
      await st.putEvents(events);
      for (const s of sessions) await st.upsertSession(s);
    }
  });

  after(async () => {
    await sqlite?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ids = async (st: IndexStore, q: string) => (await findSessions(st, parseWhere(q))).sessions.map((s) => s.id);

  // Ordered newest first (s-plain -> s-verified-zero -> s-med-nonproof -> s-rocq-dafny -> s-lean-clean -> s-lean-high).
  const cases: [string, string[]][] = [
    ["risk:high", ["s-lean-high"]],
    ["risk:medium", ["s-med-nonproof", "s-rocq-dafny"]],
    ["risk:medium,high", ["s-med-nonproof", "s-rocq-dafny", "s-lean-high"]],
    ["risk:HIGH", ["s-lean-high"]],
    ["-risk:high", ["s-plain", "s-verified-zero", "s-med-nonproof", "s-rocq-dafny", "s-lean-clean"]],
    ["-risk:medium,high", ["s-plain", "s-verified-zero", "s-lean-clean"]],
    ["risk.reason:tactic-oscillation", ["s-rocq-dafny", "s-lean-high"]],
    ["risk.reason:post-compaction-repeats", ["s-med-nonproof"]],
    ["risk.reason:tactic-oscillation,post-compaction-repeats", ["s-med-nonproof", "s-rocq-dafny", "s-lean-high"]],
    ["risk.reason:*compaction*", ["s-med-nonproof"]],
    ["-risk.reason:tactic-oscillation", ["s-plain", "s-verified-zero", "s-med-nonproof", "s-lean-clean"]],
    ["proof.lang:lean", ["s-lean-clean", "s-lean-high"]],
    ["proof.lang:rocq", ["s-rocq-dafny"]],
    ["proof.lang:dafny", ["s-rocq-dafny"]],
    ["proof.lang:lean,rocq", ["s-rocq-dafny", "s-lean-clean", "s-lean-high"]],
    ["proof.lang:verus", []],
    ["-proof.lang:lean", ["s-plain", "s-verified-zero", "s-med-nonproof", "s-rocq-dafny"]],
    ["proof.escapes>0", ["s-rocq-dafny", "s-lean-high"]],
    ["proof.escapes>=2", ["s-lean-high"]],
    ["proof.escapes<2", ["s-rocq-dafny", "s-lean-clean"]],
    ["proof.escapes<=1", ["s-rocq-dafny", "s-lean-clean"]],
    ["proof.escapes:0", ["s-lean-clean"]],
    ["proof.escapes:1..2", ["s-rocq-dafny", "s-lean-high"]],
    ["-proof.escapes>0", ["s-plain", "s-verified-zero", "s-med-nonproof", "s-lean-clean"]],
    ["proof.oscillating>0", ["s-rocq-dafny", "s-lean-high"]],
    ["proof.oscillating>=2", ["s-rocq-dafny", "s-lean-high"]],
    ["proof.oscillating>2", ["s-lean-high"]],
    ["proof.oscillating<3", ["s-rocq-dafny", "s-lean-clean"]],
    ["proof.oscillating<=2", ["s-rocq-dafny", "s-lean-clean"]],
    ["proof.oscillating:0", ["s-lean-clean"]],
    ["proof.oscillating:2..4", ["s-rocq-dafny", "s-lean-high"]],
    ["-proof.oscillating>=2", ["s-plain", "s-verified-zero", "s-med-nonproof", "s-lean-clean"]],
    ["unverified.edits>=5", ["s-med-nonproof", "s-lean-high"]],
    ["unverified.edits>5", ["s-lean-high"]],
    ["unverified.edits<3", ["s-verified-zero", "s-lean-clean"]],
    ["unverified.edits<=3", ["s-verified-zero", "s-rocq-dafny", "s-lean-clean"]],
    ["unverified.edits:0", ["s-verified-zero"]],
    ["unverified.edits:3..6", ["s-med-nonproof", "s-rocq-dafny", "s-lean-high"]],
    ["-unverified.edits>=5", ["s-plain", "s-verified-zero", "s-rocq-dafny", "s-lean-clean"]],
    ["proof.lang:lean risk:high", ["s-lean-high"]],
    ["proof.lang:lean proof.escapes:0", ["s-lean-clean"]],
    ["(risk:high OR proof.escapes>0) -proof.lang:rocq", ["s-lean-high"]],
    ["sort:-unverified.edits", ["s-lean-high", "s-med-nonproof", "s-rocq-dafny", "s-lean-clean", "s-verified-zero", "s-plain"]],
    ["sort:-proof.escapes", ["s-lean-high", "s-rocq-dafny", "s-lean-clean", "s-plain", "s-verified-zero", "s-med-nonproof"]],
    ["sort:-proof.oscillating", ["s-lean-high", "s-rocq-dafny", "s-lean-clean", "s-plain", "s-verified-zero", "s-med-nonproof"]],
  ];

  for (const [q, expected] of cases) {
    test(q, async () => {
      const a = await ids(sqlite, q);
      const b = await ids(memory, q);
      assert.deepEqual(a, expected, `sqlite ${q}`);
      assert.deepEqual(b, expected, `memory ${q}`);
    });
  }

  test("facets for risk, risk.reason, and proof.lang agree on SQLite and Memory", async () => {
    for (const q of ["", "risk:high", "proof.lang:lean", "unverified.edits>=3"]) {
      for (const key of ["risk", "risk.reason", "proof.lang"]) {
        const a = await facetCounts(sqlite, parseWhere(q), [key]);
        const b = await facetCounts(memory, parseWhere(q), [key]);
        assert.deepEqual(a, b, `${key} over ${JSON.stringify(q)}`);
      }
    }
    const all = await facetCounts(sqlite, parseWhere(""), ["risk", "risk.reason", "proof.lang"]);
    assert.deepEqual(all.risk, [{ value: "medium", count: 2 }, { value: "high", count: 1 }]);
    assert.deepEqual(all["risk.reason"], [
      { value: "tactic-oscillation", count: 2 },
      { value: "unverified-edits", count: 2 },
      { value: "post-compaction-repeats", count: 1 },
    ]);
    assert.deepEqual(all["proof.lang"], [
      { value: "lean", count: 2 },
      { value: "dafny", count: 1 },
      { value: "rocq", count: 1 },
    ]);
  });
});

describe("end-to-end CLI sessions and dataset mine with risk and proof --where keys", () => {
  let env: TmpEnv;
  let repoRoot = "";

  before(async () => {
    env = tmpEnv();
    repoRoot = join(realpathSync(env.root), "proof-repo");
    mkdirSync(repoRoot, { recursive: true });
    const { sessions, events } = riskProofFixture(repoRoot);
    await seed(env.dataHome, { sessions, events });
  });

  after(() => {
    env.restore();
  });

  test("coding.sh sessions --where filters by risk, proof, and unverified edit keys", () => {
    const queryIds = (q: string) =>
      (JSON.parse(ok(["sessions", "--limit", "50", "--where", q, "--json"]).stdout) as { sessions: { id: string }[] }).sessions.map((s) => s.id);

    assert.deepEqual(queryIds("proof.lang:lean risk:high"), ["s-lean-high"]);
    assert.deepEqual(queryIds("risk:medium,high"), ["s-med-nonproof", "s-rocq-dafny", "s-lean-high"]);
    assert.deepEqual(queryIds("risk.reason:post-compaction-repeats"), ["s-med-nonproof"]);
    assert.deepEqual(queryIds("proof.lang:lean proof.escapes:0"), ["s-lean-clean"]);
    assert.deepEqual(queryIds("proof.oscillating>=2"), ["s-rocq-dafny", "s-lean-high"]);
    assert.deepEqual(queryIds("unverified.edits>=5"), ["s-med-nonproof", "s-lean-high"]);
    assert.deepEqual(queryIds("-risk:high proof.lang:lean"), ["s-lean-clean"]);

    const facets = JSON.parse(ok(["sessions", "--facets", "risk,proof.lang", "--json"]).stdout) as {
      facets: { risk: { value: string; count: number }[]; "proof.lang": { value: string; count: number }[] };
    };
    assert.deepEqual(facets.facets.risk, [{ value: "medium", count: 2 }, { value: "high", count: 1 }]);
    assert.deepEqual(facets.facets["proof.lang"], [{ value: "lean", count: 2 }, { value: "dafny", count: 1 }, { value: "rocq", count: 1 }]);

    const bad = cli(["sessions", "--where", "risk:extreme", "--json"]);
    assert.equal(bad.status, 2);
    const err = JSON.parse(bad.stderr.trim().split("\n").pop()!) as { reason: string; message: string };
    assert.equal(err.reason, "bad_value");
    assert.match(err.message, /medium, high/);
  });

  test('coding.sh dataset mine --where "proof.lang:lean risk:high" mines only matching sessions', async () => {
    const res = JSON.parse(
      ok(["dataset", "mine", "lean-high-risk", "--where", "proof.lang:lean risk:high", "--json"]).stdout,
    ) as { outcome: string; matched: number; kept: number; dataset: { id: string; cases: number } };
    assert.equal(res.outcome, "created");
    assert.equal(res.matched, 1);
    assert.equal(res.kept, 1);
    assert.equal(res.dataset.cases, 1);

    const index = await SqliteIndexStore.open(join(env.dataHome, "index.db"));
    try {
      const ds = await new FileEvalStore({ env: process.env, index }).getDataset(res.dataset.id, "latest");
      assert.ok(ds);
      assert.deepEqual(ds.cases.map((c) => c.sourceSessionId), ["s-lean-high"]);
    } finally {
      await index.close();
    }
  });
});
