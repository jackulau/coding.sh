// Root help and the READMEs say the same one-liner, and internal flags stay out of help.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { signatureHeaders } from "../../src/alerts/notify.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { commandHelp, helpMetadata, rootHelp, SUMMARY } from "../../src/cli/main.ts";
import { findCommand } from "../../src/cli/registry.ts";
import { BUDGET_REFRESH_MS } from "../../src/proxy/budget.ts";

const plain = { heading: (s: string) => s, bold: (s: string) => s, faint: (s: string) => s };
const PKG = join(import.meta.dirname, "..", "..");

describe("help summary", () => {
  it("root help leads with the summary both READMEs use", () => {
    assert.match(rootHelp(plain), new RegExp(`^  ${SUMMARY.replace(/[.]/g, "\\.")}$`, "m"));
    // The READMEs open with "coding.sh records …", so the summary's first letter is lowercase there.
    for (const readme of [join(PKG, "README.md"), join(PKG, "..", "..", "README.md")]) {
      const text = readFileSync(readme, "utf8").toLowerCase();
      assert.ok(text.includes(SUMMARY.toLowerCase()), `${readme} carries the CLI summary`);
    }
    assert.match(SUMMARY, /^Records what your AI agents do/);
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

describe("help that states what the code does", () => {
  const notes = (name: string) => commandHelp(findCommand(name)!, undefined, plain).replace(/\s+/g, " ");

  it("alert and monitor help name all three signature headers, which one covers the timestamp, and the 5-minute check", () => {
    for (const name of ["alert", "monitor"]) {
      const help = notes(name);
      for (const h of Object.keys(signatureHeaders("s", "{}"))) assert.ok(help.includes(`${h}:`) || help.includes(`${h} (`), `${name} help names ${h}`);
      assert.match(help, /X-Coding-Sh-Signature-V2: sha256=<HMAC-SHA256 of "<timestamp>\.<body>">, which covers the timestamp and the body/);
      assert.match(help, /X-Coding-Sh-Signature: sha256=<HMAC-SHA256 of the body alone>, which does not stop a replay/);
      assert.match(help, /refuses a timestamp more than 5 minutes from its own clock/);
    }
  });

  it("proxy help: only proxy-wide budgets stop a call, and a failed read stops none for the refresh interval with one warning", () => {
    const help = notes("proxy");
    assert.match(help, /A --repo or --where budget never stops one/);
    assert.match(help, new RegExp(`none stops a call for ${BUDGET_REFRESH_MS / 1000} s, and one warning prints`));
  });

  it("budget help: a budget that can't be read prints an error in place of its numbers, and status exits 1", () => {
    assert.match(notes("budget"), /error replaces spendUsd, percent and over.*status exits 1/);
  });

  it("monitor help: a pass stops after 2 unreachable sessions, a later answer moves past them, and list hides the query string", () => {
    const help = notes("monitor");
    assert.match(help, /for 2 sessions in a row, the pass stops/);
    assert.match(help, /An answer for a later session, a score or a refusal, moves the cursor past them/);
    assert.match(help, /without its query string or fragment/);
  });

  it("harness tools help: what removed means, and that a later pin does not pin a tool that is gone", () => {
    const help = notes("harness");
    assert.match(help, /a pinned tool that no tools array offered since its pin includes/);
    assert.match(help, /a later pin does not pin again a tool that is gone/);
  });
});
