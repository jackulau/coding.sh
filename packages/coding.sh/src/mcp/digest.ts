// Session digests: the structured one session_get returns and the markdown
// one the codingsh://session/<id> resource serves.
import { costNote } from "../core/pricing.ts";
import { SKILL_EVENT_KINDS, SKILL_TAG_PREFIX, skillUse } from "../core/skills-use.ts";
import type { IndexStore, Session } from "../core/types.ts";
import { clip, countNodes, fmtMs, isRunning, iso, lastActivity, sessionSummary, splitTurns, subagentTree, timeline, turnIndex, type SubagentNode, type TimelineEntry, type TurnInfo } from "./data.ts";

type Obj = Record<string, unknown>;

/** Events read per session for a digest. Longer sessions say `eventsTruncated`. */
export const DIGEST_EVENT_CAP = 20_000;

export interface DigestOpts {
  /** 1-based turn; negative counts from the end (-1 = last). */
  turn?: number;
  /** Timeline entries per page. */
  limit: number;
  offset: number;
  /** "head" pages from the start; "tail" shows the last `limit` entries (offset ignored). */
  from?: "head" | "tail";
  /** Clock for the running/idle call (default Date.now()). */
  now?: number;
}

export interface Digest extends Obj {
  session: Obj;
  turns: TurnInfo[];
  timeline: TimelineEntry[];
}

export async function sessionDigest(index: IndexStore, s: Session, o: DigestOpts): Promise<Digest> {
  // A session past the cap read from its end (tail, or turn -1) reads its last DIGEST_EVENT_CAP
  // events: the latest activity of a days-long run, not the middle of it.
  const fromEnd = s.stats.events > DIGEST_EVENT_CAP && (o.turn !== undefined && o.turn !== 0 ? o.turn < 0 : o.from === "tail");
  const events = await index.listEvents(s.id, { limit: DIGEST_EVENT_CAP, ...(fromEnd ? { offset: s.stats.events - DIGEST_EVENT_CAP } : {}) });
  const turns = splitTurns(events);
  const idx = turnIndex(turns, s.startedAt);
  // Number the window's turns as in the whole session.
  const shift = fromEnd ? Math.max(0, s.stats.turns - turns.length) : 0;
  for (const t of idx) t.turn += shift;
  let scope = events;
  let turnNo: number | undefined;
  if (o.turn !== undefined && o.turn !== 0) {
    turnNo = o.turn < 0 ? turns.length + 1 + o.turn : o.turn;
    const t = turns[turnNo - 1];
    if (!t) throw new RangeError(`session ${s.id} has ${turns.length} turn(s); turn ${o.turn} does not exist`);
    scope = t;
  }
  const all = timeline(scope, s.startedAt);
  const start = o.from === "tail" ? Math.max(0, all.length - o.limit) : o.offset;
  const page = all.slice(start, start + o.limit);
  const kids = await index.listSessions({ parentSessionId: s.id, limit: 500 });
  const subagentEvents = events.filter((e) => e.kind === "subagent.start").length;
  // Only the skill: tags are stored; the rollup is recomputed from the events that feed it.
  const skills = s.flags.some((f) => f.startsWith(SKILL_TAG_PREFIX)) ? skillUse(await index.listEvents(s.id, { kinds: SKILL_EVENT_KINDS }), { cwd: s.cwd }).used : [];
  // The turn index is capped so a 300-turn session still fits in a reply.
  const TURN_CAP = 40;
  return {
    session: sessionSummary(s, o.now ?? Date.now()),
    ...(turnNo !== undefined ? { turn: turnNo + shift } : {}),
    turnCount: turns.length + shift,
    turns: turnNo !== undefined ? idx.slice(turnNo - 1, turnNo) : idx.length > TURN_CAP ? [...idx.slice(0, 10), ...idx.slice(-(TURN_CAP - 10))] : idx,
    ...(turnNo === undefined && idx.length > TURN_CAP ? { turnsOmitted: idx.length - TURN_CAP } : {}),
    timeline: page,
    timelineTotal: all.length,
    ...(o.from !== "tail" && start + o.limit < all.length ? { nextCursor: String(start + o.limit) } : {}),
    ...(events.length >= DIGEST_EVENT_CAP ? { eventsTruncated: true } : {}),
    subagents: kids.length + subagentEvents ? { childSessions: kids.length, spawned: subagentEvents } : undefined,
    ...(skills.length ? { skills } : {}),
  };
}

// ------------------------------------------------------------ markdown

const esc = (s: string) => s.replace(/[\r\n]+/g, " ");

function treeLines(t: SubagentNode[], depth: number, out: string[]): void {
  for (const n of t) {
    const bits = [n.type ?? "subagent", n.description ? `"${esc(n.description)}"` : "", n.durationMs !== undefined ? fmtMs(n.durationMs) : "", n.toolCalls !== undefined ? `${n.toolCalls} tools${n.toolErrors ? ` (${n.toolErrors} failed)` : ""}` : "", n.sessionId ? `session ${n.sessionId}` : "", n.ok === false ? "FAILED" : ""].filter(Boolean);
    out.push(`${"  ".repeat(depth)}- ${bits.join(" · ")}`);
    treeLines(n.children, depth + 1, out);
  }
}

