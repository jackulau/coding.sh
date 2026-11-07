// §15.8: `coding.sh toolevals` end to end against a fresh esbuild bundle, with
// a temp HOME / CODING_SH_HOME and a PATH holding only node's directory.
import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { bundle } from "../../scripts/bundle.mjs";
import { startFakeProvider, type FakeProvider } from "./fixtures/fake-provider.mjs";
import { FAKE_CLI } from "./helpers.ts";

let distDir = "";
let CLI = "";
const dirs: string[] = [];
before(async () => {
  distDir = realpathSync(mkdtempSync(join(tmpdir(), "csh-te-dist-")));
  CLI = (await bundle(distDir)).cli;
});
after(() => {
  rmSync(distDir, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Home {
  home: string;
  data: string;
  repo: string;
  env: Record<string, string>;
}

function tmpHome(): Home {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-te-home-")));
  dirs.push(root);
  const home = join(root, "home");
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(root, "tmp"));
  const data = join(home, ".coding.sh");
  return { home, data, repo, env: { HOME: home, USERPROFILE: home, CODING_SH_HOME: data, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), PATH: dirname(process.execPath), TMPDIR: join(root, "tmp") } };
}

const cli = (h: Home, args: string[], extra: Record<string, string> = {}): SpawnSyncReturns<string> => spawnSync(process.execPath, [CLI, ...args], { env: { ...h.env, ...extra }, cwd: h.repo, encoding: "utf8", timeout: 60_000 });

/** Async variant for runs that talk to the in-process fake provider. */
function cliAsync(h: Home, args: string[], extra: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: { ...h.env, ...extra }, cwd: h.repo, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    c.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => c.kill("SIGKILL"), 60_000);
    c.on("error", reject);
    c.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function one(stdout: string, label: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    assert.fail(`${label}: stdout is not one JSON document:\n${stdout}`);
  }
}

const q = (s: string) => JSON.stringify(s);

function writeRepo(h: Home, opts: { confirmAboveUsd?: number; providerUrl?: string; status?: string } = {}): void {
  const lines = ["[toolevals]", `confirmAboveUsd = ${opts.confirmAboveUsd ?? 5}`, "trialUsdEstimate = 0.1", "", "[toolevals.targets.fake]", 'kind = "cli"', 'bin = "fake-cli"', `command = [${q(process.execPath)}, ${q(FAKE_CLI)}]`, ""];
  for (const [d, suffix] of [
    ["model:anthropic/fake", ""],
    ["model:openai-chat/fake", "/v1"],
  ] as const) {
    lines.push(`[toolevals.drivers.${q(d)}]`, 'apiKeyEnv = "FAKE_KEY"');
    if (opts.providerUrl) lines.push(`baseUrl = ${q(opts.providerUrl + suffix)}`);
    lines.push("");
  }
  writeFileSync(join(h.repo, "coding.sh.toml"), lines.join("\n"));
  const tasks = join(h.repo, "evals", "toolevals", "fake", "tasks");
  mkdirSync(tasks, { recursive: true });
  for (const id of ["greet-bob", "greet-ada"]) {
    const name = id.slice(6);
    writeFileSync(join(tasks, `${id}.toml`), [`id = ${q(id)}`, `instruction = "Greet ${name} using fake-cli and reply with its output."`, ...(opts.status === "" ? [] : [`status = ${q(opts.status ?? "validated")}`]), `reference = ["fake-cli greet --name ${name}"]`, "", "[[checks]]", 'kind = "output"', `contains = ["hello ${name}"]`, ""].join("\n"));
  }
}

