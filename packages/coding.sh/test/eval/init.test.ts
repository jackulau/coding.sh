import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { parseTriggerSpec } from "../../src/eval/trigger.ts";
import { draftCases, draftTriggers, DraftError } from "../../src/eval/draft.ts";
import { chooseGraders, ciWorkflow, initSuite, InitError, suiteName } from "../../src/eval/init.ts";
import { loadSuite } from "../../src/eval/suite-spec.ts";
import { importTaskDir } from "../../src/eval/task.ts";
import type { ChatProvider, ChatRequest } from "../../src/judge/providers.ts";
import { BUGGY, FIXED, FakeSnapshots, HIDDEN_TEST, MemBlobs, MemIndex, tempDir } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function project(): Promise<string> {
  const d = await tempDir("csh-init-");
  dirs.push(d);
  return d;
}

/** A provider that answers every request with `reply`, and records the requests. */
function fakeProvider(reply: unknown): ChatProvider & { reqs: ChatRequest[] } {
  const reqs: ChatRequest[] = [];
  return {
    name: "fake",
    model: "fake-1",
    params: {},
    reqs,
    async complete(req) {
      reqs.push(req);
      return { text: typeof reply === "string" ? reply : JSON.stringify(reply), model: "fake-1" } as Awaited<ReturnType<ChatProvider["complete"]>>;
    },
  };
}

const deps = () => ({ index: new MemIndex(), blobs: new MemBlobs() });

describe("suiteName", () => {
  it("slugs names and refuses empty ones", () => {
    assert.equal(suiteName("My Suite!"), "my-suite");
    assert.throws(() => suiteName("!!!"), InitError);
  });
});

describe("chooseGraders", () => {
  it("picks exact for short expected answers, a reference judge for long ones, a rubric judge for none", () => {
    assert.deepEqual(chooseGraders([{ expected: "bug" }, { expected: 4 }]), { graders: [{ kind: "exact", normalize: { caseInsensitive: true, collapseWhitespace: true } }], judge: false });
    const long = chooseGraders([{ expected: "A paragraph\nthat spans lines" }]);
    assert.equal(long.judge, true);
    assert.equal((long.graders[0] as { name: string }).name, "matches-expected");
    const none = chooseGraders([{}, {}], "Answers billing questions politely");
    assert.equal(none.judge, true);
    assert.match((none.graders[0] as { rubric: string }).rubric, /Answers billing questions politely/);
    assert.equal(chooseGraders([{ expected: "a" }, {}]).judge, true, "an exact grader needs every case to have an answer");
  });
});

