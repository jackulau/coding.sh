// The viewer page's first paint, from the server: the first sessions page as
// plain rows (visible with JavaScript off), and the JSON the page would fetch
// first, embedded so the script reads it instead of asking again. The script
// takes each embedded response once (see preloadTake in ui/index.html).
import type { Session } from "../schema/index.ts";

/** What the sessions page fetches first, by the exact path its script builds (qs() in ui/index.html). */
export const BOOT_LIST_PATHS = [
  "/api/sessions?scope=top&limit=50",
  "/api/stats?scope=top",
  "/api/facets?scope=top&keys=agent%2Cmodel%2Crepo%2Cbranch%2Cflag&limit=40",
  "/api/facets?scope=top&keys=tool%2Cmcp%2Ckind&limit=40",
  "/api/where",
] as const;

/** Opening a session reads these first (showSession); the first row's are embedded when they are small. */
export function sessionBootPaths(id: string): string[] {
  const base = "/api/sessions/" + encodeURIComponent(id);
  return [
    base,
    base + "/events?" + new URLSearchParams({ limit: "5000" }).toString(),
    "/api/labels?" + new URLSearchParams({ sessionId: id }).toString(),
    "/api/sessions?" + new URLSearchParams({ parent: id, limit: "500" }).toString(),
    base + "/outline",
  ];
}

/** The first row's session is embedded up to this many events, and all embedded JSON up to BOOT_MAX_BYTES. */
export const BOOT_SESSION_EVENTS = 400;
export const BOOT_MAX_BYTES = 512 * 1024;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]!);

/** JSON that is safe inside a <script> element: no "<" (so no "</script>"), no line separators. */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const nf = new Intl.NumberFormat();
const fmtNum = (n: number) => nf.format(n);
const plural = (n: number, one: string) => fmtNum(n) + " " + (n === 1 ? one : one + "s");

// The formatters below are the page script's own (ui/index.html), so a row reads the same before
// and after the script takes over. test/viewer/ssr.test.ts runs both over the same sessions.
function fmtCompact(n: number): string {
  if (!n) return "0";
  if (n < 1e3) return String(n);
  const fmt = (x: number) => {
    const one = x.toFixed(1);
    return parseFloat(one) >= 10 ? x.toFixed(0) : one;
  };
  let v = n / 1e3,
    u = 0;
  while (parseFloat(fmt(v)) >= 1000 && u < 3) {
    v /= 1e3;
    u++;
  }
  return fmt(v) + "kMBT"[u];
}
function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  if (usd >= 1e5) return "$" + fmtCompact(usd);
  if (usd >= 1e3) return "$" + nf.format(Math.round(usd));
  return "$" + usd.toFixed(usd < 0.01 ? 4 : usd < 10 ? 2 : 0);
}
function fmtDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "";
  if (Math.round(ms) < 1000) return Math.round(ms) + "ms";
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return (tenths / 10).toFixed(1) + "s";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const hr = Math.floor(m / 60);
  if (hr >= 24) return Math.floor(hr / 24) + "d " + (hr % 24) + "h";
  return hr + "h " + (m % 60) + "m";
}
function midClip(s: string, n: number): string {
  if (s.length <= n) return s;
  const tail = Math.ceil((n - 1) * 0.4);
  return s.slice(0, n - 1 - tail) + "…" + s.slice(-tail);
}
/** The repo column's text: the repo facet's name (last path segment of the repo root, else the working directory). */
function repoLabel(s: Session): string {
  const p = s.repo?.root ?? s.cwd;
  if (p === undefined || p === null) return "";
  const n = String(p).replace(/\\/g, "/");
  return /\/var\/folders\/[\s\S]*\/T$/.test(n) ? "tmp" : n.slice(n.lastIndexOf("/") + 1);
}

