// Lines a person typed (or another session left in the tree) between a session's start and its end snapshot are
// in the tree diff, but the session could not have written them: its tools never named the file and it ran no
// shell or subagent call. Every session here starts at HEAD, as a hook-captured one does.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { attributeRepo } from "../../src/attribution/index.ts";
import { sessionSource } from "../../src/attribution/sources.ts";
import { snapshot } from "../../src/core/snapshot.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { gitc, isolate, removeTmp, tmp, write } from "../capture/_helpers.ts";
import { commitAll, event, HOUR, makeSession, T0 } from "./_fixture.ts";

before(() => isolate());
after(() => removeTmp());

const PERSON = "export function typedByHand(a: number, b: number): number {\n  const sum = a + b;\n  return sum * 2;\n}\n";
const OWN = "export function writtenByAgent(a: number): number {\n  const doubled = a * 2;\n  return doubled + 1;\n}\n";

function repo(prefix: string) {
  const root = tmp(prefix);
  gitc(root, "init", "-q", "-b", "main");
  write(root, { "README.md": "# demo\n\nA small demo project, long enough.\n" });
  return { root, head: commitAll(root, T0, "init") };
}

type Ses = ReturnType<typeof makeSession>;
const read = (s: Ses, n: number, file: string) => [
  event(s, "tool.start", { tool: "Read", toolUseId: `r${n}`, input: { file_path: file } }, s.startedAt + n * 1000),
  event(s, "tool.end", { tool: "Read", toolUseId: `r${n}`, ok: true, output: "1\t# demo" }, s.startedAt + n * 1000 + 1),
];
const write_ = (s: Ses, n: number, file: string, content: string) => [
  event(s, "tool.start", { tool: "Write", toolUseId: `w${n}`, input: { file_path: file, content } }, s.startedAt + n * 1000),
  event(s, "tool.end", { tool: "Write", toolUseId: `w${n}`, ok: true }, s.startedAt + n * 1000 + 1),
];
const bash = (s: Ses, n: number, command: string) => [
  event(s, "tool.start", { tool: "Bash", toolUseId: `b${n}`, input: { command } }, s.startedAt + n * 1000),
  event(s, "tool.end", { tool: "Bash", toolUseId: `b${n}`, ok: true, output: "" }, s.startedAt + n * 1000 + 1),
];

async function run(index: MemoryIndexStore, sessions: Ses[], root: string, commit: string) {
  const ctx = { index, blobs: new MemoryBlobStore(), env: process.env };
  for (const s of sessions) await index.upsertSession(s);
  const sources = await Promise.all(sessions.map((s) => sessionSource(ctx, s)));
  const rec = (await attributeRepo(ctx, { cwd: root })).commits.find((c) => c.commit === commit)!;
  return { sources, rec, ctx };
}

