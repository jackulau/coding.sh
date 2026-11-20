// Regression tests for the fourth hands-on QA round on the CLI: agent detection that left files in
// Gemini CLI's home, a subagent printed as its parent's short id, bench commands on a benchmark
// that does not exist, and upgrade-store --json calling a change of owner a migration (that one
// is in upgrade-store.test.ts).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { packageVersion } from "../../src/adapters/_shared/detect.ts";
import * as bench from "../../src/cli/commands/bench.ts";
import * as show from "../../src/cli/commands/show.ts";
import { shortSessionId } from "../../src/cli/common.ts";
import { nodeBin, pathOf } from "../_bin.ts";
import { removeTestDir } from "../_rm.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";
import { cleanup, runSync, tmpHome } from "./_run-cli.ts";

describe("detecting Gemini CLI", () => {
  after(cleanup);

  /** A fake `gemini` that, like the real one, writes into its home on every launch. */
  function fakeGemini(dir: string): void {
    nodeBin(
      dir,
      "gemini",
      [
        'const { mkdirSync, writeFileSync } = require("node:fs");',
        'const { join } = require("node:path");',
        'const dir = join(process.env.GEMINI_CLI_HOME || process.env.HOME || process.env.USERPROFILE, ".gemini");',
        "mkdirSync(dir, { recursive: true });",
        'writeFileSync(join(dir, "projects.json." + process.pid + ".tmp"), "{}");',
        'process.stdout.write("0.55.1\\n");',
      ].join("\n"),
    );
  }

  function doctorGemini(h: ReturnType<typeof tmpHome>, bin: string): { version: string | null } {
    const r = runSync(["doctor", "--json", "--agent", "gemini-cli"], { ...h.env, PATH: pathOf(bin, dirname(process.execPath)) }, 60_000);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    const doc = JSON.parse(r.stdout) as { agents: { id: string; version: string | null }[] };
    return doc.agents.find((a) => a.id === "gemini-cli")!;
  }

  test("reads the version from the npm package and does not launch the CLI", () => {
    const h = tmpHome();
    const bin = join(h.root, "prefix");
    fakeGemini(bin);
    const pkg = join(bin, "node_modules", "@google", "gemini-cli");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@google/gemini-cli", version: "9.8.7" }));
    assert.equal(doctorGemini(h, bin).version, "9.8.7");
    assert.equal(existsSync(join(h.home, ".gemini")), false, "nothing written in the user's Gemini home");
  });

  test("without a package.json the launch it falls back to runs in a temp home, not the user's", () => {
    const h = tmpHome();
    const bin = join(h.root, "bin");
    fakeGemini(bin);
    assert.equal(doctorGemini(h, bin).version, "0.55.1", "the version still comes from the CLI");
    assert.equal(existsSync(join(h.home, ".gemini")), false, "nothing written in the user's Gemini home");
  });
});

describe("packageVersion", () => {
  test("finds the npm package next to a shim, under lib/node_modules, and above the binary", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-pkgver-")));
    try {
      const put = (dir: string, name: string, version: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
      };
      put(join(root, "win", "node_modules", "opencode-ai"), "opencode-ai", "1.18.10");
      assert.equal(packageVersion(join(root, "win", "opencode.cmd"), "opencode-ai"), "1.18.10");
      put(join(root, "unix", "lib", "node_modules", "@google", "gemini-cli"), "@google/gemini-cli", "0.55.1");
      assert.equal(packageVersion(join(root, "unix", "bin", "gemini"), "@google/gemini-cli"), "0.55.1");
      const pkg = join(root, "up", "gemini-cli");
      put(pkg, "@google/gemini-cli", "1.2.3");
      mkdirSync(join(pkg, "bundle"), { recursive: true });
      writeFileSync(join(pkg, "bundle", "gemini.js"), "");
      assert.equal(packageVersion(join(pkg, "bundle", "gemini.js"), "@google/gemini-cli"), "1.2.3");
      assert.equal(packageVersion(join(root, "win", "opencode.cmd"), "@google/gemini-cli"), undefined, "another package's file is not it");
    } finally {
      removeTestDir(root);
    }
  });
});

describe("a subagent's short id", () => {
  const parent = "a03d2f6b-2cdc-4540-b67d-876ed57908c5";
  const sub = `${parent}:sub:a7d4978917f0661cd`;
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([mkSession(parent, Date.now() - 120_000, { agent: "t3code" as never }), mkSession(sub, Date.now() - 60_000, { parent: { sessionId: parent, subagentId: "a7d4978917f0661cd" } })]);
  });
  after(() => sb.cleanup());

  test("names the subagent, not its parent", () => {
    assert.equal(shortSessionId(sub), "a03d2f6b:sub:a7d49789");
    assert.equal(shortSessionId(parent), "a03d2f6b");
    assert.equal(shortSessionId(`${sub}:sub:bbbbccccdddd`), "a03d2f6b:sub:a7d49789:sub:bbbbcccc");
  });

  test("opens the subagent with show; the parent's prefix still opens the parent", async () => {
    const r = await runCmd(show, sb, { positionals: [shortSessionId(sub)], json: true, flags: { fields: "session.id" } });
    assert.equal(r.error, undefined, String(r.error?.message));
    assert.equal(r.json.session.id, sub);
    const p = await runCmd(show, sb, { positionals: ["a03d2f6b"], json: true, flags: { fields: "session.id" } });
    assert.equal(p.json.session.id, parent);
  });
});

describe("bench on a benchmark that does not exist", () => {
  let sb: Sandbox;
  let cwd: string;
  before(() => {
    sb = sandbox();
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "csh-bench-none-")));
  });
  after(() => {
    sb.cleanup();
    removeTestDir(cwd);
  });

  for (const action of ["show", "history", "report"]) {
    test(`bench ${action} says it can't find it, as bench run does`, async () => {
      const r = await runCmd(bench, sb, { action, positionals: ["nope"], cwd });
      assert.match(String(r.error?.message), /Can't find benchmark "nope"/);
      assert.equal(r.error.reason, "not_found");
      assert.ok(r.error.next.some((l: string) => l.includes("coding.sh bench new nope")), JSON.stringify(r.error.next));
      assert.ok(!r.error.next.some((l: string) => l.includes("bench run nope")), "no next step that fails too");
    });
  }

  test("bench show latest is a benchmark name too", async () => {
    const r = await runCmd(bench, sb, { action: "show", positionals: ["latest"], cwd });
    assert.match(String(r.error?.message), /Can't find benchmark "latest"/);
  });
});
