// Published installs get types for coding.sh/schema, coding.sh/store and
// coding.sh/store/conformance: every export's "types" target is a .d.ts that
// `files` ships and that tsconfig.types.json (run by `npm run build`) emits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, string | Record<string, string>>;
  files: string[];
};
const out = mkdtempSync(join(tmpdir(), "csh-types-"));
after(() => rmSync(out, { recursive: true, force: true }));

describe("package types", () => {
  const typed = Object.entries(pkg.exports).filter((e): e is [string, Record<string, string>] => typeof e[1] === "object");

  it("points every code export at a shipped dist/types declaration, never at src/", () => {
    for (const sub of ["./schema", "./store", "./store/conformance"]) assert.ok(typed.some(([k]) => k === sub), `${sub} has a conditions object`);
    assert.ok(pkg.files.includes("dist/types/**/*.d.ts"), "files ships the declarations");
    for (const [sub, cond] of typed) {
      assert.match(cond.types ?? "", /^\.\/dist\/types\/.+\.d\.ts$/, `${sub} types`);
      assert.ok(Object.keys(cond).indexOf("types") < Object.keys(cond).indexOf("default"), `${sub}: types before default`);
    }
  });

  it("emits each declared types file from tsconfig.types.json", () => {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.types.json", "--outDir", out], { cwd: root, stdio: "pipe" });
    for (const [sub, cond] of typed) {
      const file = join(out, cond.types!.replace(/^\.\/dist\/types\//, ""));
      assert.ok(existsSync(file), `${sub}: ${cond.types} is emitted`);
    }
    assert.match(readFileSync(join(out, "store/plugin-api.d.ts"), "utf8"), /IndexStore/);
  });
});
