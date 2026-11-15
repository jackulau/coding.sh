// install.sh picks its source: npm once coding.sh is published there, the
// GitHub release tarball until then (and whenever npm lacks the version).
// npm and curl are stubs on PATH; nothing touches the network or installs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, test } from "node:test";

const INSTALL_SH = resolve(import.meta.dirname, "../../../../install.sh");
const RELEASE = "https://github.com/jackulau/coding.sh/releases/download";

/** Runs install.sh with `npm view` answering `published` (version or "" for E404). */
function run(published: string, env: Record<string, string> = {}) {
  const bin = mkdtempSync(join(tmpdir(), "csh-install-"));
  const log = join(bin, "npm.log");
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
case "$1" in
  view) [ -n "$PUBLISHED" ] && { echo "$PUBLISHED"; exit 0; }; echo "npm error 404" >&2; exit 1 ;;
  install) shift; echo "$*" >> "${log}"; exit 0 ;;
  prefix) echo /nonexistent ;;
esac
`,
  );
  writeFileSync(join(bin, "curl"), `#!/bin/sh\necho '{"tag_name": "v0.3.0", "name": "x"}'\n`);
  writeFileSync(join(bin, "coding.sh"), "#!/bin/sh\nexit 0\n");
  for (const f of ["npm", "curl", "coding.sh"]) chmodSync(join(bin, f), 0o755);
  const r = spawnSync("sh", [INSTALL_SH], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: bin, CODING_SH_NO_INIT: "1", PUBLISHED: published, ...env },
  });
  let installed = "";
  try {
    installed = readFileSync(log, "utf8").trim();
  } catch {}
  return { status: r.status, stderr: r.stderr, installed };
}

describe("install.sh source", () => {
  test("before the npm publish: latest GitHub release tarball (today's path)", () => {
    const r = run("");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.installed, new RegExp(`${RELEASE}/v0\\.3\\.0/coding\\.sh-0\\.3\\.0\\.tgz$`));
  });

  test("after the npm publish: installs coding.sh@<latest> from the registry", () => {
    const r = run("0.3.0");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.installed, / coding\.sh@0\.3\.0$/);
    assert.match(r.stderr, /Installing coding\.sh v0\.3\.0/);
  });

  test("a pinned version npm lacks falls back to that GitHub release", () => {
    const r = run("", { CODING_SH_VERSION: "v0.1.0" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.installed, new RegExp(`${RELEASE}/v0\\.1\\.0/coding\\.sh-0\\.1\\.0\\.tgz$`));
  });

  test("a pinned version npm has comes from npm", () => {
    const r = run("0.1.0", { CODING_SH_VERSION: "v0.1.0" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.installed, / coding\.sh@0\.1\.0$/);
  });

  test("CODING_SH_SOURCE=github skips npm even when published", () => {
    const r = run("0.3.0", { CODING_SH_SOURCE: "github" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.installed, /releases\/download\/v0\.3\.0\/coding\.sh-0\.3\.0\.tgz$/);
  });

  test("CODING_SH_SOURCE=npm fails clearly when npm lacks it", () => {
    const r = run("", { CODING_SH_SOURCE: "npm" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /npm has no coding\.sh/);
    assert.equal(r.installed, "");
  });

  test("CODING_SH_TARBALL wins over both", () => {
    const r = run("0.3.0", { CODING_SH_TARBALL: "/tmp/x.tgz" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.installed, / \/tmp\/x\.tgz$/);
  });
});

// CODING_SH_YES=1 with no terminal is CI or a Docker build: init runs, but the
// viewer (a server that never exits) must not start. setsid drops the
// controlling terminal; without it (macOS) the test can't build the case.
const setsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;
describe("install.sh without a terminal", () => {
  test("CODING_SH_YES=1 runs init --yes and does not start the viewer", { skip: !setsid && "needs setsid" }, () => {
    const bin = mkdtempSync(join(tmpdir(), "csh-install-"));
    const calls = join(bin, "calls.log");
    writeFileSync(join(bin, "npm"), `#!/bin/sh\ncase "$1" in view) exit 1 ;; prefix) echo /nonexistent ;; esac\nexit 0\n`);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\necho '{"tag_name": "v0.3.0"}'\n`);
    writeFileSync(join(bin, "coding.sh"), `#!/bin/sh\necho "$*" >> "${calls}"\n[ "$1" = ui ] && sleep 30\nexit 0\n`);
    for (const f of ["npm", "curl", "coding.sh"]) chmodSync(join(bin, f), 0o755);
    const r = spawnSync("setsid", ["sh", INSTALL_SH], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: bin, CODING_SH_YES: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["init --yes"]);
    assert.match(r.stderr, /Run: coding\.sh ui/);
  });

  // An agent's shell has no terminal: install, set nothing up, and name the command that does (not bare `coding.sh`, which prints help there).
  test("without CODING_SH_YES: installs, runs nothing, and names init --yes as the next step", { skip: !setsid && "needs setsid" }, () => {
    const bin = mkdtempSync(join(tmpdir(), "csh-install-"));
    const calls = join(bin, "calls.log");
    writeFileSync(join(bin, "npm"), `#!/bin/sh\ncase "$1" in view) exit 1 ;; prefix) echo /nonexistent ;; esac\nexit 0\n`);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\necho '{"tag_name": "v0.3.0"}'\n`);
    writeFileSync(join(bin, "coding.sh"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 0\n`);
    for (const f of ["npm", "curl", "coding.sh"]) chmodSync(join(bin, f), 0o755);
    const r = spawnSync("setsid", ["sh", INSTALL_SH], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], env: { PATH: `${bin}:${process.env.PATH}`, HOME: bin } });
    assert.equal(r.status, 0, r.stderr);
    assert.throws(() => readFileSync(calls, "utf8"), "coding.sh was not run");
    assert.match(r.stderr, /no agent was set up yet/);
    assert.match(r.stderr, /coding\.sh init --yes/);
  });
});

