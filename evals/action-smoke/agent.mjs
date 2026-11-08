// A stand-in agent for the GitHub Action smoke test: reads one arithmetic
// expression as JSON on stdin and prints the result. If a file named BREAK
// sits next to it, it gets multiplication wrong, which the smoke workflow uses
// to check that the action catches a regression.
import { existsSync } from "node:fs";

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const expr = String(JSON.parse(raw));
  if (!/^[\d\s+\-*/().]+$/.test(expr)) throw new Error(`not arithmetic: ${expr}`);
  let result = Function(`"use strict"; return (${expr});`)();
  if (expr.includes("*") && existsSync(new URL("BREAK", import.meta.url))) result += 1;
  process.stdout.write(String(result));
});
