// Printed commands run in the user's shell: in PowerShell or cmd on Windows (no MSYSTEM or
// SHELL), a next step or an error's next line that starts with `coding.sh` names `codingsh`,
// the bin npm installs for every Windows shell. Lines cliCommand built stay as they are.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";
import { UsageError } from "../../src/cli/args.ts";
import * as improve from "../../src/cli/commands/improve.ts";
import * as status from "../../src/cli/commands/status.ts";
import * as work from "../../src/cli/commands/work.ts";
import { cliCommand } from "../../src/cli/next-steps.ts";
import { CliError, Output } from "../../src/cli/output.ts";
import { paths } from "../../src/core/paths.ts";
import { workItemId } from "../../src/core/work.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

function capture(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, json = false) {
  const res = { stdout: "", stderr: "" };
  const out = new Output({
    json,
    env,
    platform,
    stdout: { write: (s: string) => ((res.stdout += s), true), isTTY: false },
    stderr: { write: (s: string) => ((res.stderr += s), true), isTTY: false },
    stdin: { isTTY: false },
  });
  return { out, res };
}

describe("Output names the CLI for the user's shell", () => {
  it("in PowerShell or cmd, a next line `coding.sh doctor` prints as `codingsh doctor`", () => {
    const { out, res } = capture("win32", {});
    out.next("Check capture", "coding.sh doctor");
    assert.match(res.stderr, /\n {4}codingsh doctor\n/);
    assert.doesNotMatch(res.stderr, /coding\.sh doctor/);
  });

  it("a CliError's next lines, in text and --json", () => {
    const err = () => new CliError("Something broke", { reason: "x", next: ["Check capture:", "coding.sh doctor"] });
    const text = capture("win32", {});
    text.out.error(err());
    assert.match(text.res.stderr, /\n {4}codingsh doctor\n/);
    const json = capture("win32", {}, true);
    json.out.error(err());
    assert.deepEqual(JSON.parse(json.res.stderr).next, ["Check capture:", "codingsh doctor"]);
  });

  it("Git Bash (MSYSTEM), Linux and macOS keep coding.sh; under npx it is the npx form", () => {
    for (const [platform, env] of [["win32", { MSYSTEM: "MINGW64" }], ["win32", { SHELL: "/usr/bin/bash" }], ["linux", {}], ["darwin", {}]] as const) {
      const { out, res } = capture(platform, env);
      out.next("Check capture", "coding.sh doctor");
      assert.match(res.stderr, /\n {4}coding\.sh doctor\n/, `${platform} ${JSON.stringify(env)}`);
    }
    const npx = capture("linux", { npm_command: "exec" });
    npx.out.next("Check capture", "coding.sh doctor");
    assert.match(npx.res.stderr, /\n {4}npx coding\.sh doctor\n/);
  });

  it("a line cliCommand built, a label and prose stay as they are", () => {
    const { out } = capture("win32", {});
    const built = cliCommand({}, ["show", "a b"], "win32");
    assert.equal(out.command(built), built);
    assert.equal(out.command("Run coding.sh doctor."), "Run coding.sh doctor.");
    assert.equal(out.command("coding.sh 0.2.0 or newer:"), "coding.sh 0.2.0 or newer:");
    assert.equal(out.command("coding.sh.config"), "coding.sh.config");
  });
});

describe("status and improve name codingsh in PowerShell", () => {
  let sb: Sandbox;
  before(() => {
    sb = sandbox();
  });
  after(() => sb.cleanup());

  it("status's ingest-stopped hint names the update command for this shell, in text and --json", async () => {
    // As the hook's background ingest leaves it, in the agent's environment: canonical `coding.sh update`.
    const file = paths(sb.env).ingestStopped;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ since: Date.now() - 1000, at: Date.now(), reason: "store_newer", why: "a newer coding.sh migrated the store", next: "coding.sh update", version: "0.0.1", failures: 1 }) + "\n");
    const r = await runCmd(status, sb, { platform: "win32" });
    assert.match(r.stdout + r.stderr, /Ingest\s+stopped .*; run codingsh update/);
    const j = await runCmd(status, sb, { platform: "win32", json: true });
    assert.equal(j.json.ingestStopped.next, "codingsh update");
    const linux = await runCmd(status, sb, { platform: "linux" });
    assert.match(linux.stdout + linux.stderr, /; run coding\.sh update/);
  });

  it("improve's next step names codingsh", async () => {
    const r = await runCmd(improve, sb, { platform: "win32" });
    assert.equal(r.error, undefined, String(r.error));
    assert.match(r.stderr, /\n {4}codingsh (init|doctor|improve)/, r.stderr);
    assert.doesNotMatch(r.stderr, /\n {4}coding\.sh /);
  });
});

describe("work names codingsh in each item's next step in PowerShell", () => {
  let sb: Sandbox;
  const id = workItemId("broke");
  before(async () => {
    sb = sandbox();
    // Ended on failing tests with a file changed: failed first, and ready for review once the failure is acked.
    const at = Date.now() - 30 * 60e3;
    await sb.seed([mkSession("broke", at, { cwd: "/work/demo", title: "fix the parser", endedAt: at + 10 * 60e3, stats: { testsFailed: 2, filesChanged: 1 } })]);
  });
  after(() => sb.cleanup());

  it("in the list and work show, in text and --json; the agent's own resume command stays", async () => {
    const list = await runCmd(work, sb, { platform: "win32", json: true });
    assert.equal(list.error, undefined, list.error?.stack);
    const next = list.json.items[0].next as string;
    assert.match(next, /^`codingsh show [^`]+`, then `claude --resume broke`$/);
    const text = await runCmd(work, sb, { platform: "win32" });
    assert.ok(text.stdout.includes(`next: ${next}`), text.stdout);
    const show = await runCmd(work, sb, { platform: "win32", action: "show", positionals: [id], json: true });
    assert.equal(show.json.next, next);
    const shown = await runCmd(work, sb, { platform: "win32", action: "show", positionals: [id] });
    assert.match(shown.stdout, /\n {2}Next +`codingsh show /);
    const linux = await runCmd(work, sb, { platform: "linux", json: true });
    assert.equal(linux.json.items[0].next, next.replace("`codingsh ", "`coding.sh "));
  });

  it("in what work ack --json says the item shows now, and in a missing argument's usage", async () => {
    const usage = await runCmd(work, sb, { platform: "win32", action: "show" });
    assert.ok(usage.error instanceof UsageError, String(usage.error));
    assert.equal(usage.error.message, "Missing argument <ID>. Usage: codingsh work show <id>");
    const a = await runCmd(work, sb, { platform: "win32", action: "ack", positionals: [id], json: true });
    assert.equal(a.error, undefined, a.error?.stack);
    assert.equal(a.json.bucket, "failed");
    assert.equal(a.json.now.bucket, "review");
    assert.ok(a.json.now.next.includes(`\`codingsh work ack ${id}\``), a.json.now.next);
    assert.doesNotMatch(a.json.now.next, /`coding\.sh /);
  });
});
