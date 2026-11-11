// --since / --until and `--where since: until:` share one reader (src/query/time.ts): a date
// without a zone is local time, `today` and `yesterday` work, and a date with Z or an offset is
// that instant. The CLI half runs under TZ=America/Chicago against a temp store.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, session } from "../query/_seed.ts";
import { parseSince, parseSinceWhen, UsageError } from "../../src/cli/args.ts";
import { parseWhen, utcOffset, wallText } from "../../src/query/time.ts";
import { parseWhere, timeBounds } from "../../src/query/where.ts";

const ms = (iso: string) => Date.parse(iso);
const NOW = ms("2026-11-09T03:00:00Z"); // 21:00 on 2026-11-08 at UTC-6
const CST = { now: NOW, tzOffsetMin: 360 };

describe("parseWhen", () => {
  test("a date without a zone is midnight in the zone, the instant the same date with 00:00:00 names", () => {
    assert.deepEqual(parseWhen("2026-11-09", CST), { ms: ms("2026-11-09T06:00:00Z"), zoned: true });
    assert.deepEqual(parseWhen("2026-11-09T00:00:00", CST), parseWhen("2026-11-09", CST));
    assert.deepEqual(parseWhen("2026-11-09 08:30", CST), { ms: ms("2026-11-09T14:30:00Z"), zoned: true });
    assert.equal(parseWhen("2026-11-09", { tzOffsetMin: -120 })!.ms, ms("2026-11-08T22:00:00Z"));
    assert.equal(parseWhen("2026-11-09", { tzOffsetMin: 0 })!.ms, ms("2026-11-09T00:00:00Z"));
  });

  test("without an offset the process's zone decides, as new Date(y, m, d) does", () => {
    assert.equal(parseWhen("2026-11-09")!.ms, new Date(2026, 10, 9).getTime());
    assert.equal(parseWhen("2026-11-09T08:30")!.ms, new Date(2026, 10, 9, 8, 30).getTime());
    assert.equal(parseSince("2026-11-09"), new Date(2026, 10, 9).getTime());
  });

  test("a date and time with Z or an offset is that instant in any zone", () => {
    assert.deepEqual(parseWhen("2026-11-09T00:00:00Z", CST), { ms: ms("2026-11-09T00:00:00Z"), zoned: false });
    assert.equal(parseWhen("2026-11-09T00:00:00.250+02:00", CST)!.ms, ms("2026-11-08T22:00:00.250Z"));
    assert.equal(parseWhen("2026-11-09T00:00-0600", CST)!.ms, ms("2026-11-09T06:00:00Z"));
  });

  test("today and yesterday are midnights in the zone", () => {
    assert.deepEqual(parseWhen("today", CST), { ms: ms("2026-11-08T06:00:00Z"), zoned: true });
    assert.deepEqual(parseWhen("Yesterday", CST), { ms: ms("2026-11-07T06:00:00Z"), zoned: true });
    assert.equal(parseWhen("today", { now: NOW, tzOffsetMin: 0 })!.ms, ms("2026-11-09T00:00:00Z"));
    const t = new Date(NOW);
    assert.equal(parseSince("today", NOW), new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime());
  });

  test("ages and epoch ms read as before", () => {
    assert.deepEqual(parseWhen("7d", CST), { ms: NOW - 7 * 86_400_000, zoned: false });
    assert.equal(parseSince("12h", NOW), NOW - 12 * 3_600_000);
    assert.equal(parseSince("90s", NOW), NOW - 90_000);
    assert.equal(parseSince("2w", NOW), NOW - 14 * 86_400_000);
    assert.equal(parseSince("1762650000000", NOW), 1_762_650_000_000);
  });

  test("a day that does not exist, a word and a bare number are not dates", () => {
    for (const bad of ["2026-02-31", "2026-13-01", "2026-11-09T25:00", "tomorrow", "soon", "7"]) assert.equal(parseWhen(bad, CST), undefined, bad);
    assert.throws(() => parseSince("soon"), (e: unknown) => e instanceof UsageError && /--since must be a duration \(7d, 12h, 30m\), today, yesterday or a date/.test(e.message));
    assert.throws(() => parseSinceWhen("soon", NOW, "until"), /--until must be/);
  });

  test("utcOffset and wallText describe the zone", () => {
    assert.equal(utcOffset(360), "-06:00");
    assert.equal(utcOffset(-330), "+05:30");
    assert.equal(utcOffset(0), "+00:00");
    assert.equal(wallText(ms("2026-11-09T06:00:00Z"), 360), "2026-11-09 00:00");
  });

  test("--where since: and until: use the same reader", () => {
    const q = parseWhere("since:yesterday until:today agent:codex", CST);
    assert.deepEqual(timeBounds(q), { since: ms("2026-11-07T06:00:00Z"), until: ms("2026-11-08T06:00:00Z"), zoned: true });
    assert.deepEqual(timeBounds(parseWhere("since:2026-11-09", CST)), { since: ms("2026-11-09T06:00:00Z"), zoned: true });
    assert.deepEqual(timeBounds(parseWhere("since:7d", CST)), { since: NOW - 7 * 86_400_000, zoned: false });
    assert.deepEqual(timeBounds(parseWhere("agent:codex", CST)), { zoned: false });
    // A bound only one branch of an OR sets is not the window.
    assert.deepEqual(timeBounds(parseWhere("since:today OR agent:codex", CST)), { zoned: false });
  });
});

