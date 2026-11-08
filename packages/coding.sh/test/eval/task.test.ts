import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import {
  draftTaskFromSession,
  exportHarbor,
  exportTaskDir,
  extractTestCommand,
  guessSetup,
  guessVerifierFromEvents,
  guessVerifierFromRepo,
  importTaskDir,
  instructionFromArgs,
  readInstructionArg,
  shellCommandOf,
  verifierPathWarnings,
} from "../../src/eval/task.ts";
import { BUGGY, FIXED, FakeSnapshots, HIDDEN_TEST, MemBlobs, MemIndex, tempDir } from "../helpers-eval.ts";

const ROOT = "/work/toy";
const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

let seq = 0;
function ev(kind: AgentEvent["kind"], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent {
  seq++;
  return { id: `e${seq}`, v: 0, sessionId: "s1", ts: 1000 + seq, agent: "claude-code", kind, payload, ...extra };
}
const bash = (command: string) => ev("tool.start", { tool: "Bash", toolUseId: `t${seq}`, input: { command } });

async function fixture(opts: { end?: Record<string, string> } = {}) {
  const index = new MemIndex();
  const blobs = new MemBlobs();
  const git = new FakeSnapshots().add("start", BUGGY).add("end", opts.end ?? { ...FIXED, "test/add.test.js": HIDDEN_TEST }).add("turn1", FIXED);
  const session: Session = {
    id: "s1",
    agent: "claude-code",
    repo: { root: ROOT, head: "abc123", snapshot: "start" },
    startedAt: 1000,
    stats: { events: 0, turns: 2, toolCalls: 3, toolErrors: 0, filesChanged: 3 },
    flags: [],
    endSnapshot: "end",
  };
  await index.upsertSession(session);
  await index.putEvents([
    ev("session.start", {}, { repo: { root: ROOT, head: "abc123", snapshot: "start" } }),
    ev("user.message", { text: "add() and mul() are broken, fix them" }),
    bash(`cd ${ROOT} && ls`),
    bash(`cd ${ROOT} && npm test 2>&1 | tail -20`),
    // A later snapshot on turn.end must never be used as the start.
    ev("turn.end", {}, { repo: { root: ROOT, head: "abc123", snapshot: "turn1" } }),
    ev("user.message", { text: "also add a test" }),
    bash("node --test test/add.test.js"),
  ]);
  return { index, blobs, git, session };
}

describe("verifier/setup guessing", () => {
  it("extracts test commands from shell lines", () => {
    assert.equal(extractTestCommand(`cd ${ROOT} && npm test 2>&1 | tail -20`, ROOT), "npm test");
    assert.equal(extractTestCommand(`cd ${ROOT}/pkg && pnpm test`, ROOT), "cd pkg && pnpm test");
    assert.equal(extractTestCommand("python -m pytest tests/test_x.py -q", ROOT), "python -m pytest tests/test_x.py -q");
    assert.equal(extractTestCommand("go test ./... ; echo done"), "go test ./...");
    assert.equal(extractTestCommand("node --experimental-strip-types --test"), "node --experimental-strip-types --test");
    assert.equal(extractTestCommand("node test/add.test.js"), "node test/add.test.js");
    assert.equal(extractTestCommand("python tests/test_parser.py -v"), "python tests/test_parser.py -v");
    assert.equal(extractTestCommand("node scripts/build.js"), undefined);
    assert.equal(extractTestCommand(`cd /elsewhere/abs && pytest`, ROOT), "pytest");
    assert.equal(extractTestCommand("ls -la && cat package.json"), undefined);
    assert.equal(extractTestCommand("grep -r jestConfig ."), undefined);
  });
  it("reads shell commands from several agents' tool shapes", () => {
    assert.equal(shellCommandOf(ev("tool.start", { tool: "exec_command", input: { cmd: ["bash", "-lc", "cargo test"] } })), "cargo test");
    assert.equal(shellCommandOf(ev("tool.start", { tool: "shell", input: { command: ["pytest", "-x"] } })), "pytest -x");
    assert.equal(shellCommandOf(ev("tool.start", { tool: "Read", input: { file_path: "x" } })), undefined);
  });
  it("uses the last test command the agent ran", () => {
    assert.equal(guessVerifierFromEvents([bash("npm test"), bash("npx vitest run src/a.test.ts")]), "npx vitest run src/a.test.ts");
  });
  it("guesses setup from lockfiles", () => {
    const g = (...f: string[]) => guessSetup({ files: new Set(f) });
    assert.deepEqual(g("package.json", "package-lock.json"), ["npm ci"]);
    assert.deepEqual(g("package.json", "pnpm-lock.yaml"), ["pnpm i --frozen-lockfile"]);
    assert.deepEqual(g("yarn.lock", ".yarnrc.yml"), ["yarn install --immutable"]);
    assert.deepEqual(g("yarn.lock"), ["yarn install --frozen-lockfile"]);
    assert.deepEqual(g("bun.lockb"), ["bun install --frozen-lockfile"]);
    assert.deepEqual(g("pyproject.toml", "uv.lock"), ["uv sync --frozen"]);
    assert.deepEqual(g("requirements.txt"), ["pip install -r requirements.txt"]);
    assert.deepEqual(g("go.mod", "Cargo.toml"), ["go mod download", "cargo fetch"]);
    assert.deepEqual(g("README.md"), []);
  });
  it("falls back to manifests for the verifier, ignoring npm's placeholder test script", () => {
    assert.equal(guessVerifierFromRepo({ files: new Set(["package.json"]), packageJson: { scripts: { test: "vitest" } } }), "npm test");
    assert.equal(guessVerifierFromRepo({ files: new Set(["package.json", "pnpm-lock.yaml"]), packageJson: { scripts: { test: "x" } } }), "pnpm test");
    assert.equal(
      guessVerifierFromRepo({ files: new Set(["package.json"]), packageJson: { scripts: { test: 'echo "Error: no test specified" && exit 1' } } }),
      undefined,
    );
    assert.equal(guessVerifierFromRepo({ files: new Set(["go.mod"]) }), "go test ./...");
  });
});

describe("draftTaskFromSession", () => {
  it("builds a draft from the pre-agent snapshot with a reference patch and follow-ups", async () => {
    const { index, blobs, git } = await fixture();
    const t = await draftTaskFromSession({ index, blobs, git, sessionId: "s1", now: 5 });
    assert.equal(t.status, "draft");
    assert.equal(t.start.snapshot, "start", "must start from session.start, not turn/end snapshots");
    assert.equal(t.instruction, "add() and mul() are broken, fix them");
    assert.deepEqual(t.meta.followUps, ["also add a test"]);
    assert.ok(t.tags.includes("multi-turn"));
    assert.equal(t.verifier.command, "node --test test/add.test.js");
    assert.equal(t.meta.verifierSource, "session");
    assert.deepEqual(t.setup, ["npm ci"]);
    const ref = await blobs.getText(t.referencePatch ?? "");
    assert.match(ref ?? "", /\+  return a \+ b;/);
    assert.match(ref ?? "", /test\/add\.test\.js/, "without hiddenTests the test file stays in the reference");
    assert.equal(t.id, (await draftTaskFromSession({ index, blobs, git, sessionId: "s1", now: 6 })).id, "deterministic id");
  });
  it("moves test files into hidden verifier files", async () => {
    const { index, blobs, git } = await fixture();
    const t = await draftTaskFromSession({ index, blobs, git, sessionId: "s1", hiddenTests: ["test/**"], verifierCommand: "node test/add.test.js", setup: [] });
    assert.deepEqual(Object.keys(t.verifier.hiddenFiles), ["test/add.test.js"]);
    assert.equal(await blobs.getText(t.verifier.hiddenFiles["test/add.test.js"] ?? ""), HIDDEN_TEST);
    const ref = (await blobs.getText(t.referencePatch ?? "")) ?? "";
    assert.doesNotMatch(ref, /add\.test\.js/);
    assert.match(ref, /src\/mul\.js/);
    assert.equal(t.meta.verifierSource, "given");
    assert.equal(t.meta.setupSource, "given");
  });
  it("refuses a session whose start snapshot equals its end snapshot", async () => {
    const { index, blobs, git, session } = await fixture();
    await index.upsertSession({ ...session, endSnapshot: "start" });
    await assert.rejects(draftTaskFromSession({ index, blobs, git, sessionId: "s1" }), /endSnapshot/);
  });
  it("errors clearly on missing session / prompt", async () => {
    const { index, blobs, git } = await fixture();
    await assert.rejects(draftTaskFromSession({ index, blobs, git, sessionId: "nope" }), /not found/);
  });
});

/** A `coding.sh run -- <cmd>` session: snapshots, no user.message. */
async function wrapperFixture(args: unknown[], opts: { rawArgs?: string[]; start?: typeof BUGGY } = {}) {
  const index = new MemIndex();
  const blobs = new MemBlobs();
  const git = new FakeSnapshots().add("start", opts.start ?? BUGGY).add("end", FIXED);
  const repo = { root: ROOT, head: "abc123", snapshot: "start" };
  await index.upsertSession({
    id: "w1",
    agent: "wrapper",
    repo,
    startedAt: 1000,
    stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 2 },
    flags: [],
    endSnapshot: "end",
  });
  // Mirrors src/adapters/more/wrapper.ts: blobs[0] is the raw spool payload.
  const raw = opts.rawArgs ? [await blobs.put(JSON.stringify({ sessionId: "w1", cmd: "./agent.sh", args: opts.rawArgs, cwd: ROOT }))] : [];
  await index.putEvents([
    { id: "w-e1", v: 0, sessionId: "w1", ts: 1001, agent: "wrapper", kind: "session.start", payload: { source: "wrapper", cmd: "./agent.sh", args }, repo, blobs: raw },
    { id: "w-e2", v: 0, sessionId: "w1", ts: 1002, agent: "wrapper", kind: "file.change", payload: { path: "src/add.js", op: "modify" } },
    { id: "w-e3", v: 0, sessionId: "w1", ts: 1003, agent: "wrapper", kind: "session.end", payload: { reason: "exit", exitCode: 0 } },
  ]);
  return { index, blobs, git };
}

