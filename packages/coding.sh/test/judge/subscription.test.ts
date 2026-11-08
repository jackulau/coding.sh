// The subscription CLI plumbing (src/judge/subscription.ts): usage and rate
// limits, login detection from files only, the throwaway config dirs, and one
// call through a fake `codex exec`. Every env has a temp HOME, so nothing here
// reads the real ~/.claude or ~/.codex.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { autoCliProvider, CLAUDE_CODE_TOOLS, claudeArgs, cliComplete, cliHome, CliLimiter, cliLogin, codexProvider, limitKind, ProviderError } from "../../src/judge/index.ts";
import { nodeBin, pathOf } from "../_bin.ts";

// A file: URL, not a path: an import of a Windows path (D:\…) reads "d:" as a URL scheme.
const SUBSCRIPTION = new URL("../../src/judge/subscription.ts", import.meta.url).href;

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-sub-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh temp dir under the test root. */
const fresh = (name: string): string => {
  const d = join(root, `${name}-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

describe("limitKind", () => {
  it("tells a spent plan from a rate limit", () => {
    for (const m of ["Claude AI usage limit reached|1790000000", "You've hit your usage limit. resets 5pm (Europe/Paris)", "insufficient_quota: You exceeded your current quota", "You're out of extra usage"]) assert.equal(limitKind(m), "spent", m);
    for (const m of ["API Error: 429 Too Many Requests", "529 Overloaded", "rate_limit_error: slow down", "The server is overloaded"]) assert.equal(limitKind(m), "rate", m);
    for (const m of ["Not logged in", "Invalid model claude-x", ""]) assert.equal(limitKind(m), undefined, m);
  });
});

describe("CliLimiter", () => {
  it("never runs more than `max` calls at once", async () => {
    const l = new CliLimiter({ max: 2 });
    let active = 0;
    let most = 0;
    const once = async () => {
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return { ok: 1 };
    };
    const got = await Promise.all(Array.from({ length: 6 }, () => l.call("claude-code", once)));
    assert.deepEqual(got, [1, 1, 1, 1, 1, 1]);
    assert.equal(most, 2);
  });

  it("backs off on a rate limit and retries, doubling the wait, then gives up after `retries`", async () => {
    const notes: string[] = [];
    const l = new CliLimiter({ max: 1, baseDelayMs: 5, retries: 3 });
    l.onNote = (line) => notes.push(line);
    let calls = 0;
    const r = await l.call("claude-code", async () => (++calls <= 2 ? { error: "API Error: 429 rate_limit_error" } : { ok: "turn" }));
    assert.equal(r, "turn");
    assert.equal(calls, 3);
    assert.equal(l.backoffs, 2);
    assert.equal(notes.length, 2);
    assert.match(notes[0]!, /^claude-code: rate limited \(.*429.*\); waiting \d+ s before retrying \(1 of 3\)$/);
    assert.match(notes[1]!, /\(2 of 3\)$/);

    let tries = 0;
    await assert.rejects(
      l.call("claude-code", async () => (tries++, { error: "529 Overloaded" })),
      (e: unknown) => e instanceof ProviderError && /still rate limited after 3 retries: 529 Overloaded/.test(e.message),
    );
    assert.equal(tries, 4, "the first try and 3 retries");
  });

  it("a usage limit spends the plan: it says when it resets, aborts `stopped`, and later calls fail without running", async () => {
    const notes: string[] = [];
    const l = new CliLimiter({ max: 2, baseDelayMs: 5 });
    l.onNote = (line) => notes.push(line);
    assert.equal(l.stopped.aborted, false);
    await assert.rejects(
      l.call("claude-code", async () => ({ error: "You've hit your usage limit. resets 5pm (Europe/Paris)" })),
      (e: unknown) => e instanceof ProviderError && /Claude subscription hit its usage limit; resets 5pm \(Europe\/Paris\)\. Finished trials are kept/.test(e.message),
    );
    assert.ok(l.spent);
    assert.equal(l.stopped.aborted, true);
    assert.deepEqual(notes, [l.spent]);
    let ran = 0;
    await assert.rejects(l.call("claude-code", async () => (ran++, { ok: 1 })), /hit its usage limit/);
    assert.equal(ran, 0, "nothing runs once the plan is spent");
    assert.equal(l.backoffs, 0, "a spent plan is not retried");

    const codex = new CliLimiter();
    await assert.rejects(codex.call("codex", async () => ({ error: "insufficient_quota" })), /codex: your ChatGPT subscription hit its usage limit/);
  });
});

describe("cliLogin and autoCliProvider", () => {
  /** A temp HOME and a bin dir with fake `claude` and `codex` (each optional). */
  function world(o: { claude?: boolean; codex?: boolean } = {}): { home: string; env: NodeJS.ProcessEnv } {
    const home = fresh("home");
    const bin = join(home, "bin");
    mkdirSync(bin);
    if (o.claude) nodeBin(bin, "claude", "");
    if (o.codex) nodeBin(bin, "codex", "");
    return { home, env: { HOME: home, USERPROFILE: home, PATH: pathOf(bin) } };
  }

  it("reads the login from the env and the CLI's own files", () => {
    const none = world({ claude: true, codex: true });
    assert.deepEqual(cliLogin("claude-code", none.env), { installed: true, loggedIn: false });
    assert.deepEqual(cliLogin("codex", none.env), { installed: true, loggedIn: false });
    assert.deepEqual(cliLogin("claude-code", { ...none.env, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" }), { installed: true, loggedIn: true, how: "CLAUDE_CODE_OAUTH_TOKEN" });

    const creds = world({ claude: true });
    mkdirSync(join(creds.home, ".claude"));
    writeFileSync(join(creds.home, ".claude", ".credentials.json"), "{}");
    assert.deepEqual(cliLogin("claude-code", creds.env), { installed: true, loggedIn: true, how: "your Claude Code login" });

    const keychain = world({ claude: true });
    writeFileSync(join(keychain.home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "x" } }));
    assert.equal(cliLogin("claude-code", keychain.env).loggedIn, true, "a claude.ai account in .claude.json (the macOS keychain login)");
    const configDir = fresh("cfg");
    writeFileSync(join(configDir, ".claude.json"), '{ "oauthAccount": {} }');
    assert.equal(cliLogin("claude-code", { ...none.env, CLAUDE_CONFIG_DIR: configDir }).loggedIn, true, "CLAUDE_CONFIG_DIR holds .claude.json");

    const codex = world({ codex: true });
    mkdirSync(join(codex.home, ".codex"));
    writeFileSync(join(codex.home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "x" } }));
    assert.deepEqual(cliLogin("codex", codex.env), { installed: true, loggedIn: true, how: "your Codex login" });
    writeFileSync(join(codex.home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: null }));
    assert.equal(cliLogin("codex", codex.env).loggedIn, false, "a logged-out auth.json");

    const missing = world();
    assert.equal(cliLogin("claude-code", { ...missing.env, CLAUDE_CODE_OAUTH_TOKEN: "t" }).installed, false);
  });

  it("auto-picks a logged-in CLI only with no API key: Claude Code first, Codex when the sessions are Codex's", () => {
    const w = world({ claude: true, codex: true });
    mkdirSync(join(w.home, ".codex"));
    writeFileSync(join(w.home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: "x" } }));
    const both = { ...w.env, CLAUDE_CODE_OAUTH_TOKEN: "t" };
    assert.deepEqual(autoCliProvider(both), { provider: "claude-code", how: "CLAUDE_CODE_OAUTH_TOKEN" });
    assert.deepEqual(autoCliProvider(both, "codex"), { provider: "codex", how: "your Codex login" });
    assert.equal(autoCliProvider({ ...both, ANTHROPIC_API_KEY: "sk" }), undefined);
    assert.equal(autoCliProvider({ ...both, OPENAI_API_KEY: "sk" }), undefined);
    assert.deepEqual(autoCliProvider({ ...both, ANTHROPIC_API_KEY: "  " }), { provider: "claude-code", how: "CLAUDE_CODE_OAUTH_TOKEN" }, "a blank key is no key");
    assert.deepEqual(autoCliProvider(w.env), { provider: "codex", how: "your Codex login" }, "Claude Code is installed but not logged in");

    const notInstalled = world({ codex: true });
    assert.equal(autoCliProvider({ ...notInstalled.env, CLAUDE_CODE_OAUTH_TOKEN: "t" }), undefined, "a login without the CLI is not enough");
  });
});

describe("cliHome", () => {
  it("claude-code: a throwaway CLAUDE_CONFIG_DIR with only the login copied in, and no nested-session markers", () => {
    const home = fresh("home");
    const real = join(home, "real-claude");
    mkdirSync(join(real, "hooks"), { recursive: true });
    writeFileSync(join(real, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"a"}}');
    writeFileSync(join(real, "settings.json"), '{"hooks":{"Stop":[]}}');
    writeFileSync(join(real, "CLAUDE.md"), "user instructions");
    const h = cliHome("claude-code", { HOME: home, CLAUDE_CONFIG_DIR: real, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", KEEP: "yes" });
    assert.equal(h.isolated, true);
    const dir = h.env.CLAUDE_CONFIG_DIR!;
    assert.notEqual(dir, real);
    assert.ok(dir.startsWith(h.dir));
    assert.deepEqual(readdirSync(dir), [".credentials.json"], "no settings, CLAUDE.md or hooks from the real config dir");
    assert.equal(readFileSync(join(dir, ".credentials.json"), "utf8"), '{"claudeAiOauth":{"accessToken":"a"}}');
    assert.equal(h.env.CLAUDECODE, undefined);
    assert.equal(h.env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(h.env.KEEP, "yes");
    assert.equal(cliHome("claude-code", { HOME: home, CLAUDE_CONFIG_DIR: real, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", KEEP: "yes" }), h, "one per CLI and login, per process");

    const token = cliHome("claude-code", { HOME: fresh("home"), CLAUDE_CODE_OAUTH_TOKEN: "t" });
    assert.equal(token.isolated, true, "a token in the env needs no file");
    assert.deepEqual(readdirSync(token.env.CLAUDE_CONFIG_DIR!), []);

    const keychain = cliHome("claude-code", { HOME: fresh("home") });
    assert.equal(keychain.isolated, false, "no login file to copy (the macOS keychain): the flags alone isolate");
    assert.equal(keychain.env.CLAUDE_CONFIG_DIR, undefined);
  });

  it("codex: a throwaway CODEX_HOME with auth.json and nothing else", () => {
    const home = fresh("home");
    const real = join(home, ".codex");
    mkdirSync(join(real, "rules"), { recursive: true });
    writeFileSync(join(real, "auth.json"), '{"tokens":{"id_token":"x"}}');
    writeFileSync(join(real, "config.toml"), 'model = "gpt-x"\n[mcp_servers.a]\ncommand = "a"\n');
    writeFileSync(join(real, "AGENTS.md"), "user instructions");
    const h = cliHome("codex", { HOME: home });
    assert.equal(h.isolated, true);
    assert.notEqual(h.env.CODEX_HOME, real);
    assert.deepEqual(readdirSync(h.env.CODEX_HOME!), ["auth.json"]);
  });

  it("writes a login the CLI refreshed back to the real file at exit, unless the real file changed meanwhile", () => {
    const script = join(fresh("script"), "refresh.ts");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliHome } from ${JSON.stringify(SUBSCRIPTION)};
const [real, touch] = process.argv.slice(2);
const h = cliHome("claude-code", { HOME: join(real, ".."), CLAUDE_CONFIG_DIR: real });
writeFileSync(join(h.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "refreshed");
if (touch === "1") writeFileSync(join(real, ".credentials.json"), "logged in again");
process.stdout.write(h.dir);
`,
    );
    for (const [touch, want] of [
      ["0", "refreshed"],
      ["1", "logged in again"],
    ] as const) {
      const real = join(fresh("home"), "claude");
      mkdirSync(real);
      writeFileSync(join(real, ".credentials.json"), "original");
      const r = spawnSync(process.execPath, ["--no-warnings", script, real, touch], { encoding: "utf8", env: { PATH: process.env.PATH } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(real, ".credentials.json"), "utf8"), want);
      assert.equal(existsSync(r.stdout), false, "the throwaway dir is removed at exit");
    }
  });
});