// Fixed days a year back, so "today" and "yesterday" never land on them.
describe("dates on the command line, at UTC-6", () => {
  const TZ = { TZ: "America/Chicago" };
  const chicago = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "America/Chicago", hour12: false });
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    const at = (id: string, iso: string) => session(id, { startedAt: ms(iso), endedAt: ms(iso) + 60_000 });
    await seed(env.dataHome, {
      sessions: [
        at("utc-midnight", "2025-11-09T00:00:00Z"), // 18:00 on the 8th in Chicago
        at("late-on-8th", "2025-11-09T05:59:59Z"),
        at("local-midnight", "2025-11-09T06:00:00Z"),
        at("noon-on-9th", "2025-11-09T18:00:00Z"),
        session("just-now", { startedAt: Date.now() - 1000, endedAt: Date.now() }),
      ],
    });
  });
  after(() => env.restore());

  const ids = (args: string[]) => (JSON.parse(ok([...args, "--json"], TZ).stdout) as { sessions: { id: string }[] }).sessions.map((s) => s.id).sort();

  test("sessions --since <date> starts at local midnight, like the same date with a time", () => {
    const kept = ["just-now", "local-midnight", "noon-on-9th"];
    assert.deepEqual(ids(["sessions", "--since", "2025-11-09"]), kept);
    assert.deepEqual(ids(["sessions", "--since", "2025-11-09T00:00:00"]), kept);
    assert.deepEqual(ids(["sessions", "--where", "since:2025-11-09"]), kept);
    // A zone in the value still wins.
    assert.deepEqual(ids(["sessions", "--since", "2025-11-09T00:00:00Z"]), [...kept, "late-on-8th", "utc-midnight"].sort());
  });

  test("until is exclusive and local: until:2025-11-09 leaves the 9th out", () => {
    assert.deepEqual(ids(["sessions", "--where", "since:2025-11-08 until:2025-11-09"]), ["late-on-8th", "utc-midnight"]);
  });

  test("the window is echoed on stderr for a date, and is in --json; an age has no echo", () => {
    const r = ok(["sessions", "--since", "2025-11-09"], TZ);
    assert.match(r.stderr, /^ {2}Window: 2025-11-09 00:00 \(UTC-06:00\) to now, local time$/m);
    const j = JSON.parse(ok(["sessions", "--since", "2025-11-09", "--json"], TZ).stdout) as { window: unknown };
    assert.deepEqual(j.window, { since: "2025-11-09T06:00:00.000Z", utcOffset: "-06:00" });
    const w = ok(["sessions", "--where", "since:2025-11-08 until:2025-11-09"], TZ);
    assert.match(w.stderr, /^ {2}Window: 2025-11-08 00:00 \(UTC-06:00\) to 2025-11-09 00:00 \(UTC-06:00\), local time$/m);
    assert.doesNotMatch(ok(["sessions", "--since", "7d"], TZ).stderr, /Window:/);
    assert.equal((JSON.parse(ok(["sessions", "--json"], TZ).stdout) as { window?: unknown }).window, undefined);
  });

  test("usage --since today --json exits 0 and window.since is local midnight", () => {
    const j = JSON.parse(ok(["usage", "--since", "today", "--json"], TZ).stdout) as { window: { since: string; utcOffset: string; sessions: number }; total: { sessions: number } };
    assert.match(chicago(j.window.since), /, 00:00:00$/);
    assert.equal(chicago(j.window.since).slice(0, 10), chicago(new Date().toISOString()).slice(0, 10));
    assert.match(j.window.utcOffset, /^-0[56]:00$/);
    assert.equal(j.total.sessions, 1);
    assert.match(ok(["usage", "--since", "today"], TZ).stderr, /^ {2}Window: \d{4}-\d\d-\d\d 00:00 \(UTC-0[56]:00\) to now, local time$/m);
  });

  test("--where 'since:yesterday until:today' parses and names one local day", () => {
    const j = JSON.parse(ok(["sessions", "--where", "since:yesterday until:today", "--json"], TZ).stdout) as { sessions: unknown[]; window: { since: string; until: string } };
    assert.deepEqual(j.sessions, []);
    assert.match(chicago(j.window.since), /, 00:00:00$/);
    assert.match(chicago(j.window.until), /, 00:00:00$/);
    const hours = (ms(j.window.until) - ms(j.window.since)) / 3_600_000;
    assert.ok(hours >= 23 && hours <= 25, String(hours));
  });

  test("stats --since and --until read dates in local time, across a clock change", () => {
    // Chicago left daylight time at 02:00 on 2025-11-02: that midnight is UTC-5, the 9th's is UTC-6.
    const j = JSON.parse(ok(["stats", "--since", "2025-11-02", "--until", "2025-11-09", "--json"], TZ).stdout) as { window: unknown; totals: { sessions: number } };
    assert.deepEqual(j.window, { since: "2025-11-02T05:00:00.000Z", until: "2025-11-09T06:00:00.000Z", utcOffset: "-05:00" });
    assert.equal(j.totals.sessions, 2);
    const t = ok(["stats", "--since", "2025-11-02", "--until", "2025-11-09"], TZ);
    assert.match(t.stderr, /^ {2}Window: 2025-11-02 00:00 \(UTC-05:00\) to 2025-11-09 00:00 \(UTC-06:00\), local time$/m);
    const bad = cli(["stats", "--until", "soon"], TZ);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--until must be a duration/);
  });
});