describe("instruction for sessions without a user prompt (coding.sh run)", () => {
  it("fails with a hint that names --instruction", async () => {
    const { index, blobs, git } = await wrapperFixture([]);
    await assert.rejects(draftTaskFromSession({ index, blobs, git, sessionId: "w1" }), /no user prompt[\s\S]*--instruction/);
  });
  it("uses the given instruction", async () => {
    const { index, blobs, git } = await wrapperFixture([]);
    const t = await draftTaskFromSession({ index, blobs, git, sessionId: "w1", instruction: "  add() is broken, fix it\n", verifierCommand: "node test/add.test.js", setup: [] });
    assert.equal(t.instruction, "add() is broken, fix it");
    assert.equal(t.meta.instructionSource, "given");
    assert.equal(t.name, "add-is-broken-fix-it");
    assert.deepEqual(t.meta.followUps, []);
    assert.ok(t.referencePatch, "the run's snapshots still give a reference patch");
  });
  it("names the files a guessed setup came from", async () => {
    const draft = async (start: typeof BUGGY) => {
      const { index, blobs, git } = await wrapperFixture([], { start });
      return (await draftTaskFromSession({ index, blobs, git, sessionId: "w1", instruction: "fix add()", verifierCommand: "x" })).meta.notes;
    };
    const { "package-lock.json": _, ...noLock } = BUGGY;
    assert.ok((await draft(BUGGY)).includes("setup guessed from package-lock.json: npm ci"));
    assert.ok((await draft(noLock)).includes("setup guessed from package.json (no lockfile): npm install"));
  });
  it("falls back to the wrapped command's prompt argument", async () => {
    const { index, blobs, git } = await wrapperFixture(["--yes", "make add() return a + b"]);
    const t = await draftTaskFromSession({ index, blobs, git, sessionId: "w1", verifierCommand: "x", setup: [] });
    assert.equal(t.instruction, "make add() return a + b");
    assert.equal(t.meta.instructionSource, "command");
    assert.ok(t.meta.notes.some((n) => /prompt argument/.test(n)));
  });
  it("reads the full argv from the raw blob when the inline args were clipped", async () => {
    const long = `fix add() ${"x".repeat(3000)}`;
    const { index, blobs, git } = await wrapperFixture([`fix add() ${"x".repeat(500)}…[truncated]`], { rawArgs: [long] });
    const t = await draftTaskFromSession({ index, blobs, git, sessionId: "w1", verifierCommand: "x", setup: [] });
    assert.equal(t.instruction, long);
  });
  it("never takes a file name or flag for the prompt", async () => {
    const { index, blobs, git } = await wrapperFixture(["run", "--model", "gpt-5", "task.md"]);
    await assert.rejects(draftTaskFromSession({ index, blobs, git, sessionId: "w1", verifierCommand: "x", setup: [] }), /--instruction/);
  });
  it("an explicit instruction overrides the session prompt; all session prompts become follow-ups", async () => {
    const { index, blobs, git } = await fixture();
    const t = await draftTaskFromSession({ index, blobs, git, sessionId: "s1", instruction: "fix add()", setup: [] });
    assert.equal(t.instruction, "fix add()");
    assert.deepEqual(t.meta.followUps, ["add() and mul() are broken, fix them", "also add a test"]);
    assert.notEqual(t.id, (await draftTaskFromSession({ index, blobs, git, sessionId: "s1", setup: [] })).id, "instruction is part of the id");
  });
  it("instructionFromArgs", () => {
    assert.equal(instructionFromArgs(["-p", "fix the failing test"]), "fix the failing test");
    assert.equal(instructionFromArgs(["--prompt=fix it now"]), "fix it now");
    assert.equal(instructionFromArgs(["exec", "--model", "o3", "fix the failing test"]), "fix the failing test");
    assert.equal(instructionFromArgs(["--message", "add a README section", "--yes"]), "add a README section");
    assert.equal(instructionFromArgs(["./agent.sh"]), undefined);
    assert.equal(instructionFromArgs(["-p", "--verbose"]), undefined);
    assert.equal(instructionFromArgs([]), undefined);
  });
  it("readInstructionArg reads text or @FILE", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    await writeFile(join(dir, "prompt.md"), "Fix add().\n\nKeep the API.\n");
    await writeFile(join(dir, "empty.md"), "  \n");
    assert.equal(await readInstructionArg(" fix it ", dir), "fix it");
    assert.equal(await readInstructionArg("@prompt.md", dir), "Fix add().\n\nKeep the API.");
    assert.equal(await readInstructionArg(`@${join(dir, "prompt.md")}`, "/"), "Fix add().\n\nKeep the API.");
    await assert.rejects(readInstructionArg("@missing.md", dir), /can't read instruction file .*missing\.md/);
    await assert.rejects(readInstructionArg("@empty.md", dir), /empty/);
    await assert.rejects(readInstructionArg("   ", dir), /empty/);
  });
});