describe("install.sh on Windows shells", () => {
  /** npm prefix holds the shim directly (Windows layout); a stale coding.sh sits first on PATH. */
  function windows(bin: boolean) {
    const root = mkdtempSync(join(tmpdir(), "csh-win-"));
    const prefix = join(root, "prefix");
    const stale = join(root, "stale");
    const stubs = join(root, "stubs");
    for (const d of [prefix, stale, stubs, join(prefix, "bin")]) mkdirSync(d, { recursive: true });
    const log = join(root, "init.log");
    writeFileSync(join(stubs, "npm"), `#!/bin/sh\ncase "$1" in install) exit 0 ;; prefix) echo '${prefix.split("\\").join("/")}' ;; esac\n`);
    writeFileSync(join(stubs, "uname"), `#!/bin/sh\necho MINGW64_NT-10.0\n`);
    writeFileSync(join(prefix, bin ? "bin/coding.sh" : "coding.sh"), `#!/bin/sh\necho new >> "${log}"\n`);
    writeFileSync(join(stale, "coding.sh"), `#!/bin/sh\necho stale >> "${log}"\n`);
    for (const f of ["npm", "uname"]) chmodSync(join(stubs, f), 0o755);
    for (const f of [join(prefix, "coding.sh"), join(prefix, "bin/coding.sh"), join(stale, "coding.sh")]) {
      try {
        chmodSync(f, 0o755);
      } catch {}
    }
    const r = spawnSync("sh", [INSTALL_SH], {
      encoding: "utf8",
      env: {
        PATH: `${stubs}:${stale}:${process.env.PATH}`, HOME: root, CODING_SH_TARBALL: "x.tgz",
        CODING_SH_YES: "1", CODING_SH_NO_UI: "1",
      },
    });
    let ran = "";
    try { ran = readFileSync(log, "utf8").trim(); } catch {}
    return { r, ran, prefix };
  }

  test("runs init with the binary in <prefix>, not a stale one on PATH", () => {
    const { r, ran } = windows(false);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ran, "new");
  });

  test("a binary missing from PATH names the prefix without /bin", () => {
    const root = mkdtempSync(join(tmpdir(), "csh-win-"));
    const stubs = join(root, "stubs");
    mkdirSync(stubs);
    writeFileSync(join(stubs, "npm"), `#!/bin/sh\ncase "$1" in install) exit 0 ;; prefix) echo /nonexistent/prefix ;; esac\n`);
    writeFileSync(join(stubs, "uname"), `#!/bin/sh\necho MINGW64_NT-10.0\n`);
    chmodSync(join(stubs, "npm"), 0o755);
    chmodSync(join(stubs, "uname"), 0o755);
    const cleanPath = (process.env.PATH ?? "")
      .split(delimiter)
      .filter((d) => !existsSync(join(d, "coding.sh")))
      .join(delimiter);
    const r = spawnSync("sh", [INSTALL_SH], {
      encoding: "utf8",
      env: { PATH: `${stubs}${delimiter}${cleanPath}`, HOME: root, CODING_SH_TARBALL: "x.tgz", CODING_SH_NO_INIT: "1" },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Add "\/nonexistent\/prefix" to PATH/);
  });
});
