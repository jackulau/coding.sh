// Published installs get types for coding.sh/schema, coding.sh/store and
// coding.sh/store/conformance: every export's "types" target is a .d.ts that
// `files` ships and that tsconfig.types.json (run by `npm run build`) emits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

  // qa:eval-5: the changelog announced pairedDiscrimination and createWasteJudge, and no export reached them.
  it("coding.sh/judge exports the judge library functions the changelog and the guide name", async () => {
    const cond = pkg.exports["./judge"] as Record<string, string> | undefined;
    assert.ok(cond && typeof cond === "object", "exports['./judge'] exists");
    assert.deepEqual(Object.keys(cond), ["source", "types", "default"]);
    assert.equal(cond.default, "./dist/judge.mjs");
    assert.ok(pkg.files.includes("dist/*.mjs"), "files ships dist/judge.mjs");
    const entry = cond.source!.replace(/^\.\//, "");
    const lib = (await import(pathToFileURL(join(root, entry)).href)) as Record<string, unknown>;
    for (const name of ["pairedDiscrimination", "traceMutations", "formatDiscrimination", "createWasteJudge", "wasteGrader", "anthropicProvider", "openAICompatibleProvider"]) {
      assert.equal(typeof lib[name], "function", `${cond.source} exports ${name}`);
    }
    // The bundle and the declarations are built from the same entry file.
    assert.ok(readFileSync(join(root, "scripts/bundle.mjs"), "utf8").includes(`judge: "${entry}"`), "bundle.mjs builds dist/judge.mjs");
    const types = JSON.parse(readFileSync(join(root, "tsconfig.types.json"), "utf8").replace(/^\s*\/\/.*$/gm, "")) as { files: string[] };
    assert.ok(types.files.includes(entry), "tsconfig.types.json emits its declarations");
    assert.equal(cond.types, `./dist/types/${entry.replace(/^src\//, "").replace(/\.ts$/, ".d.ts")}`);
  });
});
