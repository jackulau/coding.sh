// `--trial-timeout` propagation across `coding.sh refine`:
// - `--proposer-command` on `refine propose` and `refine run` (and accurate limit text)
// - model proposer on `refine propose`
// - non-suite `refine test` decision-point continuation calls and judge calls
// - `refine distill` forwarding `timeoutMs` (with default preserved when omitted)
// - `refine recheck` accepting and forwarding `--trial-timeout`
// - `refine diagnose` accepting and forwarding `--trial-timeout`
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { which } from "../../src/adapters/_shared/detect.ts";
import { DEFAULT_PROPOSER_TIMEOUT_MS, timeoutLimitText } from "../../src/cli/commands/refine-loop.ts";
import { posixShell } from "../../src/core/spawn.ts";
import type { AgentRunOutput, EvalTask, RunResult, RunSpec } from "../../src/core/types.ts";
import { continuationTask } from "../../src/experiments/continuation.ts";
import { providerFromSpec } from "../../src/graders/index.ts";
import { ProviderError, withCallTimeout, type ChatProvider } from "../../src/judge/providers.ts";
import { DISTILL_TIMEOUT_MS, distill } from "../../src/refine/distill.ts";
import { pathOf } from "../_bin.ts";
import { CLI } from "../_cli.ts";
import { claimSession, putSession, sessionEvents } from "../helpers-decision.ts";

const gitBin = which("git") ?? "";
const BASE = "Keep answers short.\nNever run `git push --force`.\n";
const TEST_RULE = "TEST-RULE: run npm test before you say you are done.";

let root = "";
let server: Server;
let serverUrl = "";
let serverMode: "normal" | "hang-proposer" | "hang-turn" | "hang-judge" | "hang-diagnose" = "normal";
const serverHits: { kind: string }[] = [];
const openTimers = new Set<ReturnType<typeof setTimeout>>();

function reply(model: string, content: unknown[], stop: string) {
  return { id: "msg_stub", type: "message", role: "assistant", model, content, stop_reason: stop, usage: { input_tokens: 200, output_tokens: 20 } };
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-timeout-")));
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; system?: string; messages: { content: unknown }[] };
      const sys = String(body.system ?? "");
      const kind = sys.startsWith("You are a strict")
        ? "judge"
        : sys.startsWith("You improve the instruction file")
          ? "proposer"
          : sys.includes("failure taxonomy") || sys.includes("diagnos")
            ? "diagnose"
            : "turn";
      serverHits.push({ kind });

      const shouldHang =
        (serverMode === "hang-proposer" && kind === "proposer") ||
        (serverMode === "hang-turn" && kind === "turn") ||
        (serverMode === "hang-judge" && kind === "judge") ||
        (serverMode === "hang-diagnose" && kind === "diagnose");
      if (shouldHang) {
        const t = setTimeout(() => {
          openTimers.delete(t);
          if (!res.writableEnded) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(reply(body.model, [{ type: "text", text: "late" }], "end_turn")));
          }
        }, 30_000);
        openTimers.add(t);
        res.on("close", () => {
          clearTimeout(t);
          openTimers.delete(t);
        });
        return;
      }

      let out;
      if (kind === "judge") {
        out = reply(body.model, [{ type: "text", text: JSON.stringify({ score: 1, pass: true, confidence: 0.9, reason: "ok", citations: [] }) }], "end_turn");
      } else if (kind === "proposer") {
        out = reply(body.model, [{ type: "text", text: JSON.stringify({ lines: [TEST_RULE], rationale: "fix claims" }) }], "end_turn");
      } else {
        out = reply(body.model, [{ type: "tool_use", id: `toolu_${serverHits.length}`, name: "Bash", input: { command: "npm test" } }], "tool_use");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const t of openTimers) clearTimeout(t);
  openTimers.clear();
  server?.closeAllConnections?.();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (root) rmSync(root, { recursive: true, force: true });
});

interface TestEnv {
  home: string;
  repo: string;
  bin: string;
  env: NodeJS.ProcessEnv;
}

