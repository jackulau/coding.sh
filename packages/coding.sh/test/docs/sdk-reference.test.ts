// docs/reference/sdk.md is generated from packages/sdk and packages/sdk-python. This
// fails when an SDK export, signature, docstring or env var changes and the doc was
// not regenerated.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pyNamed, pyOtel, pyPublic, renderSdkReference, SDK_REFERENCE_PATH, tsExports } from "../../scripts/sdk-reference.ts";

const repo = new URL("../../../../", import.meta.url);

describe("docs/reference/sdk.md", () => {
  const doc = readFileSync(SDK_REFERENCE_PATH, "utf8");

  it("matches the SDK sources", () => {
    assert.ok(doc === renderSdkReference(), "docs/reference/sdk.md is stale. Regenerate it: node packages/coding.sh/scripts/sdk-reference.ts");
  });

  it("documents every TypeScript export", () => {
    // Read the export list straight from index.ts, so a parser bug cannot hide a name.
    const index = readFileSync(new URL("packages/sdk/src/index.ts", repo), "utf8");
    const names = [...index.matchAll(/^export (?:type )?\{([^}]+)\}/gm)].flatMap((m) => m[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!));
    assert.ok(names.length >= 10, "found the exports");
    assert.deepEqual(tsExports().map((e) => e.name).sort(), [...names].sort());
    for (const n of names) assert.ok(doc.includes(`### \`${n}`), `### heading for ${n}`);
  });

  it("documents every public Python name", () => {
    const init = readFileSync(new URL("packages/sdk-python/src/coding_sh/__init__.py", repo), "utf8");
    const all = [...init.match(/^__all__\s*=\s*\[([\s\S]*?)\]/m)![1]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
    assert.ok(all.length >= 8, "found __all__");
    assert.deepEqual(pyPublic().map((a) => a.name), all);
    for (const n of all) assert.ok(doc.includes(`### \`coding_sh.${n}`), `### heading for coding_sh.${n}`);
    for (const a of pyOtel()) assert.ok(doc.includes(`### \`coding_sh.otel.${a.name}`), `### heading for coding_sh.otel.${a.name}`);
  });

  it("documents every parameter and env var", () => {
    for (const e of tsExports()) {
      for (const p of e.params) assert.ok(doc.includes(`\`${p.name}\``), `${e.name} parameter ${p.name}`);
      for (const f of e.fields) assert.ok(doc.includes(`| \`${f.name}\` |`), `${e.name}.${f.name}`);
    }
    for (const a of [...pyPublic(), ...pyOtel()]) for (const p of pyNamed(a)) assert.ok(doc.includes(`\`${p.name}\``), `${a.name} parameter ${p.name}`);
    for (const v of ["CODING_SH_URL", "CODING_SH_INGEST_KEY", "CODING_SH_SERVICE", "CODING_SH_CAPTURE_MODE", "CODING_SH_DISABLED", "CODING_SH_DEBUG"]) {
      assert.ok(doc.includes(`| \`${v}\` | yes | yes |`), `${v} read by both SDKs`);
    }
  });
});
