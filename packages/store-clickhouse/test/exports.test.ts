// Guard: this plugin builds against `coding.sh/store` and tests against
// `coding.sh/store/conformance`. If a package.json rewrite drops either export,
// fail here with a clear message instead of a confusing resolve error.
// Reads package.json only, so it runs even when the exports are missing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "node:test";

it("coding.sh exports ./store and ./store/conformance for store plugins", () => {
  const pkgPath = createRequire(import.meta.url).resolve("coding.sh/package.json");
  const exports = JSON.parse(readFileSync(pkgPath, "utf8")).exports ?? {};
  for (const sub of ["./store", "./store/conformance"]) {
    assert.ok(exports[sub], `${pkgPath} is missing the "${sub}" export. Store plugins (coding.sh-store-postgres, coding.sh-store-clickhouse, coding.sh-store-s3) need it; see docs/PRODUCTION.md §3.1.`);
  }
});
