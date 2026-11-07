// Bundles the CLI, the hook, and the schema into dependency-free ESM files.
// The published package has zero runtime dependencies: `npx coding.sh` downloads
// one tarball and starts immediately. Used by build.mjs and by the CLI tests
// (which bundle into a temp dir so they never depend on a stale dist/).
import { build } from "esbuild";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} outdir absolute or package-relative output directory */
export async function bundle(outdir = "dist") {
  const out = resolve(root, outdir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const common = {
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    outExtension: { ".js": ".mjs" },
    outdir: out,
    // node: builtins stay external automatically on platform=node.
  };
  await Promise.all([
    build({
      ...common,
      entryPoints: { cli: "src/cli/main.ts" },
      // Command modules load through dynamic import() after dispatch; splitting
      // keeps them out of cli.mjs so `--help` parses a few KB, not the whole
      // tool. Chunks sit next to cli.mjs so `new URL("./hook.mjs", import.meta.url)`
      // still resolves from any of them.
      splitting: true,
      chunkNames: "chunk-[hash]",
      define: { __CODING_SH_VERSION__: JSON.stringify(pkg.version) },
      banner: { js: "#!/usr/bin/env node" },
      loader: { ".html": "text", ".css": "text" },
    }),
    build({ ...common, entryPoints: { hook: "src/spool/hook.ts" }, banner: { js: "#!/usr/bin/env node" }, minify: true }),
    build({ ...common, entryPoints: { schema: "src/schema/index.ts" } }),
    // Store plugin API (`coding.sh/store`, `coding.sh/store/conformance`):
    // plugins bundle these helpers in, so they load next to any install.
    build({ ...common, entryPoints: { store: "src/store/plugin-api.ts", "store-conformance": "src/store/conformance.ts" } }),
  ]);
  chmodSync(join(out, "cli.mjs"), 0o755);
  chmodSync(join(out, "hook.mjs"), 0o755);
  return { cli: join(out, "cli.mjs"), hook: join(out, "hook.mjs"), schema: join(out, "schema.mjs"), store: join(out, "store.mjs") };
}
