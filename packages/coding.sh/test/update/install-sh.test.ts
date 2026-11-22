// install.sh picks its source: the latest GitHub release (what `coding.sh
// update` installs), from npm when the registry has that version, else the
// release tarball; npm's latest when GitHub can't be reached.
// npm and curl are stubs on PATH; nothing touches the network or installs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const INSTALL_SH = resolve(import.meta.dirname, "../../../../install.sh");
const RELEASE = "https://github.com/jackulau/coding.sh/releases/download";

const stubDirs: string[] = [];
/** A new folder for the stub programs, which is also the run's HOME. Removed when the file's tests are done. */
function stubDir(prefix = "csh-install-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  stubDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of stubDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs install.sh with npm publishing `published` (versions, oldest first; "" for none) and
 * GitHub's latest release at v0.3.0. `npm view coding.sh@<v> version` answers as npm 11 does:
 * the version, or exit 1 when the registry lacks it. CURL_FAIL=1 makes GitHub unreachable.
 */
function run(published: string, env: Record<string, string> = {}) {
  const bin = stubDir();
  const log = join(bin, "npm.log");
  const curlLog = join(bin, "curl.log");
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
case "$1" in
  view)
    spec="\${2#coding.sh@}"; found=; last=
    for v in $PUBLISHED; do last=$v; [ "$v" = "$spec" ] && found=$v; done
    [ "$spec" = latest ] && found=$last
    [ -n "$found" ] && { echo "$found"; exit 0; }
    echo "npm error code E404" >&2; exit 1 ;;
  install) shift; echo "$*" >> "${log}"; exit 0 ;;
  prefix) echo /nonexistent ;;
esac
`,
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\necho "$*" >> "${curlLog}"\n[ -n "$CURL_FAIL" ] && { echo "curl: (7) Failed to connect" >&2; exit 7; }\necho '{"tag_name": "v0.3.0", "name": "x"}'\n`,
  );
  writeFileSync(join(bin, "coding.sh"), "#!/bin/sh\nexit 0\n");
  for (const f of ["npm", "curl", "coding.sh"]) chmodSync(join(bin, f), 0o755);
  const r = spawnSync("sh", [INSTALL_SH], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: bin, CODING_SH_NO_INIT: "1", PUBLISHED: published, ...env },
  });
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return "";
    }
  };
  return { status: r.status, stderr: r.stderr, installed: read(log), curled: read(curlLog) };
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

  // A release whose npm publish failed or waits for approval: rerunning the script
  // installs the release `coding.sh update` installs, not the older one on npm.
  test("npm's latest is behind the latest GitHub release: installs the release tarball", () => {
    const r = run("0.2.0");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.installed, new RegExp(`${RELEASE}/v0\\.3\\.0/coding\\.sh-0\\.3\\.0\\.tgz$`));
    assert.match(r.stderr, /Installing coding\.sh v0\.3\.0/);
  });

  test("npm has the latest GitHub release: installs that version from npm", () => {
    const r = run("0.2.0 0.3.0");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.installed, / coding\.sh@0\.3\.0$/);
  });

  test("GitHub can't be reached: installs npm's latest, and the lookup has a time limit", () => {
    const r = run("0.2.0", { CURL_FAIL: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.installed, / coding\.sh@0\.2\.0$/);
    assert.match(r.curled, /--connect-timeout \d+ --max-time \d+ /);
  });

  test("CODING_SH_SOURCE=npm installs npm's latest and never asks GitHub", () => {
    const r = run("0.2.0", { CODING_SH_SOURCE: "npm" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.installed, / coding\.sh@0\.2\.0$/);
    assert.equal(r.curled, "");
  });

  test("neither GitHub nor npm answers: fails and installs nothing", () => {
    const r = run("", { CURL_FAIL: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Could not find the latest release/);
    assert.equal(r.installed, "");
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
    const bin = stubDir();
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
    const bin = stubDir();
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
    const root = stubDir("csh-win-");
    const prefix = join(root, "prefix");
    const stale = join(root, "stale");
    const stubs = join(root, "stubs");
    for (const d of [prefix, stale, stubs, join(prefix, "bin")]) mkdirSync(d, { recursive: true });
    const log = join(root, "init.log");
    writeFileSync(join(stubs, "npm"), `#!/bin/sh\ncase "$1" in install) exit 0 ;; prefix) echo '${prefix.split("\\").join("/")}' ;; esac\n`);
    writeFileSync(join(stubs, "uname"), `#!/bin/sh\necho MINGW64_NT-10.0\n`);
    writeFileSync(join(prefix, bin ? "bin/coding.sh" : "coding.sh"), `#!/bin/sh\necho new >> "${log}"\n`);
    // install.sh asks a shadowing coding.sh for its --version (to warn about it); nothing else may reach it.
    writeFileSync(join(stale, "coding.sh"), `#!/bin/sh\n[ "$1" = --version ] && exit 0\necho stale >> "${log}"\n`);
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
    const root = stubDir("csh-win-");
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
