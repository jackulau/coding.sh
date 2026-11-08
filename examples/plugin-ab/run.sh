#!/bin/sh
# A/B one Claude Code plugin against plain Claude Code on ten small tasks, in a container.
#   examples/plugin-ab/run.sh <out-dir> --plugin <plugin-dir> [--env-file <file>]
# <plugin-dir> is a plugin's root, the directory with .claude-plugin/plugin.json.
# examples/plugin-ab/demo-plugin is a small one to try the method on.
# The container gets only <out-dir> (as /work), a copy of the plugin in <out-dir>/arms, and
# these variables from the env file:
#   CLAUDE_CODE_OAUTH_TOKEN  the agent and the judge (from `claude setup-token`)
#   ANTHROPIC_API_KEY        or this
# Other lines in the env file are not passed. No ~/.claude goes in.
# Extra env, passed through: K (runs per task and arm, default 3), C (parallel runs, 4),
# MODEL (claude-opus-5-5), JUDGE_MODEL (claude-sonnet-5-5), JUDGE (1; 0 skips the judge),
# MAX_COST (USD for the agent runs, 40), MARKER (text the plugin injects, to check it reached
# its arm only), ONLY (one task name, e.g. ab-c1-paginate, for a smoke run),
# CLAUDE_CODE_VERSION (2.1.319).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd -P)
usage="usage: run.sh <out-dir> --plugin <plugin-dir> [--env-file <file>]"
out=${1:?$usage}
shift
plugin=
envfile=
while [ $# -gt 0 ]; do
  case "$1" in
    --plugin) plugin=${2:?$usage}; shift ;;
    --env-file) envfile=${2:?$usage}; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$plugin" ] || { echo "$usage" >&2; exit 2; }
[ -f "$plugin/.claude-plugin/plugin.json" ] || { echo "$plugin has no .claude-plugin/plugin.json" >&2; exit 2; }
[ -n "$envfile" ] || { echo "--env-file with CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is required" >&2; exit 2; }
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
node "$here/build-arms.mjs" "$plugin" "$out/arms" "${MODEL:-claude-opus-5-5}"
chmod -R a+rwX "$out"
docker build -q -t coding-sh-plugin-ab --build-arg "CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION:-2.1.319}" \
  -f "$here/Dockerfile" "$repo" >/dev/null
envtmp=$(mktemp)
trap 'rm -f "$envtmp"' EXIT
trap 'exit 130' INT TERM
grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' "$envfile" > "$envtmp" || true
status=0
docker run --rm -v "$out:/work" --env-file "$envtmp" -e "K=${K:-3}" -e "C=${C:-4}" -e "MAX_COST=${MAX_COST:-40}" \
  -e "JUDGE=${JUDGE:-1}" -e "JUDGE_MODEL=${JUDGE_MODEL:-claude-sonnet-5-5}" -e "MARKER=${MARKER:-}" -e "ONLY=${ONLY:-}" \
  coding-sh-plugin-ab || status=$?
exit "$status"