describe("task dir import/export", () => {
  it("round-trips through task.json + instruction.md + tests/ + reference.patch", async () => {
    const { index, blobs, git } = await fixture();
    const t = await draftTaskFromSession({ index, blobs, git, sessionId: "s1", hiddenTests: ["test/**"] });
    const withNm = { ...t, nearMissPatches: [await blobs.put("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")] };
    const dir = await tempDir();
    dirs.push(dir);
    await exportTaskDir(withNm, dir, blobs);
    assert.equal(await readFile(join(dir, "tests/test/add.test.js"), "utf8"), HIDDEN_TEST);
    assert.ok(existsSync(join(dir, "reference.patch")));
    assert.ok(existsSync(join(dir, "near-misses/001.patch")));
    const fresh = new MemBlobs();
    const back = await importTaskDir(dir, fresh);
    assert.deepEqual(back.verifier, withNm.verifier);
    assert.equal(back.referencePatch, withNm.referencePatch);
    assert.deepEqual(back.nearMissPatches, withNm.nearMissPatches);
    assert.equal(back.instruction, withNm.instruction);
    assert.deepEqual(back.start, withNm.start);
    assert.equal(await fresh.getText(back.referencePatch ?? ""), await blobs.getText(t.referencePatch ?? ""));
    // Without a blob store the refs are still the content hashes.
    assert.equal((await importTaskDir(dir)).referencePatch, withNm.referencePatch);
  });
  it("rejects unknown formats", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "task.json"), JSON.stringify({ format: "other" }));
    await assert.rejects(importTaskDir(dir), /unsupported format/);
  });
});

