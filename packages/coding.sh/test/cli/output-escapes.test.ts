// Text the CLI prints can come from a captured session (a title, a line of code, a tool's output).
// Output strips terminal control sequences from it where it writes, so no command can print one.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UsageError } from "../../src/cli/args.ts";
import { CliError, forTerminal, Output } from "../../src/cli/output.ts";

// A title change (OSC 0), a hyperlink (OSC 8), a clear screen, a cursor move, a carriage return
// that overwrites the line, and a right-to-left override.
const HOSTILE = "a\u001b]0;pwned\u0007b\u001b]8;;https://x.test\u001b\\c\u001b[2Jd\u001b[1;1He\rf‮g\u009bh";

function capture(opts: { tty: boolean; color: boolean }) {
  let text = "";
  const env = opts.color ? { FORCE_COLOR: "1" } : { NO_COLOR: "1" };
  const out = new Output({ env, stdout: { write: (s: string) => ((text += s), true), isTTY: opts.tty, columns: 200 }, stderr: { write: () => true, isTTY: false } });
  return { out, text: () => text };
}

function controls(s: string): string[] {
  // Every control character left, except newline, tab and the color codes Output writes itself.
  // eslint-disable-next-line no-control-regex
  return [...s.replace(/\u001b\[(?:1|2|22|31|32|33|35|36|39)m/g, "").matchAll(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g)].map((m) => JSON.stringify(m[0]));
}

describe("Output strips terminal control sequences", () => {
  for (const tty of [false, true]) {
    for (const color of [false, true]) {
      const name = `${tty ? "a TTY" : "a pipe"}${color ? " with color" : ""}`;
      test(`print to ${name}`, () => {
        const c = capture({ tty, color });
        c.out.print(`line ${HOSTILE}`);
        c.out.print(c.out.style("bold", "bold") + " " + HOSTILE);
        assert.deepEqual(controls(c.text()), []);
        assert.match(c.text(), /line a/);
        assert.equal(c.text().split("\n").length, 3, "two lines and the final newline");
        if (color) assert.ok(c.text().includes("\u001b[1mbold\u001b[22m"), "Output's own color codes stay");
      });
      test(`table to ${name}`, () => {
        const c = capture({ tty, color });
        c.out.table(["ID", "TEXT"], [["s1", HOSTILE], ["s2", "plain"]]);
        assert.deepEqual(controls(c.text()), []);
        assert.match(c.text(), /s2/);
      });
    }
  }
  for (const color of [false, true]) {
    test(`stderr messages and errors${color ? " with color" : ""}`, () => {
      let text = "";
      const env = color ? { FORCE_COLOR: "1" } : { NO_COLOR: "1" };
      const out = new Output({ env, stdout: { write: () => true, isTTY: false }, stderr: { write: (s: string) => ((text += s), true), isTTY: false } });
      out.ok(`done ${HOSTILE}`);
      out.spin(`reading ${HOSTILE}`).stop();
      out.error(new CliError(`failed ${HOSTILE}`, { details: [["Title", HOSTILE]], next: [HOSTILE] }));
      out.error(new UsageError(`bad ${HOSTILE}`, { suggestion: HOSTILE }));
      out.error(new Error(HOSTILE));
      assert.deepEqual(controls(text), []);
      assert.match(text, /failed a/);
      assert.match(text, /Failed to complete: a/);
      if (color) assert.ok(text.includes("\u001b[31m"), "Output's own color codes stay");
    });
  }
  test("--json errors stay JSON, which escapes control characters", () => {
    let text = "";
    const out = new Output({ json: true, env: {}, stdout: { write: () => true }, stderr: { write: (s: string) => ((text += s), true) } });
    out.error(new CliError(HOSTILE));
    assert.equal(JSON.parse(text).message, HOSTILE);
  });
  test("CSV for a terminal drops them and keeps its CRLF row ends", () => {
    assert.equal(forTerminal(`id,text\r\ns1,${HOSTILE}\r\n`), "id,text\r\ns1,abcdefg\r\n");
    assert.deepEqual(controls(forTerminal(`s1,${HOSTILE}\r\n`).replace(/\r\n/g, "")), []);
  });
  test("newlines and tabs in printed text still print", () => {
    const c = capture({ tty: false, color: false });
    c.out.print("a\tb\nc");
    assert.equal(c.text(), "a\tb\nc\n");
  });
});
