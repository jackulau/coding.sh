// Hands-on QA, round 9, what a person types: a whole-number flag takes decimal digits only and an
// error quotes what was typed, stats --since in the future says it is after now, --where given
// twice joins with AND, a --flag typo names the flag it meant, search "" is a missing argument, an
// unknown --agent lists the agent ids, and a bad config value prints no JavaScript type name.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { joinWhere, parseArgs, positiveInt, UsageError, type FlagSpec } from "../../src/cli/args.ts";
import { suiteHarness } from "../../src/cli/commands/eval-run.ts";
import { emptyWindow } from "../../src/cli/commands/stats.ts";
import { COMMANDS } from "../../src/cli/registry.ts";
import { ConfigError, loadConfig } from "../../src/core/config.ts";
import { parseWhere, QueryError } from "../../src/query/where.ts";
import { CLI } from "../_cli.ts";
import { mkSession, sandbox, type Sandbox } from "./_cmd.ts";

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
/** The error a --json run prints on stderr. */
const jsonError = (stderr: string) => JSON.parse(stderr.trim().split("\n").pop()!) as { status: string; reason: string; message: string; next?: string[] };

const RANGE = `a whole number from 1 to ${Number.MAX_SAFE_INTEGER}`;

describe("a whole-number flag", () => {
  const LIMIT: FlagSpec = { name: "limit", short: "n", type: "number", value: "<N>", desc: "" };
  const limit = (argv: string[], sensitive = false) => positiveInt(parseArgs(argv, [LIMIT], { sensitive }).flags.limit, "limit");
  const refused = (typed: string) => (e: unknown) => e instanceof UsageError && e.message === `--limit must be ${RANGE}, got ${JSON.stringify(typed)}`;

  test("takes decimal digits", () => {
    assert.equal(limit(["--limit", "5"]), 5);
    assert.equal(limit(["--limit", "007"]), 7);
    assert.equal(limit(["-n", "12"]), 12);
    assert.equal(limit([`--limit=${Number.MAX_SAFE_INTEGER}`]), Number.MAX_SAFE_INTEGER);
  });

  test("refuses what Number() reads as a whole number but is not digits, quoting it", () => {
    for (const typed of ["1e3", "0x10", " 5", "5 ", "5.0", "+5", "0b11", "0o7"]) assert.throws(() => limit(["--limit", typed]), refused(typed), typed);
  });

  test("an out-of-range value is quoted as typed, not as the number it rounded to, in the same words", () => {
    for (const typed of ["99999999999999999999", "9007199254740992", "0", "000"]) assert.throws(() => limit(["--limit", typed]), refused(typed), typed);
    assert.throws(() => limit(["--limit", "99999999999999999999"]), (e: unknown) => e instanceof UsageError && !e.message.includes("100000000000000000000"));
  });

  test("a sensitive command hides the value", () => {
    assert.throws(() => limit(["--limit", "1e3"], true), (e: unknown) => e instanceof UsageError && e.message === `--limit must be ${RANGE}, got (value not shown)`);
  });

  test("a value that was not typed (a default, a config file) is shown as the number", () => {
    parseArgs(["--limit", "5"], [LIMIT]);
    assert.throws(() => positiveInt(0, "limit"), (e: unknown) => e instanceof UsageError && e.message === `--limit must be ${RANGE}, got 0`);
    assert.throws(() => positiveInt(2.5, "limit"), (e: unknown) => e instanceof UsageError && e.message === `--limit must be ${RANGE}, got 2.5`);
  });

  test("sessions --limit 0x10 and --limit 99999999999999999999 exit 2, quoting what was typed", () => {
    const sb = box();
    for (const typed of ["0x10", "99999999999999999999", "5.0"]) {
      const r = cli(sb, ["sessions", "--limit", typed]);
      assert.equal(r.status, 2, r.stderr);
      assert.ok(r.stderr.includes(`--limit must be ${RANGE}, got ${JSON.stringify(typed)}`), r.stderr);
    }
  });

  test("limit: in --where takes decimal digits, in the same words", () => {
    assert.equal(parseWhere("limit:007").limit, 7);
    for (const typed of ["0x10", "1e3", "5.0", "99999999999999999999", "0"]) {
      assert.throws(() => parseWhere(`limit:${typed}`), (e: unknown) => e instanceof QueryError && e.message === `limit: must be ${RANGE}, got ${JSON.stringify(typed)}`, typed);
    }
  });
});

