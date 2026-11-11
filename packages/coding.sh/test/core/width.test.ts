// Terminal cell widths for CLI tables: a CJK character takes two cells, so the
// columns after it stay aligned (eval run, exp show and every out.table).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cutToWidth, padToWidth, textWidth } from "../../src/core/width.ts";
import { table, truncate } from "../../src/experiments/text.ts";

describe("cell width", () => {
  it("counts wide characters as two cells and marks and colors as none", () => {
    assert.equal(textWidth("名前"), 4);
    assert.equal(textWidth("abc"), 3);
    assert.equal(textWidth("é"), 1);
    assert.equal(textWidth("\u001b[31mred\u001b[0m"), 3);
    assert.equal(textWidth("🚀"), 2);
  });

  it("cuts and pads by cells", () => {
    assert.equal(cutToWidth("名前名前", 5), "名前…");
    assert.equal(textWidth(cutToWidth("名前名前", 5)), 5);
    assert.equal(padToWidth("名前", 6), "名前  ");
    assert.equal(truncate("名前名前名前", 7), "名前名…");
  });

  it("an experiments table keeps the column after a CJK cell aligned", () => {
    const text = table([{ header: "case" }, { header: "result" }], [["名前", "pass"], ["name", "fail"]], { color: false });
    const [, , a, b] = text.split("\n");
    assert.equal(textWidth(a!.slice(0, a!.indexOf("pass"))), textWidth(b!.slice(0, b!.indexOf("fail"))));
  });
});
