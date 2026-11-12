// session_replay stays under the 25,000-character limit in every view, with a session that touched
// 300 files of about 50 KB each: the step list, a step, a step with a file, and ranges. Pages by
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

async function call(args: Record<string, unknown>): Promise<{ sc: Sc; len: number }> {
  const r = await c.call("session_replay", { sessionId: ID, ...args });
  assert.notEqual(r.isError, true, r.content[0]?.text.slice(0, 300));
  return { sc: r.structuredContent as Sc, len: r.content[0]!.text.length };
}

/** Every page of a view, following nextCursor. Each page is checked against the limit. */
async function pages(args: Record<string, unknown>): Promise<Sc[]> {
  const out: Sc[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 400; i++) {
    const next = { ...args };
    if (cursor) next.cursor = cursor;
    const { sc, len } = await call(next);
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
    // About 50 KB of distinct lines per file.
    const content = Array.from({ length: 1500 }, (_, l) => `export const v${i}_${l} = ${l * 7919 + i};`).join("\n") + "\n";
    evs.push({ ...base, id: `f-s${i}`, ts: t0 + 10 + i * 10, kind: "tool.start", payload: { tool: "Write", toolUseId: `w${i}`, input: { file_path: path(i), content } } });
    evs.push({ ...base, id: `f-e${i}`, ts: t0 + 15 + i * 10, kind: "tool.end", payload: { tool: "Write", toolUseId: `w${i}`, ok: true }, durationMs: 5 });
    evs.push({ ...base, id: `f-c${i}`, ts: t0 + 16 + i * 10, kind: "file.change", payload: { path: path(i), op: "add" } });
  }
  evs.push({ ...base, id: "f-end", ts: t0 + 20 * FILES, kind: "session.end", payload: {} });
  await ctx.index.putEvents(evs);
  await ctx.index.upsertSession(buildSession(evs));
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
    assert.equal(last[0]!.truncated, true, "cut text is reported");
    assert.equal(last[0]!.file.contentTruncated, true);
  });

  it("keeps ranges under the limit and reaches every changed file once", async () => {
    const few = await pages({ from: 1, to: 20 });
    once(few.flatMap((p) => (p.files as { path: string }[]).map((f) => f.path)), 19, "files of steps 1..20 (step 1 is the prompt)");
    const wide = await pages({ from: 1, to: FILES + 1 });
    once(wide.flatMap((p) => (p.files as { path: string }[]).map((f) => f.path)), FILES, "files of 1..300");
    assert.ok(wide.every((p) => p.filesTotal === FILES));
    assert.ok(wide[0]!.truncated === true && wide[0]!.files[0].diffTruncated === true, "cut diffs are flagged");
    assert.ok(wide[0]!.files[0].diff.length > 100, "a diff keeps its start");
  });

  it("gives one file's diff more room with limit 1", async () => {
    const one = await call({ from: 1, to: FILES + 1, limit: 1 });
    assert.ok(one.len <= CHARACTER_LIMIT);
    assert.ok(one.sc.files[0].diff.length > 10_000, `a lone diff is ${one.sc.files[0].diff.length} characters`);
    assert.equal(one.sc.nextCursor, "1");
  });
});
