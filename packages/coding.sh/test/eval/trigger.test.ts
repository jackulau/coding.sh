import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, HarnessBundle } from "../../src/core/types.ts";
import {
  formatTrigger,
  parseTriggerSpec,
  probeBundle,
  probeOutcome,
  readSkill,
  runTriggerEval,
  scoreTrigger,
  siblingSkills,
  skillFrontmatter,
  triggerJobs,
  TriggerSpecError,
  withDescription,
  type ProbeOutcome,
  type TriggerArm,
  type TriggerSpec,
} from "../../src/eval/trigger.ts";
import { MemoryBlobStore } from "../../src/store/memory.ts";

const SPEC = `skill = "pdf"
k = 1

[[should]]
prompt = "Fill the pdf form"

[[should]]
prompt = "Merge two pdf files"

[[should]]
prompt = "Extract tables from report.pdf"
weight = 0.5

[[should]]
prompt = "Make this document searchable"

[[should_not]]
prompt = "Rename txt files"

[[should_not]]
prompt = "Write a docx memo"
expect_skill = "docx"

[[should_not]]
prompt = "Explain what a pdf is in one line"

[[should_not]]
prompt = "Sort this list"
`;

const ok = (skills: string[]): ProbeOutcome => ({ status: "ok", skills });
const arm = (label: string, id = label): TriggerArm => ({ label, bundle: { id, name: label, agent: "claude-code", flags: [], env: {}, files: {}, remove: [], createdAt: 0 } });

/** A fake agent: loads pdf when the prompt says pdf, docx when it says docx. */
const keywordProbe = (keyword = "pdf") => async (_job: unknown, _arm: TriggerArm, p: { prompt: string }) => {
  const used: string[] = [];
  if (p.prompt.toLowerCase().includes(keyword)) used.push("pdf");
  if (p.prompt.toLowerCase().includes("docx")) used.push("docx");
  return ok(used);
};

const tmp = mkdtempSync(join(tmpdir(), "csh-trigger-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("parseTriggerSpec", () => {
  it("reads prompts, weights, notes and expect_skill, with defaults k=3 and timeout_s=120", () => {
    const s = parseTriggerSpec(SPEC.replace("k = 1\n", ""), "t.toml");
    assert.equal(s.skill, "pdf");
    assert.equal(s.k, 3);
    assert.equal(s.timeoutS, 120);
    assert.equal(s.should.length, 4);
    assert.equal(s.should[2]!.weight, 0.5);
    assert.equal(s.shouldNot[1]!.expectSkill, "docx");
  });

  const bad: [string, string, RegExp][] = [
    ["unknown top key", `model = "x"\n${SPEC}`, /t\.toml: model: unknown key/],
    ["unknown item key", SPEC.replace('weight = 0.5', 'confidence = "high"'), /t\.toml: should\[2\]\.confidence: unknown key/],
    ["expect_skill on should", SPEC.replace('weight = 0.5', 'expect_skill = "x"'), /should\[2\]\.expect_skill: unknown key/],
    ["other weight", SPEC.replace("weight = 0.5", "weight = 0.7"), /should\[2\]\.weight: must be 1 .* or 0\.5/],
    ["duplicate (case, spaces)", SPEC.replace('"Sort this list"', '"  fill THE   pdf form "'), /should_not\[3\]\.prompt: duplicates should\[0\]/],
    ["empty side", 'skill = "pdf"\n[[should]]\nprompt = "a"\n', /should_not: missing/],
    ["k out of range", SPEC.replace("k = 1", "k = 0"), /t\.toml: k: must be an integer/],
    ["toml syntax", "[[should]\n", /t\.toml:1:/],
    ["expect_skill is the skill", SPEC.replace('expect_skill = "docx"', 'expect_skill = "pdf"'), /expect_skill names the skill under test/],
  ];
  for (const [what, text, re] of bad) {
    it(`rejects ${what}, naming the file and key`, () => {
      assert.throws(() => parseTriggerSpec(text, "t.toml"), (e: unknown) => e instanceof TriggerSpecError && re.test(e.message));
    });
  }
});

