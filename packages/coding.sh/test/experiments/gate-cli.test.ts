// exp compare --gate (AA-5) from the CLI: exit codes, --json, the orphan-flag
// usage error. Three stored experiments from a fake agent; temp HOME only.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

  it("--margin: non-inferiority line, exit 1 unless B is within the margin, hard regressions listed (R2-3)", () => {
    // c gains 8 of a's failures and loses 4: mean +13pp, comfortably within −20pp.
    const ok = cli(["exp", "compare", "a", "c", "--margin", "0.2"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^non-inf B − A ≥ -20\.0pp: yes \(95% CI lower bound [+-]\d+\.\dpp > -20\.0pp, sign-flip p=[\d.<]+ < 0\.025 over 30 units\)$/m);
    assert.match(ok.stdout, /^! B now mostly fails 4 case\(s\) A passed on every trial: c10, c20, c25, c5$/m);
    // b solves all 30; c breaks the 6 multiples of 5: −20pp is not within 5pp.
    const bad = cli(["exp", "compare", "b", "c", "--margin", "0.05", "--json"]);
    assert.equal(bad.status, 1, bad.stderr);
    const cmp = JSON.parse(bad.stdout).comparison;
    assert.equal(cmp.nonInferiority.nonInferior, false);
    assert.equal(cmp.nonInferiority.delta, 0.05);
    assert.equal(cmp.nonInferiority.n, 30);
    // The bound is the lower end of the printed 95% CI.
    assert.equal(cmp.nonInferiority.lower, cmp.diff.lo);
    assert.equal(cmp.nonInferiority.hardRegressions.length, 6);
    assert.equal("nonInferiority" in JSON.parse(cli(["exp", "compare", "a", "c", "--json"]).stdout).comparison, false);
    const usage = cli(["exp", "compare", "a", "c", "--margin", "1.5"]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /--margin must be at least 0 and below 1/);
  });

  it("--lambda, --gate-alpha and --tau without --gate are usage errors", () => {
    for (const flag of ["--lambda", "--gate-alpha", "--tau"]) {
      const r = cli(["exp", "compare", "a", "b", flag, "1"]);
      assert.equal(r.status, 2, flag);
      assert.match(r.stderr, new RegExp(`${flag} needs --gate`));
    }
  });
});

// AB-13: more than one --pairwise judge, from a fake judge server that answers by model name.
const JUDGE = fileURLToPath(new URL("./fixtures/pairwise-judge-models.mjs", import.meta.url));

describe("exp compare --gate with several --pairwise judges (AB-13)", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  let server: ChildProcess | undefined;
  let port = 0;
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 120_000 });
  const task = (every: number) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { FAIL_EVERY: String(every) } });
  const judge = (model: string) => JSON.stringify({ kind: "pairwise", name: "correct", rubric: "Prefer the correct response.", provider: "openai", model, baseURL: `http://127.0.0.1:${port}`, requireKey: false });

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-gate-judges-")));
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
    for (const [name, every] of [["a", 3], ["b", 0]] as const) assert.equal(cli(["exp", "run", "-d", "gt", "--task", task(every), "-g", '{"kind":"exact"}', "--name", name]).status, 0);
    server = spawn(process.execPath, [JUDGE], { stdio: ["ignore", "pipe", "inherit"] });
    port = await new Promise<number>((res, rej) => {
      server!.stdout!.once("data", (d: Buffer) => res(Number(String(d).trim())));
      server!.once("exit", (code) => rej(new Error(`judge server exited ${code}`)));
    });
  });
  after(() => {
    server?.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  });

  it("ship plus a judge that prefers A: hold, exit 1, 'Hold: judges disagree'", () => {
    const r = cli(["exp", "compare", "a", "b", "--gate", "--pairwise", judge("right-1"), "--pairwise", judge("wrong-1")]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^gate {4}Hold: judges disagree \(correct@\w+ prefers B, correct@\w+ prefers A\)$/m);
    assert.match(r.stdout, /^judges {2}judges-disagree$/m);
    assert.match(r.stdout, /^! judges correct@\w+, correct@\w+ share provider openai/m);
    const j = JSON.parse(cli(["exp", "compare", "a", "b", "--gate", "--pairwise", judge("right-1"), "--pairwise", judge("wrong-1"), "--json"]).stdout);
    assert.ok(Array.isArray(j.pairwise) && j.pairwise.length === 2);
    assert.equal(j.replication.conclusion, "judges-disagree");
    assert.deepEqual(j.replication.judges.map((x: { verdict: string }) => x.verdict), ["better", "worse"]);
    assert.equal(j.comparison.gate.verdict, "hold");
    assert.equal(j.comparison.gate.decision, "abstain");
    assert.equal(j.comparison.gate.judgeHold.conclusion, "judges-disagree");
  });

  it("two judges that agree B is better: replicated-better, the gate still ships (exit 0)", () => {
    const r = cli(["exp", "compare", "a", "b", "--gate", "--pairwise", judge("right-1"), "--pairwise", judge("right-2"), "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.replication.conclusion, "replicated-better");
    assert.equal(j.replication.agreement[0].kappa, 1);
    assert.equal(j.comparison.gate.verdict, "ship");
    assert.equal("judgeHold" in j.comparison.gate, false);
  });

  it("one judge: the JSON and text keep their shape (pairwise is an object, no replication block)", () => {
    const j = JSON.parse(cli(["exp", "compare", "a", "b", "--gate", "--pairwise", judge("right-1"), "--json"]).stdout);
    assert.equal(Array.isArray(j.pairwise), false);
    assert.equal(j.pairwise.verdict, "better");
    assert.deepEqual(Object.keys(j), ["comparison", "pairwise"]);
    assert.equal("judgeHold" in j.comparison.gate, false);
    const t = cli(["exp", "compare", "a", "b", "--gate", "--pairwise", judge("right-1")]);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /^gate {4}Ship it: B wins 10 cases, loses 0$/m);
    assert.doesNotMatch(t.stdout, /^judges /m);
    // A lone judge that prefers A holds a ship too.
    const lone = cli(["exp", "compare", "a", "b", "--gate", "--pairwise", judge("wrong-1")]);
    assert.equal(lone.status, 1);
    assert.match(lone.stdout, /^gate {4}Hold: judges disagree \(correct@\w+ prefers A\)$/m);
  });
});
