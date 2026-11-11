// A prompt with a token, in a spool day that has passed: ingest counts the token and scrubs
// the line, and `ingest --rebuild` (which re-reads that scrubbed line) keeps the count.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CLI } from "../query/_seed.ts";

const root = mkdtempSync(join(tmpdir(), "csh-rebuild-redact-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("ingest --rebuild keeps the Redacted row of a prompt whose spool line was scrubbed", { skip: process.platform === "win32" && "hook.sh is the POSIX hook" }, () => {
  // init sets up only an agent it finds: a stand-in claude on PATH, so the test needs no install.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "2.1.319 (Claude Code)"\n');
  chmodSync(join(bin, "claude"), 0o755);
  // init installs hook.mjs from dist/, which a CI shard has not built: a stand-in will do, since the
  // test drives the sh fast path (src/spool/hook.sh when running from source).
  const hookMjs = join(root, "dist", "hook.mjs");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(hookMjs, "// stand-in: this test runs hook.sh\n");
  const env = { ...process.env, CODING_SH_HOOK_SOURCE: hookMjs, PATH: `${bin}:${process.env.PATH}`, HOME: join(root, "h"), CODING_SH_HOME: join(root, "cs"), CLAUDE_CONFIG_DIR: join(root, "c"), CODEX_HOME: join(root, "x"), CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" };
  for (const d of [env.HOME, env.CLAUDE_CONFIG_DIR]) mkdirSync(d, { recursive: true });
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", timeout: 120_000 });
  const init = cli("init", "--agent", "claude-code", "--yes", "--no-import", "--no-mcp");
  assert.equal(init.status, 0, init.stderr);
  const token = ["gh", "p_", "R7kq2Zx9", "Lm4Tv8Wn", "3Hs6Jd1F", "p0Yc5Bg2", "Qe7u"].join("");
  const payload = JSON.stringify({ session_id: "rb-2", hook_event_name: "UserPromptSubmit", prompt: `push with ${token} now`, cwd: "/work/demo" });
  const hook = spawnSync("/bin/sh", [join(env.CODING_SH_HOME, "bin", "hook.sh"), "claude-code", "UserPromptSubmit"], { env, input: payload, encoding: "utf8" });
  assert.equal(hook.status, 0, hook.stderr);
  const dir = join(env.CODING_SH_HOME, "spool", "claude-code");
  const day = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
  renameSync(join(dir, day), join(dir, "2026-11-09.jsonl"));
  assert.equal(cli("ingest").status, 0);
  assert.match(cli("show", "rb-2").stdout, /Redacted +github-token 1/);
  const rebuilt = cli("ingest", "--rebuild", "--agent", "claude-code");
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.match(cli("show", "rb-2").stdout, /Redacted +github-token 1/, "the count survives the re-parse of the scrubbed line");
});
