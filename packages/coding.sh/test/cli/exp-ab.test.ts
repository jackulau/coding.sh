// `coding.sh exp ab` end to end: synthetic captured sessions in a temp store,
// a git repo whose CLAUDE.md is edited, and a local stub that speaks the
// Anthropic Messages API for both the next turn and the judge. The stub runs
// the tests when the B marker is in its context and says "Done." otherwise; the
// judge passes a turn that runs `npm test` and fails one that does not.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultModel } from "../../src/cli/commands/exp-ab.ts";
import { DEFAULT_MODELS } from "../../src/core/pricing.ts";
import type { Case } from "../../src/datasets/types.ts";
import { nodeBin, pathOf } from "../_bin.ts";
import { claimSession, putSession } from "../helpers-decision.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const MARKER = "ALWAYS-RUN-NPM-TEST";

interface Hit {
  judge: boolean;
  marker: string | undefined;
}

let server: Server;
let base = "";
const hits: Hit[] = [];
let root = "";

function reply(model: string, content: unknown[], stop: string) {
  return { id: "msg_stub", type: "message", role: "assistant", model, content, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 50 } };
}

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw) as { model: string; system?: string; messages: { content: unknown }[] };
      const judge = String(body.system ?? "").startsWith("You are a strict");
      const text = JSON.stringify(body.messages);
      const marker = /ALWAYS-RUN-NPM-TEST(?: v\d)?/.exec(text)?.[0];
      hits.push({ judge, marker });
      let out;
      if (judge) {
        const output = /<output>([\s\S]*?)<\/output>/.exec(String((body.messages[0] as { content: string }).content))?.[1] ?? "";
        const pass = output.includes("npm test");
        out = reply(body.model, [{ type: "text", text: JSON.stringify({ score: pass ? 1 : 0.2, pass, confidence: 0.9, reason: pass ? "verifies first" : "claims done without checking", citations: [] }) }], "end_turn");
      } else if (marker) {
        out = reply(body.model, [{ type: "tool_use", id: `toolu_${hits.length}`, name: "Bash", input: { command: "npm test" } }], "tool_use");
      } else {
        out = reply(body.model, [{ type: "text", text: "Done." }], "end_turn");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-expab-")));
});
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

interface Env {
  home: string;
  repo: string;
  env: NodeJS.ProcessEnv;
}

async function setup(name: string, sessions = 3): Promise<Env> {
  const home = join(root, name, "home");
  const repo = join(root, name, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(root, name, "tmp"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: join(root, name, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    // The store is seeded directly, so each read would start a detached re-parse
    // that outlives the CLI and still has the temp home open when after() removes it.
    CODING_SH_NO_AUTO_INGEST: "1",
    CODING_SH_RETRY_BASE_MS: "0",
    ANTHROPIC_API_KEY: "sk-stub",
    ANTHROPIC_BASE_URL: base,
  };
  const git = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  writeFileSync(join(repo, "CLAUDE.md"), "Keep answers short.\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    const now = Date.now();
    for (let i = 0; i < sessions; i++) await putSession(ctx.index, claimSession(`sess-${name}-${i}`, { cwd: repo, startedAt: now - (i + 1) * 3600_000 }, `src/mod${i}.js`));
  } finally {
    await ctx.close();
  }
  return { home, repo, env };
}

/** Run the CLI without blocking the event loop (the stub answers in this process). */
function cli(e: Env, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env: e.env, cwd: e.repo });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => done({ status, stdout, stderr }));
  });
}

const withoutIds = (cmp: Record<string, unknown>) => ({ ...cmp, a: { ...(cmp.a as object), id: "" }, b: { ...(cmp.b as object), id: "" }, timing: undefined });