describe("SKILL.md frontmatter", () => {
  it("reads plain, quoted and folded descriptions", () => {
    assert.deepEqual(skillFrontmatter("---\nname: pdf\ndescription: Use for PDFs.\n---\nbody"), { name: "pdf", description: "Use for PDFs." });
    assert.equal(skillFrontmatter('---\nname: a\ndescription: "Quoted: yes"\n---\n')!.description, "Quoted: yes");
    assert.equal(skillFrontmatter("---\nname: a\ndescription: >\n  Use when\n  the user asks.\nlicense: MIT\n---\n")!.description, "Use when the user asks.");
    assert.equal(skillFrontmatter("---\nname: a\ndescription: Use when\n  continued here\n---\n")!.description, "Use when continued here");
    assert.equal(skillFrontmatter("no frontmatter"), undefined);
  });

  it("replaces only the description and keeps the rest byte for byte", () => {
    const md = "---\nname: pdf\ndescription: >\n  Old text\n  over lines.\nlicense: MIT\n---\n# Body\nkeep: me\n";
    const out = withDescription(md, "New: text");
    assert.equal(out, '---\nname: pdf\ndescription: "New: text"\nlicense: MIT\n---\n# Body\nkeep: me\n');
    assert.equal(skillFrontmatter(out)!.description, "New: text");
    assert.match(withDescription("---\nname: x\n---\nb", "d"), /^---\nname: x\ndescription: "d"\n---\nb$/);
    assert.throws(() => withDescription("# no frontmatter", "d"), /no frontmatter/);
  });
});

describe("triggerJobs", () => {
  const spec = parseTriggerSpec(SPEC);
  it("is the same order for a seed, a different one for another, and runs arms back to back", () => {
    const a = triggerJobs(spec, 2, 3, 7);
    assert.deepEqual(triggerJobs(spec, 2, 3, 7), a);
    assert.notDeepEqual(triggerJobs(spec, 2, 3, 8), a);
    assert.equal(a.length, 2 * 8 * 3);
    for (let i = 0; i < a.length; i += 2) {
      const [x, y] = [a[i]!, a[i + 1]!];
      assert.deepEqual([x.side, x.index, x.attempt], [y.side, y.index, y.attempt]);
      assert.deepEqual([x.arm, y.arm].sort(), [0, 1]);
    }
    assert.ok(a.some((j, i) => i % 2 === 0 && j.arm === 1), "the arm that goes first varies");
  });
});

