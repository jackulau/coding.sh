// attribution export checks --viewer-url; config set says what the key was.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as attribution from "../../src/cli/commands/attribution.ts";
import * as config from "../../src/cli/commands/config.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

let sb: Sandbox;
before(() => {
  sb = sandbox();
});
after(() => sb.cleanup());

test("attribution export refuses a --viewer-url that is not an http(s) URL (usage error)", async () => {
  for (const bad of ["not a url", "ftp://x.test/", "javascript:alert(1)"]) {
    const r = await runCmd(attribution, sb, { action: "export", flags: { "viewer-url": bad } });
    assert.equal(r.error?.name, "UsageError", bad);
    assert.match(r.error?.message, /--viewer-url .* is not an http or https URL/);
  }
});

test("config set confirms with the old value", async () => {
  const first = await runCmd(config, sb, { action: "set", positionals: ["capture.mode", "metadata"], json: true });
  assert.equal(first.json.previous, "full");
  const text = await runCmd(config, sb, { action: "set", positionals: ["capture.mode", "full"] });
  assert.match(text.stderr + text.stdout, /Set capture\.mode \(was metadata\)/);
});
