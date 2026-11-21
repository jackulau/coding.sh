// CLI surface crawl: each command is counted once, and a binary that is not
// on PATH is an error, not an empty surface.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { measureSurface } from "../../src/toolevals/surface.ts";
import { cleanup, cliTarget, tmp } from "./helpers.ts";

after(cleanup);

// A CLI whose `--help --json` is either the whole tree (like coding.sh) or a
// names-only index, and whose `<cmd> --help --json` is that command's subtree.
function jsonCli(full: boolean): string {
  const file = join(tmp("csh-te-surf-"), "json-cli.mjs");
  writeFileSync(
    file,
    `const FULL = ${full};
const cmd = (name) => ({ name, summary: name + " things", options: [{ name: "verbose", description: "Say more about " + name }], commands: [{ name: "list", summary: "List " + name }] });
const argv = process.argv.slice(2);
if (!argv.includes("--help") || !argv.includes("--json")) process.exit(2);
const rest = argv.filter((a) => !a.startsWith("--"));
if (rest.length === 0) process.stdout.write(JSON.stringify({ name: "jc", commands: ["alpha", "beta"].map((n) => (FULL ? cmd(n) : { name: n, summary: n + " things" })) }));
else process.stdout.write(JSON.stringify({ command: cmd(rest[0]) }));
`,
  );
  return file;
}

describe("CLI surface", () => {
  it("counts a root --help --json that holds the whole tree once, without each command's page again", async () => {
    const t = cliTarget({ bin: "jc", command: [process.execPath, jsonCli(true)] });
    const s = await measureSurface(t, { name: "base" });
    assert.deepEqual(
      s.items.map((i) => i.name),
      ["jc"],
    );
    assert.equal(s.surfaceBytes, s.items[0]!.bytes);
  });

  it("still crawls each command's page when the root JSON lists only names", async () => {
    const t = cliTarget({ bin: "jc", command: [process.execPath, jsonCli(false)] });
    const s = await measureSurface(t, { name: "base" });
    assert.deepEqual(
      s.items.map((i) => i.name),
      ["jc", "jc alpha", "jc beta"],
    );
  });

  it("rejects a binary that is not on PATH instead of reporting an empty surface", async () => {
    const t = cliTarget({ bin: "no-such-tool-xyz", command: ["no-such-tool-xyz"] });
    await assert.rejects(measureSurface(t, { name: "base" }), (e: Error & { code?: string }) => {
      assert.match(e.message, /no-such-tool-xyz: command not found on PATH/);
      assert.equal(e.code, "ENOENT");
      return true;
    });
  });

  it("reads a help page printed on stdout when --help exits 1, as npm's does", async () => {
    const file = join(tmp("csh-te-surf-"), "npmish.mjs");
    writeFileSync(
      file,
      `const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
process.exitCode = 1;
if (argv[0] === "nope") process.stderr.write("unknown command\\n");
else process.stdout.write(argv.length ? "Usage: npmish " + argv[0] + " <pkg>\\n" : "Usage: npmish <command>\\n\\nCommands:\\n  install   Install a package\\n  nope      Not really there\\n");
`,
    );
    const t = cliTarget({ bin: "npmish", command: [process.execPath, file] });
    const s = await measureSurface(t, { name: "base" });
    assert.deepEqual(
      s.items.map((i) => i.name),
      ["npmish", "npmish install"],
      "stdout counts on exit 1; a failing call's stderr does not",
    );
  });

  it("rejects a CLI whose --help prints nothing", async () => {
    const file = join(tmp("csh-te-surf-"), "mute.mjs");
    writeFileSync(file, "process.exit(3);\n");
    const t = cliTarget({ bin: "mute", command: [process.execPath, file] });
    await assert.rejects(measureSurface(t, { name: "base" }), /mute --help printed nothing \(exit 3\)/);
  });
});
