import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runUpdate, type InstallResult, type UpdateDeps } from "../../src/cli/commands/update.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import type { CheckOptions, UpdateCache } from "../../src/update/index.ts";
import { tmpEnv, ttyStream } from "./helpers.ts";

const TGZ = "https://github.com/jackulau/coding.sh/releases/download/v0.2.0/coding.sh-0.2.0.tgz";
const available: UpdateCache = { latest: "0.2.0", checkedAt: 1, url: "https://github.com/jackulau/coding.sh/releases/tag/v0.2.0", install: TGZ, source: "github" };

function ctx(flags: Record<string, boolean> = {}, json = false, signal = new AbortController().signal) {
  const stdout = ttyStream(false);
  const stderr = ttyStream(false);
  const env = tmpEnv();
  const out = new Output({ json, env, stdout, stderr, stdin: { isTTY: false } });
  const c: CommandContext = { flags, positionals: [], rest: [], out, env, cwd: process.cwd(), debug: false, signal };
  return { c, stdout, stderr };
}

function deps(cache: UpdateCache, install?: (args: string[]) => InstallResult | Promise<InstallResult>) {
  const seen = { checks: [] as CheckOptions[], installs: [] as { args: string[]; quiet: boolean }[] };
  const d: UpdateDeps = {
    current: "0.1.0",
    check: async (_env, opts) => (seen.checks.push(opts), cache),
    install: async (args, o) => (seen.installs.push({ args, quiet: o.quiet }), install ? install(args) : { code: 0, output: "" }),
  };
  return { d, seen };
}

describe("coding.sh update", () => {
  test("installs the release tarball the way install.sh does", async () => {
    const { c, stdout, stderr } = ctx();
    const { d, seen } = deps(available);
    assert.equal(await runUpdate(c, d), 0);
    assert.equal(seen.checks[0]!.force, true, "always a fresh check");
    assert.deepEqual(seen.installs, [{ args: ["install", "-g", "--silent", "--no-fund", "--no-audit", TGZ], quiet: false }]);
    assert.equal(stdout.text, "");
    assert.match(stderr.text, /Current\s+0\.1\.0/);
    assert.match(stderr.text, /Latest\s+0\.2\.0/);
    assert.match(stderr.text, /Changelog\s+https:\/\/github\.com\/jackulau\/coding\.sh\/releases\/tag\/v0\.2\.0/);
    assert.match(stderr.text, /✓ Updated coding\.sh 0\.1\.0 → 0\.2\.0/);
  });

  test("--dry-run prints the command on stdout and installs nothing", async () => {
    const { c, stdout, stderr } = ctx({ "dry-run": true });
    const { d, seen } = deps(available);
    assert.equal(await runUpdate(c, d), 0);
    assert.equal(seen.installs.length, 0);
    assert.equal(stdout.text, `npm install -g --silent --no-fund --no-audit ${TGZ}\n`);
    assert.match(stderr.text, /Dry run/);
  });

  test("--check reports the latest version without installing", async () => {
    const { c, stdout } = ctx({ check: true });
    const { d, seen } = deps(available);
    assert.equal(await runUpdate(c, d), 0);
    assert.equal(seen.installs.length, 0);
    assert.equal(stdout.text, "0.2.0\n");
  });

  test("up to date: exit 0, nothing installed", async () => {
    const { c, stderr } = ctx();
    const { d, seen } = deps({ ...available, latest: "0.1.0" });
    assert.equal(await runUpdate(c, d), 0);
    assert.equal(seen.installs.length, 0);
    assert.match(stderr.text, /✓ coding\.sh 0\.1\.0 is the latest version/);
  });

  test("--json: one document on stdout, quiet npm, empty stderr", async () => {
    for (const [flags, cache, status] of [
      [{}, available, "updated"],
      [{ "dry-run": true }, available, "available"],
      [{}, { ...available, latest: "0.0.9" }, "up_to_date"],
    ] as const) {
      const { c, stdout, stderr } = ctx(flags, true);
      const { d, seen } = deps(cache);
      assert.equal(await runUpdate(c, d), 0);
      const doc = JSON.parse(stdout.text) as Record<string, unknown>;
      assert.equal(doc.status, status);
      assert.equal(doc.current, "0.1.0");
      assert.equal(doc.latest, cache.latest);
      assert.equal(doc.url, available.url);
      assert.equal(stderr.text, "");
      for (const i of seen.installs) assert.equal(i.quiet, true);
    }
  });

  test("a failed check is exit 1 with a reason", async () => {
    const { c } = ctx({}, true);
    const { d } = deps({ latest: "0.2.0", error: "GitHub: fetch failed; npm: fetch failed" });
    await assert.rejects(runUpdate(c, d), (e: { reason: string; exitCode: number; message: string }) => {
      assert.equal(e.reason, "update_check_failed");
      assert.equal(e.exitCode, 1);
      assert.match(e.message, /fetch failed/);
      return true;
    });
  });

  test("no published release: its own reason and message, not a connection problem", async () => {
    const error = "GitHub: x returned HTTP 404; npm: y returned HTTP 404";
    const { c } = ctx({ check: true }, true);
    const { d } = deps({ errorKind: "no_release", error });
    await assert.rejects(runUpdate(c, d), (e: { reason: string; message: string; next: string[]; data: Record<string, unknown> }) => {
      assert.equal(e.reason, "no_release");
      assert.match(e.message, /No coding\.sh release has been published yet/);
      assert.doesNotMatch(e.message, /Couldn't check/);
      assert.ok(!e.next.some((n) => /connection/i.test(n)), "does not blame the network");
      assert.equal(e.data.current, "0.1.0");
      return true;
    });
  });

  test("npm failure is exit 1 with the manual command; a missing npm is named", async () => {
    const { c } = ctx();
    const { d } = deps(available, () => ({ code: 243, output: "npm ERR! code EACCES\nnpm ERR! permission denied" }));
    await assert.rejects(runUpdate(c, d), (e: { reason: string; message: string; next: string[] }) => {
      assert.equal(e.reason, "install_failed");
      assert.match(e.message, /exit 243.*EACCES/);
      assert.ok(e.next.some((n) => n.includes(TGZ)));
      return true;
    });
    const { c: c2 } = ctx();
    const { d: d2 } = deps(available, () => {
      throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
    });
    await assert.rejects(runUpdate(c2, d2), (e: { reason: string }) => e.reason === "npm_not_found");
  });

  test("Ctrl-C during install exits 130", async () => {
    const ac = new AbortController();
    const { c } = ctx({}, false, ac.signal);
    const { d } = deps(available, () => {
      ac.abort();
      return { code: 130, output: "" };
    });
    assert.equal(await runUpdate(c, d), 130);
  });
});
