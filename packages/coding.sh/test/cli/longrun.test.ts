// A synthetic 12-hour Claude Code session (test/fixtures/longrun/generate.ts,
// no real user data) at a quarter of the full event rate: two `claude --resume`
// runs, auto compactions, subagents, a day boundary and one planted derail of
// each kind. Checks that ingest finds every planted derail at its onset and
// nothing else, that `show` summarises it by phase, that `sessions --flag`
// filters on derails, and that session building stays linear in the event
// count (the perf guard for very long sessions; the full-size bench is
// scripts/perf/longrun.mjs, see docs/perf.md).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectDerails } from "../../src/core/derail.ts";
import { sessionOutline } from "../../src/core/outline.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { generateLongSession, type GenManifest } from "../fixtures/longrun/generate.ts";
import { median, timeMs } from "../helpers-timing.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
let root = "";
let m: GenManifest;
let env: NodeJS.ProcessEnv;

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  return r;
};
const cli = (...args: string[]) => run(...args).stdout;

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-longrun-"));
  m = generateLongSession({ out: join(root, "fixture"), scale: 0.25 });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = {
    ...process.env,
    ["HO" + "ME"]: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: m.files.claudeConfigDir,
    CODEX_HOME: m.files.codexHome,
    T3CODE_HOME: join(root, "t3"),
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    TZ: "UTC",
  };
  cli("ingest", "--backfill", "--agent", "claude-code", "--agent", "codex");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("a 12-hour session", () => {
  test("every planted derail is found at its onset, and nothing else", () => {
    const { sessions } = JSON.parse(cli("sessions", "--json", "--limit", "10")) as { sessions: Session[] };
    const main = sessions.find((s) => s.id === m.sessionId)!;
    assert.ok(main, "the long session is listed");
    const found = (main.stats.derails ?? []).map((d) => ({ flag: d.flag, ts: d.ts }));
    assert.deepEqual(found.map((d) => d.flag).sort(), m.derails.map((d) => d.flag).sort());
    for (const p of m.derails) {
      const d = found.find((x) => x.flag === p.flag)!;
      assert.ok(Math.abs(d.ts - p.ts) <= 60_000, `${p.flag} found ${Math.round((d.ts - p.ts) / 1000)} s from its planted onset (${p.note})`);
    }
    for (const p of m.derails) assert.ok(main.flags.includes(p.flag), `flag ${p.flag}`);
    const codex = sessions.find((s) => s.id === m.codexSessionId)!;
    assert.deepEqual(codex.stats.derails ?? [], [], "the resumed Codex thread runs clean");
  });

  test("sessions --flag filters on a derail", () => {
    const ids = (flag: string) => (JSON.parse(cli("sessions", "--json", "--flag", flag)) as { sessions: Session[] }).sessions.map((s) => s.id);
    assert.deepEqual(ids("looping"), [m.sessionId]);
    assert.deepEqual(ids("stalled"), [m.sessionId]);
  });

  // The transcript has no resume marker (only the hook's SessionStart says "resume"), so a
  // backfilled resume shows as an idle gap; test/core/outline.test.ts covers hook resumes.
  test("show summarises by phase: start, compactions, idle gaps and the day line", () => {
    const r = run("show", m.sessionId);
    const text = r.stdout;
    assert.match(r.stderr + r.stdout, /\d+ events in \d+ phases; --all lists every event/);
    assert.equal((text.match(/compacted \(auto\)/g) ?? []).length, m.compactions);
    assert.match(text, /back after \d+ min idle/);
    assert.match(text, /── \w{3}, Nov 4 ──/, "the UTC day boundary");
    for (const p of m.derails) assert.ok(text.includes(`⚠ ${p.flag}`), `derail ${p.flag} under its phase`);
    const json = JSON.parse(cli("show", m.sessionId, "--json")) as { phases: { kind: string }[]; days: unknown[]; events: unknown[] };
    assert.equal(json.phases.filter((p) => p.kind === "compaction").length, m.compactions);
    assert.equal(json.phases[0]!.kind, "start");
    assert.equal(json.days.length, 1);
    const all = cli("show", m.sessionId, "--all");
    assert.ok(all.split("\n").length > json.events.length * 0.5, "--all lists every event");
    assert.match(all, /── phase 2: /);
  });

  test("show --follow prints the tail and the derails, and stops once the session has ended", () => {
    const r = run("show", m.sessionId, "--follow");
    assert.match(r.stdout, /⚠ looping/);
    assert.match(r.stdout + r.stderr, /Session ended/);
    assert.ok(r.stdout.split("\n").length < 200, "a tail, not the whole session");
  });

  test("building the session stays linear in its event count", async () => {
    const store = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"), { readOnly: true });
    let events: AgentEvent[];
    try {
      events = await store.listEvents(m.sessionId);
    } finally {
      await store.close();
    }
    const quarter = events.slice(0, Math.floor(events.length / 4));
    const work = (evs: AgentEvent[]) => () => {
      const s = buildSession(evs);
      sessionOutline(evs, s.stats.derails ?? []);
    };
    work(events)();
    // Interleaved, so load on the box stretches both sides alike. Linear work is about 4x; quadratic would be about 16x.
    const ratios: number[] = [];
    for (let i = 0; i < 5; i++) ratios.push(timeMs(work(events)) / timeMs(work(quarter)));
    assert.ok(median(ratios) < 9, `4x the events took ${median(ratios).toFixed(1)}x as long (${ratios.map((r) => r.toFixed(1)).join(", ")})`);
    // Against a same-moment baseline: one pass that touches every event's payload.
    const base = timeMs(() => JSON.stringify(events));
    const derail = median([0, 1, 2].map(() => timeMs(() => detectDerails(events))));
    assert.ok(derail < Math.max(base * 6, 30), `detectDerails ${derail.toFixed(0)} ms over ${events.length} events; JSON.stringify ${base.toFixed(0)} ms`);
  });
});
