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
  slice("function isApiSession(", "/** \"1 failed request"),
  slice("function rowTokens(", "// Facet sidebar keys"),
  slice("function testsTone(", "function sessionTitle("),
  slice("function failedRequestsBadge(", "/** \"1.6k tokens\""),
  slice("function viaHost(", "function subagentBadge("),
  // A stand-in for the page's DOM builder: the badges are compared by their text.
  "function h(tag, attrs, ...children) { return { tag, attrs: attrs || {}, children }; }",
].join("\n");
const page: any = runInNewContext(`${src}\n({ fmtDuration, midClip, repoLabel, activityText, rowTokens, usageCost, testsTone, testsBadge, failedRequestsBadge, rowFlags, plural, viaHost })`, { Intl, Date, String, Number, Math, isFinite, parseFloat, RegExp });
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
    // A subagent's row names its type; a host app that drove the agent follows the name.
    agent: (s.parent?.type ?? s.agent) + page.viaHost(s) + (s.model ? " " + page.midClip(s.model, 22) : ""),
    agentTitle: [s.agent + page.viaHost(s), s.model].filter(Boolean).join(" · "),
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
    base({ id: "worktree", repo: { root: "/work/demo/.claude/worktrees/agent-a1", main: "/work/demo", head: "" }, cwd: "/work/demo/.claude/worktrees/agent-a1" }),
    base({ id: "open", endedAt: undefined }),
    base({ id: "flag1", flags: ["unapproved-action"] }),
    base({ id: "flag4", flags: ["cache:low", "hook:settings", "no-verification", "skill:pdf"], stats: { toolCalls: 4, toolErrors: 2 } }),
    { ...base({ id: "kids1" }), childCount: 1 } as Session,
    { ...base({ id: "kids3", flags: ["no-verification"] }), childCount: 3 } as Session,
    base({ id: "red", stats: { toolCalls: 5, testsFailed: 2, testsPassed: 7 } }),
    base({ id: "green", stats: { toolCalls: 5, testsPassed: 3 } }),
    base({ id: "api-err", stats: { latency: { llmCalls: 4, llmP95Ms: 100 }, llmErrors: { count: 2, statusCode: 429, error: "rate limited" } } }),
    base({ id: "agent-err", stats: { toolCalls: 2, llmErrors: { count: 3693, statusCode: 429 } } }),
    base({ id: "hosted", host: "t3code" }),
    base({ id: "hosted-codex", agent: "codex", host: "t3code", model: undefined }),
    base({ id: "hosted-sub", host: "t3code", parent: { sessionId: "hosted", type: "Explore" } }),
    base({ id: "hosted-unknown", host: "conductor" }),
  ];
  const all = [...metricFixtures(), ...extra];
  const out = renderSessionsMain(all, all.length, Date.UTC(2026, 9, 20));
  const rows = out.split('<a class="row"').slice(1);
  assert.equal(rows.length, all.length);
  all.forEach((s, i) => {
    const row = rows[i]!;
    const want = hydrated(s);
    const agentTitle = /<span class="cell agent-cell" title="([^"]*)"/.exec(row)?.[1]?.replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    assert.deepEqual(
      { repo: cell(row, "repo-cell"), act: cell(row, "act-cell"), tok: cell(row, "tok-cell"), cost: cell(row, "cost-cell"), dur: cell(row, "dur-cell"), agent: cell(row, "agent-cell"), agentTitle },
      want,
      s.id,
    );
    if (s.model) assert.ok(row.includes(`> ${page.midClip(s.model, 22)}</span>`), `${s.id} model`);
    const badges = /<span class="row-badges">([\s\S]*?)<\/span><\/div>/.exec(row);
    assert.ok(badges, `${s.id} badges`);
    const dot = /<span class="dot ([^"]+)"/.exec(row)![1];
    assert.deepEqual({ badges: badges![1]!.replace(/<[^>]+>/g, ""), dot }, hydratedBadges(s), `${s.id} badges and dot`);
  });
  const wt = rows[all.findIndex((s) => s.id === "worktree")]!;
  assert.equal(cell(wt, "repo-cell"), "demo", "a worktree session is named by its main checkout");
  assert.ok(wt.includes('title="/work/demo"'), "with the main checkout as the cell's title");
});

