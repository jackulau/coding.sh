// refine mine (R2-5): failure patterns across sessions from an in-memory index
// of synthetic events. Made up from scratch: no real session content.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, EvalTask, RunResult } from "../../src/core/types.ts";
import {
  canonicalInstruction,
  errorSignatureFindings,
  evalFailureFindings,
  formatFindings,
  isImperative,
  mineFindings,
  normalizeErrorLine,
} from "../../src/refine/mine.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { sessionEvents } from "../helpers-decision.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 9);
const CWD = "/work/demo";

type Step = [AgentEvent["kind"], Record<string, unknown>];

async function indexOf(sessions: { id: string; day: number; steps: Step[]; runId?: string; agent?: string; flags?: string[] }[]): Promise<MemoryIndexStore> {
  const index = new MemoryIndexStore();
  for (const s of sessions) {
    const evs = sessionEvents(s.id, { cwd: CWD, startedAt: T0 + s.day * DAY, ...(s.runId ? { runId: s.runId } : {}), ...(s.agent ? { agent: s.agent } : {}) }, s.steps);
    await index.putEvents(evs);
    const built = buildSession(evs);
    const session = s.flags ? { ...built, flags: s.flags } : built;
    await index.upsertSession(s.runId ? { ...session, runId: s.runId } : session);
  }
  return index;
}

const tscFail = (id: string, out: string): Step[] => [
  ["tool.start", { tool: "Bash", toolUseId: id, input: { command: "npx tsc --noEmit" } }],
  ["tool.end", { tool: "Bash", toolUseId: id, ok: false, output: out }],
];

const opening: Step[] = [["session.start", {}], ["user.message", { text: "Add a --json flag to the export command." }]];

describe("normalizeErrorLine", () => {
  it("keeps error codes, blurs numbers, paths, hex ids and quoted names", () => {
    assert.equal(normalizeErrorLine("src/cli/a.ts(12,5): error TS2307: Cannot find module './x.ts' or its corresponding type declarations."), "<path>(#,#): error TS2307: Cannot find module '…' or its corresponding type declarations.");
    assert.equal(normalizeErrorLine("src/b.ts(3,1): error TS2307: Cannot find module \"y\"."), normalizeErrorLine("src/cli/a.ts(40,9): error TS2307: Cannot find module './x.ts'."));
    assert.notEqual(normalizeErrorLine("error TS1294: x"), normalizeErrorLine("error TS2307: x"));
    assert.equal(normalizeErrorLine("fatal: bad object deadbeef1234abcd in /home/user/repo"), "fatal: bad object <hex> in <path>");
    assert.equal(normalizeErrorLine("error[E0308]: mismatched types at line 42"), "error[E0308]: mismatched types at line #");
    assert.equal(normalizeErrorLine("use and/or"), "use and/or");
  });
});