describe("initSuite: cases", () => {
  it("references a given cases file and picks a code grader", async () => {
    const root = await project();
    await writeFile(join(root, "cases.jsonl"), '{"input":"charged twice","expected":"billing"}\n{"input":"crash","expected":"bug"}\n');
    const r = await initSuite({ name: "triage", root, source: "cases", casesFile: "cases.jsonl", command: "node app.mjs" }, deps());
    assert.equal(r.kind, "cases");
    assert.equal(r.purpose, "regression");
    assert.equal(r.drafted, false);
    assert.deepEqual(r.files, ["evals/triage/suite.json"]);
    const s = await loadSuite(r.dir);
    assert.equal(s.spec.cases, "../../cases.jsonl");
    assert.deepEqual(s.spec.task, { kind: "command", command: "node app.mjs" });
    assert.equal((s.spec.graders![0] as { kind: string }).kind, "exact");
    assert.equal(s.spec.trials, 3);
    assert.match(r.ci!, /command: eval run triage --yes/);
    assert.ok(r.notes.some((n) => /2 cases: grow toward 20 to 50/.test(n)));
    await assert.rejects(initSuite({ name: "triage", root, source: "cases", casesFile: "cases.jsonl", command: "x" }, deps()), (e: Error) => e instanceof InitError && /already exists\. Replacing it deletes the suite's files: ask the user, and pass --force only once they approve/.test(e.message) && e.askUser === true);
    await initSuite({ name: "triage", root, source: "cases", casesFile: "cases.jsonl", url: "http://localhost:1/x", force: true, trials: 5, purpose: "capability" }, deps());
    const again = await loadSuite(r.dir);
    assert.deepEqual([again.spec.task, again.spec.trials, again.spec.purpose], [{ kind: "http", url: "http://localhost:1/x" }, 5, "capability"]);
  });

  it("--force keeps files you added or changed unless forceAll", async () => {
    const root = await project();
    await writeFile(join(root, "cases.jsonl"), '{"input":"crash","expected":"bug"}\n');
    const o = { name: "triage", root, source: "cases" as const, casesFile: "cases.jsonl", command: "node app.mjs" };
    const r = await initSuite(o, deps());
    // Untouched: --force replaces it.
    await initSuite({ ...o, force: true, trials: 5 }, deps());
    // A file you added (a reference solution, notes) is refused, and so is an edit to a written one.
    await mkdir(join(r.dir, "tasks", "t1"), { recursive: true });
    await writeFile(join(r.dir, "tasks", "t1", "reference.patch"), "diff\n");
    await assert.rejects(initSuite({ ...o, force: true }, deps()), (e: Error) => e instanceof InitError && /evals\/triage has files eval init did not write, or that changed since: tasks\/t1\/reference\.patch\. Move them out first, or ask the user and pass --force-all/.test(e.message) && e.askUser === true);
    assert.ok(existsSync(join(r.dir, "tasks", "t1", "reference.patch")), "nothing was deleted");
    await rm(join(r.dir, "tasks"), { recursive: true });
    await writeFile(join(r.dir, "suite.json"), (await readFile(join(r.dir, "suite.json"), "utf8")).replace('"trials": 5', '"trials": 9'));
    await assert.rejects(initSuite({ ...o, force: true }, deps()), /changed since: suite\.json\./);
    // forceAll deletes them.
    await mkdir(join(r.dir, "tasks", "t1"), { recursive: true });
    await writeFile(join(r.dir, "tasks", "t1", "reference.patch"), "diff\n");
    await initSuite({ ...o, force: true, forceAll: true }, deps());
    assert.ok(!existsSync(join(r.dir, "tasks")));
    assert.equal((await loadSuite(r.dir)).spec.trials, 3);
    // A file that was there before eval init wrote the suite stays yours.
    await rm(r.dir, { recursive: true });
    await mkdir(r.dir, { recursive: true });
    await writeFile(join(r.dir, "NOTES.md"), "mine\n");
    await initSuite(o, deps());
    await assert.rejects(initSuite({ ...o, force: true }, deps()), /changed since: NOTES\.md\./);
    // A suite dir eval init never wrote (no manifest) is all yours.
    await rm(join(r.dir, ".eval-init.json"));
    await assert.rejects(initSuite({ ...o, force: true }, deps()), /did not write, or that changed since: NOTES\.md, suite\.json\./);
  });

  it("writes drafted cases with should / should-not tags, marked draft, and a judge for open answers", async () => {
    const root = await project();
    const provider = fakeProvider({
      cases: [
        { input: "Where is my refund?", should: true, note: "plain billing" },
        { input: "Where is my refund?", should: true },
        { input: "Tell me a joke", should: false },
      ],
    });
    const r = await initSuite({ name: "support", root, source: "cases", command: "node bot.mjs", description: "Answers billing questions", draft: true, provider }, deps());
    assert.equal(r.drafted, true);
    assert.match(provider.reqs[0]!.user, /Answers billing questions/);
    const lines = (await readFile(join(r.dir, "cases.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines, [
      { id: "where-is-my-refund", input: "Where is my refund?", tags: ["should"], metadata: { draft: true, note: "plain billing" } },
      { id: "tell-me-a-joke", input: "Tell me a joke", tags: ["should-not"], metadata: { draft: true } },
    ]);
    const s = await loadSuite(r.dir);
    assert.equal((s.spec.graders![0] as { kind: string }).kind, "llm");
    assert.ok(r.notes.some((n) => /judge calibrate/.test(n)));
    assert.ok(r.notes.some((n) => /fake fake-1 drafted 2 cases/.test(n)));
  });

  it("says what is missing", async () => {
    const root = await project();
    await assert.rejects(initSuite({ name: "x", root, source: "cases", casesFile: "c.jsonl" }, deps()), /--command/);
    await assert.rejects(initSuite({ name: "x", root, source: "cases", command: "x" }, deps()), /needs cases/);
    await assert.rejects(initSuite({ name: "x", root, source: "cases", command: "x", draft: true, provider: fakeProvider({}) }, deps()), /--describe/);
    await assert.rejects(initSuite({ name: "x", root, source: "cases", command: "x", trials: 0, cases: [{ input: "a" }] }, deps()), /trials/);
  });
});

describe("initSuite: skill", () => {
  async function skillDir(root: string) {
    for (const [n, d] of [["pdf", "Read, fill and merge PDF files"], ["csv", "Clean CSV files"]] as const) {
      await mkdir(join(root, ".claude", "skills", n), { recursive: true });
      await writeFile(join(root, ".claude", "skills", n, "SKILL.md"), `---\nname: ${n}\ndescription: ${d}\n---\nbody\n`);
    }
    return ".claude/skills/pdf";
  }

  it("uses the skill's own triggers.toml instead of writing a template", async () => {
    const root = await project();
    const skill = await skillDir(root);
    const own = '[[should]]\nprompt = "merge a.pdf and b.pdf"\n\n[[should_not]]\nprompt = "clean up this CSV"\n';
    await writeFile(join(root, skill, "triggers.toml"), own);
    const r = await initSuite({ name: "pdf", root, source: "skill", skill }, deps());
    assert.deepEqual([r.todo, r.drafted, r.files], [false, false, ["evals/pdf/suite.json"]]);
    assert.ok(!existsSync(join(r.dir, "triggers.toml")), "no copy, no TODO template");
    const s = await loadSuite(r.dir);
    assert.equal(s.spec.triggers, "../../.claude/skills/pdf/triggers.toml");
    assert.equal(await readFile(join(r.dir, s.spec.triggers!), "utf8"), own);
    assert.ok(r.notes.some((n) => /uses the skill's own triggers\.toml \(1 should, 1 should-not prompts\)/.test(n)));
    // Prompts you pass (or --draft) still go to the suite's own file.
    const given = await initSuite({ name: "pdf2", root, source: "skill", skill, should: ["fill this form"], shouldNot: ["sum these numbers"] }, deps());
    assert.equal((await loadSuite(given.dir)).spec.triggers, "triggers.toml");
    await writeFile(join(root, skill, "triggers.toml"), "[[should]]\nprompt = 3\n");
    await assert.rejects(initSuite({ name: "pdf3", root, source: "skill", skill }, deps()), InitError);
  });

  it("writes a TODO template when no prompts are given, which still parses", async () => {
    const root = await project();
    const r = await initSuite({ name: "pdf", root, source: "skill", skill: await skillDir(root) }, deps());
    assert.equal(r.kind, "triggers");
    assert.equal(r.purpose, "regression");
    assert.equal(r.todo, true);
    const toml = await readFile(join(r.dir, "triggers.toml"), "utf8");
    const spec = parseTriggerSpec(toml);
    assert.equal(spec.should.length, 3);
    assert.ok(spec.should.every((p) => p.prompt.startsWith("TODO:")));
    const s = await loadSuite(r.dir);
    assert.equal(s.spec.skill, "../../.claude/skills/pdf");
    assert.match(r.ci!, /npm install -g @anthropic-ai\/claude-code/);
  });

  it("uses given prompts, and drafts the missing side with the siblings in view", async () => {
    const root = await project();
    const skill = await skillDir(root);
    const given = await initSuite({ name: "pdf", root, source: "skill", skill, should: ["merge a.pdf and b.pdf"], shouldNot: ["clean data.csv"] }, deps());
    assert.equal(given.todo, false);
    assert.deepEqual(parseTriggerSpec(await readFile(join(given.dir, "triggers.toml"), "utf8")).shouldNot.map((p) => p.prompt), ["clean data.csv"]);

    const provider = fakeProvider({ should: ["fill tax.pdf", "fill tax.pdf", "split a pdf"], should_not: ["clean data.csv", "split a pdf"] });
    const r = await initSuite({ name: "pdf", root, source: "skill", skill, should: ["merge a.pdf and b.pdf"], draft: true, provider, force: true }, deps());
    assert.equal(r.drafted, true);
    assert.match(provider.reqs[0]!.user, /csv: Clean CSV files/);
    const toml = await readFile(join(r.dir, "triggers.toml"), "utf8");
    assert.match(toml, /^# DRAFT: a model wrote these/m);
    const spec = parseTriggerSpec(toml);
    assert.deepEqual(spec.should.map((p) => p.prompt), ["merge a.pdf and b.pdf"], "given prompts are kept");
    assert.deepEqual(spec.shouldNot.map((p) => p.prompt), ["clean data.csv"], "a prompt on both sides is dropped from should_not");
  });

  it("needs a readable skill", async () => {
    const root = await project();
    await assert.rejects(initSuite({ name: "x", root, source: "skill" }, deps()), /--skill/);
    await assert.rejects(initSuite({ name: "x", root, source: "skill", skill: "nope" }, deps()), InitError);
  });
});

describe("initSuite: sessions", () => {
  const ROOT = "/work/toy";
  let seq = 0;
  const ev = (sessionId: string, kind: AgentEvent["kind"], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent => ({ id: `e${++seq}`, v: 0, sessionId, ts: 1000 + seq, agent: "claude-code", kind, payload, ...extra });
  async function world() {
    const d = deps();
    const git = new FakeSnapshots().add("start", BUGGY).add("end", { ...FIXED, "src/add.js": "wrong\n", "test/add.test.js": HIDDEN_TEST }).add("good", FIXED);
    const session = (id: string, extra: Partial<Session>): Session => ({
      id,
      agent: "claude-code",
      repo: { root: ROOT, head: "abc", snapshot: "start" },
      startedAt: 10_000,
      stats: { events: 0, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 1 },
      flags: [],
      endSnapshot: "end",
      ...extra,
    });
    await d.index.upsertSession(session("failed", { flags: ["test-failures", "skill:pdf"] }));
    await d.index.upsertSession(session("tagged-only", { flags: ["skill:pdf"], endSnapshot: "good" }));
    await d.index.upsertSession(session("old", { flags: ["test-failures"], startedAt: 1 }));
    for (const id of ["failed", "tagged-only", "old"]) {
      await d.index.putEvents([ev(id, "session.start", {}, { repo: { root: ROOT, head: "abc", snapshot: "start" } }), ev(id, "user.message", { text: `fix add and mul (${id})` }), ev(id, "tool.start", { tool: "Bash", toolUseId: `t${id}`, input: { command: "node test/add.test.js" } })]);
    }
    return { ...d, git };
  }

  it("drafts tasks from recent failed sessions only, the failed diff as a near miss", async () => {
    const root = await project();
    const w = await world();
    const r = await initSuite({ name: "failures", root, source: "sessions", hiddenTests: ["test/**"], since: 5_000 }, { ...w, now: 12_000 });
    assert.equal(r.kind, "tasks");
    assert.equal(r.purpose, "capability");
    assert.equal(r.ci, undefined, "repo tasks pin this machine's snapshots");
    assert.deepEqual(r.tasks!.map((t) => t.sessionId), ["failed"], "a tag (skill:pdf) is not a failure, and old sessions are out");
    assert.equal(r.spec.agent, "claude-code");
    const [dir] = r.files.filter((f) => f.startsWith("evals/failures/tasks/"));
    const taskDir = join(root, dir!);
    assert.equal(existsSync(join(taskDir, "reference.patch")), false);
    assert.match(await readFile(join(taskDir, "near-misses", "001.patch"), "utf8"), /wrong/);
    assert.ok(r.notes.some((n) => /near-misses\/001\.patch/.test(n)));
    const t = await importTaskDir(taskDir, w.blobs);
    assert.ok(t.tags.includes("suite:failures"));
    assert.equal(t.verifier.command, "node test/add.test.js");
    assert.equal((await w.index.listTasks()).length, 1, "stored too, so compare --tag suite:failures finds it");
  });

  it("ranks flagged sessions and leaves out the ones that can't become a task", async () => {
    const root = await project();
    const w = await world();
    await w.index.upsertSession({ ...(await w.index.getSession("failed"))!, id: "sub", parent: { sessionId: "failed" }, startedAt: 11_000 });
    await w.index.upsertSession({ ...(await w.index.getSession("failed"))!, id: "noprompt", startedAt: 11_000 });
    await w.index.putEvents([ev("sub", "session.start", {}, { repo: { root: ROOT, head: "abc", snapshot: "start" } }), ev("sub", "user.message", { text: "subtask" }), ev("noprompt", "session.start", {}, { repo: { root: ROOT, head: "abc", snapshot: "start" } })]);
    const r = await initSuite({ name: "ranked", root, source: "sessions", since: 5_000 }, { ...w, now: 12_000 });
    assert.deepEqual(r.tasks!.map((t) => t.sessionId), ["failed"]);
    assert.ok(r.notes.some((n) => /left out 2 flagged session\(s\) that can't become a task: 1 subagent, 1 no-user-prompt/.test(n)), r.notes.join("\n"));
  });

  it("keeps the diff as the reference for a named session that didn't fail", async () => {
    const root = await project();
    const w = await world();
    const r = await initSuite({ name: "named", root, source: "sessions", sessionIds: ["tagged-only"] }, w);
    const [dir] = r.files.filter((f) => f.includes("/tasks/"));
    assert.equal(existsSync(join(root, dir!, "reference.patch")), true);
    await assert.rejects(initSuite({ name: "none", root, source: "sessions", sessionIds: ["nope"] }, w), /no session nope/);
  });

  it("says where to look when nothing failed", async () => {
    const root = await project();
    await assert.rejects(initSuite({ name: "f", root, source: "sessions" }, deps()), /no failed or flagged sessions .* in the last 14 days.*--repo <DIR\|all>/);
  });

  it("with sessionsRepo, takes sessions from another checkout of the project, or from any with all", async () => {
    const root = await project();
    const w = await world();
    const r = await initSuite({ name: "wt", root, source: "sessions", sessionsRepo: "/work", since: 5_000 }, { ...w, now: 12_000 });
    assert.deepEqual(r.tasks!.map((t) => t.sessionId), ["failed"], "/work/toy is under /work");
    const all = await initSuite({ name: "any", root, source: "sessions", sessionsRepo: "all", since: 5_000 }, { ...w, now: 12_000 });
    assert.deepEqual(all.tasks!.map((t) => t.sessionId), ["failed"]);
    await assert.rejects(initSuite({ name: "none", root, source: "sessions", sessionsRepo: "/elsewhere", since: 5_000 }, { ...w, now: 12_000 }), /no failed or flagged sessions in \/elsewhere/);
  });
});

describe("draft", () => {
  it("rejects a reply with no usable draft", async () => {
    await assert.rejects(draftCases(fakeProvider("no json here"), { description: "x" }), DraftError);
    await assert.rejects(draftCases(fakeProvider({ cases: [{ input: " " }] }), { description: "x" }), /no usable cases/);
    await assert.rejects(draftTriggers(fakeProvider({ should: ["a"], should_not: [] }), { skill: "s", description: "d" }), /both should and should_not/);
  });
  it("caps the count and passes the schema", async () => {
    const p = fakeProvider({ cases: Array.from({ length: 30 }, (_, i) => ({ input: `q${i}`, expected: `a${i}`, should: i % 2 === 0 })) });
    const cases = await draftCases(p, { description: "x", n: 4, examples: [{ input: "seed", expected: "s" }] });
    assert.deepEqual(cases.map((c) => [c.input, c.expected, c.should]), [["q0", "a0", true], ["q1", "a1", false], ["q2", "a2", true], ["q3", "a3", false]]);
    assert.ok(p.reqs[0]!.jsonSchema);
    assert.match(p.reqs[0]!.user, /"input":"seed"/);
  });
});

describe("ciWorkflow", () => {
  it("runs the suite with the coding.sh action pinned to this release, allowed to comment", () => {
    const y = ciWorkflow("triage", "cases", undefined, "1.2.3");
    assert.match(y, /- uses: jackulau\/coding\.sh@v1\.2\.3\n {8}with:\n {10}command: eval run triage --yes\n/);
    assert.match(y, /pull-requests: write/);
    assert.doesNotMatch(y, /claude-code|setup-node/);
    assert.doesNotMatch(ciWorkflow("pdf", "triggers", "codex"), /claude-code/);
    assert.match(ciWorkflow("pdf", "triggers"), /npm install -g @anthropic-ai\/claude-code\n {6}- uses: jackulau\/coding\.sh@v/, "Claude Code is installed before the action runs the suite");
  });
});
