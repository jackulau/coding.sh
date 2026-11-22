// Which part of a compound shell line failed, on commands and outputs shaped
// like the ones agents run (Claude Code's "Exit code N" first line included).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failingPart, launchedCommand, partOutput, shellParts } from "../../src/core/failing-command.ts";
import { COMPOUND, failureRecords, rankIssues } from "../../src/improve/issues.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { sessionEvents } from "../helpers-decision.ts";

const head = (cmd: string, output: string, exitCode?: number) => failingPart(cmd, { output, ...(exitCode !== undefined ? { exitCode } : {}) })?.argv.slice(0, 2).join(" ");

describe("shellParts", () => {
  it("drops keywords, loop headers, assignments, redirects and wrappers", () => {
    const progs = (cmd: string) => shellParts(cmd).map((p) => p.prog);
    assert.deepEqual(progs("for f in src/*.py; do python3 -m py_compile \"$f\"; done"), ["python3"]);
    assert.deepEqual(progs("cd /work/demo && RUST_LOG=debug cargo build 2>&1 | tail -20"), ["cd", "cargo", "tail"]);
    assert.deepEqual(progs("export PATH=\"$HOME/.cargo/bin:$PATH\" CI=1; timeout 60 sed -n '1,5p' a.txt"), ["export", "sed"]);
    assert.deepEqual(progs("if [ -f x ]; then make; else echo none; fi"), ["[", "make", "echo"]);
    assert.deepEqual(progs("sudo -u app env FOO=1 nohup ./bin/server --port 3000 > /tmp/log 2>&1 &"), ["server"]);
    assert.deepEqual(progs("git ls-files | xargs -n 1 -I {} wc -l {}"), ["git", "wc"]);
  });

  it("joins line continuations, so a flag on the next line is not a command", () => {
    const parts = shellParts("coding.sh show \\\n  --session abc \\\n  --json");
    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.prog, "coding.sh");
    assert.deepEqual(parts[0]!.argv, ["coding.sh", "show", "--session", "abc", "--json"]);
  });

  it("does not split inside quotes, substitutions or a heredoc body", () => {
    const progs = (cmd: string) => shellParts(cmd).map((p) => p.prog);
    assert.deepEqual(progs("grep -E 'a|b; c && d' file.txt"), ["grep"]);
    assert.deepEqual(progs('echo "$(date; whoami)" && make test'), ["echo", "make"]);
    assert.deepEqual(progs("cat > notes.md <<'EOF'\n--session x\nexport FOO=1 && rm -rf /\nEOF\ngit add notes.md"), ["cat", "git"]);
  });
});

describe("launchedCommand", () => {
  it("reads the command a PowerShell launcher runs, and leaves any other line alone", () => {
    assert.equal(launchedCommand("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command rg -n x | Select-Object -First 5"), "rg -n x | Select-Object -First 5");
    assert.equal(launchedCommand('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -c "npm test"'), "npm test");
    assert.equal(launchedCommand("pwsh -NoLogo -Command Get-ChildItem"), "Get-ChildItem");
    for (const cmd of ["npm test -- -c x", "grep -c foo a.txt", "powershell.exe script.ps1 -Command x", "bash -c 'ls'"]) assert.equal(launchedCommand(cmd), cmd);
    assert.deepEqual(shellParts("powershell.exe -Command .\\tool.exe run; git status").map((p) => p.prog), ["tool.exe", "git"]);
  });
});

describe("failingPart", () => {
  it("files a cargo error under cargo, not the cat before it", () => {
    const out = "Exit code 101\n[package]\nname = \"demo\"\n   Compiling demo v0.1.0\nerror[E0425]: cannot find value `x` in this scope\n --> src/main.rs:2:5\nerror: could not compile `demo`";
    assert.equal(head("cat Cargo.toml && cargo build --release", out), "cargo build");
  });

  it("files a Python warning in a for loop under python", () => {
    const out = "Exit code 1\n/work/demo/a.py:3: DeprecationWarning: invalid escape sequence '\\d'\n  re.compile('\\d+')";
    assert.equal(head("for f in *.py; do python3 \"$f\" --check; done", out), "python3 \"$f\"");
  });

  it("files a timeout (exit 124) under the command timeout ran", () => {
    assert.equal(head("sed -n '1,20p' README.md && timeout 30 npm run e2e", "Exit code 124\n# Quickstart\n...", 124), "npm run");
  });

  it("files an error that names its tool under that tool", () => {
    assert.equal(head("cd /work/demo && cat missing.txt && npm test", "Exit code 1\ncat: missing.txt: No such file or directory"), "cat missing.txt");
    assert.equal(head("ls && fooctl status", "Exit code 127\nREADME.md\n(eval):1: command not found: fooctl"), "fooctl status");
    assert.equal(head("cd packages/web && pnpm build", "Exit code 1\n(eval):cd:1: no such file or directory: packages/web"), "cd packages/web", "zsh");
    assert.equal(head("cd packages/web && pnpm build", "Exit code 1\nbash: line 1: cd: packages/web: No such file or directory"), "cd packages/web");
  });

  it("only the last part of a pipeline sets its status; a self-naming tool the error skips did not fail", () => {
    assert.equal(head("npm run lint 2>&1 | grep -c warning", "Exit code 1\n"), "grep -c", "grep exits 1 on no match, silently");
    assert.equal(head("sleep 20 && gh run view 123 --log-failed | tail -50", "Exit code 1\nrun 123 is still in progress"), "gh run");
    assert.equal(head("ls dist && node scripts/check.mjs", "Exit code 1\ncheck failed: 3 files over budget"), "node scripts/check.mjs");
  });

  it("returns nothing when the evidence leaves more than one part", () => {
    assert.equal(head("npm install && npm run build", "Exit code 1\nsomething went wrong"), undefined);
    assert.equal(head("make && ./bin/app --selftest", "Exit code 2\nboom"), undefined);
  });
});

