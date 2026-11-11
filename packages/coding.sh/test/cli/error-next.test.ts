// Failures in --json carry a two-element `next` ([what it is, the command]),
// a typo is corrected only when it is close, and a command's help names the
// choices of a flag.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { parseArgs, UsageError } from "../../src/cli/args.ts";
import { commandHelp, main } from "../../src/cli/main.ts";
import { COMMANDS, findCommand } from "../../src/cli/registry.ts";

let root = "";
let env: NodeJS.ProcessEnv;
/** main() in this process, stderr and the exit code captured. */
async function exec(...args: string[]): Promise<{ status: number; stderr: string }> {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => ((stderr += String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { status: await main(args, env), stderr };
  } finally {
    process.stderr.write = write;
  }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-errnext-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = { ...process.env, ["HO" + "ME"]: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), T3CODE_HOME: join(root, "t3"), CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" };
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("a typo is corrected only when it is close", () => {
  const flags = findCommand("sessions")!.flags!;
  const hint = (argv: string[]) => {
    try {
      parseArgs(argv, flags, { suggestions: ["--json", "--blobs", "--store"] });
    } catch (e) {
      return (e as UsageError).suggestion;
    }
  };
  test("--bogus suggests nothing", () => assert.equal(hint(["--bogus"]), undefined));
  test("--limt suggests --limit", () => assert.equal(hint(["--limt", "3"]), "--limit"));
  test("--agnet suggests --agent", () => assert.equal(hint(["--agnet", "x"]), "--agent"));
});

describe("--json failures have a two-element next", () => {
  const cases: string[][] = [
    ["sessions", "--bogus"],
    ["nosuchcommand"],
    ["sessions", "--limit", "abc"],
    ["sessions", "--since", "never"],
    ["show"],
    ["show", "nosuchsession"],
    ["eval", "nosuchaction"],
    ["run", "ls"],
    ["export", "sessions", "--format", "xml"],
    ["replay", "nosuchsession"],
  ];
  for (const argv of cases) {
    test(argv.join(" "), async () => {
      const r = await exec(...argv, "--json");
      assert.notEqual(r.status, 0);
      const line = r.stderr.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      assert.ok(line, r.stderr);
      const doc = JSON.parse(line) as { status: string; next: string[] };
      assert.equal(doc.status, "error");
      assert.equal(doc.next.length, 2, line);
    });
  }

  test("an unknown option points at the command's help", async () => {
    const doc = JSON.parse((await exec("sessions", "--bogus", "--json")).stderr.trim()) as { next: string[] };
    assert.deepEqual(doc.next, ["See the options:", "coding.sh sessions --help"]);
  });
  test("an unknown command points at the command list", async () => {
    const doc = JSON.parse((await exec("zzzzzz", "--json")).stderr.trim()) as { next: string[] };
    assert.deepEqual(doc.next, ["See the commands:", "coding.sh --help"]);
  });
});

describe("run without -- names the fix", () => {
  test("coding.sh run claude -p hi", async () => {
    const r = await exec("run", "claude", "-p", "hi", "--json");
    assert.equal(r.status, 2);
    assert.deepEqual((JSON.parse(r.stderr.trim()) as { next: string[] }).next, ["Did you mean:", "coding.sh run -- claude -p hi"]);
  });

  test("the suggestion quotes each argument, so pasting it runs the same command", async () => {
    const r = await exec("run", "--json", "sh", "-c", "echo hi");
    assert.equal(r.status, 2);
    assert.deepEqual((JSON.parse(r.stderr.trim()) as { next: string[] }).next, ["Did you mean:", "coding.sh run -- sh -c 'echo hi'"]);
    const q = await exec("run", "--json", "sh", "-c", `echo "a b" > x; echo 'it'`);
    assert.equal((JSON.parse(q.stderr.trim()) as { next: string[] }).next[1], `coding.sh run -- sh -c 'echo "a b" > x; echo '\\''it'\\'''`);
  });
});

describe("help prints the choices", () => {
  const plain = { heading: (s: string) => s, bold: (s: string) => s, faint: (s: string) => s };
  test("usage --by lists agent-model", () => assert.match(commandHelp(findCommand("usage")!, undefined, plain), /One of: .*agent-model/));
  test("every flag with choices shows them in help", () => {
    for (const cmd of COMMANDS) {
      for (const a of [undefined, ...(cmd.actions ?? [])]) {
        const flags = (a ? a.flags : cmd.flags) ?? [];
        const help = commandHelp(cmd, a, plain);
        for (const f of flags) {
          if (f.hidden || !f.choices?.length) continue;
          for (const c of f.choices) assert.ok(help.includes(c), `${cmd.name} ${a?.name ?? ""} --${f.name} help names ${c}`);
        }
      }
    }
  });
});
