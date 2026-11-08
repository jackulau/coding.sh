#!/bin/sh
# Live mode's entrypoint, run as root (see run.sh --live). It:
#   1. puts the Vercel token and scope in /etc/vlive, readable only by vproxy, the user
#      the proxy runs as;
#   2. checks the token and collects the canaries (live/canaries, as vproxy);
#   3. runs inside.sh as the eval user without VERCEL_TOKEN in its environment, and
#      with VERCEL_SCOPE, VERCEL_PROJECT and LIVE_SITE, which the live tasks refer to.
# Outputs stay in /work (the host's output dir): /work/live holds the canary copy and
# the harness's call log (vproxy only), /work/vstub the proxy's per-run call logs.
set -eu
if [ -z "${VERCEL_TOKEN:-}" ] || [ -z "${VERCEL_SCOPE:-}" ]; then
  echo "Live mode needs VERCEL_TOKEN and VERCEL_SCOPE in the env file." >&2
  exit 2
fi
case "$VERCEL_SCOPE" in
  -*|*[!A-Za-z0-9_.-]*) echo "VERCEL_SCOPE must be a team slug." >&2; exit 2 ;;
esac
install -d -o vproxy -g vproxy -m 700 /etc/vlive
umask 077
printf '%s' "$VERCEL_TOKEN" > /etc/vlive/token
printf '%s' "$VERCEL_SCOPE" > /etc/vlive/scope
printf '%s' "${VERCEL_PROJECT:-}" > /etc/vlive/project
chown vproxy:vproxy /etc/vlive/token /etc/vlive/scope /etc/vlive/project
unset VERCEL_TOKEN
umask 022
install -d -o vproxy -g vproxy -m 755 /work/vstub
install -d -o vproxy -g vproxy -m 700 /work/live
picked=$(runuser -u vproxy -- /opt/skill-eval/live/canaries /work/live)
project=$(printf '%s\n' "$picked" | sed -n 1p)
site=$(printf '%s\n' "$picked" | sed -n 2p)
# The live tasks name the team, project and site only through these variables.
exec setpriv --reuid=eval --regid=eval --init-groups \
  env -u VERCEL_TOKEN HOME=/home/eval USER=eval LOGNAME=eval \
  SKILL_EVAL_LIVE=1 VERCEL_PROJECT="$project" LIVE_SITE="$site" \
  sh /opt/skill-eval/inside.sh
