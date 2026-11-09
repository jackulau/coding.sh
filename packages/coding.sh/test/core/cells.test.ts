// Shell commands inside REPL cells (Prime's python_repl, CodeAct, smolagents,
// IPython), and the verification they count as in a session.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_CELL_COMMANDS, shellCommandsInCode } from "../../src/core/cells.ts";
import { buildSession, commandOf, detectNoVerification, FLAGS, isVerifyToolStart } from "../../src/core/sessions.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";

const TABLE: [label: string, code: string, expect: string[]][] = [
  ["await bash", "await bash('npm test')", ["npm test"]],
  ["bash, double quotes", 'out = bash("cargo test --all")\nprint(out)', ["cargo test --all"]],
  ["subprocess.run list", 'subprocess.run(["pytest","-q"])', ["pytest -q"]],
  ["subprocess.run string", 'subprocess.run("make test", shell=True, check=True)', ["make test"]],
  ["subprocess.check_output", "r = subprocess.check_output(['git', 'status', '--short'], text=True)", ["git status --short"]],
  ["subprocess.Popen tuple", "p = subprocess.Popen(('npx', 'vitest', 'run'))", ["npx vitest run"]],
  ["subprocess.run args=", "subprocess.run(args=['go', 'test', './...'])", ["go test ./..."]],
  ["os.system", "import os\nos.system('tsc --noEmit')", ["tsc --noEmit"]],
  ["sh.run", "sh.run('ruff check .')", ["ruff check ."]],
  ["IPython bang", "!cargo test", ["cargo test"]],
  ["IPython bang assignment", "files = !ls src\nprint(files)", ["ls src"]],
  ["%sx", "%sx pytest -x", ["pytest -x"]],
  ["%%bash cell", "%%bash\nnpm ci\n# setup done\nnpm test\n", ["npm ci", "npm test"]],
  ["f-string keeps braces", 'await bash(f"pytest {path} -q")', ["pytest {path} -q"]],
  ["raw string", "bash(r'grep -E \"a\\|b\" x')", ['grep -E "a\\|b" x']],
  ["triple-quoted heredoc", 'await bash("""\ncat > a.txt <<EOF\nhi\nEOF\n""")', ["cat > a.txt <<EOF\nhi\nEOF"]],
  ["several, in order", "bash('npm ci')\nx = 1\n!npm run build\nsubprocess.run(['npm', 'test'])", ["npm ci", "npm run build", "npm test"]],
  ["comment", "# bash('rm -rf /')", []],
  ["trailing comment", "x = 2  # os.system('rm -rf /')", []],
  ["call inside a string", "print(\"use bash('npm test') to test\")", []],
  ["variable argument", "cmd = build()\nsubprocess.run(cmd)", []],
  ["list with a variable", "subprocess.run(['pytest', target])", []],
  ["plain python", "import json\ndata = json.loads(s)\nprint(len(data))", []],
  ["bang inside a docstring", 'doc = """\n!important\n"""', []],
  ["not-equal is not a bang", "if a != b:\n    print(a)", []],
  ["method named bash", "self.my_bash('npm test')\nobj.bash('npm test')", []],
];

describe("shellCommandsInCode", () => {
  for (const [label, code, expect] of TABLE) it(label, () => assert.deepEqual(shellCommandsInCode(code), expect));

  it("has at least 15 cases", () => assert.ok(TABLE.length >= 15));

  it(`stops at ${MAX_CELL_COMMANDS} commands`, () => {
    const code = Array.from({ length: 80 }, (_, i) => `bash('echo ${i}')`).join("\n");
    const cmds = shellCommandsInCode(code);
    assert.equal(cmds.length, MAX_CELL_COMMANDS);
    assert.equal(cmds[0], "echo 0");
  });
});

let t = 0;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}): AgentEvent => ({ id: `e${++t}`, v: 0, sessionId: "s", ts: 1000 + t * 10, agent: "prime", kind, payload });
const cell = (code: string) => ev("tool.start", { tool: "python_repl", toolUseId: `c${t + 1}`, input: { code } });

describe("REPL cells in sessions", () => {
  it("commandOf reads a cell's commands; other input shapes are unchanged", () => {
    assert.equal(commandOf({ code: "await bash('npm ci')\nawait bash('npm test')" }), "npm ci && npm test");
    assert.equal(commandOf({ code: "print(1)" }), undefined);
    assert.equal(commandOf({ command: "ls", code: "await bash('npm test')" }), "ls");
    assert.equal(commandOf({ cmd: ["git", "status"] }), "git status");
  });

  const table: [label: string, code: string, verifies: boolean][] = [
    ["await bash('npm test')", "await bash('npm test')", true],
    ["subprocess pytest", "import subprocess\nsubprocess.run(['pytest', '-q'])", true],
    ["!cargo test", "!cargo test", true],
    ["plain python", "with open('a.py', 'w') as f:\n    f.write(src)", false],
    ["commented test run", "# await bash('npm test')\nprint('skipped')", false],
  ];
  for (const [label, code, verifies] of table) {
    it(`${label}: ${verifies ? "counts" : "does not count"} as verification`, () => {
      const start = cell(code);
      assert.equal(isVerifyToolStart(start), verifies);
      const events = [ev("user.message", { text: "fix it" }), start, ev("file.change", { path: "a.py", op: "modify" }), ev("turn.end")];
      assert.equal(detectNoVerification(events), !verifies);
      assert.equal(buildSession(events).flags.includes(FLAGS.noVerification), !verifies);
    });
  }
});
