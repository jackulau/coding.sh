import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { formatCandidates, isDeliveryCommand, rankEvalCandidates, rankSessions, rejectSummary, type CandidateItem } from "../../src/eval/candidates.ts";
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
    { session: session("noedit", { flags: ["no-verification"], stats: { events: 3, turns: 1, toolCalls: 2, toolErrors: 0, filesChanged: 0 } }), events: events("noedit", { edits: false }) },
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
    assert.equal(rejectSummary(ranked), "1 subagent, 1 run, 1 no-git-start, 1 no-user-prompt, 1 no-edits, 1 external-deliverable");
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
    assert.deepEqual(c!.reasons, ["+2 premature-completion", "+2 repeated-tool-failure", "+1 no-verification", "+1 tests still failing", "+6 pushback ×3", "+2 verifier guessable", "+1 test edited after a failing run", "+1 multi-turn", "-1 compaction", "-1 over 300 tool calls"]);
    assert.equal(c!.score, 14);
  });

  it("is pure, filters and truncates", () => {
    const items = fixture();
    const before = JSON.stringify(items);
    const a = rankEvalCandidates(items, { now: NOW, eligibleOnly: true, limit: 1 });
    assert.deepEqual(a.map((c) => c.sessionId), ["flagged"]);
    assert.equal(JSON.stringify(items), before);
    assert.deepEqual(rankEvalCandidates(items, { now: NOW }), rankEvalCandidates(items, { now: NOW }));
    assert.match(formatCandidates(rankEvalCandidates(items, { now: NOW })), /1\.\s+9\s+flagged[\s\S]*verifier: pytest -q[\s\S]*rejected: subagent/);
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
    const r = await rankSessions(index, [...index.sessions.values()], { now: NOW, eligibleOnly: true });
    assert.deepEqual(r.map((c) => c.sessionId), ["flagged", "plain"]);
  });
});
