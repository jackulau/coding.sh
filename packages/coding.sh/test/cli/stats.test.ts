// coding.sh stats: per-day rows with gaps kept, --by tables with a trend, --json is the
// /api/metrics document, an empty window is a note, and bad flags exit 2.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, session } from "../query/_seed.ts";
import { sparkline } from "../../src/cli/commands/stats.ts";

const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;
const at = (daysAgo: number) => today - daysAgo * DAY + 3_600_000;
const s = (id: string, daysAgo: number, over: Parameters<typeof session>[1] = {}) =>
  session(id, { startedAt: at(daysAgo), endedAt: at(daysAgo) + 60_000, ...over });

describe("stats", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, {
      sessions: [
        s("a", 1, { model: "claude-opus-5-5", flags: ["no-verification"] }),
        s("b", 1, { agent: "codex", model: "gpt-6.1-sol" }),
        s("c", 3, { agent: "codex", model: "gpt-6.1-sol", flags: ["skill:pdf"] }),
        s("d", 3, { parent: { sessionId: "c", type: "Explore" } }),
        s("e", 40),
      ],
    });
  });
  after(() => env.restore());

  test("one row per day, newest first, with empty days kept and a total", () => {
    const r = ok(["stats", "--since", "7d"]);
    const lines = r.stdout.trim().split("\n");
    assert.match(lines[0]!, /^DAY\s+SESSIONS\s+FAIL%\s+COST/);
    assert.match(lines.at(-1)!, /^total\s+3\s+33%/);
    // Seven or eight daily rows (the window starts mid-day), the newest first.
    const days = lines.slice(1, -1).map((l) => l.split(/\s+/)[0]);
    assert.ok(days.length >= 7 && days.length <= 8, days.join(","));
    assert.deepEqual([...days].sort().reverse(), days);
    assert.match(r.stderr, /sessions: \S+\s+3 in all/);
  });

  test("--by agent prints a row per agent with a trend, and --all counts subagents", () => {
    const top = ok(["stats", "--since", "7d", "--by", "agent"]).stdout;
    assert.match(top, /^AGENT\s+SESSIONS/m);
    assert.match(top, /^codex\s+2\s/m);
    assert.match(top, /^claude-code\s+1\s/m);
    assert.match(top, /^total\s+3\s/m);
    const all = ok(["stats", "--since", "7d", "--by", "agent", "--all"]).stdout;
    assert.match(all, /^claude-code\s+2\s/m);
  });

  test("--json is one MetricSeries document", () => {
    const j = JSON.parse(ok(["stats", "--since", "7d", "--by", "model", "--measure", "cost", "--json"]).stdout);
    assert.equal(j.measure, "cost");
    assert.equal(j.by, "model");
    assert.equal(j.totals.sessions, 3);
    assert.equal(j.buckets.length, j.all.sessions.length);
    assert.deepEqual(j.series.map((x: { key: string }) => x.key).sort(), ["claude-opus-5-5", "gpt-6.1-sol"]);
  });

  test("--where filters, and an empty window is a note, not an error", () => {
    const j = JSON.parse(ok(["stats", "--since", "7d", "--where", "agent:codex", "--json"]).stdout);
    assert.equal(j.totals.sessions, 2);
    const r = ok(["stats", "--since", "90d", "--until", "60d"]);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /No sessions from \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d/);
  });

  test("bad flags exit 2 with a reason", () => {
    for (const args of [["--measure", "vibes"], ["--by", "tool"], ["--per", "hour"], ["--since", "1d", "--until", "2d"], ["--since", "3y"], ["--since", "500d", "--per", "day"]]) {
      const r = cli(["stats", ...args]);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.equal(r.stdout, "");
    }
    const j = JSON.parse(cli(["stats", "--measure", "vibes", "--json"]).stderr);
    assert.equal(j.status, "error");
    assert.equal(j.reason, "invalid_usage");
    assert.match(j.message, /--measure must be one of sessions/);
  });
});

// Days are the user's: a date names local midnight, so the day before `--until <date>` is whole.
describe("stats: a date is local midnight", () => {
  const TZ = "America/Chicago";
  const local = (t: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23", ...o }).format(t);
  const ymd = (t: number) => local(t, { year: "numeric", month: "2-digit", day: "2-digit" });
  // Yesterday in Chicago and today; 20:00 there is already the next day in UTC.
  const noon = Date.now() - ((Number(local(Date.now(), { hour: "2-digit" })) - 12) * 3_600_000);
  const day = ymd(noon - DAY);
  const next = ymd(noon);
  const evening = [5, 6].map((h) => Date.parse(`${day}T20:00:00Z`) + h * 3_600_000).find((t) => local(t, { hour: "2-digit" }) === "20")!;
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions: [session("late", { startedAt: evening, endedAt: evening + 60_000 })] });
  });
  after(() => env.restore());
  const rows = (args: string[]) => ok(["stats", ...args], { TZ }).stdout.trim().split("\n").slice(1, -1);

  test("--until <day+1> keeps the whole of <day>, and --since <day> starts on it", () => {
    assert.equal(ymd(evening), day);
    const row = rows([]).find((l) => l.startsWith(day));
    assert.match(row ?? "", /^\S+\t1\t0%\t/);
    // Newest first: <day> is the last day before --until, with every session it has.
    assert.equal(rows(["--until", next])[0], row);
    // Oldest last: the window starts on <day>, not in the evening of the day before.
    const since = rows(["--since", day]);
    assert.equal(since.at(-1), row);
    assert.ok(since.length <= 2, since.join(" | "));
    const none = ok(["stats", "--since", next], { TZ });
    assert.equal(none.stdout, "");
    assert.match(none.stderr, new RegExp(`No sessions from ${next} to ${next}`));
  });
});

test("sparkline scales to the largest value and leaves blanks for gaps", () => {
  assert.equal(sparkline([0, 1, 2, 4]), "▁▃▅█");
  assert.equal(sparkline([null, 3, null]), " █ ");
  assert.equal(sparkline([0, 0]), "▁▁");
});
