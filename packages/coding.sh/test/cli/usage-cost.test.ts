// coding.sh usage, human output: unpriced sessions get a share warning and a named-model hint,
// a row with priced and unpriced sessions shows its cost as a lower bound (≥$), and --json is untouched.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { ok, seed, session } from "../query/_seed.ts";

const now = Date.now() - 3_600_000;
const priced = (id: string, agent: string, model: string, costUsd: number) =>
  session(id, { agent, model, startedAt: now, endedAt: now + 60_000, stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 1000, outputTokens: 200, costUsd } } });
const unpriced = (id: string, agent: string, model: string) =>
  session(id, { agent, model, startedAt: now, endedAt: now + 60_000, stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 5000, outputTokens: 900 } } });

describe("usage with unpriced sessions", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions: [priced("a", "claude-code", "claude-opus-5", 1.5), unpriced("b", "claude-code", "mystery-model-1"), unpriced("c", "codex", "house-coder-9")] });
  });
  after(() => env.restore());

  test("--by agent: a mixed row is a lower bound, an unpriced row is '-', and the share is printed", () => {
    const r = ok(["usage", "--by", "agent"]);
    const claude = r.stdout.split("\n").find((l) => l.startsWith("claude-code"))!;
    const codex = r.stdout.split("\n").find((l) => l.startsWith("codex"))!;
    assert.match(claude, /≥\$1\.50\s*$/);
    assert.match(codex, /\s-\s*$/);
    assert.match(r.stderr, /2 of 3 sessions have tokens but no reported cost; COST counts only the priced ones/);
    assert.match(r.stderr, /≥ = some sessions in the row have tokens but no price; the cost is a lower bound/);
    assert.match(r.stderr, /No price for (mystery-model-1|house-coder-9) \(1\), (mystery-model-1|house-coder-9) \(1\): add \[prices\."<model>"\]/);
    assert.ok(!r.stdout.includes("≥ ="), "notes go to stderr");
  });

  test("--by model names the unpriced models", () => {
    const r = ok(["usage", "--by", "model"]);
    assert.match(r.stdout, /claude-opus-5.*\$1\.50/);
    assert.match(r.stdout, /mystery-model-1.*\s-\s*$/m);
    assert.match(r.stderr, /No price for .*mystery-model-1/);
  });

  test("--json keeps the data shape: costPartial and unpricedSessions on the row, no human notes", () => {
    const j = JSON.parse(ok(["usage", "--by", "agent", "--json"]).stdout);
    const claude = j.groups.find((g: { key: string }) => g.key === "claude-code");
    assert.equal(claude.costPartial, true);
    assert.equal(claude.unpricedSessions, 1);
    assert.equal(claude.costUsd, 1.5);
    assert.equal(j.groups.find((g: { key: string }) => g.key === "codex").costUsd, undefined);
    assert.ok(!JSON.stringify(j).includes("≥"));
  });
});

describe("usage with no priced session", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions: [unpriced("c", "codex", "house-coder-9")] });
  });
  after(() => env.restore());

  test("COST is left out and the note says why", () => {
    const r = ok(["usage"]);
    assert.ok(!r.stdout.includes("COST"));
    assert.match(r.stderr, /No session in this window has a cost/);
    assert.match(r.stderr, /No price for house-coder-9 \(1\)/);
  });
});

describe("usage with every session priced", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions: [priced("a", "claude-code", "claude-opus-5", 1.5), priced("b", "codex", "gpt-5", 0.25)] });
  });
  after(() => env.restore());

  test("no lower bounds and no unpriced notes", () => {
    const r = ok(["usage"]);
    assert.match(r.stdout, /\$1\.50/);
    assert.ok(!r.stdout.includes("≥") && !r.stderr.includes("≥"));
    assert.ok(!/no reported cost|No price for/.test(r.stderr));
  });
});
