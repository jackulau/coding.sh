import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { shadowRepoPath } from "../../src/core/snapshot.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { formatCandidates, isDeliveryCommand, rankEvalCandidates, rankSessions, rejectSummary, startReadable, type CandidateItem } from "../../src/eval/candidates.ts";
import { MemIndex } from "../helpers-eval.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const ROOT = "/work/demo";
let seq = 0;

const ev = (sessionId: string, kind: AgentEvent["kind"], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent => ({ id: `e${++seq}`, v: 0, sessionId, ts: NOW - DAY + seq, agent: "claude-code", kind, payload, ...extra });

function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, agent: "claude-code", repo: { root: ROOT, head: "abc", snapshot: "snap" }, title: `fix ${id}`, startedAt: NOW - DAY, stats: { events: 5, turns: 1, toolCalls: 3, toolErrors: 0, filesChanged: 1 }, flags: [], endSnapshot: "end", ...extra };
}

/** A session that asked once, ran pytest (failed, then passed) and edited src/app.py. */
function events(id: string, opts: { pushback?: boolean; prompt?: boolean; shell?: string[]; edits?: boolean } = {}): AgentEvent[] {
  const out: AgentEvent[] = [ev(id, "session.start", {}, { repo: { root: ROOT, head: "abc", snapshot: "snap" } })];
  if (opts.prompt !== false) out.push(ev(id, "user.message", { text: "make the parser accept empty lines" }));
  out.push(ev(id, "tool.start", { tool: "Bash", toolUseId: `${id}-t1`, input: { command: "cd /work/demo && pytest -q 2>&1 | tail -5" } }));
  out.push(ev(id, "tool.end", { tool: "Bash", toolUseId: `${id}-t1`, ok: false }));
  if (opts.edits !== false) out.push(ev(id, "tool.start", { tool: "Edit", toolUseId: `${id}-t2`, input: { file_path: "/work/demo/src/app.py" } }));
  for (const [i, c] of (opts.shell ?? []).entries()) out.push(ev(id, "tool.start", { tool: "Bash", toolUseId: `${id}-s${i}`, input: { command: c } }));
  if (opts.pushback) out.push(ev(id, "user.message", { text: "no, that's wrong: blank lines must be skipped, not kept" }));
  out.push(ev(id, "tool.start", { tool: "Bash", toolUseId: `${id}-t3`, input: { command: "pytest -q" } }));
  out.push(ev(id, "tool.end", { tool: "Bash", toolUseId: `${id}-t3`, ok: true }));
  return out;
}

/** The fixture index from the acceptance criterion. */
function fixture(): CandidateItem[] {
  return [
    { session: session("plain"), events: events("plain") },
    { session: session("flagged", { flags: ["premature-completion", "skill:pdf"] }), events: events("flagged", { pushback: true }) },
    { session: session("sub", { flags: ["premature-completion"], parent: { sessionId: "flagged" } }), events: events("sub") },
    { session: session("run", { flags: ["repeated-tool-failure"], runId: "run_1" }), events: events("run") },
    { session: session("nogit", { flags: ["premature-completion"], repo: undefined }), events: events("nogit").map((e) => ({ ...e, repo: undefined })) },
    { session: session("noprompt", { flags: ["no-verification"] }), events: events("noprompt", { prompt: false }) },
    { session: session("noedit", { flags: ["no-verification"], endSnapshot: "snap", stats: { events: 3, turns: 1, toolCalls: 2, toolErrors: 0, filesChanged: 0 } }), events: events("noedit", { edits: false }) },
    { session: session("deploy", { flags: ["repeated-tool-failure"] }), events: events("deploy", { shell: ["gh pr create --fill", "git push origin HEAD", "vercel deploy --prod", "kubectl apply -f k8s.yaml"] }) },
  ];
}

