// coding.sh work [--all] [--stage <list>] [--repo <path>] [--agent <name>] [--since 7d] [--limit 20]
// coding.sh work show|ack|snooze <id>: what needs you across every agent's sessions
// (core/work.ts), with acks and snoozes in work.json (core/work-overlay.ts).
import { parsePlace } from "../../mcp/data.ts";
import type { Session } from "../../schema/index.ts";
import type { Context } from "../../core/context.ts";
import { addAck, addSnooze, readOverlay, writeOverlay, type WorkOverlay } from "../../core/work-overlay.ts";
import { BUCKET_LABELS, buildWorkQueue, countsLine, loadWorkSessions, STAGES, stagesLine, workFiles, workItemJson, workJson, type Stage, type WorkItem, type WorkQueue } from "../../core/work.ts";
import { parseAge, parseSinceWhen, positiveInt, suggest, UsageError } from "../args.ts";
import { agentsFlag, autoIngest, list as listFlag, num, oneLine, pendingField, readIngest, rejectAgentTypos, str, withContext, type IngestBacklog } from "../common.ts";
import { ago, CliError, localTime, plural, usd } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** How far back items are read unless --since says otherwise. */
export const WORK_SINCE = "7d";

export async function run(c: CommandContext): Promise<number> {
  if (c.action === "show") return show(c);
  if (c.action === "ack") return ack(c);
  if (c.action === "snooze") return snooze(c);
  return list(c);
}

interface Window {
  since: number;
  sinceText: string;
}

function windowOf(c: CommandContext): Window {
  const sinceText = str(c.flags.since) ?? WORK_SINCE;
  return { since: parseSinceWhen(sinceText).ms, sinceText };
}

/** `--stage`: the stages named, repeated or as a comma list, each once. An unknown one is a usage error (exit 2). */
export function stagesFlag(c: Pick<CommandContext, "flags">): Stage[] {
  const out: Stage[] = [];
  for (const raw of listFlag(c.flags.stage).flatMap((v) => v.split(","))) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (!(STAGES as readonly string[]).includes(v)) {
      const near = suggest(v, STAGES);
      throw new UsageError(`--stage must be one of ${STAGES.join(", ")}, got ${JSON.stringify(raw.trim())}`, { reason: "invalid_argument", suggestion: near ? `--stage ${near}` : undefined });
    }
    if (!out.includes(v as Stage)) out.push(v as Stage);
  }
  return out;
}

async function list(c: CommandContext): Promise<number> {
  const { out } = c;
  const limit = positiveInt(c.flags.limit, "limit") ?? num(c.flags.limit) ?? 20;
  const w = windowOf(c);
  const agents = agentsFlag(c);
  const repo = str(c.flags.repo);
  const place = repo ? parsePlace(repo, c.cwd, c.env.HOME || c.env.USERPROFILE || "/") : undefined;
  const stages = stagesFlag(c);
  // A stage filter lists hidden items too: --stage done lists what the queue hides.
  const all = c.flags.all === true || stages.length > 0;
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const overlay = readOverlay(ctx.paths.work);
    const { sessions, truncated } = await loadWorkSessions(ctx.index, { since: w.since });
    const q = buildWorkQueue(sessions, { all, overlay, agents, place, stages });
    if (!q.items.length && agents.length) await rejectAgentTypos(ctx.index, agents);
    await distinctFiles(ctx, q.items.slice(0, limit), sessions);
    if (out.json) {
      out.data({ ...workJson(q, { since: w.since, limit, truncated }), ...pendingField(backlog) });
      return 0;
    }
    printQueue(c, q, { limit, all, stages, window: w, truncated, backlog });
    return 0;
  });
}

/**
 * An item whose files several sessions changed counts each path once, as `work show` does: a
 * sum of the sessions' own counts would count a path two sessions touched twice.
 */
