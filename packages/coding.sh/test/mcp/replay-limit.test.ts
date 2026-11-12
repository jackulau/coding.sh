// session_replay stays under the 25,000-character limit in every view, with a session that touched
// 300 files of about 2 KB each (and a few of 50 KB): the step list, a step, a step with a file, and ranges. Pages by
// limit and cursor reach every file exactly once, and cut text says so.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { CHARACTER_LIMIT } from "../../src/mcp/tools.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { RawClient, cleanup, makeWorld, seed, type World } from "./helpers.ts";

const ID = "sess-files";
const FILES = 300;
const path = (i: number) => `src/gen/file-${String(i).padStart(3, "0")}.ts`;

let w: World;
let c: RawClient;

type Sc = Record<string, any>;

async function call(args: Record<string, unknown>, sessionId = ID): Promise<{ sc: Sc; len: number }> {
  const r = await c.call("session_replay", { sessionId, ...args });
  assert.notEqual(r.isError, true, r.content[0]?.text.slice(0, 300));
  return { sc: r.structuredContent as Sc, len: r.content[0]!.text.length };
}

/** Every page of a view, following nextCursor. Each page is checked against the limit. */
async function pages(args: Record<string, unknown>, sessionId = ID): Promise<Sc[]> {
  const out: Sc[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 400; i++) {
    const next = { ...args };
    if (cursor) next.cursor = cursor;
    const { sc, len } = await call(next, sessionId);
    assert.ok(len <= CHARACTER_LIMIT, `page ${i} of ${JSON.stringify(args)} is ${len} characters`);
    out.push(sc);
    cursor = sc.nextCursor;
    if (!cursor) return out;
  }
  throw new Error("the cursor never ended");
}

const once = (xs: string[], n: number, what: string) => {
  assert.equal(xs.length, n, `${what}: ${xs.length} entries`);
  assert.equal(new Set(xs).size, n, `${what}: each exactly once`);
};

