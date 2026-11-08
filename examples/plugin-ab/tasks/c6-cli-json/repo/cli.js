#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function stats(dir) {
  const files = walk(dir);
  let lines = 0;
  let largest = null;
  let max = -1;
  for (const f of files) {
    const n = fs.readFileSync(f, "utf8").split("\n").length;
    lines += n;
    if (n > max) { max = n; largest = path.relative(dir, f); }
  }
  return { files: files.length, lines, largest };
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "stats") {
  const dir = rest[0] || ".";
  const s = stats(dir);
  console.log(`files: ${s.files}`);
  console.log(`lines: ${s.lines}`);
  console.log(`largest: ${s.largest}`);
} else {
  console.error("usage: cli.js stats [dir]");
  process.exit(2);
}
