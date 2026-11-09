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
const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

function rel(ts: number, now: number): string {
  const d = now - ts;
  if (d < 60e3) return "just now";
  if (d < 3600e3) return Math.floor(d / 60e3) + "m ago";
  if (d < 86400e3) return Math.floor(d / 3600e3) + "h ago";
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + "d ago";
  return new Date(ts).toISOString().slice(0, 10);
}
function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}

/**
 * The sessions page as the script would draw it, minus what needs the script (filters, keys,
 * charts). Rows are links, so the page works as a list of sessions with JavaScript off.
 */
export function renderSessionsMain(items: readonly Session[], total: number | undefined, now = Date.now()): string {
  const rows = items.map((s) => {
    const title = oneLine(s.title) || "Untitled session";
    const agent = s.parent?.type ?? s.agent;
    const repo = s.repo?.root ? base(s.repo.root) : "—";
    const tokens = s.stats.usage ? (s.stats.usage.inputTokens ?? 0) + (s.stats.usage.outputTokens ?? 0) + (s.stats.usage.cacheReadTokens ?? 0) : 0;
    const cost = s.stats.usage?.costUsd;
    return [
      `<a class="row" role="listitem" href="#/s/${esc(encodeURIComponent(s.id))}" data-sid="${esc(s.id)}">`,
      `<span class="dot tone-muted" aria-hidden="true"></span>`,
      `<div class="row-main"><span class="row-title truncate" title="${esc(title)}">${esc(title)}</span></div>`,
      `<div class="row-cells">`,
      `<span class="cell agent-cell"><span>${esc(agent)}</span>${s.model ? `<span class="sub"> ${esc(s.model)}</span>` : ""}</span>`,
      `<span class="cell muted repo-cell">${esc(repo)}</span>`,
      `<span class="cell act-cell">${s.stats.toolCalls ? esc(`${s.stats.toolCalls} tool calls`) : ""}</span>`,
      `<span class="cell num muted tok-cell">${tokens ? esc(tokens >= 1e6 ? (tokens / 1e6).toFixed(1) + "M tok" : tokens >= 1e3 ? Math.round(tokens / 1e3) + "k tok" : tokens + " tok") : ""}</span>`,
      `<span class="cell num cost-cell">${typeof cost === "number" ? esc("$" + cost.toFixed(cost < 10 ? 2 : 0)) : ""}</span>`,
      `<span class="cell num muted dur-cell">${s.endedAt ? esc(dur(s.endedAt - s.startedAt)) : ""}</span>`,
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
