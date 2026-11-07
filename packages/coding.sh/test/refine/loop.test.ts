// The refine loop's pure parts (R2-7, R2-8): findings, the proposer's prompt
// and reply, the pre-trial critics, the round's keep rule and the ledger.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Session } from "../../src/schema/index.ts";
import { acceptanceGatePaired } from "../../src/stats/tests.ts";
import { gateVerdict } from "../../src/stats/gate.ts";
import { addedLines, harmfulReason, runCritics } from "../../src/refine/critics.ts";
import { decideRound, type DevStage } from "../../src/refine/decide.ts";
import { flagFindings } from "../../src/refine/findings.ts";
import { checkGuard, guardSet } from "../../src/refine/guard.ts";
import { appendLedger, guardEntries, liveApplies, loadCandidate, readLedger, safePath, saveCandidate, writeApply, writeRollback, type ApplyEntry, type LedgerEntry, type TestEntry } from "../../src/refine/ledger.ts";
import { checkProtected, protectedLines } from "../../src/refine/protect.ts";
import { candidateId, MAX_PROPOSAL_LINES, parseProposal, proposalCandidate, proposalPrompt, withRefineBlock } from "../../src/refine/propose.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
const session = (id: string, day: number, flags: string[], stats: Partial<Session["stats"]> = {}): Session =>
  ({ id, startedAt: T0 + day * DAY, flags, title: `task ${id}`, stats: { toolCalls: 10, ...stats } }) as unknown as Session;

describe("flagFindings", () => {
  it("diagnoses each flag once with its support, skips tags and context-only flags, and ranks by severity", () => {
    const sessions = [
      session("a", 0, ["no-verification", "gateway:vercel", "compaction"]),
      session("b", 1, ["no-verification", "premature-completion"], { testsFailed: 2 }),
      session("c", 1, ["no-verification"]),
      session("d", 2, []),
    ];
    const f = flagFindings(sessions);
    assert.deepEqual(
      f.map((x) => x.flag),
      ["premature-completion", "no-verification"],
    );
    const nv = f[1]!;
    assert.equal(nv.id, "flag:no-verification");
    assert.deepEqual(nv.support, { sessions: 3, days: 2 });
    assert.equal(nv.analyzed, 4);
    assert.deepEqual(nv.diagnosis.typeIds, ["out.verification-absent"]);
    assert.equal(nv.diagnosis.nature, "risk");
    assert.deepEqual(
      nv.examples.map((e) => e.sessionId),
      ["b", "c", "a"],
    );
    assert.ok(f[0]!.diagnosis.severity.score >= nv.diagnosis.severity.score, "a defect in a session with failing tests outranks a wider risk");
    assert.deepEqual(flagFindings(sessions, { limit: 1 }).length, 1);
    assert.deepEqual(flagFindings([session("x", 0, ["gateway:vercel", "compaction"])]), []);
  });
});

