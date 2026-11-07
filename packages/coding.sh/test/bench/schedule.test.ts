// Schedule output: cron line, a pinned workflow with a secrets env block and
// artifact-backed history, and crontab merging that keeps other lines.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { benchHome, parseDefinition } from "../../src/bench/define.ts";
import { cronLine, envRefs, installCron, mergeCrontab, parseAt, shq, workflowYaml } from "../../src/bench/schedule.ts";

const o = { name: "daily", cwd: "/srv/proj", cli: ["coding.sh"], env: { CODING_SH_HOME: "/h/.coding.sh" } };

describe("bench schedule", () => {
  test("cron line runs from the project and marks itself", () => {
    // The log is a native path: on Windows /h resolves to C:\h and gets quoted.
    const log = shq(join(benchHome(o.env), "daily", "cron.log"));
    if (process.platform !== "win32") assert.equal(log, "/h/.coding.sh/benchmarks/daily/cron.log");
    assert.equal(cronLine({ ...o, at: "07:05" }), `5 7 * * * cd /srv/proj && coding.sh bench run daily >> ${log} 2>&1 # coding.sh bench daily`);
    assert.throws(() => parseAt("25:00"), /HH:MM/);
  });

  test("workflow: pinned version, secrets from env refs, history as an artifact", () => {
    const def = parseDefinition(
      `name = "daily"\n[source]\nkind = "github"\nrepo = "a/b"\ntokenEnv = "BENCH_GH_TOKEN"\n[[contenders]]\nname = "x"\nurl = "https://x.test"\nheaderEnv = { authorization = "X_KEY" }\n[[contenders]]\nname = "y"\ncommand = "y"\n[[graders]]\nkind = "llm"\nrubric = "r"\napiKeyEnv = "JUDGE_KEY"\n`,
      "/srv/proj/bench/daily.toml",
    );
    assert.deepEqual(envRefs(def), ["BENCH_GH_TOKEN", "JUDGE_KEY", "X_KEY"]);
    const hosted = workflowYaml({ ...o, runner: "ubuntu-latest", version: "1.2.3", secrets: envRefs(def) });
    assert.match(hosted, /npm install -g coding\.sh@1\.2\.3/);
    assert.match(hosted, /JUDGE_KEY: \$\{\{ secrets\.JUDGE_KEY \}\}/);
    assert.match(hosted, /gh run download "\$id" --name bench-daily-runs/);
    assert.match(hosted, /name: bench-daily-runs\n {10}path: ~\/\.coding\.sh\/benchmarks\/daily/);
    assert.doesNotMatch(hosted, /actions\/cache/);
    const self = workflowYaml({ ...o, version: "1.2.3" });
    assert.match(self, /runs-on: self-hosted/);
    assert.doesNotMatch(self, /gh run download/, "a self-hosted runner keeps its records on disk");
    assert.doesNotMatch(self, /^ {4}env:$/m, "no empty env block");
  });

  test("crontab merge replaces only our marked line", () => {
    const cur = "0 1 * * * a\n5 7 * * * old # coding.sh bench daily\n9 9 * * * b # coding.sh bench other\n";
    const { text, replaced } = mergeCrontab(cur, "1 2 * * * new # coding.sh bench daily", "daily");
    assert.ok(replaced);
    assert.equal(text, "0 1 * * * a\n9 9 * * * b # coding.sh bench other\n1 2 * * * new # coding.sh bench daily\n");
    let stored = text;
    const io = { read: () => stored, write: (t: string) => void (stored = t) };
    assert.deepEqual(installCron(io, "1 2 * * * new # coding.sh bench daily", "daily"), { replaced: true, changed: false });
  });
});
