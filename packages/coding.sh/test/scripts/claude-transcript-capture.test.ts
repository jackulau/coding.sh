// scripts/e2e/claude-transcript-capture.mjs end to end without the network: a stand-in `npm`
// (first on PATH) "installs" a stand-in `claude` into the npm prefix the way npm -g does (a .cmd
// shim in the prefix on Windows, <prefix>/bin on POSIX). The stand-in claude answers --version,
// makes the model calls the script waits for and writes one transcript under its home directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAbove } from "../../../../scripts/e2e/temp-base.ts";

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

/**
 * A `claude` in `tools` that notes it ran in `marker` and fails. The capture runs the claude it
 * installed, ahead of `tools` on PATH, so this one runs only when the capture would otherwise
 * reach a claude installed on this machine.
 */
function pathClaude(tools: string, marker: string): void {
  writeFileSync(join(tools, "path-claude.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "");\nconsole.error("a claude from PATH ran");\nprocess.exit(1);\n`);
  shim(tools, "claude", "path-claude.mjs");
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

/** Runs the capture with `tools` first on PATH, `home` as the caller's home and `tmp` as the temp folder. */
async function capture(tools: string, home: string, tmp: string, out: string): Promise<{ code: number | null; log: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(PATH|HOME|USERPROFILE|TMP|TEMP|TMPDIR)$/i.test(k)) env[k] = v;
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  Object.assign(env, {
    [pathKey]: [tools, process.env[pathKey]].filter(Boolean).join(delimiter),
    HOME: home,
    USERPROFILE: home,
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
  });
  const child = spawn(process.execPath, ["--no-warnings", SCRIPT, "--out", out], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const code = await new Promise<number | null>((done) => child.on("close", (c) => done(c)));
  return { code, log };
}

// The capture refuses a temp folder with Claude Code's files or a git repository above it, as on
// Windows, where the temp folder is under your home, next to ~/.claude.
const ABOVE_TEMP = readAbove(tmpdir()).length > 0 && "the temp folder has Claude Code's files or a git repository above it";

test("the capture installs claude through npm shims, runs it in the throwaway home and writes a scrubbed transcript", { timeout: 120_000, skip: ABOVE_TEMP }, async () => {
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
    pathClaude(tools, join(base, "path-claude-ran"));

    const { code, log } = await capture(tools, userHome, tmp, out);
    assert.equal(code, 0, log);
    assert.ok(!existsSync(join(base, "path-claude-ran")), "a claude from PATH ran");

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

test("the capture stops before it installs anything when the temp folder has Claude Code's files above it", { timeout: 60_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "cc-capture-test-"));
  try {
    const tools = join(base, "tools");
    const home = join(base, "home");
    const tmp = join(home, "tmp");
    for (const d of [tools, tmp, join(home, ".claude")]) mkdirSync(d, { recursive: true });
    // This npm only notes that it ran.
    writeFileSync(join(tools, "fake-npm.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(base, "npm-ran"))}, "");\n`);
    shim(tools, "npm", "fake-npm.mjs");
    pathClaude(tools, join(base, "path-claude-ran"));

    const { code, log } = await capture(tools, home, tmp, join(base, "out"));
    assert.notEqual(code, 0, log);
    assert.ok(log.includes(`Claude Code would read ${join(realpathSync(home), ".claude")}`), log);
    assert.ok(!existsSync(join(base, "npm-ran")), "npm ran");
    assert.ok(!existsSync(join(base, "path-claude-ran")), "a claude from PATH ran");
    assert.deepEqual(readdirSync(tmp), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
