// §15.1: the CLI shim records one classified TapRecord per call, passes I/O
// through unchanged, and its durationMs excludes shim startup.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { posixShell, spawn, spawnSync } from "../../src/core/spawn.ts";
import { classifyCli, DEFAULT_USAGE_PATTERNS, writeCliShim } from "../../src/toolevals/tap/cli.ts";
import type { TapRecord } from "../../src/toolevals/types.ts";
import { pathOf } from "../_bin.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE = join(FIX, "fake-cli.mjs");
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "csh-shim-")));
  dirs.push(d);
  return d;
};
const cfg = { usageExitCodes: [2], usagePatterns: DEFAULT_USAGE_PATTERNS };
const readTap = (f: string): TapRecord[] =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TapRecord);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

describe("classifyCli", () => {
  it("classifies help, meta, invalid, failed and ok", () => {
    assert.equal(classifyCli(["--help"], 0, "", cfg).class, "help");
    assert.equal(classifyCli(["help", "greet"], 0, "", cfg).class, "help");
    assert.equal(classifyCli(["--version"], 0, "", cfg).class, "meta");
    assert.deepEqual(classifyCli(["greet", "--bogus"], 2, "error: unknown option '--bogus'", cfg), { class: "invalid", reason: "unknown-flag" });
    assert.deepEqual(classifyCli(["nope"], 1, "error: unknown command 'nope'", cfg), { class: "invalid", reason: "unknown-command" });
    assert.deepEqual(classifyCli(["x"], 127, "", cfg), { class: "invalid", reason: "not-found" });
    assert.deepEqual(classifyCli(["fail"], 1, "something broke", cfg), { class: "failed", reason: "exit-1" });
    assert.deepEqual(classifyCli(["fail"], null, "", cfg), { class: "failed", reason: "signal" });
    assert.deepEqual(classifyCli(["greet"], 0, "", cfg), { class: "ok" });
  });
});

