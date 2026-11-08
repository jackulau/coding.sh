import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { RunSpec } from "../../src/core/types.ts";
import { createRedactor } from "../../src/core/redact.ts";
import { readGraderUsage, runTask } from "../../src/runner/run.ts";
import { cleanupWorlds, fakeAdapter, obedientAgent, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

describe("runTask", () => {
  it("runs the agent in an overlaid work dir and grades it with hidden tests", async () => {
    const w = await toyWorld();
    const adapter = obedientAgent();
    const bundle = await w.mkBundle("fixer", "always fix bugs");
    const r = await runTask({ task: w.task, bundle, adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, attempt: 2, experimentId: "e1", env: { EXTRA: "x" } });
    assert.equal(r.error, undefined);
    assert.equal(r.pass, true);
    assert.equal(r.verifierExit, 0);
    assert.equal(r.attempt, 2);
    assert.equal(r.experimentId, "e1");
    assert.equal(r.sessionId, `sess-${r.id}`);
    assert.deepEqual(w.index.runs, [r]);
    const spec = adapter.specs[0] as RunSpec;
    assert.equal(spec.instruction, "fix add and mul");
    assert.equal(spec.env.CODING_SH_RUN_ID, r.id);
    assert.equal(spec.env.FROM_BUNDLE, "1");
    assert.equal(spec.env.EXTRA, "x");
    assert.equal(spec.env.HOME, undefined, "no ~/ files → no HOME override");
    assert.deepEqual(spec.flags, ["--b", "--fake-overlay"]);
    // Agent's diff only: no overlay (CLAUDE.md, README removal), no setup output, no hidden tests.
    const diff = (await w.blobs.getText(r.diffBlob ?? "")) ?? "";
    assert.match(diff, /src\/add\.js/);
    assert.match(diff, /src\/mul\.js/);
    assert.doesNotMatch(diff, /CLAUDE\.md|README|build\.log|add\.test\.js/);
    assert.deepEqual(await readdir(w.runsDir), [], "run dir cleaned up");
    assert.equal(r.agent.finalText, "done", "no stdout file: the answer comes from the tail");
  });

  it("hands the verifier the agent's answer and whole stdout, outside the work tree, and sums its judge spend", async () => {
    const w = await toyWorld();
    const stream = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "vercel whoami" } }] } }),
      JSON.stringify({ type: "result", result: "Which Vercel team should I audit?" }),
    ];
    const adapter = fakeAdapter({
      act: async (spec) => {
        assert.ok(spec.stdoutFile, "the runner asks the adapter to tee stdout");
        await writeFile(spec.stdoutFile, stream.join("\n") + "\n");
        await writeFile(join(spec.cwd, "notes.txt"), "asked for scope\n");
      },
    });
    const verifier = [
      'test "$CODING_SH_AGENT" = fake',
      'grep -q "^+asked for scope" "$CODING_SH_AGENT_DIFF"',
      'case "$CODING_SH_AGENT_DIFF" in "$PWD"/*) exit 4;; esac',
      'test "$(cat "$CODING_SH_AGENT_OUTPUT")" = "Which Vercel team should I audit?"',
      'grep -q "vercel whoami" "$CODING_SH_AGENT_STDOUT"',
      'test "$CODING_SH_SESSION_ID" = "sess-$CODING_SH_RUN_ID"',
      'case "$CODING_SH_AGENT_OUTPUT" in "$PWD"/*) exit 3;; esac',
      `printf '%s\\n' '{"model":"m","costUsd":0.25,"inputTokens":10,"outputTokens":5}' '{"model":"unknown"}' 'not json' >> "$CODING_SH_GRADER_USAGE"`,
    ].join(" && ");
    const task = { ...w.task, setup: [], verifier: { command: verifier, hiddenFiles: {}, timeoutMs: 30_000 } };
    const r = await runTask({ task, bundle: await w.mkBundle("x", "x"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.verifierExit, 0, r.error);
    assert.equal(r.pass, true);
    assert.equal(r.agent.finalText, "Which Vercel team should I audit?");
    assert.deepEqual(r.graderUsage, { calls: 2, costUsd: 0.25, unpriced: 1, inputTokens: 10, outputTokens: 5 });
  });

  it("readGraderUsage: a missing file is no usage", async () => {
    assert.equal(await readGraderUsage("/nonexistent/grader-usage.jsonl"), undefined);
  });

  it("ingests before removing the run dir, so the agent's transcript in it can still be read; an ingest error never fails the run", async () => {
    const w = await toyWorld();
    const seen: boolean[] = [];
    const ingest = async () => {
      const [dir] = await readdir(w.runsDir);
      seen.push(!!dir && existsSync(join(w.runsDir, dir, "work")));
      throw new Error("ingest down");
    };
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("fixer", "always fix bugs"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, ingest });
    assert.deepEqual(seen, [true]);
    assert.equal(r.pass, true);
    assert.equal(r.error, undefined);
    assert.deepEqual(await readdir(w.runsDir), []);
  });

  it("records a failing attempt without throwing", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("half", "half effort"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, false);
    assert.equal(r.verifierExit, 1);
    assert.equal(r.error, undefined);
  });

  it("keeps the end of a failed verifier's output on the run, colour codes removed and secrets redacted", async () => {
    const w = await toyWorld();
    const key = "sk-ant-" + "api03-" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const script = [
      "for i in $(seq 1 600); do echo \"ok $i\"; done",
      `printf '\\033[31mFAIL\\033[0m expected 5, got -1 (sent ${key})\\n'`,
      "echo 'AssertionError: -1 !== 5' >&2",
      "echo 'order ACME-123456' >&2",
      "exit 1",
    ].join("; ");
    const task = { ...w.task, setup: [], verifier: { command: script, hiddenFiles: {}, timeoutMs: 30_000 } };
    const redactor = createRedactor({ redact: ["secrets"], patterns: ["ACME-\\d{6}"] });
    const r = await runTask({ task, bundle: await w.mkBundle("x", "x"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, redactor });
    assert.equal(r.verifierExit, 1);
    const o = r.verifierOutput;
    assert.ok(o?.stdout && o.stderr, JSON.stringify(o));
    assert.match(o.stdout, /FAIL expected 5, got -1 \(sent \[redacted:anthropic-key\]\)$/);
    assert.doesNotMatch(o.stdout, /\x1b|sk-ant/);
    assert.ok(o.stdout.length <= 4100 && /^…\nok \d+\n/.test(o.stdout), "the start is trimmed to whole lines");
    assert.equal(o.stderr, "AssertionError: -1 !== 5\norder [redacted:pattern]");
    assert.deepEqual(w.index.runs[0]?.verifierOutput, o, "stored with the run");
  });

  it("keeps no verifier output when the verifier printed nothing", async () => {
    const w = await toyWorld();
    const task = { ...w.task, setup: [], verifier: { command: "exit 1", hiddenFiles: {}, timeoutMs: 30_000 } };
    const r = await runTask({ task, bundle: await w.mkBundle("x", "x"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.verifierExit, 1);
    assert.equal("verifierOutput" in r, false);
  });

  it("an agent that throws becomes an error; the verifier still runs", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: w.task, bundle: await w.mkBundle("x", "x"), adapter: fakeAdapter({ throws: true }), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.equal(r.pass, false);
    assert.match(r.error ?? "", /agent failed: agent exploded/);
    assert.equal(r.verifierExit, 1);
    assert.equal(w.index.runs.length, 1);
  });

  it("setup failure is recorded and the agent never runs", async () => {
    const w = await toyWorld();
    const adapter = obedientAgent();
    const r = await runTask({ task: { ...w.task, setup: ["exit 9"] }, bundle: await w.mkBundle("x", "fix"), adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.match(r.error ?? "", /setup `exit 9` exited 9/);
    assert.equal(adapter.specs.length, 0);
    assert.equal(w.index.runs.length, 1);
  });

  it("~/ overlay files get an isolated HOME inside the run dir; keep leaves the dir", async () => {
    const w = await toyWorld();
    const bundle = await w.mkBundle("home", "fix", { files: { "CLAUDE.md": await w.blobs.put("fix"), "~/.claude/CLAUDE.md": await w.blobs.put("user-level") } });
    const adapter = obedientAgent();
    const r = await runTask({ task: w.task, bundle, adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, keep: true });
    const home = (adapter.specs[0] as RunSpec).env.HOME ?? "";
    assert.equal(home, join(w.runsDir, r.id, "home"));
    assert.notEqual(home, process.env.HOME);
    assert.equal(await readFile(join(home, ".claude/CLAUDE.md"), "utf8"), "user-level");
    assert.ok(existsSync(join(w.runsDir, r.id, "work", "src/add.js")));
  });

  it("a broken snapshot is an error result, not an exception", async () => {
    const w = await toyWorld();
    const r = await runTask({ task: { ...w.task, start: { ...w.task.start, snapshot: "missing" } }, bundle: await w.mkBundle("x", "x"), adapter: obedientAgent(), blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir });
    assert.match(r.error ?? "", /unknown snapshot/);
    assert.equal(r.pass, false);
  });
});
