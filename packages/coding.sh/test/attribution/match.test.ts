import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { blameFile, parseBlameTarget } from "../../src/attribution/blame.ts";
import { attributeRepo, commitKey } from "../../src/attribution/index.ts";
import { matchCommits, type SessionSource } from "../../src/attribution/match.ts";
import { lineKey } from "../../src/attribution/lines.ts";
import { sessionSource } from "../../src/attribution/sources.ts";
import type { CommitPatch } from "../../src/attribution/git.ts";
import { snapshot } from "../../src/core/snapshot.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { gitc, isolate, removeTmp, tmp, write } from "../capture/_helpers.ts";
import { buildFixture, commitAll, event, HOUR, makeSession, T0, type Fixture } from "./_fixture.ts";

before(() => isolate());
after(() => removeTmp());

/** git state of a repo: every ref, HEAD, the index and the notes, to prove nothing was written. */
function gitState(root: string): string {
  return [gitc(root, "for-each-ref"), gitc(root, "rev-parse", "HEAD"), gitc(root, "status", "--porcelain"), readFileSync(join(root, ".git", "index")).toString("base64").length].join("\n");
}

describe("attribution on the fixture repo (3 sessions, 4 commits, 1 human commit, 1 rebase)", () => {
  let fx: Fixture;
  before(async () => {
    fx = await buildFixture();
  });

  test("the fixture is what it says", () => {
    const log = gitc(fx.root, "log", "--format=%H %s", "main").split("\n");
    assert.equal(log.length, 5); // base + 4
    assert.deepEqual(
      log.map((l) => l.slice(41)),
      ["add smoothstep", "docs: contributing, clampToZero", "add util", "add clamp", "init"],
    );
    assert.notEqual(fx.commits.c3, fx.commits.c3Rebased);
    assert.equal(log[0]!.slice(0, 40), fx.commits.c3Rebased);
    // The pre-rebase commit is not on main.
    assert.throws(() => gitc(fx.root, "merge-base", "--is-ancestor", fx.commits.c3, "main"));
  });

  test("agent lines map to the right sessions and human lines to none, file by file", async () => {
    const ctx = { index: fx.index, blobs: fx.blobs, env: fx.env };
    const report = await attributeRepo(ctx, { cwd: fx.root });
    for (const [path, want] of Object.entries(fx.expected)) {
      const b = await blameFile(ctx, { cwd: fx.root, path, report });
      assert.equal(b.rows.length, want.length, `${path}: line count`);
      for (const row of b.rows) {
        const w = want[row.line - 1];
        if (w === undefined) continue;
        assert.equal(row.sessionId ?? null, w, `${path}:${row.line} ${JSON.stringify(row.text)}`);
      }
    }
  });

  test("per commit: C1 all S1, C2 mostly S2, H none, the rebased C3 all S3", async () => {
    const report = await attributeRepo({ index: fx.index, blobs: fx.blobs, env: fx.env }, { cwd: fx.root });
    const byCommit = new Map(report.commits.map((c) => [c.commit, c]));
    const sessionsOf = (sha: string) => [...new Set(byCommit.get(sha)!.attributions.map((a) => a.sessionId))].sort();
    assert.deepEqual(sessionsOf(fx.commits.c1), ["s1-claude"]);
    assert.equal(byCommit.get(fx.commits.c1)!.attributed, byCommit.get(fx.commits.c1)!.added);
    assert.ok(byCommit.get(fx.commits.c1)!.attributions.every((a) => a.method === "patch-id" && a.confidence === 1));
    assert.deepEqual(sessionsOf(fx.commits.c2), ["s2-codex"]);
    const c2 = byCommit.get(fx.commits.c2)!;
    assert.equal(c2.added - c2.attributed, 3, "the rewritten line, and the person's own line with the blank line before it");
    assert.deepEqual(sessionsOf(fx.commits.h), []);
    assert.equal(byCommit.get(fx.commits.h)!.attributed, 0);
    // The rebased commit (new sha) still maps, with the lines where they are now.
    assert.ok(!byCommit.has(fx.commits.c3));
    const c3 = byCommit.get(fx.commits.c3Rebased)!;
    assert.deepEqual(sessionsOf(fx.commits.c3Rebased), ["s3-claude"]);
    assert.equal(c3.attributed, c3.added);
    const math = c3.attributions.find((a) => a.path === "src/math.ts")!;
    assert.deepEqual(math.ranges.map((r) => [r.start, r.end]), [[17, 21]]);
    assert.equal(math.agent, "claude-code");
    assert.equal(math.model, "claude-opus-4-1");
    // Sessions, most lines first.
    assert.deepEqual(report.sessions.map((s) => s.id).sort(), ["s1-claude", "s2-codex", "s3-claude"]);
    assert.equal(report.sources, 3);
  });

  test("blame takes path:line and path:a-b", async () => {
    assert.deepEqual(parseBlameTarget("src/math.ts:12"), { path: "src/math.ts", lines: [12, 12] });
    assert.deepEqual(parseBlameTarget("src/math.ts:3-5"), { path: "src/math.ts", lines: [3, 5] });
    assert.deepEqual(parseBlameTarget("src/math.ts"), { path: "src/math.ts" });
    assert.deepEqual(parseBlameTarget("C:\\x\\a.ts"), { path: "C:\\x\\a.ts" });
    const ctx = { index: fx.index, blobs: fx.blobs, env: fx.env };
    const b = await blameFile(ctx, { cwd: join(fx.root, "src"), path: "math.ts", lines: [17, 21] });
    assert.equal(b.path, "src/math.ts");
    assert.deepEqual(b.rows.map((r) => r.line), [17, 18, 19, 20, 21]);
    assert.ok(b.rows.every((r) => r.sessionId === "s3-claude" && r.commit === fx.commits.c3Rebased));
    assert.deepEqual(b.sessions.map((s) => [s.id, s.lines]), [["s3-claude", 5]]);
    assert.equal(b.unattributed, 0);
  });

  test("read-only on git: refs, HEAD, index and working tree are unchanged", async () => {
    const beforeState = gitState(fx.root);
    await attributeRepo({ index: fx.index, blobs: fx.blobs, env: fx.env }, { cwd: fx.root, store: true });
    assert.equal(gitState(fx.root), beforeState);
  });

  test("store: true keeps each commit's attributions in the index kv", async () => {
    const index = new MemoryIndexStore();
    for (const s of Object.values(fx.sessions)) await index.upsertSession(s);
    await attributeRepo({ index, blobs: fx.blobs, env: fx.env }, { cwd: fx.root, store: true });
    const saved = JSON.parse((await index.kvGet(commitKey(fx.commits.c3Rebased)))!) as { added: number; attributed: number; attributions: { sessionId: string }[] };
    assert.equal(saved.attributed, saved.added);
    assert.ok(saved.attributions.every((a) => a.sessionId === "s3-claude"));
    // The session source cache holds hashes only, never the code.
    const src = (await index.kvGet("attribution:source:s3-claude"))!;
    assert.ok(!src.includes("smoothstep"));
  });

  test("a session that started after a commit, or more than 21 days before it, gets no credit", async () => {
    const late = { ...fx.sessions.s1, id: "late", startedAt: T0 + 30 * HOUR };
    const old = { ...fx.sessions.s1, id: "old", startedAt: T0 - 30 * 24 * HOUR };
    const report = await attributeRepo({ index: new MemoryIndexStore(), blobs: fx.blobs, env: fx.env }, { cwd: fx.root, sessions: [late, old], since: T0 - 31 * 24 * HOUR });
    assert.equal(report.commits.reduce((n, c) => n + c.attributed, 0), 0);
  });
});