describe("CLI shim", () => {
  it("records 4 scripted calls with the right classes and passes output through", async () => {
    const d = tmp();
    const bin = join(d, "bin");
    const tapLog = join(d, "tap.jsonl");
    writeFileSync(tapLog, "");
    await writeCliShim(bin, "fake-cli", { command: [process.execPath, FAKE], env: {}, tapLog, ...cfg });
    // A scripted "agent": four calls through PATH (Git Bash on Windows runs the extensionless shim).
    const script = "fake-cli --help >/dev/null; fake-cli greet --name ada; fake-cli greet --bogus; fake-cli fail; true";
    const r = spawnSync(posixShell()!, ["-c", script], { env: { ...process.env, PATH: pathOf(bin, process.env.PATH) }, cwd: d });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /hello ada/);
    assert.match(r.stderr, /unknown option '--bogus'/);
    assert.match(r.stderr, /something broke/);
    const tap = readTap(tapLog);
    assert.equal(tap.length, 4);
    assert.deepEqual(
      tap.map((t) => t.class),
      ["help", "ok", "invalid", "failed"],
    );
    assert.equal(tap[2]!.reason, "unknown-flag");
    assert.equal(tap[2]!.exitCode, 2);
    assert.deepEqual(tap[1]!.argv, ["greet", "--name", "ada"]);
    assert.equal(tap[1]!.stdoutBytes, Buffer.byteLength("hello ada\n"));
    assert.ok(tap.every((t) => t.target === "cli" && typeof t.durationMs === "number"));
  });

  it("without a tap log passes through and records nothing", async () => {
    const d = tmp();
    await writeCliShim(join(d, "checkbin"), "fake-cli", { command: [process.execPath, FAKE], env: {}, ...cfg });
    const r = spawnSync(join(d, "checkbin", "fake-cli"), ["sum", "2", "3"]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "5\n");
  });

  it("resolves a bare command on PATH without re-entering itself", async () => {
    const d = tmp();
    const real = join(d, "real");
    await writeCliShim(real, "fake-cli", { command: [process.execPath, FAKE], env: {}, ...cfg }); // stands in for the installed binary
    const bin = join(d, "bin");
    const tapLog = join(d, "tap.jsonl");
    writeFileSync(tapLog, "");
    await writeCliShim(bin, "fake-cli", { command: ["fake-cli"], env: {}, tapLog, ...cfg });
    const r = spawnSync("fake-cli", ["greet"], { env: { ...process.env, PATH: pathOf(bin, real, dirname(process.execPath)) }, timeout: 10_000 });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "hello world\n");
    assert.equal(readTap(tapLog).length, 1);
  });

  it("exits 127 once, without re-entering itself or another shim, when the bare command is on PATH only as shims", async () => {
    const d = tmp();
    const tapLog = join(d, "tap.jsonl");
    writeFileSync(tapLog, "");
    // Two trials' shims for the same bare command, and no real binary anywhere on PATH.
    await writeCliShim(join(d, "trial1"), "fake-cli", { command: ["fake-cli", "greet"], env: {}, tapLog, ...cfg });
    await writeCliShim(join(d, "trial2"), "fake-cli", { command: ["fake-cli", "greet"], env: {}, tapLog, ...cfg });
    const r = spawnSync("fake-cli", [], { env: { ...process.env, PATH: pathOf(join(d, "trial1"), join(d, "trial2"), dirname(process.execPath)) }, timeout: 10_000 });
    assert.equal(r.status, 127, `stderr: ${r.stderr}`);
    assert.match(String(r.stderr), /fake-cli: target command not found on PATH/);
    // trial1 runs trial2's shim once (it is on PATH), which skips both dirs and stops: one record each, no loop.
    const tap = readTap(tapLog);
    assert.equal(tap.length, 2, "each shim runs once, not a chain of shims");
    assert.deepEqual(tap.map((t) => t.reason), ["not-found", "not-found"]);
  });

  it("durationMs excludes shim startup: matches a direct spawn, not the wall time through the shim (median of 20)", async () => {
    const d = tmp();
    const bin = join(d, "bin");
    const tapLog = join(d, "tap.jsonl");
    const shim = await writeCliShim(bin, "fake-cli", { command: [process.execPath, FAKE], env: {}, tapLog, ...cfg });
    const runOnce = (file: string, args: string[]) =>
      new Promise<number>((resolve, reject) => {
        const t0 = performance.now();
        const c = spawn(file, args, { stdio: "ignore" });
        c.on("error", reject);
        c.on("exit", () => resolve(performance.now() - t0));
      });
    // One round is 20 interleaved pairs. The full suite runs test files in
    // parallel, so a round that lands on a CPU spike is retried (at most 3).
    //
    // The tolerance scales with load. The shim's own overhead (wall time
    // through the shim minus a direct spawn, both measured here) is what a
    // regression would add to durationMs, and load stretches it and the noise
    // alike. So the recorded median must sit within a quarter of that
    // overhead of the direct median (5 ms floor on an idle machine): a shim
    // that counted its own startup would land near the wall time instead.
    let last = "";
    for (let round = 0; round < 3; round++) {
      writeFileSync(tapLog, "");
      const direct: number[] = [];
      const shimWall: number[] = [];
      for (let i = 0; i < 20; i++) {
        direct.push(await runOnce(process.execPath, [FAKE, "greet"]));
        shimWall.push(await runOnce(shim, ["greet"]));
      }
      const recorded = readTap(tapLog).map((t) => t.durationMs);
      assert.equal(recorded.length, 20);
      const dm = median(direct);
      const rm = median(recorded);
      const wm = median(shimWall);
      // The shim's own startup is real: the wall time through the shim is longer.
      assert.ok(wm > rm);
      const overhead = wm - dm;
      const tolerance = Math.max(5, overhead / 4);
      if (Math.abs(rm - dm) <= tolerance) return;
      last = `shim-recorded median ${rm.toFixed(2)} ms vs direct ${dm.toFixed(2)} ms (tolerance ${tolerance.toFixed(2)} ms; shim wall ${wm.toFixed(2)} ms)`;
    }
    assert.fail(last);
  });
});
