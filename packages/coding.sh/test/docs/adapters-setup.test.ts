// docs/ADAPTERS.md says what setup each agent needs. These checks fail when it
// names a step the adapters never take: an opt-in marker Amp's plugin does not
// write, a Gemini setting init does not set, a Codex flag init does not turn on,
// or a side-file limit that is not the hook's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ampPluginSource } from "../../src/adapters/more/amp.ts";
import { MAX_INLINE_LINE_BYTES } from "../../src/spool/write.ts";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOC = readFileSync(join(pkg, "..", "..", "docs", "ADAPTERS.md"), "utf8");
const src = (rel: string) => readFileSync(join(pkg, "src", rel), "utf8");
const row = (agent: string) => DOC.split("\n").find((l) => l.startsWith(`| ${agent} |`)) ?? "";

describe("ADAPTERS.md setup steps match the adapters", () => {
  it("names the Amp plugin marker only when the plugin amp.ts writes has one", () => {
    const plugin = ampPluginSource("/opt/coding.sh/hook.mjs");
    const marker = /i-know-the-amp-plugin-api/.test(plugin);
    assert.equal(/i-know-the-amp-plugin-api/.test(DOC), marker, "ADAPTERS.md and the Amp plugin disagree on the opt-in marker");
  });

  it("names tools.enableHooks for Gemini only when the adapter sets it", () => {
    const sets = /enableHooks["']?\s*[:=]/.test(src("adapters/more/gemini-cli.ts"));
    assert.equal(row("Gemini CLI").includes("enableHooks"), sets, row("Gemini CLI"));
  });

  it("does not tell Codex users to turn [features] hooks on: it is on by default", () => {
    assert.match(src("adapters/codex.ts"), /`\[features\] hooks` is stable and on by default/);
    assert.doesNotMatch(row("Codex"), /hooks\s*=\s*true/);
  });

  it("gives the hook's inline line limit, not an older one", () => {
    assert.equal(MAX_INLINE_LINE_BYTES + 1, 1024);
    assert.doesNotMatch(DOC, /payloads over 256 KB/);
    assert.match(DOC, /any line over 1024 bytes/);
  });
});
