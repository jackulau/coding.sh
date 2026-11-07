// Host apps that drive another agent (T3 Code runs Codex and Claude Code for
// you). Their hooks still fire as the underlying agent's hooks, so the hook
// records which host launched it from the environment it inherited. Ingest
// stamps that on every event as payload.via, and buildSession then attributes
// the session to the host (session.agent = "t3code", session.provider = the
// underlying agent).
//
// Hot path: no imports, pure env lookups.

export const T3_AGENT = "t3code";

/** Codex originator T3 Code sets (CODEX_INTERNAL_ORIGINATOR_OVERRIDE "T3 Code"; older builds "t3code_desktop"). */
export const T3_ORIGINATOR = /^t3[\s_-]?code/i;

export interface HostMark {
  /** Host agent id, e.g. "t3code". */
  id: string;
  /** The host's own thread id, when it exports one. */
  thread?: string;
}

export function hostOf(env: NodeJS.ProcessEnv): HostMark | undefined {
  // Claude Agent SDK sessions: T3 sets T3CODE_THREAD_ID in the provider's env.
  const thread = env.T3CODE_THREAD_ID;
  if (thread) return { id: T3_AGENT, thread };
  // Codex app-server: T3 overrides the originator.
  const origin = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  if (origin && T3_ORIGINATOR.test(origin)) return { id: T3_AGENT };
  return undefined;
}
