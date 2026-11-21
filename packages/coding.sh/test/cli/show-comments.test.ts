// `show` prints a session's comments (text scores named comment, which the viewer's comment box
// writes): the session's after its header, a step's under that step's line, and the rest, on steps
// the listing leaves out, at the end naming their step. --json carries them all as `comments`.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as show from "../../src/cli/commands/show.ts";
import { sessionComments } from "../../src/cli/commands/show.ts";
import type { AgentEvent, Score } from "../../src/core/types.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const ID = "c0mme47s-aaaa-4bbb-8ccc-123456789012";
const T0 = 1_700_000_000_000;
let sb: Sandbox;
const s = mkSession(ID, T0, { stats: { events: 5, toolCalls: 2 } });
const ev = (id: string, kind: string, payload: Record<string, unknown>, ts: number): AgentEvent => ({ id, v: 1, sessionId: ID, ts, agent: "claude-code", kind, payload }) as unknown as AgentEvent; // slop-allow chained-as: events with only the fields show reads
const comment = (id: string, target: "session" | "event", targetId: string, value: string, ts: number): Score => ({ id, target, targetId, sessionId: ID, name: "comment", dataType: "text", value, source: "human", by: "ana", ts });

before(async () => {
  sb = sandbox();
  await sb.seed(
    [s],
    [
      ev("e1", "user.message", { text: "fix the config loader" }, T0 + 100),
      ev("e2", "tool.start", { tool: "Edit", toolUseId: "t1", input: { file_path: "src/load.ts" } }, T0 + 200),
      ev("e3", "tool.end", { tool: "Edit", toolUseId: "t1", ok: true }, T0 + 300),
      ev("e4", "assistant.message", { text: "Done." }, T0 + 400),
      ev("e5", "user.message", { text: "now the tests" }, T0 + 500),
    ],
  );
  const index = await SqliteIndexStore.open(join(sb.env.CODING_SH_HOME!, "index.db"));
  await index.migrate();
  await index.putScore(comment("comment-b", "event", "e2", "wrong file", T0 + 2000));
  await index.putScore(comment("comment-a", "session", ID, "good run\noverall", T0 + 1000));
  await index.putScore(comment("comment-c", "event", "e5", "<b>not bold</b>", T0 + 3000));
  // Another score on the session is not a comment.
  await index.putScore({ ...comment("rating", "session", ID, "fine", T0 + 4000), name: "verdict", dataType: "categorical" });
  await index.close();
});
after(() => sb.cleanup());

test("show prints the session's comments after its header, and a tool call's comment under its line", async () => {
  const r = await runCmd(show, sb, { positionals: [ID] });
  assert.equal(r.error, undefined, String(r.error));
  const lines = r.stdout.split("\n");
  const head = lines.indexOf("Comments");
  assert.ok(head > 0, r.stdout);
  assert.match(lines[head + 1]!, /^  ana, .*: good run$/);
  assert.equal(lines[head + 2], "    overall");
  // The comment targets the call's start; the call prints as one line, at its end.
  const edit = lines.findIndex((l) => /tool\s+Edit/.test(l));
  assert.ok(edit > head, r.stdout);
  assert.match(lines[edit + 1]!, /^ {10}ana, .*: wrong file$/);
  const last = lines.findIndex((l) => /now the tests/.test(l));
  assert.match(lines[last + 1]!, /^ {10}ana, .*: <b>not bold<\/b>$/);
  assert.doesNotMatch(r.stdout, /fine/);
});

test("a comment on a step the listing leaves out prints at the end, naming its step", async () => {
  const r = await runCmd(show, sb, { positionals: [ID], flags: { limit: 3 } });
  assert.equal(r.error, undefined, String(r.error));
  const lines = r.stdout.split("\n");
  const at = lines.indexOf("Comments on steps");
  assert.ok(at > 0, r.stdout);
  assert.equal(lines[at + 1], "  on event e5");
  assert.match(lines[at + 2]!, /^ {4}ana, .*: <b>not bold<\/b>$/);
  assert.equal(lines.filter((l) => /wrong file/.test(l)).length, 1, "a placed comment is not printed again");
});

test("show --json lists the comments, oldest first", async () => {
  const r = await runCmd(show, sb, { positionals: [ID], json: true });
  assert.deepEqual(r.json.comments, [
    { id: "comment-a", target: "session", targetId: ID, text: "good run\noverall", by: "ana", ts: T0 + 1000 },
    { id: "comment-b", target: "event", targetId: "e2", text: "wrong file", by: "ana", ts: T0 + 2000 },
    { id: "comment-c", target: "event", targetId: "e5", text: "<b>not bold</b>", by: "ana", ts: T0 + 3000 },
  ]);
  const picked = await runCmd(show, sb, { positionals: [ID], json: true, flags: { fields: "comments" } });
  assert.deepEqual(Object.keys(picked.json), ["comments"]);
});

test("a store that keeps no scores has no comments, and show does not fail", async () => {
  const index = new MemoryIndexStore();
  Object.defineProperty(index, "listScores", { value: undefined });
  assert.deepEqual(await sessionComments(index, s), []);
});
