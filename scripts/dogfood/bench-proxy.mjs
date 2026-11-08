#!/usr/bin/env node
// What `coding.sh proxy` adds per streamed chunk and to time to first byte; the implementation lives in bench.mjs.
import { runBenches } from "./bench.mjs";
const r = await runBenches(["proxy"]);
process.stdout.write(JSON.stringify(r, null, 2) + "\n");
process.exitCode = Object.keys(r.errors).length ? 1 : 0;
