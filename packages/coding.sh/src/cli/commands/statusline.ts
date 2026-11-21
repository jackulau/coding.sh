// coding.sh statusline: Claude Code runs the configured status line command on
// every turn with session JSON on stdin; we print one line (model, context fill, this
// session's cost, today's cost, the worst flag, a stopped ingest, plan usage) and exit 0
// even on error, so a missing store or bad input never disrupts the agent. `install`/`uninstall`
// wire settings.statusLine, backed up and restored byte-for-byte.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { CLAUDE_AGENT, claudeConfigDir } from "../../adapters/claude-code.ts";
import {
  applyChanges,
  isObject,
  parseJsonObject,
  planEdit,
  readTextIfExists,
  stringifyJsonLike,
} from "../../adapters/_shared/files.ts";
import { forgetInstall, installRecord, recordInstall, sha256 } from "../../adapters/_shared/installs.ts";
import { ingestStoppedField, ingestStoppedJson, readIngestStopped } from "../../core/ingest-health.ts";
import { loadConfig } from "../../core/config.ts";
import { paths } from "../../core/paths.ts";
import { fileUrlPath, parseStoreUrl } from "../../store/factory.ts";
import { budgetPart, highest, readBudgets, statuslineStatuses, type BudgetStatus } from "../../budget/index.ts";
import type { Context } from "../../core/context.ts";
import type { IndexStore, Session } from "../../core/types.ts";
import { needYou, readWorkQueue, WORK_WINDOW_MS } from "../../core/work.ts";
import { readOverlay } from "../../core/work-overlay.ts";
import { claudeRateLimits, quotaPart, round4, saveClaudeQuota, spendJson } from "../../quota/index.ts";
import { autoIngest, readBudgetMs, withContext } from "../common.ts";
import { CliError } from "../output.ts";
import { contextPart, ingestStoppedPart, statuslineLine, worstFailureFlag } from "../statusline.ts";
import type { CommandContext } from "../types.ts";

// The command Claude Code runs. coding.sh is on PATH after a global install.
const STATUSLINE_COMMAND = "coding.sh statusline";
// Recognises a status line as ours, whether the plain command or a bundle path.
const OURS = /coding\.sh\s+statusline|statusline\.mjs/;

export async function run(c: CommandContext): Promise<number> {
  if (c.action === "install") return install(c);
  if (c.action === "uninstall") return uninstall(c);
  return print(c);
}

/**
 * How long the status line spends reading new hook events before it answers. Claude Code runs it on
 * every turn: a short budget keeps it quick, and what is left goes to a background ingest.
 */
export const STATUSLINE_INGEST_BUDGET_MS = 400;

/** The status-line payload is a few kB; past this the read stops and the input counts as invalid. */
export const MAX_STATUSLINE_STDIN = 1 << 20;

/**
 * How long the status line waits for stdin to close. Claude Code writes a few kB and closes the
 * pipe at once; with a writer that keeps it open, the line prints from what arrived by then.
 * 1 s plus the 400 ms ingest budget keeps such a render under 2 s.
 */
export const STATUSLINE_STDIN_MS = 1000;

/**
 * Stdin, read without blocking the event loop so Ctrl-C still stops it (undefined then), and at
 * most `max` bytes: endless input (`</dev/zero`, a stuck pipe writer) ends the read, never memory.
 * A stdin still open after `limitMs` ends the read with what arrived. A TTY (manual run with no
 * pipe) returns "".
 */