describe("scoring", () => {
  const spec = parseTriggerSpec(SPEC);

  it("counts TP/FP/TN/FN, P/R/F1 and weights exactly for a keyword agent", async () => {
    const r = await runTriggerEval({ spec, skill: "pdf", arms: [arm("current")], k: 1, runProbe: keywordProbe() });
    assert.equal(r.cancelled, false);
    const rep = scoreTrigger({ spec, skill: "pdf", agent: "claude-code", arms: [arm("current")], observations: r.observations, k: 1 });
    const a = rep.arms[0]!;
    assert.deepEqual(a.raw, { tp: 3, fp: 1, tn: 3, fn: 1 });
    assert.deepEqual(a.weighted, { tp: 2.5, fp: 1, tn: 3, fn: 1 }, "the medium prompt counts 0.5 weighted, 1 raw");
    assert.equal(a.rawMetrics.precision, 0.75);
    assert.equal(a.rawMetrics.recall, 0.75);
    assert.equal(a.rawMetrics.f1, 0.75);
    assert.equal(a.rawMetrics.accuracy, 0.75);
    assert.ok(Math.abs(a.metrics.recall - 2.5 / 3.5) < 1e-12);
    assert.equal(a.recallCI.p, 0.75);
    assert.equal(a.falseTriggerCI.p, 0.25);
    // The sibling docx answered its own prompt: the expected route, not a false trigger.
    const docx = a.prompts.find((p) => p.expectSkill === "docx")!;
    assert.deepEqual([docx.triggered, docx.expectHits, docx.correct, docx.others], [0, 1, 1, { docx: 1 }]);
    const text = formatTrigger(rep);
    assert.match(text, /precision 71% {2}recall 71% {2}F1 0\.71 {2}accuracy 73%/);
    assert.match(text, /expected routes: docx 1\/1/);
    assert.match(text, /should_not false trigger 1\/1 {2}"Explain what a pdf is in one line"/);
  });

  it("leaves errored runs out of every metric and counts them", async () => {
    const probe = async (j: unknown, a: TriggerArm, p: { prompt: string }) => (p.prompt.startsWith("Merge") ? { status: "error" as const, error: "timed out before loading the skill", skills: [] } : keywordProbe()(j, a, p));
    const r = await runTriggerEval({ spec, skill: "pdf", arms: [arm("current")], k: 2, runProbe: probe });
    const a = scoreTrigger({ spec, skill: "pdf", agent: "claude-code", arms: [arm("current")], observations: r.observations, k: 2 }).arms[0]!;
    assert.deepEqual(a.raw, { tp: 4, fp: 2, tn: 6, fn: 2 });
    assert.equal(a.errors, 2);
    assert.deepEqual(a.errorReasons, { "timed out before loading the skill": 2 });
    assert.equal(a.prompts.find((p) => p.prompt.startsWith("Merge"))!.n, 0);
  });

  // A current description and a broader candidate; the fake agent loads pdf when the
  // prompt names a word from the installed description. Returns B vs A and A vs B.
  const describedPair = async (should: string[]) => {
    const blobs = new MemoryBlobStore();
    const dir = join(tmp, "skills", "pdf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: Use for pdf files.\n---\nBody\n");
    const current = await readSkill(dir);
    const md = withDescription("---\nname: pdf\ndescription: Use for pdf files.\n---\nBody\n", "Use for pdf files, documents, reports and forms.");
    const arms: TriggerArm[] = [
      { label: "current", bundle: await probeBundle({ name: "a", agent: "claude-code", skills: [current], blobs }) },
      { label: "--description", bundle: await probeBundle({ name: "b", agent: "claude-code", skills: [{ ...current, override: { "SKILL.md": md } }], blobs }) },
    ];
    const readsDescription = async (_j: unknown, a: TriggerArm, p: { prompt: string }) => {
      const text = (await blobs.getText(a.bundle.files[".claude/skills/pdf/SKILL.md"]!))!;
      const words = skillFrontmatter(text)!.description!.toLowerCase().match(/[a-z]{3,}/g)!.filter((w) => !["use", "for", "and"].includes(w));
      return ok(words.some((w) => p.prompt.toLowerCase().includes(w.replace(/s$/, ""))) ? ["pdf"] : []);
    };
    const s = parseTriggerSpec(
      `skill = "pdf"\nk = 2\n${should.map((p) => `[[should]]\nprompt = "${p}"\n`).join("")}${["Rename every txt name", "Sort this list", "Write a haiku"].map((p) => `[[should_not]]\nprompt = "${p}"\n`).join("")}`,
    );
    const r = await runTriggerEval({ spec: s, skill: "pdf", arms, k: 2, seed: 3, runProbe: readsDescription });
    const rep = scoreTrigger({ spec: s, skill: "pdf", agent: "claude-code", arms, observations: r.observations, k: 2, seed: 3 });
    const rev = scoreTrigger({ spec: s, skill: "pdf", agent: "claude-code", arms: [arms[1]!, arms[0]!], observations: r.observations.map((o) => ({ ...o, arm: 1 - o.arm })), k: 2, seed: 3 });
    return { rep, rev };
  };

  it("6 prompts that all flip to right are Better, and the same runs reversed are a regression", async () => {
    const { rep, rev } = await describedPair(["Fill the pdf form", "Summarize this report", "Make this document searchable", "Sign the form", "Read the report aloud", "Print the form", "Archive the document", "Split pdf pages"]);
    const d = rep.delta!;
    assert.equal(d.flips.length, 6);
    assert.deepEqual(d.signFlip, { p: 2 / 64, units: 11, method: "exact" });
    assert.equal(d.improvement, true);
    assert.match(formatTrigger(rep), /^Better: B answers more prompts right \(the CI is above 0 and the sign-flip p is below 0\.05\)$/m);
    assert.equal(rev.delta!.regression, true);
    assert.match(formatTrigger(rev), /^Worse: B answers fewer prompts right/m);
  });

  it("a candidate description the agent reads raises recall, lists flips and has a CI above 0", async () => {
    const blobs = new MemoryBlobStore();
    const dir = join(tmp, "skills", "pdf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: Use for pdf files.\n---\nBody\n");
    const current = await readSkill(dir);
    const md = withDescription("---\nname: pdf\ndescription: Use for pdf files.\n---\nBody\n", "Use for pdf files, documents, reports and forms.");
    const arms: TriggerArm[] = [
      { label: "current", bundle: await probeBundle({ name: "a", agent: "claude-code", skills: [current], blobs }) },
      { label: "--description", bundle: await probeBundle({ name: "b", agent: "claude-code", skills: [{ ...current, override: { "SKILL.md": md } }], blobs }) },
    ];
    assert.ok(arms[1]!.bundle.files[".claude/skills/pdf/SKILL.md"]);
    assert.deepEqual(arms[0]!.bundle.flags, ["--max-turns", "3"]);
    // The fake loads pdf when the prompt names a word from the installed description.
    const readsDescription = async (_j: unknown, a: TriggerArm, p: { prompt: string }) => {
      const text = (await blobs.getText(a.bundle.files[".claude/skills/pdf/SKILL.md"]!))!;
      const words = skillFrontmatter(text)!.description!.toLowerCase().match(/[a-z]{3,}/g)!.filter((w) => !["use", "for", "and"].includes(w));
      const hit = words.some((w) => p.prompt.toLowerCase().includes(w.replace(/s$/, "")));
      return ok(hit ? ["pdf"] : []);
    };
    const s: TriggerSpec = parseTriggerSpec(
      `skill = "pdf"\nk = 2\n${["Fill the pdf form", "Summarize this report", "Make this document searchable", "Sign the form", "Split pdf pages", "Read the report aloud"].map((p) => `[[should]]\nprompt = "${p}"\n`).join("")}${["Rename every txt name", "Sort this list", "Write a haiku"].map((p) => `[[should_not]]\nprompt = "${p}"\n`).join("")}`,
    );
    const r = await runTriggerEval({ spec: s, skill: "pdf", arms, k: 2, seed: 3, runProbe: readsDescription });
    const rep = scoreTrigger({ spec: s, skill: "pdf", agent: "claude-code", arms, observations: r.observations, k: 2, seed: 3 });
    const [a, b] = rep.arms;
    assert.equal(a!.raw.tp, 4);
    assert.equal(b!.raw.tp, 12);
    assert.equal(b!.raw.fp, 0);
    const d = rep.delta!;
    assert.equal(d.flips.length, 4);
    assert.ok(d.flips.every((f) => f.better && !f.from && f.to));
    assert.ok(d.ci.lo > 0, `CI ${d.ci.lo}..${d.ci.hi}`);
    assert.equal(d.regression, false);
    assert.match(d.verdict, /^recall 4\/12→12\/12 · false triggers 0\/6→0\/6 · Δacc \+44 pp \(95% CI \+\d+ to \+\d+\)$/);
    assert.match(d.smallNote!, /6 should and 3 should_not prompts/);
    // 4 prompts that all improve: the bootstrap CI is above 0, but the exact two-sided p is 2/2⁴.
    assert.deepEqual(d.signFlip, { p: 0.125, units: 9, method: "exact" });
    assert.equal(d.improvement, false);
    assert.match(formatTrigger(rep), /^ {2}sign-flip test \(exact up to 20 changed prompts\): p = 0\.125 over 9 prompts$/m);
    assert.match(formatTrigger(rep), /^No clear difference: the CI is above 0, but the exact sign-flip test over 9 prompts gives p 0\.125$/m);
    // Reversed, the CI is below 0, and the same exact test keeps it from reading as a regression.
    const rev = scoreTrigger({ spec: s, skill: "pdf", agent: "claude-code", arms: [arms[1]!, arms[0]!], observations: r.observations.map((o) => ({ ...o, arm: 1 - o.arm })), k: 2, seed: 3 });
    assert.ok(rev.delta!.ci.hi < 0);
    assert.equal(rev.delta!.regression, false);
  });

  it("McNemar at k=1", async () => {
    const r = await runTriggerEval({ spec, skill: "pdf", arms: [arm("a"), arm("b")], k: 1, runProbe: async (j, a, p) => (a.label === "b" ? ok(p.prompt.includes("document") || p.prompt.includes("pdf") ? ["pdf"] : []) : keywordProbe()(j, a, p)) });
    const d = scoreTrigger({ spec, skill: "pdf", agent: "claude-code", arms: [arm("a"), arm("b")], observations: r.observations, k: 1 }).delta!;
    assert.deepEqual([d.mcnemar!.b, d.mcnemar!.c], [0, 1]);
  });

  it("stops starting probes once aborted, and says cancelled", async () => {
    const ac = new AbortController();
    let n = 0;
    const r = await runTriggerEval({ spec, skill: "pdf", arms: [arm("a")], k: 1, concurrency: 1, signal: ac.signal, runProbe: async () => (++n === 2 && ac.abort(), ok([])) });
    assert.equal(r.cancelled, true);
    assert.equal(r.observations.length, 2);
  });
});