async function distinctFiles(ctx: Context, items: readonly WorkItem[], sessions: readonly Session[]): Promise<void> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const i of items) {
    const changers = i.sessionIds.filter((id) => (byId.get(id)?.stats.filesChanged ?? 0) > 0).length;
    if (changers > 1) await workFiles(ctx.index, i, sessions);
  }
}

function printQueue(c: CommandContext, q: WorkQueue, o: { limit: number; all: boolean; stages: readonly Stage[]; window: Window; truncated: boolean; backlog: IngestBacklog }): void {
  const { out } = c;
  out.print(`${out.style("Work", "bold")}  ${countsLine(q.counts)}  ${out.style(`(since ${o.window.sinceText})`, "faint")}`);
  out.print(`${out.style("Stages", "faint")}  ${stagesLine(q.stages)}`);
  if (q.noPromptSignal.length) out.print(out.style(`No prompt signal from ${q.noPromptSignal.join(", ")}: their waits show as stalled.`, "faint"));
  if (o.truncated) out.note(`Read the newest sessions only: narrow --since.`);
  if (o.backlog.pendingFiles) out.note(`${plural(o.backlog.pendingFiles, "capture")} not yet ingested; --fresh waits for them.`);
  const shown = q.items.slice(0, o.limit);
  let bucket: string | undefined | null = null;
  for (const i of shown) {
    const head = i.bucket ? BUCKET_LABELS[i.bucket] : "Hidden";
    if (head !== bucket) {
      out.print("");
      out.print(out.style(head, "bold"));
      bucket = head;
    }
    printRow(c, i);
  }
  for (const g of q.groups) out.print(out.style(`  ${g.cause} x${g.count}: ${g.items.join(", ")}`, "faint"));
  if (q.items.length > o.limit) out.note(`${q.items.length - o.limit} more: --limit ${q.items.length}`);
  if (!shown.length && o.stages.length) {
    out.print("");
    out.print(`No items in ${o.stages.join(" or ")} since ${o.window.sinceText}.`);
    return;
  }
  if (!shown.length) {
    out.print("");
    out.print(q.hidden ? `Nothing needs you. ${plural(q.hidden, "item")} running, done, acknowledged or snoozed.` : `No agent sessions since ${o.window.sinceText}.`);
    if (q.hidden && !o.all) out.next("See every item", "coding.sh work --all");
    else if (!q.hidden) out.next("Widen the window", "coding.sh work --since 30d");
    return;
  }
  const first = shown.find((i) => i.bucket);
  if (first) out.next("See what the first item needs", `coding.sh work show ${first.id}`);
}

function printRow(c: CommandContext, i: WorkItem): void {
  const { out } = c;
  const badge = i.probablyClosed ? `${out.style("probably closed", "yellow")}  ` : "";
  const agents = i.agents.length > 1 ? `${i.agent} +${i.agents.length - 1}` : i.agent;
  const where = i.repo ?? i.cwd;
  const meta = [agents, where ? short(where) : undefined, i.sessionIds.length > 1 ? plural(i.sessionIds.length, "session") : undefined, i.startedBy ? `started by ${i.startedBy}` : undefined].filter(Boolean).join("  ");
  out.print(`  ${out.style(i.id, "cyan")}  ${oneLine(i.title ?? "(untitled)", 60)}  ${stageTag(i)}  ${out.style(meta, "faint")}`);
  out.print(`          ${badge}${i.reason}`);
  out.print(`          ${out.style("next:", "faint")} ${nextText(i.next)}`);
}

/**
 * An item's next step for people: core/work.ts writes a snooze end as ISO (which --json keeps); the text
 * view gives it in local time, as the snooze confirmation does.
 */
