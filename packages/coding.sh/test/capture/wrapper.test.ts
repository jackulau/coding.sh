import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { SpoolLine } from "../../src/core/types.ts";
import { wrapRun, wrapRunDetailed } from "../../src/capture/wrapper.ts";
import { resolveRaw } from "../../src/spool/write.ts";
import { PKG_ROOT, isolate, makeRepo, removeTmp, tmp, tsNodeArgs } from "./_helpers.ts";

let home = "";
before(() => {
  home = isolate();
});
after(() => removeTmp());

function lines(agent: string, h = home): SpoolLine[] {
  const dir = join(h, "spool", agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as SpoolLine);
}

/** A fake agent: edits files in cwd, records its env, exits with a chosen code. */
function fakeAgent(): string {
  const p = join(tmp("csh-agent-"), "agent.mjs");
  writeFileSync(
    p,
    `import { writeFileSync, rmSync, appendFileSync } from "node:fs";
writeFileSync("a.txt", "a\\nedited by agent\\n");
writeFileSync("created.txt", "new\\n");
rmSync("b.txt");
writeFileSync("agent-env.json", JSON.stringify({ run: process.env.CODING_SH_RUN_ID ?? null, session: process.env.CODING_SH_SESSION_ID ?? null }));
process.exit(Number(process.argv[2] ?? 0));
`,
  );
  return p;
}

