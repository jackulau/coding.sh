// npm run build: dist/index.mjs. `pg` stays external (the one runtime dep); the
// shared helpers from `coding.sh/store` are bundled in, so the plugin loads next
// to any coding.sh install (global, npx, or the Docker image) without needing
// the core package to be resolvable from here at runtime.
//
// Also runs on `prepare` (with --soft), so `npm ci` in a checkout leaves a
// loadable plugin behind: the workspace symlink points at dist/, and without it
// `--store postgres://` fails with store_unavailable. --soft never fails an
// install (missing esbuild or a build error only warns).
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const soft = process.argv.includes("--soft");

function giveUp(why) {
  if (!soft) throw why;
  console.warn(`coding.sh-store-postgres: ${why instanceof Error ? why.message : why}; skipping build (run \`npm run build -w coding.sh-store-postgres\`)`);
  process.exit(0);
}

let build;
try {
  ({ build } = await import("esbuild"));
} catch {
  giveUp("esbuild is not installed");
}

rmSync(resolve(root, "dist"), { recursive: true, force: true });
try {
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
} catch (err) {
  giveUp(err);
}
console.log("built dist/index.mjs");
