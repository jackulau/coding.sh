// `coding.sh exp ab` end to end: synthetic captured sessions in a temp store,
// a git repo whose CLAUDE.md is edited, and a local stub that speaks the
// Anthropic Messages API for both the next turn and the judge. The stub runs
// the tests when the B marker is in its context and says "Done." otherwise; the
// judge passes a turn that runs `npm test` and fails one that does not.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultModel } from "../../src/cli/commands/exp-ab.ts";
import { DEFAULT_MODELS } from "../../src/core/pricing.ts";
import type { Case } from "../../src/datasets/types.ts";
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
    assert.match(nothing.stderr, /No uncommitted changes to CLAUDE\.md/);

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

  it("refuses to start over --max-cost", async () => {
    const e = await setup("cap");
    writeFileSync(join(e.repo, "CLAUDE.md"), `${MARKER}\n`);
    const before = hits.length;
    const r = await cli(e, ["exp", "ab", "--max-cost", "0.000001"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Estimated cost .* is over --max-cost/);
    assert.equal(hits.length, before);
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
