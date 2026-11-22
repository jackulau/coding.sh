// Hands-on QA, round 9: a --limit past 2^53 is a usage error, config set and the commands that
// open the store blame an unreadable config file (not the value or [store]), serve healthcheck
// takes --port, a too-short session prefix says so, a PR in another repo names that repo, purge
// lists a live recording once, workflows run says what the past runs lacked, and improve names
// codingsh in PowerShell and counts the headless sessions improve check leaves out.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { positiveInt, UsageError } from "../../src/cli/args.ts";
import * as improve from "../../src/cli/commands/improve.ts";
import { liveJobs } from "../../src/cli/commands/purge.ts";
import * as serve from "../../src/cli/commands/serve.ts";
import * as work from "../../src/cli/commands/work.ts";
import { prRef, prsText } from "../../src/cli/commands/work.ts";
import { noEstimateText } from "../../src/cli/commands/workflows.ts";
import { paths } from "../../src/core/paths.ts";
import type { PullRequestRef } from "../../src/schema/index.ts";
import { improveWorld, type World } from "../helpers-improve.ts";
import { CLI } from "../_cli.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));
function box(): Sandbox {
  const sb = sandbox();
  boxes.push(sb);
  return sb;
}
const cli = (sb: Sandbox, args: string[]) => {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: sb.root, env: sb.env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe("--limit past the largest safe integer", () => {
  test("is a usage error naming the range, not a store crash", () => {
    assert.throws(() => positiveInt(1e30, "limit"), (e: unknown) => e instanceof UsageError && /--limit must be an integer from 1 to 9007199254740991, got 1e\+30/.test(e.message));
    assert.equal(positiveInt(Number.MAX_SAFE_INTEGER, "limit"), Number.MAX_SAFE_INTEGER);
  });

  test("sessions --limit 1e30 exits 2", () => {
    const r = cli(box(), ["sessions", "--limit", "1e30"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--limit must be an integer from 1 to/);
  });
});

describe("an unreadable config file", () => {
  const writeConfig = (sb: Sandbox, text: string) => {
    const file = paths(sb.env).config;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };

  test("config set says the file can't be read, with its path, and exits 1; the value is not blamed", () => {
    const sb = box();
    const file = writeConfig(sb, "[capture\nmode = \"full\"\n");
    const r = cli(sb, ["config", "set", "capture.mode", "full"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Can't read config: invalid TOML/);
    assert.ok(r.stderr.includes(file), r.stderr);
    assert.doesNotMatch(r.stderr, /Invalid value for capture\.mode/);
  });

  test("a bad [capture] value opening the store names the config file, not [store]", () => {
    const sb = box();
    const file = writeConfig(sb, "[capture]\nmode = \"bogus\"\n");
    const r = cli(sb, ["sessions"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Can't read config/);
    assert.ok(r.stderr.includes(file), r.stderr);
    assert.doesNotMatch(r.stderr, /\[store\]/);
  });
});

describe("serve healthcheck --port", () => {
  let server: Server;
  let port = 0;
  before(async () => {
    server = createServer((req, res) => {
      res.statusCode = req.url === "/healthz" ? 200 : 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  test("probes the default URL on that port", async () => {
    const r = await runCmd(serve, box(), { action: "healthcheck", flags: { port }, json: true });
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual([r.json.ok, r.json.url], [true, `http://127.0.0.1:${port}/healthz`]);
  });

  test("the CLI takes --port and --help names it", async () => {
    const sb = box();
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
      // Not spawnSync: the server this test probes runs in this process.
      const p = spawn(process.execPath, ["--no-warnings", CLI, "serve", "healthcheck", "--port", String(port), "--json"], { cwd: sb.root, env: sb.env });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => res({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).url, `http://127.0.0.1:${port}/healthz`);
    assert.match(cli(sb, ["serve", "healthcheck", "--help"]).stdout, /--port <PORT>/);
  });

  test("a port out of range is a usage error", async () => {
    const r = await runCmd(serve, box(), { action: "healthcheck", flags: { port: 70000 } });
    assert.ok(r.error instanceof UsageError, String(r.error));
    assert.match(r.error.message, /--port must be 1-65535, got 70000/);
  });
});

describe("work show with a short session prefix", () => {
  test("says a prefix needs at least 4 characters", async () => {
    const r = await runCmd(work, box(), { action: "show", positionals: ["abc"] });
    assert.ok(r.error, "an error");
    assert.match(r.error.message, /an id prefix needs at least 4 characters/);
  });
});

describe("a work item's pull requests", () => {
  const pr = (number: number, repo?: string): PullRequestRef => {
    const p: PullRequestRef = { number, state: "opened", at: 0 };
    if (repo) p.repo = repo;
    return p;
  };

  test("a PR in the item's own repo is #N; one in another repo names that repo", () => {
    const own = pr(12, "acme/demo");
    const other = pr(7, "acme/site");
    assert.equal(prRef(own, [own, other], "/work/demo"), "#12");
    assert.equal(prRef(other, [own, other], "/work/demo"), "acme/site#7");
    assert.equal(prsText([own, other], "/work/demo"), "PRs #12, acme/site#7 open");
  });

  test("with no folder, one repo stays #N and several name theirs", () => {
    assert.equal(prRef(pr(3, "acme/demo"), [pr(3, "acme/demo"), pr(4, "acme/demo")]), "#3");
    assert.equal(prRef(pr(3, "acme/demo"), [pr(3, "acme/demo"), pr(4, "acme/site")]), "acme/demo#3");
    assert.equal(prRef(pr(5), [pr(5)], "/work/demo"), "#5");
  });

  test("a clone in a folder of another name keeps #N for the PRs it opened; PRs it only linked name their repo", () => {
    assert.equal(prRef(pr(12, "acme/widgets"), [pr(12, "acme/widgets")], "/work/demo"), "#12");
    const linked = (number: number, repo: string): PullRequestRef => ({ ...pr(number, repo), state: "linked" });
    assert.equal(prRef(linked(63, "other/tool"), [linked(63, "other/tool")], "/work/demo"), "other/tool#63");
    const read = [linked(1, "a/x"), linked(2, "b/y"), linked(3, "b/y")];
    assert.equal(prsText(read, "/work/demo"), "PRs a/x#1, b/y#2, b/y#3 linked");
  });
});

describe("purge's live recordings", () => {
  test("one line per experiment and process, however many locks it holds", () => {
    const live = [
      { experiment: "exp-a", pid: 10 },
      { experiment: "exp-a", pid: 10 },
      { experiment: "exp-a", pid: 11 },
      { experiment: "exp-b", pid: 10 },
    ];
    assert.deepEqual(liveJobs(live), [live[0], live[2], live[3]]);
  });
});

describe("workflows run with no cost to estimate from", () => {
  test("says whether past runs exist, rather than 'no past runs' when there are some", () => {
    assert.equal(noEstimateText(2, "nightly", 0), "2 runs; no past runs of nightly to estimate cost from");
    assert.equal(noEstimateText(1, "nightly", 3), "1 run; 3 past runs of nightly recorded no cost to estimate from");
    assert.equal(noEstimateText(1, "nightly", 50), "1 run; 50 or more past runs of nightly recorded no cost to estimate from");
  });
});

describe("improve", () => {
  let root = "";
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-qa-r9-improve-")));
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  const asBox = (w: World): Sandbox => ({ root, env: w.env, seed: async () => {}, cleanup: () => {} });

  test("in PowerShell every command it prints, --json included, names codingsh", async () => {
    const w = await improveWorld(root, "pwsh", { afterFlagged: 2 });
    const sb = asBox(w);
    const text = await runCmd(improve, sb, { cwd: w.repo, platform: "win32", flags: { limit: 1, since: "14d" } });
    assert.equal(text.error, undefined, String(text.error));
    const all = text.stdout + text.stderr;
    assert.match(all, /codingsh improve fix 1/);
    assert.match(all, /Turn these sessions into an eval you can rerun: codingsh eval init --sessions/);
    assert.doesNotMatch(all, /(^|[\s(:])coding\.sh (show|improve|exp|eval|search|usage|sessions|refine)\b/m, all);
    const j = await runCmd(improve, sb, { cwd: w.repo, platform: "win32", json: true });
    assert.equal(j.error, undefined, String(j.error));
    const commands = (j.json.issues as { next: { command: string }[] }[]).flatMap((i) => i.next.map((s) => s.command));
    assert.ok(commands.length > 0);
    for (const c of commands) assert.match(c, /^codingsh /, c);
    // In sh the same commands keep coding.sh.
    const sh = await runCmd(improve, sb, { cwd: w.repo, platform: "linux", json: true });
    assert.match(sh.json.issues[0].next[0].command, /^coding\.sh /);
  });

  test("improve check counts the headless sessions it leaves out and names --headless", async () => {
    const w = await improveWorld(root, "headless-check", { afterFlagged: 0, plan: { before: [{}, {}, {}], after: [{ headless: true }, { headless: true }, { headless: true }] } });
    const sb = asBox(w);
    const j = await runCmd(improve, sb, { action: "check", cwd: w.repo, json: true });
    assert.equal(j.error, undefined, String(j.error));
    assert.equal(j.json.headlessLeftOut, 3);
    const text = await runCmd(improve, sb, { action: "check", cwd: w.repo, platform: "linux" });
    assert.match(text.stderr, /3 headless sessions left out \(--headless\)/);
    assert.match(text.stderr, /Count the headless sessions too:\n\s+coding\.sh improve check --headless/);
    const wide = await runCmd(improve, sb, { action: "check", cwd: w.repo, json: true, flags: { headless: true } });
    assert.equal(wide.json.headlessLeftOut, undefined);
  });
});
