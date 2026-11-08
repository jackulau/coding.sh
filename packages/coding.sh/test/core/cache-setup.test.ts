import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fallbackModelRisks } from "../../src/core/cache-setup.ts";

describe("fallbackModelRisks", () => {
  it("reports a fallbackModel from settings files, read-only, skipping missing and broken ones", () => {
    const root = mkdtempSync(join(tmpdir(), "csh-cache-setup-"));
    const user = join(root, "user");
    const proj = join(root, "proj");
    mkdirSync(user, { recursive: true });
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(user, "settings.json"), JSON.stringify({ model: "claude-opus-5-5", fallbackModel: "claude-opus-4-8" }));
    writeFileSync(join(proj, "settings.local.json"), "{ not json");
    try {
      const risks = fallbackModelRisks([user, proj, join(root, "missing")]);
      assert.equal(risks.length, 1, "the broken and missing files are skipped");
      assert.equal(risks[0]?.fallbackModel, "claude-opus-4-8");
      assert.match(risks[0]!.path, /settings\.json$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is empty when no fallback is set", () => {
    const root = mkdtempSync(join(tmpdir(), "csh-cache-setup-"));
    writeFileSync(join(root, "settings.json"), JSON.stringify({ model: "claude-opus-5-5" }));
    try {
      assert.deepEqual(fallbackModelRisks([root]), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
