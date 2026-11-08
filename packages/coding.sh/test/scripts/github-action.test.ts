// The report step of the GitHub Action (scripts/github-action.mjs, run by
// action.yml): the step summary, the fallback to the command's output, and the
// pull request comment that a second run edits instead of posting again. GitHub's
// API is a local server.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SCRIPT = fileURLToPath(new URL("../../scripts/github-action.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const run = promisify(execFile);

interface Call {
  method: string;
  url: string;
  auth: string;
  body?: { body: string };
}
let calls: Call[] = [];
let comments: { id: number; body: string }[] = [];
let status = 200;
let server: Server;
let api = "";
let dir = "";

const readBody = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let s = "";
    req.on("data", (d) => (s += d)).on("end", () => res(s));
  });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "csh-action-"));
  server = createServer(async (req, res) => {
    const text = await readBody(req);
    const body = text ? (JSON.parse(text) as { body: string }) : undefined;
    calls.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization), ...(body ? { body } : {}) });
    res.setHeader("content-type", "application/json");
    if (status !== 200) {
      res.statusCode = status;
      return res.end(JSON.stringify({ message: "Resource not accessible by integration" }));
    }
    if (req.method === "GET") return res.end(JSON.stringify([{ id: 1, body: "unrelated" }, ...comments]));
    if (req.method === "POST") {
      const c = { id: 100 + comments.length, body: body!.body };
      comments.push(c);
      return res.end(JSON.stringify(c));
    }
    const id = Number(req.url!.split("/").pop());
    const c = comments.find((x) => x.id === id)!;
    c.body = body!.body;
    res.end(JSON.stringify(c));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  api = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  status = 200;
});

function env(over: Record<string, string>): NodeJS.ProcessEnv {
  const event = join(dir, "event.json");
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
  return {
    PATH: process.env.PATH,
    GITHUB_API_URL: api,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_RUN_ID: "42",
    GITHUB_WORKFLOW: "evals",
    GITHUB_JOB: "evals",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: event,
    CODING_SH_COMMENT: "true",
    CODING_SH_GITHUB_TOKEN: "t0ken",
    ...over,
  };
}

const report = (e: NodeJS.ProcessEnv) => run(process.execPath, [SCRIPT], { env: e });

