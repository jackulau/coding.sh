// FileEvalStore in file mode (an index without the dataset methods): the
// version file, history entry and latest pointer stay consistent across
// concurrent puts, crashes between writes and a torn history line.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { datasetVersion } from "../../src/datasets/dataset.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Dataset } from "../../src/datasets/types.ts";

const root = mkdtempSync(join(tmpdir(), "csh-evalstore-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => new FileEvalStore({ root: join(root, `s${n++}`) });
const mk = (id: string, cases: Dataset["cases"]): Dataset => ({ id, name: id, version: datasetVersion(cases), cases });

describe("FileEvalStore file mode", () => {
  it("concurrent puts of one new version record it once and report created once", async () => {
    const s = fresh();
    assert.equal(s.kind, "file");
    const ds = mk("ds", [{ id: "c1", input: { q: 1 } }]);
    const rs = await Promise.all([s.putDataset(ds), s.putDataset(ds), s.putDataset(ds)]);
    assert.deepEqual(rs.map((r) => r.created).sort(), [false, false, true]);
    assert.deepEqual((await s.listDatasetVersions("ds")).map((v) => v.version), [ds.version]);
    assert.equal((await s.listDatasets())[0]?.versions, 1);
    assert.ok(!existsSync(join(s.datasetsDir, "ds", ".lock")), "the lock is released");
  });

  it("a put that crashed after the version file heals on retry", async () => {
    const s = fresh();
    const ds = mk("ds", [{ id: "c2", input: { q: 2 } }]);
    mkdirSync(join(s.datasetsDir, "ds", "versions"), { recursive: true });
    writeFileSync(join(s.datasetsDir, "ds", "versions", `${ds.version}.json`), JSON.stringify({ ...ds, createdAt: 7 }));
    assert.deepEqual(await s.putDataset(ds, { note: "retry" }), { version: ds.version, created: true });
    assert.deepEqual(await s.listDatasetVersions("ds"), [{ version: ds.version, cases: 1, createdAt: 7, note: "retry" }]);
    assert.equal((await s.getDataset("ds"))?.version, ds.version);
    assert.deepEqual(await s.putDataset(ds), { version: ds.version, created: false });
    assert.equal((await s.listDatasetVersions("ds")).length, 1);
  });

  it("tolerates a torn trailing history line and repairs it on the next put", async () => {
    const s = fresh();
    const a = mk("ds", [{ id: "x", input: {} }]);
    const b = mk("ds", [{ id: "y", input: {} }]);
    await s.putDataset(a);
    await s.putDataset({ ...mk("other", [{ id: "z", input: {} }]) });
    const history = join(s.datasetsDir, "ds", "history.jsonl");
    writeFileSync(history, readFileSync(history, "utf8") + '{"version":"abc","ca');
    assert.deepEqual((await s.listDatasets()).map((d) => [d.id, d.versions]), [["ds", 1], ["other", 1]]);
    await s.putDataset(b);
    assert.deepEqual((await s.listDatasetVersions("ds")).map((v) => v.version), [a.version, b.version]);
    assert.ok(readFileSync(history, "utf8").split("\n").filter(Boolean).every((l) => JSON.parse(l)), "every line parses again");
  });

  it("listExperiments: limit 0 is none, negative or unset is no limit", async () => {
    const s = fresh();
    for (const id of ["x1", "x2"]) {
      await s.putExperiment({
        id, name: "e", dataset: { id: "d", name: "d", version: "v" }, task: { kind: "command", ref: "echo" }, graders: [], trials: 1, createdAt: 1, finishedAt: 2, runs: [],
        summary: { n: 0, cases: 0, passed: 0, errors: 0, passRate: { p: 0, lo: 0, hi: 0 }, ciMethod: "wilson", graders: [], latencyMs: { mean: 0, median: 0, p90: 0, max: 0 } },
      });
    }
    assert.deepEqual(await s.listExperiments({ limit: 0 }), []);
    assert.deepEqual((await s.listExperiments({ limit: 1 })).map((r) => r.id), ["x2"]);
    assert.deepEqual((await s.listExperiments({ limit: -1 })).map((r) => r.id), ["x2", "x1"]);
    assert.deepEqual((await s.listExperiments()).map((r) => r.id), ["x2", "x1"]);
  });
});