describe("probeOutcome", () => {
  const run = (agent: Partial<{ exitCode: number | null; timedOut: boolean }>) => ({ id: "run_1", agent: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "", ...agent } });
  const ev = (tool: string, input: Record<string, unknown>): AgentEvent => ({ id: "e1", v: 0, sessionId: "s", ts: 1, agent: "claude-code", kind: "tool.start", payload: { tool, input } });
  it("no trace is an error that says why", () => {
    assert.deepEqual(probeOutcome(run({ timedOut: true }), [], "pdf", "none"), { runId: "run_1", status: "error", error: "no trace (timed out)", skills: [] });
    assert.equal(probeOutcome(run({ exitCode: 1 }), [], "pdf", "none").error, "no trace (exited 1)");
  });
  it("a run that loaded the skill answered, even if it then timed out", () => {
    const o = probeOutcome(run({ timedOut: true }), [ev("Skill", { skill: "pdf" })], "pdf", "session");
    assert.deepEqual([o.status, o.skills], ["ok", ["pdf"]]);
    assert.deepEqual(probeOutcome(run({}), [ev("Read", { file_path: "/w/.claude/skills/pdf/SKILL.md" })], "pdf", "stdout").skills, ["pdf"]);
  });
  it("a run that didn't load it answered only if it finished or left a session", () => {
    const other = [ev("Bash", { command: "ls" })];
    assert.equal(probeOutcome(run({ timedOut: true }), other, "pdf", "session").status, "error");
    assert.equal(probeOutcome(run({ exitCode: 1 }), other, "pdf", "stdout").status, "error");
    assert.equal(probeOutcome(run({ exitCode: 1 }), other, "pdf", "session").status, "ok", "a captured session that hit --max-turns still answered");
    assert.equal(probeOutcome(run({}), [], "pdf", "stdout").status, "ok", "an answer with no tool calls is an answer");
  });
});