describe("matcher", () => {
  const commit = (sha: string, at: number, files: CommitPatch["files"]): CommitPatch => ({ sha, parents: [], committedAt: at, authoredAt: at, author: "x", subject: sha, files });
  const added = (path: string, lines: string[], from = 1) => ({ path, added: lines.map((t, i) => ({ line: from + i, key: lineKey(t) })), removed: [] });
  const src = (id: string, startedAt: number, path: string, lines: string[]): SessionSource => ({ sessionId: id, agent: "codex", startedAt, files: [{ path, keys: lines.map(lineKey), via: "snapshot" }] });

  test("a line is credited once: the same line typed again later is not the agent's", () => {
    const out = matchCommits(
      [commit("a".repeat(40), T0 + HOUR, [added("f.ts", ["const answer = compute(input);", "x();"])]), commit("b".repeat(40), T0 + 2 * HOUR, [added("f.ts", ["const answer = compute(input);"], 10)])],
      [src("s", T0, "f.ts", ["const answer = compute(input);"])],
    );
    assert.equal(out[0]!.attributed, 1);
    assert.equal(out[1]!.attributed, 0);
  });

  test("of two sessions that wrote the same line, the later one wins", () => {
    const line = "export const LIMIT = readLimit(process.env);";
    const out = matchCommits([commit("a".repeat(40), T0 + 5 * HOUR, [added("f.ts", [line])])], [src("early", T0, "f.ts", [line]), src("late", T0 + 4 * HOUR, "f.ts", [line])]);
    assert.equal(out[0]!.attributions[0]!.sessionId, "late");
  });

  test("trivial lines never match alone, and follow a matched neighbor", () => {
    const out = matchCommits(
      [commit("a".repeat(40), T0 + HOUR, [added("f.ts", ["}", "", "function body() {", "}"])])],
      [src("s", T0, "f.ts", ["}", "", "function body() {", "}"])],
    );
    // patch-id path: identical change, every line.
    assert.equal(out[0]!.attributed, 4);
    const lone = matchCommits([commit("a".repeat(40), T0 + HOUR, [added("f.ts", ["}", ")"])])], [src("s", T0, "f.ts", ["}", ")", "other line here"])]);
    assert.equal(lone[0]!.attributed, 0);
    const mixed = matchCommits(
      [commit("a".repeat(40), T0 + HOUR, [added("f.ts", ["function body() {", "  work();", "}", "", "}"])])],
      [src("s", T0, "f.ts", ["function body() {", "  work();", "}", "unrelated()"])],
    );
    // The first } follows its function; the second has no } left in the pool.
    const lines = mixed[0]!.attributions.flatMap((a) => a.ranges.flatMap((r) => Array.from({ length: r.end - r.start + 1 }, (_, i) => r.start + i)));
    assert.deepEqual(lines, [1, 2, 3]);
  });

  test("a long line in a moved file still matches, at lower confidence", () => {
    const line = "export function parseConfig(text: string): Config {";
    const out = matchCommits([commit("a".repeat(40), T0 + HOUR, [added("new/place.ts", [line, "x"])])], [src("s", T0, "old/place.ts", [line, "x"])]);
    assert.equal(out[0]!.attributed, 1);
    assert.equal(out[0]!.attributions[0]!.method, "moved");
    assert.ok(out[0]!.attributions[0]!.confidence < 1);
  });

  test("a person's copy of a long line in another file of the commit does not take the agent's credit", () => {
    const line = "  return sum(values) / values.length;";
    const agent = ["export function mean(values: number[]): number {", line, "}"];
    // a.ts sorts first: it is the person's file, and holds the same long line once.
    const out = matchCommits(
      [commit("a".repeat(40), T0 + HOUR, [added("a.ts", ["export function average(values: number[]): number {", line, "}"]), added("b.ts", agent)])],
      [src("s", T0, "b.ts", agent)],
    );
    assert.deepEqual(
      out[0]!.attributions.map((a) => [a.path, a.lines, a.method, a.ranges.map((r) => [r.start, r.end])]),
      [["b.ts", 3, "line-hash", [[1, 3]]]],
    );
    assert.equal(out[0]!.added, 6);
    assert.equal(out[0]!.attributed, 3);
  });
});

