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
    assert.ok(reasons.size > 20, "found the reasons");
    const missing = [...reasons].filter((r) => !doc.includes(`\`${r}\``));
    assert.deepEqual(missing, [], `add these reasons to docs/troubleshooting.md: ${missing.join(", ")}`);
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