describe("probe bundles and siblings", () => {
  it("installs whole skill dirs under the agent's skills dir, drops the base's copy, keeps its other files", async () => {
    const blobs = new MemoryBlobStore();
    const root = join(tmp, "sib");
    for (const n of ["pdf", "docx", "notes"]) {
      mkdirSync(join(root, n, "scripts"), { recursive: true });
      writeFileSync(join(root, n, "SKILL.md"), `---\nname: ${n}\ndescription: Use for ${n}.\n---\n`);
      writeFileSync(join(root, n, "scripts", "run.py"), "print(1)\n");
    }
    mkdirSync(join(root, "not-a-skill"));
    const sibs = await siblingSkills(root, [join(root, "pdf")]);
    assert.deepEqual(sibs.map((s) => s.name), ["docx", "notes"]);
    const base: HarnessBundle = { id: "x", name: "base", agent: "codex", flags: ["-c", "x=1"], env: { A: "1" }, files: { "AGENTS.md": await blobs.put("hi"), ".agents/skills/pdf/OLD.md": await blobs.put("old") }, remove: [], createdAt: 0 };
    const b = await probeBundle({ name: "p", agent: "codex", base, skills: [await readSkill(join(root, "pdf")), ...sibs], blobs });
    assert.deepEqual(Object.keys(b.files), ["AGENTS.md", ".agents/skills/docx/SKILL.md", ".agents/skills/docx/scripts/run.py", ".agents/skills/notes/SKILL.md", ".agents/skills/notes/scripts/run.py", ".agents/skills/pdf/SKILL.md", ".agents/skills/pdf/scripts/run.py"].sort());
    assert.deepEqual(b.flags, ["-c", "x=1"]);
    assert.deepEqual(b.env, { A: "1" });
  });
});