describe("toolevals CLI", () => {
  it("prints toolevals help in under 200 ms from the bundle", () => {
    const h = tmpHome();
    let best = Infinity;
    let bare = Infinity;
    let r: SpawnSyncReturns<string> | undefined;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      r = cli(h, ["toolevals", "--help"]);
      best = Math.min(best, performance.now() - t0);
      // A bare node spawn under the same load: the budget is for the CLI's own startup, so a busy
      // machine (the parallel suite, other jobs) slows both and does not fail the check.
      const t1 = performance.now();
      spawnSync(process.execPath, ["-e", ""]);
      bare = Math.min(bare, performance.now() - t1);
    }
    assert.equal(r!.status, 0, r!.stderr);
    assert.match(r!.stdout, /toolevals/);
    assert.match(r!.stdout, /compress/);
    assert.ok(best - bare < 170, `toolevals --help took ${best.toFixed(0)} ms (bare node ${bare.toFixed(0)} ms)`);
  });

  it("exits 2 on an unknown flag, with a JSON error on stderr in --json mode", () => {
    const h = tmpHome();
    const r = cli(h, ["toolevals", "run", "--bogus", "--json"]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /bogus/);
  });

  it("init --dry-run writes nothing; init writes the target and three draft starter tasks", () => {
    const h = tmpHome();
    const wrapper = join(h.home, "fake-cli");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${q(process.execPath)} ${q(FAKE_CLI)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const dry = cli(h, ["toolevals", "init", "--cli", wrapper, "--dry-run", "--json"]);
    assert.equal(dry.status, 0, dry.stderr);
    const plan = one(dry.stdout, "init --dry-run");
    assert.equal(plan.dryRun, true);
    assert.equal(plan.target, "fake-cli");
    assert.equal((plan.files as string[]).length, 3);
    assert.ok(((plan.surface as { items: unknown[] }).items.length ?? 0) >= 3, JSON.stringify(plan.surface));
    assert.deepEqual(readdirSync(h.repo), []);

    const r = cli(h, ["toolevals", "init", "--cli", wrapper, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    one(r.stdout, "init");
    assert.match(readFileSync(join(h.repo, "coding.sh.toml"), "utf8"), /\[toolevals\.targets\.fake-cli\]/);
    const tasks = readdirSync(join(h.repo, "evals", "toolevals", "fake-cli", "tasks")).sort();
    assert.deepEqual(tasks, ["starter-1.toml", "starter-2.toml", "starter-3.toml"]);
    assert.match(readFileSync(join(h.repo, "evals", "toolevals", "fake-cli", "tasks", "starter-1.toml"), "utf8"), /status = "draft"/);

    // A second init of the same name refuses.
    const again = cli(h, ["toolevals", "init", "--cli", wrapper, "--json"]);
    assert.equal(again.status, 1);
    assert.equal(again.stdout, "");
  });

  it("surface --json emits one document with the crawled help tree", () => {
    const h = tmpHome();
    writeRepo(h);
    const r = cli(h, ["toolevals", "surface", "fake", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const s = one(r.stdout, "surface").surface as { surfaceBytes: number; items: { name: string }[] };
    assert.ok(s.surfaceBytes > 0);
    assert.ok(s.items.some((i) => /greet/.test(i.name)), JSON.stringify(s.items));
  });

  it("validate runs the reference through the shim and the no-op trial", () => {
    const h = tmpHome();
    writeRepo(h);
    const r = cli(h, ["toolevals", "validate", "fake", "--json"]);
    const doc = one(r.stdout, "validate");
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
    assert.equal(doc.ok, true, JSON.stringify(doc));
    assert.equal((doc.tasks as unknown[]).length, 2);
  });

  it("validate marks passing draft tasks validated, so run stops warning they are drafts", () => {
    const h = tmpHome();
    writeRepo(h, { status: "", confirmAboveUsd: 0.01 });
    const tasks = join(h.repo, "evals", "toolevals", "fake", "tasks");
    // A third draft task whose reference can't pass stays draft.
    writeFileSync(join(tasks, "greet-nobody.toml"), ['id = "greet-nobody"', 'instruction = "Greet using fake-cli."', 'reference = ["fake-cli greet --name zed"]', "", "[[checks]]", 'kind = "output"', 'contains = ["hello nobody"]', ""].join("\n"));
    const before = cli(h, ["toolevals", "run", "fake", "--driver", "model:anthropic/fake"], { FAKE_KEY: "k" });
    assert.match(before.stderr, /3 tasks still draft/);

    const r = cli(h, ["toolevals", "validate", "fake", "--json"]);
    assert.equal(r.status, 1, r.stderr);
    const doc = one(r.stdout, "validate") as { tasks: { taskId: string; ok: boolean; marked: boolean; status: string }[] };
    assert.deepEqual(doc.tasks.map((t) => [t.taskId, t.ok, t.marked, t.status]), [["greet-ada", true, true, "validated"], ["greet-bob", true, true, "validated"], ["greet-nobody", false, false, "draft"]]);
    assert.match(readFileSync(join(tasks, "greet-bob.toml"), "utf8"), /^status = "validated"$/m);
    assert.doesNotMatch(readFileSync(join(tasks, "greet-nobody.toml"), "utf8"), /status/);

    const after = cli(h, ["toolevals", "run", "fake", "--driver", "model:anthropic/fake"], { FAKE_KEY: "k" });
    assert.match(after.stderr, /1 task still draft; run coding\.sh toolevals validate fake/);
  });

  it("stops at the cost gate without a TTY: action_required, exit 2", () => {
    const h = tmpHome();
    writeRepo(h, { confirmAboveUsd: 0.01 });
    const r = cli(h, ["toolevals", "run", "fake", "--driver", "model:anthropic/fake", "--json"], { FAKE_KEY: "k" });
    assert.equal(r.status, 2, r.stderr);
    const doc = one(r.stdout, "cost gate");
    assert.equal(doc.status, "action_required");
    assert.equal(doc.reason, "cost_confirmation_required");
    assert.equal(doc.next, "rerun with --yes");
    assert.ok(!existsSync(join(h.data, "toolevals")) || readdirSync(join(h.data, "toolevals")).length === 0, "nothing ran");
  });

  it("needs the model driver's API key", () => {
    const h = tmpHome();
    writeRepo(h);
    const r = cli(h, ["toolevals", "run", "fake", "--driver", "model:anthropic/fake", "--json"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FAKE_KEY/);
  });

  describe("run → compare → show against the fake provider", () => {
    let p: FakeProvider;
    before(async () => {
      // Answer from the request: call the CLI first, then repeat what it printed.
      p = await startFakeProvider((body) => {
        const text = JSON.stringify(body);
        const said = /hello (bob|ada)/.exec(text.replace(/Greet (bob|ada) using/g, ""));
        if (said) return { text: `The CLI said: hello ${said[1]}`, usage: { input: 200, output: 10 } };
        const name = /Greet (bob|ada)/.exec(text)?.[1] ?? "bob";
        return { toolCalls: [{ name: "shell", input: { command: `fake-cli greet --name ${name}` } }], usage: { input: 150, output: 12 } };
      });
    });
    after(() => p.close());

    it("runs two driver arms, compares them and shows a trial", async () => {
      const h = tmpHome();
      writeRepo(h, { providerUrl: p.url });
      const run = await cliAsync(h, ["toolevals", "run", "fake", "-d", "model:anthropic/fake", "-d", "model:openai-chat/fake", "-k", "2", "--yes", "--json"], { FAKE_KEY: "k" });
      assert.equal(run.status, 0, run.stderr);
      const doc = one(run.stdout, "run");
      assert.equal(doc.trials, 8);
      const arms = doc.arms as { arm: string; passAllK: number; tasks: number }[];
      assert.deepEqual(arms.map((a) => a.arm).sort(), ["base@model:anthropic/fake", "base@model:openai-chat/fake"]);
      for (const a of arms) assert.equal(a.passAllK, 2, JSON.stringify(a));

      const cmp = cli(h, ["toolevals", "compare", String(doc.experimentId), "--baseline", "base@model:anthropic/fake", "--candidate", "base@model:openai-chat/fake", "--json"]);
      assert.equal(cmp.status, 0, cmp.stderr);
      const report = one(cmp.stdout, "compare").report as { verdict: { kind: string }; comparing: string; pairedTasks: number };
      assert.equal(report.comparing, "driver");
      assert.equal(report.pairedTasks, 2);
      assert.equal(report.verdict.kind, "no-difference");

      const trials = readFileSync(join(String(doc.dir), "trials.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; metrics: { targetCalls: number; turns: number } });
      assert.equal(trials.length, 8);
      for (const t of trials) {
        assert.equal(t.metrics.targetCalls, 1);
        assert.equal(t.metrics.turns, 2);
      }
      const show = cli(h, ["toolevals", "show", trials[0]!.id, "--json"]);
      assert.equal(show.status, 0, show.stderr);
      const s = one(show.stdout, "show") as { trial: { id: string }; tap: { class: string }[]; sessions: unknown[] };
      assert.equal(s.trial.id, trials[0]!.id);
      assert.deepEqual(
        s.tap.map((r) => r.class),
        ["ok"],
      );
      assert.ok(s.sessions.length >= 1);
    });
  });
});
