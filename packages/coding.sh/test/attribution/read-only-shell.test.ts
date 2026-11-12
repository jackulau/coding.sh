// A session whose only shell calls cannot write (ls, cat, git status) is not credited a file a person wrote in
// the same window. A shell call that may write (a build, a script) still keeps the lower-confidence credit.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { attributeRepo } from "../../src/attribution/index.ts";
import { readOnlyCommand, sessionSource } from "../../src/attribution/sources.ts";
import { snapshot } from "../../src/core/snapshot.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { gitc, isolate, removeTmp, tmp, write } from "../capture/_helpers.ts";
import { commitAll, event, HOUR, makeSession, T0 } from "./_fixture.ts";

before(() => isolate());
after(() => removeTmp());

const PERSON = "export function typedByHand(a: number, b: number): number {\n  const sum = a + b;\n  return sum * 2;\n}\n";
const OWN = "export function writtenByAgent(a: number): number {\n  const doubled = a * 2;\n  return doubled + 1;\n}\n";

type Ses = ReturnType<typeof makeSession>;
const bash = (s: Ses, n: number, command: string) => [
  event(s, "tool.start", { tool: "Bash", toolUseId: `b${n}`, input: { command } }, s.startedAt + n * 1000),
  event(s, "tool.end", { tool: "Bash", toolUseId: `b${n}`, ok: true, output: "" }, s.startedAt + n * 1000 + 1),
];
const write_ = (s: Ses, n: number, file: string, content: string) => [
  event(s, "tool.start", { tool: "Write", toolUseId: `w${n}`, input: { file_path: file, content } }, s.startedAt + n * 1000),
  event(s, "tool.end", { tool: "Write", toolUseId: `w${n}`, ok: true }, s.startedAt + n * 1000 + 1),
];

async function scenario(prefix: string, events: (s: Ses, root: string) => ReturnType<typeof event>[]) {
  const root = tmp(prefix);
  gitc(root, "init", "-q", "-b", "main");
  write(root, { "README.md": "# demo\n\nA small demo project, long enough.\n" });
  const head = commitAll(root, T0, "init");
  const s0 = makeSession("s-1", "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head });
  write(root, { "src/person.ts": PERSON, "src/own.ts": OWN });
  const end = (await snapshot(root))!;
  const s = { ...s0, endSnapshot: end.snapshot };
  const index = new MemoryIndexStore();
  await index.putEvents(events(s, root));
  await index.upsertSession(s);
  const ctx = { index, blobs: new MemoryBlobStore(), env: process.env };
  const c = commitAll(root, T0 + 2 * HOUR, "both");
  const rec = (await attributeRepo(ctx, { cwd: root })).commits.find((x) => x.commit === c)!;
  return { rec, source: await sessionSource(ctx, s) };
}

describe("readOnlyCommand", () => {
  test("looks, lists and reads", () => {
    for (const c of ["ls -la", "cat a.txt | head -5", "git status && git diff", "rg foo src", "pwd; echo hi", "find . -name '*.ts'"]) assert.equal(readOnlyCommand(c), true, c);
  });
  test("anything that may write is not read-only", () => {
    for (const c of ["npm test", "node gen.js", "echo hi > a.txt", "sed -i s/a/b/ f", "find . -delete", "ls\nrm x", "ls $(rm x)", "cat a | xargs rm", "git checkout main", "make"]) assert.equal(readOnlyCommand(c), false, c);
  });
});

describe("a session that only listed files", () => {
  test("is credited nothing for a file a person wrote", async () => {
    const { rec, source } = await scenario("csh-ls-only-", (s) => bash(s, 1, "ls -la src"));
    assert.equal(source, undefined);
    assert.deepEqual(rec.attributions, []);
  });

  test("an edit session keeps the lines it wrote and not the person's file", async () => {
    const { rec } = await scenario("csh-ls-edit-", (s, root) => [...bash(s, 1, "ls src"), ...write_(s, 2, join(root, "src/own.ts"), OWN)]);
    assert.deepEqual(rec.attributions.map((a) => [a.path, a.lines]), [["src/own.ts", 4]]);
  });

  test("a build command could have written the file, so the lower credit stays", async () => {
    const { rec } = await scenario("csh-ls-build-", (s) => bash(s, 1, "npm run build"));
    assert.deepEqual(rec.attributions.map((a) => a.path).sort(), ["src/own.ts", "src/person.ts"]);
  });
});
