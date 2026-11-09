// AD-3: the run corpus refine distill hands a coding agent. Made-up runs and
// sessions in an in-memory store.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, EvalTask, RunResult } from "../../src/core/types.ts";
import { isHeldOut, PREVIEW_CHARS, writeCorpusDir, type EpisodeRow, type ToolCallRow } from "../../src/refine/corpus.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { sessionEvents } from "../helpers-decision.ts";

const root = mkdtempSync(join(tmpdir(), "csh-corpus-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `c${n++}`);

const T0 = Date.UTC(2026, 9, 1, 9);
// A vendor-shaped secret, built at runtime so no literal sits in the source.
const AWS_KEY = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
type Step = [AgentEvent["kind"], Record<string, unknown>];

const task = (id: string, tags: string[] = []): EvalTask => ({ id, name: `task-${id}`, status: "validated", start: { repoRoot: "/work/demo", snapshot: "s", head: "h" }, instruction: "Fix it.", setup: [], verifier: { command: "npm test", hiddenFiles: {}, timeoutMs: 1000 }, tags, createdAt: 0 });

function steps(i: number, pass: boolean): Step[] {
  return [
    ["session.start", {}],
    ["user.message", { text: `Fix bug ${i}.` }],
    ["tool.start", { tool: "Bash", toolUseId: `b${i}`, input: { command: "cat .env" } }],
    ["tool.end", { tool: "Bash", toolUseId: `b${i}`, ok: true, output: `AWS_ACCESS_KEY_ID=${AWS_KEY}\n${"x".repeat(900)}` }],
    ["tool.start", { tool: "Edit", toolUseId: `e${i}`, input: { file_path: "/work/demo/src/a.ts" } }],
    ["tool.end", { tool: "Edit", toolUseId: `e${i}`, ok: pass, output: pass ? "ok" : "old_string not found" }],
    ["assistant.message", { text: pass ? "Fixed." : "Done." }],
  ];
}

/** 30 runs over 6 tasks x 5 attempts, 12 failing; plus 4 runs of a dev-split task and 3 runs that don't count. */
async function experimentStore(): Promise<MemoryIndexStore> {
  const index = new MemoryIndexStore();
  for (let t = 0; t < 6; t++) await index.putTask(task(`t${t}`, t % 2 ? ["area:api"] : ["area:ui"]));
  await index.putTask(task("tdev", ["split:dev"]));
  let k = 0;
  const run = async (taskId: string, attempt: number, pass: boolean, extra: Partial<RunResult> = {}) => {
    const sid = `s${k}`;
    const evs = sessionEvents(sid, { cwd: "/work/demo", startedAt: T0 + k * 1000, runId: "run" }, steps(k, pass));
    await index.putEvents(evs);
    await index.upsertSession(buildSession(evs));
    const r: RunResult = { id: `run_${String(k).padStart(3, "0")}`, experimentId: "exp_1", taskId, bundleId: "b".repeat(64), attempt, sessionId: sid, pass, verifierExit: pass ? 0 : 1, agent: { exitCode: 0, timedOut: false, durationMs: 5000, stdoutTail: "", stderrTail: "", usage: { costUsd: 0.01 } }, startedAt: T0 + k * 1000, endedAt: T0 + k * 1000 + 5000, ...extra };
    k++;
    await index.putRun(r);
  };
  let failing = 0;
  for (let t = 0; t < 6; t++) {
    for (let a = 1; a <= 5; a++) {
      const pass = !(failing < 12 && (a + t) % 2 === 0);
      if (!pass) failing++;
      await run(`t${t}`, a, pass);
    }
  }
  for (let a = 1; a <= 4; a++) await run("tdev", a, a > 2);
  await run("t0", 6, false, { cancelled: true });
  await run("t0", 7, false, { superseded: true });
  await run("t0", 8, false, { infra: "rate-limit" });
  return index;
}

const rows = <T>(file: string): T[] => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
function allFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(relative(dir, join(d, e.name)));
  };
  walk(dir);
  return out.sort();
}

