// `show` prints the tail of a failed tool call's output under its line, not just "failed".
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as show from "../../src/cli/commands/show.ts";
import { failedTail } from "../../src/cli/commands/show.ts";
import type { AgentEvent } from "../../src/core/types.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const ID = "5c1d0e2f-aaaa-4bbb-8ccc-123456789012";
let sb: Sandbox;
before(async () => {
  sb = sandbox();
  const s = mkSession(ID, 1_700_000_000_000, { stats: { toolCalls: 3, toolErrors: 2 } });
  // A long failed output, stored as a cut preview with the whole text in a blob (as clipText does).
  const long = `${Array.from({ length: 400 }, (_, i) => `build step ${i} ok`).join("\n")}\nTypeError: x is not a function\nnpm ERR! code 2\n`;
  const blobs = new FsBlobStore(join(sb.env.CODING_SH_HOME!, "blobs"));
  const raw = await blobs.put(JSON.stringify({ tool_response: "raw hook payload" }));
  const ref = await blobs.put(long);
  await blobs.close();
  const ev = (id: string, kind: string, payload: Record<string, unknown>, ts: number): AgentEvent => ({ id, v: 1, sessionId: ID, ts, agent: "claude-code", kind, payload }) as unknown as AgentEvent; // slop-allow chained-as: events with only the fields show reads
  await sb.seed(
    [s],
    [
      ev("e1", "tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }, s.startedAt + 100),
      ev("e2", "tool.end", { tool: "Bash", toolUseId: "t1", ok: false, output: "line one\nFAIL src/a.test.ts\nExpected 2, got 3\nnpm ERR! code 1\n" }, s.startedAt + 200),
      ev("e3", "tool.start", { tool: "Bash", toolUseId: "t2", input: { command: "ls" } }, s.startedAt + 300),
      ev("e4", "tool.end", { tool: "Bash", toolUseId: "t2", ok: true, output: "a\nb\n" }, s.startedAt + 400),
      ev("e5", "tool.start", { tool: "Bash", toolUseId: "t3", input: { command: "npm run build" } }, s.startedAt + 500),
      { ...ev("e6", "tool.end", { tool: "Bash", toolUseId: "t3", ok: false, output: `${long.slice(0, 2000)}…` }, s.startedAt + 600), blobs: [raw, ref] },
    ],
  );
});
after(() => sb.cleanup());

test("a failed call shows the last lines of its output; an ok call shows none", async () => {
  const r = await runCmd(show, sb, { positionals: [ID], flags: { events: true } });
  assert.match(r.stdout, /npm test .*failed/);
  assert.match(r.stdout, /Expected 2, got 3\n/);
  assert.match(r.stdout, /npm ERR! code 1/);
  assert.doesNotMatch(r.stdout, /line one/);
  assert.doesNotMatch(r.stdout, /\n\s+a\n/);
});

test("a failed call whose stored output was cut shows the end of the full output, not of the preview", async () => {
  const r = await runCmd(show, sb, { positionals: [ID], flags: { events: true } });
  assert.match(r.stdout, /npm run build .*failed/);
  assert.match(r.stdout, /TypeError: x is not a function/);
  assert.match(r.stdout, /npm ERR! code 2/);
  assert.doesNotMatch(r.stdout, /raw hook payload/);
});

test("failedTail ignores output that is not text", () => {
  assert.equal(failedTail(undefined), "");
  assert.equal(failedTail({ x: 1 }), "");
  assert.equal(failedTail("\n\n"), "");
});
