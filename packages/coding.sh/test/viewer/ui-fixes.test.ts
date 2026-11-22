// Viewer fixes that live in the page's own plain functions (run straight from ui/index.html, as
// ui-format.test.ts does): the Explore range label, the repo column's name, the totals line, and
// which queries the page refuses to send.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { parseWhere, QueryError } from "../../src/query/where.ts";
import { startViewer } from "../../src/viewer/server.ts";
import { FakeBlobs, FakeIndex, session } from "./fakes.ts";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
function slice(from: string, to: string): string {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `markers ${from} .. ${to}`);
  return html.slice(a, b);
}

const src = [
  slice("const nf = new Intl.NumberFormat();", "function fmtDate("),
  slice("function fmtDayRange(", "function basename("),
  slice("function repoDir(", "function basename("),
  slice("function summaryLine(", "\n}\n") + "\n}",
  slice("function whereProblem(", "/** Top-level terms"),
].join("\n");
const f: any = runInNewContext(`${src}\n({ fmtDayRange, repoLabel, summaryLine, whereProblem, facetValueParams })`, { Intl, Date, String, Number, Math, isFinite, parseFloat, RegExp });

const DAY = 86_400_000;
const local = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

test("an Explore range names the year when it crosses one or spans a year", () => {
  assert.equal(f.fmtDayRange(local(2026, 10, 7), local(2026, 11, 5)), "Oct 7 – Nov 5");
  assert.equal(f.fmtDayRange(local(2025, 12, 20), local(2026, 1, 10)), "Dec 20, 2025 – Jan 10, 2026");
  // 365 days inside one calendar year is impossible; 365 days back from a date in the same year is not.
  const from = local(2026, 11, 5) - 365 * DAY;
  assert.match(f.fmtDayRange(from, local(2026, 11, 5)), /2025.*2026/);
  assert.equal(f.fmtDayRange(local(2026, 1, 1), local(2026, 12, 31)), "Jan 1 – Dec 31");
});

test("the repo column names a session as the repo facet does: main checkout, else root, else working directory", () => {
  assert.equal(f.repoLabel({ repo: { root: "/work/demo" }, cwd: "/elsewhere" }), "demo");
  // A worktree session (an agent's checkout under the repo) is named by its main checkout.
  assert.equal(f.repoLabel({ repo: { root: "/work/demo/.claude/worktrees/agent-a1", main: "/work/demo" }, cwd: "/work/demo/.claude/worktrees/agent-a1" }), "demo");
  assert.equal(f.repoLabel({ cwd: "/home/user/notes" }), "notes");
  assert.equal(f.repoLabel({ cwd: "C:\\work\\app" }), "app");
  assert.equal(f.repoLabel({ cwd: "/var/folders/ab/cd/T" }), "tmp");
  assert.equal(f.repoLabel({}), "");
});

test("the totals line counts subagents apart from the sessions (\"5 sessions + 2 subagents\", not \"incl.\")", () => {
  assert.deepEqual([...f.summaryLine({ sessions: 5, subagents: 2, toolCalls: 9 })], ["5 sessions", "+ 2 subagents", "9 tool calls"]);
  assert.deepEqual([...f.summaryLine({ sessions: 1, subagents: 1 })], ["1 session", "+ 1 subagent"]);
  assert.deepEqual([...f.summaryLine({ sessions: 1 })], ["1 session"]);
});