describe("writeCorpusDir", () => {
  it("writes one row per counted run with its pass, leaves held-out tasks out and lists them", async () => {
    const index = await experimentStore();
    const dir = fresh();
    const r = await writeCorpusDir({ index, source: { kind: "experiment", experimentId: "exp_1" }, dir, prompt: [{ path: "CLAUDE.md", text: "Run the tests.\n" }] });
    const eps = rows<EpisodeRow>(join(dir, "episodes.jsonl"));
    assert.equal(eps.length, 30);
    assert.equal(r.episodes, 30);
    assert.equal(eps.filter((e) => e.pass === false).length, 12);
    assert.equal(r.failures, 12);
    assert.equal(r.passRate, 18 / 30);
    assert.deepEqual(r.leftOut, { tasks: ["task-tdev"], runs: 4 });
    assert.deepEqual(r.skipped, { cancelled: 1, superseded: 1, infra: 1 });
    assert.ok(!eps.some((e) => e.taskId === "tdev"), "no dev-split run is written");
    assert.ok(!readFileSync(join(dir, "episodes.jsonl"), "utf8").includes("tdev"));
    // Each row's pass matches its run; runs stay in a fixed order.
    const all = await index.listRuns({ experimentId: "exp_1" });
    for (const e of eps) assert.equal(e.pass, all.find((x) => x.sessionId === e.sessionId)!.pass);
    assert.deepEqual(eps.map((e) => e.episode).slice(0, 3), ["ep0001", "ep0002", "ep0003"]);
    assert.equal(eps[0]!.task, "task-t0");
    assert.deepEqual(eps[0]!.tags, ["area:ui"]);
    assert.equal(eps[0]!.toolCalls, 2);
    assert.equal(eps[0]!.costUsd, 0.01);

    const calls = rows<ToolCallRow>(join(dir, "tool_calls.jsonl"));
    assert.equal(calls.length, 60);
    assert.deepEqual(Object.keys(calls[0]!), ["episode", "seq", "ts", "tool", "ok", "inputPreview", "inputSha", "outputBytes", "outputPreview"]);
    assert.ok(calls.every((c) => c.outputPreview.length <= PREVIEW_CHARS + 1 && c.inputPreview.length <= PREVIEW_CHARS + 1));
    assert.ok(calls.some((c) => c.tool === "Edit" && c.ok === false));
    assert.equal(new Set(calls.filter((c) => c.tool === "Bash").map((c) => c.inputSha)).size, 1, "duplicate inputs share a hash");

    assert.ok(existsSync(join(dir, "episodes", "ep0001", "transcript.md")));
    assert.match(readFileSync(join(dir, "episodes", "ep0001", "transcript.md"), "utf8"), /^# task-t0, attempt 1/);
    assert.equal(readFileSync(join(dir, "prompt", "CLAUDE.md"), "utf8"), "Run the tests.\n");
    assert.match(readFileSync(join(dir, "SCHEMA.md"), "utf8"), /## episodes\.jsonl/);
  });

  it("redacts a secret in tool output from every file", async () => {
    const dir = fresh();
    await writeCorpusDir({ index: await experimentStore(), source: { kind: "experiment", experimentId: "exp_1" }, dir, prompt: [{ path: "AGENTS.md", text: `key ${AWS_KEY}\n` }] });
    for (const f of allFiles(dir)) assert.ok(!readFileSync(join(dir, f), "utf8").includes(AWS_KEY), f);
    assert.match(readFileSync(join(dir, "tool_calls.jsonl"), "utf8"), /\[redacted:/, "the key was there and got redacted");
  });

  it("writes the same bytes twice", async () => {
    const index = await experimentStore();
    const a = fresh();
    const b = fresh();
    const prompt = [{ path: "CLAUDE.md", text: "x\n" }, { path: ".claude/skills/pdf/SKILL.md", text: "---\nname: pdf\n---\n" }];
    await writeCorpusDir({ index, source: { kind: "experiment", experimentId: "exp_1" }, dir: a, prompt });
    await writeCorpusDir({ index, source: { kind: "experiment", experimentId: "exp_1" }, dir: b, prompt: [...prompt].reverse() });
    const fa = allFiles(a);
    assert.deepEqual(fa, allFiles(b));
    for (const f of fa) assert.equal(readFileSync(join(a, f), "utf8"), readFileSync(join(b, f), "utf8"), f);
    // Rewriting an earlier corpus in place gives the same bytes too.
    await writeCorpusDir({ index, source: { kind: "experiment", experimentId: "exp_1" }, dir: a, prompt });
    for (const f of fa) assert.equal(readFileSync(join(a, f), "utf8"), readFileSync(join(b, f), "utf8"), f);
  });

  it("caps a long transcript with a marker", async () => {
    const dir = fresh();
    const r = await writeCorpusDir({ index: await experimentStore(), source: { kind: "experiment", experimentId: "exp_1" }, dir, prompt: [], maxBytesPerEpisode: 600 });
    assert.equal(r.truncated, 30);
    const t = readFileSync(join(dir, "episodes", "ep0001", "transcript.md"), "utf8");
    assert.ok(Buffer.byteLength(t) < 700);
    assert.match(t, /…\[truncated: \d+ more events\]/);
  });

  it("refuses a non-empty directory that is not a corpus, and skips unsafe prompt paths", async () => {
    const dir = fresh();
    mkdirSync(dir);
    writeFileSync(join(dir, "notes.txt"), "mine\n");
    await assert.rejects(writeCorpusDir({ index: new MemoryIndexStore(), source: { kind: "experiment", experimentId: "x" }, dir, prompt: [] }), /not empty and holds no corpus/);
    assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "mine\n");
    const ok = fresh();
    await writeCorpusDir({ index: new MemoryIndexStore(), source: { kind: "experiment", experimentId: "x" }, dir: ok, prompt: [{ path: "../escape.md", text: "no" }, { path: "/abs.md", text: "no" }] });
    assert.ok(!existsSync(join(ok, "..", "escape.md")));
    assert.deepEqual(readdirSync(join(ok, "prompt")), []);
  });

  it("captured sessions: pass is null and flags count as failures", async () => {
    const index = new MemoryIndexStore();
    for (let i = 0; i < 3; i++) {
      const evs = sessionEvents(`x${i}`, { cwd: "/work/demo", startedAt: T0 + i * 1000 }, steps(i, true));
      await index.putEvents(evs);
      await index.upsertSession({ ...buildSession(evs), flags: i === 0 ? ["no-verification", "gateway:vercel"] : ["gateway:vercel"] });
    }
    const dir = fresh();
    const r = await writeCorpusDir({ index, source: { kind: "sessions", since: 0, repo: "/work/demo" }, dir, prompt: [] });
    const eps = rows<EpisodeRow>(join(dir, "episodes.jsonl"));
    assert.equal(eps.length, 3);
    assert.ok(eps.every((e) => e.pass === null));
    assert.deepEqual(eps[0]!.flags, ["no-verification"], "tags are not failures");
    assert.equal(r.failures, 1);
    assert.equal(r.passRate, null);
    const other = await writeCorpusDir({ index, source: { kind: "sessions", since: 0, repo: "/elsewhere" }, dir: fresh(), prompt: [] });
    assert.equal(other.episodes, 0);
  });

  it("held-out tags", () => {
    assert.equal(isHeldOut(["split:dev"]), true);
    assert.equal(isHeldOut(["Refine:Heldout"]), true);
    assert.equal(isHeldOut(["area:api", "test"]), false);
  });
});
