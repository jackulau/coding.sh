#!/usr/bin/env node
// docs/design/dogfood.md §3.5 entry point; the implementation lives in bench.mjs.
import { runBenches } from "./bench.mjs";
const r = await runBenches(["viewer"]);
process.stdout.write(JSON.stringify(r, null, 2) + "\n");
process.exitCode = Object.keys(r.errors).length ? 1 : 0;