test("with subagents included, the totals line counts each subagent once (scope=all's sessions already hold them)", () => {
  // A parent and two subagents: scope=top counts 1 session, scope=all counts 3 rows, 2 of them subagents.
  assert.deepEqual([...f.summaryLine({ scope: "top", sessions: 1, subagents: 2, toolCalls: 6 })], ["1 session", "+ 2 subagents", "6 tool calls"]);
  assert.deepEqual([...f.summaryLine({ scope: "all", sessions: 3, subagents: 2, toolCalls: 6 })], ["1 session", "+ 2 subagents", "6 tool calls"]);
  assert.deepEqual([...f.summaryLine({ scope: "all", sessions: 2, subagents: 2 })], ["0 sessions", "+ 2 subagents"], "a filter that only subagents match");
  // pricedSessions counts subagents in either scope: an unpriced parent leaves the cost partial in both.
  const partial = (scope: string, sessions: number) => f.summaryLine({ scope, sessions, subagents: 2, costUsd: 0.04, estimatedCostUsd: 0, pricedSessions: 2 })[2];
  assert.equal(partial("top", 1).text, "$0.04 priced");
  assert.equal(partial("all", 3).text, "$0.04 priced");
  const whole = (scope: string, sessions: number) => f.summaryLine({ scope, sessions, subagents: 2, costUsd: 0.07, estimatedCostUsd: 0, pricedSessions: 3 })[2];
  assert.equal(whole("top", 1).text, "$0.07");
  assert.equal(whole("all", 3).text, "$0.07");
});

test("a parent with two subagents: the header reads the same in both scopes and adds up to the list's rows", async () => {
  const index = new FakeIndex();
  const usage = (costUsd: number) => ({ inputTokens: 100, outputTokens: 10, costUsd });
  await index.upsertSession(session("p", { startedAt: 1_700_000_000_000, stats: { events: 3, turns: 1, toolCalls: 2, toolErrors: 0, filesChanged: 1, usage: usage(0.05), latency: { llmCalls: 2 } } }));
  for (const [i, id] of ["p:sub:a", "p:sub:b"].entries()) {
    await index.upsertSession(session(id, { startedAt: 1_700_000_100_000 + i, parent: { sessionId: "p", subagentId: id.slice(-1) }, stats: { events: 3, turns: 1, toolCalls: 2, toolErrors: 0, filesChanged: 0, usage: usage(0.01), latency: { llmCalls: 1 } } }));
  }
  const v = await startViewer({ index, blobs: new FakeBlobs(), port: 0 });
  try {
    const get = async (path: string) => {
      const r = await fetch(`http://127.0.0.1:${v.port}${path}`, { headers: { authorization: `Bearer ${v.token}` } });
      assert.equal(r.status, 200, path);
      return r.json() as Promise<any>;
    };
    const lines: Record<string, unknown[]> = {};
    for (const scope of ["top", "all"]) {
      const stats = await get(`/api/stats?scope=${scope}`);
      const rows = (await get(`/api/sessions?scope=${scope}`)).items;
      // The tab count is the list's rows; the header splits them into sessions and subagents.
      assert.equal(stats.sessions, rows.length, `${scope}: stats.sessions is the list's row count`);
      assert.equal(stats.subagents, 2, `${scope}: each subagent counted once`);
      // Cost, model calls and tool calls cover each session once, in either scope (a parent's usage holds none of its subagents').
      assert.equal(stats.toolCalls, 6, scope);
      assert.equal(stats.llmCalls, 4, scope);
      assert.equal(stats.pricedSessions, 3, scope);
      assert.ok(Math.abs(stats.costUsd - 0.07) < 1e-9, `${scope}: ${stats.costUsd}`);
      lines[scope] = JSON.parse(JSON.stringify(f.summaryLine({ ...stats, scope }))); // out of the page's realm
    }
    assert.deepEqual(lines.top, ["1 session", "+ 2 subagents", "6 tool calls", "4 model calls", { text: "$0.07", title: "Reported cost" }]);
    assert.deepEqual(lines.all, lines.top);
  } finally {
    await v.close();
  }
});

test("the page refuses to send a query the server would refuse, with the server's reason and offset", () => {
  const bad = ['tool:"Bash', 'a "b', "(a OR b", "a)", "()", "OR a", "a OR", "a OR OR b", "(a OR)", "(OR a)", "-(", "title:\"x\" (y"];
  for (const q of bad) {
    const mine = f.whereProblem(q);
    assert.ok(mine, `client accepts ${q}`);
    let theirs: any;
    try {
      parseWhere(q);
    } catch (e) {
      theirs = e;
    }
    assert.ok(theirs instanceof QueryError, `server accepts ${q}`);
    assert.equal(mine.reason, theirs.reason, q);
    assert.equal(mine.offset, theirs.offset, q);
  }
  const good = ["", "tool:Bash ok:false", 'title:"a b"', "(a OR b) -flag:x", "a OR b", 'say "hi (there"', "cost>0.5", "-x", "a-b", 'path:"C:\\\\x"'];
  for (const q of good) assert.equal(f.whereProblem(q), null, q);
});

