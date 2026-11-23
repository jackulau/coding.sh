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
import { AGENT_ENV, ASK_USER, CliError, Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

/** A step that deletes, overwrites, undoes or spends: the user decides. */
const DESTRUCTIVE = /--yes\b|--force(?:-all)?\b|\bpurge\b|\brollback\b|\buninstall\b/;

/** Constructions that name such a step but do not suggest running it. */
const NOT_A_SUGGESTION: [file: string, pattern: RegExp, why: string][] = [
  // `exp compare --force` only reads stored results: it includes a partial experiment in the comparison.
  ["cli/commands/exp.ts", /exp compare \$\{(?:shellQuote\()?ida\)?\} \$\{(?:shellQuote\()?idb\)?\} --force/, "read-only comparison"],
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

/** An Output whose stderr is captured; `tty` puts a person at a terminal (stdin and stderr are TTYs). */
function capture(json: boolean, tty = false, env: NodeJS.ProcessEnv = {}): { out: Output; err: () => string } {
  let buf = "";
  const sink = { write: (s: string) => ((buf += s), true), isTTY: tty } as unknown as NodeJS.WriteStream;
  const out = new Output({ json, env: { NO_COLOR: "1", ...env }, platform: "linux", stdout: sink, stderr: sink, stdin: { isTTY: tty } as NodeJS.ReadStream });
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
    assert.deepEqual(JSON.parse(u.err()), { status: "error", reason: "confirmation_required", message: "Run 2 agent sessions needs confirmation", askUser: true, next: ["With their approval:", "coding.sh eval run s --yes"] });
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

  it("text at a terminal: the person is the user, so the line for an agent is left out and the step prints as is", () => {
    const a = capture(false, true);
    assert.equal(a.out.interactive, true);
    a.out.error(new CliError("x exists", { askUser: true, next: ["Overwrite it:", "coding.sh x --force"] }));
    assert.ok(!a.err().includes(ASK_USER), a.err());
    assert.match(a.err(), /^✗ x exists\n {4}Overwrite it:\n {4}coding\.sh x --force\n$/);
    const u = capture(false, true);
    u.out.error(new UsageError("Run 2 agent sessions needs confirmation", { suggestion: "coding.sh eval run s --yes", askUser: true }));
    assert.ok(!u.err().includes(ASK_USER), u.err());
    assert.doesNotMatch(u.err(), /With their approval|Did you mean/);
    assert.match(u.err(), /^✗ Run 2 agent sessions needs confirmation\n {4}coding\.sh eval run s --yes\n$/);
    // CI at a terminal is no person: the line stays.
    const ci = capture(false, true, { CI: "1" });
    assert.equal(ci.out.interactive, false);
    ci.out.error(new CliError("x exists", { askUser: true, next: ["Overwrite it:", "coding.sh x --force"] }));
    assert.ok(ci.err().includes(ASK_USER), ci.err());
  });

  it("text at a terminal an agent runs (its env names it): no prompts, and the lines for the agent stay", () => {
    for (const k of AGENT_ENV) {
      const a = capture(false, true, { [k]: "1" });
      // The agent reads the terminal (Codex runs a command in one): it could answer a prompt itself.
      assert.equal(a.out.interactive, false, k);
      assert.equal(a.out.forAgent, true, k);
      a.out.error(new CliError("x exists", { askUser: true, next: ["Overwrite it:", "coding.sh x --force"] }));
      assert.equal(a.err(), `✗ x exists\n    ${ASK_USER}\n    Overwrite it:\n    coding.sh x --force\n`, k);
      const u = capture(false, true, { [k]: "1" });
      u.out.error(new UsageError("Run 2 agent sessions needs confirmation", { suggestion: "coding.sh eval run s --yes", askUser: true }));
      assert.ok(u.err().includes(ASK_USER), `${k}: ${u.err()}`);
      assert.match(u.err(), /\n {4}With their approval: coding\.sh eval run s --yes\n$/, k);
    }
    // Set but empty names no agent: the person at the terminal is the user.
    const empty = capture(false, true, { AI_AGENT: "" });
    assert.equal(empty.out.interactive, true);
    assert.equal(empty.out.forAgent, false);
    empty.out.error(new CliError("x exists", { askUser: true, next: ["Overwrite it:", "coding.sh x --force"] }));
    assert.ok(!empty.err().includes(ASK_USER), empty.err());
  });
});

describe("requireConsent", () => {
  /** The context requireConsent reads: the flags and the output. */
  const ctx = (out: Output, flags: Record<string, unknown> = {}) => ({ flags, out }) as unknown as CommandContext;

  it("without a terminal or --yes: confirmation_required with askUser, telling the agent to ask", async () => {
    const { out } = capture(true);
    await assert.rejects(requireConsent(ctx(out), "Run 4 agent sessions?", "coding.sh eval run s --yes"), (e: unknown) => {
      assert.ok(e instanceof UsageError);
      assert.equal(e.reason, "confirmation_required");
      assert.equal(e.askUser, true);
      assert.equal(e.suggestion, "coding.sh eval run s --yes");
      assert.equal(e.message, "Run 4 agent sessions needs confirmation from the user");
      return true;
    });
    await requireConsent(ctx(out, { yes: true }), "Run 4 agent sessions?", "x");
  });

  it("at a terminal an agent runs: no prompt the agent could answer, the same confirmation_required", async () => {
    for (const k of AGENT_ENV) {
      const { out } = capture(false, true, { [k]: "1" });
      out.confirm = () => assert.fail(`${k}: asked at the agent's terminal`);
      await assert.rejects(requireConsent(ctx(out), "Run 4 agent sessions?", "coding.sh eval run s --yes"), (e: unknown) => {
        assert.ok(e instanceof UsageError, k);
        assert.equal(e.reason, "confirmation_required", k);
        assert.equal(e.askUser, true, k);
        return true;
      });
    }
    // A person at the terminal is asked.
    const { out } = capture(false, true);
    let asked = "";
    out.confirm = async (q: string) => ((asked = q), true);
    await requireConsent(ctx(out), "Run 4 agent sessions?", "x");
    assert.equal(asked, "Run 4 agent sessions?");
  });
});

describe("Output.spin", () => {
  /** stderr of a spinner started and stopped at a colored terminal, with the given env. */
  function spun(env: NodeJS.ProcessEnv, stdinTTY = true): string {
    let buf = "";
    const sink = { write: (s: string) => ((buf += s), true), isTTY: true } as unknown as NodeJS.WriteStream;
    const out = new Output({ json: false, env: { FORCE_COLOR: "1", ...env }, platform: "linux", stdout: sink, stderr: sink, stdin: { isTTY: stdinTTY } as NodeJS.ReadStream });
    out.spin("Reading sessions").stop();
    return buf;
  }

  it("draws frames for a person; one plain line in CI or under an agent, whose output is read back", () => {
    assert.match(spun({}), /^\r\S Reading sessions/);
    assert.match(spun({}, false), /^\r\S Reading sessions/, "a person piping stdin still sees the spinner");
    assert.equal(spun({ CI: "1" }), "  Reading sessions\n");
    for (const k of AGENT_ENV) assert.equal(spun({ [k]: "1" }), "  Reading sessions\n", k);
  });
});
