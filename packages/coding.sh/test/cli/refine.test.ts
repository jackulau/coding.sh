// `coding.sh refine protected|check` in a temp git repo with a temp HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { appendLedger, refineDir, type TestEntry } from "../../src/refine/ledger.ts";
import { putSession, sessionEvents } from "../helpers-decision.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-")));
after(() => rmSync(root, { recursive: true, force: true }));

const AGENTS = "# Rules\n\n- Never run `git push --force`.\n- Ask the owner before deleting anything under `prod/`.\n- Prefer small commits.\n";

function setup(name: string, git = true) {
  const home = join(root, name, "home");
  const repo = join(root, name, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
  writeFileSync(join(repo, "AGENTS.md"), AGENTS);
  if (git) {
    const g = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
    g("init", "-q");
    g("add", "-A");
    g("commit", "-qm", "init");
  }
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: repo, env, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { home, repo, env, cli };
}

describe("cli refine", () => {
  it("protected lists auto, config and marker lines in plain text and JSON", () => {
    const e = setup("list");
    writeFileSync(join(e.repo, "AGENTS.md"), `${AGENTS}- Use pnpm.\n<!-- coding.sh:protect -->\nKeep answers short.\n<!-- coding.sh:protect end -->\n`);
    mkdirSync(join(e.home, ".coding.sh"), { recursive: true });
    writeFileSync(join(e.home, ".coding.sh", "config.toml"), '[refine]\nprotect = ["^Use pnpm"]\n');
    const t = e.cli("refine", "protected");
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /^WHERE\s+WHY\s+LINE$/m);
    assert.match(t.stdout, /^AGENTS\.md:3\s+auto\s+Never run `git push --force`\.$/m);
    assert.match(t.stdout, /^AGENTS\.md:6\s+config\s+Use pnpm\.$/m);
    assert.match(t.stdout, /^AGENTS\.md:8\s+marker\s+Keep answers short\.$/m);
    assert.match(t.stderr, /4 protected lines in 1 file \(current files; auto-protect on, 1 pattern\)/);
    const j = JSON.parse(e.cli("refine", "protected", "--json").stdout) as { count: number; files: string[]; settings: { autoProtect: boolean; patterns: string[] }; lines: { why: string }[] };
    assert.equal(j.count, 4);
    assert.deepEqual(j.files, ["AGENTS.md"]);
    assert.deepEqual(j.settings.patterns, ["^Use pnpm"]);
    assert.deepEqual(
      j.lines.map((l) => l.why),
      ["auto", "auto", "config", "marker"],
    );
  });

  it("protected with nothing to protect says how to protect a line", () => {
    const e = setup("empty");
    writeFileSync(join(e.repo, "AGENTS.md"), "Prefer small commits.\n");
    const t = e.cli("refine", "protected");
    assert.equal(t.status, 0);
    assert.equal(t.stdout, "");
    assert.match(t.stderr, /No protected lines in 1 harness file/);
    assert.match(t.stderr, /coding\.sh:protect/);
  });

  it("check: no edits and a harmless edit pass; deleting or relaxing a protected line exits 1 until allowed", () => {
    const e = setup("check");
    const same = e.cli("refine", "check");
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stderr, /No changes from A \(git:HEAD\) to B \(your edits\); 2 protected lines in place/);

    writeFileSync(join(e.repo, "AGENTS.md"), `${AGENTS}- Run \`npm run check\` before finishing.\n`);
    const fine = e.cli("refine", "check");
    assert.equal(fine.status, 0, fine.stderr);
    assert.match(fine.stderr, /No protected line deleted, reworded or relaxed \(2 protected lines in A; git:HEAD -> your edits\)/);

    writeFileSync(join(e.repo, "AGENTS.md"), AGENTS.replace("- Never run `git push --force`.\n", "").replace("- Prefer small commits.\n", "- Prefer small commits.\n- Only ask the owner when the path is ambiguous.\n"));
    const bad = e.cli("refine", "check");
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, 'protected-line: AGENTS.md:3 "Never run `git push --force`." (auto)\nrelaxes-protected: "Only ask the owner when the path is ambiguous." vs AGENTS.md:4 (added at AGENTS.md:5)\n');
    assert.match(bad.stderr, /2 protected-line problems from A \(git:HEAD\) to B \(your edits\)/);
    assert.match(bad.stderr, /coding\.sh refine check --allow-protected-edit AGENTS\.md:3/);

    const j = e.cli("refine", "check", "--json");
    assert.equal(j.status, 1);
    const doc = JSON.parse(j.stdout) as { a: string; b: string; changed: boolean; ok: boolean; count: number; rejections: { critic: string }[] };
    assert.deepEqual(
      [doc.a, doc.b, doc.changed, doc.ok, doc.count],
      ["git:HEAD", "your edits", true, false, 2],
    );
    assert.deepEqual(
      doc.rejections.map((r) => r.critic),
      ["protected", "relaxes-protected"],
    );

    const ok = e.cli("refine", "check", "--allow-protected-edit", "AGENTS.md:3", "--allow-protected-edit", "AGENTS.md:4");
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^allowed: protected-line: AGENTS\.md:3/m);
    assert.match(ok.stdout, /^allowed: relaxes-protected: /m);
  });

  it("check refuses a malformed override and needs --a/--b outside git", () => {
    const e = setup("usage");
    const bad = e.cli("refine", "check", "--allow-protected-edit", "AGENTS.md");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--allow-protected-edit: expected PATH:LINE/);

    const ng = setup("nogit", false);
    const r = ng.cli("refine", "check");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Not in a git repo: pass the two versions with --a and --b/);
    writeFileSync(join(ng.repo, "new.md"), "- Prefer small commits.\n");
    const files = ng.cli("refine", "check", "--a", "AGENTS.md", "--b", "new.md", "--json");
    assert.notEqual(files.status, 2, files.stderr);
  });

  it("a bad [refine] config is an error naming the file", () => {
    const e = setup("badcfg");
    mkdirSync(join(e.repo, ".coding.sh"), { recursive: true });
    writeFileSync(join(e.repo, ".coding.sh", "config.toml"), '[refine]\nprotect = ["(x"]\n');
    const r = e.cli("refine", "protected");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /invalid regex/);
    assert.match(r.stderr, /config\.toml/);
  });

  it("log and apply name the canary for a round it rejected or left inconclusive; a keep shows why it was kept", () => {
    const e = setup("log-canary");
    const KEPT = "cost / run -23% [-23%, -23%], p 0.016 with quality held: pass rate 100% → 100%";
    const arm = (cost: number, size: number) => ({ pass: 1, cost, tokens: 1000, wall: 1000, size });
    const round = (n: number, id: string, verdict: TestEntry["verdict"], stage: TestEntry["stage"], reasons: string[]): TestEntry => ({
      op: "test",
      id,
      round: n,
      at: `2026-11-0${n}T00:00:00.000Z`,
      candidate: { label: "draft", source: "file", files: [{ path: "AGENTS.md", sha: `sha${n}` }], added: [], removedCount: 3 },
      base: [{ path: "AGENTS.md", sha: "base" }],
      guardTasks: [],
      verdict,
      stage,
      reasons,
      suite: { name: "chores", tasks: 6, k: 2, primary: "cost", experiment: `exp_${n}`, base: "a", cand: "b" },
      objectives: {
        list: ["cost"],
        margin: 0.02,
        minGain: 0.1,
        branch: "efficiency",
        quality: { base: 1, cand: 1, mean: 0, lo: 0, hi: 0, lower: 0, pHold: 0.016, nonInferior: true, p: 1, better: false, regressions: [], n: 6 },
        metrics: [],
        arms: { base: arm(0.18, 2000), cand: arm(0.14, 100) },
        gains: [0.23],
        warnings: [],
      },
      cost: { usd: 1, unpriced: 0 },
    });
    const dir = refineDir(e.env, e.repo);
    appendLedger(dir, round(1, "r_rejected01", "reject", "canary", [KEPT, "canary-regression: small: hard regression on chore-0 (the base passed every attempt, the candidate at most a third)"]));
    appendLedger(dir, round(2, "r_spendcap02", "inconclusive", "canary", [KEPT, "canary: small stopped at the spend cap with 13 runs not started; inconclusive"]));
    appendLedger(dir, round(3, "r_plainkeep3", "keep", "done", [KEPT, "canary: small held (pass rate +0.0 pts, lower bound +0.0 pts)"]));

    const log = e.cli("refine", "log");
    assert.equal(log.status, 0, log.stderr);
    const reason = (id: string) => log.stdout.split("\n").find((l) => l.split("\t")[1] === id)?.split("\t").at(-1);
    assert.match(reason("r_rejected01")!, /^canary-regression: small: hard regression on chore-0/);
    assert.match(reason("r_spendcap02")!, /^canary: small stopped at the spend cap/);
    assert.equal(reason("r_plainkeep3"), KEPT);

    const apply = e.cli("refine", "apply", "r_rejected01");
    assert.equal(apply.status, 1);
    assert.match(apply.stderr, /r_rejected01 was not kept \(reject: canary-regression: small/);
  });

  it("diagnose --session takes an id prefix as show does; an unknown id is not_found, never an empty plan", async () => {
    const e = setup("diagnose-session");
    const ids = ["093c2aed-1a94-4767-8adf-94d342d3abf2", "41ca9884-851f-49ea-87e8-2669e4907423", "41ca9884-0000-4000-8000-000000000000"];
    const { openContext } = await import("../../src/core/context.ts");
    const ctx = await openContext({ env: e.env, cwd: e.repo });
    try {
      // Another repo, 40 days back: --session names the session whatever the window and the repo are.
      for (const [i, id] of ids.entries()) {
        await putSession(ctx.index, sessionEvents(id, { cwd: "/work/elsewhere", startedAt: Date.now() - 40 * 86_400_000 + i * 1000 }, [["session.start", {}], ["user.message", { text: "List the files." }], ["assistant.message", { text: "Here they are." }]]));
      }
    } finally {
      await ctx.close();
    }
    const plan = (...session: string[]) => {
      const r = e.cli("refine", "diagnose", ...session.flatMap((s) => ["--session", s]), "--dry-run", "--json");
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return (JSON.parse(r.stdout) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    };
    assert.deepEqual(plan("093c2aed"), [ids[0]]);
    assert.deepEqual(plan(ids[0]!), [ids[0]]);
    assert.deepEqual(plan("093c2aed", ids[0]!, "41ca9884-85"), [ids[0], ids[1]], "a session named twice is planned once");
    assert.deepEqual(plan("latest"), [ids[2]]);

    const miss = e.cli("refine", "diagnose", "--session", "nope-nope", "--dry-run");
    assert.equal(miss.status, 1, miss.stdout + miss.stderr);
    assert.match(miss.stderr, /Can't find session "nope-nope"/);
    assert.doesNotMatch(miss.stdout + miss.stderr, /No session to diagnose/);
    const missJson = e.cli("refine", "diagnose", "--session", ids[0]!, "--session", "nope-nope", "--dry-run", "--json");
    assert.equal(missJson.status, 1, missJson.stdout + missJson.stderr);
    assert.match(missJson.stderr, /"reason":"not_found"/);
    const ambiguous = e.cli("refine", "diagnose", "--session", "41ca9884", "--dry-run", "--json");
    assert.equal(ambiguous.status, 1, ambiguous.stdout + ambiguous.stderr);
    assert.match(ambiguous.stderr, /"reason":"ambiguous"/);
  });
});
