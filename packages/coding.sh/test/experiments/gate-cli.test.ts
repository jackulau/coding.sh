// exp compare --gate (AA-5) from the CLI: exit codes, --json, the orphan-flag
// usage error. Three stored experiments from a fake agent; temp HOME only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

describe("exp compare --gate from the CLI", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 120_000 });
  // Agent: echoes its input, or answers -1 (wrong) on every k-th case for FAIL_EVERY=k.
  const task = (every: number) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { FAIL_EVERY: String(every) } });

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-gate-cli-")));
    home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "tmp"));
    env = {
      HOME: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      PATH: pathOf(dirname(process.execPath), "/usr/bin", "/bin"),
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
    const cases: string[] = [];
    for (let i = 1; i <= 30; i++) cases.push("--case", JSON.stringify({ id: `c${i}`, input: i, expected: i }));
    assert.equal(cli(["dataset", "add", "gt", ...cases]).status, 0);
    writeFileSync(
      join(home, "agent.mjs"),
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s);const k=Number(process.env.FAIL_EVERY||0);process.stdout.write(JSON.stringify(k&&q%k===0?-1:q))});\n`,
    );
    for (const [name, every] of [["a", 3], ["b", 0], ["c", 5]] as const) {
      const r = cli(["exp", "run", "-d", "gt", "--task", task(every), "-g", '{"kind":"exact"}', "--name", name]);
      assert.equal(r.status, 0, r.stderr);
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("exit 0 on ship, 1 on don't ship; --json carries comparison.gate; no --gate, no gate", () => {
    // b fixes a's 10 failures and breaks nothing.
    const ship = cli(["exp", "compare", "a", "b", "--gate"]);
    assert.equal(ship.status, 0, ship.stderr);
    assert.match(ship.stdout, /^gate {4}Ship it: B wins 10 cases, loses 0$/m);

    // c fixes 8 of a's failures (multiples of 3, not of 5) and breaks 4 it solved (5, 10, 20, 25): 8 − 2·4 = 0.
    const hold = cli(["exp", "compare", "a", "c", "--gate", "--json"]);
    assert.equal(hold.status, 1, hold.stderr);
    const g = JSON.parse(hold.stdout).comparison.gate;
    assert.deepEqual([g.wins, g.losses, g.solved, g.netGain, g.verdict], [8, 4, 20, 0, "dont-ship"]);
    assert.deepEqual([...g.lostCases].sort(), ["c10", "c20", "c25", "c5"]);
    // λ=1, α=1, τ=1: wins > losses is enough.
    assert.equal(cli(["exp", "compare", "a", "c", "--gate", "--lambda", "1", "--gate-alpha", "1", "--tau", "1"]).status, 0);

    const plain = cli(["exp", "compare", "a", "c", "--json"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal("gate" in JSON.parse(plain.stdout).comparison, false);
  });

  it("--matrix prints the success-count grid; --json always carries comparison.turnover (Y-1)", () => {
    const r = cli(["exp", "compare", "a", "c", "--matrix"]);
    assert.equal(r.status, 0, r.stderr);
    // a solves 20 (not multiples of 3), c solves 24 (not multiples of 5): 4 lost, 8 gained, 16 kept, 2 never (15, 30).
    assert.match(r.stdout, /^success counts \(cases by passes out of 1: A in rows, B in columns\)$/m);
    assert.match(r.stdout, /^0 {4}2 {3}8$/m);
    assert.match(r.stdout, /^1 {4}4 {2}16$/m);
    const t = JSON.parse(cli(["exp", "compare", "a", "c", "--json"]).stdout).comparison.turnover;
    assert.deepEqual([t.gained.length, t.lost.length, t.keptCovered, t.neverCovered], [8, 4, 16, 2]);
    assert.deepEqual([...t.lost].sort(), ["c10", "c20", "c25", "c5"]);
  });

  it("--lambda, --gate-alpha and --tau without --gate are usage errors", () => {
    for (const flag of ["--lambda", "--gate-alpha", "--tau"]) {
      const r = cli(["exp", "compare", "a", "b", flag, "1"]);
      assert.equal(r.status, 2, flag);
      assert.match(r.stderr, new RegExp(`${flag} needs --gate`));
    }
  });
});
