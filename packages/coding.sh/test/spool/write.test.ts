// The spool writer on a full disk: a write cut short leaves no fragment, so the
// next line (from hook.sh, which appends without looking at the file's end) is a
// line of its own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { SpoolLine } from "../../src/core/types.ts";
import { appendSpool, spoolFile } from "../../src/spool/write.ts";
import { PKG_ROOT } from "../capture/_helpers.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function home() {
  const root = mkdtempSync(join(tmpdir(), "csh-write-"));
  roots.push(root);
  return { root, env: { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") } as NodeJS.ProcessEnv };
}

/** Runs `fn` with fs.writeSync writing half of what it is given once, then failing with ENOSPC. */
function withFullDisk<T>(fn: () => T): T {
  const real = fs.writeSync;
  let calls = 0;
  fs.writeSync = function (fd: number, buf: unknown, off?: unknown, len?: number, ...rest: unknown[]) {
    if (fd < 3 || !Buffer.isBuffer(buf)) return (real as (...a: unknown[]) => number).call(fs, fd, buf, off, len, ...rest);
    if (calls++ === 0) return (real as (...a: unknown[]) => number).call(fs, fd, buf, off, Math.max(1, Math.floor((len ?? 0) / 2)));
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
  } as typeof fs.writeSync;
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs.writeSync = real;
    syncBuiltinESMExports();
  }
}

describe("appendSpool on a full disk", () => {
  it("cuts a partly written line back off, so the file is as it was", () => {
    const { env } = home();
    const base: SpoolLine = { v: 0, agent: "fake", event: "PostToolUse", ts: Date.now(), pid: 1, cwd: "/w", raw: { a: 1 } };
    const file = appendSpool(base, env)!;
    const before = readFileSync(file);
    assert.throws(() => withFullDisk(() => appendSpool({ ...base, event: "Stop", raw: { b: "x".repeat(200) } }, env)), { code: "ENOSPC" });
    assert.deepEqual(readFileSync(file), before);
  });

  it("a hook.sh line written after the failure parses as its own line", { skip: process.platform === "win32" && "no hook.sh on Windows" }, () => {
    const { root, env } = home();
    const base: SpoolLine = { v: 0, agent: "fake", event: "PostToolUse", ts: Date.now(), pid: 1, cwd: "/w", raw: { a: 1 } };
    const file = spoolFile("fake", base.ts, env);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(base) + "\n");
    assert.throws(() => withFullDisk(() => appendSpool({ ...base, event: "Stop", raw: { b: "x".repeat(200) } }, env)), { code: "ENOSPC" });
    const sh = join(root, "hook.sh");
    copyFileSync(join(PKG_ROOT, "src", "spool", "hook.sh"), sh);
    const r = spawnSync("/bin/sh", [sh, "fake", "UserPromptSubmit"], { input: '{"cwd":"/w","p":"hi"}', env: { PATH: "/usr/bin:/bin", CODING_SH_HOME: env.CODING_SH_HOME! }, encoding: "utf8" });
    assert.equal(r.status, 0);
    // The day may have turned between the two writes: read whichever file hook.sh wrote.
    const lines = readFileSync(spoolFile("fake", Date.now(), env), "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines.at(-1)!) as SpoolLine;
    assert.equal(last.event, "UserPromptSubmit");
    assert.deepEqual(last.raw, { cwd: "/w", p: "hi" });
    for (const l of lines) JSON.parse(l);
  });
});
