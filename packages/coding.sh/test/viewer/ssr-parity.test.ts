// The server-drawn rows (src/viewer/ssr.ts) read the same as the rows the script draws over them:
// same token total (cache writes included), "~" on an estimated cost, "1 tool", the same durations
// and repo name, the same badges (subagents, tests, failed requests, first flag and +N) and the
// same dot. The page's own functions are run from ui/index.html, so the two cannot drift.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import type { Session } from "../../src/schema/index.ts";
import { renderSessionsMain } from "../../src/viewer/ssr.ts";
import { metricFixtures } from "./fakes.ts";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
function slice(from: string, to: string): string {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `markers ${from} .. ${to}`);
  return html.slice(a, b);
}
const src = [
  slice("const nf = new Intl.NumberFormat();", "function fmtDate("),
  slice("function midClip(", "function clip("),
  slice("function repoDir(", "function basename("),
  slice("function isApiSession(", "/** API rows:"),
  slice("function rowTokens(", "// Facet sidebar keys"),
  slice("function testsTone(", "function sessionTitle("),
  slice("function failedRequestsBadge(", "/** \"1.6k tokens\""),
  // A stand-in for the page's DOM builder: the badges are compared by their text.
  "function h(tag, attrs, ...children) { return { tag, attrs: attrs || {}, children }; }",
].join("\n");
const page: any = runInNewContext(`${src}\n({ fmtDuration, midClip, repoLabel, activityText, rowTokens, usageCost, testsTone, testsBadge, failedRequestsBadge, rowFlags, plural })`, { Intl, Date, String, Number, Math, isFinite, parseFloat, RegExp });
type Built = { children: unknown[] } | string | number | null | undefined | false | unknown[];
const textOf = (n: Built): string =>
  n === null || n === undefined || n === false ? "" : Array.isArray(n) ? n.map((c) => textOf(c as Built)).join("") : typeof n === "object" ? textOf(n.children as Built) : String(n);

const cell = (row: string, cls: string): string => {
  const m = new RegExp(`<span class="cell [^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</span>(?=<span class="cell|</div>)`).exec(row);
  assert.ok(m, `${cls} cell in ${row}`);
  return m![1]!.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&amp;/g, "&").trim();
};

/** What the script's row shows for each cell, from the page's own functions. */
function hydrated(s: Session) {
  const st = s.stats;
  const [act, err] = page.activityText(s);
  const cost = page.usageCost(st.usage, s.model);
  return {
    repo: page.repoLabel(s) || "—",
    act: act + (err ? " · " + err : ""),
    tok: page.rowTokens(st.usage).replace(" tokens", " tok"),
    cost: cost.text,
    dur: s.endedAt ? page.fmtDuration(s.endedAt - s.startedAt) : "",
  };
}

/** The badges after the title and the dot's tone, as sessionList() draws them for the top-level list. */
function hydratedBadges(s: Session & { childCount?: number }) {
  const kids = s.childCount ?? 0;
  const failedReqs = page.failedRequestsBadge(s);
  const tone = page.testsTone(s);
  return {
    badges: (kids ? "▸" + page.plural(kids, "subagent") : "") + textOf(page.testsBadge(s)) + textOf(failedReqs) + textOf(page.rowFlags(s.flags)),
    dot: tone ? "tone-" + tone : page.activityText(s)[1] || failedReqs ? "tone-fail ring" : "tone-muted",
  };
}

const base = (over: Omit<Partial<Session>, "stats"> & { stats?: Partial<Session["stats"]> }): Session => ({
  ...metricFixtures()[0]!,
  id: "x",
  startedAt: Date.UTC(2026, 9, 7, 12),
  endedAt: Date.UTC(2026, 9, 7, 12) + 600_000,
  ...over,
  stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, ...over.stats },
});

test("server-drawn rows show what the script's rows show", () => {
  const extra: Session[] = [
    base({ id: "w", stats: { usage: { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 4_000, costUsd: 0.5, estimatedCostUsd: 0.5 } } }),
    base({ id: "one", stats: { toolCalls: 1 } }),
    base({ id: "part", stats: { toolCalls: 3, toolErrors: 1, usage: { inputTokens: 10, outputTokens: 10, costUsd: 2, estimatedCostUsd: 0.5 } } }),
    base({ id: "api", stats: { latency: { llmCalls: 1, llmP95Ms: 100 }, usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.00004 } } }),
    base({ id: "quick", endedAt: Date.UTC(2026, 9, 7, 12) + 500, stats: { toolCalls: 2 } }),
    base({ id: "long", endedAt: Date.UTC(2026, 9, 7, 12) + 26 * 3_600_000, model: "claude-opus-5-5-20261101-extended-thinking" }),
    base({ id: "cwd", repo: undefined, cwd: "/home/user/notes" }),
    base({ id: "open", endedAt: undefined }),
    base({ id: "flag1", flags: ["unapproved-action"] }),
    base({ id: "flag4", flags: ["cache:low", "hook:settings", "no-verification", "skill:pdf"], stats: { toolCalls: 4, toolErrors: 2 } }),
    { ...base({ id: "kids1" }), childCount: 1 } as Session,
    { ...base({ id: "kids3", flags: ["no-verification"] }), childCount: 3 } as Session,
    base({ id: "red", stats: { toolCalls: 5, testsFailed: 2, testsPassed: 7 } }),
    base({ id: "green", stats: { toolCalls: 5, testsPassed: 3 } }),
    base({ id: "api-err", stats: { latency: { llmCalls: 4, llmP95Ms: 100 }, llmErrors: { count: 2, statusCode: 429, error: "rate limited" } } }),
  ];
  const all = [...metricFixtures(), ...extra];
  const out = renderSessionsMain(all, all.length, Date.UTC(2026, 9, 20));
  const rows = out.split('<a class="row"').slice(1);
  assert.equal(rows.length, all.length);
  all.forEach((s, i) => {
    const row = rows[i]!;
    const want = hydrated(s);
    assert.deepEqual(
      { repo: cell(row, "repo-cell"), act: cell(row, "act-cell"), tok: cell(row, "tok-cell"), cost: cell(row, "cost-cell"), dur: cell(row, "dur-cell") },
      want,
      s.id,
    );
    if (s.model) assert.ok(row.includes(`> ${page.midClip(s.model, 22)}</span>`), `${s.id} model`);
    const badges = /<span class="row-badges">([\s\S]*?)<\/span><\/div>/.exec(row);
    assert.ok(badges, `${s.id} badges`);
    const dot = /<span class="dot ([^"]+)"/.exec(row)![1];
    assert.deepEqual({ badges: badges![1]!.replace(/<[^>]+>/g, ""), dot }, hydratedBadges(s), `${s.id} badges and dot`);
  });
});
