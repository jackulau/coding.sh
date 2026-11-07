// Y-4: the diagnostic taxonomy (Signals, arXiv 2611.04507v2 App. A) and the
// session-flag mapping onto it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FLAGS } from "../../src/core/sessions.ts";
import { CATALOG, FAMILIES, FLAG_DIAGNOSIS, TAXONOMY_VERSION, catalogHash, diagnosticType } from "../../src/refine/taxonomy.ts";

describe("CATALOG", () => {
  it("has exactly 45 unique ids, 5/6/8/8/5/3/6/4 per family, in family order", () => {
    assert.equal(CATALOG.length, 45);
    assert.equal(new Set(CATALOG.map((t) => t.id)).size, 45);
    const counts = FAMILIES.map((f) => CATALOG.filter((t) => t.family === f.id).length);
    assert.deepEqual(counts, [5, 6, 8, 8, 5, 3, 6, 4]);
    const order = FAMILIES.map((f) => f.id as string);
    const seen = CATALOG.map((t) => order.indexOf(t.family));
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  });

  it("ids are <family>.<kebab-slug> and every entry has a definition, evidence and natures", () => {
    for (const t of CATALOG) {
      assert.match(t.id, /^(ins|ctx|out|tool|orch|rt|sec|eff)\.[a-z]+(?:-[a-z]+)*$/, t.id);
      assert.equal(t.id.split(".")[0], t.family);
      assert.ok(t.name && t.definition && t.evidence, t.id);
      assert.ok(t.natures.length > 0, t.id);
    }
  });

  it("efficiency types are inefficiencies only, and no other family claims inefficiency by default except where the work itself is the problem", () => {
    for (const t of CATALOG.filter((x) => x.family === "eff")) assert.deepEqual([...t.natures], ["inefficiency"], t.id);
    assert.ok(CATALOG.filter((x) => x.family !== "eff").every((t) => t.natures.includes("defect")));
  });

  it("is deep-frozen", () => {
    assert.ok(Object.isFrozen(CATALOG));
    const t = CATALOG[0]!;
    assert.ok(Object.isFrozen(t));
    assert.ok(Object.isFrozen(t.exclusions));
    assert.throws(() => {
      (t as { name: string }).name = "x";
    }, TypeError);
    assert.throws(() => (CATALOG as unknown as unknown[]).push({}), TypeError);
  });

  it("catalogHash is a stable sha256", () => {
    assert.equal(TAXONOMY_VERSION, 1);
    assert.match(catalogHash(), /^[0-9a-f]{64}$/);
    assert.equal(catalogHash(), catalogHash());
  });

  it("looks types up by id", () => {
    assert.equal(diagnosticType("out.check-subverted")?.family, "out");
    assert.equal(diagnosticType("nope.nothing"), undefined);
  });
});

describe("FLAG_DIAGNOSIS", () => {
  it("covers every FLAGS value (a new flag without an entry fails here)", () => {
    for (const flag of Object.values(FLAGS)) assert.ok(flag in FLAG_DIAGNOSIS, `FLAG_DIAGNOSIS is missing ${flag}`);
  });

  it("names only catalog types whose natures admit the mapping's nature; reach only and always on a risk", () => {
    for (const [flag, d] of Object.entries(FLAG_DIAGNOSIS)) {
      if (d === "context-only") continue;
      assert.ok(d.typeIds.length > 0, flag);
      for (const id of d.typeIds) {
        const t = diagnosticType(id);
        assert.ok(t, `${flag}: unknown type ${id}`);
        assert.ok(t.natures.includes(d.nature), `${flag}: ${id} does not admit ${d.nature}`);
      }
      if (d.nature === "risk") assert.ok([0.4, 0.6, 0.8, 1.0].includes(d.reach as number), flag);
      else assert.equal(d.reach, undefined, flag);
    }
  });

  it("maps the spec's anchors", () => {
    assert.deepEqual(FLAG_DIAGNOSIS["premature-completion"], { typeIds: ["out.false-success", "out.incomplete-result"], nature: "defect" });
    assert.deepEqual(FLAG_DIAGNOSIS["repeated-tool-failure"], { typeIds: ["eff.retry-thrash", "tool.error-unhandled"], nature: "inefficiency" });
    assert.deepEqual(FLAG_DIAGNOSIS["no-verification"], { typeIds: ["out.verification-absent"], nature: "risk", reach: 0.8 });
    assert.equal(FLAG_DIAGNOSIS.compaction, "context-only");
    assert.ok(Object.isFrozen(FLAG_DIAGNOSIS));
  });
});
