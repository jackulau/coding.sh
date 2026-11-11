// Cross-harness child sessions, the fallback when the child's spool lines carry
// no parent marker (spawnedBy, see ./spawned.ts): the parent ran an agent
// whose hooks were not installed, a parent agent that exports no session id,
// a session imported from its transcript. A new top-level session is linked
// to another session's shell tool call when:
//   - the call's command runs this session's agent CLI (`codex exec …`,
//     `npx @google/gemini-cli -p …`, `/usr/local/bin/claude -p …`);
//   - the session started while the call ran: at or after its start, and no
//     later than its end (a call with no end yet counts for MAX_OPEN_MS);
//   - the session's cwd is the call's cwd or a directory under it.
// The nearest such call (latest start) wins. Ingest runs this once, when the
// session first reaches the index, so its cost is a session lookup per new
// session, not per event.
import type { Session } from "../schema/index.ts";
import type { IndexStore } from "../core/types.ts";
import { shellCommandOf } from "../adapters/_shared/tools.ts";

/** The command-line words that start each agent's CLI (an npm package name counts: `npx @google/gemini-cli`). */
export const AGENT_CLI: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["claude", "claude-code"],
  codex: ["codex"],
  "gemini-cli": ["gemini", "gemini-cli"],
  opencode: ["opencode", "opencode-ai"],
  cursor: ["cursor-agent"],
  "copilot-cli": ["copilot"],
  droid: ["droid"],
  goose: ["goose"],
  aider: ["aider"],
  amp: ["amp"],
  pi: ["pi"],
};

/** How long a shell call with no end yet can still be the parent of a session it started. */
export const MAX_OPEN_MS = 2 * 60 * 60_000;
/** Candidate parents looked at: sessions that started in this window before the child. */
const LOOKBACK_MS = 24 * 60 * 60_000;
const MAX_CANDIDATES = 50;

// Where a command starts: the start of the line, after ; & | ( $( ` or a quote
// (`bash -lc "codex exec …"`), then env assignments and launchers (npx, env,
// timeout 60, …), then an optional path or package scope.
const AT_COMMAND = String.raw`(?:^|[;&|(\n'"\`]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:sudo|env|exec|nohup|time|command|npx(?:\s+-y)?|bunx|pnpm\s+(?:dlx|exec)|yarn\s+dlx|timeout\s+\S+)\s+)*(?:[^\s;&|()'"\`]*\/)?`;
/** After the word: an optional @version, then a space, the end, or a command separator. */
const CLI_END = String.raw`(?:@\S*)?(?=\s|$|[;&|)'"\`])`;
const cliRe = new Map<string, RegExp>();

/** True when `command` runs `agent`'s CLI as a command (not as an argument: `grep codex` does not count). */
export function runsAgentCli(command: string, agent: string): boolean {
  const words = AGENT_CLI[agent];
  if (!words) return false;
  let re = cliRe.get(agent);
  if (!re) cliRe.set(agent, (re = new RegExp(`${AT_COMMAND}(?:${words.map((w) => w.replace(/[-.]/g, "\\$&")).join("|")})${CLI_END}`)));
  return re.test(command);
}

function within(cwd: string | undefined, root: string | undefined): boolean {
  if (!cwd || !root) return false;
  const c = cwd.replace(/[\\/]+$/, "");
  const r = root.replace(/[\\/]+$/, "");
  return c === r || c.startsWith(r + "/") || c.startsWith(r + "\\");
}

/** True when session `s` had started by `ts` and had not ended before it: it can have started a session at `ts`. */
export function openAt(s: Pick<Session, "startedAt" | "endedAt">, ts: number): boolean {
  return s.startedAt <= ts && (s.endedAt === undefined || s.endedAt >= ts);
}

/** The parent link for a new session started from another session's shell call, if one matches. */
export async function matchSpawnedParent(index: Pick<IndexStore, "listSessions" | "listEvents">, child: Session): Promise<NonNullable<Session["parent"]> | undefined> {
  if (child.parent || child.runId || !AGENT_CLI[child.agent] || !child.cwd) return undefined;
  const start = child.startedAt;
  const candidates = (await index.listSessions({ since: start - LOOKBACK_MS, until: start + 1, limit: MAX_CANDIDATES })).filter((s) => s.id !== child.id && !s.runId && s.parent?.sessionId !== child.id);
  let best: { link: NonNullable<Session["parent"]>; ts: number } | undefined;
  for (const s of candidates) {
    if (!openAt(s, start)) continue;
    const events = await index.listEvents(s.id, { kinds: ["tool.start", "tool.end"] });
    const ends = new Map<string, number>();
    for (const e of events) if (e.kind === "tool.end" && typeof e.payload.toolUseId === "string") ends.set(e.payload.toolUseId, e.ts);
    for (const e of events) {
      if (e.kind !== "tool.start" || e.ts > start || (best && e.ts <= best.ts)) continue;
      const command = shellCommandOf(String(e.payload.tool ?? ""), e.payload.input);
      if (!command || !runsAgentCli(command, child.agent)) continue;
      const end = typeof e.payload.toolUseId === "string" ? ends.get(e.payload.toolUseId) : undefined;
      if (start > (end ?? e.ts + MAX_OPEN_MS)) continue;
      if (!within(child.cwd, e.cwd ?? s.cwd)) continue;
      best = { link: { sessionId: s.id, eventId: e.id, type: "harness" }, ts: e.ts };
    }
  }
  return best?.link;
}