describe("rankEvalCandidates", () => {
  it("rejects subagent, run, no-git-start, no-prompt, no-edit and deliver sessions, and ranks the flagged one with a git start first", () => {
    const ranked = rankEvalCandidates(fixture(), { now: NOW });
    assert.deepEqual(ranked.filter((c) => c.eligible).map((c) => c.sessionId), ["flagged", "plain"]);
    assert.deepEqual(
      Object.fromEntries(ranked.filter((c) => !c.eligible).map((c) => [c.sessionId, c.reject])),
      { sub: "subagent", run: "run", nogit: "no-git-start", noprompt: "no-user-prompt", noedit: "no-edits", deploy: "external-deliverable" },
    );
    assert.deepEqual(ranked.slice(2).map((c) => c.sessionId), ["deploy", "noedit", "nogit", "noprompt", "run", "sub"], "rejected last, by id");
    const top = ranked[0]!;
    assert.deepEqual(top.flags, ["premature-completion"], "tags are not failures");
    assert.match(top.verifierGuess!, /pytest/);
    assert.equal(top.pushback, 1);
    assert.deepEqual(top.reasons, ["+2 premature-completion", "+3 pushback ×1", "+2 verifier guessable", "+1 multi-turn", "+1 last 7 days"]);
    assert.equal(top.score, 9);
    assert.equal(rejectSummary(ranked), "1 subagent, 1 with a run id (CODING_SH_RUN_ID), 1 with no git state at its start, 1 with no user prompt, 1 that changed no files, 1 that mostly publishes or deploys");
    assert.equal(rejectSummary([...ranked, ...ranked]), "2 subagents, 2 with a run id (CODING_SH_RUN_ID), 2 with no git state at their start, 2 with no user prompt, 2 that changed no files, 2 that mostly publish or deploy");
  });

  it("ranks a pushback session above its twin without, and orders ties newest first then by id", () => {
    const twin = (id: string, pushback: boolean, startedAt = NOW - DAY): CandidateItem => ({ session: session(id, { startedAt }), events: events(id, { pushback }) });
    const r = rankEvalCandidates([twin("b", false), twin("a", false), twin("pb", true), twin("old", false, NOW - 30 * DAY)], { now: NOW });
    assert.deepEqual(r.map((c) => c.sessionId), ["pb", "a", "b", "old"]);
    assert.deepEqual(rankEvalCandidates([twin("b", false), twin("a", false)], { now: NOW }).map((c) => c.sessionId), ["a", "b"], "deterministic for equal scores and times");
  });

  it("scores test edits after a failing run, compaction and size; caps flags and pushback", () => {
    const id = "x";
    const evs = [
      ...events(id),
      ev(id, "tool.start", { tool: "Write", toolUseId: "w", input: { file_path: "/work/demo/tests/test_app.py" } }),
      ev(id, "context.compact", { trigger: "auto" }),
      ev(id, "user.message", { text: "still failing, try again" }),
      ev(id, "user.message", { text: "you broke the CLI" }),
      ev(id, "user.message", { text: "that's wrong too" }),
    ];
    const s = session(id, { flags: ["premature-completion", "repeated-tool-failure", "no-verification", "looping"], stats: { events: 9, turns: 4, toolCalls: 400, toolErrors: 3, filesChanged: 2, testsFailed: 2 } });
    const [c] = rankEvalCandidates([{ session: s, events: evs }], { now: NOW + 30 * DAY });
    assert.deepEqual(c!.reasons, ["+2 premature-completion", "+2 repeated-tool-failure", "+1 no-verification", "+1 tests still failing", "+6 pushback ×3", "+2 verifier guessable", "+1 test edited after a failing run", "+1 multi-turn", "-1 compacted context (harder to replay)", "-1 over 300 tool calls"]);
    assert.equal(c!.score, 14);
  });

  // A test command that exits 1 with plain output (`node test-sum.js`, or `npm test` on a hand-written script)
  // gives no counts, so stats.testsFailed stays empty. The session ended with its test failing all the same,
  // and ranked below sessions whose tests passed.
  it("counts a session whose last test command failed as tests still failing, though its output gave no counts", () => {
    const run = (id: string, ok: boolean, startedAt: number): CandidateItem => ({
      session: session(id, { startedAt }),
      events: [
        ev(id, "session.start", {}, { repo: { root: ROOT, head: "abc", snapshot: "snap" } }),
        ev(id, "user.message", { text: "make sum.js add its two arguments" }),
        ev(id, "tool.start", { tool: "Write", toolUseId: `${id}-w`, input: { file_path: "/work/demo/sum.js" } }),
        ev(id, "tool.start", { tool: "Bash", toolUseId: `${id}-t`, input: { command: "node test-sum.js" } }),
        ev(id, "tool.end", { tool: "Bash", toolUseId: `${id}-t`, ok }),
      ],
    });
    const r = rankEvalCandidates([run("passed", true, NOW - DAY + 2), run("failed", false, NOW - DAY)], { now: NOW });
    assert.deepEqual(r.map((c) => c.sessionId), ["failed", "passed"], "the session that ended failing ranks first, though it is older");
    assert.deepEqual(r[0]!.reasons, ["+1 tests still failing", "+2 verifier guessable", "+1 last 7 days"]);
    // A test command that failed and then passed is not still failing.
    const again = ev("fixed", "tool.start", { tool: "Bash", toolUseId: "fixed-t2", input: { command: "node test-sum.js" } });
    const fixed = [...run("fixed", false, NOW - DAY).events, again, ev("fixed", "tool.end", { tool: "Bash", toolUseId: "fixed-t2", ok: true })];
    const [c] = rankEvalCandidates([{ session: session("fixed"), events: fixed }], { now: NOW });
    assert.ok(!c!.reasons.includes("+1 tests still failing"), c!.reasons.join(", "));
  });

  it("reads the test command and the deploys through Antigravity's run_command and Droid's Execute, as through Bash", () => {
    const shells: [string, (command: string) => Record<string, unknown>][] = [
      ["Bash", (command) => ({ command })],
      ["run_command", (command) => ({ CommandLine: command, Cwd: ROOT })],
      ["Execute", (command) => ({ command })],
    ];
    for (const [tool, input] of shells) {
      const id = `via-${tool}`;
      const call = (n: number, command: string, ok: boolean) => [
        ev(id, "tool.start", { tool, toolUseId: `${id}-${n}`, input: input(command) }),
        ev(id, "tool.end", { tool, toolUseId: `${id}-${n}`, ok }),
      ];
      const start = [
        ev(id, "session.start", {}, { repo: { root: ROOT, head: "abc", snapshot: "snap" } }),
        ev(id, "user.message", { text: "make sum.js add its two arguments" }),
        ev(id, "tool.start", { tool: "Write", toolUseId: `${id}-w`, input: { file_path: "/work/demo/sum.js" } }),
      ];
      const [c] = rankEvalCandidates([{ session: session(id), events: [...start, ...call(1, `cd ${ROOT} && node test-sum.js`, false)] }], { now: NOW });
      assert.equal(c!.verifierGuess, "node test-sum.js", tool);
      assert.deepEqual(c!.reasons, ["+1 tests still failing", "+2 verifier guessable", "+1 last 7 days"], tool);
      const [d] = rankEvalCandidates([{ session: session(id), events: [...start, ...call(1, "gh pr create --fill", true), ...call(2, "vercel deploy --prod", true)] }], { now: NOW });
      assert.equal(d!.reject, "external-deliverable", tool);
    }
  });

  it("scores compaction only as the compacted-context penalty: it is a note, not a failure flag", () => {
    const id = "cmp";
    const s = session(id, { flags: ["compaction", "no-verification"] });
    const [c] = rankEvalCandidates([{ session: s, events: [...events(id), ev(id, "context.compact", { trigger: "auto" })] }], { now: NOW });
    assert.deepEqual(c!.flags, ["no-verification"]);
    assert.ok(c!.reasons.includes("+1 no-verification"), c!.reasons.join(", "));
    assert.ok(!c!.reasons.some((r) => r.endsWith(" compaction")), c!.reasons.join(", "));
    assert.ok(c!.reasons.includes("-1 compacted context (harder to replay)"), c!.reasons.join(", "));
    const labels = c!.reasons.map((r) => r.replace(/^[+-]\d+ /, ""));
    assert.equal(new Set(labels).size, labels.length, `a label repeats: ${c!.reasons.join(", ")}`);
  });

  it("is pure, filters and truncates", () => {
    const items = fixture();
    const before = JSON.stringify(items);
    const a = rankEvalCandidates(items, { now: NOW, eligibleOnly: true, limit: 1 });
    assert.deepEqual(a.map((c) => c.sessionId), ["flagged"]);
    assert.equal(JSON.stringify(items), before);
    assert.deepEqual(rankEvalCandidates(items, { now: NOW }), rankEvalCandidates(items, { now: NOW }));
    assert.match(formatCandidates(rankEvalCandidates(items, { now: NOW })), /1\.\s+9\s+flagged[\s\S]*verifier: pytest -q[\s\S]*rejected: a subagent's session: the session that started it is the one to use/);
  });

  it("tells delivery commands from repo work", () => {
    for (const c of ["gh pr create --fill", "git push -u origin main", "npm publish", "terraform apply", "docker push x/y", "cd infra && kubectl apply -f a.yaml"]) assert.ok(isDeliveryCommand(c), c);
    for (const c of ["git status", "npm test", "docker build .", "echo gh", "pytest -q"]) assert.ok(!isDeliveryCommand(c), c);
  });

  it("rankSessions loads events from the index", async () => {
    const index = new MemIndex();
    for (const it of fixture()) {
      await index.upsertSession(it.session);
      await index.putEvents([...it.events]);
    }
    // ROOT is not on this machine: the start state is taken as readable here.
    const r = await rankSessions(index, [...index.sessions.values()], { now: NOW, eligibleOnly: true, startReadable: () => true });
    assert.deepEqual(r.map((c) => c.sessionId), ["flagged", "plain"]);
  });

  it("counts a session whose end snapshot differs from its start as edited, though hooks saw no edit tool", () => {
    const stats = { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 };
    const viaShell = rankEvalCandidates([{ session: session("shell", { stats }), events: events("shell", { edits: false, shell: ["sed -i 's/a - b/a + b/' sum.js"] }) }], { now: NOW })[0]!;
    assert.equal(viaShell.eligible, true);
    const untouched = rankEvalCandidates([{ session: session("same", { stats, endSnapshot: "snap" }), events: events("same", { edits: false }) }], { now: NOW })[0]!;
    assert.equal(untouched.reject, "no-edits");
  });

  it("rankSessions compares files when the start state is only a HEAD commit (Bash edits, filesChanged 0)", async () => {
    const stats = { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 };
    const headOnly = (id: string) => session(id, { stats, repo: { root: ROOT, head: "abc" }, endSnapshot: "end" });
    const index = new MemIndex();
    for (const id of ["bash", "idle"]) {
      await index.upsertSession(headOnly(id));
      await index.putEvents(events(id, { edits: false, shell: ["sed -i 's/a - b/a + b/' sum.js"] }).map((e) => (e.kind === "session.start" ? { ...e, repo: { root: ROOT, head: "abc" } } : e)));
    }
    const diffSnapshots = async (_r: string, a: string, b: string) => ({ files: a === "abc" && b === "end" && calls++ < 1 ? [{ path: "sum.js" }] : [] });
    let calls = 0;
    const r = await rankSessions(index, [...index.sessions.values()], { now: NOW, diffSnapshots, startReadable: () => true });
    assert.deepEqual(r.map((c) => [c.sessionId, c.reject]), [["bash", undefined], ["idle", "no-edits"]]);
  });
});

// A session captured with `coding.sh run -- <cmd> "<prompt>"` has no typed prompt. `eval new` takes the
// command's prompt argument as the instruction, but eval candidates and eval init --sessions left the
// session out as having no user prompt.
describe("a session captured with coding.sh run --", () => {
  const T0 = NOW - DAY;
  const wrapper = (id: string, args: string[], extra: Partial<Session> = {}): CandidateItem => ({
    session: session(id, { agent: "wrapper", endedAt: T0 + 60_000, ...extra }),
    events: [
      ev(id, "session.start", { source: "wrapper", cmd: "node", args }, { agent: "wrapper", ts: T0, repo: { root: ROOT, head: "abc", snapshot: "snap" } }),
      ev(id, "file.change", { path: "mul.js", op: "modify", additions: 1, deletions: 1 }, { agent: "wrapper", ts: T0 + 50 }),
      ev(id, "session.end", { reason: "exit", exitCode: 0 }, { agent: "wrapper", ts: T0 + 60_000 }),
    ],
  });

  it("takes the command's prompt argument as its prompt, as eval new does", () => {
    const r = rankEvalCandidates([wrapper("wprompt", ["agent.mjs", "make mul multiply its arguments"]), wrapper("wbare", ["agent.mjs", "--fix"])], { now: NOW });
    assert.deepEqual(
      r.map((c) => [c.sessionId, c.eligible, c.reject]),
      [
        ["wprompt", true, undefined],
        ["wbare", false, "no-user-prompt"],
      ],
    );
  });

  it("does not take a script, a setting or a path for a prompt", () => {
    const r = rankEvalCandidates(
      [
        wrapper("wscript", ["-c", "npm run build"]),
        wrapper("wenv", ["GREETING=hello world", "agent.mjs"]),
        wrapper("wpath", ["agent.mjs", "--config", "/srv/my configs/agent.toml"]),
      ],
      { now: NOW },
    );
    assert.deepEqual(Object.fromEntries(r.map((c) => [c.sessionId, c.reject])), {
      wscript: "no-user-prompt",
      wenv: "no-user-prompt",
      wpath: "no-user-prompt",
    });
  });

  it("rankSessions leaves out a wrapped command that changed no files, though its two snapshots are different commits", async () => {
    // Each snapshot is a new commit, so a start and an end snapshot of the same files have different ids.
    const index = new MemIndex();
    const idle = wrapper("widle", ["agent.mjs", "make mul multiply its arguments"], { stats: { events: 2, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 } });
    await index.upsertSession(idle.session);
    await index.putEvents(idle.events.filter((e) => e.kind !== "file.change"));
    const diffSnapshots = async (_r: string, a: string, b: string) => ({ files: a === "snap" && b === "end" ? [] : [{ path: "?" }] });
    const r = await rankSessions(index, [...index.sessions.values()], { now: NOW, diffSnapshots, startReadable: () => true });
    assert.deepEqual(r.map((c) => [c.sessionId, c.reject]), [["widle", "no-edits"]]);
  });

  it("rankSessions leaves out a wrapper around a session captured inside it, and names that session", async () => {
    const index = new MemIndex();
    const items = [
      wrapper("wrap-1", ["-p", "make mul multiply its arguments"]),
      { session: session("inner-claude-1", { startedAt: T0 + 1_000, endedAt: T0 + 50_000, repo: { root: ROOT, head: "abc" } }), events: events("inner-claude-1") },
      { session: session("earlier-1", { startedAt: T0 - 3_600_000, endedAt: T0 - 3_000_000 }), events: events("earlier-1") },
    ];
    for (const it of items) {
      await index.upsertSession(it.session);
      await index.putEvents([...it.events]);
    }
    const r = await rankSessions(index, [...index.sessions.values()], { now: NOW, startReadable: () => true });
    const byId = Object.fromEntries(r.map((c) => [c.sessionId, c]));
    assert.deepEqual([byId["wrap-1"]!.reject, byId["wrap-1"]!.wrapped], ["wrapped", "inner-claude-1"]);
    assert.equal(byId["inner-claude-1"]!.eligible, true);
    assert.equal(byId["earlier-1"]!.eligible, true, "a session that ended before the wrapper started is not inside it");
    const text = formatCandidates(r);
    // The whole id, or the reference a ref function gives (eval candidates passes core/session-ref.ts shortener).
    assert.ok(text.includes("rejected: it wrapped session inner-claude-1, which recorded the same work: that session is the one to use"), text);
    assert.ok(formatCandidates(r, (id) => `<${id}>`).includes("rejected: it wrapped session <inner-claude-1>, which"));
    assert.equal(rejectSummary(r), "1 that wrapped another session");
  });
});

// A session whose repository was moved or deleted ranked first, and `eval init --session` then failed on
// it ("the session's repository ... is gone"). Sessions read from another machine's transcripts were
// left out as "no-git-start", a code that did not say their folder is not here either.
describe("a session's folder that is not on this machine", () => {
  it("rankSessions leaves out a session whose repository is gone, and says where it was", async () => {
    const index = new MemIndex();
    const gone = join(tmpdir(), "csh-cand-moved-away");
    for (const it of [
      { session: session("here"), events: events("here") },
      { session: session("moved", { repo: { root: gone, head: "abc", snapshot: "snap" } }), events: events("moved").map((e) => (e.repo ? { ...e, repo: { root: gone, head: "abc", snapshot: "snap" } } : e)) },
      { session: session("transcript", { repo: undefined, cwd: gone }), events: events("transcript").map((e) => ({ ...e, repo: undefined })) },
    ]) {
      await index.upsertSession(it.session);
      await index.putEvents([...it.events]);
    }
    const r = await rankSessions(index, [...index.sessions.values()], { now: NOW, startReadable: (root) => root !== gone });
    assert.deepEqual(
      r.map((c) => [c.sessionId, c.reject, c.gone]),
      [
        ["here", undefined, undefined],
        ["moved", "repo-gone", gone],
        ["transcript", "no-git-start", gone],
      ],
    );
    const text = formatCandidates(r);
    assert.ok(text.includes(`rejected: its repository ${gone} is not on this machine, so its start can't be rebuilt: put the repository back at that path to use it`), text);
    assert.ok(text.includes(`rejected: no git commit was recorded at its start (read from a transcript, or not in a git repository), so its start can't be rebuilt, and its folder ${gone} is not on this machine`), text);
    assert.equal(rejectSummary(r), "1 with no git state at its start, 1 whose repository is gone");
  });

  it("startReadable: a folder that is there, or this store's copy of a removed worktree whose main checkout still holds the objects", async () => {
    const base = mkdtempSync(join(tmpdir(), "csh-cand-readable-"));
    try {
      const env = { ...process.env, CODING_SH_HOME: join(base, "home") };
      const main = join(base, "main");
      mkdirSync(join(main, ".git", "objects"), { recursive: true });
      const shadowOf = (root: string, alternates: string) => {
        const shadow = shadowRepoPath(root, env);
        mkdirSync(join(shadow, "objects", "info"), { recursive: true });
        writeFileSync(join(shadow, "HEAD"), "ref: refs/heads/main\n");
        writeFileSync(join(shadow, "objects", "info", "alternates"), `${alternates}\n`);
      };
      assert.equal(await startReadable(main, env), true, "the folder is there");
      assert.equal(await startReadable(join(base, "never-here"), env), false, "no folder and no copy");
      shadowOf(join(base, "wt-removed"), join(main, ".git", "objects"));
      assert.equal(await startReadable(join(base, "wt-removed"), env), true, "a removed worktree reads through its main checkout's objects");
      shadowOf(join(base, "wt-orphan"), join(base, "main-deleted", ".git", "objects"));
      assert.equal(await startReadable(join(base, "wt-orphan"), env), false, "the objects it borrows are gone too");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