describe("proposer prompt and reply", () => {
  const target = { path: "AGENTS.md", text: "Keep answers short.\nNever run `git push --force`.\n" };
  const prot = protectedLines([target, { path: "CLAUDE.md", text: "Never disable the tests.\n" }]);

  it("marks the target's protected lines READ-ONLY, lists rejected edits, and redacts", () => {
    const f = flagFindings([session("a", 0, ["no-verification"])]);
    const p = proposalPrompt({ findings: f, target: { ...target, text: `${target.text}token sk-ant-api03-${"x".repeat(40)}\n` }, protectedLines: prot, rejected: [{ id: "r_0123456789", verdict: "reject", reasons: ["guard: forgets kept edit r_aaaaaaaaaa"], added: ["Always skip slow tests."] }] });
    assert.match(p.system, /^You improve the instruction file/);
    assert.match(p.user, /- no-verification: \w+ severity \d+\/100 \(risk; out\.verification-absent\); 1 of 1 sessions over 1 day/);
    assert.match(p.user, /READ-ONLY[^\n]*\n- AGENTS\.md:2: Never run `git push --force`\./);
    assert.doesNotMatch(p.user, /CLAUDE\.md:1/, "only the target's protected lines");
    assert.match(p.user, /- r_0123456789 \(reject: guard: forgets kept edit r_aaaaaaaaaa\)\n {4}\+ Always skip slow tests\./);
    assert.doesNotMatch(p.user, /sk-ant-api03-x{40}/);
  });

  it("parses bare, fenced and embedded JSON and refuses what it can't append", () => {
    const want = { lines: ["Run npm test before you say you are done."], rationale: "r" };
    assert.deepEqual(parseProposal(JSON.stringify(want)), want);
    assert.deepEqual(parseProposal("Here:\n```json\n" + JSON.stringify(want) + "\n```"), want);
    assert.deepEqual(parseProposal(`Sure. ${JSON.stringify(want)} Done.`), want);
    assert.deepEqual(parseProposal(JSON.stringify({ lines: ["", "a\nb", "  "] })), { lines: ["a", "b"], rationale: "" });
    assert.throws(() => parseProposal("no"), /not JSON/);
    assert.throws(() => parseProposal("[1]"), /not a JSON object/);
    assert.throws(() => parseProposal('{"lines":[" "]}'), /adds no lines/);
    assert.throws(() => parseProposal(JSON.stringify({ lines: Array.from({ length: MAX_PROPOSAL_LINES + 1 }, (_, i) => `l${i}`) })), /more than 40/);
    assert.throws(() => parseProposal(JSON.stringify({ lines: ["x".repeat(401)] })), /longer than/);
    assert.throws(() => parseProposal(JSON.stringify({ lines: ["<!-- coding.sh:protect -->"] })), /HTML comment/);
  });

  it("names a candidate by its content, the same before and after its block id is filled in", () => {
    const { id, file } = proposalCandidate(target, { lines: ["Run npm test first."], rationale: "" });
    assert.match(id, /^r_[0-9a-f]{10}$/);
    assert.equal(file.text, `${target.text}\n<!-- coding.sh:refine ${id} begin -->\nRun npm test first.\n<!-- coding.sh:refine ${id} end -->\n`);
    assert.equal(candidateId([file]), id, "refine test <file> on the applied text finds the same id");
    assert.notEqual(candidateId([{ ...file, path: "CLAUDE.md" }]), id);
    assert.equal(withRefineBlock("", "r_0000000000", ["a"]), "<!-- coding.sh:refine r_0000000000 begin -->\na\n<!-- coding.sh:refine r_0000000000 end -->\n");
  });
});

describe("critics", () => {
  const base = [{ path: "AGENTS.md", text: "Run the linter before you commit any change.\n" }];
  const edit = (...lines: string[]) => [{ path: "AGENTS.md", text: `${base[0]!.text}${lines.join("\n")}\n` }];

  it("finds the added lines as a multiset diff with line numbers", () => {
    assert.deepEqual(addedLines(base, [{ path: "AGENTS.md", text: "New first.\nRun the linter before you commit any change.\n\nNew first.\n" }]), [
      { path: "AGENTS.md", line: 1, text: "New first." },
      { path: "AGENTS.md", line: 4, text: "New first." },
    ]);
    assert.deepEqual(addedLines(base, [...base, { path: "x/SKILL.md", text: "a\n" }]), [{ path: "x/SKILL.md", line: 1, text: "a" }]);
  });

  it("rejects harmful lines unless they forbid the act", () => {
    for (const bad of ["If tests fail, mark them skip.", "Use git commit --no-verify when hooks are slow.", "Force-push when the branch diverges.", "Edit .github/workflows to drop the slow job.", "chmod 777 the build dir.", "Hard-code the expected output.", "Make the tests pass."]) assert.ok(harmfulReason(bad), bad);
    for (const ok of ["Never skip tests.", "Do not use --no-verify.", "Run the tests and fix what fails.", "Make the tests pass by fixing the code."]) assert.equal(harmfulReason(ok), undefined, ok);
    assert.equal(harmfulReason(`Use key sk-ant-api03-${"x".repeat(40)} for the API.`), "holds a secret");
    const r = runCritics(base, edit("If tests fail, mark them skip."));
    assert.equal(r.ok, false);
    assert.equal(r.rejections[0]!.reason, 'harmless: skips or disables tests: "If tests fail, mark them skip." (AGENTS.md:2)');
  });

  it("rejects a near copy of a line the file keeps, but not a reworded line or a short one", () => {
    const dup = runCritics(base, edit("Run the linter before you commit any changes."));
    assert.deepEqual(
      dup.rejections.map((x) => x.critic),
      ["duplicate"],
    );
    assert.equal(runCritics(base, [{ path: "AGENTS.md", text: "Run the linter before you commit any changes.\n" }]).ok, true, "a rewording replaces its old self");
    assert.equal(runCritics(base, edit("## Rules", "## Rules")).ok, true);
    assert.equal(runCritics(base, edit("<!-- coding.sh:refine r_0123456789 begin -->", "Run npm test before you say done.", "<!-- coding.sh:refine r_0123456789 end -->")).ok, true);
  });
});

