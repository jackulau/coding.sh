// Unit tests for CLI formatting and message helpers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockingNotes, setupSummary } from "../../src/cli/commands/init.ts";
import { checkFailed } from "../../src/cli/commands/update.ts";
import { duration, formatLabel, LABEL_WIDTH } from "../../src/cli/output.ts";
import type { UpdateCache } from "../../src/update/index.ts";

describe("duration", () => {
  it("carries rounding into the next unit instead of printing 60s or 1000ms", () => {
    assert.deepEqual([119600, 59700, 999.6, 3599700, 7199999].map(duration), ["2m00s", "1m00s", "1.0s", "1h00m", "2h00m"]);
    assert.deepEqual([9960, 9940, 59400, 89_000].map(duration), ["10s", "9.9s", "59s", "1m29s"]);
  });

  it("keeps the usual shapes", () => {
    assert.deepEqual([0, 850, 4200, 42_000, 187_000, 7_500_000, undefined, NaN].map(duration), ["0ms", "850ms", "4.2s", "42s", "3m07s", "2h05m", "-", "-"]);
  });
});

describe("formatLabel", () => {
  it("marks a cut label with an ellipsis and keeps the column width", () => {
    const l = formatLabel("Any command (coding.sh run --)");
    assert.equal(l.length, LABEL_WIDTH);
    assert.match(l, /… $/);
    assert.equal(formatLabel("Claude Code"), "Claude Code".padEnd(LABEL_WIDTH));
  });
});

describe("init summary", () => {
  it("groups agents by what they actually got", () => {
    assert.equal(setupSummary([{ name: "A", mcp: true }, { name: "B", mcp: true }, { name: "C", mcp: false }]), "A and B (hooks + MCP server); C (hooks)");
    assert.equal(setupSummary([{ name: "C", mcp: false }]), "C (hooks)");
    assert.equal(setupSummary([]), "");
  });

  it("keeps only the detect notes that block capture", () => {
    const notes = [
      "cursor-agent 2025.09.18 predates CLI hooks; run `cursor-agent update` (hooks need 2026.01+)",
      "cursor-agent -p does not fire beforeSubmitPrompt/afterAgentResponse/stop; prompts and final text are missing from headless runs",
      "hooks are disabled in config.toml ([features] hooks = false); coding.sh hooks will not run",
      "2 coding.sh hook(s) not trusted yet (Stop). Codex runs new or changed hooks only after you trust them",
      "No tool output reaches hooks; run `coding.sh backfill antigravity` for transcripts.",
    ];
    assert.deepEqual(blockingNotes(notes), [notes[0], notes[2], notes[3]]);
    assert.deepEqual(blockingNotes(undefined), []);
  });
});

describe("update check failures", () => {
  const cache = (extra: Record<string, unknown>) => ({ error: "GitHub: x; npm: y", ...extra }) as UpdateCache;

  it("a 404 from every source is no published release, not a connection problem", () => {
    const e = checkFailed(cache({ errorKind: "no_release" }), "0.0.1");
    assert.equal(e.reason, "no_release");
    assert.match(e.message, /No coding\.sh release has been published yet/);
    assert.ok(!e.next.some((n) => /connection/i.test(n)));
    assert.ok(e.next.includes("https://github.com/jackulau/coding.sh/releases"));
  });

  it("only a network failure blames the connection", () => {
    assert.match(checkFailed(cache({ errorKind: "network" }), "0.0.1").next[0]!, /Check your connection/);
    const bad = checkFailed(cache({ errorKind: "bad_response" }), "0.0.1");
    assert.equal(bad.reason, "update_check_failed");
    assert.doesNotMatch(bad.next.join(" "), /connection/i);
  });
});
