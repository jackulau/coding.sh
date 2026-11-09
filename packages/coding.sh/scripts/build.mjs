// npm run build: dist/cli.mjs, dist/hook.mjs, dist/hook.sh, dist/schema.mjs, dist/store*.mjs (see bundle.mjs),
// plus dist/types/**/*.d.ts for the published entry points (tsconfig.types.json).
// Type errors are `npm run typecheck`'s job (prepublishOnly runs it first); the build only
// fails when a declared `types` file was not emitted.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await bundle("dist");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const r = spawnSync(process.execPath, [tsc, "-p", "tsconfig.types.json"], { cwd: root, stdio: "inherit" });
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const missing = Object.values(pkg.exports).flatMap((c) => (typeof c === "object" && c.types && !existsSync(join(root, c.types)) ? [c.types] : []));
if (missing.length) {
  console.error(`build: declarations not emitted: ${missing.join(", ")}`);
  process.exit(1);
}
if (r.status !== 0) console.error("build: tsc reported type errors (declarations were still emitted; run npm run typecheck)");
console.log("built dist/cli.mjs, dist/hook.mjs, dist/hook.sh, dist/schema.mjs, dist/store.mjs and dist/types");
