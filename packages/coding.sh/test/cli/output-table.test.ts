// Tables on a narrow terminal keep every id whole; a width of 0 means unknown (120).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Output } from "../../src/cli/output.ts";

const ID = "36d2966a-1c53-47f1-891d-aae1827d0e95";
const TITLE = "Refactor the session list so that a very long title cannot push the id off the line";

function render(columns: number, rows: string[][] = [[ID, "claude-code", "5m ago", TITLE]]): string[] {
  let text = "";
  const out = new Output({ env: { NO_COLOR: "1" }, stdout: { write: (s: string) => ((text += s), true), isTTY: true, columns }, stderr: { write: () => true, isTTY: false } });
  out.table(["ID", "AGENT", "STARTED", "TITLE"], rows);
  return text.trimEnd().split("\n");
}

describe("table on a TTY", () => {
  test("columns=80 keeps a 36-character id whole and shrinks the title", () => {
    const lines = render(80);
    assert.ok(lines[1]!.startsWith(ID), lines[1]);
    assert.ok(lines[1]!.endsWith("…"), "the title is cut");
    assert.ok(lines[1]!.length <= 80, `${lines[1]!.length} wide`);
  });
  test("columns=0 means unknown: 120", () => {
    const lines = render(0);
    assert.ok(lines[1]!.startsWith(ID));
    assert.ok(lines[1]!.length <= 120 && lines[1]!.length > 80, `${lines[1]!.length} wide`);
    assert.ok(lines[1]!.includes("Refactor the session list"), "a 120-wide line holds most of the title");
  });
  test("a terminal narrower than the id still prints it whole", () => {
    assert.ok(render(20)[1]!.startsWith(ID));
  });
  test("an 80-column sessions table leaves the title out before it cuts AGENT or STARTED, and never wraps", () => {
    let text = "";
    const out = new Output({ env: { NO_COLOR: "1" }, stdout: { write: (s: string) => ((text += s), true), isTTY: true, columns: 80 }, stderr: { write: () => true, isTTY: false } });
    out.table(["ID", "AGENT", "STARTED", "DURATION", "TURNS", "TOOLS", "TITLE"], [[ID, "claude-code", "Nov 9 06:12", "12m", "4", "18", TITLE]]);
    const lines = text.trimEnd().split("\n");
    for (const l of lines) assert.ok(l.length <= 80, `${l.length} wide: ${l}`);
    assert.match(lines[1]!, new RegExp(`^${ID}  claude-code  Nov 9 06:12 `));
    assert.doesNotMatch(lines[0]!, /TITLE/);
  });
  test("a wide character takes two cells: the next column stays aligned", () => {
    let text = "";
    const out = new Output({ env: { NO_COLOR: "1" }, stdout: { write: (s: string) => ((text += s), true), isTTY: true, columns: 120 }, stderr: { write: () => true, isTTY: false } });
    out.table(["NAME", "STATUS"], [["名前", "ok"], ["abcd", "ok"]]);
    const [, a, b] = text.trimEnd().split("\n");
    assert.equal(a, "名前  ok");
    assert.equal(b, "abcd  ok");
  });
  test("a keep list names other columns that must not shrink", () => {
    let text = "";
    const out = new Output({ env: { NO_COLOR: "1" }, stdout: { write: (s: string) => ((text += s), true), isTTY: true, columns: 60 }, stderr: { write: () => true, isTTY: false } });
    out.table(["NAME", "NOTES"], [["a-name-that-is-quite-long-indeed", "x".repeat(80)]], { keep: ["NAME"] });
    assert.ok(text.includes("a-name-that-is-quite-long-indeed"));
  });
});
