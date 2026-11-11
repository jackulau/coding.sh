// Every example in the registry (and in the workflows and bench specs it pulls
// in) is a command line a user will paste. Each one must parse against its own
// command's flags: no unknown option, no flag missing its short form.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../../src/cli/args.ts";
import { COMMANDS, findCommand, type ActionSpec, type CommandSpec } from "../../src/cli/registry.ts";

/** Shell-style split: single and double quotes group, backslash escapes inside double quotes. */
export function words(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === q) q = undefined;
      else if (ch === "\\" && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

interface Example {
  where: string;
  line: string;
  cmd: CommandSpec;
  action?: ActionSpec;
}

function examples(): Example[] {
  const all: Example[] = [];
  for (const cmd of COMMANDS) {
    for (const line of cmd.examples ?? []) all.push({ where: cmd.name, line, cmd });
    for (const a of cmd.actions ?? []) for (const line of a.examples ?? []) all.push({ where: `${cmd.name} ${a.name}`, line, cmd, action: a });
  }
  return all;
}

describe("registry examples parse", () => {
  const list = examples();
  it("finds examples to check", () => assert.ok(list.length > 50));
  it("examples use coding.sh itself, never a made-up company", () => {
    assert.deepEqual(list.filter((e) => /acme/i.test(e.line)).map((e) => e.line), []);
  });
  for (const ex of list) {
    it(`${ex.where}: ${ex.line}`, () => {
      // Pipelines and chains show a second command; check the first one.
      const first = ex.line.split(/\s(?:\|\||&&|\|)\s/)[0]!;
      // A redirect is the shell's, and a trailing … stands for the rest of an id.
      const raw = words(first);
      const w = (raw.includes(">") ? raw.slice(0, raw.indexOf(">")) : raw).map((t) => t.replace(/…$/, "0000000000"));
      if (w[0] !== "coding.sh") return; // not a coding.sh command line (npx, a script)
      const named = findCommand(w[1] ?? "");
      assert.ok(named, `unknown command in: ${ex.line}`);
      let tail = w.slice(2);
      let action: ActionSpec | undefined;
      if (named.actions && !(named.actionOptional && (tail[0] === undefined || tail[0].startsWith("-")))) {
        action = named.actions.find((a) => a.name === tail[0]);
        assert.ok(action, `unknown action ${tail[0]} in: ${ex.line}`);
        tail = tail.slice(1);
      }
      const args = action ? (action.args ?? []) : (named.args ?? []);
      const flags = action ? (action.flags ?? []) : (named.flags ?? []);
      const variadic = args.some((a) => a.variadic) && !named.passthrough;
      // Global flags (--json, --help …) are handled before the command's own.
      const own = tail.filter((t) => !["--json", "--no-color", "--quiet", "--debug", "--help", "-h"].includes(t));
      parseArgs(own, flags, { maxPositionals: named.passthrough ? 0 : variadic ? undefined : args.length });
    });
  }
});
