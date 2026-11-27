import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { agentTraceRecords, commitRecord } from "../../src/attribution/export.ts";
import { readCommits } from "../../src/attribution/git.ts";
import type { CommitAttribution } from "../../src/attribution/match.ts";
import { MAX_DATE_MS } from "../../src/core/dates.ts";

const root = mkdtempSync(join(tmpdir(), "csh-attr-range-"));
after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-01T10:00:00Z");
const commit = (sha: string, committedAt: number): CommitAttribution => ({
  commit: sha,
  parents: [],
  committedAt,
  authoredAt: committedAt,
  author: "dev",
  subject: `commit ${sha}`,
  added: 1,
  attributed: 1,
  attributions: [
    {
      commit: sha,
      path: "a.ts",
      ranges: [{ start: 1, end: 1, contentHash: "abc" }],
      lines: 1,
      sessionId: "s1",
      agent: "claude-code",
      confidence: 0.9,
      method: "line-hash",
      source: "coding.sh",
    },
  ],
});

describe("attribution date range handling", () => {
  it("commitRecord and agentTraceRecords leave out a commit outside the Date range and keep the other commits", () => {
    const far = commit("a".repeat(40), MAX_DATE_MS + 1);
    const ok = commit("b".repeat(40), T0);
    assert.equal(commitRecord(far), undefined);
    const records = agentTraceRecords({ root: "/work/demo", rev: "HEAD", since: T0 - 1000, gitAi: false, sessions: [], considered: 1, commits: [far, ok], sources: 2 });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.vcs?.revision, ok.commit);
    assert.equal(records[0]!.timestamp, "2026-11-01T10:00:00Z");
  });

  it("readCommits omits an out-of-range since filter and still reads commits", async () => {
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "dev@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Dev"]);
    writeFileSync(join(repo, "a.ts"), "export const x = 1;\n");
    execFileSync("git", ["-C", repo, "add", "a.ts"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);

    const commits = await readCommits(repo, { since: -MAX_DATE_MS - 1 });
    assert.equal(commits.length, 1);
    assert.equal(commits[0]!.subject, "init");
  });
});
