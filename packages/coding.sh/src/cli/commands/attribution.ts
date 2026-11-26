// coding.sh attribution [export]: which captured agent session wrote the
// lines each commit added (src/attribution), and the same as Agent Trace
// records (agent-trace.dev). Read-only on git.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AttributionError, attributeRepo, type AttributeOptions, type AttributionReport } from "../../attribution/index.ts";
import { agentTraceRecords, AGENT_TRACE_VERSION } from "../../attribution/export.ts";
import type { Context } from "../../core/context.ts";
import { version } from "../meta.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { printedRefs } from "../../core/session-ref.ts";
import { autoIngest, emptyStateNext, oneLine, readIngest, str, withContext } from "../common.ts";
import { cliCommand, nextStepBin, widerSince } from "../next-steps.ts";
import { CliError, localTime, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** The command that ran: the next steps name it, with its own arguments. */
export type AttributionCommand = "attribution" | "blame";

/** `env` names the CLI in the next steps as the user's shell runs it (nextStepBin). */
export function attributionCliError(e: unknown, command: AttributionCommand = "attribution", env: NodeJS.ProcessEnv = process.env): unknown {
  if (!(e instanceof AttributionError)) return e;
  const bin = nextStepBin(env);
  const withRepo = command === "blame" ? `${bin} blame <path> --repo <dir>` : `${bin} attribution --repo <dir>`;
  if (e.reason === "not_a_repo") return new CliError(e.message, { reason: "not_a_repo", next: ["Run it inside a git repository, or pass one:", withRepo] });
  if (e.reason === "unknown_rev") return new CliError(e.message, { reason: "unknown_rev", next: ["List branches and commits:", "git log --oneline -n 20"] });
  if (e.reason === "invalid_range") return new UsageError(e.message, { reason: "invalid_argument" });
  if (e.reason === "not_found") return new CliError(e.message, { reason: "not_found", next: e.next ?? ["See the files git tracks:", "git ls-files"] });
  return new CliError(e.message, { reason: e.reason, next: ["See the options:", `${bin} ${command} --help`] });
}

/** Shared by attribution and blame: repo, rev, since, and a progress line on stderr. */
export async function report(c: CommandContext, ctx: Context, extra: Partial<AttributeOptions> = {}, command: AttributionCommand = "attribution"): Promise<AttributionReport> {
  await autoIngest(ctx, readIngest(c));
  const since = str(c.flags.since);
  const spin = c.out.spin("Matching commits to sessions");
  try {
    return await attributeRepo(ctx, {
      cwd: resolve(c.cwd, str(c.flags.repo) ?? "."),
      ...(str(c.flags.rev) ? { rev: str(c.flags.rev)! } : {}),
      ...(since ? { since: parseSince(since) } : {}),
      store: true,
      ...extra,
    });
  } catch (e) {
    throw attributionCliError(e, command, c.env);
  } finally {
    spin.stop();
  }
}

const short = (sha: string) => sha.slice(0, 8);

/** The same attribution from further back than `since`, with the --repo, --rev and --all given. */
function furtherBack(c: CommandContext, since: number): string {
  const args = ["attribution", "--since", widerSince(since)];
  const repo = str(c.flags.repo);
  if (repo) args.push("--repo", repo);
  const rev = str(c.flags.rev);
  if (rev) args.push("--rev", rev);
  if (c.flags.all === true) args.push("--all");
  return cliCommand(c.env, args);
}

async function list(c: CommandContext, ctx: Context): Promise<number> {
  const { out } = c;
  const bin = nextStepBin(c.env);
  const limit = positiveInt(c.flags.limit, "limit") ?? 50;
  const r = await report(c, ctx);
  const newest = [...r.commits].reverse();
  const shown = c.flags.all === true ? newest : newest.filter((x) => x.attributed > 0);
  const added = r.commits.reduce((n, x) => n + x.added, 0);
  const attributed = r.commits.reduce((n, x) => n + x.attributed, 0);
  if (out.json) {
    out.data({
      root: r.root,
      rev: r.rev,
      since: new Date(r.since).toISOString(),
      gitAi: r.gitAi,
      totals: { commits: r.commits.length, linesAdded: added, linesAttributed: attributed },
      sessions: r.sessions.map((s) => ({ ...s, startedAt: new Date(s.startedAt).toISOString() })),
      commits: shown.slice(0, limit).map((x) => ({ ...x, committedAt: new Date(x.committedAt).toISOString(), authoredAt: new Date(x.authoredAt).toISOString() })),
    });
    return 0;
  }
  if (!r.commits.length) {
    out.note(`No commits since ${localTime(r.since)} on ${short(r.rev)}`);
    out.next("Look further back", furtherBack(c, r.since));
    return 0;
  }
  const pct = added ? Math.round((attributed / added) * 100) : 0;
  out.print(`${plural(r.commits.length, "commit")} since ${localTime(r.since)}: ${attributed} of ${added} added lines by ${plural(r.sessions.length, "session")} (${pct}%)`);
  if (!shown.length) {
    out.print("No commit has lines a captured session wrote.");
    if (!r.considered) {
      // No session ran here, so capture is not what to check. Without --since every session in the repo
      // was read, so a wider window finds none either: the step shows where the stored sessions ran.
      const typed = str(c.flags.since) !== undefined;
      out.print(typed ? `No captured session ran in this repo since ${localTime(r.since)}.` : "No captured session ran in this repo.");
      const widen = typed ? { label: "Look further back", command: furtherBack(c, r.since) } : { label: "See which repos your sessions ran in", command: cliCommand(c.env, ["sessions", "--facets", "repo"]) };
      // On a store with no session at all, the step is how the first one gets here instead.
      await emptyStateNext(out, c.env, ctx.index, widen);
    } else if (!r.sources) out.next("Sessions in this repo need an end snapshot or edit tool calls; check capture", `${bin} doctor`);
    return 0;
  }
  out.print();
  // A session prints the shortest reference that opens it alone: every stored id is read once.
  const refs = await printedRefs(ctx.index, { short: shown.slice(0, limit).flatMap((x) => x.attributions.map((a) => a.sessionId)) });
  out.table(
    ["COMMIT", "DATE", "AGENT LINES", "SESSIONS", "SUBJECT"],
    shown.slice(0, limit).map((x) => [
      short(x.commit),
      localTime(x.committedAt),
      `${x.attributed}/${x.added}`,
      [...new Set(x.attributions.map((a) => `${refs.short(a.sessionId)} ${a.agent}`))].join(", ") || "-",
      oneLine(x.subject, 60),
    ]),
  );
  if (shown.length > limit) out.note(`${shown.length - limit} more; --limit ${shown.length} shows all`);
  if (r.sessions[0]) out.next("See which lines of a file each session wrote", `${bin} blame <path>`);
  return 0;
}

async function exportTrace(c: CommandContext, ctx: Context): Promise<number> {
  const { out } = c;
  const format = str(c.flags.format) ?? "agent-trace";
  if (format !== "agent-trace") throw new UsageError(`unknown --format ${format} (expected agent-trace)`);
  const viewerUrl = str(c.flags["viewer-url"]);
  if (viewerUrl !== undefined) {
    let u: URL | undefined;
    try {
      u = new URL(viewerUrl);
    } catch {
      // not a URL
    }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) throw new UsageError(`--viewer-url ${JSON.stringify(viewerUrl)} is not an http or https URL`, { reason: "invalid_argument", suggestion: `${nextStepBin(c.env)} attribution export --viewer-url http://127.0.0.1:4319` });
  }
  const r = await report(c, ctx);
  const records = agentTraceRecords(r, { toolVersion: version(), ...(viewerUrl ? { viewerUrl } : {}) });
  const file = str(c.flags.out);
  if (file) {
    const path = resolve(c.cwd, file);
    writeFileSync(path, records.map((x) => JSON.stringify(x) + "\n").join(""));
    if (out.json) out.data({ path, version: AGENT_TRACE_VERSION, records: records.length });
    else {
      out.ok(`${plural(records.length, "trace record")} (one per commit with agent lines)`);
      out.print(path);
    }
    return 0;
  }
  if (out.json) {
    out.data({ version: AGENT_TRACE_VERSION, records });
    return 0;
  }
  for (const x of records) out.print(JSON.stringify(x));
  if (!records.length) out.note("No commit has lines a captured session wrote");
  return 0;
}

export async function run(c: CommandContext): Promise<number> {
  return withContext(c, (ctx) => (c.action === "export" ? exportTrace(c, ctx) : list(c, ctx)));
}