describe("stats --since in the future", () => {
  test("without --until, says --since is after now, and exits 2", () => {
    const r = cli(box(), ["stats", "--since", "2099-01-01"]);
    assert.equal(r.status, 2, r.stderr);
    // A date is local midnight, so its UTC instant falls on 2098-12-31 east of UTC.
    assert.match(r.stderr, /--since is after now: "2099-01-01" is 209[89]-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z, and now is \d{4}-\d\d-\d\dT/);
    assert.doesNotMatch(r.stderr, /--until/, "no --until was given");
  });

  test("in --json the same message, reason invalid_argument", () => {
    const r = cli(box(), ["stats", "--since", "2099-01-01", "--json"]);
    assert.equal(r.status, 2, r.stderr);
    const e = jsonError(r.stderr);
    assert.equal(e.reason, "invalid_argument");
    assert.match(e.message, /^--since is after now: /);
  });

  test("with --until, says --since must be before --until and gives both times", () => {
    const r = cli(box(), ["stats", "--since", "1d", "--until", "7d"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--since must be before --until: "1d" is \d{4}-\d\d-\d\dT[\d:.]+Z, and --until "7d" is \d{4}-\d\d-\d\dT[\d:.]+Z/);
  });

  test("the same instant as now is not before now", () => {
    const t = Date.parse("2026-11-01T10:00:00Z");
    assert.equal(emptyWindow("now", t, undefined, t).message, '--since is not before now: "now" is 2026-11-01T10:00:00.000Z, and now is 2026-11-01T10:00:00.000Z');
  });
});

describe("--where given more than once", () => {
  const WHERE: FlagSpec = { name: "where", type: "string", dashValue: true, value: "<QUERY>", desc: "" };
  const SQL: FlagSpec = { name: "where", type: "string", value: "<SQL>", desc: "" };
  const where = (...parts: string[]) => parseArgs(parts.flatMap((p) => ["--where", p]), [WHERE]).flags.where;

  test("joins the queries with AND, as if written in one", () => {
    assert.equal(where("agent:codex", "cost>1"), "agent:codex cost>1");
    assert.equal(where("a OR b", "-flag:compaction"), "(a OR b) -flag:compaction");
    assert.equal(parseArgs(["--where=agent:codex", "--where", "turns>2"], [WHERE]).flags.where, "agent:codex turns>2");
  });

  test("a later sort: or limit: wins", () => {
    assert.equal(where("agent:codex sort:cost limit:5", "limit:7"), "agent:codex sort:cost limit:7");
    assert.equal(where("sort:cost", "sort:-turns"), "sort:-turns");
  });

  test("a blank part is left out; one --where is kept as typed", () => {
    assert.equal(where("", "agent:codex"), "agent:codex");
    assert.equal(where("agent:codex  cost>1"), "agent:codex  cost>1");
  });

  test("a part that does not parse is passed on alone, so the error points into it", () => {
    assert.equal(where("agent:codex", "bogus:1"), "bogus:1");
  });

  test("the joined text parses to the same query as each part, and printing it again changes nothing", () => {
    const joined = where('tool:Bash ok:false', 'model:claude-* "exact words"', "cost:0.5..2 -is:flagged since:7d");
    assert.equal(joined, 'tool:Bash ok:false model:claude-* "exact words" cost:0.5..2 -is:flagged since:7d');
    assert.equal(where(joined), joined);
  });

  test("SQL parts are wrapped in parentheses and joined with AND", () => {
    assert.equal(parseArgs(["--where", "a = 1 OR b = 2", "--where", "c = 3"], [SQL]).flags.where, "(a = 1 OR b = 2) AND (c = 3)");
    assert.equal(joinWhere(["a = 1"], "<SQL>"), "a = 1");
  });

  test("every --where in the registry is a query or SQL, the two kinds joinWhere joins", () => {
    for (const c of COMMANDS) {
      for (const f of [...(c.flags ?? []), ...(c.actions ?? []).flatMap((a) => a.flags ?? [])]) {
        if (f.name === "where") assert.ok(f.value === "<QUERY>" || f.value === "<SQL>", `${c.name} --where takes ${f.value}`);
      }
    }
  });

  test("sessions --where agent:codex --where cost>1 lists only the sessions both pick", async () => {
    const sb = box();
    const t = Date.now() - 3_600_000;
    await sb.seed([
      mkSession("codex-cheap", t, { agent: "codex", stats: { usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 } } }),
      mkSession("codex-dear", t - 60_000, { agent: "codex", stats: { usage: { inputTokens: 10, outputTokens: 1, costUsd: 2 } } }),
      mkSession("claude-dear", t - 120_000, { stats: { usage: { inputTokens: 10, outputTokens: 1, costUsd: 3 } } }),
    ]);
    const ids = (args: string[]) => {
      const r = cli(sb, ["sessions", "--json", ...args]);
      assert.equal(r.status, 0, r.stderr);
      return (JSON.parse(r.stdout) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
    };
    assert.deepEqual(ids(["--where", "agent:codex", "--where", "cost>1"]), ["codex-dear"]);
    assert.deepEqual(ids(["--where", "cost>1", "--where", "agent:codex"]), ["codex-dear"], "in either order");
    assert.deepEqual(ids(["--where", "agent:codex cost>1"]), ["codex-dear"], "the same as one --where");
  });
});

describe("a --flag or flag: value typed wrong", () => {
  let sb: Sandbox;
  before(async () => {
    sb = box();
    const t = Date.now() - 3_600_000;
    await sb.seed([mkSession("verified", t, { flags: ["no-verification"] }), mkSession("tagged", t - 60_000, { flags: ["my-own-tag"] }), mkSession("plain", t - 120_000)]);
  });

  test("sessions --flag no-verificaton names the flag it meant, and exits 2", () => {
    const r = cli(sb, ["sessions", "--flag", "no-verificaton"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /Unknown session flag "no-verificaton"/);
    assert.match(r.stderr, /Did you mean --flag no-verification\?/);
  });

  test("in --json too, reason unknown_flag", () => {
    const r = cli(sb, ["sessions", "--flag", "no-verificaton", "--json"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const e = jsonError(r.stderr);
    assert.equal(e.reason, "unknown_flag");
    assert.ok(e.next?.includes("--flag no-verification"), r.stderr);
  });

  test("a flag: term in --where, including one typed in another case (flag: matches case too)", () => {
    for (const typed of ["no-verificaton", "NO-VERIFICATION"]) {
      const r = cli(sb, ["sessions", "--where", `flag:${typed}`]);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`Unknown session flag "${typed}"`));
      assert.match(r.stderr, /Did you mean flag:no-verification\?/);
    }
  });

  test("a tag only stored sessions carry is suggested too", () => {
    const r = cli(sb, ["sessions", "--flag", "my-own-tga"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /Did you mean --flag my-own-tag\?/);
  });

  test("a value a stored session carries is no typo, though this search found none", () => {
    const r = cli(sb, ["sessions", "--flag", "my-own-tag", "--agent", "codex"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /No sessions/);
  });

  test("a flag coding.sh sets that no session has, or a name near nothing, is an empty list", () => {
    for (const args of [["--flag", "compaction"], ["--flag", "zzzzzzzzzzzz"], ["--where", "-flag:no-verificaton agent:codex"]]) {
      const r = cli(sb, ["sessions", ...args]);
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stdout + r.stderr, /No sessions/);
    }
  });

  test("when something matched, the typo is not checked", () => {
    const r = cli(sb, ["sessions", "--json", "--where", "flag:no-verificaton OR flag:my-own-tag"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual((JSON.parse(r.stdout) as { sessions: { id: string }[] }).sessions.map((s) => s.id), ["tagged"]);
  });
});

describe("search with blank text", () => {
  test("is a usage error, like a missing argument", () => {
    const sb = box();
    for (const text of ["", "   "]) {
      const r = cli(sb, ["search", text]);
      assert.equal(r.status, 2, JSON.stringify(text) + r.stdout + r.stderr);
      assert.match(r.stderr, /Missing argument <TEXT>: the search text is blank/);
      const j = cli(sb, ["search", text, "--json"]);
      assert.equal(j.status, 2, j.stderr);
      assert.equal(jsonError(j.stderr).reason, "missing_argument");
    }
  });

  test("text after a blank one still searches", () => {
    const r = cli(box(), ["search", "", "deploy"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /No matches for "deploy"/);
  });
});

describe("an unknown --agent", () => {
  const LISTED = /Unknown agent "nope": use one of [a-z0-9-]+(, [a-z0-9-]+)+/;

  for (const args of [
    ["harness", "snapshot", "--agent", "nope"],
    ["harness", "audit", "--agent", "nope"],
    ["init", "--agent", "nope"],
    ["doctor", "--agent", "nope"],
    ["ingest", "--agent", "nope"],
    ["uninstall", "--agent", "nope"],
  ]) {
    test(`${args.slice(0, -2).join(" ")} lists the agent ids when nothing is close`, () => {
      const r = cli(box(), args);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, LISTED);
      assert.match(r.stderr, /\bclaude-code\b/);
      assert.match(r.stderr, /\bcodex\b/);
    });
  }

  test("a near miss is still a suggestion, not the list", () => {
    const r = cli(box(), ["harness", "snapshot", "--agent", "claud-code"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Unknown agent "claud-code"\n/);
    assert.match(r.stderr, /Did you mean --agent claude-code\?/);
    assert.doesNotMatch(r.stderr, /use one of/);
  });

  test("eval run lists the agents it can run headless", async () => {
    const c = { flags: { agent: "nope" }, env: {}, cwd: "." } as never;
    const suite = { spec: { name: "s" }, dir: "." } as never;
    await assert.rejects(suiteHarness(c, {} as never, suite, "."), (e: unknown) => e instanceof UsageError && LISTED.test(e.message) && e.message.includes("claude-code") && e.reason === "unknown_agent");
  });

  test("eval trigger lists the agents it can run headless", () => {
    const sb = box();
    const skill = join(sb.root, "skills", "pdf");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: pdf\ndescription: Use when the user mentions pdf.\n---\nBody.\n");
    writeFileSync(join(skill, "triggers.toml"), 'k = 1\n[[should]]\nprompt = "Fill in the pdf form"\n[[should_not]]\nprompt = "Rename every txt file"\n');
    const r = cli(sb, ["eval", "trigger", "skills/pdf", "--agent", "nope", "--no-siblings"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, LISTED);
    assert.match(r.stderr, /\bclaude-code\b/);
  });
});

describe("a bad config value", () => {
  const msg = (toml: string): string => {
    const sb = box();
    const file = join(sb.root, "config.toml");
    writeFileSync(file, toml);
    try {
      loadConfig({ env: sb.env, file });
    } catch (e) {
      assert.ok(e instanceof ConfigError, String(e));
      return e.message;
    }
    assert.fail(`no error for ${toml}`);
  };

  test("prints the value as written, with no type name", () => {
    assert.match(msg("[retention]\nkeepSpoolDays = -1\n"), /retention\.keepSpoolDays must be an integer >= 0, got -1$/);
    assert.match(msg('[retention]\nkeepSpoolDays = "5"\n'), /retention\.keepSpoolDays must be an integer >= 0, got "5"$/);
    assert.match(msg('[update]\ncheck = "yes"\n'), /update\.check must be true or false, got "yes"$/);
    assert.match(msg("[capture]\nredact = [1]\n"), /capture\.redact must be an array of strings, got \[1\]$/);
    assert.match(msg("retention = 5\n"), /retention must be a table, got 5$/);
  });

  test("config set retention.keepSpoolDays -1 says got -1", () => {
    const r = cli(box(), ["config", "set", "retention.keepSpoolDays", "-1"]);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /must be an integer >= 0, got -1\b/);
    assert.doesNotMatch(r.stderr, /got number/);
  });
});