function rel(ts: number, now: number): string {
  const d = now - ts;
  if (Math.abs(d) < 60e3) return "just now";
  const year = (t: number) => new Date(t).getFullYear();
  const date = () => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: year(ts) === year(now) ? undefined : "numeric" });
  if (d < 0) {
    const a = -d;
    if (a < 3600e3) return "in " + Math.floor(a / 60e3) + "m";
    if (a < 86400e3) return "in " + Math.floor(a / 3600e3) + "h";
    if (a < 7 * 86400e3) return "in " + Math.floor(a / 86400e3) + "d";
    return date();
  }
  if (d < 3600e3) return Math.floor(d / 60e3) + "m ago";
  if (d < 86400e3) return Math.floor(d / 3600e3) + "h ago";
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + "d ago";
  return date();
}

/** API and production traces: model requests, no tool calls (isApiSession in ui/index.html). */
const isApi = (s: Session): boolean => !s.stats.toolCalls && !s.stats.toolErrors && (s.stats.latency?.llmCalls ?? 0) > 0;

/** The activity cell: "42 tools · 2 failed", or "14 requests" for API traffic. */
function activity(s: Session): { text: string; failed: string } {
  const st = s.stats;
  if (isApi(s)) return { text: plural(st.latency!.llmCalls ?? 0, "request"), failed: "" };
  if (!st.toolCalls && !st.toolErrors) return { text: "", failed: "" };
  return { text: plural(st.toolCalls || 0, "tool"), failed: st.toolErrors ? fmtNum(st.toolErrors) + " failed" : "" };
}

/** The cost cell: "~" when any part is estimated from list prices, "—" when there is no price. */
function costText(s: Session): { text: string; none: boolean } {
  const u = s.stats.usage;
  if (typeof u?.costUsd !== "number") return { text: "—", none: true };
  return { text: ((u.estimatedCostUsd ?? 0) > 0 ? "~" : "") + fmtCost(u.costUsd), none: false };
}

/** The tests tone of the row's dot: "fail", "pass" or "" (testsTone in ui/index.html). */
function testsTone(s: Session): string {
  if ((s.stats.testsFailed ?? 0) > 0) return "fail";
  if ((s.stats.testsPassed ?? 0) > 0) return "pass";
  return "";
}

/** API rows: "1 failed request (429)" (failedRequestsBadge in ui/index.html). */
function failedRequests(s: Session): { text: string; title: string } | undefined {
  const e = isApi(s) ? s.stats.llmErrors : undefined;
  if (!e?.count) return undefined;
  const text = plural(e.count, "failed request") + (typeof e.statusCode === "number" ? ` (${e.statusCode})` : "");
  return { text, title: e.error ? "First failure: " + e.error : text };
}

/**
 * The badges after the title, as the script draws them for the top-level list: the subagent
 * toggle (a plain label here, since the row is a link), the tests badge, failed requests, the
 * first flag and "+N" for the rest.
 */
function badges(s: Session & { childCount?: number }): string {
  const out: string[] = [];
  const kids = s.childCount ?? 0;
  if (kids) out.push(`<span class="sub-toggle"><span class="caret" aria-hidden="true">▸</span>${esc(plural(kids, "subagent"))}</span>`);
  const st = s.stats;
  if (st.testsFailed !== undefined || st.testsPassed !== undefined) {
    out.push(
      (st.testsFailed ?? 0) > 0
        ? `<span class="badge fail" title="${esc(fmtNum(st.testsPassed ?? 0) + " passed")}">${esc("✕ " + fmtNum(st.testsFailed!) + " failed")}</span>`
        : `<span class="badge pass">${esc("✓ " + fmtNum(st.testsPassed ?? 0) + " passed")}</span>`,
    );
  }
  const fr = failedRequests(s);
  if (fr) out.push(`<span class="badge fail" title="${esc(fr.title)}">${esc(fr.text)}</span>`);
  const flags = s.flags ?? [];
  if (flags.length) out.push(`<span class="badge flag" title="${esc("Flag: " + flags[0])}"><span class="dot"></span>${esc(flags[0])}</span>`);
  if (flags.length > 1) out.push(`<span class="badge" title="${esc("Flags: " + flags.join(", "))}">${esc("+" + (flags.length - 1))}</span>`);
  return `<span class="row-badges">${out.join("")}</span>`;
}

