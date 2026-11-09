// Intent preload's rules (createIntent in src/viewer/ui/index.html), on a fake
// clock: a pointer that rests 100 ms on a row, focus that stays, or a press is
// intent; a row that scrolls under a still pointer is not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
const src = html.slice(html.indexOf("// <intent>"), html.indexOf("// </intent>"));
assert.ok(src.includes("function createIntent"), "found createIntent between the intent markers");

function rig() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const fired: string[] = [];
  const createIntent = runInNewContext(`${src}; createIntent`, {}) as (o: unknown) => any;
  const intent = createIntent({
    delay: 100,
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id: number) => { timers.delete(id); },
    onIntent: (k: string) => fired.push(k),
  });
  const tick = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { timers.delete(id); t.fn(); }
  };
  return { intent, fired, tick, pending: () => timers.size };
}

test("a pointer that rests 100 ms on a row is intent; moving on restarts the wait", () => {
  const { intent, fired, tick } = rig();
  intent.move("a", 10, 10);
  tick(60);
  intent.move("a", 12, 10);
  tick(60);
  assert.deepEqual(fired, [], "still moving");
  tick(40);
  assert.deepEqual(fired, ["a"]);
  intent.move("b", 12, 40);
  tick(99);
  assert.deepEqual(fired, ["a"]);
  tick(1);
  assert.deepEqual(fired, ["a", "b"]);
});

test("passing over rows on the way somewhere fires nothing", () => {
  const { intent, fired, tick } = rig();
  for (let k = 0; k < 10; k++) { intent.move(`r${k}`, 10, 10 + k * 30); tick(30); }
  intent.leave();
  tick(500);
  assert.deepEqual(fired, []);
});

test("rows that scroll under a still pointer fire nothing", () => {
  const { intent, fired, tick, pending } = rig();
  intent.move("a", 50, 50);
  // The wheel scrolls: a scroll event, then a move event at the same spot over another row.
  tick(40);
  intent.scroll();
  intent.move("b", 50, 50);
  intent.move("c", 50, 50);
  tick(1000);
  assert.deepEqual(fired, []);
  assert.equal(pending(), 0);
  // The person moves again: that is intent.
  intent.move("c", 51, 50);
  tick(100);
  assert.deepEqual(fired, ["c"]);
});

test("keyboard focus that stays 100 ms is intent, and a scroll it causes does not cancel it", () => {
  const { intent, fired, tick } = rig();
  intent.focus("a");
  tick(50);
  intent.focus("b");
  intent.scroll();
  tick(100);
  assert.deepEqual(fired, ["b"]);
});

test("a press is intent at once and drops a pending rest", () => {
  const { intent, fired, tick } = rig();
  intent.move("a", 1, 1);
  intent.press("b");
  assert.deepEqual(fired, ["b"]);
  tick(200);
  assert.deepEqual(fired, ["b"]);
});
