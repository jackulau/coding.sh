// Durable long runs from the CLI: open or resume a job (src/jobs/store.ts) for
// exp run, exp aa, exp sweep, compare and workflows run, and the flags they share.
//
// `--resume <id>` continues that run; `--resume` alone continues the newest
// unfinished run of the same kind with the same config hash. Without the flag,
// an unfinished run with the same config is offered (interactive) or pointed
// at (otherwise) and a new run starts. A config that changed refuses to resume:
// finished trials of one config mixed with new trials of another would be a
// result of neither.
import { positiveInt, UsageError } from "./args.ts";
import { num, str } from "./common.ts";
import { ago, CliError, duration, plural, usd } from "./output.ts";
import type { CommandContext } from "./types.ts";
import { configChanges } from "../jobs/config.ts";
import { RESUME_ID } from "../jobs/flags.ts";
import { infraStopText, retryPolicy, type InfraStopReport, type RetryPolicy } from "../jobs/retry.ts";
import { JobStore, type Job, type JobConfig, type JobKind, type JobView } from "../jobs/store.ts";

/** The retry policy from --retries and --stop-after-infra. */
export function retryFlag(c: CommandContext): RetryPolicy {
  const whole = (flag: string): number | undefined => {
    const raw = num(c.flags[flag]);
    if (raw !== undefined && (!Number.isInteger(raw) || raw < 0)) throw new UsageError(`--${flag} must be a whole number ≥ 0, got ${raw}`, { reason: "invalid_argument" });
    return raw;
  };
  return retryPolicy(c.env, whole("retries"), whole("stop-after-infra"));
}

/** --trial-timeout in ms. */
export function trialTimeout(c: CommandContext): number | undefined {
  const s = positiveInt(c.flags["trial-timeout"], "trial-timeout");
  return s === undefined ? undefined : s * 1000;
}

/** The command line to show for resuming: as given, `--resume [ID]` dropped. */
function commandLine(c: CommandContext): string[] | undefined {
  if (!c.argv) return undefined;
  const out: string[] = [];
  for (let i = 0; i < c.argv.length; i++) {
    const t = c.argv[i]!;
    if (t === "--resume") {
      if (c.argv[i + 1] !== undefined && RESUME_ID.test(c.argv[i + 1]!)) i++;
      continue;
    }
    if (t.startsWith("--resume=")) continue;
    out.push(t);
  }
  return out;
}

/** `coding.sh <command> --resume <id>`, the way to continue a job. */
export function resumeCommand(h: { id: string; command?: string[]; kind: JobKind; name: string }): string {
  if (h.kind === "bench run") return `coding.sh bench run ${h.name} --resume ${h.id}`;
  const base = h.command?.length ? h.command.map(shellWord).join(" ") : h.kind;
  return `coding.sh ${base} --resume ${h.id}`;
}

