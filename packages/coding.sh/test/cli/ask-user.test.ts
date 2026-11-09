// Errors that suggest a destructive, irreversible or paid step say the user must approve it
// first: `askUser: true` in --json and a plain line in text (gbrain-evals Cat 41: told to
// "re-run with --yes", agents ran it without asking).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { UsageError } from "../../src/cli/args.ts";
import { requireConsent } from "../../src/cli/common.ts";
import { ASK_USER, CliError, Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** A step that deletes, overwrites, undoes or spends: the user decides. */
const DESTRUCTIVE = /--yes\b|--force(?:-all)?\b|\bpurge\b|\brollback\b|\buninstall\b/;

/** Constructions that name such a step but do not suggest running it. */
const NOT_A_SUGGESTION: [file: string, pattern: RegExp, why: string][] = [
  // `exp compare --force` only reads stored results: it includes a partial experiment in the comparison.
  ["cli/commands/exp.ts", /exp compare \$\{ida\} \$\{idb\} --force/, "read-only comparison"],
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : []));
}

/** The text from `start` to its balanced closing paren (strings and templates are skipped over). */
function call(text: string, start: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

describe("destructive suggestions carry askUser", () => {
  const found: { where: string; text: string }[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    const rel = relative(SRC, file).replaceAll("\\", "/");
    for (const m of text.matchAll(/new (?:CliError|UsageError|InitError)\(/g)) {
      const args = call(text, m.index! + m[0].length - 1);
      if (!DESTRUCTIVE.test(args)) continue;
      if (NOT_A_SUGGESTION.some(([f, p]) => f === rel && p.test(args))) continue;
      found.push({ where: `${rel}:${text.slice(0, m.index).split("\n").length}`, text: args });
    }
  }

  it("every CliError, UsageError and InitError that suggests --yes, --force, purge, rollback or uninstall sets askUser", () => {
    assert.ok(found.length >= 10, `found ${found.length}`);
    const missing = found.filter((f) => !/askUser: true/.test(f.text)).map((f) => `${f.where}: ${f.text.slice(0, 160)}`);
    assert.deepEqual(missing, []);
  });

  it("every action_required document sets askUser", () => {
    let n = 0;
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/status: "action_required"/g)) {
        n++;
        const line = text.slice(m.index!, text.indexOf("\n", m.index!));
        assert.match(line, /askUser: true/, relative(SRC, file));
      }
    }
    assert.ok(n >= 1);
  });
});

/** An Output whose stderr is captured. */
function capture(json: boolean): { out: Output; err: () => string } {
  let buf = "";
  const sink = { write: (s: string) => ((buf += s), true), isTTY: false } as unknown as NodeJS.WriteStream;
  const out = new Output({ json, env: { NO_COLOR: "1" }, stdout: sink, stderr: sink, stdin: { isTTY: false } as NodeJS.ReadStream });
  return { out, err: () => buf };
}

describe("Output.error", () => {
  it("--json: askUser: true on an error whose next step the user must approve, and absent otherwise", () => {
    const a = capture(true);
    assert.equal(a.out.error(new CliError("x exists", { reason: "exists", askUser: true, next: ["Overwrite it:", "coding.sh x --force"] })), 1);
    assert.deepEqual(JSON.parse(a.err()), { status: "error", reason: "exists", message: "x exists", askUser: true, next: ["Overwrite it:", "coding.sh x --force"] });
    const b = capture(true);
    b.out.error(new CliError("not found", { reason: "not_found", next: ["List:", "coding.sh sessions"] }));
    assert.equal("askUser" in JSON.parse(b.err()), false);
    const u = capture(true);
    assert.equal(u.out.error(new UsageError("Run 2 agent sessions needs confirmation", { reason: "confirmation_required", suggestion: "coding.sh eval run s --yes", askUser: true })), 2);
    assert.deepEqual(JSON.parse(u.err()), { status: "error", reason: "confirmation_required", message: "Run 2 agent sessions needs confirmation", askUser: true, next: ["coding.sh eval run s --yes"] });
  });

  it("text: says plainly that the user must approve, and never 'Did you mean' for such a step", () => {
    const a = capture(false);
    a.out.error(new CliError("x exists", { askUser: true, next: ["Overwrite it:", "coding.sh x --force"] }));
    assert.ok(a.err().includes(ASK_USER), a.err());
    assert.ok(a.err().indexOf(ASK_USER) < a.err().indexOf("coding.sh x --force"), "the warning comes before the command");
    const u = capture(false);
    u.out.error(new UsageError("Run 2 agent sessions needs confirmation", { suggestion: "coding.sh eval run s --yes", askUser: true }));
    assert.ok(u.err().includes(ASK_USER), u.err());
    assert.match(u.err(), /With their approval: coding\.sh eval run s --yes/);
    assert.doesNotMatch(u.err(), /Did you mean/);
    const typo = capture(false);
    typo.out.error(new UsageError("Unknown option --sinse", { suggestion: "--since" }));
    assert.match(typo.err(), /Did you mean --since\?/);
    assert.ok(!typo.err().includes(ASK_USER));
  });
});

describe("requireConsent", () => {
  it("without a terminal or --yes: confirmation_required with askUser, telling the agent to ask", async () => {
    const { out } = capture(true);
    const c = { flags: {}, out } as unknown as CommandContext;
    await assert.rejects(requireConsent(c, "Run 4 agent sessions?", "coding.sh eval run s --yes"), (e: unknown) => {
      assert.ok(e instanceof UsageError);
      assert.equal(e.reason, "confirmation_required");
      assert.equal(e.askUser, true);
      assert.equal(e.suggestion, "coding.sh eval run s --yes");
      assert.equal(e.message, "Run 4 agent sessions needs confirmation from the user");
      return true;
    });
    await requireConsent({ flags: { yes: true }, out } as unknown as CommandContext, "Run 4 agent sessions?", "x");
  });
});
