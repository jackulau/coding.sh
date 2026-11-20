// The scorecard on Windows: Git Bash eats unescaped backslashes, PATH uses ";", and npm CLIs on
// PATH are .cmd shims. These tests hold on every platform; on Windows they fail without the fixes.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bash, checkOutput, failure, formatReason, shellVars, TAP, template, validateTask, withPath } from "../cli-suite.mjs";
import { invalidSummary } from "../score.mjs";
import { siteLighthouse } from "../site.mjs";
import { benchViewer, chromeCandidates } from "../bench.mjs";
import { browserEnv, CLI, findLighthouse, firstErrorLine, lighthouseReport, runLighthouse } from "../lib/util.mjs";

const root = mkdtempSync(join(tmpdir(), "dogfood-portability-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("the tap shim points at a file that exists", () => {
  // URL.pathname gave "/D:/…/tap.mjs" on Windows, which node resolves to no file.
  assert.ok(existsSync(TAP), TAP);
});

test("a Windows path reaches a bash script intact", async () => {
  const p = "C:\\Users\\x\\repos\\calc";
  const script = template(`printf '%s|' \${p}/a "\${p}" ; node -e 'process.stdout.write("\${p}")'`, shellVars({ p }, "win32"));
  const r = await bash(script, root, { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${p}/a|${p}|${p}`);
  assert.deepEqual(shellVars({ p }, "linux"), { p });
});

test("withPath puts dirs first with the platform delimiter and keeps one PATH key", () => {
  const w = withPath({ Path: "C:\\Windows", HOME: "h" }, ["C:\\bin"], undefined, "win32");
  assert.deepEqual(w, { HOME: "h", PATH: "C:\\bin;C:\\Windows" });
  assert.equal(withPath({ PATH: "/usr/bin" }, ["/x"], undefined, "linux").PATH, "/x:/usr/bin");
  // State checks keep this process's PATH over the fixture's narrow one.
  assert.equal(withPath({ PATH: "/fixture" }, ["/node"], "/usr/bin", "linux").PATH, "/node:/usr/bin");
});

test("output checks read backslashes as slashes when asked", () => {
  const text = "C:\\h\\.claude\\settings.json\n";
  assert.equal(checkOutput({ regex: "\\.claude/settings\\.json" }, text).pass, false);
  assert.equal(checkOutput({ regex: "\\.claude/settings\\.json" }, text, { slashes: true }).pass, true);
  assert.equal(checkOutput({ contains: "C:\\h\\.claude" }, "C:/h/.claude", { slashes: true }).pass, true);
  // JSON is parsed from the text as printed: escaped quotes stay valid.
  assert.equal(checkOutput({ json: { a: 'x"y' } }, '{"a":"x\\"y"}', { slashes: true }).pass, true);
});

test("the error line skips Node's stack preamble", () => {
  const stderr = "node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module 'D:\\x\\tap.mjs'\n    at Module._resolveFilename\n";
  assert.equal(firstErrorLine(stderr), "Error: Cannot find module 'D:\\x\\tap.mjs'");
  assert.equal(firstErrorLine("just a line\nanother"), "just a line");
  assert.deepEqual(failure("reference", "coding.sh x\n", { code: 2, stderr: "usage: coding.sh x\n" }), { check: "reference", command: "coding.sh x", exit: 2, stderr: "usage: coding.sh x" });
  assert.equal(formatReason({ check: "reference", command: "coding.sh x", exit: 2, stderr: "usage" }), "reference: coding.sh x exited 2: usage");
});

// A suite whose setup writes the answers file the runner reads, with work/ as the trial's cwd.
const suite = {
  setup: {
    commands: [`${JSON.stringify(process.execPath)} -e 'const fs=require("fs"),p=require("path");const [a,t]=process.argv.slice(1);fs.mkdirSync(p.join(t,"work"),{recursive:true});fs.mkdirSync(p.dirname(a),{recursive:true});fs.writeFileSync(a,JSON.stringify({paths:{work:p.join(t,"work"),home:t},env:{}}))' '\${answersFile}' '\${trial}'`],
  },
};
const task = (id, reference, check) => ({ id, split: "dev", instruction: "do the thing", reference, check });

test("an invalid task carries the check, command, exit code and error line", async () => {
  const r = await validateTask(suite, task("ref-fails", ['echo "Error: boom" >&2; exit 3'], [{ kind: "output", contains: "done" }]), { cli: CLI });
  assert.equal(r.ok, false);
  assert.deepEqual({ ...r.reason, command: undefined }, { check: "reference", command: undefined, exit: 3, stderr: "Error: boom" });
  assert.match(r.reason.command, /exit 3/);
  const noop = await validateTask(suite, task("noop-passes", ["echo done"], [{ kind: "output", absent: "nope" }]), { cli: CLI });
  assert.equal(noop.reason.check, "no-op");
  const ok = await validateTask(suite, task("passes", ["echo done"], [{ kind: "output", contains: "done" }]), { cli: CLI });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, undefined);
  const s = invalidSummary([r, noop, ok, { id: "b", status: "blocked", ok: false }]);
  assert.deepEqual(s.invalidTasks, ["ref-fails", "noop-passes"]);
  assert.equal(s.invalidReasons["ref-fails"].exit, 3);
  assert.equal(s.invalidReasons["noop-passes"].check, "no-op");
});

test("a reference that uses a templated path validates", async () => {
  // The answers' work dir is a native path: C:\…\work on Windows, which bash read as C:…work.
  const r = await validateTask(suite, task("path", ["cd ${answers.paths.work} && pwd -W 2>/dev/null || pwd", 'node -e \'process.stdout.write("${answers.paths.work}")\''], [{ kind: "output", contains: "${answers.paths.work}" }]), { cli: CLI });
  assert.equal(r.ok, true, formatReason(r.reason));
});

test("findLighthouse prefers the site's node_modules copy, run with this node", () => {
  const dir = join(root, "lh-site");
  mkdirSync(join(dir, "node_modules", "lighthouse", "cli"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "lighthouse", "package.json"), JSON.stringify({ version: "9.9.9", bin: { lighthouse: "cli/index.js" } }));
  writeFileSync(join(dir, "node_modules", "lighthouse", "cli", "index.js"), "");
  const lh = findLighthouse({ from: [dir], env: { PATH: "" } });
  assert.equal(lh.cmd, process.execPath);
  assert.equal(lh.shell, false);
  assert.match(lh.source, /9\.9\.9/);
});

test("findLighthouse takes the .cmd shim on Windows PATH, and runLighthouse starts it", () => {
  const bin = join(root, "lh-bin");
  mkdirSync(bin, { recursive: true });
  const report = '{"audits":{"interactive":{"numericValue":42}}}';
  if (process.platform === "win32") writeFileSync(join(bin, "lighthouse.cmd"), `@echo off\r\necho ${report}\r\n`);
  else {
    writeFileSync(join(bin, "lighthouse"), `#!/bin/sh\necho '${report}'\n`);
    chmodSync(join(bin, "lighthouse"), 0o755);
  }
  const lh = findLighthouse({ from: [], env: { PATH: bin } });
  assert.ok(lh, "found on PATH");
  assert.equal(lh.shell, process.platform === "win32");
  const r = runLighthouse(lh, ["http://127.0.0.1:1/", "--output=json"]);
  assert.equal(lighthouseReport(r).audits.interactive.numericValue, 42);
  assert.equal(findLighthouse({ from: [], env: { PATH: join(root, "nothing-here") } }), undefined);
});

test("a lighthouse run with no report says why", () => {
  assert.throws(() => lighthouseReport({ code: 1, stdout: "", stderr: "", error: { code: "ENOENT" } }), /exited 1: ENOENT/);
  assert.throws(() => lighthouseReport({ code: 1, stdout: "", stderr: "Runtime error encountered: No Chrome installations found.\n" }), (e) => /Chrome/.test(e.missing));
  // Windows: the report printed, then deleting Chrome's temp profile failed (exit 1).
  assert.equal(lighthouseReport({ code: 1, stdout: '{"audits":{}}', stderr: "EPERM" }).audits.constructor, Object);
});

test("missing lighthouse or Chrome is a skip that names what to install", async () => {
  const site = await siteLighthouse({ lighthouse: null });
  assert.equal(site.value, null);
  assert.match(site.skipped, /lighthouse CLI not found: run npm ci/);
  const viewer = await benchViewer({ chrome: null, lighthouse: null });
  assert.equal(viewer["perf.viewerTti"], null);
  assert.match(viewer.skipped, /CHROME_PATH/);
  assert.match(viewer.skipped, /npm ci/);
  assert.ok(chromeCandidates({ LOCALAPPDATA: "L" }).includes(join("L", "Google", "Chrome", "Application", "chrome.exe")));
});

test("Chrome gets a USERPROFILE with AppData/Local on Windows", () => {
  // Without it Chrome refuses remote debugging, even with --user-data-dir, and lighthouse never connects.
  const home = join(root, "temp-home");
  mkdirSync(home, { recursive: true });
  const env = browserEnv({ USERPROFILE: home, PATH: "p" }, "win32");
  assert.equal(env.LOCALAPPDATA, join(home, "AppData", "Local"));
  assert.ok(existsSync(env.LOCALAPPDATA));
  const other = { USERPROFILE: join(root, "untouched"), PATH: "p" };
  assert.equal(browserEnv(other, "linux"), other);
  assert.equal(existsSync(other.USERPROFILE), false);
});