before(async () => {
  w = makeWorld();
  await seed(w);
  const ctx = await openContext({ env: w.env, cwd: w.root });
  const t0 = w.now - 3 * 3600e3;
  const base = { v: 0 as const, sessionId: ID, agent: "claude-code", cwd: w.repo, model: "claude-opus-4-5" };
  const evs: AgentEvent[] = [{ ...base, id: "f-0", ts: t0, kind: "session.start", payload: {} }, { ...base, id: "f-1", ts: t0 + 1, kind: "user.message", payload: { text: "Generate the files" } }];
  for (let i = 0; i < FILES; i++) {
    // About 2 KB of distinct lines per file.
    const content = Array.from({ length: 60 }, (_, l) => `export const v${i}_${l} = ${l * 7919 + i};`).join("\n") + "\n";
    evs.push({ ...base, id: `f-s${i}`, ts: t0 + 10 + i * 10, kind: "tool.start", payload: { tool: "Write", toolUseId: `w${i}`, input: { file_path: path(i), content } } });
    evs.push({ ...base, id: `f-e${i}`, ts: t0 + 15 + i * 10, kind: "tool.end", payload: { tool: "Write", toolUseId: `w${i}`, ok: true }, durationMs: 5 });
    evs.push({ ...base, id: `f-c${i}`, ts: t0 + 16 + i * 10, kind: "file.change", payload: { path: path(i), op: "add" } });
  }
  evs.push({ ...base, id: "f-end", ts: t0 + 20 * FILES, kind: "session.end", payload: {} });
  await ctx.index.putEvents(evs);
  await ctx.index.upsertSession(buildSession(evs));
  // More shapes: a small diff, a MultiEdit of 60 edits, an apply_patch that adds 500 files, and a 20 KB
  // file followed by tool steps whose output grows, so that some step is near the limit.
  const put = async (sid: string, agent: string, calls: { tool: string; input: Record<string, unknown>; output?: string }[]) => {
    const b = { ...base, sessionId: sid, agent };
    const list: AgentEvent[] = [{ ...b, id: `${sid}-0`, ts: t0, kind: "session.start", payload: {} }, { ...b, id: `${sid}-1`, ts: t0 + 1, kind: "user.message", payload: { text: "go" } }];
    calls.forEach((x, i) => {
      list.push({ ...b, id: `${sid}-s${i}`, ts: t0 + 10 + i * 2, kind: "tool.start", payload: { tool: x.tool, toolUseId: `u${i}`, input: x.input } });
      list.push({ ...b, id: `${sid}-e${i}`, ts: t0 + 11 + i * 2, kind: "tool.end", payload: { tool: x.tool, toolUseId: `u${i}`, ok: true, output: x.output } });
    });
    list.push({ ...b, id: `${sid}-end`, ts: t0 + 1000, kind: "session.end", payload: {} });
    await ctx.index.putEvents(list);
    await ctx.index.upsertSession(buildSession(list));
  };
  const body = Array.from({ length: 150 }, (_, l) => `export const v${l} = ${l * 7919};`).join("\n") + "\n";
  await put("rv-small", "claude-code", [
    { tool: "Write", input: { file_path: "src/a.ts", content: "short\n" } },
    { tool: "Edit", input: { file_path: "src/a.ts", old_string: "short\n", new_string: body.slice(0, 1900) } },
  ]);
  const edits = Array.from({ length: 60 }, (_, i) => ({ old_string: `old${i} `.padEnd(500, "o"), new_string: `new${i} `.padEnd(500, "n") }));
  await put("rv-multi", "claude-code", [{ tool: "MultiEdit", input: { file_path: "src/b.ts", edits } }]);
  const patch = "*** Begin Patch\n" + Array.from({ length: 500 }, (_, i) => `*** Add File: src/generated/models/entity-${String(i).padStart(4, "0")}.generated.ts\n+export const x = ${i};\n`).join("") + "*** End Patch\n";
  await put("rv-patch", "codex", [{ tool: "apply_patch", input: { input: patch }, output: "Done" }]);
  await put("rv-grow", "claude-code", [
    { tool: "Write", input: { file_path: "src/d.ts", content: "x".repeat(20000) } },
    ...Array.from({ length: 40 }, (_, k) => ({ tool: "Grep", input: { pattern: "x" }, output: "y".repeat(7700 + k * 20) })),
  ]);
  await put("rv-big", "claude-code", Array.from({ length: 6 }, (_, i) => ({ tool: "Write", input: { file_path: `src/big${i}.ts`, content: Array.from({ length: 1500 }, (_, l) => `export const v${i}_${l} = ${l * 7919 + i};`).join("\n") + "\n" } })));
  await ctx.close();
  c = new RawClient(w.env, w.repo);
  await c.initialize();
});

after(async () => {
  await c?.close();
  cleanup();
});

describe("session_replay under the 25,000-character limit", () => {
  it("pages the step list, with its files, once each", async () => {
    const all = await pages({});
    const steps = all.flatMap((p) => (p.steps as { n: number }[]).map((s) => String(s.n)));
    const first = all[0]!;
    once(steps, first.total, "steps");
    once(all.flatMap((p) => p.files as string[]), FILES, "files");
    assert.ok(all.length > 1, "a long list takes more than one page");
  });

  it("keeps a step, and a step with a file, under the limit and pages its tree", async () => {
    const total = (await call({})).sc.total as number;
    assert.equal(total, FILES + 1, "a prompt, then one step per file");
    const step = (await pages({ step: 5 }))[0]!;
    assert.ok(step.step, "the step is there");
    const last = await pages({ step: total, file: path(FILES - 1) });
    assert.ok(last[0]!.file, "the first page has the file");
    assert.equal(last[0]!.file.path, path(FILES - 1));
    assert.equal(last[1]?.file, undefined, "later pages hold only the next files");
    once(last.flatMap((p) => (p.tree as { path: string }[]).map((t) => t.path)), FILES, "tree");
    for (const p of last) assert.equal(p.treeTotal, FILES);
    assert.ok(last[0]!.file.content.length > 1000, "the file keeps a useful start");
    assert.equal(last[0]!.truncated, undefined, "nothing was cut: whole rows fit");
    const shrunk = await pages({ step: total, file: path(FILES - 1), limit: 1000 });
    assert.ok(shrunk[0]!.limitUsed > 0 && shrunk[0]!.limitUsed < 1000, "a page with fewer rows than asked says limitUsed");
    once(shrunk.flatMap((p) => (p.tree as { path: string }[]).map((t) => t.path)), FILES, "tree, limit 1000");
  });

  it("keeps ranges under the limit and reaches every changed file once", async () => {
    const few = await pages({ from: 1, to: 20 });
    once(few.flatMap((p) => (p.files as { path: string }[]).map((f) => f.path)), 19, "files of steps 1..20 (step 1 is the prompt)");
    const wide = await pages({ from: 1, to: FILES + 1 });
    once(wide.flatMap((p) => (p.files as { path: string }[]).map((f) => f.path)), FILES, "files of 1..300");
    assert.ok(wide.every((p) => p.filesTotal === FILES));
    assert.ok(wide.length > 1 && wide[0]!.limitUsed > 0, "whole diffs, fewer per page");
    assert.equal(wide[0]!.truncated, undefined);
  });

  it("returns each 50 KB file's diff as the replay recorded it (16 KB, flagged), one per page", async () => {
    const all = await pages({ from: 1, to: 7 }, "rv-big");
    once(all.flatMap((p) => (p.files as { path: string }[]).map((f) => f.path)), 6, "big files");
    for (const p of all) {
      assert.equal(p.files[0].diffTruncated, true, "the replay's own 16 KB cap is flagged");
      assert.ok(p.files[0].diff.length > 15_000, `a diff is ${p.files[0].diff.length} characters`);
    }
  });
});