describe("github-action report", () => {
  it("appends the eval run Markdown to the step summary and posts it once, then edits that comment", async () => {
    const stepSummary = join(dir, "step1.md");
    writeFileSync(stepSummary, "");
    const md = join(dir, "eval.md");
    writeFileSync(md, "### Evals: 1 of 1 suite failed\n\n| Suite |\n");
    const reportFile = join(dir, "report.md");
    const e = env({ GITHUB_STEP_SUMMARY: stepSummary, CODING_SH_COMMAND: "eval run triage --yes", CODING_SH_EXIT: "1", CODING_SH_SUMMARY_FILE: md, CODING_SH_LOG_FILE: join(dir, "missing.log"), CODING_SH_REPORT_FILE: reportFile });

    const first = await report(e);
    assert.match(first.stdout, /created comment 100 on #7/);
    const summary = readFileSync(stepSummary, "utf8");
    assert.equal(readFileSync(reportFile, "utf8"), summary, "the report output holds what the step summary got");
    assert.match(summary, /^### Evals: 1 of 1 suite failed\n/);
    assert.match(summary, /<sub>`coding\.sh eval run triage --yes` exited 1 · \[workflow run\]\(https:\/\/github\.com\/acme\/app\/actions\/runs\/42\)<\/sub>/);
    assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
    assert.equal(calls[1]!.url, "/repos/acme/app/issues/7/comments");
    assert.equal(calls[1]!.auth, "Bearer t0ken");
    assert.match(comments[0]!.body, /^<!-- coding\.sh-action [0-9a-f]{16} -->\n### Evals/);

    calls = [];
    writeFileSync(md, "### Evals: the suite passed\n");
    const second = await report({ ...e, CODING_SH_EXIT: "0" });
    assert.match(second.stdout, /updated comment 100 on #7/);
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [["GET", "/repos/acme/app/issues/7/comments?per_page=100&page=1"], ["PATCH", "/repos/acme/app/issues/comments/100"]]);
    assert.equal(comments.length, 1, "the second run edits the first comment");
    assert.match(comments[0]!.body, /### Evals: the suite passed/);

    calls = [];
    await report({ ...e, CODING_SH_COMMAND: "eval run other --yes" });
    assert.equal(comments.length, 2, "another command in the same job gets its own comment");
  });

  it("reports another command by the tail of its output, in a fence longer than any backticks in it", async () => {
    const stepSummary = join(dir, "step2.md");
    const log = join(dir, "out.log");
    writeFileSync(log, "\u001b[31mgate    hold\u001b[0m\nsee ```code```\n");
    await report(env({ GITHUB_STEP_SUMMARY: stepSummary, GITHUB_EVENT_NAME: "push", CODING_SH_COMMAND: "exp compare base head --gate", CODING_SH_EXIT: "1", CODING_SH_LOG_FILE: log }));
    const text = readFileSync(stepSummary, "utf8");
    assert.match(text, /^### `coding\.sh exp compare base head --gate` failed \(exit 1\)\n\n````text\ngate    hold\nsee ```code```\n````\n/);
    assert.deepEqual(calls, [], "no comment outside a pull request");
  });

  it("warns and exits 0 when the token can't comment", async () => {
    status = 403;
    const r = await report(env({ CODING_SH_COMMAND: "eval run --yes", CODING_SH_EXIT: "0", CODING_SH_LOG_FILE: join(dir, "missing.log") }));
    assert.match(r.stdout, /::warning title=coding\.sh::Couldn't post the report on #7 \(GET .* HTTP 403/);
    assert.match(r.stdout, /pull-requests: write/);
  });

  it("does not comment when comment is off", async () => {
    await report(env({ CODING_SH_COMMENT: "false", CODING_SH_COMMAND: "eval run --yes", CODING_SH_EXIT: "0" }));
    assert.deepEqual(calls, []);
  });
});

describe("action.yml", () => {
  /** The body of the step with `id: <id>`, as the runner would write it to a script. */
  function stepScript(id: string): string {
    const yml = readFileSync(join(REPO_ROOT, "action.yml"), "utf8");
    const step = yml.split(/\n(?= {4}- )/).find((s) => new RegExp(`\\n {6}id: ${id}\\n`).test(s))!;
    const body = step.split("\n      run: |\n")[1]!;
    return body.split("\n").map((l) => l.replace(/^ {8}/, "")).join("\n");
  }

  it("records the command's exit code under bash -e -o pipefail, and adds --summary to eval run only", async (t) => {
    if (process.platform === "win32") return t.skip("needs a POSIX bash");
    const bin = join(dir, "bin");
    const { mkdirSync, chmodSync } = await import("node:fs");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "coding.sh"), '#!/bin/sh\nfor a in "$@"; do echo "arg=$a"; done\nexit 3\n');
    chmodSync(join(bin, "coding.sh"), 0o755);
    const script = join(dir, "run-step.sh");
    writeFileSync(script, stepScript("run"));
    const step = async (command: string) => {
      const out = join(dir, `out-${Math.random()}`);
      writeFileSync(out, "");
      // GitHub runs a `shell: bash` step as `bash --noprofile --norc -e -o pipefail {0}`.
      const r = await run("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], {
        env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: out, COMMAND: command },
      });
      return { stdout: r.stdout, outputs: Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2))) as Record<string, string> };
    };
    const e = await step(`eval run 'my suite' --yes`);
    assert.equal(e.outputs["exit-code"], "3");
    assert.match(e.stdout, /^arg=eval\narg=run\narg=my suite\narg=--yes\narg=--summary\narg=.*\.md\n$/);
    assert.equal(readFileSync(e.outputs.log!, "utf8"), e.stdout, "the output is kept for the report");
    assert.match(e.outputs.report!, /\.report\.md$/);
    const x = await step("exp compare a b --gate");
    assert.equal(x.outputs["exit-code"], "3");
    assert.doesNotMatch(x.stdout, /--summary/);
  });

  it("runs files that exist in the repo", () => {
    const yml = readFileSync(join(REPO_ROOT, "action.yml"), "utf8");
    for (const m of yml.matchAll(/\$GITHUB_ACTION_PATH\/([\w./-]+)/g)) assert.ok(existsSync(join(REPO_ROOT, m[1]!)), m[1]);
    assert.match(yml, /packages\/coding\.sh\/scripts\/github-action\.mjs/);
    assert.match(yml, /\/install\.sh/);
  });
});
