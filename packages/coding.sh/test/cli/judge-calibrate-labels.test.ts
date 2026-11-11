// `judge calibrate` and `judge sample` count human scores put on cases
// (`score add case:<id>`), not only labels on sessions. A dataset added by hand
// has no source sessions, so before this every case label was dropped (n=0).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { addScore } from "../../src/scores/scores.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
let root = "";
let env: NodeJS.ProcessEnv;
const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", cwd: root, timeout: 60_000 });

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-judge-cal-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = { ...process.env, ["HO" + "ME"]: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), CODING_SH_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
  writeFileSync(join(root, "echo.mjs"), 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(s));\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("judge calibrate with case labels", () => {
  it("23 labels from score add case:<id> give n=23, and judge sample sees them as labelled", async () => {
    const cases = Array.from({ length: 23 }, (_, i) => ["--case", JSON.stringify({ input: String(i), expected: String(i) })]).flat();
    const add = run("dataset", "add", "arith", ...cases, "--split", "test");
    assert.equal(add.status, 0, add.stderr);
    const ran = run("exp", "run", "-d", "arith", "--task", '{"kind":"command","command":"node echo.mjs"}', "-g", '{"kind":"llm","name":"correct","rubric":"right?","provider":"mock","tunedOn":["dev"]}', "--json");
    assert.equal(ran.status, 0, ran.stderr);
    const exp = (JSON.parse(ran.stdout) as { experiment: { id: string; runs: { caseId: string }[] } }).experiment;
    const ids = [...new Set(exp.runs.map((r) => r.caseId))];
    assert.equal(ids.length, 23);
    // One through the CLI, the rest through the same addScore call (each CLI start is slow).
    const s = run("score", "add", `case:${ids[0]}`, "correct", "true");
    assert.equal(s.status, 0, s.stderr);
    const index = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"));
    try {
      for (const id of ids.slice(1)) await addScore(index, { target: "case", targetId: id, name: "correct", value: true }, { by: "tester", source: "human", now: Date.now() });
    } finally {
      await index.close();
    }

    // Exit 1 is "not calibrated" (every label and verdict is pass, so κ is undefined); 2 is a usage error.
    const cal = run("judge", "calibrate", exp.id, "--json");
    assert.notEqual(cal.status, 2, cal.stderr);
    const c = (JSON.parse(cal.stdout) as { calibration: { n: number; excluded: { noLabel: number } } }).calibration;
    assert.equal(c.n, 23);
    assert.equal(c.excluded.noLabel, 0);

    const sample = run("judge", "sample", exp.id, "--budget", "5", "--json");
    assert.equal(sample.status, 0, sample.stderr);
    const picks = (JSON.parse(sample.stdout) as { plan: { picks: { alreadyLabelled?: boolean }[] } }).plan.picks;
    assert.ok(picks.length > 0);
    assert.ok(picks.every((p) => p.alreadyLabelled === true), JSON.stringify(picks));
  });
});
