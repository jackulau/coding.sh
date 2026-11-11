// `coding.sh refine signals [show <id>]` in a temp git repo with a temp HOME:
// the list, one Signal by id and by prefix, --json, and an unknown id.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { signalsFile } from "../../src/refine/diagnose.ts";
import { refineDir } from "../../src/refine/ledger.ts";
import { writeSignals, type Signal, type SignalsDoc } from "../../src/refine/signals.ts";
import { catalogHash } from "../../src/refine/taxonomy.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-signals-")));
after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 10, 1);
const signal = (id: string, title: string, name: string, score: number): Signal => ({
  id,
  key: `tool:${name.toLowerCase()}:eff.retry-thrash`,
  title,
  typeIds: ["eff.retry-thrash"],
  component: { type: "tool", name },
  natures: ["inefficiency"],
  occurrences: [
    {
      id: `occ-${id}`,
      sessionId: "s1",
      component: { type: "tool", name },
      typeIds: ["eff.retry-thrash"],
      nature: "inefficiency",
      explanation: "The agent reran a type check that kept failing.",
      evidence: [{ quote: "error TS2307", verified: true, eventId: "ev1" }],
      factor: 25,
    },
  ],
  severity: { score, level: "low", drivingNature: "inefficiency", parts: [{ nature: "inefficiency", factor: 25, affected: 1, analyzed: 2, scope: { band: "broad", points: 12, via: "count" }, score }], population: { affected: 1, analyzed: 2 } },
  remediation: { action: "Fix the import before rerunning tsc.", surface: "instructions", intent: "prevent", checks: [], sessions: { affected: ["s1"], preserved: ["s2"] } },
  firstSeen: T0,
  lastSeen: T0,
  analyzedSinceLastSeen: 0,
  status: "open",
  population: { affected: 1, analyzed: 2 },
});

function setup(name: string) {
  const home = join(root, name, "home");
  const repo = join(root, name, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo, env }).status, 0);
  const file = signalsFile(refineDir(env, repo));
  const doc: SignalsDoc = {
    version: 1,
    catalog: catalogHash(),
    sessions: { s1: { startedAt: T0, agent: "claude-code", repo, status: "problems" }, s2: { startedAt: T0, agent: "claude-code", repo, status: "none" } },
    signals: [signal("60a2402e4def", "Retry thrash in tool Bash", "Bash", 37), signal("f87e99a397d3", "Retry thrash in tool Edit", "Edit", 30)],
  };
  writeSignals(file, doc);
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: repo, env, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { file, cli };
}

describe("cli refine signals", () => {
  it("show <id> prints one Signal with its occurrences, citations and fix; a prefix finds it too", () => {
    const e = setup("show");
    const list = e.cli("refine", "signals");
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^60a2402e4def\s+37 low\s+Retry thrash in tool Bash/m);

    for (const id of ["60a2402e4def", "60a240"]) {
      const t = e.cli("refine", "signals", "show", id);
      assert.equal(t.status, 0, `${id}: ${t.stderr}`);
      assert.match(t.stdout, /60a2402e4def {2}Retry thrash in tool Bash/);
      assert.match(t.stdout, /Fix the import before rerunning tsc\. \(instructions, prevent\)/);
      assert.match(t.stdout, /^s1 {2}inefficiency 25 {2}The agent reran a type check that kept failing\.$/m);
      assert.match(t.stdout, /^ {2}\[ev1\] "error TS2307"$/m);
      assert.doesNotMatch(t.stdout, /tool Edit/);
    }
  });

  it("show <id> --json returns the Signal", () => {
    const e = setup("json");
    const t = e.cli("refine", "signals", "show", "f87e99", "--json");
    assert.equal(t.status, 0, t.stderr);
    const s = JSON.parse(t.stdout) as Signal;
    assert.equal(s.id, "f87e99a397d3");
    assert.equal(s.title, "Retry thrash in tool Edit");
    assert.equal(s.occurrences.length, 1);
  });

  it("an unknown id is not_found with the file; show without an id and a third argument are usage errors", () => {
    const e = setup("unknown");
    const t = e.cli("refine", "signals", "show", "000000", "--json");
    assert.equal(t.status, 2);
    const err = JSON.parse(t.stdout || t.stderr) as { message: string; reason: string };
    assert.equal(err.reason, "not_found");
    assert.equal(err.message, `No Signal 000000 in ${e.file}`);
    const bare = e.cli("refine", "signals", "show");
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /needs a Signal id/);
    const extra = e.cli("refine", "signals", "show", "60a240", "more");
    assert.equal(extra.status, 2);
    assert.match(extra.stderr, /Unexpected argument "more"/);
  });
});