async function setupEnv(name: string, o: { claims?: number; withDistillExp?: boolean } = {}): Promise<TestEnv> {
  const base = join(root, name);
  const home = join(base, "home");
  const repo = join(base, "repo");
  const bin = join(base, "bin");
  const tmp = join(base, "tmp");
  for (const d of [home, repo, bin, tmp]) mkdirSync(d, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: pathOf(
      bin,
      dirname(process.execPath),
      gitBin ? dirname(gitBin) : undefined,
      process.platform === "win32" ? dirname(posixShell() ?? "") : undefined,
      process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : undefined,
      "/usr/bin",
      "/bin",
    ),
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: tmp,
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
    CODING_SH_RETRY_BASE_MS: "0",
    CODING_SH_HOOK_SOURCE: join(base, "hook-source.mjs"),
    ANTHROPIC_API_KEY: "sk-stub",
    ANTHROPIC_BASE_URL: serverUrl,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  writeFileSync(join(base, "hook-source.mjs"), "// test hook\n");
  writeFileSync(join(repo, "CLAUDE.md"), BASE);
  if (gitBin) {
    const git = (...a: string[]) => assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
  }
  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    const now = Date.now();
    for (let i = 0; i < (o.claims ?? 2); i++) {
      await putSession(ctx.index, claimSession(`claim-${name}-${i}`, { cwd: repo, startedAt: now - (i + 1) * 3600_000 }, `src/mod${i}.js`));
    }
    if (o.withDistillExp) {
      const task = (id: string): EvalTask => ({ id, name: id, status: "validated", start: { repoRoot: repo, snapshot: "s", head: "h" }, instruction: "Fix it.", setup: [], verifier: { command: "true", hiddenFiles: {}, timeoutMs: 1000 }, tags: [], createdAt: 0 });
      for (let t = 0; t < 4; t++) await ctx.index.putTask(task(`t${t}`));
      for (let i = 0; i < 20; i++) {
        const sid = `exp_to-s${i}`;
        const pass = i >= 6;
        await putSession(ctx.index, sessionEvents(sid, { cwd: repo, startedAt: now - (30 - i) * 1000, runId: "exp_to" }, [["session.start", {}], ["user.message", { text: "Fix it." }], ["assistant.message", { text: pass ? "Fixed." : "Done." }]]), { runId: "exp_to" });
        const r: RunResult = { id: `exp_to_r${i}`, experimentId: "exp_to", taskId: `t${i % 4}`, bundleId: "b".repeat(64), attempt: i, sessionId: sid, pass, verifierExit: pass ? 0 : 1, agent: { exitCode: 0, timedOut: false, durationMs: 50, stdoutTail: "", stderrTail: "" }, startedAt: now - (30 - i) * 1000, endedAt: now - (30 - i) * 1000 + 50 };
        await ctx.index.putRun(r);
      }
    }
  } finally {
    await ctx.close();
  }
  return { home, repo, bin, env };
}

function runCli(e: TestEnv, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  const started = Date.now();
  return new Promise((done) => {
    const p = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...e.env, ...extraEnv }, cwd: e.repo });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => done({ status, stdout, stderr, elapsedMs: Date.now() - started }));
  });
}

