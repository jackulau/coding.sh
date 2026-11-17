// Regression tests for the hands-on QA round on the CLI: typo suggestions, help text, where
// `status` prints, exit codes, `export --json`, `config get`, and `search --agent`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { suggest } from "../../src/cli/args.ts";
import * as config from "../../src/cli/commands/config.ts";
import * as exportCmd from "../../src/cli/commands/export.ts";
import * as search from "../../src/cli/commands/search.ts";
import * as status from "../../src/cli/commands/status.ts";
import { COMMANDS } from "../../src/cli/registry.ts";
import { fixtureEvent } from "../../src/store/conformance.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

describe("typo suggestions", () => {
  test("an adjacent transposition is one edit", () => {
    assert.equal(suggest("lsit", ["init", "list", "run"]), "list");
    assert.equal(suggest("rnu", ["init", "list", "run"]), "run");
  });
  test("a far-off word still suggests nothing", () => assert.equal(suggest("zzzzzz", ["init", "list", "run"]), undefined));
});

describe("help text", () => {
  test("no command, flag or action description uses the word 'just'", () => {
    const texts: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") texts.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(COMMANDS);
    const bad = texts.filter((t) => /\bjust\b/i.test(t));
    assert.deepEqual(bad, []);
  });
});

describe("status", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([mkSession("s1", Date.now() - 1000)]);
  });
  after(() => sb.cleanup());
  test("the report is the answer: it goes to stdout", async () => {
    const r = await runCmd(status, sb);
    assert.match(r.stdout, /Store/);
    assert.match(r.stdout, /Home/);
    assert.doesNotMatch(r.stderr, /Store|Home/);
  });
});

describe("export --json", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([mkSession("s1", Date.now() - 1000)]);
  });
  after(() => sb.cleanup());
  test("is a usage error, not JSONL or nothing", async () => {
    const r = await runCmd(exportCmd, sb, { json: true, positionals: ["sessions"] });
    assert.equal(r.error?.exitCode ?? r.error?.code ?? 2, 2);
    assert.match(String(r.error?.message), /JSONL/);
    assert.equal(r.stdout, "");
  });
  test("without --json it still prints one session per line", async () => {
    const r = await runCmd(exportCmd, sb, { positionals: ["sessions"] });
    assert.equal(r.error, undefined);
    assert.equal(r.stdout.trim().split("\n").length, 1);
  });
});

describe("config get", () => {
  let sb: Sandbox;
  before(() => {
    sb = sandbox();
  });
  after(() => sb.cleanup());
  test("lists refine.* and serve.forward.endpoint once they are set", async () => {
    const set = async (k: string, v: string) => {
      const r = await runCmd(config, sb, { action: "set", positionals: [k, v] });
      assert.equal(r.error, undefined, String(r.error?.message));
    };
    await set("refine.maxCostRise", "0.5");
    await set("serve.forward.endpoint", "http://localhost:4318");
    const r = await runCmd(config, sb, { action: "get", json: true });
    assert.equal(r.json.config.refine.maxCostRise, 0.5);
    assert.equal(r.json.config.serve.forward.endpoint, "http://localhost:4318");
    const text = await runCmd(config, sb, { action: "get" });
    assert.match(text.stdout, /maxCostRise/);
    assert.match(text.stdout, /endpoint/);
  });
});

describe("search --agent", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    // A Claude Code session hosted by T3 Code: the session says t3code, its events say claude-code.
    await sb.seed(
      [mkSession("hosted", Date.now() - 1000, { agent: "t3code" }), mkSession("plain", Date.now() - 2000, { agent: "claude-code" })],
      [
        fixtureEvent({ id: "e-hosted", sessionId: "hosted", agent: "claude-code", kind: "user.message", payload: { text: "zebrafinch migration" } }),
        fixtureEvent({ id: "e-plain", sessionId: "plain", agent: "claude-code", kind: "user.message", payload: { text: "zebrafinch nesting" } }),
      ],
    );
  });
  after(() => sb.cleanup());
  const ids = (r: { json?: any }) => (r.json.hits as { sessionId: string }[]).map((h) => h.sessionId).sort();
  test("filters on the session's agent, as sessions --agent does", async () => {
    assert.deepEqual(ids(await runCmd(search, sb, { json: true, positionals: ["zebrafinch"], flags: { agent: ["t3code"] } })), ["hosted"]);
    assert.deepEqual(ids(await runCmd(search, sb, { json: true, positionals: ["zebrafinch"], flags: { agent: ["claude-code"] } })), ["plain"]);
  });
  test("a hit reports its session's agent", async () => {
    const r = await runCmd(search, sb, { json: true, positionals: ["zebrafinch"], flags: { agent: ["t3code"] } });
    assert.equal(r.json.hits[0].agent, "t3code");
  });
});

describe("main", () => {
  test("a mistyped eval action suggests the right one", () => {
    const r = spawnSync(process.execPath, ["--no-warnings", MAIN, "eval", "lsit"], { encoding: "utf8", env: { ...process.env, CODING_SH_HOME: "", NO_COLOR: "1" } });
    assert.match(r.stderr + r.stdout, /eval list/);
  });
});