// A fake `codex` that logs its argv, stdin, cwd, CODEX_HOME and the instructions file,
// then answers like `codex exec --json -o <file>`.
const FAKE_CODEX = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const after = (f) => argv[argv.indexOf(f) + 1];
  const configs = argv.flatMap((a, i) => (argv[i - 1] === "-c" ? [a] : []));
  const instr = configs.find((c) => c.startsWith("model_instructions_file="));
  const file = instr ? JSON.parse(instr.slice("model_instructions_file=".length)) : undefined;
  const schema = argv.includes("--output-schema") ? fs.readFileSync(after("--output-schema"), "utf8") : undefined;
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, input, cwd: process.cwd(), codexHome: process.env.CODEX_HOME, instructions: file && fs.readFileSync(file, "utf8"), schema }));
  const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
  say({ type: "thread.started", thread_id: "t1" });
  say({ type: "turn.started" });
  const mode = process.env.FAKE_MODE;
  if (mode === "error") {
    say({ type: "error", message: "unexpected status 401 Unauthorized" });
    say({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } });
    process.exitCode = 1;
    return;
  }
  if (mode === "limit") {
    say({ type: "error", message: "You've hit your usage limit. Try again in 2 hours." });
    process.exitCode = 1;
    return;
  }
  const verdict = JSON.stringify({ score: 0.9, pass: true, reason: "checks first", citations: [] });
  say({ type: "item.completed", item: { id: "i0", type: "command_execution", command: "ls", exit_code: 0 } });
  say({ type: "item.completed", item: { id: "i1", type: "agent_message", text: verdict } });
  say({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 30 } });
  fs.writeFileSync(after("-o"), verdict);
});
`;

describe("codex exec", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const log = () => JSON.parse(readFileSync(join(dir, "log.json"), "utf8")) as { argv: string[]; input: string; cwd: string; codexHome: string; instructions?: string; schema?: string };

  before(() => {
    dir = fresh("codex");
    nodeBin(join(dir, "bin"), "codex", FAKE_CODEX);
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex", "auth.json"), '{"tokens":{"id_token":"x"}}');
    writeFileSync(join(dir, ".codex", "config.toml"), 'model = "gpt-x"\n');
    env = { HOME: dir, USERPROFILE: dir, PATH: pathOf(join(dir, "bin"), process.env.PATH), FAKE_LOG: join(dir, "log.json") };
  });

  it("runs read-only and ephemeral with no user config, rules or project docs, our system prompt as its instructions", async () => {
    const schema = { type: "object", properties: { score: { type: "number" } }, required: ["score"], additionalProperties: false };
    const r = await cliComplete("codex", { system: "You are a strict reviewer.", user: "Grade this turn.", model: "gpt-6-sol", effort: "low", jsonSchema: schema }, { env, limiter: new CliLimiter() });
    const { argv, input, cwd, codexHome, instructions, schema: sent } = log();
    assert.deepEqual(argv.slice(0, 6), ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]);
    assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
    assert.equal(basename(argv[argv.indexOf("-C") + 1]!), basename(cwd), "-C is the call's own working dir");
    assert.equal(argv[argv.indexOf("-m") + 1], "gpt-6-sol");
    assert.ok(argv.includes("project_doc_max_bytes=0"));
    assert.ok(argv.includes('model_reasoning_effort="low"'));
    assert.equal(argv.at(-1), "-", "the prompt goes over stdin");
    assert.equal(instructions, "You are a strict reviewer.");
    assert.deepEqual(JSON.parse(sent!), schema);
    assert.equal(input, "Grade this turn.");
    assert.notEqual(codexHome, join(dir, ".codex"));
    assert.equal(existsSync(cwd), false, "the empty working dir is removed afterwards");
    assert.equal(existsSync(codexHome), true);
    assert.deepEqual(readdirSync(codexHome), ["auth.json"]);
    assert.equal(JSON.parse(r.text).score, 0.9);
    assert.deepEqual(r.usage, { inputTokens: 200, cacheReadTokens: 1000, outputTokens: 30 });
    assert.equal(r.commands, 1);
    assert.equal(r.model, "gpt-6-sol");
  });

  it("a judge provider: the verdict from -o, usage with cached input counted in", async () => {
    const p = codexProvider({ env, model: "gpt-6-sol", limiter: new CliLimiter() });
    assert.equal(p.name, "codex");
    const r = await p.complete({ system: "s", user: "u" });
    assert.equal(JSON.parse(r.text).pass, true);
    assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 30 });
    assert.ok(!log().argv.includes("--output-schema"), "no schema asked, none sent");
  });

  it("an error event fails the call; a usage limit spends the limiter", async () => {
    await assert.rejects(cliComplete("codex", { system: "s", user: "u" }, { env: { ...env, FAKE_MODE: "error" }, limiter: new CliLimiter() }), (e: unknown) => e instanceof ProviderError && /codex: `codex exec` failed: unexpected status 401/.test(e.message));
    const l = new CliLimiter();
    await assert.rejects(cliComplete("codex", { system: "s", user: "u" }, { env: { ...env, FAKE_MODE: "limit" }, limiter: l }), /ChatGPT subscription hit its usage limit; Try again in 2 hours/);
    assert.equal(l.stopped.aborted, true);
  });
});

describe("claude -p with the session's tools", () => {
  it("offers the built-ins natively, refuses every call with a PreToolUse hook, and stops after one turn", () => {
    const args = claudeArgs({ system: "s", tools: ["Bash", "Read"], jsonSchema: { type: "object" } }, "claude-haiku-4-5");
    const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
    assert.equal(flag("--output-format"), "stream-json");
    assert.ok(args.includes("--verbose"), "stream-json needs --verbose with -p");
    assert.equal(flag("--tools"), "Bash,Read");
    assert.equal(flag("--max-turns"), "1");
    assert.equal(flag("--setting-sources"), "", "still no user or project settings");
    for (const f of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) assert.ok(args.includes(f), f);
    assert.ok(!args.includes("--json-schema"), "the turn comes back as tool calls, not as a schema");
    const settings = JSON.parse(flag("--settings")) as { hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] } };
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: "*", hooks: [{ type: "command", command: "exit 2" }] }]);

    const plain = claudeArgs({ system: "s", jsonSchema: { type: "object" } }, "m");
    assert.equal(plain[plain.indexOf("--tools") + 1], "");
    assert.equal(plain[plain.indexOf("--output-format") + 1], "json");
    assert.ok(plain.includes("--json-schema") && !plain.includes("--settings") && !plain.includes("--max-turns"));
    assert.ok(CLAUDE_CODE_TOOLS.has("Bash") && !CLAUDE_CODE_TOOLS.has("mcp__github__create_issue"));
  });

  // A fake `claude -p --output-format stream-json`: one turn, its refused tool results, then a
  // second turn that must not count, and the result line.
  const FAKE_STREAM = `
