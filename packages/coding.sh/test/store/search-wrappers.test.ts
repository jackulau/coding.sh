// A Codex code-mode cell (`exec`) is a wrapper: its script holds the commands of the calls it
// makes and its output repeats theirs, while each call has its own tool.start and tool.end.
// Search lists such a match once, from the call, and still finds what only the wrapper says.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { IndexStore } from "../../src/core/types.ts";
import { parseWhere } from "../../src/query/where.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { event } from "../query/_seed.ts";

/** A cell (call_<n>) that runs one shell command (exec-<n>), as the Codex adapter records it. */
function cell(n: number, at: number, command: string, output: string, printed: string): AgentEvent[] {
  const start = `s1-cell${n}`;
  const call = { kind: "tool.start" as const, agent: "codex" as const };
  return [
    event("s1", at, { ...call, id: start, payload: { tool: "exec", toolUseId: `call_${n}`, input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(r);`, wrapper: true } }),
    event("s1", at + 1, { ...call, id: `s1-bash${n}`, parentId: start, payload: { tool: "Bash", toolUseId: `exec-${n}`, input: { command } } }),
    event("s1", at + 2, { kind: "tool.end", agent: "codex", id: `s1-bash${n}-end`, parentId: start, payload: { tool: "Bash", toolUseId: `exec-${n}`, ok: true, output } }),
    event("s1", at + 3, {
      kind: "tool.end",
      agent: "codex",
      id: `s1-cell${n}-end`,
      payload: { tool: "exec", toolUseId: `call_${n}`, ok: true, wrapper: true, output: `Script completed\nOutput:\n\n${JSON.stringify({ chunk_id: "ab12", exit_code: 0, original_token_count: 12, output })}${printed}` },
    }),
  ];
}

describe("search lists a code-mode cell's call once", () => {
  let sqlite: SqliteIndexStore;
  const memory = new MemoryIndexStore();
  before(async () => {
    sqlite = await SqliteIndexStore.open(":memory:");
    for (const st of [sqlite, memory] as IndexStore[]) {
      await st.putEvents([
        ...cell(1, 10, "rg -n narwhal AGENTS.md", "AGENTS.md:339:## Narwhal material discovery", ""),
        ...cell(2, 20, "rg -n narwhal tools", "tools/narwhal_operator.py:57: def login", "\nsummary: walrus"),
        event("s1", 30, { id: "s1-msg", agent: "codex", kind: "assistant.message", payload: { text: "The narwhal tools are in tools/" } }),
      ]);
    }
  });
  after(() => sqlite?.close());

  for (const [name, st] of [["sqlite", () => sqlite], ["memory", () => memory]] as const) {
    test(`${name}: the call's command and output are listed, not the cell's copy of them`, async () => {
      const ids = (await st().search("narwhal")).map((h) => h.event.id).sort();
      assert.deepEqual(ids, ["s1-bash1", "s1-bash1-end", "s1-bash2", "s1-bash2-end", "s1-msg"]);
    });

    test(`${name}: a page of hits is filled with distinct ones`, async () => {
      const hits = await st().search("narwhal", { limit: 5 });
      assert.equal(hits.length, 5);
      assert.ok(!hits.some((h) => h.event.payload.wrapper), hits.map((h) => h.event.id).join(" "));
    });

    test(`${name}: what only the cell says is still found on the cell`, async () => {
      assert.deepEqual((await st().search("walrus")).map((h) => h.event.id), ["s1-cell2-end"]);
      assert.deepEqual((await st().search("tools exec_command")).map((h) => h.event.id).sort(), ["s1-cell1", "s1-cell2"]);
    });
  }

  test("sqlite: a filter the call does not pass keeps the cell's match", async () => {
    const hits = await sqlite.searchWhere("narwhal", parseWhere("tool:exec"));
    assert.deepEqual(hits.map((h) => h.event.id).sort(), ["s1-cell1", "s1-cell1-end", "s1-cell2", "s1-cell2-end"]);
  });

  test("sqlite: a match past the rank cap is listed once too", async () => {
    const capped = await SqliteIndexStore.open(":memory:", { searchRankMaxMatches: 2 });
    try {
      await capped.putEvents([...cell(1, 10, "rg -n narwhal AGENTS.md", "AGENTS.md:339:## Narwhal material discovery", ""), ...cell(2, 20, "rg -n narwhal tools", "tools/narwhal_operator.py:57: def login", "")]);
      const hits = await capped.search("narwhal", { limit: 3 });
      assert.deepEqual(hits.map((h) => h.event.id), ["s1-bash2-end", "s1-bash2", "s1-bash1-end"], "newest first, the cell's events left out");
    } finally {
      await capped.close();
    }
  });
});
