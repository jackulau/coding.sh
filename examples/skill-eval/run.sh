#!/bin/sh
# Build the eval image and run the A/B in a container.
#   examples/skill-eval/run.sh <out-dir> [--dry-run] [--env-file <file>] [--live] [--candidate <skill-dir>]
#   examples/skill-eval/run.sh <out-dir> --regrade
# The container gets only <out-dir> (as /work) and these variables from the env file:
#   ANTHROPIC_API_KEY        the agent and the judge
#   CLAUDE_CODE_OAUTH_TOKEN  the agent only (from `claude setup-token`); no judge without
#                            ANTHROPIC_API_KEY
#   --live adds:
#   VERCEL_TOKEN, VERCEL_SCOPE  a real Vercel team, read through the read-only proxy
#   VERCEL_PROJECT              optional: the project the tasks name (default: the most
#                               recently updated one)
# Other lines in the env file are not passed. No host credentials, ~/.claude or Vercel
# login go in. Extra env: MODEL, K, MAX_COST (passed through), and TASKS: task number
# prefixes to run, e.g. TASKS="01 06" (default: all).
# --candidate <skill-dir> compares the pinned skill (arm A, with-skill) with an edited copy
# of it (arm B, candidate) instead of no skill with the skill. The dir holds SKILL.md and
# goes in read-only.
# --regrade grades the runs already in <out-dir> again with the current checks
# (grader/regrade): no agent, Vercel or judge call, and no env file.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd -P)
usage="usage: run.sh <out-dir> [--dry-run] [--env-file <file>] [--live] [--candidate <skill-dir>] | <out-dir> --regrade"
out=${1:?$usage}
shift
dry=0
live=0
regrade=0
envfile=
candidate=
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --live) live=1 ;;
    --regrade) regrade=1 ;;
    --env-file) envfile=${2:?$usage}; shift ;;
    --candidate) candidate=${2:?$usage}; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
if [ "$regrade" = 1 ]; then
  [ "$dry$live" = 00 ] && [ -z "$envfile$candidate" ] || { echo "--regrade takes only the output dir." >&2; exit 2; }
  [ -f "$out/csh/index.db" ] || { echo "$out has no eval run to regrade (no csh/index.db)." >&2; exit 2; }
  out=$(cd "$out" && pwd -P)
  docker build -q -t coding-sh-skill-eval -f "$here/Dockerfile" "$repo" >/dev/null
  # Root, so it can read a live run's canaries (vproxy only) for the leak check.
  exec docker run --rm -v "$out:/work" --user root --entrypoint python3 coding-sh-skill-eval /opt/skill-eval/grader/regrade /work
fi
if [ -n "$candidate" ]; then
  [ -f "$candidate/SKILL.md" ] || { echo "--candidate needs a skill directory with SKILL.md: $candidate" >&2; exit 2; }
  candidate=$(cd "$candidate" && pwd -P)
fi
mkdir -p "$out"
out=$(cd "$out" && pwd -P)
if [ "$live" = 1 ]; then
  [ "$dry" = 0 ] || { echo "--live and --dry-run don't combine: the dry run's fake agent needs the stub's fixtures." >&2; exit 2; }
  [ -n "$envfile" ] || { echo "--live needs --env-file with VERCEL_TOKEN, VERCEL_SCOPE and model auth." >&2; exit 2; }
  case "$out/" in
    "$repo"/*) echo "--live writes real account data to <out-dir>; pick one outside the repo." >&2; exit 2 ;;
  esac
fi
# Sticky: the eval user can't rename or replace the proxy's dirs in /work.
chmod 1777 "$out"
docker build -q -t coding-sh-skill-eval -f "$here/Dockerfile" "$repo" >/dev/null
set -- --rm -v "$out:/work" -e "SKILL_EVAL_DRY_RUN=$dry" -e "MODEL=${MODEL:-claude-sonnet-5-5}" -e "K=${K:-1}" -e "MAX_COST=${MAX_COST:-15}" -e "TASKS=${TASKS:-}"
[ -z "$candidate" ] || set -- "$@" -v "$candidate:/candidate:ro" -e SKILL_EVAL_CANDIDATE=1
envtmp=
trap 'rm -f "$envtmp"' EXIT
trap 'exit 130' INT TERM
if [ -n "$envfile" ]; then
  keys='ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN'
  [ "$live" = 1 ] && keys="$keys|VERCEL_TOKEN|VERCEL_SCOPE|VERCEL_PROJECT"
  envtmp=$(mktemp)
  grep -E "^($keys)=" "$envfile" > "$envtmp" || true
  set -- "$@" --env-file "$envtmp"
fi
if [ "$live" = 1 ]; then
  set -- "$@" --user root --entrypoint sh coding-sh-skill-eval /opt/skill-eval/live/entry.sh
else
  set -- "$@" coding-sh-skill-eval
fi
status=0
docker run "$@" || status=$?
exit "$status"
