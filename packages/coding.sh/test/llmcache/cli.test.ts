// X-11 from the CLI: exp run --record, --replay with its control arm,
// --replay-until with --no-control, the spec's "llm" field and the usage
// errors. A command agent calls a stub model API; temp HOME only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathOf } from "../_bin.ts";
import { API_KEY, recordingTexts, startStub, type Stub } from "./_stub.ts";
import { CLI } from "../_cli.ts";


describe("exp run --record / --replay from the CLI", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  let stub: Stub;
  // Async: the stub answers from this process, so the CLI must not block it.
  const cli = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const spec = (name: string, sys: string, extra: Record<string, unknown> = {}) => {
    const file = join(home, `${name}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        dataset: "ds",
        name,
        task: { kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { SYS: sys, TEST_API_KEY: API_KEY } },
        graders: [{ kind: "exact" }],
        llm: { upstream: { anthropic: stub.url }, ...extra },
      }),
    );
    return file;
  };
  let recId = "";
  let candId = "";

  before(async () => {
    stub = await startStub();
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-llm-cli-")));
    home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "tmp"));
    env = {
      HOME: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: pathOf(dirname(process.execPath), "/usr/bin", "/bin"),
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
    const cases: string[] = [];
    for (let i = 1; i <= 4; i++) cases.push("--case", JSON.stringify({ id: `c${i}`, input: `q${i}`, expected: "x" }));
    assert.equal((await cli(["dataset", "add", "ds", ...cases])).status, 0);
    // Two calls per case, the second carrying the first reply; prints both replies.
    writeFileSync(
      join(home, "agent.mjs"),
      [
        `import { readFileSync } from "node:fs";`,
        `const input = JSON.parse(readFileSync(0, "utf8"));`,
        `const call = async (messages) => { const r = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.TEST_API_KEY }, body: JSON.stringify({ model: "m", max_tokens: 9, system: process.env.SYS, messages }) }); return (await r.json()).content[0].text; };`,
        `const a = await call([{ role: "user", content: input }]);`,
        `const b = await call([{ role: "user", content: input }, { role: "assistant", content: a }, { role: "user", content: "more" }]);`,
        `process.stdout.write(JSON.stringify([a, b]));`,
      ].join("\n"),
    );
  });
  after(async () => {
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("--record stores every call and shows the LLM calls line", async () => {
    const before = stub.calls();
    const r = await cli(["exp", "run", spec("rec", "sys A"), "--record", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const exp = JSON.parse(r.stdout).experiment;
    recId = exp.id;
    assert.equal(stub.calls() - before, 8);
    assert.equal(exp.metadata.llm.mode, "record");
    assert.equal(exp.metadata.llm.task.kind, "command");
    assert.deepEqual(exp.metadata.llm.task.env, { SYS: "sys A" }, "the key-named env var is left out of the stored spec");
    for (const run of exp.runs) assert.deepEqual(run.llm, { calls: 2, hits: 0, live: 2 });
    const show = await cli(["exp", "show", recId]);
    assert.match(show.stdout, /LLM calls: 8 \(0 cached, 8 live\)/);
    for (const t of recordingTexts(join(home, ".coding.sh", "llm-cache"))) assert.ok(!t.includes(API_KEY), "a recording holds the API key");
  });

  it("--replay runs the recorded config as a control arm: a system-prompt edit replays with 0 upstream calls", async () => {
    const before = stub.calls();
    const r = await cli(["exp", "run", spec("cand", "sys B, edited"), "--replay", recId, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(stub.calls() - before, 0);
    const [a, b] = out.experiments;
    assert.equal(a.pair.arm, "control");
    assert.equal(b.pair.arm, "candidate");
    candId = b.id;
    const rec =JSON.parse((await cli(["exp", "show", recId, "--json"])).stdout).experiment;
    const outputs = (e: { runs: { caseId: string; output: unknown }[] }) => Object.fromEntries(e.runs.map((x) => [x.caseId, x.output]));
    assert.deepEqual(outputs(a), outputs(rec));
    assert.deepEqual(outputs(b), outputs(rec));
    for (const run of [...a.runs, ...b.runs]) assert.deepEqual(run.llm, { calls: 2, hits: 2, live: 0 });
    assert.equal(out.comparison.llmReplay.noise.n, 4);
    assert.equal(out.comparison.llmReplay.noise.outputsDiffer, 0);
    assert.match(out.comparison.llmReplay.note, /Confirm with a fresh live run/);
    const text = await cli(["exp", "compare", a.id, b.id]);
    assert.match(text.stdout, /llm replay noise floor 0% \(n=4\)/);
  });

  it("a replay keeps its task spec too, so it is the source of the next replay, with a control arm", async () => {
    assert.ok(candId, "the replay above ran");
    const before = stub.calls();
    const r = await cli(["exp", "run", spec("cand2", "sys C"), "--replay", candId, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(stub.calls() - before, 0, "the replay recorded every call it served");
    const [a, b] = JSON.parse(r.stdout).experiments;
    assert.equal(a.pair.arm, "control");
    assert.deepEqual(a.metadata.llm.task.env, { SYS: "sys B, edited" }, "the control is the task the source ran");
    assert.deepEqual(b.metadata.llm.task.env, { SYS: "sys C" });
  });

  it("a candidate whose every call replayed is told its system-prompt edit was never sent; one with a live call is not", async () => {
    let before = stub.calls();
    const r = await cli(["exp", "run", spec("cand-text", "sys B, edited"), "--replay", recId]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(stub.calls() - before, 0);
    assert.match(r.stderr, /^! llm cache: every model call of the candidate matched the recording, so it made no live call\. The key leaves out the system prompt: a change to it alone is never sent\. Test one with a live run, without --replay$/m);
    before = stub.calls();
    const live = await cli(["exp", "run", spec("until-ctl", "sys A"), "--replay", recId, "--replay-until", "1"]);
    assert.equal(live.status, 0, live.stderr);
    assert.equal(stub.calls() - before, 8, "call 2 of each case-trial runs live, in both arms");
    assert.match(live.stdout, /llm replay noise floor/);
    assert.doesNotMatch(live.stderr, /made no live call/);
  });

  it("--replay-until 1 --no-control: one run, call 2 live", async () => {
    const before = stub.calls();
    const r = await cli(["exp", "run", spec("until", "sys A"), "--replay", recId, "--replay-until", "1", "--no-control", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const exp = JSON.parse(r.stdout).experiment;
    assert.equal(stub.calls() - before, 4);
    const { task, ...llm } = exp.metadata.llm;
    assert.deepEqual(llm, { mode: "replay", source: recId, until: 1, control: "skipped" });
    assert.deepEqual(task.env, { SYS: "sys A" });
    for (const run of exp.runs) assert.deepEqual(run.llm, { calls: 2, hits: 1, live: 1, firstLiveOrdinal: 2 });
    // Without --json: the warning, and the counts line.
    const t = await cli(["exp", "run", spec("until2", "sys A"), "--replay", recId, "--replay-until", "1", "--no-control"]);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stderr, /without a control arm/);
    assert.match(t.stdout, /LLM calls: 8 \(4 cached, 4 live\)/);
  });

  it("--weights with a control arm is a usage error; with --no-control the replayed run carries the stamp", async () => {
    const sha = "ab12".repeat(16);
    const before = stub.calls();
    // The control arm replays the recorded checkpoint, so one stamp cannot name both arms.
    const refused = await cli(["exp", "run", spec("wt", "sys A"), "--replay", recId, "--weights", sha]);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /--replay with a control arm runs an A\/B; pass --no-control to combine it with --weights/);
    assert.equal(stub.calls() - before, 0, "nothing ran");
    const alone = await cli(["exp", "run", spec("wt", "sys A"), "--replay", recId, "--no-control", "--weights", sha, "--json"]);
    assert.equal(alone.status, 0, alone.stderr);
    const meta = JSON.parse(alone.stdout).experiment.metadata;
    assert.deepEqual(meta.weights, { sha256: sha });
    assert.equal(meta.llm.control, "skipped");
  });

  it("--no-control says why each left-out case-trial is unscored: no recording, or a live call that failed", async () => {
    const add = (...cases: object[]) => cli(["dataset", "add", "dsu", ...cases.flatMap((x) => ["--case", JSON.stringify(x)])]);
    const specU = (name: string) => {
      const file = join(home, `${name}.json`);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(spec(name, "sys A"), "utf8")), dataset: "dsu" }));
      return file;
    };
    // u2's calls fail (the stub answers 500), so the recording has no reply to serve for it.
    assert.equal((await add({ id: "u1", input: "q1", expected: "x" }, { id: "u2", input: "please-500", expected: "x" })).status, 0);
    const rec = JSON.parse((await cli(["exp", "run", specU("urec"), "--record", "--json"])).stdout).experiment.id as string;
    // u3 comes after the recording, so it has none.
    assert.equal((await add({ id: "u3", input: "q3", expected: "x" })).status, 0);
    const r = await cli(["exp", "run", specU("urep"), "--replay", rec, "--no-control"]);
    assert.match(r.stdout, /unscored 2 replayed run/);
    assert.match(r.stderr, new RegExp(`${rec} has no recording for case u3 trial 1; running it live and leaving it unscored`));
    assert.match(r.stderr, /case u2 trial 1: live call 1 failed \(HTTP 500\); leaving it unscored/);
    assert.doesNotMatch(r.stderr, /case u1 /);
  });

  it("--arm: each arm's own llm.upstream wins, with or without a positional spec", async () => {
    const stubs = [await startStub(), await startStub()];
    try {
      const arm = (name: string, s: Stub) => {
        const file = join(home, `${name}.json`);
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(spec(name, "sys A"), "utf8")), llm: { upstream: { anthropic: s.url } } }));
        return `${name}=${file}`;
      };
      const counts = () => [stub, ...stubs].map((s) => s.calls());
      const delta = (from: number[]) => counts().map((n, i) => n - from[i]!);
      // Call 1 replays, call 2 runs live: 4 live calls per arm, each to the arm's own upstream.
      const replayed = ["--replay", recId, "--replay-until", "1"];
      let from = counts();
      const withSpec = await cli(["exp", "run", spec("armspec", "sys A"), "--arm", arm("a1", stubs[0]!), "--arm", arm("b1", stubs[1]!), ...replayed, "--json"]);
      assert.equal(withSpec.status, 0, withSpec.stderr);
      assert.deepEqual(delta(from), [0, 4, 4], "the positional spec's upstream got the calls");
      from = counts();
      const alone = await cli(["exp", "run", "--dataset", "ds", "--grader", '{"kind":"exact"}', "--arm", arm("a2", stubs[0]!), "--arm", arm("b2", stubs[1]!), ...replayed, "--json"]);
      assert.equal(alone.status, 0, alone.stderr);
      assert.deepEqual(delta(from), [0, 4, 4]);
    } finally {
      for (const s of stubs) await s.close();
    }
  });

  it("the spec's llm field records too, and flags fail fast with a reason", async () => {
    const r = await cli(["exp", "run", spec("specrec", "sys A", { record: true }), "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).experiment.metadata.llm.mode, "record");
    const bad = async (args: string[], re: RegExp) => {
      const x = await cli(["exp", "run", spec("bad", "s"), ...args]);
      assert.notEqual(x.status, 0);
      assert.match(x.stderr, re);
    };
    await bad(["--replay-until", "1"], /--replay-until needs --replay/);
    await bad(["--record", "--replay", recId], /either --record or --replay/);
    await bad(["--replay", "nope"], /Can't find experiment "nope"/);
    await bad(["--replay", recId, "--replay-until", "-1"], /--replay-until must be/);
  });
});
