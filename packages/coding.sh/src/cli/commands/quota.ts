// coding.sh quota [--json]: plan usage for the 5-hour and weekly windows, one row per agent and
// window. Claude Code's reading is the one `coding.sh statusline` saved to quota.json; Codex's is
// the last token_count in the tail of its newest rollouts.
// coding.sh quota wait [--agent A] [--window 5h|7d] [--below 90]: blocks until the window resets or
// its use drops under the threshold. Exit 0 when there is room, 1 with no reading, 130 on Ctrl-C.
import { setTimeout as sleep } from "node:timers/promises";
import { codexHome } from "../../adapters/codex.ts";
import { paths } from "../../core/paths.ts";
import { hasRoom, quotaJson, quotaReport, type QuotaReading, type QuotaReport } from "../../quota/index.ts";
import { UsageError } from "../args.ts";
import { CliError, ago, duration, localTime } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** `quota wait` reads the files again at most this often. */
export const REREAD_MS = 60_000;
const DEFAULT_BELOW = 90;

export async function run(c: CommandContext): Promise<number> {
  if (c.action === "wait") return wait(c);
  return show(c);
}

function report(c: CommandContext): QuotaReport {
  return quotaReport({ claudeFile: paths(c.env).quota, codexHome: codexHome(c.env) });
}

function resets(w: QuotaReading, now: number): string {
  if (w.resetsAt === undefined) return "-";
  if (w.resetsAt <= now) return "reset";
  return `in ${duration(w.resetsAt - now)}`;
}

const pct = (n: number): string => `${Math.round(n)}%`;

function show(c: CommandContext): number {
  const now = Date.now();
  const r = report(c);
  if (c.out.json) {
    c.out.data(quotaJson(r, now));
    return 0;
  }
  if (r.windows.length) {
    c.out.table(
      ["AGENT", "WINDOW", "USED", "RESETS", "READ"],
      r.windows.map((w) => [w.agent, w.window, pct(w.usedPercent), resets(w, now), ago(w.readAt, { now })]),
    );
  }
  for (const m of r.missing) c.out.note(`${m.agent}: no reading. ${m.how}`);
  return 0;
}

function waitFlags(c: CommandContext): { agent?: string; window?: string; below: number } {
  const agent = typeof c.flags.agent === "string" ? c.flags.agent : undefined;
  const window = typeof c.flags.window === "string" ? c.flags.window : undefined;
  const below = typeof c.flags.below === "number" ? c.flags.below : DEFAULT_BELOW;
  if (!(below > 0 && below <= 100)) throw new UsageError(`--below must be a percent above 0 and at most 100, got ${below}`, { suggestion: `--below ${DEFAULT_BELOW}` });
  return { agent, window, below };
}

function select(r: QuotaReport, f: { agent?: string; window?: string }): QuotaReading[] {
  return r.windows.filter((w) => (f.agent === undefined || w.agent === f.agent) && (f.window === undefined || w.window === f.window));
}

function waitingFor(w: QuotaReading, below: number, now: number): string {
  const reset = w.resetsAt === undefined ? "" : ` or reset at ${localTime(w.resetsAt, now)} (in ${duration(w.resetsAt - now)})`;
  return `${w.agent} ${w.window} at ${pct(w.usedPercent)} to drop below ${below}%${reset}`;
}

async function wait(c: CommandContext): Promise<number> {
  const f = waitFlags(c);
  let lastRead = Date.now();
  let windows = select(report(c), f);
  if (!windows.length) {
    const scope = [f.agent, f.window].filter(Boolean).join(" ");
    const r = report(c);
    const how = r.missing.filter((m) => f.agent === undefined || m.agent === f.agent).map((m) => `${m.agent}: ${m.how}`);
    throw new CliError(`No plan usage reading${scope ? ` for ${scope}` : ""}`, { reason: "no_quota_reading", next: how.length ? how : ["See what there is:", "coding.sh quota"] });
  }
  let announced = false;
  for (;;) {
    const now = Date.now();
    const pending = windows.filter((w) => !hasRoom(w, f.below, now));
    if (!pending.length) {
      c.out.data({ ok: true, ...quotaJson({ windows, missing: [] }, now) });
      return 0;
    }
    if (!announced) {
      c.out.note(`Waiting for ${pending.map((w) => waitingFor(w, f.below, now)).join("; ")}`);
      announced = true;
    }
    // Wake at the next re-read or the nearest reset, whichever comes first.
    const resetAt = Math.min(...pending.map((w) => w.resetsAt ?? Infinity));
    const until = Math.min(lastRead + REREAD_MS, resetAt);
    try {
      await sleep(Math.max(10, until - now), undefined, { signal: c.signal });
    } catch {
      return 130;
    }
    if (Date.now() >= lastRead + REREAD_MS) {
      lastRead = Date.now();
      const fresh = select(report(c), f);
      if (fresh.length) windows = fresh; // a reading gone since keeps the one we had
    }
  }
}
