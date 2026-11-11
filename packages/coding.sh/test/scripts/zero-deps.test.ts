import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

const PKG = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const BUILTIN = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

/** The package names a source file imports: bare specifiers that are not `node:` built-ins. */
export function scanner(source: string): string[] {
  const found: string[] = [];
  // Statements start a line (so a string or a comment that says "from 'x'" is not an import);
  // a dynamic import or require must be called with a literal.
  const re = /^[ \t]*(?:import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s+from\s*["']([^"']+)["']|^[ \t]*import[ \t]*["']([^"']+)["']|\b(?:await\s+import|require)\s*\(\s*["']([^"']+)["']\s*\)/gm;
  for (const m of source.matchAll(re)) {
    const spec = (m[1] ?? m[2] ?? m[3])!;
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    if (spec.startsWith("node:") || BUILTIN.has(spec.split("/")[0]!)) continue;
    found.push(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
  }
  return found;
}

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(?:ts|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) yield p;
  }
}

// Text that coding.sh writes into an agent's plugin file, resolved by the agent, never by us.
const HOST_PROVIDED = new Set(["src/adapters/opencode.ts: @opencode/plugin"]);

describe("zero runtime dependencies", () => {
  it("the scanner finds a package import and skips built-ins and local files", () => {
    assert.deepEqual(scanner('import x from "chalk"'), ["chalk"]);
    assert.deepEqual(scanner('import { y } from "@scope/pkg/sub"; const z = await import("left-pad")'), ["@scope/pkg", "left-pad"]);
    assert.deepEqual(scanner('import fs from "node:fs"; import p from "path"; import q from "fs/promises"; import l from "./local.ts"'), []);
  });

  it("package.json lists no dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  });

  it("src imports only node: built-ins and local files", () => {
    const bad: string[] = [];
    for (const file of sources(join(PKG, "src"))) {
      for (const dep of scanner(readFileSync(file, "utf8"))) {
        const found = `${file.slice(PKG.length)}: ${dep}`;
        if (!HOST_PROVIDED.has(found)) bad.push(found);
      }
    }
    assert.deepEqual(bad, []);
  });
});