describe("lines a person typed are not a session's", () => {
  test("a session that only read a file gets nothing for a file a person wrote and committed before the end snapshot", async () => {
    const { root, head } = repo("csh-hand-read-");
    write(root, { "src/person.ts": PERSON });
    const c = commitAll(root, T0 + 2 * HOUR, "by hand");
    const end = (await snapshot(root))!;
    const s = makeSession("s-read", "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head }, end.snapshot);
    const index = new MemoryIndexStore();
    await index.putEvents(read(s, 1, join(root, "README.md")));
    const { sources, rec } = await run(index, [s], root, c);
    assert.equal(sources[0], undefined);
    assert.equal(rec.added, 4);
    assert.deepEqual(rec.attributions, []);
  });

  test("a hand file already uncommitted at session start is not credited to a session that never named it", async () => {
    const { root, head } = repo("csh-hand-dirty-");
    write(root, { "src/person.ts": PERSON });
    const s0 = makeSession("s-dirty", "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head });
    write(root, { "src/own.ts": OWN });
    const end = (await snapshot(root))!;
    const s = { ...s0, endSnapshot: end.snapshot };
    const index = new MemoryIndexStore();
    await index.putEvents([...read(s, 1, join(root, "README.md")), ...write_(s, 2, join(root, "src/own.ts"), OWN)]);
    const c = commitAll(root, T0 + 2 * HOUR, "both");
    const { sources, rec } = await run(index, [s], root, c);
    assert.deepEqual(sources[0]!.files.map((f) => f.path), ["src/own.ts"]);
    assert.deepEqual(rec.attributions.map((a) => [a.path, a.sessionId]), [["src/own.ts", "s-dirty"]]);
  });

  test("another session's uncommitted file is not credited to a session that only read", async () => {
    const { root, head } = repo("csh-hand-other-");
    const other = makeSession("s-other", "codex", "gpt-5-codex", T0 + HOUR, { root, head });
    const mine = makeSession("s-mine", "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head });
    write(root, { "src/other.ts": OWN });
    const end = (await snapshot(root))!;
    const index = new MemoryIndexStore();
    await index.putEvents([...write_(other, 1, join(root, "src/other.ts"), OWN), ...read(mine, 1, join(root, "README.md"))]);
    const c = commitAll(root, T0 + 2 * HOUR, "other");
    const { sources, rec } = await run(index, [{ ...other, endSnapshot: end.snapshot }, { ...mine, endSnapshot: end.snapshot }], root, c);
    assert.equal(sources[1], undefined);
    assert.deepEqual(rec.attributions.map((a) => [a.path, a.sessionId]), [["src/other.ts", "s-other"]]);
  });

  test("a session with edit tool calls is still credited its own lines, and not a person's file in the same window", async () => {
    const { root, head } = repo("csh-hand-edit-");
    const s0 = makeSession("s-edit", "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head });
    write(root, { "src/own.ts": OWN, "src/person.ts": PERSON });
    const end = (await snapshot(root))!;
    const s = { ...s0, endSnapshot: end.snapshot };
    const index = new MemoryIndexStore();
    await index.putEvents(write_(s, 1, join(root, "src/own.ts"), OWN));
    const c = commitAll(root, T0 + 2 * HOUR, "both");
    const { rec } = await run(index, [s], root, c);
    assert.deepEqual(rec.attributions.map((a) => [a.path, a.sessionId, a.lines]), [["src/own.ts", "s-edit", 4]]);
    assert.equal(rec.attributions[0]!.confidence, 0.9);
  });

  test("a person's lines in a file the session also edited are not its own", async () => {
    const { root, head } = repo("csh-hand-samefile-");
    const s0 = makeSession("s-same", "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head });
    write(root, { "src/own.ts": OWN + "\n" + PERSON });
    const end = (await snapshot(root))!;
    const s = { ...s0, endSnapshot: end.snapshot };
    const index = new MemoryIndexStore();
    await index.putEvents(write_(s, 1, join(root, "src/own.ts"), OWN));
    const c = commitAll(root, T0 + 2 * HOUR, "both");
    const { rec } = await run(index, [s], root, c);
    assert.deepEqual(rec.attributions.map((a) => [a.path, a.lines]), [["src/own.ts", 4]]);
  });

  test("a session that ran a shell tool keeps the lower-confidence credit for a file nothing named", async () => {
    const { root, head } = repo("csh-hand-shell-");
    const s0 = makeSession("s-shell", "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head });
    write(root, { "src/own.ts": OWN, "src/generated.ts": PERSON });
    const end = (await snapshot(root))!;
    const s = { ...s0, endSnapshot: end.snapshot };
    const index = new MemoryIndexStore();
    await index.putEvents([...write_(s, 1, join(root, "src/own.ts"), OWN), ...bash(s, 2, "node gen.js > src/generated.ts")]);
    const c = commitAll(root, T0 + 2 * HOUR, "both");
    const { rec } = await run(index, [s], root, c);
    const by = new Map(rec.attributions.map((a) => [a.path, a]));
    assert.equal(by.get("src/own.ts")!.confidence, 0.9);
    assert.equal(by.get("src/generated.ts")!.sessionId, "s-shell");
    assert.equal(by.get("src/generated.ts")!.confidence < 0.9, true);
  });
});
