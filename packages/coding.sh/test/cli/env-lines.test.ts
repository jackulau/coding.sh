// Commands that print a line setting an environment variable print it for the user's shell:
// `export NAME=value` in sh, `$env:NAME = 'value'` in PowerShell or cmd, where an export line does
// not run. `collector` prints its exporter env; `compare --gateway`, `gateway enrich` and
// `gateway status --credits` name the key to set. Each line runs as printed, and the command
// printed next to one names the CLI as that shell runs it. A message names a variable as that
// shell reads it: `$NAME` in sh, `$env:NAME` in PowerShell or cmd. (`exp replay` and
// `replay --fork`: test/proxy/replay.test.ts and test/experiments/fork.test.ts.)
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { NO_USER_SHELL, runEnvLines } from "./_env-lines.ts";
import { cleanup, runLive, runSync, tmpHome } from "./_run-cli.ts";

after(cleanup);

const win = process.platform === "win32";
// tmpHome's env sets no SHELL or MSYSTEM: PowerShell or cmd on Windows. SHELL marks sh, and
// MSYSTEM Git Bash on Windows.
const SH = { SHELL: "/bin/bash" };
const GIT_BASH = { MSYSTEM: "MINGW64" };
const BIN = win ? "codingsh" : "coding.sh";
/** The line that sets NAME in the shell an env with no SHELL or MSYSTEM is for. */
const setLine = (name: string) => (win ? `$env:${name} = '...'` : `export ${name}=...`);
/** NAME as that shell reads it. */
const ref = (name: string) => (win ? `$env:${name}` : `$${name}`);

/** The --json error on stderr. */
function errOf(r: { status: number | null; stderr: string }): { status: string; reason: string; message: string; next: string[] } {
  assert.equal(r.status, 1, r.stderr);
  const line = r.stderr.split(/\r?\n/).find((l) => l.startsWith('{"status":"error"'));
  assert.ok(line, r.stderr);
  return JSON.parse(line) as { status: string; reason: string; message: string; next: string[] };
}

describe("coding.sh collector", () => {
  const lines = async (env: NodeJS.ProcessEnv) => {
    const p = runLive(["collector", "--port", "0"], env);
    try {
      await p.waitFor(/Press Ctrl-C/);
      return p.out.join("").trim().split(/\r?\n/);
    } finally {
      p.child.kill("SIGINT");
    }
  };
  const NAMES = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_TRACES_EXPORTER", "OTEL_LOGS_EXPORTER", "CLAUDE_CODE_ENABLE_TELEMETRY"];
  const values = (url: string) => [url, "http/protobuf", "otlp", "otlp", "1"];

  it("prints export lines in sh, and in PowerShell or cmd $env: lines that run as printed", async () => {
    const sh = await lines({ ...tmpHome().env, ...SH });
    const shUrl = /http:\/\/127\.0\.0\.1:\d+/.exec(sh[0] ?? "")?.[0] ?? assert.fail(sh.join("\n"));
    assert.deepEqual(sh, NAMES.map((n, i) => `export ${n}=${values(shUrl)[i]}`));

    const plain = await lines(tmpHome().env);
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(plain[0] ?? "")?.[0] ?? assert.fail(plain.join("\n"));
    assert.deepEqual(plain, NAMES.map((n, i) => (win ? `$env:${n} = '${values(url)[i]}'` : `export ${n}=${values(url)[i]}`)));
    if (!NO_USER_SHELL) assert.deepEqual(runEnvLines(plain, NAMES), Object.fromEntries(NAMES.map((n, i) => [n, values(url)[i]])));
  });
});

