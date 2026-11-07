// npm run build: dist/cli.mjs, dist/hook.mjs, dist/schema.mjs (see bundle.mjs).
import { bundle } from "./bundle.mjs";

await bundle("dist");
console.log("built dist/cli.mjs, dist/hook.mjs, dist/schema.mjs");