describe("failureRecords on compound commands", () => {
  const CWD = "/work/demo";
  const T0 = 1_790_000_000_000;
  const session = (id: string, steps: Parameters<typeof sessionEvents>[2]) => sessionEvents(id, { cwd: CWD, startedAt: T0 }, steps);

  it("groups by the failing part, and calls an unclear one a compound command", () => {
    const recs = failureRecords(
      session("a", [
        ["tool.start", { tool: "Bash", toolUseId: "1", input: { command: "cat Cargo.toml && cargo build" } }],
        ["tool.end", { tool: "Bash", toolUseId: "1", ok: false, output: "Exit code 101\nerror[E0425]: cannot find value `x`" }],
        ["tool.start", { tool: "Bash", toolUseId: "2", input: { command: "npm install && npm run build" } }],
        ["tool.end", { tool: "Bash", toolUseId: "2", ok: false, output: "Exit code 1\nsomething went wrong" }],
      ]),
    );
    // The unclear one is keyed on its exit status: the output's text never makes an id.
    assert.deepEqual(recs.map((r) => [r.key, r.label]), [
      ["cmd:cargo build", "cargo build"],
      ["compound:exit 1", COMPOUND],
    ]);
  });

  it("keys a PowerShell launcher line on the program, never the launcher or a pipeline cmdlet", () => {
    const recs = failureRecords(
      session("a", [
        ["tool.start", { tool: "Bash", toolUseId: "1", input: { command: 'powershell -NoProfile -Command "npm test | Select-Object -Last 20"' } }],
        ["tool.end", { tool: "Bash", toolUseId: "1", ok: false, output: "Exit code 1\n# tests 4\n# fail 2" }],
      ]),
    );
    assert.deepEqual(recs.map((r) => r.key), ["cmd:npm test"]);
  });

  it("parses a PowerShell tool's command as PowerShell: `Get-ChildItem x | Out-String` is keyed on Get-ChildItem", () => {
    const recs = failureRecords(
      session("a", [
        ["tool.start", { tool: "PowerShell", toolUseId: "1", input: { command: "Get-ChildItem x | Out-String" } }],
        ["tool.end", { tool: "PowerShell", toolUseId: "1", ok: false, output: "Get-ChildItem : Cannot find path 'C:\\work\\demo\\x' because it does not exist.\nAt line:1 char:1" }],
      ]),
    );
    assert.deepEqual(recs.map((r) => [r.key, r.sample]), [["cmd:Get-ChildItem", "Get-ChildItem : Cannot find path 'C:\\work\\demo\\x' because it does not exist."]]);
  });

  it("files a Codex code-mode failure once, under the inner command, never under the exec wrapper's script", () => {
    // The `exec` cell runs JavaScript that calls exec_command; it fails because the call inside failed.
    const recs = failureRecords(
      session("a", [
        ["tool.start", { tool: "exec", toolUseId: "w", wrapper: true, input: "text(await tools.exec_command({cmd: 'cargo build'}))" }],
        ["tool.start", { tool: "exec_command", toolUseId: "c", input: { cmd: "cargo build" } }],
        ["tool.end", { tool: "exec_command", toolUseId: "c", ok: false, exitCode: 101, output: "error[E0425]: cannot find value `x`" }],
        ["tool.end", { tool: "exec", toolUseId: "w", wrapper: true, ok: false, output: "Script completed\nWall time 0.6 seconds" }],
        ["tool.start", { tool: "exec", toolUseId: "w2", wrapper: true, input: "text(ALL_TOOLS.filter((x) => x))" }],
        ["tool.end", { tool: "exec", toolUseId: "w2", ok: false, output: "" }],
      ]),
    );
    assert.deepEqual(recs.map((r) => [r.key, r.label]), [["cmd:cargo build", "cargo build"]]);
  });

  it("names the program a PowerShell launcher ran, not powershell.exe", () => {
    const recs = failureRecords(
      session("a", [
        ["tool.start", { tool: "Bash", toolUseId: "1", input: { command: "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command .\\lockedbotctl.exe files list" } }],
        ["tool.end", { tool: "Bash", toolUseId: "1", ok: false, exitCode: 1, output: "lockedbotctl: API returned 403 Forbidden" }],
      ]),
    );
    assert.deepEqual(recs.map((r) => r.key), ["cmd:lockedbotctl.exe"]);
  });

  it("a test summary that cat printed is not a failing test run, so cat never gets the broken-setup verdict", () => {
    const steps = (id: string): Parameters<typeof sessionEvents>[2] => [
      ["tool.start", { tool: "Bash", toolUseId: `${id}-1`, input: { command: "sleep 30 && cat /tmp/test-output.log | tail -40" } }],
      ["tool.end", { tool: "Bash", toolUseId: `${id}-1`, ok: true, output: "FAILED tests/test_a.py::test_x\n2 failed, 10 passed in 1.2s" }],
      ["test.result", { runner: "pytest", passed: 10, failed: 2, toolUseId: `${id}-1` }],
      ["tool.start", { tool: "Bash", toolUseId: `${id}-2`, input: { command: "cd /work/demo && cat setup.cfg | grep pytest && pytest -q" } }],
      ["tool.end", { tool: "Bash", toolUseId: `${id}-2`, ok: false, output: "Exit code 1\n[tool:pytest]\nF.\n1 failed, 1 passed in 0.1s" }],
      ["test.result", { runner: "pytest", passed: 1, failed: 1, toolUseId: `${id}-2` }],
    ];
    const recs = failureRecords(session("a", steps("a")));
    assert.deepEqual(recs.map((r) => [r.key, r.tests]), [["cmd:pytest -q", true]]);
    const sessions = ["a", "b"].map((id, k) => buildSession(sessionEvents(id, { cwd: CWD, startedAt: T0 + k }, steps(id))));
    const issues = rankIssues(sessions, new Map(sessions.map((s) => [s.id, failureRecords(sessionEvents(s.id, { cwd: CWD, startedAt: T0 }, steps(s.id)))])));
    const titles = issues.filter((i) => i.kind === "failure").map((i) => i.title);
    assert.deepEqual(titles, ["`pytest -q` already fails before the agent changes anything"]);
  });
});