describe("session_replay cuts only what does not fit", () => {
  it("cuts many small strings in one step (a MultiEdit of 60 edits), whatever the limit", async () => {
    for (const limit of [undefined, 1]) {
      const { sc, len } = await call({ step: 2, limit }, "rv-multi");
      assert.ok(len <= CHARACTER_LIMIT, `limit ${String(limit)}: ${len} characters`);
      assert.equal(sc.truncated, true);
      assert.match(sc.note, /cut/);
      assert.equal(sc.detail.inputTruncated, true, "the cut input is flagged on detail");
      assert.equal(sc.detail.input.editsTotal, undefined, "nothing is written inside the recorded input");
      assert.equal(sc.detail.input.editsTruncated, undefined);
      assert.ok(sc.detail.input.edits.length >= 1, "at least one edit stays");
    }
  });

  it("caps a step's own file list, in the step and in the step list", async () => {
    for (const limit of [undefined, 1]) {
      const { sc, len } = await call({ step: 2, limit }, "rv-patch");
      assert.ok(len <= CHARACTER_LIMIT, `step, limit ${String(limit)}: ${len} characters`);
      assert.equal(sc.step.filesTruncated, true);
      assert.equal(sc.step.filesTotal, 500);
      assert.ok(sc.step.files.length < 500);
    }
    const rows: { files?: unknown[]; filesTotal?: number }[] = [];
    for (const p of await pages({}, "rv-patch")) rows.push(...p.steps);
    const row = rows.find((x) => x.filesTotal === 500);
    assert.ok(row && row.files!.length < 500, "a step's file list in the step list is capped, with its total");
  });

  it("stays under the limit, note included, for a step whose content and output are near it", async () => {
    let cut = 0;
    for (let k = 0; k < 40; k++) {
      const { sc, len } = await call({ step: 3 + k, file: "src/d.ts" }, "rv-grow");
      assert.ok(len <= CHARACTER_LIMIT, `step ${3 + k}: ${len} characters`);
      if (sc.truncated) {
        cut++;
        assert.match(sc.note, /cut/);
      } else assert.equal(sc.note, undefined, "no note when this answer cut nothing");
    }
    assert.ok(cut > 0, "some step needed a cut");
  });

  it("does not cut a small diff at the default limit, nor add a note", async () => {
    const { sc } = await call({ step: 3 }, "rv-small");
    assert.equal(sc.changes[0].diff.length > 1900, true, `the whole diff (${sc.changes[0].diff.length})`);
    assert.equal(sc.changes[0].diffTruncated, undefined);
    assert.equal(sc.truncated, undefined);
    assert.equal(sc.note, undefined);
    const range = await call({ from: 3, to: 3 }, "rv-small");
    assert.equal(range.sc.files[0].diffTruncated, undefined);
  });
});