const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  const mode = process.env.FAKE_MODE;
  say({ type: "system", subtype: "init", tools: ["Bash"], model: "claude-haiku-4-5" });
  if (mode === "error") {
    say({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["stream closed"], usage: {} });
    process.exitCode = 1;
    return;
  }
  if (mode === "limit") {
    say({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "Claude AI usage limit reached|1790000000" }] } });
    say({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1790000000", usage: {} });
    process.exitCode = 1;
    return;
  }
  if (mode === "text") {
    say({ type: "assistant", message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "All done." }] } });
    say({ type: "result", subtype: "success", is_error: false, result: "All done.", usage: { input_tokens: 50, output_tokens: 5 }, total_cost_usd: 0.0001 });
    return;
  }
  say({ type: "assistant", message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "Running the tests first." }] } });
  say({ type: "assistant", message: { model: "claude-haiku-4-5", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "PreToolUse:Bash hook error: blocked" }] } });
  say({ type: "assistant", message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "The hook blocked it." }, { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "x" } }] } });
  say({ type: "result", subtype: "error_max_turns", is_error: true, usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 100 }, total_cost_usd: 0.002 });
  process.exitCode = 1;
});
`;
  let env: NodeJS.ProcessEnv;
  before(() => {
    const dir = fresh("stream");
    nodeBin(join(dir, "bin"), "claude", FAKE_STREAM);
    env = { HOME: dir, USERPROFILE: dir, PATH: pathOf(join(dir, "bin"), process.env.PATH), CLAUDE_CODE_OAUTH_TOKEN: "fake" };
  });
  const call = (mode: string, limiter = new CliLimiter()) => cliComplete("claude-code", { system: "s", user: "u", model: "claude-haiku-4-5", tools: ["Bash", "Read"] }, { env: { ...env, FAKE_MODE: mode }, limiter });

  it("reads the first turn's text and tool calls; the turn after the refused calls does not count", async () => {
    const r = await call("tools");
    assert.equal(r.text, "Running the tests first.");
    assert.deepEqual(r.toolCalls, [{ name: "Bash", input: { command: "npm test" } }]);
    assert.equal(r.stopReason, "tool_use");
    assert.deepEqual(r.usage, { inputTokens: 900, outputTokens: 40, cacheReadTokens: 100 });
    assert.equal(r.costUsd, 0.002);
    assert.equal(r.model, "claude-haiku-4-5");

    const text = await call("text");
    assert.equal(text.text, "All done.");
    assert.deepEqual(text.toolCalls, []);
    assert.equal(text.stopReason, "end_turn");
  });

  it("an error result fails the call; a usage-limit result spends the limiter", async () => {
    await assert.rejects(call("error"), (e: unknown) => e instanceof ProviderError && /claude-code: `claude -p` failed: stream closed/.test(e.message));
    const l = new CliLimiter();
    await assert.rejects(call("limit", l), /Claude subscription hit its usage limit; resets /);
    assert.equal(l.stopped.aborted, true);
  });
});
