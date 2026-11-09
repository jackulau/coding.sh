// Comma lists for multi-value flags: `--agent a,b` is `--agent a --agent b`, in the parser and on
// sessions, usage, search, export and ingest.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { parseArgs, UsageError, type FlagSpec } from "../../src/cli/args.ts";
import { findCommand } from "../../src/cli/registry.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, session } from "../query/_seed.ts";
import type { Session } from "../../src/schema/index.ts";

const AGENT: FlagSpec = { name: "agent", short: "a", type: "list", commas: true, value: "<AGENT>", desc: "" };
const KIND: FlagSpec = { name: "kind", type: "list", commas: true, choices: ["x", "y"], desc: "" };
const GRADER: FlagSpec = { name: "grader", type: "list", value: "<JSON>", desc: "" };

describe("parser: comma lists", () => {
  test("a comma list equals the repeated flag, in every spelling", () => {
    const want = ["claude-code", "codex", "cursor"];
    for (const argv of [
      ["--agent", "claude-code,codex", "--agent", "cursor"],
      ["--agent=claude-code,codex,cursor"],
      ["-a", "claude-code, codex", "-a", "cursor"],
      ["--agent", "claude-code", "--agent", "codex", "--agent", "cursor"],
      ["--agent", "claude-code,,codex,", "-a=cursor"],
    ]) {
      assert.deepEqual(parseArgs(argv, [AGENT]).flags.agent, want, argv.join(" "));
    }
  });
  test("an empty comma list is a missing value", () => {
    assert.throws(() => parseArgs(["--agent", ","], [AGENT]), (e: unknown) => e instanceof UsageError && e.reason === "missing_value");
  });
  test("choices are checked per item", () => {
    assert.deepEqual(parseArgs(["--kind", "x,y"], [KIND]).flags.kind, ["x", "y"]);
    assert.throws(() => parseArgs(["--kind", "x,z"], [KIND]), /must be one of x, y, got "z"/);
  });
  test("a list flag without commas keeps its value whole (JSON, commands)", () => {
    assert.deepEqual(parseArgs(["--grader", '{"kind":"exact","a":[1,2]}'], [GRADER]).flags.grader, ['{"kind":"exact","a":[1,2]}']);
  });
  test("exp run --cell keeps a matrix cell's name whole: it holds a comma per axis", () => {
    const flags = findCommand("exp")!.actions!.find((a) => a.name === "run")!.flags!;
    assert.deepEqual(parseArgs(["--cell", "model=big,prompt=shout", "--cell", "model=small,prompt=shout"], flags).flags.cell, ["model=big,prompt=shout", "model=small,prompt=shout"]);
  });
});

const now = Date.now() - 3_600_000;
const mk = (id: string, agent: string, minutesAgo: number): Session =>
  session(id, {
    agent: agent as Session["agent"],
    startedAt: now - minutesAgo * 60_000,
    endedAt: now - minutesAgo * 60_000 + 30_000,
    stats: { events: 4, turns: 2, toolCalls: 1, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 100 * (minutesAgo + 1), outputTokens: 20, cacheReadTokens: 50, costUsd: 0.01 } },
  }) as Session;

describe("--agent a,b on commands", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions: [mk("s-claude", "claude-code", 1), mk("s-codex", "codex", 2), mk("s-cursor", "cursor", 3), mk("s-claude2", "claude-code", 4)] });
  });
  after(() => env.restore());

  const ids = (args: string[]) => (JSON.parse(ok(args).stdout) as { sessions: { id: string }[] }).sessions.map((s) => s.id);

  test("sessions: the comma list equals the repeated flag, and keeps only those agents", () => {
    const comma = ids(["sessions", "--json", "--agent", "claude-code,codex"]);
    assert.deepEqual(comma, ids(["sessions", "--json", "--agent", "claude-code", "--agent", "codex"]));
    assert.deepEqual(comma, ["s-claude", "s-codex", "s-claude2"], "newest first, cursor left out");
    assert.deepEqual(ids(["sessions", "--json", "--agent", "claude-code,codex", "--limit", "2"]), ["s-claude", "s-codex"]);
    assert.deepEqual(ids(["sessions", "--json", "--agent", "codex"]), ["s-codex"], "one agent still filters in the store");
  });

  test("sessions --where and --facets take the agents too", () => {
    assert.deepEqual(ids(["sessions", "--json", "--agent", "claude-code,cursor", "--where", "turns>0"]).sort(), ["s-claude", "s-claude2", "s-cursor"]);
    const facets = (args: string[]) => JSON.parse(ok(args).stdout).facets.agent as { value: string; count: number }[];
    const comma = facets(["sessions", "--json", "--facets", "agent", "--agent", "claude-code,codex"]);
    assert.deepEqual(comma, facets(["sessions", "--json", "--facets", "agent", "--agent", "claude-code", "--agent", "codex"]));
    assert.deepEqual(Object.fromEntries(comma.map((r) => [r.value, r.count])), { "claude-code": 2, codex: 1 });
  });

  test("usage: the comma list equals the repeated flag", () => {
    const comma = JSON.parse(ok(["usage", "--json", "--by", "agent", "--agent", "claude-code,codex"]).stdout);
    const repeated = JSON.parse(ok(["usage", "--json", "--by", "agent", "--agent", "claude-code", "--agent", "codex"]).stdout);
    assert.deepEqual(comma.groups, repeated.groups, "same rows (only the `since` instant differs between runs)");
    assert.deepEqual(comma.total, repeated.total);
    assert.deepEqual(comma.groups.map((g: { key: string }) => g.key).sort(), ["claude-code", "codex"]);
    assert.equal(comma.total.sessions, 3);
  });

  test("export: the comma list equals the repeated flag", () => {
    const rows = (args: string[]) => ok(args).stdout.trim().split("\n").map((l) => JSON.parse(l).id as string).sort();
    const comma = rows(["export", "sessions", "--agent", "codex,cursor"]);
    assert.deepEqual(comma, rows(["export", "sessions", "--agent", "codex", "--agent", "cursor"]));
    assert.deepEqual(comma, ["s-codex", "s-cursor"]);
  });

  test("ingest: the comma list is checked like the repeated flag", () => {
    const comma = cli(["ingest", "--json", "--agent", "claude-code,codex"]);
    const repeated = cli(["ingest", "--json", "--agent", "claude-code", "--agent", "codex"]);
    assert.equal(comma.status, 0, comma.stderr);
    assert.equal(comma.status, repeated.status);
    const a = JSON.parse(comma.stdout);
    const b = JSON.parse(repeated.stdout);
    assert.equal(a.outcome, b.outcome);
    assert.deepEqual(a.spool, b.spool);
    assert.deepEqual(a.backfill, b.backfill);
    const bad = cli(["ingest", "--agent", "claude-code,nope"]);
    const badRepeated = cli(["ingest", "--agent", "claude-code", "--agent", "nope"]);
    assert.equal(bad.status, 2);
    assert.equal(bad.status, badRepeated.status);
    assert.equal(bad.stderr, badRepeated.stderr);
  });
});
