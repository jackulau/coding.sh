// diff-calls prints a call's time in the local zone, as `show` does.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { printDiff } from "../../src/cli/commands/diff-calls.ts";
import { Output } from "../../src/cli/output.ts";
import type { CallDiff } from "../../src/proxy/calls.ts";

const saved = process.env.TZ;
after(() => {
  if (saved === undefined) delete process.env.TZ;
  else process.env.TZ = saved;
});

test("under America/Chicago 20:48:09 UTC prints as 14:48:09", () => {
  process.env.TZ = "America/Chicago";
  const side = (id: string, ts: number) => ({ id, sessionId: "s", ts, model: "m", usage: {} });
  const d = {
    a: side("aaaaaaaaaaaaaaaa", Date.UTC(2026, 10, 11, 20, 48, 9)),
    b: side("bbbbbbbbbbbbbbbb", Date.UTC(2026, 10, 11, 20, 49, 10)),
    content: "metadata",
    params: [],
    tools: { same: true, added: [], removed: [], changed: [], reordered: false },
    system: { same: true },
    messages: { a: 1, b: 2, shared: 1, rewritten: false },
    cache: { reused: true, expected: 0, read: 0, write: 0, gapMs: 61000 },
  } as unknown as CallDiff; // slop-allow chained-as: a diff with only the fields printDiff prints here
  let text = "";
  printDiff(new Output({ json: false, noColor: true, env: {}, stdout: { write: (x: string) => ((text += x), true), isTTY: false }, stdin: { isTTY: false } }), d);
  assert.match(text, /aaaaaaaaaaaa {2}m {2}14:48:09 /);
  assert.match(text, /bbbbbbbbbbbb {2}m {2}14:49:10 /);
});
