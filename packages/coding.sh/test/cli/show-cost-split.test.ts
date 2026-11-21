// `show` splits the estimate by token type under the Tokens row: cache reads, cache writes,
// uncached input and output, each with its share and its dollars.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as show from "../../src/cli/commands/show.ts";
import type { Session } from "../../src/core/types.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const T0 = 1_700_000_000_000;
// Opus 4.5 rates: 502,400 cache reads $0.2512, 14,512 cache writes $0.0907, 3,300 input $0.0165, 2,156 output $0.0539.
const tokens = { inputTokens: 3300, outputTokens: 2156, cacheReadTokens: 502_400, cacheWriteTokens: 14_512 };
const split = { cacheRead: 0.2512, cacheWrite: 0.0907, input: 0.0165, output: 0.0539 };
const withUsage = (id: string, usage: NonNullable<Session["stats"]["usage"]>) => mkSession(id, T0, { model: "claude-opus-4-5", stats: { usage } });

let sb: Sandbox;
before(async () => {
  sb = sandbox();
  await sb.seed([
    withUsage("all-estimated", { ...tokens, costUsd: 0.4123, estimatedCostUsd: 0.4123, estimatedCostByTokenType: split }),
    // $1 of the cost was reported: the split covers the $0.4123 estimate only.
    withUsage("part-reported", { ...tokens, costUsd: 1.4123, estimatedCostUsd: 0.4123, estimatedCostByTokenType: split }),
    withUsage("reported", { ...tokens, costUsd: 0.5 }),
  ]);
});
after(() => sb.cleanup());

const lines = async (id: string) => (await runCmd(show, sb, { positionals: [id] })).stdout.split("\n");

test("the Cost split row follows Tokens, with each part's share and dollars, in 100 columns", async () => {
  const out = await lines("all-estimated");
  const at = out.findIndex((l) => l.startsWith("  Tokens"));
  assert.match(out[at]!, /\$0\.4123 \(estimated\)$/);
  assert.equal(out[at + 1], "  Cost split    cache read 61% $0.2512  cache write 22% $0.0907  in 4% $0.0165  out 13% $0.0539");
  assert.ok(out[at + 1]!.length <= 100);
});

test("when part of the cost was reported, the row is the Est. split of the estimate the Tokens row names", async () => {
  const out = await lines("part-reported");
  const at = out.findIndex((l) => l.startsWith("  Tokens"));
  assert.match(out[at]!, /\$1\.41 \(incl\. \$0\.4123 estimated\)$/);
  assert.equal(out[at + 1], "  Est. split    cache read 61% $0.2512  cache write 22% $0.0907  in 4% $0.0165  out 13% $0.0539");
});

test("a reported cost has no split row", async () => {
  const out = await lines("reported");
  assert.ok(out.some((l) => l.startsWith("  Tokens")));
  assert.ok(!out.some((l) => /split/.test(l)), out.join("\n"));
});

test("show --json carries the split in the session's usage", async () => {
  const r = await runCmd(show, sb, { positionals: ["all-estimated"], json: true });
  assert.deepEqual(r.json.session.stats.usage.estimatedCostByTokenType, split);
  const none = await runCmd(show, sb, { positionals: ["reported"], json: true });
  assert.equal(none.json.session.stats.usage.estimatedCostByTokenType, undefined);
});
