// A usage error (a typo command, an unknown flag, a missing argument) exits 2
// whether or not the streams are a terminal; a runtime error exits 1. A preload
// marks stdin, stdout and stderr as a TTY, as a terminal would.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { CLI } from "../_cli.ts";

describe("usage errors exit 2 on a TTY and off one", () => {
  let root = "";
  let env: NodeJS.ProcessEnv = {};
  let preload = "";
  const cli = (args: string[], tty: boolean) =>
    spawnSync(process.execPath, tty ? ["--no-warnings", "--import", pathToFileURL(preload).href, CLI, ...args] : ["--no-warnings", CLI, ...args], { env, cwd: root, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-usage-tty-")));
    const home = join(root, "home");
    mkdirSync(home);
    preload = join(root, "tty.mjs");
    writeFileSync(preload, `for (const s of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(s, "isTTY", { value: true, configurable: true });\n`);
    env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("a command named for what it asks (cost, waste) exits 2 and suggests the command that answers it", () => {
    const want: Record<string, string> = { cost: "usage", costs: "usage", spend: "usage", price: "usage", tokens: "usage", waste: "usage --cache", WASTE: "usage --cache" };
    for (const [typed, cmd] of Object.entries(want)) {
      const r = cli([typed], false);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`Unknown command "${typed}"\\n    Did you mean (?:coding\\.sh|codingsh) ${cmd.replace("-", "\\-")}\\?\\n$`), typed);
    }
    // --json carries it in next, in the same words.
    const j = cli(["waste", "--json"], false);
    assert.equal(j.status, 2);
    const next = JSON.parse(j.stderr).next as string[];
    assert.equal(next.length, 2);
    assert.equal(next[0], "Did you mean:");
    assert.match(next[1]!, /^(?:coding\.sh|codingsh) usage --cache$/);
    // A close spelling still comes first; a name no intent covers gets no guess (not even Object's own keys).
    assert.match(cli(["usge"], false).stderr, /Did you mean (?:coding\.sh|codingsh) usage\?/);
    for (const typed of ["constructor", "toString"]) {
      const r = cli([typed], false);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.doesNotMatch(r.stderr, /Did you mean/i, typed);
    }
  });

  for (const tty of [false, true]) {
    const where = tty ? "on a TTY" : "piped";
    it(`a typo command exits 2 ${where}, with one suggestion`, () => {
      const r = cli(["sesions"], tty);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /Unknown command "sesions"/);
      assert.equal((r.stderr.match(/did you mean/gi) ?? []).length, 1);
    });
    it(`an unknown flag exits 2 ${where}`, () => {
      const r = cli(["sessions", "--bogus"], tty);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /Unknown option --bogus/);
    });
    it(`a missing argument exits 2 ${where}`, () => {
      const r = cli(["exp", "show"], tty);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /Missing argument/);
    });
    it(`a session that does not exist is a runtime error: exit 1 ${where}`, () => {
      const r = cli(["show", "no-such-session-id"], tty);
      assert.equal(r.status, 1, r.stdout + r.stderr);
    });
  }
});
