// The join between a session's weights.checkpoint event and an experiment's weights stamp: for a
// stamped experiment, exp show and both sides of exp compare name the sessions that recorded that
// file's hash, each with the edits it recorded, and --json carries their ids next to the stamp.
// The hashes below are of labels, not of files: nothing here hashes a file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { IndexStore } from "../../src/core/types.ts";
import type { ExperimentResult } from "../../src/datasets/types.ts";
import { CHECKPOINT_SESSIONS_MAX, checkpointExperiments, checkpointLines, checkpointSessions, withSessions } from "../../src/experiments/checkpoints.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { ok, seed, T0 } from "../query/_seed.ts";

const sha = (label: string) => createHash("sha256").update(label).digest("hex");
const BASE = sha("base file");
const EDITED = sha("edited file");
const OTHER = sha("a file no session saved");
const TENSOR_A = sha("tensor before");
const TENSOR_B = sha("tensor after");

/** A session as an SDK run leaves it: `edits` weight edits on distinct tensors, then one checkpoint per hash. */
function run(id: string, at: number, edits: number, checkpoints: { sha256: string; baseSha256?: string }[]): AgentEvent[] {
  const e = { v: 0 as const, sessionId: id, agent: "weights-run" };
  const evs: AgentEvent[] = [{ ...e, id: `${id}-0`, ts: at, kind: "session.start", payload: { name: "edit" } }];
  for (let i = 0; i < edits; i++) {
    evs.push({ ...e, id: `${id}-e${i}`, ts: at + 1 + i, kind: "notification", payload: { kind: "weights.edit", tensor: `model.layers.${i}.weight`, shape: [256, 260], changed: 33_280, l2: 0.5, maxAbs: 0.01, baseSha256: TENSOR_A, editedSha256: TENSOR_B } });
  }
  checkpoints.forEach((c, i) => evs.push({ ...e, id: `${id}-c${i}`, ts: at + 100 + i, kind: "notification", payload: { kind: "weights.checkpoint", ...c } }));
  evs.push({ ...e, id: `${id}-z`, ts: at + 200, kind: "session.end", payload: {} });
  return evs;
}

