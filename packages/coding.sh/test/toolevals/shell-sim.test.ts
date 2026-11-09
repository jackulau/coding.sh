// TB-14: a model plays the shell for model-driver CLI evals. A stub simulator
// answers the shell calls (nothing runs in the sandbox), the trial records the
// shell model, the arm name carries it, and compare refuses mixed shells.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { runTrial, type ToolJob } from "../../src/toolevals/experiment.ts";
import { compareToolArms } from "../../src/toolevals/compare.ts";
import { parseDriver, withShellModel } from "../../src/toolevals/config.ts";
import { DEFAULT_SHELL_DATE, parseSimReply } from "../../src/toolevals/model/shell-sim.ts";
import { driverKey, shellModelOf, type Driver } from "../../src/toolevals/types.ts";
import { MemBlobs, MemIndex } from "../helpers-eval.ts";
import { startFakeProvider } from "./fixtures/fake-provider.mjs";
import { cleanup, cliTarget, task, tmp, trial } from "./helpers.ts";

after(cleanup);

describe("simulated shell", () => {
  it("a stub simulator answers shell calls with a fixed date; the trial records the shell model", async () => {
    // Agent model: one shell call, then answers with what it saw.
    const agent = await startFakeProvider((body) => {
      const msgs = JSON.stringify(body.messages ?? body.input ?? "");
      return msgs.includes("tool_result") ? { text: msgs.includes("hello bob") ? "The CLI said: hello bob" : "nothing" } : { toolCalls: [{ name: "shell", input: { command: "fake-cli greet --name bob && date" } }] };
    });
    // Simulator: answers from the command and the date in its system prompt.
    const sim = await startFakeProvider((body) => {
      const system = JSON.stringify(body.system ?? body.messages ?? "");
      assert.match(system, /simulating a Linux machine/);
      assert.ok(system.includes(DEFAULT_SHELL_DATE));
      return { text: `hello bob\nThu Jan 15 09:30:00 UTC 2026\nexit: 0`, usage: { input: 50, output: 12 } };
    });
    try {
      const base = parseDriver("model:anthropic/agent-model", { "model:anthropic/agent-model": { baseUrl: agent.url, apiKeyEnv: "AGENT_KEY" } });
      const driver = withShellModel(base, "openai-chat/stub-shell", { "model:openai-chat/stub-shell": { baseUrl: `${sim.url}/v1`, apiKeyEnv: "SIM_KEY" } });
      assert.equal(driverKey(driver), "model:anthropic/agent-model+shell:openai-chat/stub-shell");
      const job: ToolJob = { task: task(), variant: { name: "base" }, driver, attempt: 1 };
      const index = new MemIndex();
      const r = await runTrial({ job, target: cliTarget(), experimentId: "texp_sim", expDir: tmp(), index, blobs: new MemBlobs(), adapterFor: () => { throw new Error("no agent"); }, env: { AGENT_KEY: "a", SIM_KEY: "s" }, keep: true });
      assert.equal(r.error, undefined);
      assert.equal(r.pass, true, JSON.stringify(r.checks));
      assert.equal(r.shellModel, "openai-chat/stub-shell");
      assert.equal(r.driver, "model:anthropic/agent-model+shell:openai-chat/stub-shell");
      assert.equal(sim.requests.length, 1);
      // Nothing ran in the sandbox: the tapped CLI saw no call.
      assert.equal(r.metrics.targetCalls, 0);
      const events = await index.listEvents(r.sessionId!);
      const end = events.find((e) => e.kind === "tool.end")!;
      assert.equal(end.payload.simulated, true);
      assert.equal(end.payload.shellModel, "openai-chat/stub-shell");
      assert.match(String(end.payload.output), /hello bob\nThu Jan 15 09:30:00 UTC 2026\n\[exit code 0\]/);
      // The simulator call counts for usage, not as an agent turn.
      const simCall = events.find((e) => e.kind === "llm.call" && e.payload.purpose === "shell-simulator")!;
      assert.equal(simCall.model, "stub-shell");
      assert.equal(r.metrics.turns, 2);
      assert.equal(r.metrics.usage.inputTokens, 100 + 100 + 50);
      // The agent's second request carried the simulated output.
      assert.match(JSON.stringify(agent.requests[1]!.body), /hello bob/);
    } finally {
      await agent.close();
      await sim.close();
    }
  });

  it("parses the exit code line, and defaults to 0", () => {
    assert.deepEqual(parseSimReply("ls: x: No such file\nexit: 2"), { output: "ls: x: No such file", exitCode: 2 });
    assert.deepEqual(parseSimReply("```\nfoo\n```"), { output: "foo", exitCode: 0 });
    assert.deepEqual(parseSimReply("a\n[exit code 1]"), { output: "a", exitCode: 1 });
  });

  it("compare refuses arms with different shell models, and a real vs simulated shell", () => {
    const real = "model:anthropic/m";
    const simA = "model:anthropic/m+shell:anthropic/haiku";
    const simB = "model:anthropic/m+shell:openai/mini";
    assert.equal(shellModelOf(simA), "anthropic/haiku");
    assert.equal(shellModelOf(real), undefined);
    const trials = [real, simA, simB].flatMap((d) => [trial("a", "base", d, 1, true), trial("b", "base", d, 1, false)]);
    assert.throws(() => compareToolArms(trials, { baseline: `base@${simA}`, candidate: `base@${simB}` }), /different shells \(simulated by anthropic\/haiku vs simulated by openai\/mini\)/);
    assert.throws(() => compareToolArms(trials, { baseline: `base@${real}`, candidate: `base@${simA}` }), /different shells \(real vs simulated by anthropic\/haiku\)/);
    // Same shell model on both arms compares (variants differ).
    const same = [...trials, trial("a", "terse", simA, 1, true), trial("b", "terse", simA, 1, true)];
    const r = compareToolArms(same, { baseline: `base@${simA}`, candidate: `terse@${simA}`, seed: 1 });
    assert.equal(r.comparing, "variant");
  });

  it("withShellModel refuses agent drivers", () => {
    const d: Driver = { kind: "agent", agent: "claude-code" };
    assert.throws(() => withShellModel(d, "anthropic/haiku"), /model drivers/);
  });
});