export function nextText(next: string, now = Date.now()): string {
  const m = /^snoozed until (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/.exec(next);
  return m ? `snoozed until ${localTime(Date.parse(m[1]!), now)}` : next;
}

/** "review · change", or the stage alone while the kind is not known. */
const stageTag = (i: Pick<WorkItem, "stage" | "kind">): string => (i.kind ? `${i.stage} · ${i.kind}` : i.stage);

const short = (p: string): string => (p.length > 40 ? `…${p.slice(-39)}` : p);

// ------------------------------------------------------------ one item

/** The item an id names: an item id (w + 6 hex), else a session id in one. Unknown: exit 1. */
async function findItem(c: CommandContext, ctx: Context, ref: string, overlay: WorkOverlay): Promise<{ item: WorkItem; sessions: Session[] }> {
  const w = windowOf(c);
  const { sessions } = await loadWorkSessions(ctx.index, { since: w.since });
  const pick = (ss: Session[]) => {
    const q = buildWorkQueue(ss, { all: true, overlay });
    return q.items.find((i) => i.id === ref) ?? q.items.find((i) => i.sessionIds.includes(ref) || i.rootId === ref);
  };
  let item = pick(sessions);
  if (!item && !/^w[0-9a-f]{6}$/.test(ref)) {
    // A session outside the window: add it and its stored parents, then group again.
    const s = await ctx.index.getSession(ref);
    if (s) {
      const have = new Set(sessions.map((x) => x.id));
      let cur: Session | undefined = s;
      for (let n = 0; cur && n < 20 && !have.has(cur.id); n++) {
        sessions.push(cur);
        have.add(cur.id);
        cur = cur.parent ? await ctx.index.getSession(cur.parent.sessionId) : undefined;
      }
      item = pick(sessions);
    }
  }
  if (!item) {
    throw new CliError(`Can't find work item ${JSON.stringify(ref)} since ${w.sinceText}`, { reason: "not_found", next: ["List work items, hidden ones too:", `coding.sh work --all --since ${w.sinceText}`] });
  }
  return { item, sessions };
}

function idArg(c: CommandContext): string {
  const id = c.positionals[0]?.trim();
  if (!id) throw new UsageError(`Missing argument <ID>. Usage: coding.sh work ${c.action} <id>`, { reason: "missing_argument" });
  return id;
}

async function show(c: CommandContext): Promise<number> {
  const { out } = c;
  const ref = idArg(c);
  windowOf(c);
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const overlay = readOverlay(ctx.paths.work);
    const { item, sessions } = await findItem(c, ctx, ref, overlay);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const files = new Set(await workFiles(ctx.index, item, sessions));
    const children = item.sessionIds.filter((id) => id !== item.primaryId).map((id) => byId.get(id)).filter((s): s is Session => !!s);
    if (out.json) {
      out.data({
        ...workItemJson(item),
        files: [...files].slice(0, 200),
        sessions: [item.primaryId, ...children.map((s) => s.id)].map((id) => {
          const s = byId.get(id);
          if (!s) return { id };
          const row: Record<string, unknown> = { id: s.id, agent: s.agent, title: s.title ?? null, parentSessionId: s.parent?.sessionId ?? null };
          if (s.stats.waiting) row.waiting = s.stats.waiting.kind;
          return row;
        }),
        ...pendingField(backlog),
      });
      return 0;
    }
    out.print(`${out.style(item.id, "cyan")}  ${oneLine(item.title ?? "(untitled)", 80)}`);
    out.row("State", item.bucket ? BUCKET_LABELS[item.bucket] : `hidden (${item.hidden})`, item.bucket === "blocked" || item.bucket === "failed" ? "warn" : "none", true);
    out.row("Why", `${item.probablyClosed ? "probably closed: " : ""}${item.reason}`, "none", true);
    out.row("Stage", `${stageTag(item)}: ${item.stageWhy}`, "none", true);
    const w = item.cause?.waiting;
    if (w?.text) out.row("Prompt", oneLine(w.text, 200), "none", true);
    if (w) out.row("Waiting", `${w.kind} since ${ago(w.at)}`, "none", true);
    out.row("Agent", item.agents.join(", "), "none", true);
    if (item.repo || item.cwd) out.row("Where", `${item.repo ?? item.cwd}${item.branch ? ` (${item.branch})` : ""}`, "none", true);
    out.row("Started", `${ago(item.startedAt)}, last active ${ago(item.lastActivity)}${item.running ? " (running)" : ""}`, "none", true);
    if (item.costUsd !== undefined) out.row("Cost", usd(item.costUsd), "none", true);
    if (item.startedBy) out.row("Started by", item.startedBy, "none", true);
    out.row("Files", item.filesChanged ? `${plural(item.filesChanged, "file")} changed` : "none changed", "none", true);
    for (const f of [...files].slice(0, 20)) out.print(`    ${f}`);
    if (files.size > 20) out.print(out.style(`    and ${files.size - 20} more (--json lists up to 200)`, "faint"));
    out.row("Sessions", `${item.primaryId}${children.length ? ` and ${plural(children.length, "child", "children")}` : ""}`, "none", true);
    for (const s of children.slice(0, 10)) out.print(`    ${s.id}  ${s.agent}  ${oneLine(s.title, 50)}`);
    if (children.length > 10) out.print(out.style(`    and ${children.length - 10} more: coding.sh tree ${item.primaryId}`, "faint"));
    out.row("Next", nextText(item.next), "none", true);
    return 0;
  });
}