describe("checkpointSessions", () => {
  const put = async (index: IndexStore, evs: AgentEvent[]) => {
    await index.putEvents(evs);
    await index.upsertSession(buildSession(evs));
  };

  it("groups sessions by the hash they recorded, newest first, with each session's edits", async () => {
    const index = new MemoryIndexStore();
    await put(index, run("old", T0, 2, [{ sha256: EDITED, baseSha256: BASE }]));
    await put(index, run("new", T0 + 60_000, 1, [{ sha256: EDITED }, { sha256: BASE }]));
    await put(index, run("none", T0 + 120_000, 3, []));
    const by = await checkpointSessions(index, [EDITED, BASE.toUpperCase(), OTHER, undefined, "not a hash"]);
    assert.deepEqual([...by.keys()].sort(), [BASE, EDITED].sort(), "a hash no session recorded has no entry");
    assert.deepEqual(by.get(EDITED)!.map((s) => [s.id, s.edits.events]), [["new", 1], ["old", 2]]);
    assert.deepEqual(by.get(BASE)!.map((s) => s.id), ["new"], "the hash a checkpoint started from does not make it a session of that file");
    assert.deepEqual(checkpointLines(EDITED, by), ["  edits    new  1 edit, 1 tensor, 33,280 weights changed", "  edits    old  2 edits, 2 tensors, 66,560 weights changed"]);
    assert.deepEqual(checkpointLines(OTHER, by), []);
    assert.deepEqual(checkpointLines(undefined, by), []);
    assert.deepEqual(checkpointLines(EDITED, undefined), []);
  });

  it(`names at most ${CHECKPOINT_SESSIONS_MAX} sessions per hash`, async () => {
    const index = new MemoryIndexStore();
    for (let i = 0; i < CHECKPOINT_SESSIONS_MAX + 2; i++) await put(index, run(`s${i}`, T0 + i * 1000, 0, [{ sha256: EDITED }]));
    const by = await checkpointSessions(index, [EDITED]);
    assert.deepEqual(by.get(EDITED)!.map((s) => s.id), ["s6", "s5", "s4", "s3", "s2"]);
    assert.deepEqual(checkpointLines(EDITED, by)[0], "  edits    s6  no edits", "a session that saved without recording an edit says so");
  });

  it("finds the session among more hashes than one query holds", async () => {
    // exp list and experiments_list ask for every stamp on the page. A --where query holds 2,000
    // characters, about 30 hashes: one query for 120 would be refused, and the join would say nothing.
    const index = new MemoryIndexStore();
    const many = Array.from({ length: 120 }, (_, i) => sha(`file ${i}`));
    await put(index, run("first", T0, 1, [{ sha256: many[0]! }]));
    await put(index, run("last", T0 + 1000, 2, [{ sha256: many[119]! }, { sha256: many[60]! }]));
    const by = await checkpointSessions(index, many);
    assert.deepEqual([...by].map(([k, v]) => [many.indexOf(k), v.map((s) => s.id)]).sort((a, b) => Number(a[0]) - Number(b[0])), [[0, ["first"]], [60, ["last"]], [119, ["last"]]]);
  });

  it("is empty, with no error, when the index can't answer or nothing was asked", async () => {
    // What a store plugin from before the key does: its query path throws on a key it has no SQL for.
    const broken = new MemoryIndexStore();
    await put(broken, run("one", T0, 1, [{ sha256: EDITED }]));
    broken.listSessions = async () => Promise.reject(new Error("no such key"));
    assert.equal((await checkpointSessions(broken, [EDITED])).size, 0);
    let asked = 0;
    const counting = new MemoryIndexStore();
    counting.listSessions = async () => (asked++, []);
    assert.equal((await checkpointSessions(counting, [undefined, "abc"])).size, 0);
    assert.equal(asked, 0, "no query for no hash");
  });

  it("withSessions sets the ids on a stamp some session recorded, and leaves any other object alone", async () => {
    const index = new MemoryIndexStore();
    await put(index, run("one", T0, 1, [{ sha256: EDITED }]));
    const by = await checkpointSessions(index, [EDITED, BASE]);
    const row = (id: string, sha256?: string): { id: string; weights?: { sha256: string } } => (sha256 === undefined ? { id } : { id, weights: { sha256 } });
    assert.deepEqual(withSessions(row("a", EDITED), by), { id: "a", weights: { sha256: EDITED, sessions: ["one"] } });
    assert.deepEqual(withSessions(row("b", BASE), by), { id: "b", weights: { sha256: BASE } });
    assert.deepEqual(withSessions(row("c"), by), { id: "c" });
  });

  it("checkpointExperiments lists the experiments stamped with each hash, and nothing when they can't be read", async () => {
    const exp = (id: string, name: string, sha256?: string): ExperimentResult => {
      const e = { id, name } as ExperimentResult;
      if (sha256) e.metadata = { weights: { sha256 } };
      return e;
    };
    const store = { listExperiments: async () => [exp("exp_3", "again", EDITED), exp("exp_2", "plain"), exp("exp_1", "first", EDITED), exp("exp_0", "base", BASE)] };
    const by = await checkpointExperiments(store, [EDITED, OTHER]);
    assert.deepEqual([...by], [[EDITED, [{ id: "exp_3", name: "again" }, { id: "exp_1", name: "first" }]]]);
    assert.equal((await checkpointExperiments({ listExperiments: async () => Promise.reject(new Error("no store")) }, [EDITED])).size, 0);
    assert.equal((await checkpointExperiments(store, undefined)).size, 0);
  });
});

