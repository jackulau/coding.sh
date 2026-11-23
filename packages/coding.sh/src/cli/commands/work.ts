// coding.sh work [--all] [--stage <list>] [--repo <path>] [--agent <name>] [--since 7d] [--limit 20]
// coding.sh work show|ack|snooze <id>: what needs you across every agent's sessions
// (core/work.ts), with acks and snoozes in work.json (core/work-overlay.ts).
import { parsePlace } from "../../mcp/data.ts";
import type { PullRequestRef, Session } from "../../schema/index.ts";
import type { Context } from "../../core/context.ts";
import { indexAge, staleIndexText, type IndexAge } from "../../core/ingest-health.ts";
import { addAck, addSnooze, readOverlay, writeOverlay, type WorkOverlay } from "../../core/work-overlay.ts";
import { BUCKET_LABELS, BUCKETS, buildWorkQueue, countsLine, itemWorkflowAgents, loadWorkSessions, settleWorkFiles, STAGES, stagesLine, workFiles, workItemJson, workJson, type Stage, type WorkItem, type WorkPhase, type WorkQueue } from "../../core/work.ts";
import { parseAge, parseSinceWhen, positiveInt, suggest, UsageError } from "../args.ts";
import { agentsFlag, autoIngest, list as listFlag, num, oneLine, pendingField, readIngest, rejectAgentTypos, resolveSession, str, withContext, type IngestBacklog } from "../common.ts";
import { ago, CliError, localTime, plural, usd } from "../output.ts";
import { IdSet, matchRef, MAX_CANDIDATES, MIN_ID_PREFIX, shortener } from "../../core/session-ref.ts";
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
    const stale = staleIndex(ctx);
    const overlay = readOverlay(ctx.paths.work);
    const { sessions, truncated } = await loadWorkSessions(ctx.index, { since: w.since });
    // Next steps name sessions by the shortest id that resolves (core/session-ref.ts).
    const q = buildWorkQueue(sessions, { all, overlay, agents, place, stages, now: stale?.at, shortId: await shortener(ctx.index) });
    if (!q.items.length && agents.length) await rejectAgentTypos(ctx.index, agents);
    // The shown items count and name their files as `work show` does (core/work.ts settleWorkFiles).
    await settleWorkFiles(ctx.index, q.items.slice(0, limit), sessions, stale?.at);
    if (out.json) {
      out.data({ ...workJson(q, { since: w.since, limit, truncated }), ...staleIndexField(stale), ...pendingField(backlog) });
      return 0;
    }
    printQueue(c, q, { limit, all, stages, window: w, truncated, backlog, stale });
    return 0;
  });
}

/**
 * The index's age while it is old (core/ingest-health.ts): no ingest has finished for longer than
 * a stall takes and none runs. The queue is then judged as of the last ingest, so an agent that was
 * active just before it is not called stalled. A store named by --store or CODING_SH_STORE_URL is
 * filled elsewhere, so this home's record says nothing about it.
 */
function staleIndex(ctx: Context): IndexAge | undefined {
  if (ctx.storeOverridden) return undefined;
  const age = indexAge(ctx.paths.root);
  return age?.stale ? age : undefined;
}

/** `indexUpdatedAt` and `asOf` (the time the queue was judged at) for --json, only while the index is old. */
function staleIndexField(stale: IndexAge | undefined): { indexUpdatedAt?: string; asOf?: string } {
  if (!stale) return {};
  const at = new Date(stale.at).toISOString();
  return { indexUpdatedAt: at, asOf: at };
}

function printQueue(c: CommandContext, q: WorkQueue, o: { limit: number; all: boolean; stages: readonly Stage[]; window: Window; truncated: boolean; backlog: IngestBacklog; stale?: IndexAge }): void {
  const { out } = c;
  out.print(`${out.style("Work", "bold")}  ${countsLine(q.counts)}  ${out.style(`(since ${o.window.sinceText})`, "faint")}`);
  out.print(`${out.style("Stages", "faint")}  ${stagesLine(q.stages)}`);
  if (o.stale) out.print(out.style(staleIndexText(o.stale), "yellow"));
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
  const meta = [agents, where ? short(where) : undefined, i.sessionIds.length > 1 ? plural(i.sessionIds.length, "session") : undefined, i.startedBy ? `started by ${i.startedBy}` : undefined, i.prs ? prsText(i.prs, i.repoMain ?? i.repo ?? i.cwd) : undefined].filter(Boolean).join("  ");
  out.print(`  ${out.style(i.id, "cyan")}  ${oneLine(i.title ?? "(untitled)", 60)}  ${stageTag(i)}  ${out.style(meta, "faint")}`);
  if (i.workflow) out.print(`          ${out.style("phases:", "faint")} ${i.workflow.phases.map(phaseText).join(" · ")}`);
  out.print(`          ${badge}${i.reason}`);
  out.print(`          ${out.style("next:", "faint")} ${nextText(i.next)}`);
}