describe("coding.sh compare --gateway, with no key", () => {
  it("names the key as the user's shell sets it, in a line that runs as printed", () => {
    const vercel = (env: NodeJS.ProcessEnv) => errOf(runSync(["compare", "a", "b", "--gateway", "vercel", "--yes", "--json"], env));
    const openrouter = (env: NodeJS.ProcessEnv) => errOf(runSync(["compare", "a", "b", "--gateway", "openrouter", "--yes", "--json"], env));
    const h = tmpHome();
    for (const sh of [SH, GIT_BASH]) {
      assert.deepEqual(vercel({ ...h.env, ...sh }), { status: "error", reason: "missing_key", message: "--gateway needs an AI Gateway key in $AI_GATEWAY_API_KEY", next: ["Create one at vercel.com/ai-gateway, then:", "export AI_GATEWAY_API_KEY=..."] });
      assert.deepEqual(openrouter({ ...h.env, ...sh }), { status: "error", reason: "missing_key", message: "--gateway openrouter needs a key in $OPENROUTER_API_KEY (OpenRouter)", next: ["Next:", "export OPENROUTER_API_KEY=..."] });
    }

    const v = vercel(h.env);
    const o = openrouter(h.env);
    assert.deepEqual(v, { status: "error", reason: "missing_key", message: `--gateway needs an AI Gateway key in ${ref("AI_GATEWAY_API_KEY")}`, next: ["Create one at vercel.com/ai-gateway, then:", setLine("AI_GATEWAY_API_KEY")] });
    assert.deepEqual(o, { status: "error", reason: "missing_key", message: `--gateway openrouter needs a key in ${ref("OPENROUTER_API_KEY")} (OpenRouter)`, next: ["Next:", setLine("OPENROUTER_API_KEY")] });
    if (!NO_USER_SHELL) assert.deepEqual(runEnvLines([v.next[1]!, o.next[1]!], ["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"]), { AI_GATEWAY_API_KEY: "...", OPENROUTER_API_KEY: "..." });
  });
});

describe("coding.sh gateway status", () => {
  it("--credits with no key names each key it reads, and the lines that set them", () => {
    const run = (env: NodeJS.ProcessEnv, ...args: string[]) => errOf(runSync(["gateway", "status", "--credits", ...args, "--json"], env));
    const h = tmpHome();
    // Vercel's and OpenRouter's credits APIs: either key will do. Named, one gateway's.
    for (const sh of [SH, GIT_BASH]) {
      assert.deepEqual(run({ ...h.env, ...sh }), { status: "error", reason: "missing_key", message: "--credits needs a key in $AI_GATEWAY_API_KEY or $OPENROUTER_API_KEY", next: ["export AI_GATEWAY_API_KEY=...", "export OPENROUTER_API_KEY=..."] });
      assert.deepEqual(run({ ...h.env, ...sh }, "--gateway", "openrouter"), { status: "error", reason: "missing_key", message: "--credits needs a key in $OPENROUTER_API_KEY", next: ["Next:", "export OPENROUTER_API_KEY=..."] });
    }
    const plain = run(h.env);
    assert.deepEqual(plain, { status: "error", reason: "missing_key", message: `--credits needs a key in ${ref("AI_GATEWAY_API_KEY")} or ${ref("OPENROUTER_API_KEY")}`, next: [setLine("AI_GATEWAY_API_KEY"), setLine("OPENROUTER_API_KEY")] });
    assert.deepEqual(run(h.env, "--gateway", "openrouter"), { status: "error", reason: "missing_key", message: `--credits needs a key in ${ref("OPENROUTER_API_KEY")}`, next: ["Next:", setLine("OPENROUTER_API_KEY")] });
    if (!NO_USER_SHELL) assert.deepEqual(runEnvLines(plain.next, ["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"]), { AI_GATEWAY_API_KEY: "...", OPENROUTER_API_KEY: "..." });
  });

  it("--credits with a gateway that has no credits API says so, and names the ones that have one", () => {
    const r = runSync(["gateway", "status", "--credits", "--gateway", "litellm", "--json"], tmpHome().env);
    assert.equal(r.status, 2, r.stderr);
    const line = r.stderr.split(/\r?\n/).find((l) => l.startsWith('{"status":"error"'));
    assert.ok(line, r.stderr);
    const doc = JSON.parse(line) as { reason: string; message: string };
    assert.deepEqual([doc.reason, doc.message], ["invalid_argument", "LiteLLM proxy has no credits API. --credits works with --gateway vercel or openrouter"]);
  });

  it("and doctor name the key a Codex provider reads as the user's shell reads it", () => {
    const h = tmpHome();
    const codexHome = join(h.root, "codex");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), ['model_provider = "gw"', "", "[model_providers.gw]", 'name = "OpenRouter"', 'base_url = "https://openrouter.ai/api/v1"', 'env_key = "OPENROUTER_API_KEY"', ""].join("\n"));
    type Found = { agent: string; detail: string }[] | undefined;
    const codexDetail = (found: Found, output: string) => found?.find((f) => f.agent === "codex")?.detail ?? assert.fail(output);
    const status = (env: NodeJS.ProcessEnv) => {
      const r = runSync(["gateway", "status", "--json"], { ...env, CODEX_HOME: codexHome });
      assert.equal(r.status, 0, r.stderr);
      return codexDetail((JSON.parse(r.stdout) as { configured?: Found }).configured, r.stdout);
    };
    // doctor's exit code is about its other checks; its --json document lists the routes under gateway.configured.
    const doctor = (env: NodeJS.ProcessEnv) => {
      const r = runSync(["doctor", "--json"], { ...env, CODEX_HOME: codexHome }, 60_000);
      return codexDetail((JSON.parse(r.stdout) as { gateway?: { configured?: Found } }).gateway?.configured, r.stdout + r.stderr);
    };
    const sh = "model_providers.gw.base_url → openrouter.ai/api/v1, key from $OPENROUTER_API_KEY";
    for (const read of [status, doctor]) {
      assert.equal(read({ ...h.env, ...SH }), sh);
      assert.equal(read({ ...h.env, ...GIT_BASH }), sh);
      assert.equal(read(h.env), `model_providers.gw.base_url → openrouter.ai/api/v1, key from ${ref("OPENROUTER_API_KEY")}`);
    }
  });
});

