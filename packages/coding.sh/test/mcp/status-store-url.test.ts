// The MCP status tool names the store the way `coding.sh status` does: a password in the store
// URL (CODING_SH_STORE_URL) is masked, and so is the URL in the error a store that fails to open
// gives. Its answers go into the agent's context and on to its model provider. memory:// ignores
// the rest of its URL, so a made-up password needs no server.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCodingShMcp } from "../../src/mcp/server.ts";
import { registerIndexStore } from "../../src/store/factory.ts";
import { cleanup, makeWorld, type World } from "./helpers.ts";

// Made up for this test.
const PASSWORD = ["pw", "status", "7731"].join("-");

let w: World;
before(() => {
  w = makeWorld();
});
after(() => cleanup());

async function callStatus(storeUrl: string): Promise<{ raw: string; isError?: boolean; text: string; structured?: Record<string, unknown> }> {
  const mcp = createCodingShMcp({ env: { ...w.env, CODING_SH_STORE_URL: storeUrl }, cwd: w.root, log: () => {}, now: () => w.now, autoIngest: async () => ({ pendingFiles: 0, indexing: false }) });
  try {
    const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: {} } });
    const res = r!.result as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
    return { raw: JSON.stringify(r), isError: res.isError, text: res.content[0]?.text ?? "", structured: res.structuredContent };
  } finally {
    await mcp.close();
  }
}

describe("a store URL with a password", () => {
  it("status answers with the masked URL, and the password is nowhere in the answer", async () => {
    const r = await callStatus(`memory://demo:${PASSWORD}@db.example.invalid/x`);
    assert.notEqual(r.isError, true, r.text);
    assert.equal(r.structured?.store, "memory://demo:***@db.example.invalid/x");
    assert.ok(!r.raw.includes(PASSWORD), `the password is in the answer: ${r.raw.slice(0, 300)}`);
  });

  it("the error of a store that can't open names the URL masked", async () => {
    registerIndexStore("statusfail", (url) => {
      throw new Error(`can't reach ${url}`);
    });
    const r = await callStatus(`statusfail://demo:${PASSWORD}@db.example.invalid/x`);
    assert.equal(r.isError, true);
    assert.match(r.text, /^Couldn't open the coding\.sh store: can't reach statusfail:\/\/demo:\*\*\*@db\.example\.invalid\/x\./);
    assert.ok(!r.raw.includes(PASSWORD), `the password is in the answer: ${r.raw.slice(0, 300)}`);
  });
});
