// AD-3: refine distill with a fake Adapter.run that writes out/SKILL.md.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentRunOutput, RunSpec } from "../../src/core/types.ts";
import type { CorpusResult } from "../../src/refine/corpus.ts";
import { checkSkill, DISTILL_BRIEF, distill, ledgerDraws, MAX_SKILL_LINES, parseSkill, preflight } from "../../src/refine/distill.ts";
import { loadCandidate, readLedger } from "../../src/refine/ledger.ts";

const root = mkdtempSync(join(tmpdir(), "csh-distill-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `d${n++}`);

function corpus(): string {
  const d = fresh();
  mkdirSync(join(d, "episodes", "ep0001"), { recursive: true });
  writeFileSync(join(d, "episodes.jsonl"), `${JSON.stringify({ episode: "ep0001", pass: false })}\n`);
  writeFileSync(join(d, "tool_calls.jsonl"), "");
  writeFileSync(join(d, "SCHEMA.md"), "# Corpus schema\n");
  writeFileSync(join(d, "episodes", "ep0001", "transcript.md"), "# t\n");
  return d;
}

const SKILL = `---
name: verify-before-done
description: Use before saying a task is finished.
---
# Verify before done

- Run the test command before you say you are done: 12 of 30 failing episodes ended without it.
- Re-read a file before editing it again: 9 of 12 failed edits retried a stale old_string.
`;

/** A fake agent: writes `text` (per draw) to out/SKILL.md and records what it saw. */
function fakeAdapter(text: (draw: number) => string | undefined) {
  const seen: { cwd: string; instruction: string; corpus: boolean; model?: string }[] = [];
  return {
    seen,
    adapter: {
      id: "claude-code",
      async run(spec: RunSpec): Promise<AgentRunOutput> {
        seen.push({ cwd: spec.cwd, instruction: spec.instruction, corpus: existsSync(join(spec.cwd, "corpus", "episodes.jsonl")), ...(spec.model ? { model: spec.model } : {}) });
        const t = text(seen.length);
        if (t !== undefined) writeFileSync(join(spec.cwd, "out", "SKILL.md"), t);
        return { exitCode: 0, timedOut: false, durationMs: 1200, stdoutTail: "", stderrTail: "", usage: { costUsd: 0.4 } };
      },
    },
  };
}

const C: CorpusResult = { dir: "", episodes: 30, failures: 12, passRate: 0.6, leftOut: { tasks: ["task-tdev"], runs: 4 }, skipped: { cancelled: 0, superseded: 0, infra: 0 }, truncated: 0 };
const base = [{ path: "CLAUDE.md", text: "# Project\nUse pnpm.\n" }];

describe("refine distill", () => {
  it("one draw: the brief, a candidate, one ledger entry with provenance, testable by id", async () => {
    const f = fakeAdapter(() => SKILL);
    const r = await distill({ corpusDir: corpus(), adapter: f.adapter, model: "opus", workRoot: fresh(), base, skillsDir: ".claude/skills" });
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0]!.instruction, DISTILL_BRIEF);
    assert.equal(f.seen[0]!.corpus, true, "the corpus is copied into the draw's cwd");
    assert.equal(f.seen[0]!.model, "opus");
    assert.equal(r.spentUsd, 0.4);
    const d = r.draws[0]!;
    assert.deepEqual(d.rejections, []);
    assert.equal(d.candidate!.file.path, ".claude/skills/verify-before-done/SKILL.md");
    assert.match(d.candidate!.id, /^r_[0-9a-f]{10}$/);

    const dir = fresh();
    const entries = ledgerDraws(dir, r.draws, { corpus: C, source: "exp_1", distiller: "claude-code", model: "opus", at: "2026-11-08T00:00:00.000Z" });
    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1);
    assert.deepEqual(ledger, entries);
    const e = entries[0]!;
    assert.equal(e.op, "propose");
    assert.equal(e.proposer, "distill");
    assert.equal(e.verdict, "proposed");
    assert.deepEqual(e.provenance, { corpusEpisodes: 30, failures: 12, passRate: 0.6, source: "exp_1", leftOut: ["task-tdev"], draw: 1, distiller: "claude-code", model: "opus", costUsd: 0.4, durationMs: 1200 });
    const stored = loadCandidate(dir, e.id)!;
    assert.deepEqual(stored.files, [{ path: ".claude/skills/verify-before-done/SKILL.md", text: SKILL }]);
    assert.equal(JSON.parse(readFileSync(join(dir, "candidates", e.id, "candidate.json"), "utf8")).proposer, "distill");
  });

  it("the harmless critic rejects 'if tests fail, mark them skip'", async () => {
    const bad = `${SKILL}- If tests fail, mark them skip and move on.\n`;
    const r = await distill({ corpusDir: corpus(), adapter: fakeAdapter(() => bad).adapter, workRoot: fresh(), base, skillsDir: ".claude/skills" });
    assert.equal(r.draws[0]!.rejections[0]!.critic, "harmless");
    const dir = fresh();
    const [e] = ledgerDraws(dir, r.draws, { corpus: C, source: "exp_1", distiller: "claude-code" });
    assert.equal(e!.verdict, "rejected");
    assert.match(e!.reasons[0]!, /^harmless: skips or disables tests/);
  });

  it("rejects a 200-line skill as over the cap", () => {
    const long = `---\nname: long\ndescription: Too long.\n---\n${Array.from({ length: 196 }, (_, i) => `- Rule ${i}: keep it.`).join("\n")}\n`;
    const r = checkSkill(base, { path: ".claude/skills/long/SKILL.md", text: long });
    assert.equal(r[0]!.critic, "cap");
    assert.match(r[0]!.reason, new RegExp(`200 lines .* the cap is ${MAX_SKILL_LINES} lines`));
  });

  it("a draw with no out/SKILL.md is a clear error and no ledger entry", async () => {
    const r = await distill({ corpusDir: corpus(), adapter: fakeAdapter(() => undefined).adapter, workRoot: fresh(), base, skillsDir: ".claude/skills" });
    assert.match(r.draws[0]!.error!, /the distiller wrote no out\/SKILL\.md/);
    const dir = fresh();
    assert.deepEqual(ledgerDraws(dir, r.draws, { corpus: C, source: "exp_1", distiller: "claude-code" }), []);
    assert.deepEqual(readLedger(dir), []);
    const noName = await distill({ corpusDir: corpus(), adapter: fakeAdapter(() => "# no frontmatter\n").adapter, workRoot: fresh(), base, skillsDir: ".claude/skills" });
    assert.match(noName.draws[0]!.error!, /no YAML frontmatter/);
  });

  it("--n 3 gives three candidates from separate directories; the cap stops new draws", async () => {
    const f = fakeAdapter((i) => SKILL.replace("verify-before-done", `verify-${i}`));
    const r = await distill({ corpusDir: corpus(), adapter: f.adapter, n: 3, workRoot: fresh(), base, skillsDir: ".agents/skills" });
    assert.equal(r.draws.length, 3);
    assert.equal(new Set(f.seen.map((s) => s.cwd)).size, 3);
    assert.equal(new Set(r.draws.map((d) => d.candidate!.id)).size, 3);
    assert.equal(r.draws[2]!.candidate!.file.path, ".agents/skills/verify-3/SKILL.md");
    const capped = await distill({ corpusDir: corpus(), adapter: fakeAdapter(() => SKILL).adapter, n: 3, maxCostUsd: 0.5, workRoot: fresh(), base, skillsDir: ".claude/skills" });
    assert.equal(capped.draws.length, 2);
    assert.equal(capped.stopped, "budget");
  });

  it("preflight refuses a small or failure-free corpus", () => {
    assert.match(preflight({ episodes: 12, failures: 6 })!, /12 episodes; distilling needs at least 20/);
    assert.match(preflight({ episodes: 30, failures: 2 })!, /2 failing or flagged episodes; distilling needs at least 5/);
    assert.equal(preflight({ episodes: 30, failures: 12 }), undefined);
    assert.equal(preflight({ episodes: 8, failures: 2 }, { episodes: 5, failures: 1 }), undefined);
  });

  it("parses the frontmatter", () => {
    assert.deepEqual(parseSkill(SKILL), { name: "verify-before-done", description: "Use before saying a task is finished.", text: SKILL });
    assert.match((parseSkill("---\nname: Bad Name\ndescription: x\n---\n") as { error: string }).error, /lowercase/);
  });
});