/** How a PR's state reads: an opened PR is open. */
export const prStateText = (state: PullRequestRef["state"]): string => (state === "opened" ? "open" : state);

/**
 * How a PR is named next to an item: "#12" for a PR of the item's own repo, "owner/name#12" for one of
 * another repo. A PR repo is the item's own when its name is the item folder's name (in a linked worktree,
 * the main checkout's folder: callers pass WorkItem.repoMain first). When none is (a
 * clone can sit in a folder of another name), the PRs are its own while they all share one repo and the
 * sessions opened, merged or closed them: a PR only linked, such as one read for research, is not.
 */
export function prRef(p: PullRequestRef, prs: readonly PullRequestRef[], itemRepo?: string): string {
  if (!p.repo) return `#${p.number}`;
  const name = (r: string) => r.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.toLowerCase();
  const folder = itemRepo ? name(itemRepo) : undefined;
  const named = folder !== undefined && prs.some((x) => x.repo !== undefined && name(x.repo) === folder);
  const own = named ? name(p.repo) === folder : new Set(prs.map((x) => x.repo ?? "")).size === 1 && p.state !== "linked";
  return own ? `#${p.number}` : `${p.repo}#${p.number}`;
}

/** "PR #12 merged", "PRs #12, #14 open", "PRs #12 merged; #14 open": an item's PRs by state, in the order first seen. */
export function prsText(prs: readonly PullRequestRef[], itemRepo?: string): string {
  const byState = new Map<string, string[]>();
  for (const p of prs) byState.set(prStateText(p.state), [...(byState.get(prStateText(p.state)) ?? []), prRef(p, prs, itemRepo)]);
  const groups = [...byState].map(([state, ns]) => `${ns.slice(0, 5).join(", ")}${ns.length > 5 ? ` +${ns.length - 5}` : ""} ${state}`);
  return `${prs.length === 1 ? "PR" : "PRs"} ${groups.join("; ")}`;
}

