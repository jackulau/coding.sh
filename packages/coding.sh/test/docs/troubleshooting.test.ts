// docs/troubleshooting.md sorts every CLI error reason into "Usage errors (exit 2)" and
// "Errors (exit 1)". This reads each `new …Error(…)` in src and fails when a row names a
// reason the build never raises, or sits under an exit code the build never gives it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = join(pkg, "..", "..");
const DOC_PATH = join(repo, "docs", "troubleshooting.md");

interface Row {
  reasons: string[];
  /** Exit codes the row's own text gives, like `(exit 2)` or `(exp ab, exit 2)`. */
  stated: number[];
  line: string;
}

/** Rows of the reason table under `### <heading>`: | Reason | Example message | Fix |. */
function docRows(doc: string, heading: string): Row[] {
  const start = doc.indexOf(`\n### ${heading}\n`);
  assert.ok(start >= 0, `troubleshooting.md has a "### ${heading}" section`);
  const end = doc.indexOf("\n#", start + 1);
  const rows: Row[] = [];
  for (const line of doc.slice(start, end === -1 ? undefined : end).split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.replace(/^\||\|$/g, "").split(/(?<!\\)\|/);
    const reasons = [...cells[0]!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
    assert.ok(reasons.length, `row names a reason: ${line}`);
    // Outside code spans, so an example message like `npm install failed (exit 1): …` states nothing.
    const prose = cells.slice(1).join("|").replace(/(`+).*?\1/g, "");
    rows.push({ reasons, stated: [...prose.matchAll(/\((?:[^()]*, )?exit (\d+)\)/g)].map((m) => Number(m[1])), line });
  }
  return rows;
}

interface Call {
  cls: string;
  args: string;
  file: string;
  /** The source up to the call, for the `instanceof` that guards it. */
  before: string;
}

/** A call's arguments: from the `(` at `open` to the `)` that closes it, past quotes and template literals. */
function callArgs(text: string, open: number): string {
  const tpl: string[] = []; // "`" in a template's text, "{" in its ${…}
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    const top = tpl[tpl.length - 1];
    if (top === "`") {
      if (ch === "\\") i++;
      else if (ch === "`") tpl.pop();
      else if (ch === "$" && text[i + 1] === "{") tpl.push("{"), i++;
    } else if (ch === '"' || ch === "'") {
      for (i++; i < text.length && text[i] !== ch && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
    } else if (ch === "`") tpl.push("`");
    else if (ch === "{" && top === "{") tpl.push("{");
    else if (ch === "}" && top === "{") tpl.pop();
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Every source file under src, by its path from there. */
function sources(): Map<string, string> {
  const dir = join(pkg, "src");
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  return new Map(files.map((f) => [f.replaceAll("\\", "/"), readFileSync(join(dir, f), "utf8")]));
}

/** Every `new <Name>Error(…)` in src. */
function errorCalls(src: Map<string, string>): Call[] {
  const calls: Call[] = [];
  for (const [file, text] of src) {
    for (const m of text.matchAll(/\bnew (\w*Error)\(/g)) {
      calls.push({ cls: m[1]!, args: callArgs(text, m.index + m[0].length - 1), file, before: text.slice(Math.max(0, m.index - 400), m.index) });
    }
  }
  return calls;
}

/** The exit code the CLI gives an error built by this call (src/cli/output.ts `error()`), or undefined when it is not a CLI error. */
function cliExit(c: Call): number | undefined {
  if (c.cls === "UsageError") return 2;
  if (c.cls === "CliError") return Number(/\bexitCode: (\d+)/.exec(c.args)?.[1] ?? 1);
  return undefined;
}

/** Reason → the exit codes the CLI can end with when it reports that reason. */
function reasonExits(): Map<string, Set<number>> {
  const src = sources();
  const calls = errorCalls(src);
  const exits = new Map<string, Set<number>>();
  const add = (reason: string, code: number) => exits.set(reason, (exits.get(reason) ?? new Set()).add(code));

  // An error raised below the CLI with a reason of its own (QueryError, ForkError) leaves through the
  // CLI error that copies it: `if (e instanceof QueryError) … new CliError(…, { reason: e.reason, exitCode: 2 })`.
  const carried = new Map<string, Set<number>>();
  for (const c of calls) {
    const code = cliExit(c);
    const from = /\breason: (\w+)\.reason\b/.exec(c.args)?.[1];
    if (code === undefined || !from || !c.file.startsWith("cli/")) continue;
    const guard = [...c.before.matchAll(new RegExp(`\\b${from} instanceof (\\w+Error)\\b`, "g"))].pop()?.[1];
    if (guard && guard !== "CliError" && guard !== "UsageError") carried.set(guard, (carried.get(guard) ?? new Set()).add(code));
  }

  for (const c of calls) {
    const own = cliExit(c);
    const codes = own !== undefined ? [own] : [...(carried.get(c.cls) ?? [])];
    // `reason: "x"`, `reason: cond ? "x" : "y"`, or a carried class's positional reason: `new ForkError(message, "x")`.
    const reasons = [...c.args.matchAll(/\breason: ([^,}\n]*)/g)].flatMap((m) => [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!));
    const positional = own === undefined ? /,\s*"([a-z_]+)"\s*$/.exec(c.args)?.[1] : undefined;
    if (positional) reasons.push(positional);
    for (const reason of reasons) for (const code of codes) add(reason, code);
  }

  // A class's default reason: `this.reason = opts.reason ?? "invalid_usage"`.
  for (const [cls, codes] of [["UsageError", [2]], ["CliError", [1]], ...carried] as [string, Iterable<number>][]) {
    const text = [...src.values()].find((t) => t.includes(`export class ${cls} `)) ?? "";
    const at = text.indexOf(`export class ${cls} `);
    const fallback = /this\.reason = opts\.reason \?\? "([a-z_]+)"/.exec(text.slice(at, text.indexOf("\n}\n", at)))?.[1];
    if (fallback) for (const code of codes) add(fallback, code);
  }

  // A command that stops for the user's approval prints `status: "action_required"` and returns its own code.
  for (const [file, text] of src) {
    if (!file.startsWith("cli/")) continue;
    for (const m of text.matchAll(/status: "action_required", reason: "([a-z_]+)"/g)) {
      const code = /\n  return (\d+);\n/.exec(text.slice(m.index))?.[1];
      if (code) add(m[1]!, Number(code));
    }
  }
  return exits;
}

describe("docs/troubleshooting.md", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const exits = reasonExits();
  const tables: [string, number][] = [["Usage errors (exit 2)", 2], ["Errors (exit 1)", 1]];

  it("reads the error sites in src", () => {
    assert.ok(exits.size > 100, `found ${exits.size} reasons`);
    assert.deepEqual([...exits.get("unknown_command")!], [2], "a UsageError");
    assert.deepEqual([...exits.get("store_unavailable")!], [1], "a CliError");
    assert.deepEqual([...exits.get("no_diff")!], [2], "a CliError with exitCode: 2");
    assert.deepEqual([...exits.get("bad_value")!], [2], "a QueryError, carried by queryCliError");
    assert.deepEqual([...exits.get("bad_query")!], [2], "QueryError's default reason");
    assert.deepEqual([...exits.get("bad_step")!], [1], "a ForkError, carried by replay --fork");
    assert.deepEqual([...exits.get("invalid_usage")!], [2], "UsageError's default reason");
    assert.deepEqual([...exits.get("cost_confirmation_required")!], [2], "action_required, from the command itself");
  });

  it("reads both reason tables", () => {
    for (const [heading] of tables) assert.ok(docRows(doc, heading).length > 30, heading);
  });

  it("lists only reasons the build can report", () => {
    const unknown = tables.flatMap(([heading]) => docRows(doc, heading)).flatMap((r) => r.reasons).filter((r) => !exits.has(r));
    assert.deepEqual(unknown, [], `docs/troubleshooting.md lists reasons no CLI error in src has: ${unknown.join(", ")}`);
  });

  for (const [heading, tableCode] of tables) {
    it(`lists under "${heading}" only reasons that exit ${tableCode}`, () => {
      const wrong: string[] = [];
      for (const row of docRows(doc, heading)) {
        // A row that states a code of its own (`(exit 2)` in the exit-1 table) is checked against that too.
        const allowed = new Set([tableCode, ...row.stated]);
        for (const reason of row.reasons) {
          const codes = [...(exits.get(reason) ?? [])];
          if (codes.length && !codes.some((c) => allowed.has(c))) wrong.push(`${reason} (exits ${codes.join(" or ")})`);
        }
        for (const code of row.stated) {
          if (!row.reasons.some((r) => exits.get(r)?.has(code))) wrong.push(`${row.reasons.join(" / ")} (says exit ${code}; exits ${row.reasons.flatMap((r) => [...(exits.get(r) ?? [])]).join(" or ")})`);
        }
      }
      assert.deepEqual(wrong, [], `move these rows of docs/troubleshooting.md to the table for their exit code, or state the code in the row: ${wrong.join(", ")}`);
    });
  }

  it("lists each reason in one table", () => {
    const [usage, errors] = tables.map(([heading]) => new Set(docRows(doc, heading).flatMap((r) => r.reasons)));
    assert.deepEqual([...usage!].filter((r) => errors!.has(r)), []);
  });
});
