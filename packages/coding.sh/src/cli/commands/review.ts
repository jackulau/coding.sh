// coding.sh review create <queue> --where <q> --config <name> [--sample n] [--assign <name>]
//                  | list | status <queue> | next <queue> | done <queue> <item> <value> | skip <queue> <item>
//
// A review queue (src/scores/review.ts): the sessions a query matched, scored by hand one at
// a time with one score config. done writes a human score through addScore, the path
// `coding.sh score add` takes, so a value that does not fit the config is refused (exit 2).
import { QueryError } from "../../query/where.ts";
import { shortener } from "../../core/session-ref.ts";
import { cliError as scoreCliError, readValue } from "../../scores/cli.ts";
import { completeItem, configValues, createQueue, listQueues, nextItem, queueStatus, ReviewError, skipItem, type NextItem } from "../../scores/review.ts";
import { addScore, listScoreConfigs, ScoreError, whoami } from "../../scores/scores.ts";
import { positiveInt, shellQuote, UsageError } from "../args.ts";
import { queryCliError, str, withContext } from "../common.ts";
import { cliCommand } from "../next-steps.ts";
import { ago, CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

/**
 * A ReviewError, QueryError or ScoreError as the CLI reports it: bad input exits 2, the rest 1.
 * With `env`, a query that matched nothing is printed for the user's shell.
 */
export function reviewCliError(e: unknown, raw?: string, config?: string, env?: NodeJS.ProcessEnv): unknown {
  if (e instanceof QueryError) return queryCliError(e, raw);
  if (e instanceof ScoreError) return scoreCliError(e);
  if (!(e instanceof ReviewError)) return e;
  switch (e.reason) {
    case "bad_name":
    case "bad_value":
      return new UsageError(e.message, { reason: "invalid_value" });
    case "no_review":
      return new CliError(e.message, { reason: "unsupported_store", next: ["coding.sh config get store.index shows which store is in use"] });
    case "unknown_config":
      // Name the config the user asked for, when it is one `score config` would take as typed.
      return new CliError(e.message, { reason: "not_found", next: ["Add a config, e.g.:", `coding.sh score config ${config && /^[\w.-]+$/.test(config) ? config : "<name>"} --type boolean`] });
    case "unknown_queue":
      return new CliError(e.message, { reason: "not_found", next: ["List the queues:", "coding.sh review list"] });
    case "unknown_item":
      return new CliError(e.message, { reason: "not_found" });
    case "queue_exists":
      return new CliError(e.message, { reason: "conflict", next: ["List the queues:", "coding.sh review list"] });
    case "no_match":
      return new CliError(e.message, { reason: "not_found", next: ["See what a query matches:", raw && env ? cliCommand(env, ["sessions", "--where", raw]) : "coding.sh sessions --where '<query>'"] });
    default:
      return new CliError(e.message, { reason: e.reason });
  }
}

const fail = (raw?: string, config?: string, env?: NodeJS.ProcessEnv) => (e: unknown) => Promise.reject(reviewCliError(e, raw, config, env));

/** A queue's next item, its command named for the user's shell, as --json prints it. */
const shown = (c: CommandContext, it: NextItem | undefined) => (it ? { ...it, command: c.out.command(it.command) } : null);

export async function run(c: CommandContext): Promise<number> {
  switch (c.action) {
    case "create":
      return create(c);
    case "list":
      return list(c);
    case "status":
      return status(c);
    case "next":
      return next(c);
    case "done":
      return done(c);
    case "skip":
      return skip(c);
    default:
      throw new UsageError(`unknown action ${JSON.stringify(c.action)}`);
  }
}

async function create(c: CommandContext): Promise<number> {
  const { out } = c;
  const name = c.positionals[0]!;
  const where = str(c.flags.where);
  if (where === undefined) throw new UsageError("--where is required: the sessions to review, e.g. --where 'is:flagged agent:codex'", { reason: "missing_value" });
  const config = str(c.flags.config);
  if (config === undefined) throw new UsageError("--config is required: the score config every item is scored with (coding.sh score configs)", { reason: "missing_value" });
  const sample = positiveInt(c.flags.sample, "sample");
  const assign = str(c.flags.assign);
  if (assign !== undefined && !assign.trim()) throw new UsageError("--assign needs a name", { reason: "missing_value" });
  return withContext(c, async (ctx) => {
    const r = await createQueue(ctx.index, { name, where, config, sample, assign: assign?.trim() }).catch(fail(where.trim(), config.trim(), c.env));
    if (out.json) {
      out.data({ queue: r.queue, total: r.items.length, matched: r.matched });
      return 0;
    }
    const of = r.items.length < r.matched ? ` (of ${r.matched} matching)` : "";
    out.ok(`Made review queue ${r.queue.name}: ${plural(r.items.length, "session")}${of}, scored with ${r.queue.config}${assign ? `, for ${assign.trim()}` : ""}`);
    out.next("Review the first one", `coding.sh review next ${r.queue.name}`);
    return 0;
  });
}

async function list(c: CommandContext): Promise<number> {
  const { out } = c;
  return withContext(c, async (ctx) => {
    const queues = await listQueues(ctx.index).catch(fail());
    if (out.json) {
      out.data({ queues });
      return 0;
    }
    if (!queues.length) {
      out.note("No review queues yet");
      out.next("Make one from a query", "coding.sh review create <queue> --where '<query>' --config <score config>");
      return 0;
    }
    out.table(
      ["QUEUE", "CONFIG", "DONE", "SKIPPED", "TOTAL", "CREATED", "WHERE"],
      queues.map((q) => [q.queue, q.config, String(q.done), String(q.skipped), String(q.total), ago(q.createdAt), q.where]),
    );
    return 0;
  }, { create: false });
}

async function status(c: CommandContext): Promise<number> {
  const { out } = c;
  const name = c.positionals[0]!;
  return withContext(c, async (ctx) => {
    const s = await queueStatus(ctx.index, name).catch(fail());
    if (out.json) {
      out.data(s);
      return 0;
    }
    const pending = s.total - s.done - s.skipped;
    out.print(`${s.queue}: ${s.done} done, ${s.skipped} skipped, ${pending} pending of ${s.total} (config ${s.config})`);
    if (pending) out.next("Review the next one", `coding.sh review next ${s.queue}`);
    return 0;
  }, { create: false });
}

async function next(c: CommandContext): Promise<number> {
  const { out } = c;
  const name = c.positionals[0]!;
  return withContext(c, async (ctx) => {
    const it = await nextItem(ctx.index, name).catch(fail());
    if (out.json) {
      out.data({ next: shown(c, it) });
      return 0;
    }
    if (!it) {
      out.ok(`Review queue ${name} is done: no pending items`);
      out.next("See its counts", `coding.sh review status ${name}`);
      return 0;
    }
    // The session by a reference that opens it when pasted (core/session-ref.ts): a full id can need quoting, or be `latest`.
    const session = (await shortener(ctx.index))(it.targetId);
    out.print(`Item ${it.item} of ${name} (${plural(it.pending, "pending item")})`);
    out.print(`  session  ${session}`);
    if (it.agent) out.print(`  agent    ${it.agent}`);
    if (it.title) out.print(`  title    ${it.title.replace(/[\r\n\t]+/g, " ").slice(0, 120)}`);
    if (it.flags.length) out.print(`  flags    ${it.flags.join(", ")}`);
    if (it.assignee) out.print(`  for      ${it.assignee}`);
    out.next("Read it", `coding.sh show ${shellQuote(session)}`);
    out.next(`Score it (${it.config}: ${it.values})`, it.command);
    return 0;
  }, { create: false });
}

async function done(c: CommandContext): Promise<number> {
  const { out } = c;
  const [name, item, raw] = c.positionals as [string, string, string];
  return withContext(c, async (ctx) => {
    const configs = await listScoreConfigs(ctx.index).catch((e) => Promise.reject(scoreCliError(e)));
    const comment = str(c.flags.comment);
    const by = whoami();
    const write = async (body: Record<string, unknown>) => {
      const config = configs.find((x) => x.id === body.configId);
      const value = readValue(raw, config?.dataType);
      return (await addScore(ctx.index, { ...body, value }, { by, source: "human", now: Date.now() })).score;
    };
    const r = await completeItem(ctx.index, name, item, raw, write, { comment }).catch(fail());
    const after = await nextItem(ctx.index, name).catch(fail());
    if (out.json) {
      out.data({ item: r.item, score: r.score, next: shown(c, after) });
      return 0;
    }
    const session = (await shortener(ctx.index))(r.item.targetId);
    out.ok(`Scored item ${r.item.id} of ${name}: ${r.score.name} = ${String(r.score.value)} on session ${session}`);
    if (after) out.next(`Next: item ${after.item} (${after.config}: ${configValues(configs.find((x) => x.name === after.config))})`, `coding.sh review next ${name}`);
    else out.note(`Review queue ${name} is done`);
    return 0;
  });
}

async function skip(c: CommandContext): Promise<number> {
  const { out } = c;
  const [name, item] = c.positionals as [string, string];
  return withContext(c, async (ctx) => {
    const it = await skipItem(ctx.index, name, item).catch(fail());
    const after = await nextItem(ctx.index, name).catch(fail());
    if (out.json) {
      out.data({ item: it, next: shown(c, after) });
      return 0;
    }
    out.ok(`Skipped item ${it.id} of ${name}`);
    if (after) out.next(`Next: item ${after.item}`, `coding.sh review next ${name}`);
    else out.note(`Review queue ${name} is done`);
    return 0;
  });
}
