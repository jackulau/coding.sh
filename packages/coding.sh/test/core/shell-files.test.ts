import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shellCallFiles, shellWrittenPaths, writtenFileKey } from "../../src/core/shell-files.ts";

describe("shellWrittenPaths", () => {
  it("names redirect, tee, sed -i, perl -i, cp and mv targets", () => {
    assert.deepEqual(shellWrittenPaths("echo a > a.txt; echo b >> logs/b.log; echo c | tee -a c.md"), ["a.txt", "logs/b.log", "c.md"]);
    assert.deepEqual(shellWrittenPaths("sed -i.bak -e 's/x/y/' src/a.ts && perl -pi -e 's/x/y/' b.pl"), ["src/a.ts", "b.pl"]);
    assert.deepEqual(shellWrittenPaths("cp a.ts b.ts; mv c.ts d/e.ts"), ["b.ts", "d/e.ts"]);
    assert.deepEqual(shellWrittenPaths("cd pkg && echo x > out.txt"), ["pkg/out.txt"]);
  });

  it("leaves out reads, deletes, devices, fd dups, globs, variables and branch names", () => {
    assert.deepEqual(shellWrittenPaths("cat a.ts; sed -n 1p b.ts; grep x c.ts 2>&1 > /dev/null; rm d.ts"), []);
    assert.deepEqual(shellWrittenPaths('echo x > "$F"; sed -i s/a/b/ *.ts; echo y > out/'), []);
    assert.deepEqual(shellWrittenPaths("git checkout release/1.2 && git restore src/a.ts"), []);
    assert.deepEqual(shellWrittenPaths("git restore -- src/a.ts"), ["src/a.ts"]);
  });

  it("reads PowerShell writers and backslash redirects", () => {
    assert.deepEqual(shellWrittenPaths("Set-Content -Path a.txt -Value 'x'", true), ["a.txt"]);
    assert.deepEqual(shellWrittenPaths("Set-Content -Value 'x' -Encoding utf8 b.txt", true), ["b.txt"]);
    assert.deepEqual(shellWrittenPaths("'x' | Out-File -FilePath:out\\c.txt -Encoding utf8", true), ["out/c.txt"]);
    assert.deepEqual(shellWrittenPaths("Add-Content -LiteralPath d.md 'y'; Get-Content e.txt > src\\f.txt", true), ["d.md", "src/f.txt"]);
    assert.deepEqual(shellWrittenPaths("Out-File $env:TEMP\\x.txt; Set-Content -Path NUL -Value x", true), []);
  });
});

describe("writtenFileKey", () => {
  it("keys a path relative to the cwd, or drops it outside", () => {
    assert.equal(writtenFileKey("/work/demo/src/a.ts", "/work/demo"), "src/a.ts");
    assert.equal(writtenFileKey("./src/../a.ts", "/work/demo"), "a.ts");
    assert.equal(writtenFileKey("C:\\work\\demo\\a.ts", "C:\\work\\demo"), "a.ts");
    assert.equal(writtenFileKey("a.txt", "/work/demo", "/work/demo/pkg"), "pkg/a.txt");
    assert.equal(writtenFileKey("/tmp/x.log", "/work/demo"), undefined);
    assert.equal(writtenFileKey("../other/a.ts", "/work/demo"), undefined);
    assert.equal(writtenFileKey("~/.bashrc", "/work/demo"), undefined);
  });
});

describe("shellCallFiles", () => {
  it("reads shell tools only", () => {
    assert.deepEqual(shellCallFiles("Bash", { command: "echo x > a.txt" }, "/w"), ["a.txt"]);
    assert.deepEqual(shellCallFiles("exec_command", { cmd: ["bash", "-lc", "echo x > a.txt"] }, "/w"), ["a.txt"]);
    assert.deepEqual(shellCallFiles("Read", { command: "echo x > a.txt" }, "/w"), []);
    assert.deepEqual(shellCallFiles("exec", { command: "echo x > a.txt", shell_id: "default" }, "/w"), ["a.txt"], "Devin CLI's shell");
    assert.deepEqual(shellCallFiles("exec", { code: "echo x > a.txt" }, "/w"), [], "an exec with no command line");
    assert.deepEqual(shellCallFiles(undefined, { command: "echo x > a.txt" }, "/w"), []);
  });
});
