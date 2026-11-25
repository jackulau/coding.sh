// Doc lines that state what the code does: the MCP status tool's work-item count in the
// changelog, the parts of the status line in its how-to, file modes in the CLI reference, the
// scorecard's scope note and intervals in its how-to, its help and the changelog, and which
// pushback kind a prompt takes in the scorecard's how-to and the API reference.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { scopeNote } from "../../src/cli/commands/stats-scorecard.ts";
import { statuslineLine } from "../../src/cli/statusline.ts";
import { PUSHBACK_KINDS, pushbackKind } from "../../src/core/pushback.ts";

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

  it("the compare-models how-to shows the scope note the scorecard prints for its example", () => {
    const example = /## 1\. Print the scorecard[\s\S]*?```text\n([\s\S]*?)```/.exec(read("docs", "how-to", "compare-models.md"))?.[1];
    assert.ok(example, "found the example output");
    // The Turns row's sessions are the top-level sessions launched interactively. The window also has a subagent session and a headless one.
    const turns = /^Turns .*\n {2}sessions +(\d+) +(\d+)$/m.exec(example);
    assert.ok(turns, "found the Turns row's sessions");
    const turnSessions = Number(turns[1]) + Number(turns[2]);
    const note = scopeNote({ by: "model", sessions: turnSessions + 2, turnSessions, groups: [], turnsLeftOut: { subagent: 1, headless: 1 } });
    assert.ok(example.includes(`\n  ${note}\n`), `the example shows the note: ${note}`);
  });

  it("the scorecard's how-to, help and changelog line give the Turns row no interval", () => {
    assert.doesNotMatch(read("docs", "how-to", "compare-models.md"), /Every row shows its/);
    for (const doc of ["CHANGELOG.md", "docs/reference/cli.md"]) assert.doesNotMatch(read(doc), /--scorecard[^\n]*turns, [^\n]*each with its counts and a 95% interval/, doc);
  });

  it("the scorecard's how-to and the API reference say the order of the pushback kinds, not of the prompt, picks a prompt's kind", () => {
    // "try again" comes first in the prompt, but undo comes before redo in the order.
    assert.equal(pushbackKind("try again, and undo that"), "undo");
    assert.equal(pushbackKind(`${"x".repeat(390)} undo that`), "undo");
    assert.equal(pushbackKind(`${"x".repeat(391)} undo that`), undefined, "reads the first 400 characters");
    const claim = "A prompt takes the first of these kinds, in this order, that it matches in its first 400 characters";
    const row = read("docs", "reference", "api.md").split("\n").find((l) => l.startsWith("| `stats.turnsByModel.<model>.pushback` |"));
    assert.ok(row, "found the API reference row");
    const howTo = read("docs", "how-to", "compare-models.md").replace(/\s+/g, " ");
    for (const [doc, text, name] of [["docs/reference/api.md", row, (k: string) => `\`${k}\``], ["docs/how-to/compare-models.md", howTo, (k: string) => `| Pushback: ${k} |`]] as const) {
      assert.ok(text.includes(claim), `${doc} says: ${claim}`);
      const at = PUSHBACK_KINDS.map((k) => text.indexOf(name(k)));
      assert.ok(at.every((i) => i >= 0), `${doc} names every kind`);
      assert.deepEqual(at, [...at].sort((a, b) => a - b), `${doc} lists the kinds in the order the code tries them`);
    }
  });
});
