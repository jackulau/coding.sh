// coding.sh harness audit warns, before any run, about a Claude Code fallback model:
// the prompt cache belongs to one model, so a fallback rewrites it at full price.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";
import { ok } from "../query/_seed.ts";

describe("harness audit flags a fallback model as a cache risk", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
    writeFile(join(env.home, ".claude", "settings.json"), JSON.stringify({ model: "claude-opus-5-5", fallbackModel: "claude-opus-4-8" }));
  });
  after(() => env.restore());

  test("--json lists it under fallbackModels", () => {
    const j = JSON.parse(ok(["harness", "audit", "--json"]).stdout);
    assert.equal(j.fallbackModels?.[0]?.fallbackModel, "claude-opus-4-8");
    assert.match(j.fallbackModels?.[0]?.path, /settings\.json$/);
  });

  test("human output warns and says how to fix", () => {
    const r = ok(["harness", "audit"]);
    assert.match(r.stderr, /fallback model is set/);
    assert.match(r.stderr, /falls back to claude-opus-4-8/);
    assert.match(r.stderr, /Remove `fallbackModel`, or pin one model/);
  });
});
