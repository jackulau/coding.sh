// Which tools' durations are waiting (on the user, a subagent, a timer) rather than tool latency.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { waitKind } from "../../src/core/wait-tools.ts";
import { waitKind as mcpWaitKind } from "../../src/mcp/data.ts";

describe("waitKind", () => {
  it("counts T3 Code's request_secret card as waiting on the user, with or without its MCP prefix", () => {
    assert.equal(waitKind("mcp__t3-code__request_secret"), "human");
    assert.equal(waitKind("request_secret"), "human");
    assert.equal(mcpWaitKind("mcp__t3-code__request_secret"), "human", "the latency tool reads the same table");
  });

  it("keeps the existing user, subagent and wait tools", () => {
    assert.equal(waitKind("AskUserQuestion"), "human");
    assert.equal(waitKind("mcp__codex__request_user_input"), "human");
    assert.equal(waitKind("Agent"), "subagent");
    assert.equal(waitKind("Monitor"), "wait");
  });

  it("leaves real tools out", () => {
    for (const t of ["WebFetch", "Bash", "mcp__t3-code__t3_thread_read", "mcp__x__request_secrets_audit"]) assert.equal(waitKind(t), undefined, t);
  });
});
