// X-11 from the CLI: exp run --record, --replay with its control arm,
// --replay-until with --no-control, the spec's "llm" field and the usage
// errors. A command agent calls a stub model API; temp HOME only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { pathOf } from "../_bin.ts";
import { API_KEY, recordingTexts, startStub, type Stub } from "./_stub.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

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
    const rec = JSON.parse((await cli(["exp", "show", recId, "--json"])).stdout).experiment;
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

  it("--replay-until 1 --no-control: one run, call 2 live", async () => {
    const before = stub.calls();
    const r = await cli(["exp", "run", spec("until", "sys A"), "--replay", recId, "--replay-until", "1", "--no-control", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const exp = JSON.parse(r.stdout).experiment;
    assert.equal(stub.calls() - before, 4);
    assert.deepEqual(exp.metadata.llm, { mode: "replay", source: recId, until: 1, control: "skipped" });
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
