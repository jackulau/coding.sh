#!/bin/sh
# The packed CLI on the oldest Node it claims (engines in packages/coding.sh/package.json):
# install the tarball into a throwaway prefix and home, then init, a hook call
# through hook.sh, ingest, sessions, search, status and doctor. CI runs it with
# `node` on PATH at the floor version; the dev suite needs a newer Node (AGENTS.md).
#
#   scripts/release/runtime-floor.sh path/to/coding.sh-X.Y.Z.tgz
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TGZ=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
. "$ROOT/scripts/release/smoke-env.sh"
smoke_isolate_env "$W"
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR"
fail() { printf 'FAIL: %s\n' "$*" >&2; [ ! -s "$W/log" ] || tail -n 20 "$W/log" >&2; exit 1; }

floor=$(node -p 'require(process.argv[1]).engines.node.replace(">=", "")' "$ROOT/packages/coding.sh/package.json")
have=$(node -p 'process.versions.node')
echo "node $have (floor $floor)"
case "$have" in "$floor".*) ;; *) fail "node on PATH is $have, not the floor $floor" ;; esac

npm i -g --silent --no-fund --no-audit --prefix "$W/prefix" "$TGZ"
B="$W/prefix/bin/coding.sh"
"$B" --version
"$B" init --agent claude-code --yes --no-import >>"$W/log" 2>&1 || fail "init exited non-zero"
[ -f "$CODING_SH_HOME/bin/hook.sh" ] || fail "init installed no hook.sh"
printf '{"session_id":"floor-1","hook_event_name":"UserPromptSubmit","prompt":"find the floor","cwd":"/work/demo"}' \
  | /bin/sh "$CODING_SH_HOME/bin/hook.sh" claude-code UserPromptSubmit
"$B" ingest >>"$W/log" 2>&1 || fail "ingest exited non-zero"
"$B" sessions --empty --json | grep -q floor-1 || fail "the session is not in the store"
"$B" search floor --json | grep -q floor-1 || fail "search (FTS5) did not find the prompt"
"$B" status >>"$W/log" 2>&1 || fail "status exited non-zero"
"$B" doctor >>"$W/log" 2>&1 || fail "doctor exited non-zero"
echo "runtime floor ok on node $have"