async function ack(c: CommandContext): Promise<number> {
  const { out } = c;
  const ref = idArg(c);
  windowOf(c);
  return withContext(c, async (ctx) => {
    await autoIngest(ctx, readIngest(c));
    const overlay = readOverlay(ctx.paths.work);
    const { item } = await findItem(c, ctx, ref, overlay);
    const cause = item.bucket ? item.cause : undefined;
    if (!cause) {
      if (out.json) out.data({ id: item.id, acked: false, hidden: item.hidden ?? null });
      else out.note(`${item.id} has nothing to acknowledge (${item.hidden ?? "nothing waits"})`);
      return 0;
    }
    addAck(overlay, cause.sessionId, cause.fingerprint);
    writeOverlay(ctx.paths.work, overlay);
    // What the item shows now: the next cause, if it has one.
    const { item: after } = await findItem(c, ctx, item.id, overlay);
    if (out.json) {
      out.data({ id: item.id, acked: true, bucket: cause.bucket, fingerprint: cause.fingerprint, now: workItemJson(after) });
      return 0;
    }
    out.ok(`Acknowledged ${item.id} (${BUCKET_LABELS[cause.bucket].toLowerCase()})`);
    if (after.bucket) out.note(`It is still in the queue: ${BUCKET_LABELS[after.bucket].toLowerCase()}, ${after.reason}`);
    return 0;
  });
}

async function snooze(c: CommandContext): Promise<number> {
  const { out } = c;
  const ref = idArg(c);
  const raw = c.positionals[1];
  if (!raw) throw new UsageError("Missing argument <DURATION>. Usage: coding.sh work snooze <id> <duration>", { reason: "missing_argument", suggestion: `coding.sh work snooze ${ref} 2h` });
  const ms = parseAge(raw, "<DURATION>");
  windowOf(c);
  return withContext(c, async (ctx) => {
    await autoIngest(ctx, readIngest(c));
    const overlay = readOverlay(ctx.paths.work);
    const { item } = await findItem(c, ctx, ref, overlay);
    const now = Date.now();
    const until = now + ms;
    const bucket = item.bucket ?? item.cause?.bucket ?? "review";
    const ids = [...new Set([item.primaryId, item.cause?.sessionId ?? item.primaryId])];
    addSnooze(overlay, ids, { until, bucket });
    writeOverlay(ctx.paths.work, overlay, now);
    if (out.json) {
      out.data({ id: item.id, snoozedUntil: new Date(until).toISOString(), bucket });
      return 0;
    }
    out.ok(`Snoozed ${item.id} until ${localTime(until, now)}`);
    out.note(`It comes back sooner if it moves to a more urgent bucket than ${BUCKET_LABELS[bucket].toLowerCase()}.`);
    return 0;
  });
}