describe("the sample under a failing part's heading", () => {
  const CWD = "/work/demo";
  const T0 = 1_790_000_000_000;
  const which = (id: string, k: number, command: string, output: string) =>
    sessionEvents(id, { cwd: CWD, startedAt: T0 + k }, [
      ["tool.start", { tool: "Bash", toolUseId: `${id}-1`, input: { command } }],
      ["tool.end", { tool: "Bash", toolUseId: `${id}-1`, ok: false, output }],
    ]);

  it("partOutput keeps the part's own line, the whole output for a lone command, and nothing it can't tie", () => {
    const cmd = "curl -sS https://example.test/; ls site; which vercel wrangler";
    const out = "Exit code 2\ncurl: (6) Could not resolve host: example.test\nsite.ts\nwhich: no vercel in (/usr/local/bin:/usr/bin:/bin)\n/usr/bin/wrangler";
    const part = failingPart(cmd, { output: out })!;
    assert.equal(part.prog, "which");
    assert.equal(partOutput(cmd, part, out), "which: no vercel in PATH");
    // A clipped PATH (no closing parenthesis) is still not the error.
    assert.equal(partOutput(cmd, part, "which: no vercel in (/usr/bin:/home/user/.loc…"), "which: no vercel in PATH");
    const lone = failingPart("cd /work/demo && mkdir -p out && node -e 'x()'", { output: "Exit code 1\nReferenceError: x is not defined" })!;
    assert.equal(partOutput("cd /work/demo && mkdir -p out && node -e 'x()'", lone, "Exit code 1\nReferenceError: x is not defined"), "Exit code 1\nReferenceError: x is not defined");
    // `which` printed nothing (a POSIX which is silent) and curl's error is curl's.
    const silent = "curl -sS https://example.test/; which vercel";
    assert.equal(partOutput(silent, failingPart(silent, { output: "curl: (6) Could not resolve host", exitCode: 1 })!, "curl: (6) Could not resolve host"), "curl: (6) Could not resolve host");
    assert.equal(partOutput(silent, { argv: ["which", "vercel"], prog: "which", last: true, timed: false }, "curl: (6) Could not resolve host"), undefined);
  });

  it("takes the failing part's line, not another part's error, and says 'the same way' only when the errors match", () => {
    const a = which("a", 0, "curl -sS https://example.test/; ls site; which vercel wrangler", "Exit code 2\ncurl: (6) Could not resolve host: example.test\nsite.ts\nwhich: no vercel in (/usr/bin:/bin)");
    const b = which("b", 1, "which actionlint; grep -n fetch site.mjs", "Exit code 1\nsite.mjs:25:  const res = await fetch(url);\nwhich: no actionlint in (/usr/bin:/bin)");
    const recs = [a, b].map((ev) => failureRecords(ev));
    assert.deepEqual(recs.map((r) => r.map((x) => [x.key, x.sample])), [[["cmd:which", "which: no vercel in PATH"]], [["cmd:which", "which: no actionlint in PATH"]]]);
    const sessions = [a, b].map((ev) => buildSession(ev));
    const issue = rankIssues(sessions, new Map(sessions.map((s, k) => [s.id, recs[k]!]))).find((i) => i.id === "fails:cmd:which")!;
    assert.equal(issue.title, "`which` fails in several sessions");
    assert.equal(issue.sample, "which: no vercel in PATH");
    const c = which("c", 2, "ls site; which vercel", "Exit code 1\nsite.ts\nwhich: no vercel in (/usr/bin)");
    const same = [a, c].map((ev) => buildSession(ev));
    const both = rankIssues(same, new Map([[same[0]!.id, recs[0]!], [same[1]!.id, failureRecords(c)]])).find((i) => i.id === "fails:cmd:which")!;
    assert.equal(both.title, "`which` fails the same way in several sessions");
  });
});

