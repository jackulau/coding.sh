// The variables an adapter reads to find an agent's config or sessions, in one list shared by
// tmpEnv() (test/adapters/_helpers.ts) and the gate's isolated environment (scripts/gate.mjs).
// test/scripts/gate-env.test.ts checks that the list covers every such read under src/adapters.

/**
 * Every variable an adapter reads to find an agent's config or sessions. tmpEnv() unsets them all,
 * so a developer's shell (say, CURSOR_DATA_DIR, which Cursor reads before CURSOR_CONFIG_DIR) can
 * neither fail a test nor point one at real sessions. %APPDATA% is where Goose keeps its data on
 * Windows.
 */
export const AGENT_HOME_KEYS: readonly string[] = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CURSOR_CONFIG_DIR",
  "CURSOR_DATA_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "GEMINI_CLI_HOME",
  "COPILOT_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "GOOSE_PATH_ROOT",
  "T3CODE_HOME",
  "DEVIN_CONFIG_HOME",
  "DEVIN_SESSIONS_DIR",
  "DEVIN_PROJECT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "APPDATA",
];

/**
 * Where an isolated environment points a directory variable, relative to its throwaway HOME: the
 * place the adapter looks when the variable is unset, so setting it changes no path. A key of
 * AGENT_HOME_KEYS that is not here names one file or db, a project, or a root that changes the
 * layout (OPENCODE_DB, PI_CODING_AGENT_SESSION_DIR, GOOSE_PATH_ROOT, DEVIN_*), and is unset:
 * its default then falls under the throwaway HOME, APPDATA or XDG directories.
 */
export const AGENT_HOME_DIRS: Readonly<Record<string, readonly string[]>> = {
  CLAUDE_CONFIG_DIR: [".claude"],
  CODEX_HOME: [".codex"],
  CURSOR_CONFIG_DIR: [".cursor"],
  CURSOR_DATA_DIR: [".cursor"],
  OPENCODE_CONFIG_DIR: [".config", "opencode"],
  GEMINI_CLI_HOME: [],
  COPILOT_HOME: [".copilot"],
  PI_CODING_AGENT_DIR: [".pi", "agent"],
  T3CODE_HOME: [".t3"],
  XDG_CONFIG_HOME: [".config"],
  XDG_DATA_HOME: [".local", "share"],
  XDG_STATE_HOME: [".local", "state"],
  XDG_CACHE_HOME: [".cache"],
  APPDATA: ["AppData", "Roaming"],
};
