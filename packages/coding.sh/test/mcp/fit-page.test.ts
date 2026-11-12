// fitPage: the largest page that fits CHARACTER_LIMIT, `limitUsed` only when it shrank, and a
// `truncated` page when the fixed part of the answer is the part that is too long.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHARACTER_LIMIT, fitPage } from "../../src/mcp/tools.ts";
import { toolText } from "../../src/mcp/protocol.ts";

type Obj = Record<string, unknown>;

/** A page of `n` rows of `rowLen` characters out of `total`, after `fixed` characters that are always there. */
const pager =
  (total: number, rowLen: number, fixed = 0, tail = false) =>
  (n: number): Obj => {
    const rows = Array.from({ length: Math.min(n, total) }, (_, i) => `${tail ? total - Math.min(n, total) + i : i}`.padEnd(rowLen, "x"));
    const page: Obj = { head: "h".repeat(fixed), rows };
    if (n < total) page.nextCursor = String(n);
    return page;
  };

describe("fitPage", () => {
  it("leaves a page that fits alone, without limitUsed, and calls render once", async () => {
    let calls = 0;
    const render = pager(10, 100);
    const page = await fitPage(10, (n) => (calls++, render(n)));
    assert.equal(calls, 1);
    assert.equal("limitUsed" in page, false);
    assert.equal((page.rows as string[]).length, 10);
  });

  it("returns the largest page that fits, and says which limit it used", async () => {
    const render = pager(500, 1000);
    const page = await fitPage(500, render);
    const n = page.limitUsed as number;
    assert.ok(toolText(page).length <= CHARACTER_LIMIT);
    assert.equal((page.rows as string[]).length, n);
    assert.ok(toolText({ ...render(n + 1), limitUsed: n + 1 }).length > CHARACTER_LIMIT, "one more row would not fit");
    assert.ok(n >= 20 && n < 26, `about 25 rows of 1,000 characters (${n})`);
  });

  it("works on a page taken from the tail", async () => {
    const render = pager(500, 1000, 0, true);
    const page = await fitPage(500, render);
    const rows = page.rows as string[];
    assert.ok(toolText(page).length <= CHARACTER_LIMIT);
    assert.equal(rows.length, page.limitUsed);
    assert.ok(rows[0]!.startsWith(String(500 - rows.length)), "the newest rows stay");
  });

  it("a last page shorter than the limit still counts as fitting", async () => {
    const page = await fitPage(1000, pager(30, 100));
    assert.equal("limitUsed" in page, false);
  });

  it("returns the page whole with truncated when the fixed part is over the limit", async () => {
    let calls = 0;
    const render = pager(100, 10, CHARACTER_LIMIT + 5000);
    const page = await fitPage(100, (n) => (calls++, render(n)));
    assert.equal(page.truncated, true);
    assert.equal("limitUsed" in page, false);
    assert.equal((page.rows as string[]).length, 100, "the page that was asked for");
    assert.ok(calls <= 2, `no pointless retries (${calls} calls)`);
    const one = await fitPage(1, render);
    assert.equal(one.truncated, true);
  });
});