export function readStdin(
  signal: AbortSignal,
  stdin: Readable & { isTTY?: boolean } = process.stdin,
  max = MAX_STATUSLINE_STDIN,
  limitMs = STATUSLINE_STDIN_MS,
): Promise<string | undefined> {
  if (stdin.isTTY) return Promise.resolve("");
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const finish = (v: string | undefined) => {
      clearTimeout(timer);
      stdin.off("data", onData).off("end", onEnd).off("error", onError);
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onData = (d: Buffer | string) => {
      const b = typeof d === "string" ? Buffer.from(d) : d;
      chunks.push(b.subarray(0, max - total));
      total += b.length;
      if (total < max) return;
      stdin.destroy(); // no more reads: whatever follows is not a status-line payload
      finish("");
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString("utf8"));
    const onError = () => finish("");
    const onAbort = () => {
      stdin.destroy();
      finish(undefined);
    };
    // A writer that never closes stdin: stop reading, so the process can exit, and use what came.
    const timer = setTimeout(() => {
      stdin.destroy();
      onEnd();
    }, limitMs);
    stdin.on("data", onData).on("end", onEnd).on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function stdinModel(payload: unknown): string | undefined {
  if (!isObject(payload) || !isObject(payload.model)) return undefined;
  const m = payload.model;
  if (typeof m.display_name === "string") return m.display_name;
  if (typeof m.id === "string") return m.id;
  return undefined;
}

/** How full the context window is (`context_window.used_percentage`), when it is a number from 0 to 100. */
export function stdinContextPercent(payload: unknown): number | undefined {
  if (!isObject(payload) || !isObject(payload.context_window)) return undefined;
  const p = payload.context_window.used_percentage;
  return typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 100 ? p : undefined;
}

/** The budget part over the sessions the line already read for its `today` figure, so the two agree. */
async function budgetPartOf(index: IndexStore, env: NodeJS.ProcessEnv, today: readonly Session[]): Promise<{ part: string; status: BudgetStatus } | undefined> {
  const budgets = readBudgets(env);
  if (!budgets.length) return undefined;
  const statuses = await statuslineStatuses(index, budgets, today, env);
  const part = budgetPart(statuses);
  return part ? { part, status: highest(statuses)! } : undefined;
}

async function print(c: CommandContext): Promise<number> {
  let payload: unknown = {};
  const text = await readStdin(c.signal);
  if (text === undefined) return 130; // Ctrl-C while the payload was still coming
  try {
    payload = JSON.parse(text);
  } catch {
    // no/invalid stdin: still print today's total below
  }
  const sid = isObject(payload) && typeof payload.session_id === "string" ? payload.session_id : undefined;
  const model = stdinModel(payload);
  const contextPercent = stdinContextPercent(payload);
  const contextField = contextPercent === undefined ? {} : { contextPercent: round4(contextPercent) };
  // Plan usage (`5h 62% 7d 41% spend 63%`), when this Claude Code sends rate_limits; saved for `coding.sh quota`.
  const quota = claudeRateLimits(payload);
  const quotaSuffix = quota.length ? `  ·  ${quotaPart(quota)}` : "";
  const quotaField = quota.length
    ? { quota: quota.map((w) => ({ window: w.window, usedPercent: round4(w.usedPercent), resetsAt: w.resetsAt === undefined ? null : new Date(w.resetsAt).toISOString(), ...spendJson(w) })) }
    : {};
  try {
    saveClaudeQuota(paths(c.env).quota, quota);
  } catch {
    // a reading not saved is only a stale `coding.sh quota`
  }
  try {
    // Rendering the line never makes a store: with no SQLite file and nothing spooled for one,
    // the line has the model and plan usage from stdin and no costs yet.
    if (sqliteStoreMissing(c)) {
      const stopped = readIngestStopped(paths(c.env).ingestStopped);
      if (c.out.json) c.out.data({ model: model ?? null, ...contextField, sessionCostUsd: null, todayCostUsd: 0, worstFlag: null, ...ingestStoppedField(stopped), ...quotaField });
      else c.out.print(statuslineLine({ model, contextPercent, todayCostUsd: 0, ingestStoppedSince: stopped?.since }) + quotaSuffix);
      return 0;
    }
    return await withContext(c, async (ctx) => {
      // The hook spools events; without reading them the "need you" count lags until some other
      // command ingests (a new permission prompt missed, an answered one still counted).
      try {
        await autoIngest(ctx, { env: c.env, budgetMs: Math.min(readBudgetMs(c.env), STATUSLINE_INGEST_BUDGET_MS), lockWaitMs: 0 });
      } catch {
        // show what is indexed
      }
      const session = sid ? await ctx.index.getSession(sid) : undefined;
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      // Every session that started today, subagents too: the spend budget status, usage and stats count.
      const today = await ctx.index.listSessions({ since: dayStart.getTime() });
      const todayCostUsd = today.reduce((sum, s) => sum + (s.stats.usage?.costUsd ?? 0), 0);
      const sessionCostUsd = session?.stats.usage?.costUsd;
      const flags = session?.flags;
      const stopped = readIngestStopped(ctx.paths.ingestStopped);
      // Spend budgets (`budget 82%`), once the highest passes 80%. A budget problem never breaks the line.
      const budget = await budgetPartOf(ctx.index, c.env, today).catch(() => undefined);
      const budgetSuffix = budget ? `  ·  ${budget.part}` : "";
      const budgetField = budget ? { budget: { id: budget.status.budget.id, percent: round4(budget.status.percent), over: budget.status.over } } : {};
      const need = await needYouCount(ctx);
      if (c.out.json) {
        const doc: Record<string, unknown> = {
          model: model ?? session?.model ?? null,
          ...contextField,
          sessionCostUsd: sessionCostUsd === undefined ? null : round4(sessionCostUsd),
          todayCostUsd: round4(todayCostUsd),
          worstFlag: flags ? (worstFailureFlag(flags) ?? null) : null,
        };
        if (need) doc.needYou = need;
        c.out.data({ ...doc, ...ingestStoppedField(stopped), ...quotaField, ...budgetField });
      } else {
        c.out.print(statuslineLine({ model: model ?? session?.model, contextPercent, sessionCostUsd, todayCostUsd, flags, ingestStoppedSince: stopped?.since, needYou: need }) + quotaSuffix + budgetSuffix);
      }
      return 0;
    });
  } catch {
    // Never break Claude Code's status line. A store that can't be opened has no costs
    // to show, but a stopped ingest is the one thing worth saying about it.
    try {
      const stopped = readIngestStopped(paths(c.env).ingestStopped);
      if (stopped && c.out.json) c.out.data({ model: model ?? null, ...contextField, sessionCostUsd: null, todayCostUsd: null, worstFlag: null, ingestStopped: ingestStoppedJson(stopped), ...quotaField });
      else if (stopped) {
        const ctxPart = contextPercent === undefined ? undefined : contextPart(contextPercent);
        c.out.print([model, ctxPart, ingestStoppedPart(stopped.since)].filter(Boolean).join("  ·  ") + quotaSuffix);
      }
    } catch {
      // nothing to print
    }
    return 0;
  }
}

/**
 * Whether the configured index is a SQLite file that does not exist yet (opening it would create
 * it) and the hook has spooled nothing to ingest into one.
 */
function sqliteStoreMissing(c: CommandContext): boolean {
  if (existsSync(paths(c.env).spool)) return false;
  try {
    const { scheme, rest } = parseStoreUrl(loadConfig({ env: c.env, cwd: c.cwd }).store.index);
    return scheme === "sqlite" && rest !== ":memory:" && !existsSync(fileUrlPath(rest, { env: c.env }));
  } catch {
    return false; // a config problem is withContext's to report (and the catch below swallows it)
  }
}

/** Work items blocked on you or failed, over `coding.sh work`'s default window; 0 when they can't be read. */
async function needYouCount(ctx: Context): Promise<number> {
  try {
    const { queue } = await readWorkQueue(ctx.index, { since: Date.now() - WORK_WINDOW_MS, overlay: readOverlay(ctx.paths.work) });
    return needYou(queue);
  } catch {
    return 0; // the costs still print
  }
}

function userSettings(c: CommandContext): string {
  return join(claudeConfigDir(c.env), "settings.json");
}

/**
 * The status line's own record in installs.json. It sits beside init's record
 * for settings.json, never over it: uninstalling the status line puts back the
 * bytes from right before it was installed, and init's restore point stays.
 */
const recordKey = (file: string): string => `${file}#statusline`;

function currentCommand(cfg: Record<string, unknown>): string | undefined {
  const sl = isObject(cfg.statusLine) ? cfg.statusLine : undefined;
  return sl && typeof sl.command === "string" ? sl.command : undefined;
}

async function install(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const file = userSettings(c);
  const before = readTextIfExists(file);
  const cfg = parseJsonObject(file, before);
  const existing = currentCommand(cfg);
  const oursAlready = existing !== undefined && OURS.test(existing);
  if (existing !== undefined && !oursAlready && !c.flags.force) {
    throw new CliError(`Claude Code already has a status line: ${existing}`, {
      reason: "statusline_exists",
      askUser: true,
      next: ["Replace it (the old one is restored on uninstall):", "coding.sh statusline install --force"],
    });
  }
  const after = stringifyJsonLike({ ...cfg, statusLine: { type: "command", command: STATUSLINE_COMMAND, padding: 0 } }, before);
  if (before !== undefined && JSON.stringify(parseJsonObject(file, after)) === JSON.stringify(cfg)) {
    out.note("coding.sh status line is already installed");
    return 0;
  }
  const change = planEdit(file, before, after, "install coding.sh status line");
  if (!change) {
    out.note("coding.sh status line is already installed");
    return 0;
  }
  if (c.flags["dry-run"]) {
    out.print(`Would write statusLine into ${file}`);
    return 0;
  }
  await applyChanges([change], {
    agent: CLAUDE_AGENT,
    dryRun: false,
    env,
    onApplied(ch, backup) {
      // The restore point is the bytes right before this install (null: the file did not exist).
      // A file that already held our status line keeps the record it has.
      const known = installRecord(recordKey(ch.path), env);
      const restore = oursAlready ? (known?.restore ?? undefined) : ch.before === undefined ? null : backup;
      recordInstall(CLAUDE_AGENT, recordKey(ch.path), ch.after ?? "", env, Date.now(), oursAlready && known === undefined ? undefined : restore);
    },
  });
  out.print(`Installed the coding.sh status line into ${file}`);
  out.note("Claude Code shows it on the next turn. Remove it with: coding.sh statusline uninstall");
  return 0;
}

async function uninstall(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const file = userSettings(c);
  const text = readTextIfExists(file);
  if (text === undefined) {
    out.note("No Claude Code settings.json; nothing to remove");
    return 0;
  }
  const cfg = parseJsonObject(file, text);
  const existing = currentCommand(cfg);
  if (existing === undefined || !OURS.test(existing)) {
    out.note("No coding.sh status line found");
    return 0;
  }

  // statusLine is a single value, so uninstall must restore the previous one,
  // not merely strip ours. While the file is byte-identical to our last write
  // (nothing changed since install), restore the recorded original exactly;
  // otherwise fall back to removing only our statusLine key.
  const rec = installRecord(recordKey(file), env);
  const owned = rec !== undefined && rec.restore !== undefined && rec.sha256 === sha256(text);
  let change;
  if (owned && rec.restore === null) {
    change = planEdit(file, text, undefined, "remove coding.sh status line (delete the file coding.sh created)");
  } else if (owned && typeof rec.restore === "string") {
    let original: string | undefined;
    try {
      original = readFileSync(rec.restore, "utf8");
    } catch {
      original = undefined; // backup gone: strip instead
    }
    change =
      original !== undefined
        ? planEdit(file, text, original, "restore settings.json as it was before the status line")
        : stripChange(file, text, cfg, env);
  } else {
    change = stripChange(file, text, cfg, env);
  }
  if (!change) {
    out.note("No coding.sh status line found");
    return 0;
  }
  if (c.flags["dry-run"]) {
    out.print(`Would remove the statusLine from ${file}`);
    return 0;
  }
  await applyChanges([change], { agent: CLAUDE_AGENT, dryRun: false, env, onApplied: (ch) => forgetInstall(recordKey(ch.path), env) });
  out.print(`Removed the coding.sh status line from ${file}`);
  return 0;
}

/**
 * The file changed since install (init, or Claude Code adding a permission): keep those
 * changes and swap only our statusLine back to the one install replaced, read from the
 * restore point. With no earlier status line, remove ours; delete the file if that
 * empties one we created.
 */
function stripChange(file: string, text: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const rest = { ...cfg };
  delete rest.statusLine;
  const rec = installRecord(recordKey(file), env);
  const previous = typeof rec?.restore === "string" ? previousStatusLine(file, rec.restore) : undefined;
  if (previous !== undefined) return planEdit(file, text, stringifyJsonLike({ ...cfg, statusLine: previous }, text), "restore the status line coding.sh replaced");
  const createdByUs = rec?.restore === null;
  const empty = Object.keys(rest).length === 0 && createdByUs;
  return planEdit(file, text, empty ? undefined : stringifyJsonLike(rest, text), "remove coding.sh status line");
}

/** The statusLine in the restore point's bytes, when it held one that is not ours. */
function previousStatusLine(file: string, backup: string): unknown {
  try {
    const cfg = parseJsonObject(file, readFileSync(backup, "utf8"));
    const command = currentCommand(cfg);
    return cfg.statusLine !== undefined && !(command !== undefined && OURS.test(command)) ? cfg.statusLine : undefined;
  } catch {
    return undefined; // a backup gone or unreadable: remove ours
  }
}