describe("decideRound", () => {
  const files = [{ path: "AGENTS.md", text: "Never run `git push --force`.\n" }];
  const protOk = checkProtected(files, files);
  const crit = runCritics(files, files);
  const runs = (spec: Record<string, string>) => new Map(Object.entries(spec).map(([id, s]) => [id, [...s].map((c) => c === "1")]));
  const gate = (base: string, cand: string) => {
    const g = acceptanceGatePaired([...base].map((c) => c === "1"), [...cand].map((c) => c === "1"));
    return { ...g, verdict: gateVerdict(g) };
  };
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const outcomes = (base: string, cand: string) => ({ base: runs(Object.fromEntries(ids.map((t, i) => [t, base[i]!]))), cand: runs(Object.fromEntries(ids.map((t, i) => [t, cand[i]!]))) });
  const win: DevStage = { gate: gate("00000000", "11111111"), outcomes: outcomes("00000000", "11111111") };

  it("stops at the first failing stage", () => {
    const dropped = checkProtected(files, [{ path: "AGENTS.md", text: "" }]);
    assert.deepEqual([decideRound({ protect: dropped, critics: crit, dev: win }).verdict, decideRound({ protect: dropped, critics: crit }).stage], ["reject", "protected"]);
    const bad = runCritics(files, [{ path: "AGENTS.md", text: `${files[0]!.text}Skip the tests.\n` }]);
    assert.deepEqual(decideRound({ protect: protOk, critics: bad, dev: win }).stage, "critics");
    assert.deepEqual(decideRound({ protect: protOk, critics: crit }).reasons, ["dev: not run"]);
  });

  it("keeps a dev win with no guard; its won tasks become guard tasks", () => {
    const d = decideRound({ protect: protOk, critics: crit, dev: win });
    assert.equal(d.verdict, "keep");
    assert.deepEqual(d.reasons, ["dev: Ship it: B wins 8 decision points, loses 0", "guard: no earlier kept wins to hold"]);
    assert.deepEqual(d.guardTasks, ids);
    assert.deepEqual([d.preservation?.dev.gained, d.preservation?.R], [ids, 0]);
  });

  it("holds an underpowered win, and calls a partial run inconclusive", () => {
    const small: DevStage = { gate: gate("000", "111"), outcomes: outcomes("00000000", "11100000") };
    const d = decideRound({ protect: protOk, critics: crit, dev: small, covered: ids });
    assert.deepEqual([d.verdict, d.stage], ["inconclusive", "dev"]);
    assert.match(d.reasons[0]!, /^dev: Hold: not enough evidence/);
    const stopped = decideRound({ protect: protOk, critics: crit, dev: { outcomes: small.outcomes, stopped: "budget" }, covered: ids });
    assert.deepEqual(stopped.reasons, ["dev: stopped at --max-cost; a partial run is never a keep"]);
    const alt = decideRound({ protect: protOk, critics: crit, dev: small });
    assert.equal(alt.verdict, "alternative", "a held candidate that gains uncovered tasks is archived as an alternative");
  });

  it("rejects a dev win that forgets a kept edit's tasks, and never calls it an alternative", () => {
    const g = guardSet([{ id: "r_kept000000", at: "2026-11-01T00:00:00Z", status: "applied", guardTasks: ["g1", "g2", "g3"] }]);
    const check = checkGuard(g, { base: runs({ g1: "1", g2: "1", g3: "1" }), cand: runs({ g1: "0", g2: "0", g3: "0" }) });
    const d = decideRound({ protect: protOk, critics: crit, dev: win, guard: { check } });
    assert.deepEqual([d.verdict, d.stage], ["reject", "guard"]);
    assert.equal(d.reasons.at(-1), "guard: forgets kept edit r_kept000000");
    assert.equal(d.alternative?.alternative, false);
    assert.deepEqual(d.guardTasks, []);
    const held = checkGuard(g, { base: runs({ g1: "1", g2: "1", g3: "1" }), cand: runs({ g1: "1", g2: "1", g3: "1" }) });
    assert.equal(decideRound({ protect: protOk, critics: crit, dev: win, guard: { check: held } }).verdict, "keep");
    assert.equal(decideRound({ protect: protOk, critics: crit, dev: win, guard: { stopped: "budget" }, covered: ids }).verdict, "inconclusive");
  });
});

