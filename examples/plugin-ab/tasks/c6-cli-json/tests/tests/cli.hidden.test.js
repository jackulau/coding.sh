const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cli = path.join(__dirname, "..", "cli.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-"));
fs.writeFileSync(path.join(dir, "a.txt"), "1\n2\n3");
fs.mkdirSync(path.join(dir, "sub"));
fs.writeFileSync(path.join(dir, "sub", "b.txt"), "1\n2\n3\n4\n5");
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });
test("text output unchanged", () => {
  assert.equal(run("stats", dir), `files: 2\nlines: 8\nlargest: ${path.join("sub", "b.txt")}\n`);
});
test("--json before or after the dir", () => {
  for (const args of [["stats", dir, "--json"], ["stats", "--json", dir]]) {
    assert.deepEqual(JSON.parse(run(...args)), { files: 2, lines: 8, largest: path.join("sub", "b.txt") });
  }
});
