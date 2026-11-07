// install.sh picks its source: npm once coding.sh is published there, the
// GitHub release tarball until then (and whenever npm lacks the version).
// npm and curl are stubs on PATH; nothing touches the network or installs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
});