describe("cli exp ab", () => {
  it("compares git HEAD with an uncommitted CLAUDE.md edit; a rerun makes no calls and gives the same verdict", async () => {
    const e = await setup("main");
    writeFileSync(join(e.repo, "CLAUDE.md"), `Keep answers short.\n${MARKER}: run npm test before you say you are done.\n`);

    const before = hits.length;
    const dry = await cli(e, ["exp", "ab", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(hits.length, before, "--dry-run makes no model calls");
    assert.match(dry.stdout, /3 decision points from 3 sessions/);
    assert.match(dry.stdout, /Would make 6 of 6 model calls/);

    const first = await cli(e, ["exp", "ab", "--json"]);
    assert.equal(first.status, 0, first.stderr);
    const a = JSON.parse(first.stdout) as { comparison: Record<string, unknown> & { mcnemar: { b: number; c: number }; gate: { verdict: string } }; fixed: string[]; broke: string[]; cacheHits: { model: number; of: number }; cost: { usd: number } };
    assert.equal(a.fixed.length, 3, "B fixes every case");
    assert.equal(a.broke.length, 0);
    assert.deepEqual([a.comparison.mcnemar.b, a.comparison.mcnemar.c], [0, 3]);
    assert.deepEqual(a.cacheHits, { model: 0, of: 6, judgeCalls: 6 });
    assert.ok(a.cost.usd > 0);
    const made = hits.slice(before);
    assert.equal(made.filter((h) => !h.judge).length, 6);
    assert.equal(made.filter((h) => !h.judge && h.marker).length, 3, "only arm B sees the marker");

    const mark = hits.length;
    const again = await cli(e, ["exp", "ab", "--json"]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(hits.length, mark, "an unchanged rerun is answered from the caches");
    const b = JSON.parse(again.stdout) as typeof a;
    assert.deepEqual(withoutIds(b.comparison), withoutIds(a.comparison));
    assert.deepEqual(b.cacheHits, { model: 6, of: 6, judgeCalls: 0 });

    const text = await cli(e, ["exp", "ab"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^A: git:HEAD {3}B: your edits {3}model: claude-sonnet-5-5$/m);
    assert.match(text.stdout, /3 decision points from 3 sessions \| A 0\/3 -> B 3\/3 \| fixed 3, broke 0 \| paired p=0\.25 \| \$0, 6\/6 cached/);
    assert.match(text.stdout, /^Hold: not enough evidence/m);
    assert.match(text.stdout, /Replay noise floor 0%/);
    assert.match(text.stdout, /Fixed \(A failed, B passed\):\n {2}unverified-claim .*coding\.sh show sess-main-0/);
    assert.match(text.stdout, /^Full comparison: coding\.sh exp compare exp_\w+ exp_\w+$/m);

    // --gate turns the (hold) verdict into the exit code.
    const gated = await cli(e, ["exp", "ab", "--gate"]);
    assert.equal(gated.status, 1, gated.stderr);
  });

  it("refuses bad arms and behaviors with a suggestion, and exits 2 with no decision points", async () => {
    const e = await setup("errors");
    const unknown = await cli(e, ["exp", "ab", "--behavior", "unverifed-claim", "--b", "CLAUDE.md"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown behavior "unverifed-claim"/);
    assert.match(unknown.stderr, /Did you mean --behavior unverified-claim\?/);

    const missing = await cli(e, ["exp", "ab", "--b", "CLAUDE.mdx"]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--b CLAUDE\.mdx: no such file, directory or harness bundle/);
    assert.match(missing.stderr, /Did you mean --b CLAUDE\.md\?/);

    const same = await cli(e, ["exp", "ab", "--b", "CLAUDE.md"]);
    assert.equal(same.status, 2);
    assert.match(same.stderr, /have the same harness files/);

    const nothing = await cli(e, ["exp", "ab"]);
    assert.equal(nothing.status, 2);
    assert.match(nothing.stderr, /No uncommitted changes to AGENTS\.md or other instructions files, rules or skills/);

    const empty = await setup("empty", 0);
    writeFileSync(join(empty.repo, "CLAUDE.md"), `${MARKER}\n`);
    const none = await cli(empty, ["exp", "ab", "--json"]);
    assert.equal(none.status, 2, none.stderr);
    assert.equal((JSON.parse(none.stderr.trim()) as { reason: string }).reason, "no_cases");
    const noneText = await cli(empty, ["exp", "ab"]);
    assert.match(noneText.stderr, /coding\.sh exp ab --since 30d --repo all/);
  });

  it("exp run wants a control arm for a continuation task; --no-control runs it alone and compare says so", async () => {
    const e = await setup("control", 0);
    const prefix = { v: 1, tools: [], messages: [{ role: "user", text: "Fix it." }] };
    assert.equal((await cli(e, ["dataset", "add", "nt", "--case", JSON.stringify({ id: "c1", input: prefix, expected: "runs tests" })])).status, 0);
    const task = JSON.stringify({ kind: "continuation", provider: "anthropic", model: "claude-sonnet-5-5" });
    const refused = await cli(e, ["exp", "run", "-d", "nt", "--task", task, "-g", '{"kind":"contains","value":"npm test"}']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /needs a control arm/);
    const alone = await cli(e, ["exp", "run", "-d", "nt", "--task", task, "-g", '{"kind":"contains","value":"npm test"}', "--no-control", "--json"]);
    assert.notEqual(alone.status, 2, alone.stderr);
    const exp = (JSON.parse(alone.stdout) as { experiment: { id: string; metadata?: { control?: string } } }).experiment;
    assert.equal(exp.metadata?.control, "skipped");
    const cmp = await cli(e, ["exp", "compare", exp.id, exp.id, "--json"]);
    assert.match((JSON.parse(cmp.stdout) as { comparison: { controlWarning?: string } }).comparison.controlWarning ?? "", /without a control arm/);
  });

  it("warns before any model call when B deletes a protected line, reports it, and --allow-protected-edit waives it", async () => {
    const e = await setup("protect");
    const git = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: e.repo, env: e.env }).status, 0, a.join(" "));
    writeFileSync(join(e.repo, "CLAUDE.md"), "Keep answers short.\nNever run `git push --force`.\n");
    git("commit", "-qam", "rule");
    writeFileSync(join(e.repo, "CLAUDE.md"), `Keep answers short.\n${MARKER}: run npm test before you say you are done.\n`);

    const before = hits.length;
    const dry = await cli(e, ["exp", "ab", "--dry-run", "--json"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(hits.length, before);
    const p = (JSON.parse(dry.stdout) as { protected: { ok: boolean; count: number; rejections: { critic: string; reason: string }[] } }).protected;
    assert.equal(p.ok, false);
    assert.equal(p.count, 1);
    assert.deepEqual(
      p.rejections.map((r) => r.reason),
      ['protected-line: CLAUDE.md:2 "Never run `git push --force`." (auto)'],
    );

    const text = await cli(e, ["exp", "ab", "--gate"]);
    assert.equal(text.status, 1, text.stderr);
    assert.match(text.stderr, /protected-line: CLAUDE\.md:2 .*\n.*can't see the harm of dropping a safety rule, so --gate will fail\. Allow it on purpose: --allow-protected-edit CLAUDE\.md:2/);
    assert.match(text.stdout, /^Protected: B deletes, rewords or relaxes 1 protected line; --gate fails \(coding\.sh refine check lists them\)$/m);

    const allowed = await cli(e, ["exp", "ab", "--json", "--allow-protected-edit", "CLAUDE.md:2"]);
    assert.equal(allowed.status, 0, allowed.stderr);
    const q = (JSON.parse(allowed.stdout) as { protected: { ok: boolean; overridden: unknown[] } }).protected;
    assert.equal(q.ok, true);
    assert.equal(q.overridden.length, 1);
  });

  it("refuses to start over --max-cost", async () => {
    const e = await setup("cap");
    writeFileSync(join(e.repo, "CLAUDE.md"), `${MARKER}\n`);
    const before = hits.length;
    const r = await cli(e, ["exp", "ab", "--max-cost", "0.000001"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Estimated cost .* is over --max-cost/);
    assert.equal(hits.length, before);
  });

  it("stops before any trial when the model API key is missing, and points at improve check", async () => {
    const e = await setup("nokey");
    const { ANTHROPIC_API_KEY: _k, ANTHROPIC_BASE_URL: _b, ...env } = e.env;
    writeFileSync(join(e.repo, "CLAUDE.md"), `${MARKER}\n`);
    const r = await cli({ ...e, env }, ["exp", "ab", "--json"]);
    assert.equal(r.status, 1, r.stdout);
    const err = JSON.parse(r.stderr) as { reason: string; message: string; next: string[] };
    assert.equal(err.reason, "missing_key");
    assert.match(err.message, /set ANTHROPIC_API_KEY \(6 of 6 model calls are not cached\)/);
    assert.match(err.message, /or log in to Claude Code \(.*\) or Codex \(run `codex login`\) and exp ab replays them on that subscription$/);
    assert.ok(err.next.includes("coding.sh improve check"));
    const runs = await cli({ ...e, env }, ["exp", "list", "--json"]);
    assert.doesNotMatch(runs.stdout, /exp ab/, "no experiment was recorded");
  });

  it("--watch reruns once per edit, calls the model only for arm B, and Ctrl-C exits 0", { skip: process.platform === "win32" && "no SIGINT to a child on Windows" }, async () => {
    const e = await setup("watch");
    writeFileSync(join(e.repo, "CLAUDE.md"), `Keep answers short.\n${MARKER}: run npm test first.\n`);
    const p = spawn(process.execPath, ["--no-warnings", CLI, "exp", "ab", "--watch"], { env: e.env, cwd: e.repo });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const until = async (re: RegExp, what: string) => {
      for (let i = 0; i < 300 && !re.test(stdout + stderr); i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(stdout + stderr, re, `${what}\n${stdout}\n${stderr}`);
    };
    await until(/Watching .* for changes to B/, "watch started");
    const mark = hits.length;
    writeFileSync(join(e.repo, "CLAUDE.md"), `Keep answers short.\n${MARKER} v2: run npm test first.\n`);
    await until(/^\d\d:\d\d:\d\d {2}A 0\/3 -> B 3\/3/m, "one history line");
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(stdout.match(/^\d\d:\d\d:\d\d {2}/gm)?.length, 1, "exactly one rerun");
    const made = hits.slice(mark).filter((h) => !h.judge);
    assert.equal(made.length, 3, "only arm B's 3 turns are new");
    assert.ok(made.every((h) => h.marker === `${MARKER} v2`));
    assert.equal(hits.slice(mark).filter((h) => h.judge).length, 0, "the same turn with a new tool-call id keeps its cached verdict");
    const code = await new Promise<number | null>((done) => {
      p.on("close", done);
      p.kill("SIGINT");
    });
    assert.equal(code, 0, stderr);
  });
});

// A fake `claude -p` for the subscription path: the next turn runs `npm test` when the
// B marker is in its context and says "Done." otherwise; the judge passes a turn that
// runs `npm test`. A turn with the session's tools (--tools not empty) answers like
// `--output-format stream-json`; the judge like `--output-format json` with
// structured output. It appends one line per call to FAKE_LOG.
const FAKE_CLAUDE = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
  const schema = argv.includes("--json-schema") ? JSON.parse(argv[argv.indexOf("--json-schema") + 1]) : {};
  const native = !!argv[argv.indexOf("--tools") + 1];
  const turn = native || !!(schema.properties && schema.properties.tool_calls);
  const marker = /ALWAYS-RUN-NPM-TEST/.test(input);
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ turn, native, marker, configDir: process.env.CLAUDE_CONFIG_DIR }) + "\\n");
  const mode = process.env.FAKE_MODE;
  if (turn && (mode === "fail" || (mode === "fail-a" && !marker))) {
    const error = "API Error: 400 invalid_request_error: prompt is too long";
    say(native ? { type: "result", subtype: "success", is_error: true, result: error, usage: {} } : { type: "result", is_error: true, result: error });
    process.exitCode = 1;
    return;
  }
  if (native) {
    const usage = { input_tokens: 1000, output_tokens: 50 };
    say({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
    if (marker) {
      say({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "npm test" } }] } });
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", is_error: true, content: "blocked" }] } });
      say({ type: "result", subtype: "error_max_turns", is_error: true, usage, total_cost_usd: 0.001 });
      process.exitCode = 1;
    } else {
      say({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "Done." }] } });
      say({ type: "result", subtype: "success", is_error: false, result: "Done.", usage, total_cost_usd: 0.001 });
    }
    return;
  }
  let out;
  if (turn) out = marker ? { text: "", tool_calls: [{ name: "Bash", input_json: JSON.stringify({ command: "npm test" }) }] } : { text: "Done.", tool_calls: [] };
  else {
    const output = (/<output>([\\s\\S]*?)<\\/output>/.exec(input) || [])[1] || "";
    const pass = output.includes("npm test");
    out = { score: pass ? 1 : 0.2, pass, confidence: 0.9, reason: pass ? "verifies first" : "claims done without checking", citations: [] };
  }
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, stop_reason: "end_turn", result: "", structured_output: out, usage: { input_tokens: 1000, output_tokens: 50 }, modelUsage: { "claude-sonnet-5-5": {} } }) + "\\n");
});
`;

/** The env with no API key, a fake `claude` on PATH, and (unless `login` is false) CLAUDE_CODE_OAUTH_TOKEN. */
function subscriptionEnv(e: Env, o: { login?: boolean; claude?: boolean } = {}): Env & { log: string } {
  const { ANTHROPIC_API_KEY: _k, ANTHROPIC_BASE_URL: _b, ...rest } = e.env;
  const bin = join(e.home, "bin");
  if (o.claude !== false) nodeBin(bin, "claude", FAKE_CLAUDE);
  else mkdirSync(bin, { recursive: true });
  const log = join(e.home, "claude.log");
  return { ...e, log, env: { ...rest, PATH: pathOf(bin, process.env.PATH), FAKE_LOG: log, ...(o.login !== false ? { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" } : {}) } };
}

describe("cli exp ab on a subscription", () => {
  it("with no API key and Claude Code logged in, replays and judges through claude -p, says so once, and marks costs API-equivalent", async () => {
    const e = subscriptionEnv(await setup("sub"));
    writeFileSync(join(e.repo, "CLAUDE.md"), `Keep answers short.\n${MARKER}: run npm test before you say you are done.\n`);
    const before = hits.length;

    const dry = await cli(e, ["exp", "ab", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    const out = dry.stdout + dry.stderr;
    assert.equal(out.match(/No API key set: replaying through `claude -p` on your Claude subscription \(CLAUDE_CODE_OAUTH_TOKEN\); costs are API-equivalent/g)?.length, 1, out);
    assert.match(dry.stdout, /, claude-sonnet-5-5 through claude-code$/m);
    assert.match(dry.stdout, /~\$[\d.]+ API-equivalent/);
    const json = JSON.parse((await cli(e, ["exp", "ab", "--dry-run", "--json"])).stdout) as { provider: string; estimate: { apiEquivalent?: boolean } };
    assert.equal(json.provider, "claude-code");
    assert.equal(json.estimate.apiEquivalent, true);

    const run = await cli(e, ["exp", "ab"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(hits.length, before, "nothing reached the API");
    assert.match(run.stdout, /^A: git:HEAD {3}B: your edits {3}model: claude-sonnet-5-5 \(claude-code\)$/m);
    assert.match(run.stdout, /A 0\/3 -> B 3\/3 \| fixed 3, broke 0 .*\| \$[\d.]+ API-equivalent, 0\/6 cached/);
    const calls = readFileSync(e.log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { turn: boolean; native: boolean; marker: boolean; configDir?: string });
    assert.equal(calls.filter((c) => c.turn).length, 6);
    assert.ok(calls.filter((c) => c.turn).every((c) => c.native), "Claude Code sessions' tools are given natively");
    assert.ok(calls.filter((c) => !c.turn).every((c) => !c.native), "the judge gets no tools");
    assert.equal(calls.filter((c) => c.turn && c.marker).length, 3, "only arm B's turns see the edit");
    assert.equal(calls.filter((c) => !c.turn).length, 6, "the judge runs through claude -p too");
    assert.ok(calls.every((c) => c.configDir && !c.configDir.startsWith(e.home)), "a throwaway config dir, not the user's");

    const again = JSON.parse((await cli(e, ["exp", "ab", "--json"])).stdout) as { provider: string; cost: { apiEquivalent?: boolean }; cacheHits: { model: number } };
    assert.equal(again.provider, "claude-code");
    assert.equal(again.cost.apiEquivalent, true);
    assert.equal(again.cacheHits.model, 6);
  });

  it("an API key keeps the API: no note, provider anthropic", async () => {
    const base = await setup("subkey");
    const e = subscriptionEnv(base);
    e.env.ANTHROPIC_API_KEY = "sk-stub";
    writeFileSync(join(e.repo, "CLAUDE.md"), `${MARKER}\n`);
    const r = await cli(e, ["exp", "ab", "--dry-run", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as { provider: string; estimate: { apiEquivalent?: boolean } }).provider, "anthropic");
    const text = await cli(e, ["exp", "ab", "--dry-run"]);
    assert.doesNotMatch(text.stdout + text.stderr, /No API key set|API-equivalent/);
  });

  it("--provider claude-code stops before any call when claude is missing or not logged in", async () => {
    const base = await setup("sublogin");
    writeFileSync(join(base.repo, "CLAUDE.md"), `${MARKER}\n`);
    const out = subscriptionEnv(base, { login: false });
    const r = await cli(out, ["exp", "ab", "--provider", "claude-code", "--json"]);
    assert.equal(r.status, 1, r.stdout);
    const err = JSON.parse(r.stderr) as { reason: string; message: string; next: string[] };
    assert.equal(err.reason, "not_logged_in");
    assert.match(err.next.join("\n"), /claude setup-token/);
    assert.equal(existsSync(out.log), false, "claude never ran");

    const none = subscriptionEnv(base, { claude: false });
    // PATH keeps git and drops every dir with a claude in it.
    none.env.PATH = pathOf(...(process.env.PATH ?? "").split(delimiter).filter((d) => d && !["claude", "claude.cmd", "claude.exe"].some((f) => existsSync(join(d, f)))));
    const m = await cli(none, ["exp", "ab", "--provider", "claude-code", "--json"]);
    assert.equal(m.status, 1, m.stdout);
    assert.equal((JSON.parse(m.stderr) as { reason: string }).reason, "missing_cli");
  });

  it("every model call failing is an error (model_error), not a Hold; some failing is a warning", async () => {
    const e = subscriptionEnv(await setup("subfail"));
    writeFileSync(join(e.repo, "CLAUDE.md"), `Keep answers short.\n${MARKER}: run npm test before you say you are done.\n`);
    const all = await cli({ ...e, env: { ...e.env, FAKE_MODE: "fail" } }, ["exp", "ab", "--json"]);
    assert.equal(all.status, 1, all.stdout);
    const err = JSON.parse(all.stderr) as { reason: string; message: string; next: string[] };
    assert.equal(err.reason, "model_error");
    assert.match(err.message, /^Every model call failed \(6 of 6 trials\): .*prompt is too long/);
    assert.match(err.next.join("\n"), /coding\.sh exp show exp_\w+/);

    const some = await cli({ ...e, env: { ...e.env, FAKE_MODE: "fail-a" } }, ["exp", "ab", "--no-cache"]);
    assert.equal(some.status, 0, some.stderr);
    assert.match(some.stderr, /3 of 6 trials failed and count as not passing: .*prompt is too long/);
    assert.match(some.stdout, /A 0\/3 -> B 3\/3/);
  });
});

describe("cli exp ab on a committed edit", () => {
  it("with no uncommitted edits, tests the last harness commit against the version before it", async () => {
    const e = await setup("committed");
    const git = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: e.repo, env: e.env }).status, 0, a.join(" "));
    writeFileSync(join(e.repo, "CLAUDE.md"), `Keep answers short.\n${MARKER}: run npm test before you say you are done.\n`);
    git("commit", "-qam", "CLAUDE.md: run the tests");
    writeFileSync(join(e.repo, "README.md"), "unrelated\n");
    git("add", "README.md");
    git("commit", "-qm", "readme");
    const short = spawnSync("git", ["log", "-1", "--format=%h", "HEAD~1"], { cwd: e.repo, encoding: "utf8" }).stdout.trim();

    const before = hits.length;
    const dry = await cli(e, ["exp", "ab", "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout + dry.stderr, new RegExp(`No uncommitted edits: testing your last harness commit ${short} "CLAUDE\\.md: run the tests" \\(B\\) against the version before it \\(A\\)`));
    assert.match(dry.stdout, new RegExp(`^A git:${short}\\^ \\(1 file\\) vs B git:HEAD \\(1 file\\)`, "m"));
    assert.equal(hits.length, before);
    const json = JSON.parse((await cli(e, ["exp", "ab", "--dry-run", "--json"])).stdout) as { arms: { a: string; b: string } };
    assert.deepEqual(json.arms, { a: `git:${short}^`, b: "git:HEAD" });

    const explicit = await cli(e, ["exp", "ab", "--a", "git:HEAD~2", "--b", "git:HEAD", "--dry-run", "--json"]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.deepEqual((JSON.parse(explicit.stdout) as { arms: { a: string; b: string } }).arms, { a: "git:HEAD~2", b: "git:HEAD" });

    const run = await cli(e, ["exp", "ab", "--json"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal((JSON.parse(run.stdout) as { fixed: string[] }).fixed.length, 3, "B is the committed edit");
  });
});

describe("exp ab default model", () => {
  const cases = (...models: (string | undefined)[]) => models.map((model, i) => ({ id: `c${i}`, input: {}, metadata: model ? { model } : {} })) as unknown as Case[];
  it("uses the model the decision points were recorded with, only when the provider serves it", () => {
    const mixed = cases("claude-opus-5-5", "gpt-6-sol", "anthropic/claude-opus-5-5", "gpt-6-sol", "gpt-6-sol");
    assert.equal(defaultModel("anthropic", mixed), "claude-opus-5-5", "Codex cases don't pick the Anthropic model");
    assert.equal(defaultModel("openai", mixed), "gpt-6-sol");
    assert.equal(defaultModel("openai-compatible", mixed), "gpt-6-sol");
  });
  it("falls back to the provider's current default (none for openai-compatible)", () => {
    assert.equal(defaultModel("anthropic", cases("gpt-6-sol", undefined)), DEFAULT_MODELS.anthropic);
    assert.equal(defaultModel("openai", cases()), DEFAULT_MODELS.openai);
    assert.equal(defaultModel("openai-compatible", cases(undefined)), undefined);
  });
});
