// Dry test of examples/plugin-ab: the arm builder maps a plugin into a harness bundle whose hook
// runs, every task fails at its start and passes with a reference fix, and the analysis pairs runs
// and splits cost by token type. No Docker, agent or key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const AB = join(dirname(fileURLToPath(import.meta.url)), "../../../../examples/plugin-ab");
const posix = process.platform !== "win32";
const hasPython = posix && spawnSync("python3", ["--version"]).status === 0;
const root = mkdtempSync(join(tmpdir(), "plugin-ab-"));
after(() => rmSync(root, { recursive: true, force: true }));

function buildArms(plugin: string, out: string) {
  const r = spawnSync(process.execPath, [join(AB, "build-arms.mjs"), plugin, out, "test-model"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
// The [files] table of a harness.toml: target -> source, relative to the arm dir.
function files(arm: string): Record<string, string> {
  const toml = readFileSync(join(arm, "harness.toml"), "utf8");
  const out: Record<string, string> = {};
  for (const line of toml.slice(toml.indexOf("[files]")).split("\n").slice(1)) {
    const m = line.match(/^("[^"]*") = ("[^"]*")$/);
    if (m) out[JSON.parse(m[1] as string)] = JSON.parse(m[2] as string);
  }
  return out;
}
const hookCommands = (arm: string, event: string): string[] =>
  JSON.parse(readFileSync(join(arm, "settings.json"), "utf8")).hooks[event].flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));

describe("plugin-ab build-arms", () => {
  it("maps the demo plugin's SessionStart hook, and only the plugin arm gets it", () => {
    const out = join(root, "demo");
    const log = buildArms(join(AB, "demo-plugin"), out);
    assert.match(log, /hooks on SessionStart/);
    assert.deepEqual(Object.keys(files(join(out, "base"))), ["~/.claude/settings.json"]);
    assert.equal(JSON.parse(readFileSync(join(out, "base", "settings.json"), "utf8")).hooks, undefined);
    assert.match(readFileSync(join(out, "plugin", "harness.toml"), "utf8"), /^model = "test-model"$/m);
    const f = files(join(out, "plugin"));
    assert.equal(f["~/.claude/ab-plugin/hooks/terse.mjs"], "files/ab-plugin/hooks/terse.mjs");
    const [cmd] = hookCommands(join(out, "plugin"), "SessionStart");
    assert.ok(cmd && !cmd.includes("${CLAUDE_PLUGIN_ROOT}"), cmd);
    // Run it as Claude Code would: through a shell, with CLAUDE_CONFIG_DIR as the run's ~/.claude.
    if (posix) {
      const r = spawnSync("sh", ["-c", cmd as string], { env: { ...process.env, CLAUDE_CONFIG_DIR: join(out, "plugin", "files") }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, "SessionStart");
      assert.match(r.stdout, /TERSE STYLE ON/);
    }
  });

  it("runs a directly executed hook script through its interpreter, copies skills and notes MCP servers", () => {
    const p = join(root, "p2");
    mkdirSync(join(p, ".claude-plugin"), { recursive: true });
    mkdirSync(join(p, "scripts"), { recursive: true });
    mkdirSync(join(p, "skills", "tidy"), { recursive: true });
    writeFileSync(join(p, "scripts", "note.sh"), 'echo "root=$CLAUDE_PLUGIN_ROOT"\n');
    writeFileSync(join(p, "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: d\n---\n");
    writeFileSync(join(p, ".mcp.json"), "{}");
    const hooks = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/note.sh" }] }] };
    writeFileSync(join(p, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p2", hooks }));
    const out = join(root, "p2-arms");
    const log = buildArms(p, out);
    assert.match(log, /\.mcp\.json is not mapped/);
    const f = files(join(out, "plugin"));
    assert.equal(f["~/.claude/skills/tidy/SKILL.md"], "files/skills/tidy/SKILL.md");
    const [cmd] = hookCommands(join(out, "plugin"), "UserPromptSubmit");
    assert.match(cmd as string, /; sh \$CLAUDE_PLUGIN_ROOT\/scripts\/note\.sh$/);
    if (posix) {
      const dir = join(out, "plugin", "files");
      const r = spawnSync("sh", ["-c", cmd as string], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: "utf8" });
      assert.equal(r.stdout.trim(), `root=${dir}/ab-plugin`);
    }
  });

  it("refuses a directory that isn't a plugin", () => {
    const r = spawnSync(process.execPath, [join(AB, "build-arms.mjs"), join(AB, "tasks"), join(root, "x")], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no \.claude-plugin\/plugin\.json/);
  });
});

describe("plugin-ab tasks and analysis", { skip: !hasPython && "needs python3 on a POSIX system" }, () => {
  it("every task fails at its start and passes with the reference fix", () => {
    // Without NODE_TEST_CONTEXT, or the tasks' own `node --test` reports to this runner and exits 0.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const r = spawnSync("python3", [join(AB, "check-tasks.py")], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim().split("\n").filter((l) => l.endsWith(" OK")).length, 10);
  });

  it("pairs runs by task and attempt, checks the marker and splits cost by token type", () => {
    const out = join(root, "out");
    mkdirSync(join(out, "answers"), { recursive: true });
    const runs: object[] = [];
    // Per arm: [output tokens, 1-hour cache writes, reply]
    const arms = { base: [1000, 1000, "one two three four"], plugin: [800, 2000, "one two"] } as const;
    for (const task of ["t1", "t2"]) {
      for (const [arm, [outTok, cw, reply]] of Object.entries(arms)) {
        const run = `${task}-${arm}`;
        runs.push({ run, arm, task, attempt: 1, pass: true });
        const stream = [
          arm === "plugin" ? { type: "system", subtype: "hook_response", output: "TERSE STYLE ON" } : { type: "system", subtype: "init" },
          { type: "assistant", message: { id: "m1", content: [{ type: "text", text: reply }] } },
          { type: "result", total_cost_usd: 0.1, duration_ms: 2000, usage: { input_tokens: 0, output_tokens: outTok, cache_read_input_tokens: 0, cache_creation_input_tokens: cw, cache_creation: { ephemeral_1h_input_tokens: cw, ephemeral_5m_input_tokens: 0 } } },
        ];
        writeFileSync(join(out, "answers", `${run}.stdout.jsonl`), stream.map((e) => JSON.stringify(e)).join("\n") + "\n");
        writeFileSync(join(out, "answers", `${run}.txt`), reply);
      }
    }
    writeFileSync(join(out, "runs.json"), JSON.stringify(runs));
    const r = spawnSync("python3", [join(AB, "analysis", "analyze.py"), out, "--marker", "TERSE STYLE ON"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /pairs \(task, attempt\): 2 over 2 tasks/);
    assert.match(r.stdout, /shows 'TERSE STYLE ON': \{'base': 0, 'plugin': 2\}/);
    const s = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    assert.equal(s["output tokens"].change, "-20.0%");
    assert.equal(s["final reply words"].change, "-50.0%");
    // Default list prices: output $20/M, 1-hour cache writes $8/M.
    assert.ok(Math.abs(s["cost split"].output.change - -200 * 20e-6) < 1e-12);
    assert.ok(Math.abs(s["cost split"]["cache write"].change - 1000 * 8e-6) < 1e-12);
  });
});