describe("verifierPathWarnings", () => {
  const task = (command: string, files: string[]) => ({ verifier: { command, timeoutMs: 1, hiddenFiles: Object.fromEntries(files.map((f) => [f, "ref"])) } });
  it("flags a verifier that names tests/ when the hidden files land at the root", async () => {
    // A hand-written dir: tests/check.js and tests/need.json are copied to check.js and need.json.
    const dir = await tempDir();
    dirs.push(dir);
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "tests", "check.js"), "process.exit(0)\n");
    await writeFile(join(dir, "tests", "need.json"), "[]\n");
    await writeFile(join(dir, "instruction.md"), "Explain it.\n");
    await writeFile(join(dir, "task.json"), JSON.stringify({ name: "explain", verifier: { command: "node tests/check.js" } }));
    const t = await importTaskDir(dir, undefined, { start: { repoRoot: ROOT, snapshot: "s" } as never });
    assert.deepEqual(Object.keys(t.verifier.hiddenFiles).sort(), ["check.js", "need.json"]);
    const [w, ...rest] = verifierPathWarnings(t);
    assert.equal(rest.length, 0);
    assert.match(w ?? "", /names tests\/check\.js, but hidden files land at their path inside tests\/ \(tests\/check\.js → check\.js\): name check\.js/);
    // A glob that matches nothing runs zero tests (node --test passes): flagged too.
    assert.equal(verifierPathWarnings(task("node --test './tests/*.test.js'", ["a.test.js", "b.test.js"])).length, 1);
  });
  it("stays quiet when the hidden files are where the verifier looks", () => {
    assert.deepEqual(verifierPathWarnings(task("node --test tests/*.test.js", ["tests/a.test.js"])), []);
    assert.deepEqual(verifierPathWarnings(task("node check.js", ["check.js"])), []);
    assert.deepEqual(verifierPathWarnings(task("npm test", ["test/add.test.js"])), []);
    assert.deepEqual(verifierPathWarnings(task("node tests/run.js", [])), []);
    // tests/ in the start tree, unrelated to the hidden files.
    assert.deepEqual(verifierPathWarnings(task("node tests/run.js && node check.js", ["check.js"])), []);
  });
});

