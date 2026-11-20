// scripts/e2e/claude-transcript-capture.mjs end to end without the network: a stand-in `npm`
// (first on PATH) "installs" a stand-in `claude` into the npm prefix the way npm -g does (a .cmd
// shim in the prefix on Windows, <prefix>/bin on POSIX). The stand-in claude answers --version,
// makes the model calls the script waits for and writes one transcript under its home directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/e2e/claude-transcript-capture.mjs", import.meta.url));
const isWin = process.platform === "win32";

/** An npm-style command shim for `name` in `dir` that runs `script` (in the same dir) with node. */
function shim(dir: string, name: string, script: string): void {
  if (isWin) {
    const cmd = ["@ECHO off", "SETLOCAL", "SET dp0=%~dp0", 'SET "_prog=node"', `"%_prog%"  "%dp0%\\${script}" %*`, ""].join("\r\n");
    writeFileSync(join(dir, `${name}.cmd`), cmd);
  } else {
    writeFileSync(join(dir, name), `#!/bin/sh\nexec node "$(dirname "$0")/${script}" "$@"\n`);
    chmodSync(join(dir, name), 0o755);
  }
}

const FAKE_CLAUDE = `
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("2.1.319 (stand-in)"); process.exit(0); }
const call = async (text) => {
  const r = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", max_tokens: 10, tools: [{ name: "Read" }], messages: [{ role: "user", content: text }] }),
  });
  await r.text();
};
for (let i = 0; i < 10; i++) await call("Tidy notes.txt and greet.");
await call("Please create a detailed summary of the conversation.");
for (let i = 0; i < 2; i++) await call("Check notes.txt once more.");
const cwd = process.cwd();
const dir = join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
mkdirSync(dir, { recursive: true });
const lines = [
  JSON.stringify({ type: "user", cwd, message: { role: "user", content: "Read " + join(cwd, "notes.txt") } }),
  JSON.stringify({ type: "api-request", body: "system prompt" }),
  JSON.stringify({ type: "user", message: { role: "user", content: "input: " + JSON.stringify({ file_path: join(cwd, "sub", "CLAUDE.md") }) } }),
  JSON.stringify({ type: "attachment", attachment: { type: "skill", path: join(homedir(), ".claude", "skills", "hello", "SKILL.md") } }),
];
writeFileSync(join(dir, "s1.jsonl"), lines.join("\\n") + "\\n");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`;

const FAKE_NPM = `
import { copyFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
const isWin = process.platform === "win32";
const prefix = process.env.npm_config_prefix;
const bin = isWin ? prefix : join(prefix, "bin");
mkdirSync(bin, { recursive: true });
copyFileSync(join(import.meta.dirname, "fake-claude.mjs"), join(bin, "fake-claude.mjs"));
if (isWin) writeFileSync(join(bin, "claude.cmd"), ${JSON.stringify(["@ECHO off", "SETLOCAL", "SET dp0=%~dp0", 'SET "_prog=node"', '"%_prog%"  "%dp0%\\fake-claude.mjs" %*', ""].join("\r\n"))});
else { writeFileSync(join(bin, "claude"), '#!/bin/sh\\nexec node "$(dirname "$0")/fake-claude.mjs" "$@"\\n'); chmodSync(join(bin, "claude"), 0o755); }
`;

test("the capture installs claude through npm shims, runs it in the throwaway home and writes a scrubbed transcript", { timeout: 120_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "cc-capture-test-"));
  try {
    const tools = join(base, "tools");
    const tmp = join(base, "tmp");
    const userHome = join(base, "user");
    const out = join(base, "out");
    for (const d of [tools, tmp, userHome]) mkdirSync(d, { recursive: true });
    writeFileSync(join(tools, "fake-npm.mjs"), FAKE_NPM);
    writeFileSync(join(tools, "fake-claude.mjs"), FAKE_CLAUDE);
    shim(tools, "npm", "fake-npm.mjs");

    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(PATH|HOME|USERPROFILE|TMP|TEMP|TMPDIR)$/i.test(k)) env[k] = v;
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    Object.assign(env, {
      [pathKey]: [tools, process.env[pathKey]].filter(Boolean).join(delimiter),
      HOME: userHome,
      USERPROFILE: userHome,
      TMP: tmp,
      TEMP: tmp,
      TMPDIR: tmp,
    });
    const child = spawn(process.execPath, ["--no-warnings", SCRIPT, "--out", out], { env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const code = await new Promise<number | null>((done) => child.on("exit", (c) => done(c)));
    assert.equal(code, 0, log);

    assert.ok(existsSync(join(out, "s1.jsonl")), log);
    const text = readFileSync(join(out, "s1.jsonl"), "utf8");
    assert.match(text, /"cwd":"\/work\/demo"/);
    assert.ok(text.includes('"content":"Read /work/demo/notes.txt"'), text);
    assert.ok(text.includes('"path":"/home/user/.claude/skills/hello/SKILL.md"'), text);
    assert.ok(text.includes('input: {\\"file_path\\":\\"/work/demo/sub/CLAUDE.md\\"}'), text);
    assert.doesNotMatch(text, /api-request/);
    assert.ok(!text.includes("csh-cc-capture-"), text);
    assert.ok(!text.includes(base) && !text.includes(JSON.stringify(base).slice(1, -1)), text);
    // Claude ran in the capture's home, not the caller's; the capture's temp root is gone.
    assert.ok(!existsSync(join(userHome, ".claude")), "the caller's home was written");
    assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith("csh-cc-capture-")), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
