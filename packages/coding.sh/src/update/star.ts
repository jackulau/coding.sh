// A polite, one-time "star us on GitHub" prompt, shown once in the terminal and once in the viewer.
//
//   starNotice(env, out)         after a successful command: one dim stderr line, once ever.
//   starVisible(env, sessions)   the viewer's GET /api/star: true after real use, until dismissed.
//   recordStar(env, action)      the viewer's POST /api/star: "dismiss" or "starred" ends both prompts.
//
// State is <root>/star.json. There is no network call anywhere in this file. Nothing is shown or
// written when CODING_SH_NO_STAR_PROMPT=1, NO_UPDATE_NOTIFIER is set, or CI is set.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../core/paths.ts";
import { isCI } from "./index.ts";

export const STAR_URL = "https://github.com/jackulau/coding.sh";
export const STAR_LINE = `Enjoying coding.sh? A star on GitHub helps other people find it: ${STAR_URL}`;
export const STAR_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
export const STAR_MIN_SESSIONS = 5;

export interface StarState {
  firstSeen?: number;
  cliShownAt?: number;
  dismissedAt?: number;
  starredAt?: number;
}

export type StarAction = "dismiss" | "starred";

export function starFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).root, "star.json");
}

export function readStar(env: NodeJS.ProcessEnv = process.env): StarState {
  try {
    const v = JSON.parse(readFileSync(starFile(env), "utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: StarState = {};
    for (const k of ["firstSeen", "cliShownAt", "dismissedAt", "starredAt"] as const) {
      const n = (v as Record<string, unknown>)[k];
      if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** True when the state is saved. A read-only or full home returns false, and the caller then shows nothing. */
function writeStar(env: NodeJS.ProcessEnv, state: StarState): boolean {
  const file = starFile(env);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing more to clean up
    }
    return false;
  }
}

const truthy = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/** Why the prompt is off ("CODING_SH_NO_STAR_PROMPT", "NO_UPDATE_NOTIFIER" or "ci"), or undefined. */
export function starDisabled(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (truthy(env.CODING_SH_NO_STAR_PROMPT)) return "CODING_SH_NO_STAR_PROMPT";
  if (env.NO_UPDATE_NOTIFIER !== undefined) return "NO_UPDATE_NOTIFIER";
  if (isCI(env)) return "ci";
  return undefined;
}

/** Reads the state and records `firstSeen` on the first check. Undefined under an opt-out (nothing is written). */
function checked(env: NodeJS.ProcessEnv, now: number): StarState | undefined {
  if (starDisabled(env)) return undefined;
  const state = readStar(env);
  if (state.firstSeen === undefined) {
    state.firstSeen = now;
    writeStar(env, state);
  }
  return state;
}

/** Three days since `firstSeen`, and neither dismissed nor starred. */
function eligible(state: StarState, now: number): boolean {
  if (state.dismissedAt !== undefined || state.starredAt !== undefined) return false;
  const first = state.firstSeen;
  return first !== undefined && now - first >= STAR_AFTER_MS;
}

export interface StarOptions {
  now?: () => number;
  stderr?: { write(s: string): unknown; isTTY?: boolean };
  /** The command that just ran. */
  command?: string;
  /** The update notice printed in this run: the star line waits. */
  skip?: boolean;
}

export interface StarOutput {
  json: boolean;
  style?(s: string, style: "faint", stream: "err"): string;
}

/**
 * Call once after a command succeeded. Prints one dim stderr line (TTY only, not --json, not
 * mcp or update, not in the run that printed the update notice) when eligible, then records
 * `cliShownAt` so it never prints again. Never throws. Returns true when it printed.
 */
export function starNotice(env: NodeJS.ProcessEnv, out: StarOutput, opts: StarOptions = {}): boolean {
  try {
    const stderr = opts.stderr ?? process.stderr;
    if (out.json || stderr.isTTY !== true || opts.command === "mcp" || opts.command === "statusline" || opts.command === "update") return false;
    const now = (opts.now ?? Date.now)();
    const state = checked(env, now);
    if (!state || opts.skip || state.cliShownAt !== undefined || !eligible(state, now)) return false;
    // Saved first: a home that cannot be written would otherwise repeat the line on every command.
    if (!writeStar(env, { ...state, cliShownAt: now })) return false;
    stderr.write((out.style ? out.style(STAR_LINE, "faint", "err") : STAR_LINE) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Not opted out, three days past `firstSeen`, and neither dismissed nor starred: the viewer then counts sessions. Never throws. */
export function starDue(env: NodeJS.ProcessEnv, now: () => number = Date.now): boolean {
  try {
    const t = now();
    const state = checked(env, t);
    return state !== undefined && eligible(state, t);
  } catch {
    return false;
  }
}

/** The viewer's `show`: due, and the store holds at least STAR_MIN_SESSIONS top-level sessions. Never throws. */
export function starVisible(env: NodeJS.ProcessEnv, sessionCount: number, now: () => number = Date.now): boolean {
  return starDue(env, now) && sessionCount >= STAR_MIN_SESSIONS;
}

/** The viewer's POST: records `dismissedAt` or `starredAt` (first one wins). Never throws. */
export function recordStar(env: NodeJS.ProcessEnv, action: StarAction, now: () => number = Date.now): void {
  try {
    if (starDisabled(env)) return;
    const state = readStar(env);
    const t = now();
    state.firstSeen ??= t;
    if (action === "dismiss") state.dismissedAt ??= t;
    else state.starredAt ??= t;
    writeStar(env, state);
  } catch {
    // never fail the viewer over this
  }
}
