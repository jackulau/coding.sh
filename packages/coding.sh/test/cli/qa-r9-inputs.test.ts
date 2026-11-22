// Hands-on QA, round 9, what a person types: a whole-number flag takes decimal digits only and an
// error quotes what was typed, stats --since in the future says it is after now, search "" is a
// missing argument, and a bad config value prints no JavaScript type name.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { parseArgs, positiveInt, UsageError, type FlagSpec } from "../../src/cli/args.ts";
import { emptyWindow } from "../../src/cli/commands/stats.ts";
import { ConfigError, loadConfig } from "../../src/core/config.ts";
import { parseWhere, QueryError } from "../../src/query/where.ts";
import { CLI } from "../_cli.ts";
import { sandbox, type Sandbox } from "./_cmd.ts";

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
