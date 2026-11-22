// usage --by: the parser takes only the registry's choices and usage does not check the value
// again, so the choices must be exactly the groups usage serves.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ATTRIBUTED_GROUPS } from "../../src/cli/commands/usage.ts";
import { main } from "../../src/cli/main.ts";
import { findCommand } from "../../src/cli/registry.ts";
import { USAGE_GROUPS } from "../../src/mcp/data.ts";

let root = "";
let env: NodeJS.ProcessEnv;
before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-usage-by-"));
  env = { ...process.env, HOME: root, USERPROFILE: root, CODING_SH_HOME: join(root, ".coding.sh"), CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" };
});
after(() => rmSync(root, { recursive: true, force: true }));

test("the registry's --by choices are the groups usage serves", () => {
  const by = findCommand("usage")!.flags!.find((f) => f.name === "by")!;
  assert.deepEqual([...by.choices!].sort(), [...USAGE_GROUPS, ...ATTRIBUTED_GROUPS].sort());
});

test("an unknown --by stops in the parser, with the choices and the closest one", async () => {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => ((stderr += String(chunk)), true)) as typeof process.stderr.write;
  let status: number;
  try {
    status = await main(["usage", "--by", "subagents"], env);
  } finally {
    process.stderr.write = write;
  }
  assert.equal(status, 2, stderr);
  assert.match(stderr, /--by must be one of agent, model, agent-model, day, repo, mcp, skill, subagent, got "subagents"\n {4}Did you mean --by subagent\?/);
});
