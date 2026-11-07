// npm run build: dist/index.mjs. `pg` stays external (the one runtime dep); the
// shared helpers from `coding.sh/store` are bundled in, so the plugin loads next
// to any coding.sh install (global, npx, or the Docker image) without needing
// the core package to be resolvable from here at runtime.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(resolve(root, "dist"), { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { index: "src/index.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["pg"],
  // Bundle coding.sh/store from its TypeScript source, so building the plugin never depends on a stale core dist/.
  conditions: ["source"],
  legalComments: "none",
  logLevel: "warning",
});
console.log("built dist/index.mjs");
