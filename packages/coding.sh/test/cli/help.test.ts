// Root help and the READMEs say the same one-liner, and internal flags stay out of help.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../../src/cli/args.ts";
import { commandHelp, helpMetadata, rootHelp, SUMMARY } from "../../src/cli/main.ts";
import { findCommand } from "../../src/cli/registry.ts";

const plain = { heading: (s: string) => s, bold: (s: string) => s, faint: (s: string) => s };
const PKG = join(import.meta.dirname, "..", "..");

describe("help summary", () => {
  it("root help leads with the summary both READMEs use", () => {
    assert.match(rootHelp(plain), new RegExp(`^  ${SUMMARY.replace(/[.]/g, "\\.")}$`, "m"));
    // The READMEs open with "coding.sh is open-source, …", so the summary's first letter may be lowercase there.
    for (const readme of [join(PKG, "README.md"), join(PKG, "..", "..", "README.md")]) {
      const text = readFileSync(readme, "utf8").toLowerCase();
      assert.ok(text.includes(SUMMARY.toLowerCase()), `${readme} carries the CLI summary`);
    }
    assert.match(SUMMARY, /any AI agent/);
  });
});

describe("hidden flags", () => {
  const update = findCommand("update")!;

  it("update --refresh-bin is accepted but not shown in help or --help --json", () => {
    const help = commandHelp(update, undefined, plain);
    assert.doesNotMatch(help, /refresh-bin/);
    assert.match(help, /--check/);
    assert.doesNotMatch(JSON.stringify(helpMetadata(update)), /refresh-bin/);
    assert.doesNotMatch(JSON.stringify(helpMetadata()), /refresh-bin/);
    const parsed = parseArgs(["--refresh-bin"], update.flags ?? []);
    assert.equal(parsed.flags["refresh-bin"], true);
  });

  it("a typo is never corrected to a hidden flag", () => {
    assert.throws(() => parseArgs(["--refresh-bim"], update.flags ?? []), (e: Error & { suggestion?: string }) => e.suggestion === undefined);
  });
});