describe("exp show, exp compare and exp list name the sessions that recorded a stamp", () => {
  let env: TmpEnv;
  let proj = "";
  const task = (model: string) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(proj, "gen.mjs")], env: { MODEL: model } });
  const G = '{"kind":"json-path","name":"correct","path":"$.answer"}';
  const runArgs = (model: string, name: string, ...more: string[]) => ["exp", "run", "-d", "wt", "--task", task(model), "-g", G, "--name", name, ...more];

  before(async () => {
    env = tmpEnv();
    proj = join(env.root, "proj");
    mkdirSync(proj, { recursive: true });
    mkdirSync(env.dataHome, { recursive: true });
    // MODEL=base answers m1 and m2; edited answers all four.
    writeFileSync(
      join(proj, "gen.mjs"),
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=Number(JSON.parse(s).slice(1));const right=process.env.MODEL==="edited"||n<=2;process.stdout.write(JSON.stringify({answer:right?"ok":"wrong"}))});\n`,
    );
    const cases = [1, 2, 3, 4].flatMap((n) => ["--case", JSON.stringify({ id: `m${n}`, input: `m${n}`, expected: { answer: "ok" } })]);
    ok(["dataset", "add", "wt", ...cases]);
    // Two sessions saved the edited file (the newer one recorded no edit); nobody recorded the base file.
    const sessions = [run("sess-edit", T0, 2, [{ sha256: EDITED, baseSha256: BASE }]), run("sess-resave", T0 + 3600e3, 0, [{ sha256: EDITED }]), run("sess-plain", T0, 1, [])];
    await seed(env.dataHome, { events: sessions.flat(), sessions: sessions.map((evs) => buildSession(evs)) });
    ok(runArgs("base", "base", "--weights", BASE));
    ok(runArgs("edited", "edited", "--weights", EDITED));
    ok(runArgs("edited", "other", "--weights", OTHER));
    ok(runArgs("base", "plain"));
  });
  after(() => env.restore());

  const EDIT_LINES = ["  edits    sess-resave  no edits", "  edits    sess-edit  2 edits, 2 tensors, 66,560 weights changed"];

  it("exp show prints one edits line per session under the stamp, and --json carries the ids next to it", () => {
    const lines = ok(["exp", "show", "edited"]).stdout.split("\n");
    const at = lines.indexOf(`weights ${EDITED}`);
    assert.ok(at > 0, lines.join("\n"));
    assert.deepEqual(lines.slice(at + 1, at + 3), EDIT_LINES);
    const j = JSON.parse(ok(["exp", "show", "edited", "--json"]).stdout) as { experiment: ExperimentResult; weights?: unknown };
    assert.deepEqual(j.weights, { sha256: EDITED, sessions: ["sess-resave", "sess-edit"] });
    assert.deepEqual(j.experiment.metadata?.weights, { sha256: EDITED }, "the stored record prints as it is");
  });

  it("a stamp no session recorded, and an experiment with no stamp, print nothing extra", () => {
    for (const name of ["base", "other", "plain"]) {
      assert.doesNotMatch(ok(["exp", "show", name]).stdout, /^ {2}edits /m, name);
      assert.equal(Object.hasOwn(JSON.parse(ok(["exp", "show", name, "--json"]).stdout), "weights"), false, name);
    }
  });

  it("exp compare names them under the side that ran that file, in text and --json", () => {
    const lines = ok(["exp", "compare", "base", "edited"]).stdout.split("\n");
    assert.match(lines[0]!, /^A base exp_\w+ {2}pass 50\.0% {2}weights \w{12}$/);
    assert.match(lines[1]!, /^B edited exp_\w+ {2}pass 100\.0% {2}weights \w{12}$/);
    assert.deepEqual(lines.slice(2, 4), EDIT_LINES);
    const flipped = ok(["exp", "compare", "edited", "base"]).stdout.split("\n");
    assert.deepEqual(flipped.slice(1, 3), EDIT_LINES, "under A when A ran the edited file");
    assert.match(flipped[3]!, /^B base /);
    const c = JSON.parse(ok(["exp", "compare", "base", "edited", "--json"]).stdout).comparison;
    assert.deepEqual([c.a.weights, c.b.weights], [{ sha256: BASE }, { sha256: EDITED, sessions: ["sess-resave", "sess-edit"] }]);
    const twins = ok(["exp", "compare", "edited", "edited"]).stdout.split("\n");
    assert.deepEqual([twins.slice(1, 3), twins.slice(4, 6)], [EDIT_LINES, EDIT_LINES], "both sides, when both ran it");
    assert.doesNotMatch(ok(["exp", "compare", "base", "plain"]).stdout, /^ {2}edits /m);
  });

  it("exp list --json carries the ids on each stamped row", () => {
    const rows = (JSON.parse(ok(["exp", "list", "--json"]).stdout) as { experiments: { name: string; weights?: unknown }[] }).experiments;
    const row = (name: string) => rows.find((r) => r.name === name)!;
    assert.deepEqual(row("edited").weights, { sha256: EDITED, sessions: ["sess-resave", "sess-edit"] });
    assert.deepEqual(row("base").weights, { sha256: BASE });
    assert.equal(Object.hasOwn(row("plain"), "weights"), false);
  });

  it("the session, in turn, names the experiment that ran its checkpoint", () => {
    assert.match(ok(["show", "sess-edit"]).stdout, new RegExp(`^\\s*Experiments\\s+${EDITED.slice(0, 12)} ran in edited \\(exp_\\w+\\)$`, "m"));
    assert.doesNotMatch(ok(["show", "sess-plain"]).stdout, /^\s*Experiments/m);
  });
});
