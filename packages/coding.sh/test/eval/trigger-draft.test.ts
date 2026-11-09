import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { MemoryJudgeCache } from "../../src/judge/cache.ts";
import type { ChatProvider } from "../../src/judge/providers.ts";
import { DraftError } from "../../src/eval/draft.ts";
import { parseTriggerSpec, readSkill } from "../../src/eval/trigger.ts";
import { draftTriggerSpec, mineTriggerPrompts, namesSkill, renderTriggerToml, skillCard } from "../../src/eval/trigger-draft.ts";
import { MemIndex, tempDir } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 8);
const DAY = 86_400_000;
// Built at runtime so no vendor-shaped literal sits in the source.
const SECRET = ["sk-ant-api03-", "Q".repeat(40), "AA"].join("");

let n = 0;
function session(id: string, flags: string[], prompt: string | undefined, extra: Partial<Session> = {}): { s: Session; events: AgentEvent[] } {
  const startedAt = NOW - DAY - n++ * 1000;
  const s: Session = { id, agent: "claude-code", startedAt, stats: { events: 2, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 }, flags, ...extra };
  const ev = (i: number, kind: AgentEvent["kind"], payload: Record<string, unknown>): AgentEvent => ({ id: `${id}-${i}`, v: 0, sessionId: id, ts: startedAt + i, agent: "claude-code", kind, payload });
  const events = [
    ev(0, "user.message", { text: "<command-name>/clear</command-name>" }),
    ...(prompt ? [ev(1, "user.message", { text: prompt })] : []),
    ev(2, "tool.start", { tool: "Skill", toolUseId: "t", input: {} }),
  ];
  return { s, events };
}

async function fakeIndex(): Promise<MemIndex & { reads: number }> {
  const index = new MemIndex() as MemIndex & { reads: number };
  index.reads = 0;
  const rows = [
    session("p1", ["skill:pdf"], "Merge these three invoices into one file"),
    session("p2", ["skill:pdf", "no-verification"], `Pull the table out of report.pdf, my key is ${SECRET}`),
    session("p3", ["skill:anthropic-skills:pdf"], "Fill in the form fields of w9.pdf"),
    session("d1", ["skill:docx"], "Track changes in contract.docx and accept them all"),
    session("d2", ["skill:docx", "skill:xlsx"], "Turn the meeting notes into a Word document"),
    session("x1", [], "Fix the flaky test"),
    session("sub", ["skill:pdf"], "a subagent prompt", { parent: { sessionId: "p1" } }),
    session("run", ["skill:pdf"], "a run prompt", { runId: "r1" }),
    session("old", ["skill:pdf"], "an old prompt", { startedAt: NOW - 200 * DAY }),
    session("dup", ["skill:pdf"], "merge these three  invoices into one file"),
  ];
  for (const r of rows) {
    await index.upsertSession(r.s);
    await index.putEvents(r.events);
  }
  const listSessions = index.listSessions.bind(index);
  const listEvents = index.listEvents.bind(index);
  index.listSessions = async (f) => (index.reads++, listSessions(f));
  index.listEvents = async (id, o) => (index.reads++, listEvents(id, o));
  return index;
}

function mock(reply: string | string[]): ChatProvider & { calls: number; users: string[] } {
  const replies = Array.isArray(reply) ? reply : [reply];
  const p = {
    name: "mock",
    model: "m1",
    params: {},
    calls: 0,
    users: [] as string[],
    async complete(req: { user: string }) {
      p.users.push(req.user);
      return { text: replies[Math.min(p.calls++, replies.length - 1)]!, model: "m1" };
    },
  };
  return p as unknown as ChatProvider & { calls: number; users: string[] };
}

const REPLY = JSON.stringify({
  should: [
    { prompt: "Combine the scanned receipts into a single document", why: "merging pages" },
    { prompt: "Rotate page 3 of the attached scan", why: "page edit" },
    { prompt: "Extract the text from this brochure", why: "text extraction" },
    { prompt: "Add a watermark to every page of the handout", why: "page stamp" },
    { prompt: "Fill in the form fields of w9.pdf", why: "duplicate of a mined one" },
    { prompt: "Split the 40-page manual into chapters", why: "splitting" },
    { prompt: "Make the slides printable as one file", why: "export" },
  ],
  should_not: [
    { prompt: "Add a column to the budget spreadsheet", why: "sibling", expect_skill: "xlsx" },
    { prompt: "Convert README.md headings to title case", why: "near miss on documents" },
    { prompt: "Write release notes for v2", why: "unrelated", expect_skill: "nonexistent" },
    { prompt: "Lint the TypeScript sources", why: "unrelated" },
    { prompt: "Resize the hero image", why: "unrelated" },
    { prompt: "Rename the docs folder", why: "near miss" },
    { prompt: "Bump the version", why: "unrelated" },
  ],
});

async function skillTree() {
  const root = await tempDir("csh-trigger-draft-");
  dirs.push(root);
  const mk = async (name: string, description: string, body = "") => {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  };
  await mk("pdf", "Read, merge, split and fill PDF files.", "# PDF\n\nUse pypdf for merging.\n");
  await mk("docx", "Create and edit Word documents.");
  await mk("xlsx", "Edit spreadsheets.");
  return root;
}