/** Markdown digest of a session: header, turns, the first `maxEntries` timeline lines, subagents. */
export async function sessionMarkdown(index: IndexStore, s: Session, maxEntries = 120, now = Date.now()): Promise<string> {
  const events = await index.listEvents(s.id, { limit: DIGEST_EVENT_CAP });
  const turns = turnIndex(splitTurns(events), s.startedAt);
  const tl = timeline(events, s.startedAt);
  const u = s.stats.usage;
  const lat = s.stats.latency;
  const lines: string[] = [];
  lines.push(`# ${esc(clip(s.title, 120) ?? s.id)}`, "");
  const row = (k: string, v: string | undefined) => {
    if (v) lines.push(`- **${k}:** ${v}`);
  };
  row("Session", `\`${s.id}\``);
  row("Agent", [s.agent, s.agentVersion, s.model].filter(Boolean).join(" · "));
  row("Repo", s.repo ? `${s.repo.root}${s.repo.branch ? ` (${s.repo.branch})` : ""}` : s.cwd);
  row("Started", iso(s.startedAt));
  const last = lastActivity(s);
  row("Duration", s.endedAt !== undefined ? fmtMs(s.endedAt - s.startedAt) : isRunning(s, now) ? `running (no end seen; last activity ${iso(last)})` : `${fmtMs(last - s.startedAt)} (no end seen; idle since ${iso(last)})`);
  row("Activity", `${s.stats.turns} turns, ${s.stats.toolCalls} tool calls${s.stats.toolErrors ? ` (${s.stats.toolErrors} failed)` : ""}, ${s.stats.filesChanged} files changed`);
  if (s.stats.testsPassed !== undefined || s.stats.testsFailed !== undefined) row("Tests", `${s.stats.testsPassed ?? 0} passed, ${s.stats.testsFailed ?? 0} failed`);
  if (u) row("Tokens", `in ${u.inputTokens ?? 0}, out ${u.outputTokens ?? 0}, cache read ${u.cacheReadTokens ?? 0}${u.costUsd !== undefined ? `, $${u.costUsd.toFixed(4)}${costNote(u)}` : ""}`);
  if (lat?.llmCalls) row("Latency", `${lat.llmCalls} model calls, p50 ${fmtMs(lat.llmP50Ms)}, p95 ${fmtMs(lat.llmP95Ms)}${lat.ttftP50Ms !== undefined ? `, TTFT p50 ${fmtMs(lat.ttftP50Ms)}` : ""}`);
  if (s.flags.length) row("Flags", s.flags.join(", "));
  const sw = s.stats.modelSwitch;
  const why = sw && [sw.trigger, sw.reason].filter(Boolean).join(": ");
  row("Models", [s.stats.models && Object.entries(s.stats.models).map(([k, n]) => `${k} ${n}`).join(", "), sw && `switched from ${sw.from} to ${sw.to}${sw.subagent ? " in a subagent" : ""} at +${fmtMs(sw.at - s.startedAt)}${why ? ` (${why})` : ""}${sw.count ? `, ${sw.count} switches` : ""}`, sw?.switchedCalls && `${sw.switchedCalls} calls on the other model${sw.extraUsd !== undefined ? `, $${sw.extraUsd.toFixed(4)} over ${sw.from}'s prices` : ""}`].filter(Boolean).join("; "));
  if (s.stats.redactions) row("Redacted", `${Object.entries(s.stats.redactions).map(([k, n]) => `${k} ${n}`).join(", ")}${s.flags.includes("secret:exposed") ? " (vendor tokens: rotate them)" : ""}`);
  if (s.stats.waste) row("Re-fetches", `${s.stats.waste.duplicateFetches} of ${s.stats.waste.readOnlyCalls} read-only calls repeated with the same result (~${s.stats.waste.duplicateFetchTokens} tokens)`);
  const cb = s.stats.cacheBreaks;
  if (cb) row("Cache breaks", `${cb.count}, ${cb.lostTokens} prompt tokens billed again${cb.extraUsd !== undefined ? `, $${cb.extraUsd.toFixed(4)} extra` : ""} (${Object.entries(cb.byCause).map(([k, c]) => `${k} ${c!.count}`).join(", ")})`);
  for (const d of s.stats.derails ?? []) row("Derail", `${d.flag} at +${fmtMs(d.ts - s.startedAt)} (event ${d.index + 1}): ${d.detail}`);
  if (s.parent) row("Parent", `\`${s.parent.sessionId}\``);
  if (turns.length > 1) {
    lines.push("", "## Turns", "");
    for (const t of turns.slice(0, 50)) lines.push(`${t.turn}. +${fmtMs(t.at)} ${t.prompt ? `"${esc(t.prompt)}"` : "(no prompt)"} · ${t.toolCalls} tools${t.toolErrors ? ` (${t.toolErrors} failed)` : ""}`);
    if (turns.length > 50) lines.push(`… ${turns.length - 50} more turns`);
  }
  lines.push("", "## Timeline", "");
  for (const e of tl.slice(0, maxEntries)) lines.push(`- \`+${fmtMs(e.at)}\` **${e.kind}** ${esc(e.text)}`);
  if (tl.length > maxEntries) lines.push(`- … ${tl.length - maxEntries} more entries (use the session_get tool with a cursor)`);
  if (!tl.length) lines.push("_No events._");
  const tree = await subagentTree(index, s.id);
  if (tree.length) {
    lines.push("", `## Subagents (${countNodes(tree)})`, "");
    treeLines(tree, 0, lines);
  }
  return lines.join("\n") + "\n";
}