describe("refine timeout helpers and provider propagation", () => {
  it("formats timeout limits accurately while preserving the 10 minute proposer default", () => {
    assert.equal(DEFAULT_PROPOSER_TIMEOUT_MS, 600_000);
    assert.equal(timeoutLimitText(DEFAULT_PROPOSER_TIMEOUT_MS), "10 minute");
    assert.equal(timeoutLimitText(60_000), "1 minute");
    assert.equal(timeoutLimitText(1_000), "1 second");
    assert.equal(timeoutLimitText(90_000), "90 second");
  });

  it("withCallTimeout preserves the provider when omitted and enforces timeoutMs without retrying", async () => {
    const base: ChatProvider = {
      name: "stub",
      model: "m",
      params: { maxTokens: 100 },
      async complete(req) {
        await new Promise<void>((_, reject) => {
          const t = setTimeout(() => reject(new Error("late")), 30_000);
          req.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(req.signal?.reason ?? new Error("aborted"));
            },
            { once: true },
          );
        });
        return { text: "never", model: "m" };
      },
    };
    assert.equal(withCallTimeout(base, undefined), base);

    const timed = withCallTimeout(base, 80);
    assert.deepEqual([timed.name, timed.model, timed.params], [base.name, base.model, base.params]);
    await assert.rejects(() => timed.complete({ system: "s", user: "u" }), (err: unknown) => err instanceof ProviderError && err.message === "stub: timed out after 80 ms (trial timeout)");

    // Caller abort propagates as the caller's abort, not a trial timeout.
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new Error("user cancelled")), 25);
    await assert.rejects(() => withCallTimeout(base, 5_000).complete({ system: "s", user: "u", signal: ctl.signal }), /user cancelled/);
  });

  it("providerFromSpec forwards timeoutMs to HTTP calls and stops on timeout without retries", async () => {
    let calls = 0;
    const hangingFetch = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        calls++;
        const t = setTimeout(() => reject(new Error("late")), 30_000);
        init.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(init.signal?.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
    const p = providerFromSpec({ provider: "anthropic", model: "claude-sonnet-5-5" }, { env: { ANTHROPIC_API_KEY: "sk-test" }, fetch: hangingFetch, timeoutMs: 80 });
    await assert.rejects(() => p.complete({ system: "s", user: "u" }), /timed out after 80 ms \(trial timeout\)/);
    assert.equal(calls, 1, "a call over timeoutMs is not retried");
  });

  it("continuationTask forwards timeoutMs to HTTP fetch and keeps defaults when omitted", async () => {
    let calls = 0;
    const hangingFetch = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        calls++;
        const t = setTimeout(() => reject(new Error("late")), 30_000);
        init.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(init.signal?.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      });
    const task = continuationTask({
      kind: "continuation",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      cache: false,
      env: { ANTHROPIC_API_KEY: "sk-test" },
      fetch: hangingFetch,
      retry: { retries: 0 },
      timeoutMs: 80,
    });
    const prefix = { v: 1 as const, tools: [], messages: [{ role: "user" as const, text: "hi" }] };
    await assert.rejects(() => task.run(prefix, { runId: "r", caseId: "c", trial: 1 }), /timed out after 80 ms/);
    assert.equal(calls, 1);
  });

  it("distill forwards timeoutMs to adapter.run, preserves the 20 minute default, and reports the active limit on timeout", async () => {
    const dir = join(root, "distill-unit");
    const corpusDir = join(dir, "corpus");
    mkdirSync(join(corpusDir, "episodes", "ep0001"), { recursive: true });
    writeFileSync(join(corpusDir, "episodes.jsonl"), `${JSON.stringify({ episode: "ep0001", pass: false })}\n`);
    writeFileSync(join(corpusDir, "tool_calls.jsonl"), "");
    writeFileSync(join(corpusDir, "SCHEMA.md"), "# schema\n");
    writeFileSync(join(corpusDir, "episodes", "ep0001", "transcript.md"), "# t\n");

    const seenTimeouts: number[] = [];
    const adapter = {
      id: "claude-code",
      async run(spec: RunSpec): Promise<AgentRunOutput> {
        seenTimeouts.push(spec.timeoutMs);
        return { exitCode: null, timedOut: true, durationMs: 50, stdoutTail: "", stderrTail: "" };
      },
    };
    const custom = await distill({ corpusDir, adapter, timeoutMs: 1_000, workRoot: join(dir, "w1"), base: [], skillsDir: ".claude/skills" });
    assert.deepEqual(seenTimeouts, [1_000]);
    assert.match(custom.draws[0]!.error ?? "", /it ran out of time after the 1 second limit/);

    const fallback = await distill({ corpusDir, adapter, workRoot: join(dir, "w2"), base: [], skillsDir: ".claude/skills" });
    assert.deepEqual(seenTimeouts, [1_000, DISTILL_TIMEOUT_MS]);
    assert.match(fallback.draws[0]!.error ?? "", /it ran out of time after the 20 minute limit/);
  });
});

