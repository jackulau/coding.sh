#!/bin/sh
# Build the eval image and run the A/B in a container.
#   examples/skill-eval/run.sh <out-dir> [--dry-run] [--env-file <file>]
# The container gets only <out-dir> (as /work) and the env file, which should hold
# ANTHROPIC_API_KEY=... and nothing else. No host credentials, ~/.claude or
# Vercel login go in. Extra env: MODEL, K, MAX_COST (passed through).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
out=${1:?usage: run.sh <out-dir> [--dry-run] [--env-file <file>]}
shift
dry=0
envfile=
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --env-file) envfile=$2; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$out"
chmod 777 "$out"
docker build -q -t coding-sh-skill-eval -f "$here/Dockerfile" "$repo" >/dev/null
set -- --rm -v "$out:/work" -e "SKILL_EVAL_DRY_RUN=$dry" -e "MODEL=${MODEL:-claude-sonnet-5-5}" -e "K=${K:-1}" -e "MAX_COST=${MAX_COST:-15}"
[ -n "$envfile" ] && set -- "$@" --env-file "$envfile"
exec docker run "$@" coding-sh-skill-eval
