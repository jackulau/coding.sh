// Viewer fixes from hands-on QA (round 8) without a browser: the Work page's next step for a failed
// subagent resumes the session that ran it, never coding.sh's own `<session>:sub:<agent>` id.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { FLAGS } from "../../src/core/sessions.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { workList } from "../../src/viewer/work.ts";
import { session } from "./fakes.ts";

const now = Date.UTC(2026, 10, 7, 12);
const ROOT = "07ea0cbb-a16b-445d-84d4-ff2fc6bdf8df";
let dir: string;
let index: MemoryIndexStore;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "qa8w-"));
  index = new MemoryIndexStore();
  // As in a store whose parent transcript is not read: the subagent's item is its own.
  await index.upsertSession(session(`${ROOT}:sub:a1d4c32c15a2744a7`, {
    startedAt: now - 3_000_000, endedAt: now - 2_400_000, cwd: "/work/demo", title: "lane A",
    parent: { sessionId: ROOT, type: "general-purpose" } as any,
    flags: [FLAGS.apiStall], stats: { events: 4, turns: 1, toolCalls: 2, toolErrors: 0, filesChanged: 0, llmErrors: { count: 3, statusCode: 529 } } as any,
  }));
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test("a failed subagent's next step resumes the session that ran it", async () => {
  const doc = await workList(index, { overlay: join(dir, "work.json"), now: () => now }, new URLSearchParams("all=1")) as { items: { next: string; reason: string }[] };
  const failed = doc.items.find((i) => /^ended .* on /.test(i.reason));
  assert.ok(failed, `a failed item: ${JSON.stringify(doc.items.map((i) => i.reason))}`);
  assert.match(failed.next, new RegExp("`claude --resume " + ROOT + "`"));
  assert.doesNotMatch(failed.next, /--resume [^`]*:sub:/);
  // `coding.sh show` takes coding.sh's own id, so it keeps the subagent's.
  assert.match(failed.next, /`coding\.sh show [^`]+:sub:a1d4c32c15a2744a7`/);
});
