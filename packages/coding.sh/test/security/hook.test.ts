// The hook holds its contract against what a hook config or a payload can hand it: it exits 0
// and prints nothing but the reply its protocol asks for, writes only under the spool, puts an
// agent name shaped like a path under `unknown`, keeps a session id shaped like a path out of
// the paused list, survives payloads that are empty, not JSON, not UTF-8 or nested deeper than
// JSON can be copied, and keeps no secret it was handed at any depth. Every run gets a data dir
// of its own in a fresh temp folder, so a file written anywhere else in it shows.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { after, describe, it } from "node:test";
import { PKG_ROOT, tsNodeArgs } from "../capture/_helpers.ts";

const HOOK = join(PKG_ROOT, "src", "spool", "hook.ts");
const J = (...parts: string[]): string => parts.join("");
const PAYLOAD = JSON.stringify({ session_id: "11111111-2222-4333-8444-555555555555", hook_event_name: "Stop", cwd: "/work/demo" });
const DAY_FILE = /^spool\/([^/]+)\/\d{4}-\d{2}-\d{2}\.jsonl$/;

const roots: string[] = [];
after(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A temp folder that holds the data dir (`home`) and nothing else. */
function fresh(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "csh-sec-hook-"));
  roots.push(root);
  return { root, home: join(root, "home") };
}

function hook(home: string, args: string[], input: string | Buffer, extra: Record<string, string> = {}) {
  const user = join(home, "..", "user");
  const env = { PATH: process.env.PATH ?? "", CODING_SH_HOME: home, HOME: user, USERPROFILE: user, CODING_SH_NO_AUTO_INGEST: "1", CODING_SH_NO_PROXY_AUTOSTART: "1", ...extra };
  const r = spawnSync(process.execPath, [...tsNodeArgs(), HOOK, ...args], { input, env, encoding: "utf8" });
  return [r.status, r.stdout, r.stderr];
}

/** Every file under `dir`, relative to it, with `/` separators. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"));
}

describe("the hook", () => {
  it("writes an agent name shaped like a path under spool/unknown, and nothing outside the data dir", () => {
    for (const agent of ["../../outside", "..\\..\\outside", "a/b", "/abs", "x".repeat(300), "claude-code:x", "..", "."]) {
      const { root, home } = fresh();
      assert.deepEqual(hook(home, [agent, "Stop"], PAYLOAD), [0, "", ""], agent);
      assert.deepEqual(readdirSync(root), ["home"], agent);
      const written = files(home);
      assert.equal(written.length, 1, agent);
      assert.equal(DAY_FILE.exec(written[0]!)?.[1], "unknown", agent);
    }
  });

  it("keeps an event name of any length as data", () => {
    const { root, home } = fresh();
    assert.deepEqual(hook(home, ["claude-code", J("../../", "x".repeat(20000))], PAYLOAD), [0, "", ""]);
    assert.deepEqual(readdirSync(root), ["home"]);
    assert.ok(files(home).every((f) => f.startsWith("spool/claude-code/")));
  });

  it("writes one line for a payload that is empty, not JSON or not UTF-8, and prints nothing", () => {
    const nul = String.fromCharCode(0);
    const inputs: [string, string | Buffer][] = [
      ["empty", ""],
      ["null", "null"],
      ["a number out of range", "1e999"],
      ["NUL bytes", J("a", nul, "b", nul, "c")],
      ["not UTF-8", Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0xc0, 0x22, 0x7d])],
      ["a byte order mark", J(String.fromCharCode(0xfeff), PAYLOAD)],
      ["NUL in the session id and cwd", JSON.stringify({ session_id: J("s", nul, "x"), cwd: J("/w", nul, "/x") })],
    ];
    for (const [name, input] of inputs) {
      const { home } = fresh();
      assert.deepEqual(hook(home, ["claude-code", "Stop"], input), [0, "", ""], name);
      const day = files(home).filter((f) => DAY_FILE.test(f));
      assert.equal(day.length, 1, name);
      assert.equal(readFileSync(join(home, day[0]!), "utf8").trimEnd().split("\n").length, 1, name);
      assert.ok(!existsSync(join(home, "spool", "errors.log")), name);
    }
  });

  it("keeps a session id shaped like a path out of the paused list", () => {
    const { root, home } = fresh();
    assert.deepEqual(hook(home, ["claude-code", "Stop"], JSON.stringify({ session_id: "../../outside/x" }), { CODING_SH_DISABLE: "1" }), [0, "", ""]);
    assert.deepEqual(files(root), []);
  });

  it("exits 0 and prints nothing when the spool can't be written, and still replies when asked to", () => {
    const layouts: [string, (home: string) => void][] = [
      ["the spool is a file", (h) => (mkdirSync(h, { recursive: true }), writeFileSync(join(h, "spool"), "x"))],
      ["the agent's folder is a file and errors.log a folder", (h) => (mkdirSync(join(h, "spool", "errors.log"), { recursive: true }), writeFileSync(join(h, "spool", "claude-code"), "x"))],
      ["the agent's folder links to nowhere", (h) => (mkdirSync(join(h, "spool"), { recursive: true }), symlinkSync(join(h, "..", "nowhere"), join(h, "spool", "claude-code"), "junction"))],
    ];
    for (const [name, setup] of layouts) {
      const { home } = fresh();
      setup(home);
      assert.deepEqual(hook(home, ["claude-code", "Stop"], PAYLOAD), [0, "", ""], name);
      assert.deepEqual(hook(home, ["claude-code", "Stop", "--echo-continue"], PAYLOAD), [0, '{"continue":true}\n', ""], name);
    }
  });

  it("keeps no secret nested deeper than JSON can be copied, and still writes the line", () => {
    // Far deeper than JSON.stringify can follow on any platform; JSON.parse still reads it.
    const deep = (inner: string): string => `${"[".repeat(100_000)}${inner}${"]".repeat(100_000)}`;
    const token = J("h", "f_", "Zq7Lm2Xc9Vb4Nn8Kp1Rt6Yw3Hs5Df0Gj2A");
    const password = J("Pw", "Tq8Rv2Lm4Xc6Bn1Zk3", "9");
    const cases: [string, string][] = [
      ["in the payload", `{"session_id":"s1","tool_response":${deep(JSON.stringify(token))}}`],
      ["in a JSON document inside a string, next to a password", JSON.stringify({ session_id: "s2", tool_response: deep("1"), note: `password=${password}` })],
    ];
    for (const [name, input] of cases) {
      const { home } = fresh();
      assert.deepEqual(hook(home, ["claude-code", "PostToolUse"], input), [0, "", ""], name);
      assert.ok(files(home).some((f) => DAY_FILE.test(f)), `${name}: no spool line`);
      assert.ok(!existsSync(join(home, "spool", "errors.log")), name);
      for (const f of files(home)) {
        const text = readFileSync(join(home, f), "utf8");
        assert.ok(!text.includes(token) && !text.includes(password), `${name}: ${f} holds a secret`);
      }
    }
  });
});