/** "build: 2 running, 1 failed, 3 done", the agents of one phase of a workflow run by state. */
export function phaseText(p: WorkPhase): string {
  const states = (["running", "failed", "done"] as const).filter((k) => p[k]).map((k) => `${p[k]} ${k}`);
  return `${p.name ?? "no phase"}: ${states.join(", ")}`;
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

/**
 * What matchItem finds: the item, or for a prefix several items' ids share the newest MAX_CANDIDATES
 * of them and whether there are more, or nothing.
 */
export type ItemMatch = { item: WorkItem; sessions: Session[]; shortId: (id: string) => string } | { ambiguous: WorkItem[]; more: boolean } | undefined;

/**
 * The item an id names: an item id (w + 6 hex), or a prefix of at least MIN_ID_PREFIX characters that
 * one item's id in the window starts with (matched as session ids are, core/session-ref.ts matchRef),
 * else a session in one, by any reference `show` takes (`resolve`, which returns undefined for none:
 * a prefix, a subagent id, latest). `shortId` is how the item's next step names a session. `work show`
 * and the MCP work tool's `id` find an item this way, and each words its own errors.
 */
export async function matchItem(ctx: Context, ref: string, since: number, overlay: WorkOverlay, now: number | undefined, resolve: (ref: string) => Promise<Session | undefined>): Promise<ItemMatch> {
  const { sessions } = await loadWorkSessions(ctx.index, { since });
  const shortId = await shortener(ctx.index);
  const queue = (ss: Session[]) => buildWorkQueue(ss, { all: true, overlay, now, shortId }).items;
  // A session id names the item it is in before a run item it started (whose rootId it is).
  const pick = (items: WorkItem[], id: string) => items.find((i) => i.id === id) ?? items.find((i) => i.sessionIds.includes(id)) ?? items.find((i) => i.rootId === id);
  const items = queue(sessions);
  let item = pick(items, ref);
  const m = item ? undefined : matchRef(new IdSet(items.map((i) => i.id)), ref);
  if (m && "ambiguous" in m) {
    const ids = new Set(m.ambiguous);
    const all = items.filter((i) => ids.has(i.id)).sort((x, y) => y.startedAt - x.startedAt);
    return { ambiguous: all.slice(0, MAX_CANDIDATES), more: all.length > MAX_CANDIDATES };
  }
  if (m) item = items.find((i) => i.id === m.id);
  if (!item && !/^w[0-9a-f]{6}$/.test(ref)) {
    // Any other reference to a session: its full id, then the item it is in. A session outside the
    // window is added with its stored parents, and the sessions grouped again.
    const s = await resolve(ref);
    if (s) {
      item = pick(items, s.id);
      const have = new Set(sessions.map((x) => x.id));
      let cur: Session | undefined = item ? undefined : s;
      for (let n = 0; cur && n < 20 && !have.has(cur.id); n++) {
        sessions.push(cur);
        have.add(cur.id);
        cur = cur.parent ? await ctx.index.getSession(cur.parent.sessionId) : undefined;
      }
      item ??= pick(queue(sessions), s.id);
    }
  }
  return item && { item, sessions, shortId };
}

/** matchItem in the window of --since. Unknown: exit 1; an ambiguous prefix lists its candidates. */
async function findItem(c: CommandContext, ctx: Context, ref: string, overlay: WorkOverlay, now?: number): Promise<{ item: WorkItem; sessions: Session[]; shortId: (id: string) => string }> {
  const w = windowOf(c);
  const found = await matchItem(ctx, ref, w.since, overlay, now, (r) =>
    resolveSession(ctx, r).catch((e: unknown) => {
      if (e instanceof CliError && e.reason === "not_found") return undefined;
      throw e;
    }),
  );
  if (found && "ambiguous" in found) throw ambiguousItemError(ref, found, w);
  if (!found) {
    // A reference too short to look up says so, as `show` does.
    const short = ref.length < MIN_ID_PREFIX && ref !== "latest" && ref !== "last" ? ` (an id prefix needs at least ${MIN_ID_PREFIX} characters)` : "";
    throw new CliError(`Can't find work item ${JSON.stringify(ref)} since ${w.sinceText}${short}`, { reason: "not_found", next: ["List work items, hidden ones too:", `coding.sh work --all --since ${w.sinceText}`] });
  }
  return found;
}

/** A prefix several items' ids share, worded as the CLI words an ambiguous session id prefix (resolveSession), newest first. */
function ambiguousItemError(ref: string, { ambiguous: shown, more }: { ambiguous: WorkItem[]; more: boolean }, w: Window): CliError {
  const lines = shown.map((i) => `  ${i.id}  ${i.agent}  ${ago(i.startedAt)}  ${oneLine(i.title ?? "", 50)}`.trimEnd());
  if (more) lines.push(`  …and more`);
  return new CliError(`Work item id prefix ${JSON.stringify(ref)} is ambiguous. It matches:\n${lines.join("\n")}`, {
    reason: "ambiguous",
    next: ["Pass one of these ids, more of the id, or list work items:", `coding.sh work --all --since ${w.sinceText}`],
    data: { candidates: shown.map((i) => ({ id: i.id, agent: i.agent, startedAt: new Date(i.startedAt).toISOString(), title: i.title ?? null })), more },
  });
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
    const stale = staleIndex(ctx);
    const overlay = readOverlay(ctx.paths.work);
    const { item, sessions, shortId } = await findItem(c, ctx, ref, overlay, stale?.at);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const files = new Set(await workFiles(ctx.index, item, sessions));
    const children = item.sessionIds.filter((id) => id !== item.primaryId).map((id) => byId.get(id)).filter((s): s is Session => !!s);
    const agents = itemWorkflowAgents(item, sessions, stale?.at ?? Date.now());
    // filesChanged covers every session of the item; the main session's own count is what `show <sessionId>` reports.
    const own = mainFilesChanged(item, byId);
    if (out.json) {
      out.data({
        ...workItemJson(item),
        // JSON.stringify drops an undefined field: no sessionFilesChanged without a count, and an item that is
        // no workflow run has no workflowAgents.
        sessionFilesChanged: own,
        workflowAgents: item.workflow ? agents.map(({ startedAt, ...a }) => ({ ...a, startedAt: new Date(startedAt).toISOString() })) : undefined,
        files: [...files].slice(0, 200),
        sessions: [item.primaryId, ...children.map((s) => s.id)].map((id) => {
          const s = byId.get(id);
          if (!s) return { id };
          const row: Record<string, unknown> = { id: s.id, agent: s.agent, title: s.title ?? null, parentSessionId: s.parent?.sessionId ?? null };
          if (s.stats.waiting) row.waiting = s.stats.waiting.kind;
          return row;
        }),
        ...staleIndexField(stale),
        ...pendingField(backlog),
      });
      return 0;
    }
    out.print(`${out.style(item.id, "cyan")}  ${oneLine(item.title ?? "(untitled)", 80)}`);
    if (stale) out.print(out.style(staleIndexText(stale), "yellow"));
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
    if (item.workflow) {
      out.row("Workflow", `${item.workflow.name ? `${item.workflow.name}, ` : ""}run ${item.workflow.id}, ${plural(agents.length, "agent")}`, "none", true);
      for (const p of item.workflow.phases) {
        out.print(`    ${phaseText(p)}${p.costUsd !== undefined ? `  ${usd(p.costUsd)}` : ""}`);
        const inPhase = agents.filter((a) => a.phase === p.name);
        for (const a of inPhase.slice(0, 20)) {
          const cost = a.costUsd !== undefined ? usd(a.costUsd) : "";
          out.print(`      ${shortId(a.sessionId)}  ${a.state}  ${oneLine(a.label ?? a.title ?? "(untitled)", 50)}${cost ? `  ${cost}` : ""}`);
        }
        if (inPhase.length > 20) out.print(out.style(`      and ${inPhase.length - 20} more (--json lists every agent)`, "faint"));
      }
    }
    if (item.prs) {
      const prs = item.prs;
      const ref = (p: PullRequestRef) => prRef(p, prs, item.repoMain ?? item.repo ?? item.cwd);
      out.row(prs.length === 1 ? "PR" : "PRs", prs.map((p) => `${ref(p)} ${prStateText(p.state)}`).join(", "), "none", true);
      for (const p of prs) out.print(`    ${ref(p)}  ${prStateText(p.state)}  ${p.url ?? "(no URL: the sessions named it by number only)"}  ${out.style(ago(p.at), "faint")}`);
    }
    out.row("Files", `${item.filesChanged ? `${plural(item.filesChanged, "file")} changed` : "none changed"}${own !== undefined ? ` across ${plural(item.sessionIds.length, "session")}; the main session changed ${own}` : ""}`, "none", true);
    for (const f of [...files].slice(0, 20)) out.print(`    ${f}`);
    if (files.size > 20) out.print(out.style(`    and ${files.size - 20} more (--json lists up to 200)`, "faint"));
    if (item.workflow) {
      // A workflow run's agents are siblings under its orchestrator, not children of the first one, and the
      // orchestrator's tree holds every run it made: the item's own --json lists exactly these.
      const members = [byId.get(item.primaryId), ...children].filter((s): s is Session => !!s);
      out.row("Sessions", `${plural(item.sessionIds.length, "agent")} of run ${item.workflow.id}`, "none", true);
      for (const s of members.slice(0, 10)) out.print(`    ${shortId(s.id)}  ${s.agent}  ${oneLine(s.title, 50)}`);
      if (members.length > 10) out.print(out.style(`    and ${members.length - 10} more: ${out.command(`coding.sh work show ${item.id} --json`)}`, "faint"));
    } else {
      out.row("Sessions", `${shortId(item.primaryId)}${children.length ? ` and ${plural(children.length, "child", "children")}` : ""}`, "none", true);
      for (const s of children.slice(0, 10)) out.print(`    ${shortId(s.id)}  ${s.agent}  ${oneLine(s.title, 50)}`);
      if (children.length > 10) out.print(out.style(`    and ${children.length - 10} more: coding.sh tree ${shortId(item.primaryId)}`, "faint"));
    }
    out.row("Next", nextText(item.next), "none", true);
    return 0;
  });
}