describe("mineTriggerPrompts", () => {
  it("takes the first real prompt of root sessions: pdf ones are positives, docx/xlsx ones are negatives", async () => {
    const index = await fakeIndex();
    const m = await mineTriggerPrompts(index, { skill: "pdf", siblings: ["docx", "xlsx"], now: NOW });
    assert.deepEqual(m.should.map((p) => p.source), ["trace:p1", "trace:p2", "trace:p3"]);
    assert.deepEqual(m.shouldNot.map((p) => [p.source, p.expectSkill]), [["trace:d1", "docx"], ["trace:d2", "docx"]]);
    assert.ok(!JSON.stringify(m).includes(SECRET), "the key is redacted");
    assert.match(m.should[1]!.prompt, /\[redacted:[a-z-]+\]/);
    assert.ok(m.should.every((p) => !p.prompt.startsWith("<command")));
  });

  it("cuts long prompts to 500 characters", async () => {
    const index = new MemIndex();
    const r = session("long", ["skill:pdf"], "x".repeat(2000));
    await index.upsertSession(r.s);
    await index.putEvents(r.events);
    const m = await mineTriggerPrompts(index, { skill: "pdf", siblings: [], now: NOW });
    assert.equal(m.should[0]!.prompt.length, 500);
  });
});

describe("draftTriggerSpec", () => {
  it("fills each side to 8 after the mined prompts, and the toml round-trips", async () => {
    const root = await skillTree();
    const pdf = await readSkill(join(root, "pdf"));
    const card = await skillCard(pdf);
    assert.match(card.body, /Use pypdf/);
    const siblings = [await readSkill(join(root, "docx")), await readSkill(join(root, "xlsx"))];
    const index = await fakeIndex();
    const mined = await mineTriggerPrompts(index, { skill: "pdf", siblings: siblings.map((s) => s.name), now: NOW });
    const p = mock(REPLY);
    const cache = new MemoryJudgeCache();
    const d = await draftTriggerSpec(card, siblings, mined, { provider: p, cache });
    assert.equal(p.calls, 1);
    assert.match(p.users[0]!, /Write 5 should and 6 should_not prompts/);
    assert.match(p.users[0]!, /docx: Create and edit Word documents/);
    assert.equal(d.should.length, 8);
    assert.equal(d.shouldNot.length, 8);
    assert.deepEqual(d.should.slice(0, 3).map((x) => x.source), ["trace:p1", "trace:p2", "trace:p3"]);
    assert.ok(!d.should.some((x) => x.source === "draft" && x.prompt === "Fill in the form fields of w9.pdf"), "a draft identical to a mined prompt is dropped");
    assert.equal(d.shouldNot.find((x) => x.prompt.startsWith("Add a column"))!.expectSkill, "xlsx");
    assert.equal(d.shouldNot.find((x) => x.prompt.startsWith("Write release"))!.expectSkill, undefined, "an unknown expect_skill is dropped");
    assert.ok(d.warnings.some((w) => /dropped expect_skill from 1/.test(w)));

    const toml = renderTriggerToml(d, { version: "0.0.0-test", date: "2026-11-08" });
    assert.match(toml, /^# drafted by coding\.sh 0\.0\.0-test 2026-11-08: review before trusting/);
    const spec = parseTriggerSpec(toml);
    assert.equal(spec.skill, "pdf");
    assert.equal(spec.should.length, 8);
    assert.equal(spec.shouldNot.length, 8);
    assert.equal(spec.should[0]!.source, "trace:p1");
    assert.equal(spec.shouldNot[0]!.expectSkill, "docx");
    assert.ok(!toml.includes(SECRET));

    // The same inputs again: the cache answers, no model call.
    const again = await draftTriggerSpec(card, siblings, mined, { provider: p, cache });
    assert.equal(p.calls, 1);
    assert.equal(again.calls, 0);
    assert.deepEqual(again.should, d.should);
  });

  it("asks once more on bad JSON, then fails clearly", async () => {
    const card = { name: "pdf", description: "PDF files", body: "" };
    const ok = mock(["sorry, no", REPLY]);
    const d = await draftTriggerSpec(card, [], { should: [], shouldNot: [] }, { provider: ok });
    assert.equal(ok.calls, 2);
    assert.match(ok.users[1]!, /had no JSON object/);
    assert.equal(d.should.length, 7);
    const bad = mock("still no");
    await assert.rejects(draftTriggerSpec(card, [], { should: [], shouldNot: [] }, { provider: bad }), (e: unknown) => e instanceof DraftError && /no JSON draft in 2 replies/.test(e.message));
    assert.equal(bad.calls, 2);
  });

  it("warns that a set is too easy when half the positives name the skill (5 of 8)", async () => {
    const card = { name: "pdf", description: "PDF files", body: "" };
    const should = ["merge two pdf files", "split this PDF", "pdf to text please", "compress the pdf", "sign the PDF", "rotate page 2 of the scan", "combine the receipts", "extract the brochure text"].map((prompt) => ({ prompt, source: "draft" }));
    const shouldNot = Array.from({ length: 8 }, (_, i) => ({ prompt: `unrelated ${i}`, source: "draft" }));
    const p = mock(REPLY);
    const d = await draftTriggerSpec(card, [], { should, shouldNot }, { provider: p });
    assert.equal(p.calls, 0, "mined prompts filled both sides");
    assert.ok(d.warnings.some((w) => /^5 of 8 should prompts name the skill: too easy/.test(w)));
    assert.equal(namesSkill("Fill in w9.pdf", "pdf"), true);
    assert.equal(namesSkill("open the pdfium build", "pdf"), false);
    assert.equal(namesSkill("use the frontend design rules", "frontend-design"), true);
  });
});
