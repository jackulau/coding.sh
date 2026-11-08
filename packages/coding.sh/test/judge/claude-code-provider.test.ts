import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createGrader } from "../../src/graders/index.ts";
import { claudeCodeProvider, ProviderError } from "../../src/judge/index.ts";
import { nodeBin, pathOf } from "../_bin.ts";

// A fake `claude` that logs its argv, stdin and cwd, then answers like `claude -p --output-format json`.
const FAKE = `
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd() }));
  const mode = process.env.FAKE_MODE;
  if (mode === "error") {
    process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }) + "\\n");
    process.exitCode = 1;
    return;
  }
  if (mode === "garbage") {
    process.stderr.write("boom");
    process.exitCode = 2;
    return;
  }
  const verdict = { score: 0.8, pass: true, reason: "clear and correct", citations: [] };
  process.stdout.write(JSON.stringify({
    type: "result", is_error: false, stop_reason: "end_turn",
    result: mode === "text" ? JSON.stringify(verdict) : "done",
    ...(mode === "text" ? {} : { structured_output: verdict }),
    usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 7 },
    modelUsage: { "claude-sonnet-5-5": { inputTokens: 10 } },
  }) + "\\n");
});
`;

describe("claude-code judge provider", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const log = () => readFile(join(dir, "log.json"), "utf8").then((s) => JSON.parse(s) as { argv: string[]; input: string; cwd: string });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "csh-cc-judge-"));
    nodeBin(join(dir, "bin"), "claude", FAKE);
    env = { PATH: pathOf(join(dir, "bin"), process.env.PATH), FAKE_LOG: join(dir, "log.json") };
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("grades through `claude -p` with no tools, hooks, plugins or saved session, and reads the structured verdict", async () => {
    const g = await createGrader({ kind: "llm", name: "clarity", rubric: "Is the reply clear?", provider: "claude-code", model: "claude-sonnet-5-5" }, { env });
    const v = await g.grade({ input: "explain the bug", output: "Off by one in the loop bound." });
    assert.equal(v.pass, true);
    assert.equal(v.score, 0.8);
    assert.equal(v.reason, "clear and correct");
    const { argv, input, cwd } = await log();
    assert.equal(argv[0], "-p");
    const flag = (name: string) => argv[argv.indexOf(name) + 1] ?? "";
    assert.equal(flag("--output-format"), "json");
    assert.equal(flag("--model"), "claude-sonnet-5-5");
    assert.equal(flag("--tools"), "");
    assert.equal(flag("--setting-sources"), "", "no user or project settings: the arm's hooks and plugins never reach the judge");
    for (const f of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) assert.ok(argv.includes(f), f);
    assert.match(flag("--system-prompt"), /\S/);
    assert.ok(JSON.parse(flag("--json-schema")).properties, "asks for the verdict schema");
    assert.match(input, /Off by one in the loop bound\./, "the material goes over stdin");
    assert.ok(!existsSync(cwd), "runs in a temp dir that is removed afterwards");
  });

  it("falls back to the result text when there is no structured output, and reports usage with cache tokens", async () => {
    const p = claudeCodeProvider({ env: { ...env, FAKE_MODE: "text" } });
    const r = await p.complete({ system: "s", user: "u" });
    assert.deepEqual(JSON.parse(r.text).score, 0.8);
    assert.equal(r.model, "claude-sonnet-5-5");
    assert.deepEqual(r.usage, { inputTokens: 15, outputTokens: 7 });
    assert.equal(p.name, "claude-code");
  });

  it("fails loudly when the CLI reports an error, prints no JSON, or is missing", async () => {
    await assert.rejects(claudeCodeProvider({ env: { ...env, FAKE_MODE: "error" } }).complete({ system: "s", user: "u" }), (e: Error) => e instanceof ProviderError && /Not logged in/.test(e.message));
    await assert.rejects(claudeCodeProvider({ env: { ...env, FAKE_MODE: "garbage" } }).complete({ system: "s", user: "u" }), /exited 2 without a JSON result: boom/);
    await assert.rejects(claudeCodeProvider({ env, command: "no-such-claude-cli" }).complete({ system: "s", user: "u" }), /not on PATH/);
  });
});
