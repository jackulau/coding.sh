#!/usr/bin/env node
// The report step of the coding.sh GitHub Action (action.yml at the repo root).
// After `coding.sh <command>` ran, it builds one Markdown report, appends it to
// the step summary and, on a pull request, posts it as a comment or edits the
// comment an earlier run of the same job and command posted.
//
// The report is the Markdown that `eval run --summary` wrote, or else the tail of
// the command's output in a code block. A comment that can't be posted (no
// `pull-requests: write`, a fork's read-only token) is a warning: this step never
// fails the job; the action's last step does that from the command's exit code.
//
// Env (set by action.yml):
//   CODING_SH_COMMAND       the coding.sh arguments, as written in the workflow
//   CODING_SH_EXIT          the command's exit code
//   CODING_SH_SUMMARY_FILE  Markdown from --summary (may be empty or missing)
//   CODING_SH_LOG_FILE      the command's output
//   CODING_SH_REPORT_FILE   where to write the report (the action's `report` output)
//   CODING_SH_COMMENT       "true" to comment on pull requests
//   CODING_SH_GITHUB_TOKEN  token for the comment
// plus GitHub's own: GITHUB_STEP_SUMMARY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH,
// GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_SERVER_URL, GITHUB_RUN_ID,
// GITHUB_WORKFLOW, GITHUB_JOB.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** GitHub rejects comment bodies over 65,536 characters. */
const COMMENT_MAX = 60_000;
const LOG_LINES = 200;
const LOG_CHARS = 20_000;

const read = (file) => {
  try {
    return file ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
};

/** A code fence longer than any run of backticks in the text. */
function fenced(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** The last lines of the command's output, without terminal escapes. */
function tail(log) {
  let t = log.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r(?!\n)/g, "\n").trimEnd();
  const lines = t.split("\n");
  if (lines.length > LOG_LINES) t = `… ${lines.length - LOG_LINES} earlier lines cut\n${lines.slice(-LOG_LINES).join("\n")}`;
  if (t.length > LOG_CHARS) t = `… cut\n${t.slice(-LOG_CHARS)}`;
  return t || "(no output)";
}

/** The report: the command's Markdown summary, or its output in a code block, and a footer naming the command and the run. */
export function reportBody({ command, exitCode, summary, log, runUrl }) {
  const cmd = `coding.sh ${command}`.trim().replace(/`/g, "'");
  const status = exitCode === 0 ? "passed" : `failed (exit ${exitCode})`;
  const main = summary.trim() ? summary.trimEnd() : `### \`${cmd}\` ${status}\n\n${fenced(tail(log))}`;
  const footer = `<sub>\`${cmd}\` exited ${exitCode}${runUrl ? ` · [workflow run](${runUrl})` : ""}</sub>`;
  return `${main}\n\n${footer}\n`;
}

/** The hidden line that finds this job's comment again: one per workflow, job, directory and command. */
export function marker({ workflow, job, command, dir }) {
  const key = createHash("sha256").update([workflow, job, dir, command].join("\n")).digest("hex").slice(0, 16);
  return `<!-- coding.sh-action ${key} -->`;
}

async function gh(api, token, method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "coding.sh-action",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Edit the comment that carries `mark`, or post a new one. */
export async function upsertComment({ api, token, repo, issue, mark, body }) {
  let found;
  for (let page = 1; !found; page++) {
    const list = await gh(api, token, "GET", `/repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`);
    found = list.find((c) => typeof c.body === "string" && c.body.includes(mark));
    if (list.length < 100) break;
  }
  const text = `${mark}\n${body.length > COMMENT_MAX ? `${body.slice(0, COMMENT_MAX)}\n\n… cut; the full report is in the job's step summary.\n` : body}`;
  if (found) {
    await gh(api, token, "PATCH", `/repos/${repo}/issues/comments/${found.id}`, { body: text });
    return { action: "updated", id: found.id };
  }
  const made = await gh(api, token, "POST", `/repos/${repo}/issues/${issue}/comments`, { body: text });
  return { action: "created", id: made.id };
}

/** The pull request this run is for, from the event payload; undefined for pushes and manual runs. */
function pullRequest(env) {
  if (env.GITHUB_EVENT_NAME !== "pull_request" && env.GITHUB_EVENT_NAME !== "pull_request_target") return undefined;
  try {
    const n = JSON.parse(read(env.GITHUB_EVENT_PATH)).pull_request?.number;
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export async function main(env = process.env, log = console.log) {
  const command = env.CODING_SH_COMMAND ?? "";
  const exitCode = Number(env.CODING_SH_EXIT ?? 1);
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const runUrl = env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : "";
  const body = reportBody({ command, exitCode, summary: read(env.CODING_SH_SUMMARY_FILE), log: read(env.CODING_SH_LOG_FILE), runUrl });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, body);
  if (env.CODING_SH_REPORT_FILE) writeFileSync(env.CODING_SH_REPORT_FILE, body);

  const issue = pullRequest(env);
  if (env.CODING_SH_COMMENT !== "true" || issue === undefined) return 0;
  if (!env.CODING_SH_GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    log("::warning title=coding.sh::No GitHub token, so the report was not posted as a pull request comment.");
    return 0;
  }
  try {
    const mark = marker({ workflow: env.GITHUB_WORKFLOW ?? "", job: env.GITHUB_JOB ?? "", command, dir: env.CODING_SH_DIR ?? "." });
    const r = await upsertComment({ api: env.GITHUB_API_URL ?? "https://api.github.com", token: env.CODING_SH_GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, issue, mark, body });
    log(`coding.sh: ${r.action} comment ${r.id} on #${issue}`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    log(`::warning title=coding.sh::Couldn't post the report on #${issue} (${why.replace(/\r?\n/g, " ")}). The job needs "permissions: pull-requests: write"; pull requests from forks get a read-only token.`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
