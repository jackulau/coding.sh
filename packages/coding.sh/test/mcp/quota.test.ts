// The MCP status tool carries plan usage (quota), the same object `coding.sh quota --json` prints.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createCodingShMcp } from "../../src/mcp/server.ts";
import { schemaViolations } from "../../src/toolevals/jsonschema.ts";
import { cleanup, makeWorld } from "./helpers.ts";

after(cleanup);

describe("status tool quota", () => {
  it("lists each agent's windows and how to get a missing one", async () => {
    const w = makeWorld();
    const env: Record<string, string> = { ...w.env, CODEX_HOME: join(w.root, "codex"), CLAUDE_CONFIG_DIR: join(w.root, "claude") };
    writeFileSync(join(w.env.CODING_SH_HOME!, "quota.json"), JSON.stringify({ agent: "claude-code", readAt: w.now - 60_000, windows: [{ window: "5h", usedPercent: 62, resetsAt: 4_000_000_000_000 }, { window: "7d", usedPercent: 41 }] }));
    const mcp = createCodingShMcp({ env, cwd: w.root, log: () => {}, now: () => w.now });
    try {
      const list = await mcp.server.handle({ jsonrpc: "2.0", id: 0, method: "tools/list" });
      const tool = (list!.result as { tools: { name: string; outputSchema: Record<string, unknown> }[] }).tools.find((t) => t.name === "status")!;
      const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } });
      const res = r!.result as { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] };
      assert.notEqual(res.isError, true, res.content?.[0]?.text);
      const sc = JSON.parse(JSON.stringify(res.structuredContent)) as { quota: { windows: Record<string, unknown>[]; missing: { agent: string; how: string }[] } };
      assert.deepEqual(schemaViolations(sc, tool.outputSchema), []);
      assert.deepEqual(sc.quota.windows, [
        { agent: "claude-code", window: "5h", usedPercent: 62, resetsAt: new Date(4_000_000_000_000).toISOString(), reset: false, readAt: new Date(w.now - 60_000).toISOString(), ageSeconds: 60 },
        { agent: "claude-code", window: "7d", usedPercent: 41, reset: false, readAt: new Date(w.now - 60_000).toISOString(), ageSeconds: 60 },
      ]);
      assert.deepEqual(sc.quota.missing.map((m) => m.agent), ["codex"]);
    } finally {
      await mcp.close();
    }
  });
});
