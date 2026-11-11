# Sourced by smoke.sh: puts everything the smoke test could read or write
# under the throwaway directory $1, whatever the caller's environment holds.
# A CODING_SH_HOME, a store URL or an agent home in the caller's shell would
# otherwise send a real store or a real agent config into the test.
smoke_isolate_env() {
  W=$1
  export HOME="$W/home" NO_UPDATE_NOTIFIER=1 CODING_SH_NO_UPDATE_CHECK=1 npm_config_update_notifier=false
  # Store, blob and forwarding settings from the caller's shell mean a different store.
  unset CODING_SH_STORE_URL CODING_SH_BLOB_URL CODING_SH_URL CODING_SH_FORWARD_URL CODING_SH_DEV_REAL_STORE
  # Homes the CLI and the agents read: each one inside $W.
  export CODING_SH_HOME="$HOME/.coding.sh" CLAUDE_CONFIG_DIR="$HOME/.claude" CODEX_HOME="$HOME/.codex" \
    GEMINI_HOME="$HOME/.gemini" COPILOT_HOME="$HOME/.copilot" PI_CODING_AGENT_DIR="$HOME/.pi"
}