function shellWord(w: string): string {
  return /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

function mismatch(v: JobView, now: JobConfig): CliError {
  const parts = configChanges(v.header.config, now);
  return new CliError(`Can't resume ${v.header.id}: its config changed since it started (${parts.join(", ") || "config"}). Its finished trials would mix with trials of a different config`, {
    reason: "config_changed",
    next: ["Restore the original config, or start a new run without --resume"],
  });
}

function describe(v: JobView): string {
  const p = v.progress;
  return `${v.header.id} (${p.done}/${p.total} trials finished${p.infra ? `, ${p.infra} hit infra errors` : ""}, started ${ago(v.header.createdAt)})`;
}

/**
 * The job this run checkpoints to: a resumed one (--resume, or yes to the
 * offer) or a new one with id `newId()`.
 */
export async function openJob(c: CommandContext, o: { kind: JobKind; name: string; config: JobConfig; newId: () => string; concurrency: number }): Promise<Job> {
  const store = JobStore.forEnv(c.env);
  const flag = c.flags.resume;
  const ref = str(flag);
  const command = commandLine(c);
  const opts = { concurrency: o.concurrency, ...(command ? { command } : {}) };
  const open = (v: JobView) => v.status !== "completed" && v.status !== "running";
  if (ref) {
    const v = await store.find(ref);
    if (!v) throw new CliError(`No run ${JSON.stringify(ref)} to resume`, { reason: "not_found", next: ["List runs and their progress:", "coding.sh exp status"] });
    if (v.header.kind !== o.kind) throw new CliError(`${v.header.id} is a ${v.header.kind} run, not ${o.kind}`, { reason: "invalid_argument", next: ["Resume it with:", resumeCommand(v.header)] });
    if (v.status === "completed") throw new CliError(`${v.header.id} already finished; nothing to resume`, { reason: "already_complete" });
    if (v.status === "running") {
      const s = v.header.sessions.at(-1);
      throw new CliError(`${v.header.id} is still running (pid ${s?.pid ?? "?"} on ${s?.host ?? "?"}); stop it first`, { reason: "busy" });
    }
    if (v.header.config.hash !== o.config.hash) throw mismatch(v, o.config);
    return store.resume(v.header.id, opts);
  }
  const unfinished = (await store.list({ kind: o.kind })).filter(open);
  const same = unfinished.find((v) => v.header.config.hash === o.config.hash);
  if (flag === true) {
    if (same) return store.resume(same.header.id, opts);
    const named = unfinished.find((v) => v.header.name === o.name);
    if (named) throw mismatch(named, o.config);
    throw new CliError(`No unfinished \`${o.kind}\` run with this config to resume`, { reason: "not_found", next: ["List runs and their progress:", "coding.sh exp status"] });
  }
  if (same && flag !== false) {
    if (c.out.interactive) {
      if (await c.out.confirm(`An unfinished run with the same config exists: ${describe(same)}. Resume it?`, { defaultYes: true })) return store.resume(same.header.id, opts);
    } else {
      c.out.note(`An unfinished run with the same config exists: ${describe(same)}. Starting a new one; to continue it instead: ${resumeCommand({ ...same.header, ...(command ? { command } : {}) })}`);
    }
  }
  return store.create({ id: o.newId(), kind: o.kind, name: o.name, config: o.config, total: 0, concurrency: o.concurrency, ...(command ? { command } : {}) });
}

/**
 * Trials already finished in the job that `--resume` names or finds, so a
 * consent prompt can count only the runs still to go. 0 without `--resume`,
 * or when openJob would refuse or start a new job.
 */
export async function finishedToResume(c: CommandContext, kind: JobKind, config: JobConfig): Promise<number> {
  const flag = c.flags.resume;
  if (flag === undefined || flag === false) return 0;
  const store = JobStore.forEnv(c.env);
  const ref = str(flag);
  const open = (v: JobView) => v.status !== "completed" && v.status !== "running";
  const v = ref ? await store.find(ref) : (await store.list({ kind })).find((x) => open(x) && x.header.config.hash === config.hash);
  return v && open(v) && v.header.kind === kind && v.header.config.hash === config.hash ? v.progress.done : 0;
}

/**
 * End the session: interrupted when cancelled, incomplete when infra-failed
 * trials remain (a run that stopped on an infra streak among them), else completed.
 */
export async function finishJob(job: Job, cancelled: boolean, infraStop?: InfraStopReport): Promise<void> {
  await job.finish(cancelled && !infraStop ? "interrupted" : job.infraCount() ? "incomplete" : "completed");
}

/** After a run that stopped on an infra streak: say why, in plain words (the --json output carries `infraStop`). */
export function infraStopNote(c: CommandContext, stop: InfraStopReport | undefined): void {
  if (stop && !c.out.json) c.out.warn(infraStopText(stop));
}

/** For --json output: how to continue a run that stopped short. */
export function resumeField(job: Job): { resume?: string } {
  const s = job.header.status;
  return s === "completed" || s === "running" ? {} : { resume: resumeCommand(job.header) };
}

/** After a run: say how to pick it up again when it stopped short. */
export function resumeNote(c: CommandContext, job: Job): void {
  const s = job.header.status;
  if (s === "completed" || s === "running") return;
  const n = job.infraCount();
  const why = s === "incomplete" ? `${plural(n, "trial")} still hit infrastructure errors after retries` : "interrupted";
  c.out.note(`${why}; finished trials are saved. Continue with: ${resumeCommand(job.header)}`);
}

/** One job as `exp status --json` reports it. */
export function jobJson(v: JobView) {
  const h = v.header;
  const p = v.progress;
  const open = v.status === "interrupted" || v.status === "incomplete";
  return {
    id: h.id,
    kind: h.kind,
    name: h.name,
    status: v.status,
    done: p.done,
    total: p.total,
    infra: p.infra,
    retries: p.retries,
    costUsd: p.costKnown ? p.costUsd : null,
    costKnown: p.costKnown,
    etaMs: p.etaMs ?? null,
    activeMs: p.activeMs,
    concurrency: h.concurrency,
    sessions: h.sessions.length,
    createdAt: new Date(h.createdAt).toISOString(),
    updatedAt: new Date(h.updatedAt).toISOString(),
    config: h.config.hash.slice(0, 12),
    records: h.refs,
    resume: open ? resumeCommand(h) : null,
  };
}

/** `coding.sh exp status [<run>]`: progress, ETA and cost so far of durable runs. */
export async function statusCommand(c: CommandContext): Promise<number> {
  const { out } = c;
  const store = JobStore.forEnv(c.env);
  const ref = c.positionals[0];
  if (ref) {
    const v = await store.find(ref);
    if (!v) throw new CliError(`No run ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List runs:", "coding.sh exp status"] });
    if (out.json) {
      out.data({ run: jobJson(v) });
      return 0;
    }
    const j = jobJson(v);
    const rows: [string, string][] = [
      ["run", `${j.id} (${j.kind} ${j.name})`],
      ["status", j.status],
      ["progress", `${j.done}/${j.total} trials${j.infra ? `, ${j.infra} hit infra errors (run again on resume)` : ""}${j.retries ? `, ${plural(j.retries, "retry", "retries")}` : ""}`],
      ["eta", j.etaMs === null ? "-" : duration(j.etaMs)],
      ["cost so far", j.costUsd === null ? "unknown" : `${usd(j.costUsd)} (${j.costKnown} of ${j.done + j.infra} trials report cost)`],
      ["running for", `${duration(j.activeMs)} over ${plural(j.sessions, "session")}`],
      ["updated", ago(v.header.updatedAt)],
    ];
    if (j.records.length) rows.push(["records", j.records.join(" ")]);
    if (j.resume) rows.push(["resume", j.resume]);
    const w = Math.max(...rows.map((r) => r[0].length));
    out.print(rows.map(([k, x]) => `${k.padEnd(w)}  ${x}`).join("\n"));
    return 0;
  }
  const limit = positiveInt(c.flags.limit, "limit") ?? 20;
  const all = (await store.list()).slice(0, limit);
  if (out.json) {
    out.data({ runs: all.map(jobJson) });
    return 0;
  }
  if (!all.length) {
    out.note("No runs yet: exp run, exp aa, exp sweep, compare, bench run and workflows run show up here");
    return 0;
  }
  out.table(
    ["ID", "KIND", "NAME", "STATUS", "PROGRESS", "ETA", "COST", "UPDATED"],
    all.map((v) => {
      const p = v.progress;
      return [v.header.id, v.header.kind, v.header.name, v.status, `${p.done}/${p.total}${p.infra ? ` +${p.infra} infra` : ""}`, p.etaMs === undefined ? "-" : duration(p.etaMs), p.costKnown ? usd(p.costUsd) : "-", ago(v.header.updatedAt)];
    }),
  );
  const open = all.filter((v) => v.status === "interrupted" || v.status === "incomplete");
  for (const v of open) out.note(`resume ${v.header.id}: ${resumeCommand(v.header)}`);
  return 0;
}
