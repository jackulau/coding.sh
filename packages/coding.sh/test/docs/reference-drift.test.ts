// docs/troubleshooting.md lists every CLI error reason, and docs/reference/config.md
// every CODING_SH_* environment variable. These fail when code adds one the docs miss.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = join(pkg, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|mjs|js|py)$/.test(f) && !f.endsWith(".d.ts"))
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

function matches(texts: string[], re: RegExp): Set<string> {
  const found = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(re)) found.add(m[1]!);
  return found;
}

describe("docs drift", () => {
  it("troubleshooting.md lists every CLI error reason", () => {
    const doc = readFileSync(join(repo, "docs", "troubleshooting.md"), "utf8");
    const reasons = matches(sources(join(pkg, "src", "cli")), /reason: "([a-z_]+)"/g);
    // --where errors (src/query/where.ts) reach the CLI with their own reasons.
    for (const r of matches([readFileSync(join(pkg, "src", "query", "where.ts"), "utf8")], /reason(?::| =| \?\?) "([a-z_]+)"/g)) reasons.add(r);
    assert.ok(reasons.size > 20, "found the reasons");
    const missing = [...reasons].filter((r) => !doc.includes(`\`${r}\``));
    assert.deepEqual(missing, [], `add these reasons to docs/troubleshooting.md: ${missing.join(", ")}`);
  });

  it("the grader field reference lists every grader kind and its fields", () => {
    const doc = readFileSync(join(repo, "docs", "guides", "evals.md"), "utf8");
    const table = doc.slice(doc.indexOf("### Grader fields"), doc.indexOf("### Regrade"));
    const rows = new Map([...table.matchAll(/^\| `([a-z-]+)` \| (.*)$/gm)].map((m) => [m[1]!, m[2]!]));
    const graders = join(pkg, "src", "graders");
    const kinds = matches([readFileSync(join(graders, "index.ts"), "utf8")], /case "([a-z-]+)":/g);
    kinds.add("llm-checklist");
    assert.ok(kinds.size >= 14, "found the kinds");
    assert.deepEqual([...kinds].filter((k) => !rows.has(k)), [], "add these kinds to Grader fields in docs/guides/evals.md");
    // Each built-in or external spec's fields, by kind, with the fields of the spec it extends.
    const src = [...["builtin.ts", "external.ts", "proc.ts"].map((f) => join(graders, f)), join(pkg, "src", "toolevals", "calls.ts")].map((f) => readFileSync(f, "utf8")).join("\n");
    const fieldsOf = (body: string) => [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!).filter((f) => f !== "kind" && f !== "name");
    const parentFields = (name: string) => fieldsOf(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src)![1]!);
    let specs = 0;
    for (const m of src.matchAll(/export interface \w+Spec(?: extends (\w+))? \{\n\s{2}kind: "([a-z-]+)";([\s\S]*?)\n\}/g)) {
      specs++;
      const kind = m[2]!;
      const fields = [...fieldsOf(m[3]!), ...(m[1] ? parentFields(m[1]) : [])];
      const missing = fields.filter((f) => !rows.get(kind)?.includes(`\`${f}\``));
      assert.deepEqual(missing, [], `add these ${kind} fields to Grader fields in docs/guides/evals.md`);
    }
    assert.equal(specs, 13, "every built-in and external spec was checked");
  });

  it("the MCP docs list every MCP tool", () => {
    const tools = matches([readFileSync(join(pkg, "src", "mcp", "tools.ts"), "utf8")], /^\s{6}name: "([a-z_]+)",$/gm);
    assert.ok(tools.size >= 10, "found the tools");
    for (const file of [join(repo, "apps", "site", "src", "pages", "docs", "mcp.astro"), join(repo, "docs", "guides", "explore.md")]) {
      const doc = readFileSync(file, "utf8");
      const listed = matches([doc], /(?:\["|`)([a-z_]+)(?:",|`)/g);
      const missing = [...tools].filter((t) => !listed.has(t));
      assert.deepEqual(missing, [], `add these MCP tools to ${file}: ${missing.join(", ")}`);
    }
  });

  it("reference/config.md lists every CODING_SH_* variable", () => {
    const doc = readFileSync(join(repo, "docs", "reference", "config.md"), "utf8");
    const dirs = [join(pkg, "src"), join(repo, "packages", "sdk", "src"), join(repo, "packages", "sdk-python")];
    const texts = dirs.flatMap((d) => {
      try {
        return sources(d);
      } catch {
        return [];
      }
    });
    // CODING_SH_IDENTITY is internal; __CODING_SH_VERSION__ is a build-time constant (no word boundary).
    const vars = [...matches(texts, /\b(CODING_SH_[A-Z_]*[A-Z])\b/g)].filter((v) => v !== "CODING_SH_IDENTITY");
    assert.ok(vars.length > 20, "found the variables");
    const missing = vars.filter((v) => !doc.includes(v));
    assert.deepEqual(missing, [], `add these variables to docs/reference/config.md: ${missing.join(", ")}`);
  });
});
