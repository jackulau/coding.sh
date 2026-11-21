// Viewer fixes from hands-on QA (round 5), run straight from the page's own script: a diff that ends
// with a newline shows no made-up blank line, a cut diff counts the changed lines it leaves out, and a
// Work card's next step and age read as the CLI's reason does (commands as code, one rounding rule).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");

function slice(from: string, to: string): string {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `markers ${from} .. ${to}`);
  return html.slice(a, b);
}

const src = [
  slice("function diffRows(", "function diffBlock("),
  slice("function diffLeftOut(", "/**\n * A file.change's diff."),
  slice("function workNextParts(", "function workHiddenReasons("),
].join("\n");
const f: any = runInNewContext(`${src}\n({ diffRows, diffLeftOut, workNextParts, workAge })`, { String, Math, Number, relPath: (s: string) => s });

// A new file's diff cut at a line break, as the adapters store it (core: clipDiff keeps whole lines).
const added = (n: number) => Array.from({ length: n }, (_, i) => `+line ${i + 1}\n`).join("");
const cut = "--- /dev/null\n+++ b/study.py\n@@ -0,0 +1,56 @@\n" + added(32);

test("a diff that ends with a newline has no blank context line after its last line", () => {
  const rows = f.diffRows(cut);
  assert.equal(rows.length, 3 + 32);
  assert.deepEqual({ ...rows[rows.length - 1] }, { t: "add", b: 32, text: "line 32" });
  assert.equal(rows.filter((r: { t: string }) => r.t === "ctx").length, 0);
  // A real empty context line in the middle stays.
  const mid = f.diffRows("@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n");
  assert.deepEqual([...mid.map((r: { t: string; text: string }) => r.t + ":" + r.text)], ["hunk:@@ -1,3 +1,3 @@", "ctx:a", "ctx:", "del:b", "add:c"]);
  // Without the ending newline nothing changes.
  assert.equal(f.diffRows(cut.slice(0, -1)).length, 3 + 32);
});

test("a cut diff counts the changed lines it leaves out", () => {
  assert.equal(f.diffLeftOut({ diff: cut, additions: 56, deletions: 0 }), 24);
  assert.equal(f.diffLeftOut({ diff: "@@ -1,2 +1,2 @@\n-a\n+b\n", additions: 3, deletions: 3 }), 4);
  assert.equal(f.diffLeftOut({ diff: cut }), null, "no counts, no number");
  assert.equal(f.diffLeftOut({ diff: cut, additions: 10 }), 0, "never below zero");
});

test("a Work item's next step shows its commands as code, without the backticks", () => {
  const plain = (parts: [boolean, string][]) => parts.map(([code, text]) => (code ? `<${text}>` : text)).join("");
  assert.equal(plain(f.workNextParts("`coding.sh show 689058c4`")), "<coding.sh show 689058c4>");
  assert.equal(plain(f.workNextParts("`coding.sh show a`, then `claude --resume a`")), "<coding.sh show a>, then <claude --resume a>");
  assert.equal(plain(f.workNextParts("review: `git -C /work/demo diff`, then `coding.sh work ack w1`")), "review: <git -C /work/demo diff>, then <coding.sh work ack w1>");
  assert.equal(plain(f.workNextParts("answer in claude-code in /work/demo")), "answer in claude-code in /work/demo");
  assert.equal(plain(f.workNextParts("an odd ` stays")), "an odd ` stays");
  assert.equal(f.workNextParts("").length, 0);
});

test("a Work card's age is floored like its reason's, so 1h53m reads 1h in both", () => {
  const m = 60e3, h = 60 * m;
  assert.equal(f.workAge(h + 53 * m), "1h");
  assert.equal(f.workAge(27e3), "27s");
  assert.equal(f.workAge(4 * m + 59e3), "4m");
  assert.equal(f.workAge(30 * h), "30h", "hours up to two days, as the reason gives them");
  assert.equal(f.workAge(3 * 24 * h + 5 * h), "3d");
  assert.equal(f.workAge(-5e3), "0s");
});
