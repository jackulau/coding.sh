// docs/reference/cli.md is generated from the command registry. This fails when
// a command, argument or option changes and the doc was not regenerated.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CLI_REFERENCE_PATH, renderCliReference } from "../../scripts/cli-reference.ts";
import { visibleFlags } from "../../src/cli/args.ts";
import { COMMANDS, GLOBAL_FLAGS } from "../../src/cli/registry.ts";

describe("docs/reference/cli.md", () => {
  const doc = readFileSync(CLI_REFERENCE_PATH, "utf8");

  it("matches the command registry", () => {
    assert.ok(doc === renderCliReference(), "docs/reference/cli.md is stale. Regenerate it: node packages/coding.sh/scripts/cli-reference.ts");
  });

  it("documents every command, action and option", () => {
    for (const f of GLOBAL_FLAGS) assert.ok(doc.includes(`--${f.name}`), `global --${f.name}`);
    for (const c of COMMANDS) {
      assert.ok(doc.includes(`## \`coding.sh ${c.name}\``), c.name);
      for (const f of visibleFlags(c.flags)) assert.ok(doc.includes(`--${f.name}`), `${c.name} --${f.name}`);
      for (const a of c.actions ?? []) {
        assert.ok(doc.includes(`### \`coding.sh ${c.name} ${a.name}\``), `${c.name} ${a.name}`);
        for (const f of visibleFlags(a.flags)) assert.ok(doc.includes(`--${f.name}`), `${c.name} ${a.name} --${f.name}`);
      }
    }
  });

  it("leaves hidden flags out", () => {
    const hidden = COMMANDS.flatMap((c) => [...(c.flags ?? []), ...(c.actions ?? []).flatMap((a) => a.flags ?? [])]).filter((f) => f.hidden);
    assert.ok(hidden.some((f) => f.name === "refresh-bin"), "update --refresh-bin is hidden");
    for (const f of hidden) assert.ok(!doc.includes(`--${f.name}`), `--${f.name} is internal`);
  });
});