describe("exportHarbor", () => {
  it("writes the Harbor layout", async () => {
    const { index, blobs, git } = await fixture();
    const t = await draftTaskFromSession({ index, blobs, git, sessionId: "s1", hiddenTests: ["test/**"], verifierCommand: "node test/add.test.js" });
    const dir = await tempDir();
    dirs.push(dir);
    await exportHarbor(t, dir, blobs, { git });
    const toml = await readFile(join(dir, "task.toml"), "utf8");
    assert.match(toml, /\[verifier\]/);
    assert.match(toml, /timeout_sec = 600/);
    assert.match(await readFile(join(dir, "environment/Dockerfile"), "utf8"), /FROM node:22-bookworm[\s\S]*WORKDIR \/app[\s\S]*RUN npm ci/);
    assert.equal(await readFile(join(dir, "environment/repo/src/add.js"), "utf8"), BUGGY["src/add.js"]);
    const testSh = await readFile(join(dir, "tests/test.sh"), "utf8");
    assert.match(testSh, /\/logs\/verifier\/reward\.txt/);
    assert.match(testSh, /'node test\/add\.test\.js'/);
    assert.equal(await readFile(join(dir, "tests/files/test/add.test.js"), "utf8"), HIDDEN_TEST);
    // Windows has no exec bit to check (Harbor runs the task in a Linux container anyway).
    if (process.platform !== "win32") assert.ok(((await stat(join(dir, "solution/solve.sh"))).mode & 0o111) !== 0);
    assert.ok(existsSync(join(dir, "solution/reference.patch")));
    assert.equal(await readFile(join(dir, "instruction.md"), "utf8"), `${t.instruction}\n`);
  });
});
