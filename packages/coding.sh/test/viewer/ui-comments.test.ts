// The viewer's comment request body, run from the page's own script without a browser: a comment
// is a text score named comment by a person, on the session or on a step's event, with its own id
// so a second comment by the same person adds one rather than replacing the first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");

function slice(from: string, to: string): string {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `slice ${from} .. ${to}`);
  return html.slice(a, b);
}

const ctx = runInNewContext(`${slice("function commentId(", "function commentStore(")}; ({ commentId, commentBody, stepIds })`, { crypto, Date, Array, String, Uint8Array });

test("a session comment is a trimmed text score on the session, by a person, with its own id", () => {
  const body = ctx.commentBody("session", "s1", "  looks right \n");
  assert.match(body.id, /^comment-[0-9a-z]+-[0-9a-f]{18}$/);
  assert.doesNotMatch(body.id, /^[0-9a-f]{64}$/, "not the shape of a default score id");
  const { id: _id, ...rest } = body;
  assert.deepEqual({ ...rest }, { target: "session", targetId: "s1", name: "comment", dataType: "text", value: "looks right", source: "human" });
  assert.notEqual(ctx.commentBody("session", "s1", "again").id, body.id, "each comment has its own id");
});

test("a step comment targets the step's event", () => {
  assert.deepEqual({ ...ctx.commentBody("event", "s1-e3", "wrong file", "comment-x") }, { id: "comment-x", target: "event", targetId: "s1-e3", name: "comment", dataType: "text", value: "wrong file", source: "human" });
});

test("empty text posts nothing", () => {
  for (const text of ["", "   ", "\n\t", null, undefined]) assert.equal(ctx.commentBody("session", "s1", text), null);
});

test("a step's comments can target its start, end, only event or copy", () => {
  assert.deepEqual([...ctx.stepIds({ id: "s1-e2", start: { id: "s1-e2" }, end: { id: "s1-e3" } })], ["s1-e2", "s1-e2", "s1-e3"]);
  assert.deepEqual([...ctx.stepIds({ id: "p", ev: { id: "s1-e5" }, copyId: "s1-e9" })], ["p", "s1-e5", "s1-e9"]);
});
