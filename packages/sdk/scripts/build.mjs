// Builds dist/ (ESM .js + .d.ts) from src/ with tsc. Runs on `npm run build`
// and on `prepare` (with --soft, so a failed build never fails an install).
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const soft = process.argv.includes("--soft");
let tsc;
try {
  tsc = createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
} catch {
  console.warn("@coding.sh/sdk: typescript is not installed, skipping build");
  process.exit(0);
}
rmSync(join(root, "dist"), { recursive: true, force: true });
const r = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
if (r.status !== 0 && soft) {
  console.warn("@coding.sh/sdk: build failed (run `npm run build -w @coding.sh/sdk`)");
  process.exit(0);
}
process.exit(r.status ?? 1);
