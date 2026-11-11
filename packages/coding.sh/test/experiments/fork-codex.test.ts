// A fork of a Codex call that adds AGENTS.md puts it the way Codex does: its
// own "# AGENTS.md instructions for <dir>" block in a user message before the
// prompt, not a Claude Code "Contents of" reminder.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestContextTexts, rewriteHarness } from "../../src/experiments/fork.ts";

type Item = { type?: string; role: string; content: { type: string; text: string }[] };

describe("rewriteHarness on a Codex request", () => {
  it("adds AGENTS.md as Codex's own block, which reads back as AGENTS.md", () => {
    const body = { input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex." }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] }] };
    const { body: out, edits } = rewriteHarness("responses", body, { files: [{ path: "AGENTS.md", text: "Run node --test before you say you are done.\n" }], remove: [] }, "/work/demo");
    assert.deepEqual(edits, [{ path: "AGENTS.md", how: "added" }]);
    const input = out.input as Item[];
    assert.equal(input.length, 3);
    assert.equal(input[1]!.role, "user");
    assert.equal(input[1]!.content[0]!.text, "# AGENTS.md instructions for /work/demo\n\n<INSTRUCTIONS>\nRun node --test before you say you are done.\n</INSTRUCTIONS>");
    assert.ok(!JSON.stringify(out).includes("Contents of"), "no Claude Code shape");
    assert.ok(!JSON.stringify(out).includes("claudeMd"));
    assert.equal(input[2]!.content[0]!.text, "fix it");
    assert.deepEqual(requestContextTexts("responses", out, "/work/demo"), [{ path: "AGENTS.md", text: "Run node --test before you say you are done." }]);
  });

  it("a Claude Code request still gets the Contents of shape", () => {
    const { body: out } = rewriteHarness("messages", { messages: [{ role: "user", content: "fix it" }] }, { files: [{ path: "AGENTS.md", text: "Use pnpm." }], remove: [] }, "/work/demo");
    assert.match((out.messages as { content: string }[])[0]!.content, /Contents of \/work\/demo\/AGENTS\.md \(project instructions/);
  });
});