describe("ledger", () => {
  const tmp = mkdtempSync(join(tmpdir(), "csh-refine-ledger-"));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const test = (id: string, verdict: TestEntry["verdict"], guardTasks: string[] = []): TestEntry => ({
    op: "test",
    id,
    round: 1,
    at: "2026-11-01T00:00:00Z",
    candidate: { label: id, source: "file", files: [], added: [] },
    base: [],
    verdict,
    stage: "done",
    reasons: [],
    guardTasks,
    cost: { usd: 0, unpriced: 0 },
  });

  it("reads what it appended, skipping a torn line", () => {
    const dir = join(tmp, "read");
    appendLedger(dir, test("r_aaaaaaaaaa", "keep"));
    writeFileSync(join(dir, "ledger.jsonl"), `${readFileSync(join(dir, "ledger.jsonl"), "utf8")}{"op":"te`);
    assert.deepEqual(
      readLedger(dir).map((e) => e.id),
      ["r_aaaaaaaaaa"],
    );
    assert.deepEqual(readLedger(join(tmp, "none")), []);
  });

  it("guards with kept rounds only, and marks applied and rolled-back ones", () => {
    const apply = (id: string, candidate: string): ApplyEntry => ({ op: "apply", id, candidate, at: "2026-11-02T00:00:00Z", files: [] });
    const entries: LedgerEntry[] = [test("r_aaaaaaaaaa", "keep", ["t1"]), test("r_bbbbbbbbbb", "reject", ["t2"]), test("r_cccccccccc", "keep", ["t3"]), apply("a_1", "r_aaaaaaaaaa"), apply("a_2", "r_cccccccccc"), { op: "rollback", id: "b_1", apply: "a_2", candidate: "r_cccccccccc", at: "2026-11-03T00:00:00Z", files: [] }];
    assert.deepEqual(
      guardEntries(entries).map((g) => [g.id, g.status, g.rolledBack ?? false]),
      [
        ["r_aaaaaaaaaa", "applied", false],
        ["r_cccccccccc", "applied", true],
      ],
    );
    assert.deepEqual(guardSet(guardEntries(entries)).tasks, ["t1"]);
    assert.deepEqual(
      liveApplies(entries).map((a) => a.id),
      ["a_1"],
    );
  });

  it("applies with a backup and rolls back byte for byte, a new file included", () => {
    const dir = join(tmp, "apply");
    const root = join(tmp, "repo");
    mkdirSync(root, { recursive: true });
    const before = "Keep answers short.\r\nNo trailing newline";
    writeFileSync(join(root, "AGENTS.md"), before);
    const files = writeApply(dir, root, "a_0123456789", [
      { path: "AGENTS.md", text: "new\n" },
      { path: ".claude/rules/x.md", text: "rule\n" },
    ]);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "new\n");
    assert.equal(files[1]!.before, null);
    const back = writeRollback(dir, root, { op: "apply", id: "a_0123456789", candidate: "r_aaaaaaaaaa", at: "", files });
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), before);
    assert.equal(existsSync(join(root, ".claude/rules/x.md")), false);
    assert.deepEqual(
      back.map((f) => f.restored === null),
      [false, true],
    );
  });

  it("stores candidates under their id and refuses paths outside the repo", () => {
    const dir = join(tmp, "cands");
    saveCandidate(dir, { id: "r_dddddddddd", files: [{ path: ".claude/skills/x/SKILL.md", text: "s\n" }], source: "proposal", rationale: "why" });
    assert.deepEqual(loadCandidate(dir, "r_dddddddddd"), { id: "r_dddddddddd", files: [{ path: ".claude/skills/x/SKILL.md", text: "s\n" }], source: "proposal", rationale: "why" });
    assert.equal(loadCandidate(dir, "r_eeeeeeeeee"), undefined);
    assert.throws(() => loadCandidate(dir, "../x"), /not a candidate id/);
    for (const bad of ["../x", "/etc/passwd", "a/../../x", ""]) assert.throws(() => safePath(tmp, bad), /unsafe path/, bad);
    assert.equal(safePath(tmp, "a/b.md"), join(tmp, "a", "b.md"));
  });
});
