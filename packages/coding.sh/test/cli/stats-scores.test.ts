// coding.sh stats --measure score:<name>: daily and grouped score trends, --json,
// boolean/categorical handling, negative sparklines, and validation errors.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sparkline } from "../../src/cli/commands/stats.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, session } from "../query/_seed.ts";

const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;
const at = (daysAgo: number) => today - daysAgo * DAY + 3_600_000;
const s = (id: string, daysAgo: number, over: Parameters<typeof session>[1] = {}) =>
  session(id, { startedAt: at(daysAgo), endedAt: at(daysAgo) + 60_000, ...over });

describe("stats --measure score:<name>", () => {
  let env: TmpEnv;

  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, {
      sessions: [
        s("a", 1, { agent: "claude-code", model: "claude-opus-5-5" }),
        s("b", 1, { agent: "codex", model: "gpt-6.1-sol" }),
        s("c", 3, { agent: "claude-code", model: "claude-opus-5-5" }),
      ],
      scores: [
        { id: "h1", target: "session", targetId: "a", sessionId: "a", name: "helpfulness", dataType: "numeric", value: 4, source: "judge", by: "judge", ts: at(1) + 1000 },
        { id: "h2", target: "session", targetId: "b", sessionId: "b", name: "helpfulness", dataType: "numeric", value: 2, source: "judge", by: "judge", ts: at(1) + 2000 },
        { id: "h3", target: "session", targetId: "c", sessionId: "c", name: "helpfulness", dataType: "numeric", value: 5, source: "human", by: "me", ts: at(3) + 1000 },
        { id: "h-cat", target: "session", targetId: "c", sessionId: "c", name: "helpfulness", dataType: "categorical", value: "good", source: "human", by: "other", ts: at(3) + 2000 },
        { id: "o1", target: "session", targetId: "a", sessionId: "a", name: "passed", dataType: "boolean", value: true, source: "code", by: "ci", ts: at(1) + 1000 },
        { id: "o2", target: "session", targetId: "b", sessionId: "b", name: "passed", dataType: "boolean", value: false, source: "code", by: "ci", ts: at(1) + 2000 },
      ],
    });
  });

  after(() => env.restore());

  test("daily table prints SCORE column and summary note", () => {
    const r = ok(["stats", "--since", "7d", "--measure", "score:helpfulness"]);
    const lines = r.stdout.trim().split("\n");
    assert.match(lines[0]!, /SCORE:HELPFULNESS/);
    assert.match(lines.at(-1)!, /^total\s+3\s+.*\s3\.667$/);
    assert.match(r.stderr, /score:helpfulness:.*3\.667 in all \(3 scores\)/);
  });

  test("--by agent prints per-group score mean and sparkline", () => {
    const r = ok(["stats", "--since", "7d", "--by", "agent", "--measure", "score:helpfulness"]);
    assert.match(r.stdout, /SCORE:HELPFULNESS\s+SCORE:HELPFULNESS PER DAY/);
    assert.match(r.stdout, /^claude-code\s+2\s+.*\s4\.5\s+/m);
    assert.match(r.stdout, /^codex\s+1\s+.*\s2\s+/m);
  });

  test("--json includes scoreMean and scoreCount on totals, all, and series", () => {
    const j = JSON.parse(ok(["stats", "--since", "7d", "--by", "agent", "--measure", "score:passed", "--json"]).stdout);
    assert.equal(j.measure, "score:passed");
    assert.equal(j.totals.scoreCount, 2);
    assert.equal(j.totals.scoreMean, 0.5);
    assert.equal(j.all.scoreMean.length, j.buckets.length);
    assert.equal(j.series.find((x: { key: string }) => x.key === "claude-code").totals.scoreMean, 1);
    assert.equal(j.series.find((x: { key: string }) => x.key === "codex").totals.scoreMean, 0);
  });

  test("unknown or unscored name prints - and 0 scores", () => {
    const r = ok(["stats", "--since", "7d", "--measure", "score:missing"]);
    assert.match(r.stderr, /score:missing:.*-\s+in all \(0 scores\)/);
  });

  test("invalid score measures and --scorecard combination exit 2", () => {
    for (const args of [
      ["stats", "--measure", "score:"],
      ["stats", "--measure", "score:bad name!"],
      ["stats", "--scorecard", "--measure", "score:helpfulness"],
    ]) {
      const r = cli(args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.equal(r.stdout, "");
    }
  });
});

test("sparkline handles negative score values cleanly", () => {
  const s = sparkline([-2, 0, 2, null]);
  assert.equal(s.length, 4);
  assert.equal(s[3], " ");
  assert.doesNotMatch(s, /undefined/);
});