describe("errorSignatureFindings and mineFindings", () => {
  it("20 TS2307 errors across 5 sessions on 3 days are one pattern with count 20 and 5 sessions", async () => {
    const sessions = [0, 1, 2, 3, 4].map((n) => ({
      id: `s${n}`,
      day: n % 3,
      steps: [
        ...opening,
        ...[0, 1, 2, 3].flatMap((k) => tscFail(`s${n}-t${k}`, `src/m${n}/f${k}.ts(${10 + k},${n + 1}): error TS2307: Cannot find module './dep${k}.ts' or its corresponding type declarations.\nFound 1 error.`)),
      ] as Step[],
    }));
    const index = await indexOf(sessions);
    const r = await mineFindings({ index });
    const errs = r.findings.filter((f) => f.kind === "error-signature");
    assert.equal(errs.length, 1);
    const f = errs[0]!;
    assert.equal(f.count, 20);
    assert.equal(f.support.sessions, 5);
    assert.equal(f.support.days, 3);
    assert.match(f.label, /error TS2307: Cannot find module '…'/);
    assert.equal(f.impact.wastedToolCalls, 20);
    assert.deepEqual(f.examples.map((e) => e.sessionId), ["s2", "s1", "s4", "s0", "s3"], "newest first, then by id");
    assert.equal(f.examples[0]!.eventIds.length, 4);
    assert.equal(r.analyzed, 5);
    assert.equal(r.findings[0]!.id, f.id, "the most wasteful pattern ranks first");
  });

  it("TS1294 at different line numbers in 3 sessions on 2 days → support {3, 2}; in 2 sessions → nothing", async () => {
    const mk = (n: number, day: number) => ({ id: `t${n}`, day, steps: [...opening, ...tscFail(`t${n}-x`, `src/a.ts(${n * 7},2): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.`)] as Step[] });
    const three = await mineFindings({ index: await indexOf([mk(1, 0), mk(2, 0), mk(3, 1)]) });
    const e = three.findings.filter((f) => f.kind === "error-signature");
    assert.equal(e.length, 1);
    assert.deepEqual({ s: e[0]!.support.sessions, d: e[0]!.support.days }, { s: 3, d: 2 });
    const two = await mineFindings({ index: await indexOf([mk(1, 0), mk(3, 1)]) });
    assert.equal(two.findings.filter((f) => f.kind === "error-signature").length, 0);
    assert.equal(two.belowSupport > 0, true);
    const loose = await mineFindings({ index: await indexOf([mk(1, 0), mk(3, 1)]), minSupport: { sessions: 2, days: 1 } });
    assert.equal(loose.findings.filter((f) => f.kind === "error-signature").length, 1);
  });

  it("redacts a secret in an error line", async () => {
    const key = ["sk-ant-api03-", "A".repeat(40)].join("");
    const mk = (n: number) => ({ id: `k${n}`, day: n, steps: [...opening, ...tscFail(`k${n}-x`, `Error: request failed with key ${key}`)] as Step[] });
    const r = await mineFindings({ index: await indexOf([mk(0), mk(1), mk(2)]) });
    const text = JSON.stringify(r);
    assert.ok(r.findings.some((f) => f.kind === "error-signature"));
    assert.ok(!text.includes(key), "the key appears nowhere");
    assert.ok(!formatFindings(r.findings).join("\n").includes(key));
  });
});

describe("repeated instructions", () => {
  const said = (id: string, day: number, text: string, extra: Step[] = []): { id: string; day: number; steps: Step[] } => ({
    id,
    day,
    steps: [...opening, ["assistant.message", { text: "Done." }], ["user.message", { text }], ...extra],
  });

  it("recognizes imperatives and folds the ways of saying 'done'", () => {
    assert.ok(isImperative("please run the tests before you say done"));
    assert.ok(isImperative("Never push to main."));
    assert.ok(!isImperative("The build is slow today."));
    assert.equal(canonicalInstruction("please run the tests before you say done"), canonicalInstruction("Run tests before saying it's done"));
    assert.equal(canonicalInstruction("run the tests before finishing"), canonicalInstruction("Run tests before saying it's done"));
  });

  it("three phrasings in 3 sessions are one finding labelled with the medoid; an agent's message and the opening prompt are ignored", async () => {
    const index = await indexOf([
      said("u1", 0, "Thanks. please run the tests before you say done"),
      said("u2", 1, "run the tests before finishing."),
      said("u3", 2, "Run tests before saying it's done!"),
      // The same words from an agent (a teammate's message) and as the task prompt.
      { id: "u4", day: 2, steps: [["session.start", {}], ["user.message", { text: "Run the tests before finishing." }], ["user.message", { text: "Run the tests before finishing.", from: "agent" }]] },
    ]);
    const r = await mineFindings({ index });
    const instr = r.findings.filter((f) => f.kind === "repeated-instruction");
    assert.equal(instr.length, 1);
    assert.equal(instr[0]!.support.sessions, 3);
    assert.equal(instr[0]!.count, 3);
    assert.deepEqual(new Set(instr[0]!.examples.map((e) => e.sessionId)), new Set(["u1", "u2", "u3"]));
    assert.ok(["please run the tests before you say done", "run the tests before finishing.", "Run tests before saying it's done!"].includes(instr[0]!.label));
  });

  it("an agent-sent instruction alone does not count", async () => {
    const agentOnly = (id: string, day: number) => ({ id, day, steps: [...opening, ["user.message", { text: "Run the tests before finishing.", from: "agent" }]] as Step[] });
    const r = await mineFindings({ index: await indexOf([agentOnly("a1", 0), agentOnly("a2", 1), agentOnly("a3", 2)]) });
    assert.equal(r.findings.filter((f) => f.kind === "repeated-instruction").length, 0);
  });

  it("leaves out runId sessions and keeps ids stable across calls", async () => {
    const steps = (n: number): Step[] => [...opening, ...tscFail(`r${n}`, "Error: ENOENT: no such file or directory, open '/work/demo/x.json'")];
    const sessions = [
      { id: "o1", day: 0, steps: steps(1) },
      { id: "o2", day: 1, steps: steps(2) },
      { id: "e1", day: 1, steps: steps(3), runId: "run_1" },
      { id: "e2", day: 2, steps: steps(4), runId: "run_2" },
    ];
    const index = await indexOf(sessions);
    const r1 = await mineFindings({ index, evalRuns: false });
    assert.equal(r1.analyzed, 2);
    assert.equal(r1.findings.filter((f) => f.kind === "error-signature").length, 0, "2 organic sessions are below support");
    const loose = { index, evalRuns: false, minSupport: { sessions: 2, days: 2 } } as const;
    const a = await mineFindings(loose);
    const b = await mineFindings(loose);
    assert.deepEqual(a.findings.map((f) => f.id), b.findings.map((f) => f.id));
    assert.ok(a.findings.length > 0);
    assert.ok(a.findings.every((f) => f.examples.every((e) => !e.sessionId.startsWith("e"))));
  });
});

