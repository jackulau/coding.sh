// Doc lines that state what the code does: the MCP status tool's work-item count in the
// changelog, the parts of the status line in its how-to, and file modes in the CLI reference.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { statuslineLine } from "../../src/cli/statusline.ts";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = join(pkg, "..", "..");
const read = (...p: string[]) => readFileSync(join(repo, ...p), "utf8");

describe("doc claims", () => {
  it("the changelog gives the MCP status tool's work-item count as the code has it", () => {
    const rows = /export const STATUS_WORK_ROWS = (\d+);/.exec(readFileSync(join(pkg, "src", "mcp", "tools.ts"), "utf8"))?.[1];
    assert.ok(rows, "found STATUS_WORK_ROWS");
    const counts = [...read("CHANGELOG.md").matchAll(/`status`(?: tool)? lists the (?:first|top) (\d+)/g)].map((m) => m[1]);
    assert.ok(counts.length > 0, "the changelog states the count");
    assert.deepEqual(counts.filter((n) => n !== rows), [], `the MCP status tool lists ${rows} work items`);
  });

  it("the status-line how-to shows every part the line prints, in order", () => {
    const doc = read("docs", "how-to", "status-line.md");
    const line = statuslineLine({ model: "Opus 5.5", contextPercent: 62, sessionCostUsd: 0.0011, todayCostUsd: 0.2867, flags: ["no-verification"], needYou: 2 });
    assert.ok(doc.includes(line), `the how-to shows the full line: ${line}`);
    assert.match(doc, /`needYou`/, "the how-to names the --json field");
    assert.match(doc, /ingest stopped/, "the how-to names the stopped-ingest part");
  });

  it("the status-line how-to does not say unexpected input prints nothing", () => {
    const doc = read("docs", "how-to", "status-line.md");
    assert.doesNotMatch(doc, /input is unexpected it prints nothing/);
    assert.match(doc, /not a JSON object/);
  });

  it("the CLI reference qualifies mode 600 for systems without file modes", () => {
    const lines = read("docs", "reference", "cli.md").split("\n").filter((l) => l.includes("mode 600"));
    assert.ok(lines.length > 0, "the CLI reference mentions mode 600");
    assert.deepEqual(lines.filter((l) => !l.includes("mode 600 where the OS has file modes")), []);
  });
});