describe("sources", () => {
  test("a session whose end snapshot is gone is matched from its own edit tool calls (replay)", async () => {
    const root = tmp("csh-attr-replay-");
    gitc(root, "init", "-q", "-b", "main");
    write(root, { "a.txt": "base\n" });
    const head = commitAll(root, T0, "init");
    const content = "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n";
    // Its end snapshot is gone (shadow repo deleted, history pruned): the edit tool calls stand in.
    const s = makeSession("s-replay", "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head }, "f".repeat(40));
    const index = new MemoryIndexStore();
    await index.upsertSession(s);
    await index.putEvents([
      event(s, "tool.start", { tool: "Write", toolUseId: "t1", input: { file_path: join(root, "src/greet.ts"), content } }),
      event(s, "tool.end", { tool: "Write", toolUseId: "t1", ok: true }, s.startedAt + 61_000),
    ]);
    write(root, { "src/greet.ts": content, "notes.md": "a person's note, long enough to count\n" });
    const c = commitAll(root, T0 + 2 * HOUR, "greet");
    const report = await attributeRepo({ index, blobs: new MemoryBlobStore(), env: process.env }, { cwd: root });
    const rec = report.commits.find((x) => x.commit === c)!;
    assert.deepEqual(rec.attributions.map((a) => [a.path, a.sessionId, a.lines]), [["src/greet.ts", "s-replay", 3]]);
    assert.equal(rec.attributions[0]!.confidence <= 0.8, true);
    assert.equal(rec.added, 4);
  });

  describe("a session whose work was committed on another branch before its end snapshot was taken", () => {
    const TEMP = [
      "export const celsiusToFahrenheit = (celsius: number): number => (celsius * 9) / 5 + 32;",
      "export const fahrenheitToCelsius = (fahrenheit: number): number => ((fahrenheit - 32) * 5) / 9;",
      "export const celsiusToKelvin = (celsius: number): number => celsius + 273.15;",
      "export const kelvinToCelsius = (kelvin: number): number => kelvin - 273.15;",
      "export const fahrenheitToKelvin = (fahrenheit: number): number => celsiusToKelvin(fahrenheitToCelsius(fahrenheit));",
      "export const kelvinToFahrenheit = (kelvin: number): number => celsiusToFahrenheit(kelvinToCelsius(kelvin));",
      "export const ABSOLUTE_ZERO_CELSIUS = -273.15;",
    ];
    const content = TEMP.join("\n") + "\n";

    /**
     * `git checkout -b auto-branch`, the agent Writes src/temp.ts, the work is committed there, and the tree is
     * back on main (plus whatever `onMain` leaves in it) when the end snapshot is taken.
     */
    async function committedElsewhere(prefix: string, onMain: Record<string, string> = {}) {
      const root = tmp(prefix);
      gitc(root, "init", "-q", "-b", "main");
      write(root, { "a.txt": "base\n" });
      const head = commitAll(root, T0, "init");
      gitc(root, "checkout", "-q", "-b", "auto-branch");
      write(root, { "src/temp.ts": content });
      const c = commitAll(root, T0 + 2 * HOUR, "auto: add temperature conversions");
      gitc(root, "checkout", "-q", "main");
      write(root, onMain);
      const end = (await snapshot(root))!;
      const s = makeSession(`s-${prefix}`, "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head }, end.snapshot);
      const index = new MemoryIndexStore();
      await index.upsertSession(s);
      await index.putEvents([
        event(s, "tool.start", { tool: "Write", toolUseId: "t1", input: { file_path: join(root, "src/temp.ts"), content } }),
        event(s, "tool.end", { tool: "Write", toolUseId: "t1", ok: true }, s.startedAt + 61_000),
      ]);
      const ctx = { index, blobs: new MemoryBlobStore(), env: process.env };
      const source = await sessionSource(ctx, s);
      const report = await attributeRepo(ctx, { cwd: root, rev: "auto-branch" });
      return { s, source, rec: report.commits.find((x) => x.commit === c)! };
    }

    test("an end snapshot whose tree equals the start: the commit is the session's, from its Write call", async () => {
      const { s, source, rec } = await committedElsewhere("csh-attr-branch-");
      assert.deepEqual(source?.files.map((f) => [f.path, f.via, f.edited]), [["src/temp.ts", "replay", true]]);
      assert.deepEqual([...source!.files[0]!.keys].sort(), TEMP.map(lineKey).sort());
      assert.equal(rec.added, 7);
      assert.deepEqual(rec.attributions.map((a) => [a.path, a.sessionId, a.lines, a.confidence]), [["src/temp.ts", s.id, 7, 0.8]]);
    });

    test("an end snapshot that holds only another file: that file stays the snapshot's, the written file comes from the Write call", async () => {
      const { s, source, rec } = await committedElsewhere("csh-attr-branch-other-", { "notes.md": "a note left in the tree on main\n" });
      assert.deepEqual(source?.files.map((f) => [f.path, f.via, f.edited]), [["notes.md", "snapshot-head", undefined], ["src/temp.ts", "replay", true]]);
      assert.deepEqual(rec.attributions.map((a) => [a.path, a.sessionId, a.lines, a.confidence]), [["src/temp.ts", s.id, 7, 0.8]]);
    });
  });

  describe("without snapshots, a file a person edited between two of the session's edits", () => {
    const WRITE = ["export function rectArea(width: number, height: number): number {", "  return width * height;", "}"];
    const PERSON = ["", "export function triangleArea(base: number, height: number): number {", "  // typed by a person between two agent turns", "  return (base * height) / 2;", "}"];
    const EDIT = ["export function circleArea(radius: number): number {", "  return Math.PI * radius * radius;", "}", ""];
    const text = (ls: string[]) => ls.join("\n") + "\n";
    const sorted = (ls: string[]) => ls.map(lineKey).sort();

    /**
     * Write, a person appends, then Edit, with the events a transcript backfill stores (each edit's file.change
     * included). `between` are the events of the steps in between, `editOutput` what Edit returned.
     */
    async function replayed(prefix: string, between: (s: ReturnType<typeof makeSession>, file: string) => ReturnType<typeof event>[], editOutput: (file: string) => unknown) {
      const root = tmp(prefix);
      gitc(root, "init", "-q", "-b", "main");
      write(root, { "a.txt": "base\n" });
      const head = commitAll(root, T0, "init");
      // No start snapshot and no end snapshot, as after `ingest --backfill` on a store that never ran the hook.
      const s = makeSession(`s-${prefix}`, "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head });
      const file = join(root, "src/geo.ts");
      const at = (n: number) => s.startedAt + n * 1000;
      const index = new MemoryIndexStore();
      await index.upsertSession(s);
      await index.putEvents([
        event(s, "tool.start", { tool: "Write", toolUseId: "t1", input: { file_path: file, content: text(WRITE) } }, at(1)),
        event(s, "tool.end", { tool: "Write", toolUseId: "t1", ok: true, output: `File created successfully at: ${file}` }, at(2)),
        event(s, "file.change", { path: "src/geo.ts", op: "add", tool: "Write", toolUseId: "t1", diff: `--- /dev/null\n+++ b/src/geo.ts\n@@ -0,0 +1,3 @@\n${WRITE.map((l) => `+${l}\n`).join("")}` }, at(2)),
        ...between(s, file),
        event(s, "tool.start", { tool: "Edit", toolUseId: "t3", input: { file_path: file, old_string: "export function rectArea(", new_string: text(EDIT) + "export function rectArea(" } }, at(5)),
        event(s, "tool.end", { tool: "Edit", toolUseId: "t3", ok: true, output: editOutput(file) }, at(6)),
        event(s, "file.change", { path: "src/geo.ts", op: "modify", tool: "Edit", toolUseId: "t3", diff: `--- a/src/geo.ts\n+++ b/src/geo.ts\n@@ -1,3 +1,7 @@\n${EDIT.map((l) => `+${l}\n`).join("")}${WRITE.map((l) => ` ${l}\n`).join("")}` }, at(6)),
      ]);
      write(root, { "src/geo.ts": text([...EDIT, ...WRITE, ...PERSON]) });
      const c = commitAll(root, T0 + 2 * HOUR, "add geo helpers");
      const ctx = { index, blobs: new MemoryBlobStore(), env: process.env };
      const source = await sessionSource(ctx, s);
      const report = await attributeRepo(ctx, { cwd: root });
      return { ctx, s, source, rec: report.commits.find((x) => x.commit === c)! };
    }

    test("that the agent read again: only the lines of its Write and Edit are its own", async () => {
      const numbered = [...WRITE, ...PERSON, ""].map((l, i) => `${i + 1}\t${l}`).join("\n");
      const { source, rec } = await replayed(
        "csh-attr-reread-",
        (s, file) => [
          event(s, "tool.start", { tool: "Read", toolUseId: "t2", input: { file_path: file } }, s.startedAt + 3000),
          event(s, "tool.end", { tool: "Read", toolUseId: "t2", ok: true, output: numbered }, s.startedAt + 4000),
        ],
        (file) => `The file ${file} has been updated successfully.`,
      );
      assert.deepEqual(source!.files.map((f) => [f.path, f.via]), [["src/geo.ts", "replay"]]);
      // The 7 lines of the Write and the Edit, and none of the person's 5 (their blank line and brace are not counted twice).
      assert.deepEqual([...source!.files[0]!.keys].sort(), sorted([...WRITE, ...EDIT]));
      assert.equal(rec.added, 12);
      assert.equal(rec.attributed, 7);
      assert.deepEqual(rec.attributions[0]!.ranges.map((r) => [r.start, r.end]), [[1, 7]]);
    });

    test("that only the Edit's own result shows (no read in between): the person's lines are still not the session's", async () => {
      const { source, rec } = await replayed(
        "csh-attr-original-",
        () => [],
        (file) => ({ filePath: file, oldString: "export function rectArea(", newString: text(EDIT) + "export function rectArea(", originalFile: text([...WRITE, ...PERSON]) }),
      );
      assert.deepEqual([...source!.files[0]!.keys].sort(), sorted([...WRITE, ...EDIT]));
      assert.equal(rec.attributed, 7);
    });

    test("a source an older build cached with the person's lines in it is built again", async () => {
      const { ctx, s, source } = await replayed("csh-attr-cached-", () => [], (file) => `The file ${file} has been updated successfully.`);
      const key = `attribution:source:${s.id}`;
      const cached = JSON.parse((await ctx.index.kvGet(key))!) as { fp: string; files: { keys: string[] }[] };
      // What the first source version stored: the same fingerprint under version 1, and the net diff of the file.
      cached.fp = cached.fp.replace(/^\d+\|/, "1|");
      cached.files[0]!.keys.push(...PERSON.map(lineKey));
      await ctx.index.kvSet(key, JSON.stringify(cached));
      const again = await sessionSource(ctx, s);
      assert.deepEqual([...again!.files[0]!.keys].sort(), [...source!.files[0]!.keys].sort());
      assert.deepEqual([...again!.files[0]!.keys].sort(), sorted([...WRITE, ...EDIT]));
    });
  });

  test("a line the session wrote and then replaced is not in its source", async () => {
    const root = tmp("csh-attr-rewrite-");
    gitc(root, "init", "-q", "-b", "main");
    write(root, { "a.txt": "base\n" });
    const head = commitAll(root, T0, "init");
    const s = makeSession("s-rewrite", "claude-code", "claude-sonnet-4-5", T0 + HOUR, { root, head });
    const file = join(root, "src/limit.ts");
    const index = new MemoryIndexStore();
    await index.upsertSession(s);
    await index.putEvents([
      event(s, "tool.start", { tool: "Write", toolUseId: "t1", input: { file_path: file, content: "export const LIMIT = 10;\nexport const NAME = readName(process.env);\n" } }, s.startedAt + 1000),
      event(s, "tool.end", { tool: "Write", toolUseId: "t1", ok: true }, s.startedAt + 2000),
      event(s, "file.change", { path: "src/limit.ts", op: "add", tool: "Write", toolUseId: "t1" }, s.startedAt + 2000),
      event(s, "tool.start", { tool: "Edit", toolUseId: "t2", input: { file_path: file, old_string: "export const LIMIT = 10;", new_string: "export const LIMIT = 25;" } }, s.startedAt + 3000),
      event(s, "tool.end", { tool: "Edit", toolUseId: "t2", ok: true }, s.startedAt + 4000),
    ]);
    const source = await sessionSource({ index, blobs: new MemoryBlobStore(), env: process.env }, s);
    assert.deepEqual([...source!.files[0]!.keys].sort(), ["export const LIMIT = 25;", "export const NAME = readName(process.env);"].map(lineKey).sort());
  });

  test("sessions in another worktree of the repo are found", async () => {
    const root = tmp("csh-attr-wt-");
    gitc(root, "init", "-q", "-b", "main");
    write(root, { "a.txt": "base\n" });
    commitAll(root, T0, "init");
    // Long names on Windows (the temp dir has a short name on CI, RUNNER~1): git lists a worktree by its long name.
    const wt = join(realpathSync.native(tmp("csh-attr-wt2-")), "wt");
    gitc(root, "worktree", "add", "-q", "-b", "agent", wt);
    const start = (await snapshot(wt))!;
    write(wt, { "lib.ts": "export const workerCount = Number(process.env.WORKERS ?? 4);\n" });
    const end = (await snapshot(wt))!;
    const s = makeSession("s-wt", "codex", "gpt-5-codex", T0 + HOUR, start, end.snapshot);
    const index = new MemoryIndexStore();
    await index.upsertSession(s);
    const c = commitAll(wt, T0 + 2 * HOUR, "workers");
    gitc(root, "merge", "-q", "--ff-only", "agent");
    const report = await attributeRepo({ index, blobs: new MemoryBlobStore(), env: process.env }, { cwd: root });
    assert.deepEqual(report.commits.find((x) => x.commit === c)!.attributions.map((a) => a.sessionId), ["s-wt"]);
  });

  test("git-ai notes credit lines no captured session matched", async () => {
    const root = tmp("csh-attr-gitai-");
    gitc(root, "init", "-q", "-b", "main");
    write(root, { "a.txt": "base\n" });
    commitAll(root, T0, "init");
    write(root, { "src/x.ts": "one line here\ntwo line here\nthree by hand\n" });
    const c = commitAll(root, T0 + HOUR, "x");
    const note = [
      "src/x.ts",
      "  s_c9883b05a2487d::t_9f8e7d6c5b4a32 1-2",
      "  h_31dce776f88375 3",
      "---",
      JSON.stringify({
        schema_version: "authorship/3.0.0",
        base_commit_sha: c,
        prompts: {},
        humans: { h_31dce776f88375: { author: "Dev <dev@example.invalid>" } },
        sessions: { s_c9883b05a2487d: { agent_id: { tool: "cursor", id: "conv-123", model: "claude-sonnet-4-5" } } },
      }),
    ].join("\n");
    const file = join(tmp("csh-note-"), "note.txt");
    writeFileSync(file, note);
    execFileSync("git", ["notes", "--ref=ai", "add", "-F", file, c], { cwd: root });
    const report = await attributeRepo({ index: new MemoryIndexStore(), blobs: new MemoryBlobStore(), env: process.env }, { cwd: root, since: T0 - HOUR });
    assert.equal(report.gitAi, true);
    const a = report.commits.find((x) => x.commit === c)!.attributions;
    assert.deepEqual(a.map((x) => [x.sessionId, x.agent, x.model, x.method, x.source, x.ranges.map((r) => [r.start, r.end])]), [["conv-123", "cursor", "claude-sonnet-4-5", "git-ai", "git-ai", [[1, 2]]]]);
  });
});