describe("coding.sh gateway enrich", () => {
  it("--gateway cliproxyapi with no key names the key and the rerun for the user's shell", () => {
    const run = (env: NodeJS.ProcessEnv) => errOf(runSync(["gateway", "enrich", "--gateway", "cliproxyapi", "--json"], env));
    const h = tmpHome();
    for (const sh of [SH, GIT_BASH]) assert.deepEqual(run({ ...h.env, ...sh }), { status: "error", reason: "missing_key", message: "Reading CLIProxyAPI's usage queue needs its management key in $CLIPROXYAPI_MANAGEMENT_KEY", next: ["export CLIPROXYAPI_MANAGEMENT_KEY=...", "coding.sh gateway enrich --gateway cliproxyapi"] });
    const plain = run(h.env);
    assert.deepEqual(plain, { status: "error", reason: "missing_key", message: `Reading CLIProxyAPI's usage queue needs its management key in ${ref("CLIPROXYAPI_MANAGEMENT_KEY")}`, next: [setLine("CLIPROXYAPI_MANAGEMENT_KEY"), `${BIN} gateway enrich --gateway cliproxyapi`] });
    if (!NO_USER_SHELL) assert.deepEqual(runEnvLines([plain.next[0]!], ["CLIPROXYAPI_MANAGEMENT_KEY"]), { CLIPROXYAPI_MANAGEMENT_KEY: "..." });
  });

  it("a call that needs a lookup key names it as the user's shell sets it", async () => {
    const h = tmpHome();
    // One Codex call through Vercel's AI Gateway: looking it up needs $AI_GATEWAY_API_KEY.
    const now = Date.now();
    const events: AgentEvent[] = [
      { id: "cx-0", v: 0, sessionId: "codex-s1", ts: now - 61_000, agent: "codex", kind: "session.start", source: "transcript", payload: {} },
      { id: "cx-1", v: 0, sessionId: "codex-s1", ts: now - 60_000, agent: "codex", kind: "llm.call", source: "transcript", model: "openai/gpt-5", usage: { inputTokens: 10, outputTokens: 2 }, payload: { provider: "vercel", responseId: "gen_01JAZ3NDEKTSV4RRFFQ69G5FAV" } },
    ];
    const index = await SqliteIndexStore.open(join(h.env.CODING_SH_HOME!, "index.db"));
    try {
      await index.migrate();
      await index.putEvents(events);
      await index.upsertSession(buildSession(await index.listEvents("codex-s1")));
    } finally {
      await index.close();
    }
    const key = (env: NodeJS.ProcessEnv) => {
      const r = runSync(["gateway", "enrich", "--offline", "--dry-run"], env);
      assert.equal(r.status, 0, r.stderr);
      return /1 request via vercel need a lookup; (.*) and run again/.exec(r.stdout + r.stderr)?.[1] ?? assert.fail(r.stdout + r.stderr);
    };
    assert.equal(key({ ...h.env, ...SH }), "export AI_GATEWAY_API_KEY=...");
    const plain = key(h.env);
    assert.equal(plain, win ? "$env:AI_GATEWAY_API_KEY = '...'" : "export AI_GATEWAY_API_KEY=...");
    if (!NO_USER_SHELL) assert.deepEqual(runEnvLines([plain], ["AI_GATEWAY_API_KEY"]), { AI_GATEWAY_API_KEY: "..." });
  });
});
