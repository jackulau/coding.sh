// coding.sh export scores: JSONL and CSV streaming, filtering by --name, --source,
// --since, --until, --agent, --repo, --where, --limit, --out, and secret redaction.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { IndexStore, Score } from "../../src/core/types.ts";
import { CSV_COLUMNS, exportRows } from "../../src/query/export.ts";
import { ScoreError } from "../../src/scores/scores.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, event, ok, seed, session, T0 } from "./_seed.ts";

const H = 3_600_000;
const FAKE_KEY = ["sk-ant-api03-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2G3h4I5j6K7l8M9n0P1q2R3s4T5u6V7w8"].join("");

const jsonl = (s: string) =>
  s
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("coding.sh export scores", () => {
  let env: TmpEnv;
  let outDir: string;

  const scores: Score[] = [
    {
      id: "sc-num",
      target: "session",
      targetId: "s1",
      sessionId: "s1",
      name: "helpfulness",
      dataType: "numeric",
      value: 4.5,
      source: "judge",
      configId: "helpfulness",
      judgeVersion: "v1",
      calibrated: true,
      comment: `Solid answer; key ${FAKE_KEY}`,
      by: "judge",
      ts: T0 + H,
    },
    {
      id: "sc-bool",
      target: "event",
      targetId: "s1-e1",
      sessionId: "s1",
      name: "grounded",
      dataType: "boolean",
      value: true,
      source: "code",
      by: "checker",
      ts: T0 + 2 * H,
    },
    {
      id: "sc-cat",
      target: "session",
      targetId: "s2",
      sessionId: "s2",
      name: "tone",
      dataType: "categorical",
      value: "concise",
      source: "human",
      comment: "=SUM(A1:A2), nice",
      by: "reviewer",
      ts: T0 + 3 * H,
    },
    {
      id: "sc-text",
      target: "case",
      targetId: "case-1",
      name: "notes",
      dataType: "text",
      value: `Leaked ${FAKE_KEY} in text`,
      source: "api",
      by: "sdk-user",
      ts: T0 + 4 * H,
    },
    {
      id: "sc-mon",
      target: "session",
      targetId: "s2",
      sessionId: "s2",
      name: "helpfulness",
      dataType: "numeric",
      value: 2,
      source: "monitor",
      by: "monitor",
      ts: T0 + 5 * H,
    },
  ];

  before(async () => {
    env = tmpEnv();
    outDir = mkdtempSync(join(tmpdir(), "csh-export-scores-"));
    await seed(env.dataHome, {
      sessions: [
        session("s1", { agent: "claude-code", startedAt: T0, repo: { root: "/work/alpha", head: "aaa" } }),
        session("s2", { agent: "codex", startedAt: T0 + 2 * H, repo: { root: "/work/beta", head: "bbb" } }),
      ],
      events: [event("s1", 1), event("s2", 1)],
      scores,
    });
  });

  after(() => {
    rmSync(outDir, { recursive: true, force: true });
    env.restore();
  });

  test("JSONL exports all typed scores, omits absent optional fields, and redacts secrets", () => {
    const r = ok(["export", "scores"]);
    const rows = jsonl(r.stdout);
    assert.equal(rows.length, 5);
    assert.match(r.stderr, /Exported 5 scores/);

    const num = rows.find((x) => x.id === "sc-num")!;
    assert.equal(num.target, "session");
    assert.equal(num.targetId, "s1");
    assert.equal(num.sessionId, "s1");
    assert.equal(num.dataType, "numeric");
    assert.equal(num.value, 4.5);
    assert.equal(num.configId, "helpfulness");
    assert.equal(num.judgeVersion, "v1");
    assert.equal(num.calibrated, true);
    assert.ok(typeof num.comment === "string" && num.comment.includes("[redacted:anthropic-key]"), String(num.comment));
    assert.ok(!String(num.comment).includes(FAKE_KEY));

    const bool = rows.find((x) => x.id === "sc-bool")!;
    assert.equal(bool.target, "event");
    assert.equal(bool.targetId, "s1-e1");
    assert.equal(bool.value, true);
    assert.equal("comment" in bool, false);
    assert.equal("configId" in bool, false);
    assert.equal("judgeVersion" in bool, false);
    assert.equal("calibrated" in bool, false);

    const txt = rows.find((x) => x.id === "sc-text")!;
    assert.equal(txt.target, "case");
    assert.equal("sessionId" in txt, false);
    assert.ok(typeof txt.value === "string" && txt.value.includes("[redacted:anthropic-key]"), String(txt.value));
    assert.ok(!String(txt.value).includes(FAKE_KEY));
  });

  test("CSV exports fixed columns, neutralises formulas, formats ISO timestamps, and redacts", () => {
    const out = ok(["export", "scores", "--format", "csv"]).stdout;
    const lines = out.trim().split("\r\n");
    assert.equal(lines[0], CSV_COLUMNS.scores.join(","));
    assert.equal(lines.length, 6);
    const catLine = lines.find((l) => l.startsWith("sc-cat,"))!;
    assert.ok(catLine.includes(`"'=SUM(A1:A2), nice"`), catLine);
    assert.ok(catLine.endsWith(new Date(T0 + 3 * H).toISOString()), catLine);
    assert.ok(!out.includes(FAKE_KEY));
    assert.ok(out.includes("[redacted:anthropic-key]"));
  });

  test("filters by --name, --source, --since, --until, --limit, --agent, --repo and --where", () => {
    assert.deepEqual(
      jsonl(ok(["export", "scores", "--name", "helpfulness"]).stdout).map((r) => r.id),
      ["sc-mon", "sc-num"],
    );
    assert.deepEqual(
      jsonl(ok(["export", "scores", "--source", "monitor"]).stdout).map((r) => r.id),
      ["sc-mon"],
    );
    assert.deepEqual(
      jsonl(ok(["export", "scores", "--name", "helpfulness", "--source", "judge"]).stdout).map((r) => r.id),
      ["sc-num"],
    );
    assert.deepEqual(
      jsonl(ok(["export", "scores", "--since", new Date(T0 + 2 * H).toISOString(), "--until", new Date(T0 + 4 * H).toISOString()]).stdout).map((r) => r.id),
      ["sc-cat", "sc-bool"],
    );
    assert.equal(jsonl(ok(["export", "scores", "--limit", "2"]).stdout).length, 2);
    assert.deepEqual(
      jsonl(ok(["export", "scores", "--agent", "codex"]).stdout).map((r) => r.id),
      ["sc-mon", "sc-cat"],
    );
    assert.deepEqual(
      jsonl(ok(["export", "scores", "--repo", "alpha"]).stdout).map((r) => r.id),
      ["sc-bool", "sc-num"],
    );
    assert.deepEqual(
      jsonl(ok(["export", "scores", "--where", "agent:claude-code", "--name", "grounded"]).stdout).map((r) => r.id),
      ["sc-bool"],
    );
  });

  test("--out writes to a file and supports --json summary", () => {
    const file = join(outDir, "nested", "scores.csv");
    const r = ok(["export", "scores", "--format", "csv", "--name", "helpfulness", "--out", file]);
    assert.equal(r.stdout.trim(), file);
    assert.match(r.stderr, /Exported 2 scores/);
    const lines = readFileSync(file, "utf8").trim().split("\r\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], CSV_COLUMNS.scores.join(","));

    const jsonOut = join(outDir, "scores.jsonl");
    const rj = ok(["export", "scores", "--source", "code", "--out", jsonOut, "--json"]);
    const doc = JSON.parse(rj.stdout) as { outcome: string; path: string; kind: string; format: string; rows: number };
    assert.deepEqual(doc, { outcome: "written", path: jsonOut, kind: "scores", format: "jsonl", rows: 1 });
    assert.deepEqual(jsonl(readFileSync(jsonOut, "utf8")).map((x) => x.id), ["sc-bool"]);
  });

  test("rejects bad flags with exit 2", () => {
    const cases: string[][] = [
      ["export", "sessions", "--name", "helpfulness"],
      ["export", "labels", "--source", "judge"],
      ["export", "scores", "--source", "bogus"],
      ["export", "scores", "--name", "bad name!"],
      ["export", "scores", "--since", new Date(T0 + 5 * H).toISOString(), "--until", new Date(T0 + H).toISOString()],
      ["export", "--evidence", join(outDir, "ev"), "--out", join(outDir, "x.jsonl")],
    ];
    for (const args of cases) {
      const r = cli(args);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    }
  });
});

describe("exportRows scores on store without score support", () => {
  test("throws ScoreError 501 when index lacks listScores", async () => {
    const base = new MemoryIndexStore();
    const noScores = new Proxy(base, {
      get(target, k) {
        if (k === "listScores") return undefined;
        const v = Reflect.get(target, k, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as IndexStore;
    await assert.rejects(
      () => exportRows(noScores, "scores", { filter: {}, format: "jsonl", write: () => {} }),
      (e: unknown) => e instanceof ScoreError && e.status === 501,
    );
  });
});