test("a row's tests badge counts tests from the last run, on the server and in the script", () => {
  const red = base({ id: "red", stats: { toolCalls: 5, toolErrors: 3, testsFailed: 1, testsPassed: 41 } });
  const green = base({ id: "green", stats: { toolCalls: 5, testsPassed: 1 } });
  const rows = renderSessionsMain([red, green], 2, Date.UTC(2026, 9, 20)).split('<a class="row"').slice(1);
  // "1 failed" beside "3 tool errors" read as a count of tool calls; the badge says tests, from the last run.
  assert.match(rows[0]!, /<span class="badge fail" title="Last test run: 41 passed, 1 failed">✕ 1 test failed<\/span>/);
  assert.match(rows[1]!, /<span class="badge pass" title="Last test run: 1 passed, 0 failed">✓ 1 test passed<\/span>/);
  const [fail, pass] = [page.testsBadge(red), page.testsBadge(green)];
  assert.deepEqual([textOf(fail), fail.attrs.class, fail.attrs.title], ["✕ 1 test failed", "badge fail", "Last test run: 41 passed, 1 failed"]);
  assert.deepEqual([textOf(pass), pass.attrs.class, pass.attrs.title], ["✓ 1 test passed", "badge pass", "Last test run: 1 passed, 0 failed"]);
});

test("a row's duration rounds as the CLI's does, on the server and in the script", () => {
  const long = base({ id: "2h30", endedAt: Date.UTC(2026, 9, 7, 12) + 8_975_379 });
  const [row] = renderSessionsMain([long], 1, Date.UTC(2026, 9, 20)).split('<a class="row"').slice(1);
  // The CLI prints 2h30m for 8,975,379 ms; the viewer used to floor it to 2h 29m.
  assert.equal(page.fmtDuration(8_975_379), "2h 30m");
  assert.equal(cell(row!, "dur-cell"), "2h 30m");
});

test("the agent cell names the host app that drove the session, on the server and in the script", () => {
  const hosted = base({ id: "hosted", host: "t3code" });
  const [row] = renderSessionsMain([hosted], 1, Date.UTC(2026, 9, 20)).split('<a class="row"').slice(1);
  // `sessions --agent t3code` lists a claude-code session that T3 Code drove: the row says why.
  assert.match(row!, /<span class="cell agent-cell" title="claude-code via T3 Code · claude-opus-5-5"><span>claude-code<span class="host"> via T3 Code<\/span><\/span><span class="sub"> claude-opus-5-5<\/span><\/span>/);
  assert.deepEqual([page.viaHost(hosted), page.viaHost(base({ id: "c", host: "conductor" })), page.viaHost(base({ id: "n" }))], [" via T3 Code", " via conductor", ""]);
  // The script's row builds the same cell from the same function.
  assert.ok(html.includes('title: [s.agent + viaHost(s), s.model].filter(Boolean).join(" · ")'), "the script's agent cell title");
  assert.ok(html.includes('s.host ? h("span", { class: "host" }, viaHost(s)) : null'), "the script's host span");
});


test("a session whose model calls failed shows a marker in the row and the header", () => {
  const s = base({ id: "all-429", stats: { llmErrors: { count: 3693, statusCode: 429, error: "rate_limit" } } });
  const row = renderSessionsMain([s], 1);
  assert.match(row, /3,693 model errors \(429\)/);
  assert.match(row, /class="dot tone-fail ring"/);
  assert.equal(textOf(page.failedRequestsBadge(s)), "3,693 model errors (429)");
  assert.match(html, /plural\(st\.llmErrors\.count, "model error"\)/);
});