describe("CLI refine --trial-timeout propagation", () => {
  it("refine propose and refine run enforce --trial-timeout on --proposer-command and report the active limit", async () => {
    const e = await setupEnv("proposer-cmd");
    const sleeper = join(root, "sleep.mjs");
    writeFileSync(sleeper, "setTimeout(() => {}, 30_000);\n");
    const cmd = `"${process.execPath}" "${sleeper}"`;

    const prop = await runCli(e, ["refine", "propose", "--proposer-command", cmd, "--trial-timeout", "1", "--json"]);
    assert.equal(prop.status, 1, prop.stdout + prop.stderr);
    assert.ok(prop.elapsedMs < 15_000, `expected fast timeout, took ${prop.elapsedMs}ms`);
    const propErr = JSON.parse(prop.stderr) as { reason: string; message: string };
    assert.equal(propErr.reason, "proposer_failed");
    assert.match(propErr.message, /--proposer-command exited after the 1 second limit/);
    assert.doesNotMatch(propErr.message, /10 minute/);

    const run = await runCli(e, ["refine", "run", "--proposer-command", cmd, "--trial-timeout", "1", "--rounds", "1", "--json"]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.ok(run.elapsedMs < 15_000, `expected fast timeout, took ${run.elapsedMs}ms`);
    const runErr = JSON.parse(run.stderr) as { reason: string; message: string };
    assert.equal(runErr.reason, "proposer_failed");
    assert.match(runErr.message, /--proposer-command exited after the 1 second limit/);
  });

  it("refine propose enforces --trial-timeout on the model proposer without retrying", async () => {
    const e = await setupEnv("proposer-model");
    const before = serverHits.length;
    serverMode = "hang-proposer";
    try {
      const r = await runCli(e, ["refine", "propose", "--trial-timeout", "1", "--json"]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.ok(r.elapsedMs < 15_000, `expected fast timeout, took ${r.elapsedMs}ms`);
      const err = JSON.parse(r.stderr) as { reason: string; message: string };
      assert.equal(err.reason, "proposer_failed");
      assert.match(err.message, /Proposer timed out after the 1 second limit/);
      assert.equal(serverHits.slice(before).filter((h) => h.kind === "proposer").length, 1, "model proposer did not retry past --trial-timeout");
    } finally {
      serverMode = "normal";
    }
  });

  it("non-suite refine test forwards --trial-timeout to decision-point continuation calls and judge calls", async () => {
    const e = await setupEnv("decision-eval", { claims: 1 });
    const draftDir = join(root, "draft-decision");
    mkdirSync(draftDir, { recursive: true });
    const cand = join(draftDir, "CLAUDE.md");
    writeFileSync(cand, `${BASE}${TEST_RULE}\n`);

    // 1. Hanging continuation model call times out at --trial-timeout 1 without retries.
    let before = serverHits.length;
    serverMode = "hang-turn";
    try {
      const r = await runCli(e, ["refine", "test", cand, "--trial-timeout", "1", "--no-cache", "--json"]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.ok(r.elapsedMs < 15_000, `expected fast continuation timeout, took ${r.elapsedMs}ms`);
      const doc = JSON.parse(r.stdout) as { rounds: { verdict: string; experiments?: { devA: string; devB: string } }[] };
      assert.equal(doc.rounds[0]!.verdict, "inconclusive");
      // 1 case x 2 arms = 2 calls, zero retries.
      assert.equal(serverHits.slice(before).filter((h) => h.kind === "turn").length, 2);
    } finally {
      serverMode = "normal";
    }

    // 2. Fast continuation + hanging judge call times out at --trial-timeout 1 without retries.
    before = serverHits.length;
    serverMode = "hang-judge";
    try {
      const r = await runCli(e, ["refine", "test", cand, "--trial-timeout", "1", "--no-cache", "--json"]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.ok(r.elapsedMs < 15_000, `expected fast judge timeout, took ${r.elapsedMs}ms`);
      const judgeCalls = serverHits.slice(before).filter((h) => h.kind === "judge").length;
      // 1 case x 2 arms (same turn may share verdict only after a response; while hanging, at most 2 calls, zero retries).
      assert.ok(judgeCalls >= 1 && judgeCalls <= 2, `expected 1-2 judge calls with no retries, got ${judgeCalls}`);
    } finally {
      serverMode = "normal";
    }
  });

  it("refine distill accepts and forwards --trial-timeout to the distiller agent", async () => {
    const e = await setupEnv("distill-cli", { claims: 0, withDistillExp: true });
    // Invalid --trial-timeout fails fast.
    const bad = await runCli(e, ["refine", "distill", "--experiment", "exp_to", "--trial-timeout", "0", "--dry-run"]);
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /--trial-timeout/);

    // Install a hanging fake `claude` on PATH (works on both Windows via npm cmd-shim and POSIX via shebang).
    const script = join(e.bin, "claude-hang.cjs");
    writeFileSync(script, "setTimeout(() => {}, 30_000);\n");
    if (process.platform === "win32") {
      writeFileSync(join(e.bin, "claude.cmd"), `@ECHO off\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\claude-hang.cjs" %*\r\n`);
    } else {
      const shBin = join(e.bin, "claude");
      writeFileSync(shBin, `#!/usr/bin/env node\nsetTimeout(() => {}, 30_000);\n`);
      chmodSync(shBin, 0o755);
    }

    const r = await runCli(e, ["refine", "distill", "--experiment", "exp_to", "--trial-timeout", "1", "--yes", "--json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(r.elapsedMs < 15_000, `expected fast distill timeout, took ${r.elapsedMs}ms`);
    const doc = JSON.parse(r.stdout) as { draws: { error?: string }[] };
    assert.match(doc.draws[0]!.error ?? "", /it ran out of time after the 1 second limit/);
  });

  it("refine recheck accepts --trial-timeout and forwards it to the suite runner", async (t) => {
    if (!gitBin) return t.skip("needs git");
    const e = await setupEnv("recheck-cli", { claims: 0 });
    // Validate invalid --trial-timeout fails cleanly instead of unknown-flag error.
    const bad = await runCli(e, ["refine", "recheck", "r_0123456789", "--model", "small", "--trial-timeout", "0", "--dry-run"]);
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /--trial-timeout/);
    assert.doesNotMatch(bad.stderr, /Unknown option/);

    // Create a 1-task suite with a wrapper agent that sleeps under model "slow" and exits fast otherwise.
    writeFileSync(
      join(root, "recheck-agent.mjs"),
      `import { writeFileSync } from "node:fs";
const model = (process.argv.find((a) => a.startsWith("--model=")) ?? "").slice(8);
if (model === "slow") {
  setTimeout(() => {}, 30_000);
} else {
  writeFileSync("done.txt", "ok\\n");
  console.log(JSON.stringify({ type: "result", result: "Done." }));
}
`,
    );
    const h = join(root, "recheck-harness");
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(join(h, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(h, "harness.toml"), `name = "recheck-fake"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "recheck-agent.mjs"), "--model={model}"])}\ninclude = [".claude/**"]\n`);
    const snap = await runCli(e, ["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
    assert.equal(snap.status, 0, snap.stdout + snap.stderr);

    const suite = join(e.repo, "evals", "tiny");
    const taskDir = join(suite, "tasks", "t1");
    mkdirSync(join(taskDir, "tests"), { recursive: true });
    writeFileSync(join(suite, "suite.json"), JSON.stringify({ name: "tiny", purpose: "regression", trials: 1, tasks: "tasks", harness: "recheck-fake" }));
    writeFileSync(join(taskDir, "task.json"), JSON.stringify({ name: "t1", verifier: { command: `"${process.execPath}" check.mjs`, timeoutMs: 10_000 } }));
    writeFileSync(join(taskDir, "instruction.md"), "Do t1.\n");
    writeFileSync(join(taskDir, "tests", "check.mjs"), `import { existsSync } from "node:fs";\nprocess.exit(existsSync("done.txt") ? 0 : 1);\n`);

    const candDir = join(root, "recheck-cand");
    mkdirSync(candDir, { recursive: true });
    const cand = join(candDir, "CLAUDE.md");
    writeFileSync(cand, `${BASE}${TEST_RULE}\n`);
    const first = await runCli(e, ["refine", "test", cand, "--suite", "tiny", "--yes", "--json"]);
    assert.ok(first.stdout.trim().length > 0, first.stdout + first.stderr);
    const roundId = (JSON.parse(first.stdout) as { rounds: { id: string }[] }).rounds[0]!.id;

    // Recheck under "slow" with --trial-timeout 1 times out both arms in ~1s instead of 30s.
    const rc = await runCli(e, ["refine", "recheck", roundId, "--model", "slow", "--trial-timeout", "1", "--yes", "--json"]);
    assert.ok(rc.elapsedMs < 15_000, `expected fast recheck timeout, took ${rc.elapsedMs}ms`);
    const doc = JSON.parse(rc.stdout) as { recheck: { canary: { model: string; experiment: string } } };
    assert.equal(doc.recheck.canary.model, "slow");
    assert.ok(doc.recheck.canary.experiment);
  });

  it("refine diagnose accepts and forwards --trial-timeout to its model calls", async () => {
    const e = await setupEnv("diagnose-cli", { claims: 1 });
    const before = serverHits.length;
    serverMode = "hang-diagnose";
    try {
      const r = await runCli(e, ["refine", "diagnose", "--session", "claim-diagnose-cli-0", "--provider", "anthropic", "--trial-timeout", "1", "--json"]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.ok(r.elapsedMs < 15_000, `expected fast diagnose timeout, took ${r.elapsedMs}ms`);
      assert.match(r.stderr, /timed out after 1000 ms \(trial timeout\)/);
      assert.equal(serverHits.slice(before).filter((h) => h.kind === "diagnose").length, 1, "diagnose did not retry past --trial-timeout");
    } finally {
      serverMode = "normal";
    }
  });
});
