// exp run --record / --replay with the user's [capture] settings: a recording applies
// capture.redactPatterns, a recording made before those settings still replays, and
// metadata mode says that the run keeps model replies. A command agent calls a stub
// model API that echoes the prompt; temp HOME only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathOf } from "../_bin.ts";
import { API_KEY, recordingTexts, startStub, type Stub } from "./_stub.ts";
import { CLI } from "../_cli.ts";

// No built-in rule matches it; only the user's pattern does.
const MARKER = "internal-zz9plural";
const PATTERN = "internal-[a-z0-9]+";

describe("exp run --record / --replay with the user's redaction settings", () => {
  let root = "";
  let home = "";
  let csh = "";
  let env: NodeJS.ProcessEnv = {};
  let stub: Stub;
  const cli = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const config = (lines: string[]) => writeFileSync(join(csh, "config.toml"), [...lines, ""].join("\n"));
  const spec = (name: string) => {
    const file = join(home, `${name}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        dataset: "ds",
        name,
        task: { kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { TEST_API_KEY: API_KEY } },
        graders: [{ kind: "exact" }],
        llm: { upstream: { anthropic: stub.url } },
      }),
    );
    return file;
  };
  const record = async (name: string, json = true) => {
    const args = ["exp", "run", spec(name), "--record"];
    if (json) args.push("--json");
    const r = await cli(args);
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const replay = async (name: string, source: string) => {
    const before = stub.calls();
    const r = await cli(["exp", "run", spec(name), "--replay", source, "--no-control", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const exp = JSON.parse(r.stdout).experiment as { runs: { llm: unknown }[] };
    return { upstream: stub.calls() - before, runs: exp.runs };
  };
  const recordings = (expId: string) => recordingTexts(join(csh, "llm-cache", expId));

  before(async () => {
    stub = await startStub();
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-llm-redact-")));
    home = join(root, "home");
    csh = join(root, "csh");
    mkdirSync(home);
    mkdirSync(csh);
    mkdirSync(join(root, "tmp"));
    env = {
      HOME: home,
      CODING_SH_HOME: csh,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: pathOf(dirname(process.execPath), "/usr/bin", "/bin"),
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
    assert.equal((await cli(["dataset", "add", "ds", "--case", JSON.stringify({ id: "c1", input: `q1 ${MARKER}`, expected: "x" })])).status, 0);
    // Two calls, the second carrying the first reply (which echoes the marker).
    writeFileSync(
      join(home, "agent.mjs"),
      [
        `import { readFileSync } from "node:fs";`,
        `const input = JSON.parse(readFileSync(0, "utf8"));`,
        `const call = async (messages) => { const r = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.TEST_API_KEY }, body: JSON.stringify({ model: "m", max_tokens: 9, messages }) }); return (await r.json()).content[0].text; };`,
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

  let older = "";

  it("a recording made before the pattern was set holds the value (only the built-in rules ran)", async () => {
    const r = await record("older");
    older = JSON.parse(r.stdout).experiment.id;
    assert.ok(recordings(older).some((t) => t.includes(MARKER)), "the stub echoes the marker into the reply");
  });

  it("--record applies capture.redactPatterns to the replies it stores", async () => {
    config(["[capture]", `redactPatterns = [${JSON.stringify(PATTERN)}]`]);
    const r = await record("patterned");
    const id = JSON.parse(r.stdout).experiment.id as string;
    const texts = recordings(id);
    assert.ok(texts.length > 0);
    for (const t of texts) {
      assert.ok(!t.includes(MARKER), "a recording holds a value capture.redactPatterns matches");
      assert.ok(!t.includes(API_KEY), "a recording holds the API key");
    }
    assert.ok(texts.some((t) => t.includes("[redacted:pattern]")));
    // The redacted recording replays every call: the key is taken from the request as the recording holds it.
    const rep = await replay("patterned-replay", id);
    assert.equal(rep.upstream, 0);
    for (const run of rep.runs) assert.deepEqual(run.llm, { calls: 2, hits: 2, live: 0 });
  });

  it("a recording made before the pattern was set still replays every call", async () => {
    const rep = await replay("older-replay", older);
    assert.equal(rep.upstream, 0);
    for (const run of rep.runs) assert.deepEqual(run.llm, { calls: 2, hits: 2, live: 0 });
  });

  it("in metadata mode, --record says in one line that it keeps model replies", async () => {
    config(["[capture]", 'mode = "metadata"']);
    const r = await record("meta", false);
    const lines = r.stderr.split("\n").filter((l) => /capture\.mode/.test(l));
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0]!, /metadata/);
    assert.match(lines[0]!, /llm-cache/);
    // The flag is an explicit request: the run still records.
    assert.match(r.stdout, /LLM calls: 2 \(0 cached, 2 live\)/);
  });

  it("without metadata mode there is no such line", async () => {
    config([]);
    const r = await record("full", false);
    assert.doesNotMatch(r.stderr, /capture\.mode/);
  });
});