test("the page builds DOM through one helper that skips null, not the DOM's own replaceChildren", () => {
  // replaceChildren(null) writes the text "null"; swap() fills like h() does and skips it.
  const uses = html.match(/replaceChildren\(/g) ?? [];
  assert.equal(uses.length, 1, "only swap() itself calls replaceChildren");
  assert.match(html, /function swap\(el, \.\.\.children\) \{\s*return keepFocus\(el, \(\) => \{ el\.replaceChildren\(\); return append\(el, children\); \}\);/);
});

/** The top-level arguments of the call whose "(" ends just before `i`. */
function callArgs(text: string, i: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = "";
  for (let j = i; j < text.length; j++) {
    const c = text[j]!;
    if (quote) {
      cur += c;
      if (c === "\\") cur += text[++j];
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
    } else if ("([{".includes(c)) {
      depth++;
      cur += c;
    } else if (")]}".includes(c)) {
      if (depth === 0) return [...args, cur.trim()].filter(Boolean);
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  throw new Error("unclosed call");
}

/** A `?`, `&&` or `||` outside any bracket or string: the argument can be null. */
function conditional(arg: string): boolean {
  let depth = 0;
  let quote = "";
  for (let k = 0; k < arg.length; k++) {
    const c = arg[k]!;
    if (quote) {
      if (c === "\\") k++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && (c === "?" || arg.startsWith("&&", k) || arg.startsWith("||", k))) return true;
  }
  return false;
}

test("children that can be null go through append(), never the DOM's own Element.append", () => {
  // Element.append(null) writes the text "null" (5 of them showed under a benchmark's gap chart).
  const bad: string[] = [];
  for (const m of html.matchAll(/([A-Za-z_$][\w$]*)\.append\(/g)) {
    if (m[1] === "el") continue; // inside append() and svg(), which skip null themselves
    const args = callArgs(html, m.index! + m[0].length);
    if (args.length === 2 && /^["'`]/.test(args[0]!)) continue; // URLSearchParams / FormData .append(key, value)
    const many = args.length > 1 && !args.every((a) => /^(?:h|svg)\(|^["'`]/.test(a));
    if (many || args.some(conditional)) bad.push(`line ${html.slice(0, m.index).split("\n").length}: ${m[0]}${args.length} args`);
  }
  assert.deepEqual(bad, [], "use append(el, [...]) for these");
});

test("the value autocomplete leaves out a rest of the query the parser would refuse", () => {
  // Typing `(tool:Bash OR "unclosed` sent where=( and got a 400 in the console on every key.
  const p = { scope: "top", since: undefined, until: undefined };
  assert.equal(f.facetValueParams(p, "tool", 12, "Bash", "(").where, undefined);
  assert.equal(f.facetValueParams(p, "tool", 12, "Bash", 'model:"open').where, undefined);
  assert.equal(f.facetValueParams(p, "tool", 12, "Bash", "agent:codex").where, "agent:codex");
  assert.equal(f.facetValueParams(p, "tool", 12, "Bash", "").where, undefined);
  assert.equal(f.facetValueParams(p, "tool", 12, "Bash", "(").keys, "tool");
});

test("the command menu key is Ctrl K off a Mac, the fold toggle keeps one name, and the palette asks the server", () => {
  assert.match(html, /const MOD_K = IS_MAC \? "⌘K" : "Ctrl K";/);
  assert.match(html, /keys: \[MOD_K\], label: "Command menu"/);
  assert.doesNotMatch(html, /"Expand all"/);
  assert.match(html, /function searchStored\(\)/);
  assert.match(html, /announce\("Session loaded, " \+ plural\(items\.length, "step"\) \+ \(failIdx\.length \? ", " \+ plural\(failIdx\.length, "failure"\) : ""\)\);\n\s+loadOutline\(\)/);
  assert.match(html, /"Include subagents"\)\)\n?\s*: null,/);
});
