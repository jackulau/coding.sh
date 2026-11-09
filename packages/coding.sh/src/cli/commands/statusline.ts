// coding.sh statusline: Claude Code runs the configured status line command on
// every turn with session JSON on stdin; we print one line (model, this
// session's cost, today's cost, the worst flag) and exit 0 even on error, so a
// missing store or bad input never disrupts the agent. `install`/`uninstall`
// wire settings.statusLine, backed up and restored byte-for-byte.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_AGENT, claudeConfigDir } from "../../adapters/claude-code.ts";
import {
  applyChanges,
  isObject,
  parseJsonObject,
  planEdit,
  readTextIfExists,
  stringifyJsonLike,
} from "../../adapters/_shared/files.ts";
import { existedBeforeInstall, forgetInstall, installRecord, recordInstall, restoreForInstall, sha256 } from "../../adapters/_shared/installs.ts";
import { withContext } from "../common.ts";
import { CliError } from "../output.ts";
import { statuslineLine, worstFailureFlag } from "../statusline.ts";
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

/** Synchronous stdin read; a TTY (manual run with no pipe) returns "". */
function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function stdinModel(payload: unknown): string | undefined {
  if (!isObject(payload) || !isObject(payload.model)) return undefined;
  const m = payload.model;
  if (typeof m.display_name === "string") return m.display_name;
  if (typeof m.id === "string") return m.id;
  return undefined;
}

async function print(c: CommandContext): Promise<number> {
  let payload: unknown = {};
  try {
    payload = JSON.parse(readStdin());
  } catch {
    // no/invalid stdin: still print today's total below
  }
  const sid = isObject(payload) && typeof payload.session_id === "string" ? payload.session_id : undefined;
  const model = stdinModel(payload);
  try {
    return await withContext(c, async (ctx) => {
      const session = sid ? await ctx.index.getSession(sid) : undefined;
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const today = await ctx.index.listSessions({ since: dayStart.getTime(), parentSessionId: null });
      const todayCostUsd = today.reduce((sum, s) => sum + (s.stats.usage?.costUsd ?? 0), 0);
      const sessionCostUsd = session?.stats.usage?.costUsd;
      const flags = session?.flags;
      if (c.out.json) {
        c.out.data({
          model: model ?? session?.model ?? null,
          sessionCostUsd: sessionCostUsd ?? null,
          todayCostUsd,
          worstFlag: flags ? (worstFailureFlag(flags) ?? null) : null,
        });
      } else {
        c.out.print(statuslineLine({ model: model ?? session?.model, sessionCostUsd, todayCostUsd, flags }));
      }
      return 0;
    });
  } catch {
    // Never break Claude Code's status line.
    return 0;
  }
}

function userSettings(c: CommandContext): string {
  return join(claudeConfigDir(c.env), "settings.json");
}

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
      const pristine = !oursAlready; // the file did not already hold our status line
      recordInstall(CLAUDE_AGENT, ch.path, ch.after ?? "", env, Date.now(), restoreForInstall(ch.path, ch.before, pristine, backup, env));
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
  const rec = installRecord(file, env);
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
  await applyChanges([change], { agent: CLAUDE_AGENT, dryRun: false, env, onApplied: (ch) => forgetInstall(ch.path, env) });
  out.print(`Removed the coding.sh status line from ${file}`);
  return 0;
}

/** Remove only our statusLine key; delete the file if that empties one we created. */
function stripChange(file: string, text: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const rest = { ...cfg };
  delete rest.statusLine;
  const empty = Object.keys(rest).length === 0 && !existedBeforeInstall(file, env);
  return planEdit(file, text, empty ? undefined : stringifyJsonLike(rest, text), "remove coding.sh status line");
}
