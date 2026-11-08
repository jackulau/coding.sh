// A temp store and git repo for `coding.sh improve`: CLAUDE.md gains a line
// (commit "CLAUDE.md: run the tests"), with six synthetic sessions recorded at
// the HEAD before it and six after. Made up from scratch: no real sessions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { putSession, sessionEvents } from "./helpers-decision.ts";

export interface World {
  repo: string;
  env: NodeJS.ProcessEnv;
  commits: Record<string, string>;
}

/** Before the CLAUDE.md change, 4 of 6 sessions edit without a check (or, with `beforeTested`, all 6 run the tests); after it, `afterFlagged` of 6 skip the check. With `elsewhere`, every session ran in another checkout of the repo (`<name>/other`). */
export async function improveWorld(root: string, name: string, o: { afterFlagged: number; beforeTested?: boolean; elsewhere?: boolean }): Promise<World> {
  const elsewhere = o.elsewhere === true;
  const home = join(root, name, "home");
  const repo = join(root, name, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig-none"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const commits: Record<string, string> = {};
  const git = (args: string[], date?: string) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env: { ...env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const now = Date.now();
  const day = (d: number) => new Date(now - d * 86_400_000).toISOString();
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
  writeFileSync(join(repo, "CLAUDE.md"), "Keep answers short.\n");
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"], day(12));
  commits.init = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "CLAUDE.md"), "Keep answers short.\nRun `npm test` before you say you are done.\n");
  git(["commit", "-qam", "CLAUDE.md: run the tests"], day(6));
  commits.rule = git(["rev-parse", "HEAD"]);
  if (elsewhere) git(["worktree", "add", "-q", "--detach", join(root, name, "other")]);

  const { openContext } = await import("../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    // Flags come from the events (ingest recomputes them): an edit with no check is no-verification.
    const at = elsewhere ? join(root, name, "other") : repo;
    const put = (id: string, head: string, daysAgo: number, o: { edit: boolean; test: boolean }) => {
      const steps: Parameters<typeof sessionEvents>[2] = [["user.message", { text: `Task ${id}` }]];
      if (o.edit) steps.push(["tool.start", { tool: "Edit", toolUseId: `${id}-e`, input: { file_path: join(at, "index.js") } }], ["tool.end", { tool: "Edit", toolUseId: `${id}-e`, ok: true }], ["file.change", { path: "index.js", op: "modify" }]);
      if (o.test) steps.push(["tool.start", { tool: "Bash", toolUseId: `${id}-t`, input: { command: "npm test" } }], ["tool.end", { tool: "Bash", toolUseId: `${id}-t`, ok: true, output: "ok" }]);
      steps.push(["assistant.message", { text: "Done." }]);
      const ev = sessionEvents(id, { cwd: at, startedAt: now - daysAgo * 86_400_000 }, steps).map((e) => ({ ...e, repo: { root: at, head } }));
      return putSession(ctx.index, ev);
    };
    for (let k = 0; k < 6; k++) await put(`before-${k}`, commits.init, 11 - k * 0.5, o.beforeTested ? { edit: true, test: true } : { edit: k < 4, test: false });
    for (let k = 0; k < 6; k++) await put(`after-${k}`, commits.rule, 5 - k * 0.5, { edit: true, test: k >= o.afterFlagged });
  } finally {
    await ctx.close();
  }
  return { repo, env, commits };
}