describe("wrapRun", () => {
  test("snapshots before/after and spools session.start, file.change, session.end", async () => {
    const agent = fakeAgent();
    const root = makeRepo({ "a.txt": "a\n", "b.txt": "b\n", ".gitignore": "agent-env.json\n" });
    const r = await wrapRunDetailed({ cmd: process.execPath, args: [agent, "3"], cwd: root, env: { CODING_SH_RUN_ID: "run-42" }, agentId: "aider" });
    assert.equal(r.exitCode, 3);
    assert.ok(r.start?.snapshot && r.end?.snapshot);
    assert.notEqual(r.start.snapshot, r.end.snapshot);
    const env = JSON.parse(readFileSync(join(root, "agent-env.json"), "utf8"));
    assert.equal(env.run, "run-42");
    assert.equal(env.session, r.sessionId);

    const ls = lines("aider");
    assert.deepEqual(ls.map((l) => l.event), ["session.start", "file.change", "file.change", "file.change", "session.end"]);
    assert.equal(ls.every((l) => l.runId === "run-42" && l.cwd === root && l.agent === "aider"), true);
    const raw = ls.map((l) => resolveRaw(l) as Record<string, unknown>);
    assert.equal(raw.every((x) => x.sessionId === r.sessionId), true);
    assert.deepEqual((raw[0]!.repo as { snapshot: string }).snapshot, r.start.snapshot);
    assert.deepEqual(
      raw.slice(1, 4).map((x) => `${x.op} ${x.path} +${x.additions} -${x.deletions}`).sort(),
      ["add created.txt +1 -0", "delete b.txt +0 -1", "modify a.txt +1 -0"],
    );
    const end = raw[4]!;
    assert.equal(end.exitCode, 3);
    assert.equal(typeof end.durationMs, "number");
    assert.equal(end.endSnapshot, r.end.snapshot);
    assert.match(String(end.patch), /\+edited by agent/);
  });

  test("spools secret flag values redacted, and passes them to the agent as given", async () => {
    const h = join(tmp(), "home");
    const dir = tmp("csh-argv-");
    const script = "require('fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(1)))";
    const args = ["-e", script, "--", "--openai-api-key", "plainsecretvalue", "--api-key=hunterhunter", "--model", "gpt-5"];
    const code = await wrapRun({ cmd: process.execPath, args, cwd: dir, env: { CODING_SH_HOME: h }, agentId: "aider" });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")), ["--openai-api-key", "plainsecretvalue", "--api-key=hunterhunter", "--model", "gpt-5"]);
    const start = lines("aider", h).find((l) => l.event === "session.start")!;
    const text = JSON.stringify(start);
    assert.doesNotMatch(text, /plainsecretvalue|hunterhunter/);
    assert.deepEqual((resolveRaw(start) as { args: string[] }).args.slice(2), ["--", "--openai-api-key", "[redacted:secret-flag]", "--api-key=[redacted:secret-flag]", "--model", "gpt-5"]);
  });

  test("works outside a git repo (no repo state, no file changes)", async () => {
    const h = join(tmp(), "home");
    const dir = tmp("csh-norepo-");
    const code = await wrapRun({ cmd: process.execPath, args: ["-e", "process.exit(0)"], cwd: dir, env: { CODING_SH_HOME: h } });
    assert.equal(code, 0);
    const ls = lines("wrapper", h);
    assert.deepEqual(ls.map((l) => l.event), ["session.start", "session.end"]);
    assert.equal((ls[0]!.raw as { repo?: unknown }).repo, undefined);
  });

  test("missing command → 127 and a session.end with the error", async () => {
    const h = join(tmp(), "home");
    const code = await wrapRun({ cmd: "definitely-not-a-real-agent-binary", cwd: tmp(), env: { CODING_SH_HOME: h } });
    assert.equal(code, 127);
    const end = lines("wrapper", h).pop()!;
    assert.equal(end.event, "session.end");
    assert.match(String((end.raw as { error?: string }).error), /ENOENT/);
  });

  test("missing command → the spawn error is returned in the result, not only spooled", async () => {
    const h = join(tmp(), "home");
    const r = await wrapRunDetailed({ cmd: "definitely-not-a-real-agent-binary", cwd: tmp(), env: { CODING_SH_HOME: h } });
    assert.equal(r.exitCode, 127);
    assert.match(String(r.error), /^definitely-not-a-real-agent-binary: .*ENOENT/);
  });

  test("a command that starts has no error in the result", async () => {
    const h = join(tmp(), "home");
    const r = await wrapRunDetailed({ cmd: process.execPath, args: ["-e", "process.exit(3)"], cwd: tmp(), env: { CODING_SH_HOME: h } });
    assert.equal(r.exitCode, 3);
    assert.equal(r.error, undefined);
  });

  test("stdoutToStderr sends the child's stdout to fd 2 and leaves stdout empty", { timeout: 150_000 }, async () => {
    const dir = tmp("csh-stdout-");
    const driver = join(dir, "driver.ts");
    const wrapper = JSON.stringify(join(PKG_ROOT, "src", "capture", "wrapper.ts"));
    const run = (toStderr: boolean) => {
      writeFileSync(
        driver,
        `import { wrapRun } from ${wrapper};
process.exit(await wrapRun({ cmd: process.execPath, args: ["-e", "console.log('child-out'); console.error('child-err')"], cwd: ${JSON.stringify(dir)}, stdoutToStderr: ${toStderr} }));
`,
      );
      const p = spawnSync(process.execPath, [...tsNodeArgs(), driver], { env: { ...process.env, CODING_SH_HOME: join(dir, "home") }, encoding: "utf8", timeout: 60_000 });
      assert.equal(p.status, 0, p.stderr);
      return p;
    };
    const control = run(false);
    assert.equal(control.stdout, "child-out\n");
    const redirected = run(true);
    assert.equal(redirected.stdout, "");
    assert.match(redirected.stderr, /child-out\n/);
    assert.match(redirected.stderr, /child-err\n/);
  });

  test("CODING_SH_DISABLE=1 runs the command without capture", async () => {
    const h = join(tmp(), "home");
    const root = makeRepo({ "a.txt": "a\n", "b.txt": "b\n" });
    const code = await wrapRun({ cmd: process.execPath, args: [fakeAgent(), "0"], cwd: root, env: { CODING_SH_HOME: h, CODING_SH_DISABLE: "1" } });
    assert.equal(code, 0);
    assert.equal(existsSync(h), false);
  });

  test("child killed by a signal → 128 + signo", async () => {
    const h = join(tmp(), "home");
    const code = await wrapRun({ cmd: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGKILL')"], cwd: tmp(), env: { CODING_SH_HOME: h } });
    assert.equal(code, 137);
    assert.equal((lines("wrapper", h).pop()!.raw as { signal?: string }).signal, "SIGKILL");
  });

  test("forwards SIGTERM to the child and returns the child's exit code", { timeout: 150_000 }, async (t) => {
    const dir = tmp("csh-sig-");
    const h = join(dir, "home");
    const ready = join(dir, "ready");
    const child = join(dir, "child.mjs");
    // The child gives up on its own after 2 minutes, a last resort should a kill miss.
    writeFileSync(
      child,
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(join(dir, "got-term"))}, "1"); process.exit(42); });
writeFileSync(${JSON.stringify(ready)}, "1");
setTimeout(() => process.exit(99), 120_000);
`,
    );
    const driver = join(dir, "driver.ts");
    writeFileSync(
      driver,
      `import { wrapRun } from ${JSON.stringify(join(PKG_ROOT, "src", "capture", "wrapper.ts"))};
process.exit(await wrapRun({ cmd: process.execPath, args: [${JSON.stringify(child)}], cwd: ${JSON.stringify(dir)} }));
`,
    );
    // Detached: the driver leads its own process group, and the wrapper's child
    // joins it, so one group kill reaches both even before the child reports in.
    const p = spawn(process.execPath, [...tsNodeArgs(), driver], { env: { ...process.env, CODING_SH_HOME: h }, stdio: ["ignore", "inherit", "inherit"], detached: true });
    const exited = new Promise<number | null>((resolve) => p.on("exit", (c) => resolve(c)));
    // Kill the group on every way out: a failed assertion, a thrown wait, or the
    // test timing out (t.signal). A survivor holding the inherited stdout would
    // keep the test file, and the whole run, alive.
    const killAll = () => {
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {
        // group already gone
      }
    };
    t.signal.addEventListener("abort", killAll, { once: true });
    try {
      // No fixed sleep: wait for the child to report in. Under load the driver's
      // startup and the start snapshot can take far longer than usual.
      while (!existsSync(ready)) {
        if (t.signal.aborted) throw new Error("child never became ready");
        await new Promise((r) => setTimeout(r, 20));
      }
      p.kill("SIGTERM");
      assert.equal(await exited, 42);
      assert.equal(existsSync(join(dir, "got-term")), true);
      const end = lines("wrapper", h).pop()!;
      assert.equal(end.event, "session.end");
      assert.equal((end.raw as { exitCode: number }).exitCode, 42);
    } finally {
      t.signal.removeEventListener("abort", killAll);
      killAll();
    }
  });

  test("a wrapper that dies hard takes its child with it", { timeout: 150_000 }, async (t) => {
    const dir = tmp("csh-hard-");
    const pidFile = join(dir, "pid");
    const driver = join(dir, "driver.ts");
    writeFileSync(
      driver,
      `import { existsSync } from "node:fs";
import { wrapRun } from ${JSON.stringify(join(PKG_ROOT, "src", "capture", "wrapper.ts"))};
void wrapRun({ cmd: "/bin/sh", args: ["-c", "echo $$ > ${pidFile}; exec sleep 120"], cwd: ${JSON.stringify(dir)} });
const t = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(t); setTimeout(() => process.exit(3), 50); } }, 20);
`,
    );
    let pid = 0;
    try {
      const p = spawn(process.execPath, [...tsNodeArgs(), driver], { env: { ...process.env, CODING_SH_HOME: join(dir, "home") }, stdio: "ignore", detached: true });
      const onAbort = () => {
        try {
          process.kill(-p.pid!, "SIGKILL");
        } catch {
          // gone
        }
      };
      t.signal.addEventListener("abort", onAbort, { once: true });
      assert.equal(await new Promise<number | null>((r) => p.on("exit", r)), 3);
      t.signal.removeEventListener("abort", onAbort);
      pid = Number(readFileSync(pidFile, "utf8").trim());
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 20));
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, "child killed when the wrapper exited");
    } finally {
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {
        // gone, as it should be
      }
    }
  });
});
