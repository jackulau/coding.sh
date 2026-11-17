// What install.sh tells people about the coding.sh they will run next: another
// coding.sh earlier on PATH shadows the one just installed, and on Windows
// PowerShell and cmd resolve `coding.sh` to npm's sh shim, so they need `codingsh`.
// npm and uname are stubs on PATH; nothing touches the network or installs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, test } from "node:test";

const INSTALL_SH = resolve(import.meta.dirname, "../../../../install.sh");

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  try {
    chmodSync(path, 0o755);
  } catch {}
}

/**
 * Runs install.sh with npm's prefix in a temp dir holding the new coding.sh.
 * `stale`: an older coding.sh (0.1.6) comes before the prefix on PATH.
 * `onPath`: the prefix's bin dir is on PATH (first).
 */
function install(opts: { windows?: boolean; stale?: boolean; onPath?: boolean; env?: Record<string, string> }) {
  const root = mkdtempSync(join(tmpdir(), "csh-path-"));
  const prefix = join(root, "prefix");
  const bin = opts.windows ? prefix : join(prefix, "bin");
  const stale = join(root, "stale");
  const stubs = join(root, "stubs");
  for (const d of [bin, stale, stubs]) mkdirSync(d, { recursive: true });
  script(join(stubs, "npm"), `case "$1" in install) exit 0 ;; prefix) echo '${prefix.split("\\").join("/")}' ;; esac`);
  script(join(stubs, "uname"), `echo ${opts.windows ? "MINGW64_NT-10.0" : "Linux"}`);
  script(join(bin, "coding.sh"), `[ "$1" = --version ] && echo 0.1.7\nexit 0`);
  script(join(stale, "coding.sh"), `[ "$1" = --version ] && echo 0.1.6\nexit 0`);
  const dirs = [stubs];
  if (opts.onPath) dirs.push(bin);
  if (opts.stale) dirs.push(stale);
  dirs.push(process.env.PATH ?? "");
  const r = spawnSync("sh", [INSTALL_SH], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: dirs.join(delimiter), HOME: root, CODING_SH_HOME: join(root, "csh"), CODING_SH_TARBALL: "x.tgz", CODING_SH_NO_INIT: "1", ...opts.env },
  });
  return r;
}

describe("install.sh: another coding.sh first on PATH", () => {
  test("warns, naming the other binary, its version, and the dir to put ahead of it", () => {
    const r = install({ stale: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /another coding\.sh \(0\.1\.6, [^)]*stale\/coding\.sh\) comes first on PATH; put "[^"]*prefix[\/]bin" ahead of it/);
  });

  test("says nothing when the binary just installed comes first", () => {
    const r = install({ stale: true, onPath: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /another coding\.sh/);
    assert.doesNotMatch(r.stderr, /not on PATH/);
  });

  test("warns on Windows shells too (the shim sits in the prefix itself)", () => {
    const r = install({ stale: true, windows: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /another coding\.sh \(0\.1\.6, [^)]*stale\/coding\.sh\) comes first on PATH; put "[^"]*prefix" ahead of it/);
  });
});

describe("install.sh: PowerShell and cmd on Windows", () => {
  test("names codingsh, since coding.sh there resolves to npm's sh shim", () => {
    const r = install({ windows: true, onPath: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Done\. Run: coding\.sh init/);
    assert.match(r.stderr, /In PowerShell or cmd, type codingsh instead of coding\.sh \(codingsh init\)/);
  });

  test("names codingsh after init when the viewer is skipped", () => {
    const r = install({ windows: true, onPath: true, env: { CODING_SH_NO_INIT: "", CODING_SH_YES: "1", CODING_SH_NO_UI: "1" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /type codingsh instead of coding\.sh/);
  });

  test("macOS and Linux shells get no such note", () => {
    const r = install({ onPath: true });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /codingsh/);
  });
});
