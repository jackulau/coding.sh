// coding.sh's own tool evals pointed at its MCP server: the surface stays
// small, and every task in test/mcp/toolevals validates (the no-op fails,
// the reference passes through the MCP tap, nothing leaks).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadToolEvals, type ToolEvalsConfig } from "../../src/toolevals/config.ts";
import { resetEraCache } from "../../src/toolevals/mcp/client.ts";
import { measureSurface } from "../../src/toolevals/surface.ts";
import type { McpTarget } from "../../src/toolevals/types.ts";
import { validateToolTask } from "../../src/toolevals/validate.ts";
import { MAIN, PKG } from "./helpers.ts";

const TARGET = "codingsh-mcp";
let root: string;
let cfg: ToolEvalsConfig;

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-mcp-te-")));
  // The suite lives in test/mcp/toolevals; the repo layout loadToolEvals wants is a symlink to it.
  mkdirSync(join(root, "evals", "toolevals"), { recursive: true });
  symlinkSync(join(PKG, "test", "mcp", "toolevals"), join(root, "evals", "toolevals", TARGET), "dir");
  writeFileSync(
    join(root, "coding.sh.toml"),
    [
      `[toolevals.targets.${TARGET}]`,
      'kind = "mcp"',
      `command = [${JSON.stringify(process.execPath)}, "--no-warnings", ${JSON.stringify(MAIN)}]`,
      'env = { HOME = "${home}", CODING_SH_HOME = "${sandbox}/data", TZ = "UTC" }',
      "",
    ].join("\n"),
  );
  cfg = await loadToolEvals(root);
  resetEraCache();
});

after(() => rmSync(root, { recursive: true, force: true }));

describe("tool evals against the coding.sh MCP server", () => {
  it("loads the suite without problems", () => {
    assert.deepEqual(cfg.problems, []);
    assert.equal(cfg.targets.get(TARGET)?.kind, "mcp");
    assert.ok(cfg.tasks.length >= 6);
  });

  it("keeps the tool surface small", async () => {
    const target = cfg.targets.get(TARGET) as McpTarget;
    const env = { HOME: join(root, "home"), CODING_SH_HOME: join(root, "surface-data") };
    const s = await measureSurface({ ...target, env }, { name: "base" }, { cwd: root });
    assert.equal(s.items.length, 14);
    // Every tool definition (name, description, input + output schema) costs context in every turn.
    // 24 KB for 13 tools; harness_compare (the 14th) adds about 1.3 KB.
    assert.ok(s.surfaceBytes < 25_500, `surface is ${s.surfaceBytes} bytes`);
    assert.ok(s.descriptionBytes < 9_000, `descriptions are ${s.descriptionBytes} bytes`);
    for (const it of s.items) assert.ok(it.bytes < 4_000, `${it.name} is ${it.bytes} bytes`);
  });

  for (const id of ["failing-tool", "llm-p95", "latest-prompt", "subagent-count", "codex-cost", "session-to-eval"]) {
    it(`validates ${id}`, async () => {
      const task = cfg.tasks.find((t) => t.id === id);
      assert.ok(task, `task ${id} exists`);
      const v = await validateToolTask(task, cfg.targets.get(TARGET)!, { root: join(root, "trials") });
      assert.deepEqual(v.problems, [], JSON.stringify(v, null, 2));
      assert.equal(v.ok, true);
      assert.ok((v.reference?.targetCalls ?? 0) >= (task.expect?.minTargetCalls ?? 1), "the reference went through the MCP tap");
    });
  }
});