/**
 * The sessions page as the script would draw it, minus what needs the script (filters, keys,
 * charts). Rows are links, so the page works as a list of sessions with JavaScript off.
 */
export function renderSessionsMain(items: readonly (Session & { childCount?: number })[], total: number | undefined, now = Date.now()): string {
  const rows = items.map((s) => {
    const title = oneLine(s.title) || "Untitled session";
    const agent = s.parent?.type ?? s.agent;
    const repo = repoLabel(s);
    const u = s.stats.usage;
    const tokens = u ? (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + (u.outputTokens ?? 0) : 0;
    const act = activity(s);
    const cost = costText(s);
    const dir = s.repo?.root ?? s.cwd;
    const tone = testsTone(s);
    const fr = failedRequests(s);
    return [
      `<a class="row" role="listitem" href="#/s/${esc(encodeURIComponent(s.id))}" data-sid="${esc(s.id)}">`,
      `<span class="dot ${tone ? "tone-" + tone : act.failed || fr ? "tone-fail ring" : "tone-muted"}" aria-hidden="true"></span>`,
      `<div class="row-main"><span class="row-title truncate" title="${esc(title)}">${esc(title)}</span>${badges(s)}</div>`,
      `<div class="row-cells">`,
      `<span class="cell agent-cell"><span>${esc(agent)}</span>${s.model ? `<span class="sub"> ${esc(midClip(s.model, 22))}</span>` : ""}</span>`,
      `<span class="cell muted repo-cell${repo ? "" : " is-none"}"${dir ? ` title="${esc(dir)}"` : ""}>${esc(repo || "—")}</span>`,
      `<span class="cell act-cell">${esc(act.text)}${act.failed ? `<span class="err"> ${esc("· " + act.failed)}</span>` : ""}</span>`,
      `<span class="cell num muted tok-cell">${tokens ? esc(fmtCompact(tokens) + " tok") : ""}</span>`,
      `<span class="cell num cost-cell${cost.none ? " muted opt" : ""}">${esc(cost.text)}</span>`,
      `<span class="cell num muted dur-cell">${s.endedAt ? esc(fmtDuration(s.endedAt - s.startedAt)) : ""}</span>`,
      `<span class="cell num muted">${esc(rel(s.startedAt, now))}</span>`,
      `</div></a>`,
    ].join("");
  });
  const count = total ?? items.length;
  return [
    `<section class="wrap view ssr-sessions" aria-labelledby="ssr-h">`,
    `<div class="page-head"><div><h1 id="ssr-h">Sessions</h1><p class="meta">${esc(count === 1 ? "1 session" : `${count} sessions`)}</p></div></div>`,
    items.length
      ? `<div class="panel table session-table"><div class="list" role="list" aria-label="Sessions">${rows.join("")}</div></div>`
      : `<div class="panel empty"><h2>No sessions yet</h2><p>Run coding.sh init to capture your agents' sessions.</p></div>`,
    `</section>`,
  ].join("");
}

/** The page with `main` drawn and `boot` embedded. `page` is the template with the nonce already set. */
export function renderPage(page: string, main: string, boot: Record<string, unknown>, nonce: string): string {
  const MAIN = '<main id="main" tabindex="-1"></main>';
  const at = page.indexOf(MAIN);
  if (at < 0) return page;
  const data = Object.keys(boot).length ? `<script type="application/json" id="boot-data" nonce="${esc(nonce)}">${scriptJson(boot)}</script>` : "";
  return page.slice(0, at) + `<main id="main" tabindex="-1">${main}</main>` + data + page.slice(at + MAIN.length);
}