describe("PowerShell", () => {
  const parts = (cmd: string, shell?: "powershell") => shellParts(cmd, shell).map((p) => [p.prog, p.last]);

  it("splits statements on ; and pipelines on |, and drops the launcher", () => {
    assert.deepEqual(parts('powershell -NoProfile -Command "npm test | Select-Object -Last 20"'), [["npm", true], ["Select-Object", false]]);
    assert.deepEqual(parts("Set-Location C:\\work\\demo; npm run build; git status", "powershell"), [["Set-Location", true], ["npm", true], ["git", true]]);
    // An assignment runs what it assigns; a value statement (`$out`, a script block's `$_`) runs nothing.
    assert.deepEqual(parts("$out = dotnet build 2>&1; $out | Out-String", "powershell").map(([p]) => p), ["dotnet", "Out-String"]);
    assert.deepEqual(parts("rg -n x src | ForEach-Object { $_ }", "powershell"), [["rg", true], ["ForEach-Object", false]]);
  });

  it("applies PowerShell quoting: single quotes are literal, the backtick escapes", () => {
    assert.deepEqual(parts("Write-Output 'a; b | c'; git log", "powershell").map(([p]) => p), ["Write-Output", "git"]);
    assert.deepEqual(parts('Write-Output "a`"; b"; git log', "powershell").map(([p]) => p), ["Write-Output", "git"]);
    assert.deepEqual(parts("Write-Output 'it''s; done'; npm test", "powershell").map(([p]) => p), ["Write-Output", "npm"]);
    // Without PowerShell rules the backtick and the doubled quote would split these lines in the wrong place.
    assert.deepEqual(parts("echo `| x; npm test", "powershell").map(([p]) => p), ["echo", "npm"]);
  });

  it("never files a failure under the launcher or a pipeline cmdlet", () => {
    const ps = (cmd: string, output: string) => failingPart(cmd, { output, shell: "powershell" })?.prog;
    assert.equal(failingPart('powershell -NoProfile -Command "npm test | Select-Object -Last 20"', { output: "Exit code 1\n# fail 2" })?.prog, "npm");
    assert.equal(ps("Get-ChildItem x | Out-String", "Get-ChildItem : Cannot find path 'C:\\work\\demo\\x' because it does not exist."), "Get-ChildItem");
    assert.equal(ps("Get-ChildItem x | Out-String", "Cannot find path 'C:\\work\\demo\\x' because it does not exist."), "Get-ChildItem");
    for (const cmdlet of ["Where-Object { $_ }", "ForEach-Object { $_ }", "Sort-Object", "Select-Object -First 1"]) assert.equal(ps(`rg -n x src | ${cmdlet}`, "Exit code 1"), "rg");
    assert.equal(ps("foo-tool --x | Select-Object -First 3", "foo-tool : The term 'foo-tool' is not recognized as the name of a cmdlet"), "foo-tool");
  });
});