/**
 * The main session's own files-changed count (its stats.filesChanged, as `show` reports it), when
 * the item has other sessions whose files its filesChanged also counts; undefined otherwise.
 */
export function mainFilesChanged(item: Pick<WorkItem, "primaryId" | "sessionIds">, byId: ReadonlyMap<string, Session>): number | undefined {
  if (!item.sessionIds.some((id) => id !== item.primaryId)) return undefined;
  return byId.get(item.primaryId)?.stats.filesChanged;
}

async function ack(c: CommandContext): Promise<number> {
  const { out } = c;
  const ref = idArg(c);
  windowOf(c);
  return withContext(c, async (ctx) => {
    await autoIngest(ctx, readIngest(c));
    // Judged as the list was: an old index acknowledges what `work` showed, not a stall that came of its age.
    const asOf = staleIndex(ctx)?.at;
    const overlay = readOverlay(ctx.paths.work);
    const { item } = await findItem(c, ctx, ref, overlay, asOf);
    const cause = item.bucket ? item.cause : undefined;
    if (!cause) {
      if (out.json) out.data({ id: item.id, acked: false, hidden: item.hidden ?? null });
      else out.note(`${item.id} has nothing to acknowledge (${item.hidden ?? "nothing waits"})`);
      return 0;
    }
    addAck(overlay, cause.sessionId, cause.fingerprint);
    writeOverlay(ctx.paths.work, overlay);
    // What the item shows now: the next cause, if it has one.
    const { item: after } = await findItem(c, ctx, item.id, overlay, asOf);
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
    // Blocked is the most urgent bucket: nothing brings the item back sooner, not even a new prompt.
    if (bucket === BUCKETS[0]) out.note(`Nothing is more urgent than ${BUCKET_LABELS[bucket].toLowerCase()}, so it stays hidden until then, even if it waits on you again.`);
    else out.note(`It comes back sooner if it moves to a more urgent bucket than ${BUCKET_LABELS[bucket].toLowerCase()}.`);
    return 0;
  });
}

