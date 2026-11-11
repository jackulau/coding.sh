// Viewer fixes that live in the page's own plain functions (run straight from ui/index.html, as
// ui-format.test.ts does): the Explore range label, the repo column's name, the totals line, and
// which queries the page refuses to send.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { parseWhere, QueryError } from "../../src/query/where.ts";

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

test("the repo column names a session as the repo facet does: root, else working directory", () => {
  assert.equal(f.repoLabel({ repo: { root: "/work/demo" }, cwd: "/elsewhere" }), "demo");
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
  assert.match(html, /function swap\(el, \.\.\.children\) \{\s*el\.replaceChildren\(\);\s*return append\(el, children\);/);
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
