// Commands that print a line setting an environment variable print it for the user's shell:
// `export NAME=value` in sh, `$env:NAME = 'value'` in PowerShell or cmd, where an export line does
// not run. `collector` prints its exporter env; `compare --gateway` and `gateway enrich` name the
// key to set. Each line runs as printed, and the command printed next to one names the CLI as
// that shell runs it. (`exp replay` and `replay --fork`: test/proxy/replay.test.ts and
// test/experiments/fork.test.ts.)
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { NO_USER_SHELL, runEnvLines } from "./_env-lines.ts";
import { cleanup, runLive, runSync, tmpHome } from "./_run-cli.ts";

after(cleanup);

const win = process.platform === "win32";
// tmpHome's env sets no SHELL or MSYSTEM: PowerShell or cmd on Windows. SHELL marks sh.
const SH = { SHELL: "/bin/bash" };
const BIN = win ? "codingsh" : "coding.sh";

/** The `next` of the --json error on stderr. */
function nextOf(r: { status: number | null; stderr: string }): string[] {
  assert.equal(r.status, 1, r.stderr);
  const line = r.stderr.split(/\r?\n/).find((l) => l.startsWith('{"status":"error"'));
  assert.ok(line, r.stderr);
  return (JSON.parse(line) as { next: string[] }).next;
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
    const vercel = (env: NodeJS.ProcessEnv) => nextOf(runSync(["compare", "a", "b", "--gateway", "vercel", "--yes", "--json"], env));
    const openrouter = (env: NodeJS.ProcessEnv) => nextOf(runSync(["compare", "a", "b", "--gateway", "openrouter", "--yes", "--json"], env));
    const h = tmpHome();
    assert.deepEqual(vercel({ ...h.env, ...SH }), ["Create one at vercel.com/ai-gateway, then:", "export AI_GATEWAY_API_KEY=..."]);
    assert.deepEqual(openrouter({ ...h.env, ...SH }), ["Next:", "export OPENROUTER_API_KEY=..."]);

    const v = vercel(h.env);
    const o = openrouter(h.env);
    assert.deepEqual(v, ["Create one at vercel.com/ai-gateway, then:", win ? "$env:AI_GATEWAY_API_KEY = '...'" : "export AI_GATEWAY_API_KEY=..."]);
    assert.deepEqual(o, ["Next:", win ? "$env:OPENROUTER_API_KEY = '...'" : "export OPENROUTER_API_KEY=..."]);
    if (!NO_USER_SHELL) assert.deepEqual(runEnvLines([v[1]!, o[1]!], ["AI_GATEWAY_API_KEY", "OPENROUTER_API_KEY"]), { AI_GATEWAY_API_KEY: "...", OPENROUTER_API_KEY: "..." });
  });
});

describe("coding.sh gateway enrich", () => {
  it("--gateway cliproxyapi with no key names the key and the rerun for the user's shell", () => {
    const run = (env: NodeJS.ProcessEnv) => nextOf(runSync(["gateway", "enrich", "--gateway", "cliproxyapi", "--json"], env));
    const h = tmpHome();
    assert.deepEqual(run({ ...h.env, ...SH }), ["export CLIPROXYAPI_MANAGEMENT_KEY=...", "coding.sh gateway enrich --gateway cliproxyapi"]);
    const plain = run(h.env);
    assert.deepEqual(plain, [win ? "$env:CLIPROXYAPI_MANAGEMENT_KEY = '...'" : "export CLIPROXYAPI_MANAGEMENT_KEY=...", `${BIN} gateway enrich --gateway cliproxyapi`]);
    if (!NO_USER_SHELL) assert.deepEqual(runEnvLines([plain[0]!], ["CLIPROXYAPI_MANAGEMENT_KEY"]), { CLIPROXYAPI_MANAGEMENT_KEY: "..." });
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
