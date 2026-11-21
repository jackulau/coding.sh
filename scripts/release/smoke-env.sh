# Sourced by smoke.sh: puts everything the smoke test could read or write
# under the throwaway directory $1, whatever the caller's environment holds.
# A CODING_SH_HOME, a store URL or an agent home in the caller's shell would
# otherwise send a real store or a real agent config into the test.
smoke_isolate_env() {
  W=$1
  export HOME="$W/home" NO_UPDATE_NOTIFIER=1 CODING_SH_NO_UPDATE_CHECK=1 npm_config_update_notifier=false
  # Node on Windows takes the home directory from USERPROFILE, not HOME.
  case "$(uname -s 2>/dev/null)" in
    MINGW* | MSYS* | CYGWIN*)
      if command -v cygpath >/dev/null 2>&1; then USERPROFILE=$(cygpath -w "$HOME"); else USERPROFILE=$HOME; fi
      export USERPROFILE ;;
  esac
  # Store, blob and forwarding settings from the caller's shell mean a different store.
  unset CODING_SH_STORE_URL CODING_SH_BLOB_URL CODING_SH_URL CODING_SH_FORWARD_URL CODING_SH_DEV_REAL_STORE
  export CODING_SH_HOME="$HOME/.coding.sh"
  # Every agent home an adapter reads (AGENT_HOME_KEYS in packages/coding.sh/test/_agent-env.ts).
  # A directory goes where the adapter looks when it is unset, under the throwaway HOME
  # (AGENT_HOME_DIRS); a file, project or layout override is unset, so its default falls there too.
  export CLAUDE_CONFIG_DIR="$HOME/.claude" CODEX_HOME="$HOME/.codex" \
    CURSOR_CONFIG_DIR="$HOME/.cursor" CURSOR_DATA_DIR="$HOME/.cursor" \
    OPENCODE_CONFIG_DIR="$HOME/.config/opencode" GEMINI_CLI_HOME="$HOME" \
    COPILOT_HOME="$HOME/.copilot" PI_CODING_AGENT_DIR="$HOME/.pi/agent" T3CODE_HOME="$HOME/.t3" \
    XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" \
    XDG_STATE_HOME="$HOME/.local/state" XDG_CACHE_HOME="$HOME/.cache" APPDATA="$HOME/AppData/Roaming"
  unset OPENCODE_DB PI_CODING_AGENT_SESSION_DIR GOOSE_PATH_ROOT DEVIN_CONFIG_HOME DEVIN_SESSIONS_DIR DEVIN_PROJECT_DIR
}