describe("flags and eval failures", () => {
  it("one finding per diagnosed flag with its severity", async () => {
    const edit: Step[] = [
      ...opening,
      ["tool.start", { tool: "Edit", toolUseId: "e", input: { file_path: `${CWD}/a.ts`, old_string: "a", new_string: "b" } }],
      ["tool.end", { tool: "Edit", toolUseId: "e", ok: true, output: "ok" }],
      ["assistant.message", { text: "All done, it works now." }],
      ["turn.end", {}],
    ];
    const index = await indexOf([0, 1, 2].map((d) => ({ id: `f${d}`, day: d, steps: edit, flags: ["no-verification", "gateway:vercel", "compaction"] })));
    const r = await mineFindings({ index });
    const flags = r.findings.filter((f) => f.kind === "flag");
    assert.deepEqual(flags.map((f) => f.signature), ["flag:no-verification"], "tags and context-only flags are not findings");
    const nv = flags.find((f) => f.signature === "flag:no-verification");
    assert.ok(nv, `flags: ${flags.map((f) => f.signature).join(", ")}`);
    assert.equal(nv!.support.sessions, 3);
    assert.equal(nv!.diagnosis?.nature, "risk");
  });

  it("groups failed runs by the first tool where they leave a passing attempt", () => {
    const evs = (sid: string, tools: string[]): AgentEvent[] => sessionEvents(sid, { cwd: CWD, startedAt: T0, runId: "x" }, tools.map((t, i) => ["tool.start", { tool: t, toolUseId: `${sid}${i}` }] as Step));
    const events = new Map<string, AgentEvent[]>([
      ["p", evs("p", ["Read", "Edit", "Bash"])],
      ["f1", evs("f1", ["Read", "Write"])],
      ["f2", evs("f2", ["Read", "Write", "Bash"])],
      ["f3", evs("f3", ["Read"])],
    ]);
    const sessions = new Map([...events].map(([id, e]) => [id, { ...buildSession(e), id }]));
    const run = (id: string, sid: string, pass: boolean): RunResult => ({ id, taskId: "t1", bundleId: "b", attempt: 1, sessionId: sid, pass, verifierExit: pass ? 0 : 1, agent: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" }, startedAt: T0, endedAt: T0 + 1 });
    const f = evalFailureFindings([run("a", "p", true), run("b", "f1", false), run("c", "f2", false), run("d", "f3", false)], sessions, events);
    const by = Object.fromEntries(f.map((x) => [x.signature, x.count]));
    assert.deepEqual(by, { "eval:Write": 2, "eval:<end>": 1 });
  });

  it("under a repo filter an eval run counts by the repo of its task, not by the scratch directory it ran in", async () => {
    const R = "/work/demo";
    const index = new MemoryIndexStore();
    const task = (id: string, repoRoot: string): EvalTask => ({ id, name: id, status: "validated", start: { repoRoot, snapshot: "s", head: "h" }, instruction: "Fix it.", setup: [], verifier: { command: "npm test", hiddenFiles: {}, timeoutMs: 1000 }, tags: [], createdAt: 0 });
    await index.putTask(task("t_here", R));
    await index.putTask(task("t_sub", `${R}/packages/api`));
    await index.putTask(task("t_other", "/work/other"));
    await index.putTask(task("t_empty", "/home/user/.coding.sh/repos/empty-start"));
    let k = 0;
    // Each run's agent works under the coding.sh home, as the runner has it: never under a repo.
    const run = async (taskId: string, day: number, pass: boolean, agent = "claude-code"): Promise<string> => {
      const sid = `run-s${k}`;
      const id = `run_${String(k++).padStart(2, "0")}`;
      const evs = sessionEvents(sid, { cwd: `/home/user/.coding.sh/runs/${id}/work`, startedAt: T0 + day * DAY, runId: id, agent }, (pass ? ["Read", "Edit", "Bash"] : ["Read"]).map((t, i) => ["tool.start", { tool: t, toolUseId: `${sid}-${i}` }] as Step));
      await index.putEvents(evs);
      await index.upsertSession({ ...buildSession(evs), runId: id });
      await index.putRun({ id, taskId, bundleId: "b", attempt: k, sessionId: sid, pass, verifierExit: pass ? 0 : 1, agent: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" }, startedAt: T0 + day * DAY, endedAt: T0 + day * DAY + 1 });
      return sid;
    };
    await run("t_here", 0, true);
    await run("t_sub", 0, true);
    const here = [await run("t_here", 0, false), await run("t_here", 1, false), await run("t_sub", 2, false, "codex")];
    await run("t_other", 0, true);
    const other = [await run("t_other", 0, false), await run("t_other", 1, false), await run("t_other", 2, false)];
    const empty = [await run("t_empty", 0, false), await run("t_empty", 1, false), await run("t_empty", 2, false)];

    const evalOf = (r: Awaited<ReturnType<typeof mineFindings>>) => r.findings.filter((f) => f.kind === "eval-failure");
    const mined = await mineFindings({ index, repo: R });
    assert.equal(mined.evalRuns, 5, "the two passing runs and the three failed ones of this repo's tasks");
    assert.equal(mined.analyzed, 0, "eval runs are not captured sessions");
    const [f, ...rest] = evalOf(mined);
    assert.deepEqual(rest, []);
    assert.equal(f!.count, 3);
    assert.deepEqual([f!.support.sessions, f!.support.days], [3, 3]);
    assert.deepEqual(f!.examples.map((e) => e.sessionId).sort(), [...here].sort());
    assert.ok(![...other, ...empty].some((sid) => f!.examples.some((e) => e.sessionId === sid)), "runs of another repo's task are left out");

    // The since and agent parts of the filter still apply to the run's session.
    assert.deepEqual(evalOf(await mineFindings({ index, repo: R, agents: ["codex"], minSupport: { sessions: 1, days: 1 } })).flatMap((x) => x.examples.map((e) => e.sessionId)), [here[2]]);
    assert.deepEqual(evalOf(await mineFindings({ index, repo: R, since: T0 + DAY, minSupport: { sessions: 1, days: 1 } })).map((x) => x.count), [2]);

    // A suite task that starts from an empty tree names no repo: the suites in the repo say it is theirs.
    const suite = evalOf(await mineFindings({ index, repo: R, repoTaskIds: new Set(["t_empty"]) }));
    assert.deepEqual(suite.flatMap((x) => x.examples.map((e) => e.sessionId)).sort(), [...here, ...empty].sort());
    assert.deepEqual(evalOf(await mineFindings({ index, repo: "/work/other" })).flatMap((x) => x.examples.map((e) => e.sessionId)).sort(), [...other].sort());
    // No repo filter: every failed run.
    assert.equal(evalOf(await mineFindings({ index })).reduce((n, x) => n + x.count, 0), 9);
  });

  it("error signatures come from failed calls only", () => {
    const evs = sessionEvents("z", { cwd: CWD, startedAt: T0 }, [
      ["tool.end", { tool: "Bash", toolUseId: "a", ok: true, output: "error TS2307: fine" }],
      ["tool.end", { tool: "Bash", toolUseId: "b", ok: false, output: "Exit code 2\nerror TS2307: Cannot find module 'x'" }],
    ]);
    const s = { ...buildSession(evs), id: "z" };
    const f = errorSignatureFindings([s], new Map([["z", evs]]));
    assert.equal(f.length, 1);
    assert.equal(f[0]!.count, 1);
    assert.equal(f[0]!.label, "error TS2307: Cannot find module '…'");
  });
});
