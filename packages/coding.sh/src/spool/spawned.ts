// Cross-harness child sessions: an agent started by another agent's shell tool
// (`codex exec` or `gemini -p` from Claude Code's Bash) inherits that agent's
// env, and the parent agents export their own session id to every command
// they run:
//   Claude Code: CLAUDE_CODE_SESSION_ID
//   Codex:       CODEX_THREAD_ID, plus CODEX_TOOL_CALL_ID for the command's call
// The child's hooks inherit the same env, so the hook (hook.ts and the sh fast
// path hook.sh) records these markers on the SpoolLine as `spawnedBy`, and
// ingest links the child's session to the parent's (linkSpawned below).
//
// A marker can also be the line's own session (an agent's own hooks may see
// its own id): ingest drops a marker equal to the session it is stamping.
// Eval runs (CODING_SH_RUN_ID) are their own roots: the hook records no marker.
//
// Hot path: no imports, pure env lookups (linkSpawned runs at ingest).
import type { SpoolLine } from "../core/types.ts";

export type SpawnedBy = NonNullable<SpoolLine["spawnedBy"]>[number];

/** Ids we copy into JSON as is (the sh hook hands anything else to hook.mjs). */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Parent-session markers in a hook's env, outermost agent first (Claude Code, then Codex). */
export function spawnedByFromEnv(env: NodeJS.ProcessEnv): SpawnedBy[] | undefined {
  if (env.CODING_SH_RUN_ID) return undefined;
  const out: SpawnedBy[] = [];
  const claude = env.CLAUDE_CODE_SESSION_ID;
  if (claude && SAFE_ID.test(claude)) out.push({ agent: "claude-code", session: claude });
  const codex = env.CODEX_THREAD_ID;
  if (codex && SAFE_ID.test(codex)) {
    const call = env.CODEX_TOOL_CALL_ID;
    out.push(call && SAFE_ID.test(call) ? { agent: "codex", session: codex, toolCallId: call } : { agent: "codex", session: codex });
  }
  return out.length ? out : undefined;
}

/**
 * The parent link a child's `session.start` payload gets from its line's
 * markers: `{ parentSessionId, parentAgent, subagentType: "harness" }` (plus
 * `parentToolCallId` from Codex), or undefined when every marker is the
 * session itself. With markers from two agents (Claude ran Codex, which ran
 * Gemini), the env cannot say which is nearer; the last recorded wins, so a
 * Codex marker beats an inherited Claude Code one.
 */
export function linkSpawned(spawnedBy: SpoolLine["spawnedBy"], sessionId: string): Record<string, string> | undefined {
  if (!Array.isArray(spawnedBy)) return undefined;
  for (let i = spawnedBy.length - 1; i >= 0; i--) {
    const m = spawnedBy[i];
    // The session itself, or one of its own subagent sessions (`<id>:sub:<n>`), is not a parent harness.
    if (!m || typeof m.session !== "string" || !m.session || m.session === sessionId || sessionId.startsWith(m.session + ":") || typeof m.agent !== "string") continue;
    const link: Record<string, string> = { parentSessionId: m.session, parentAgent: m.agent, subagentType: "harness" };
    if (typeof m.toolCallId === "string" && m.toolCallId) link.parentToolCallId = m.toolCallId;
    return link;
  }
  return undefined;
}
