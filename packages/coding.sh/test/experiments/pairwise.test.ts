// exp compare --pairwise (EM-14) end to end: two stored experiments, a fake
// OpenAI-compatible judge server in another process, --labels calibration
// stored on the judge version. Temp HOME / CODING_SH_HOME only.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const JUDGE = fileURLToPath(new URL("./fixtures/pairwise-judge.mjs", import.meta.url));

describe("exp compare --pairwise from the CLI", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  let server: ChildProcess | undefined;
  let port = 0;
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 120_000 });
  const json = (args: string[]) => {
    const r = cli([...args, "--json"]);
    assert.equal(r.status, 0, `coding.sh ${args.join(" ")} failed:\n${r.stderr}`);
    return JSON.parse(r.stdout) as Record<string, any>;
  };
  // Agent: echoes its input, or answers -1 (wrong) on every k-th case for FAIL_EVERY=k.
  const task = (every: number) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { FAIL_EVERY: String(every) } });
  const judgeSpec = () => JSON.stringify({ kind: "pairwise", name: "correct", rubric: "Prefer the response that answers correctly.", provider: "openai", model: "fake-judge", baseURL: `http://127.0.0.1:${port}`, requireKey: false });

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-pairwise-cli-")));
    home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "tmp"));
    env = {
      HOME: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
    const cases: string[] = [];
    for (let i = 1; i <= 30; i++) cases.push("--case", JSON.stringify({ id: `c${i}`, input: i, expected: i, split: i <= 10 ? "train" : "test" }));
    const add = cli(["dataset", "add", "pw", ...cases]);
    assert.equal(add.status, 0, add.stderr);
    writeFileSync(
      join(home, "agent.mjs"),
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s);const k=Number(process.env.FAIL_EVERY||0);process.stdout.write(JSON.stringify(k&&q%k===0?-1:q))});\n`,
    );
    server = spawn(process.execPath, [JUDGE], { stdio: ["ignore", "pipe", "pipe"] });
    port = await new Promise<number>((res, rej) => {
      server!.stdout!.once("data", (d: Buffer) => res(Number(String(d).trim())));
      server!.once("exit", (code) => rej(new Error(`judge server exited ${code}`)));
    });
  });
  after(() => {
    server?.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  });

  it("judges both orders, counts order flips as ties, and calibrates on --labels", () => {
    // A is wrong on every 3rd case, B on every 5th.
    assert.equal(cli(["exp", "run", "-d", "pw", "--task", task(3), "-g", '{"kind":"exact"}', "--name", "a"]).status, 0);
    assert.equal(cli(["exp", "run", "-d", "pw", "--task", task(5), "-g", '{"kind":"exact"}', "--name", "b"]).status, 0);
    const out = json(["exp", "compare", "a", "b", "--pairwise", judgeSpec()]);
    const p = out.pairwise;
    assert.equal(out.comparison.paired, 30);
    // B alone right: 3 6 9 12 18 21 24 27. A alone right: 5 10 20 25. The rest the judge can't
    // tell apart, so it picks the first response in both orders: a flip, recorded as a tie.
    assert.equal(p.n, 30);
    assert.deepEqual(p.wins, { a: 4, b: 8 });
    assert.equal(p.ties, 18);
    assert.equal(p.inconsistent, 18);
    assert.deepEqual(p.positionBias, { rate: 0.6, first: 18, second: 0 });
    assert.equal(p.winRate.b, (8 + 9) / 30);
    assert.equal(p.signTest.b, 4);
    assert.equal(p.signTest.c, 8);
    assert.equal(p.verdict, "inconclusive");
    assert.equal(p.judge.calibration, undefined);
    assert.match(p.warnings.join("\n"), /changed its answer with the order on 60% of cases/);
    assert.match(p.warnings.join("\n"), /uncalibrated/);
    const c12 = p.cases.find((x: { caseId: string }) => x.caseId === "c12");
    assert.equal(c12.winner, "b");
    assert.deepEqual(c12.orders, ["b", "b"]);

    // Human pairwise labels on every case; the judge agrees on every decisive one.
    const labels = join(home, "labels.jsonl");
    const rows: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const aOk = i % 3 !== 0;
      const bOk = i % 5 !== 0;
      const winner = aOk === bOk ? "tie" : bOk ? "b" : "a";
      rows.push(JSON.stringify({ caseId: `c${i}`, winner }));
    }
    writeFileSync(labels, rows.join("\n"));
    const cal = json(["exp", "compare", "a", "b", "--pairwise", judgeSpec(), "--labels", labels]);
    const k = cal.pairwiseCalibration;
    assert.equal(k.reportSplit, "test");
    assert.equal(k.heldOut, true);
    assert.equal(k.n, 7, "decisive held-out cases: 12 18 21 24 27 (B) and 20 25 (A)");
    assert.equal(k.agreement, 1);
    assert.equal(k.state, "insufficient-data");
    assert.equal(k.abstained, 0);
    assert.equal(cal.pairwise.judge.calibration.state, "insufficient-data");
    // Stored on the judge version: the next compare reads it back.
    const again = json(["exp", "compare", "a", "b", "--pairwise", judgeSpec()]);
    assert.equal(again.pairwise.judge.calibration.state, "insufficient-data");
    assert.equal(again.pairwise.judge.id, p.judge.id);

    // Text output.
    const t = cli(["exp", "compare", "a", "b", "--pairwise", judgeSpec()]);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /^wins {4}B 8, A 4, ties 18 \(18 from order flips\)$/m);
    assert.match(t.stdout, /^order {3}answer changed with the order on 18 of 30 \(60\.0%\): 18 favored the first response, 0 the second$/m);

    // Usage errors.
    const noPair = cli(["exp", "compare", "a", "b", "--labels", labels]);
    assert.equal(noPair.status, 2);
    assert.match(noPair.stderr, /--labels needs --pairwise/);
    const wrongKind = cli(["exp", "compare", "a", "b", "--pairwise", '{"kind":"llm","name":"x","rubric":"y"}']);
    assert.equal(wrongKind.status, 2);
    assert.match(wrongKind.stderr, /pairwise judge spec/);
  });
});
