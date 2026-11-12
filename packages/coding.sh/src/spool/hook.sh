# coding.sh hook, the POSIX sh fast path. Installed as ~/.coding.sh/bin/hook.sh
# next to hook.mjs (src/spool/hook.ts). Agents run it as:
#
#   /bin/sh "<home>/bin/hook.sh" <agent> <event> [--echo-continue | --reply={}]   < hook JSON on stdin
#
# It writes the same SpoolLine (core/types.ts) hook.mjs writes, without starting
# node: a node start costs about 30 ms, this script a few ms. Same contract:
# - Exits 0 and prints nothing, except `{"continue":true}` for --echo-continue
#   (or CODING_SH_ECHO_CONTINUE=1) and `{}` for --reply={}. stderr goes to
#   /dev/null, and a reader of stdout that is gone does not fail the call
#   (SIGPIPE is ignored for the reply). These hold when a call is handed to
#   hook.mjs and node cannot run it.
# - No network, no git. Files 0600, dirs 0700.
# - CODING_SH_DISABLE=1: reads the payload and writes no line. The payload's
#   session id goes to spool/disabled-sessions, so ingest and an import of the
#   agent's transcripts leave that session out (hook.mjs does the same).
# - Anything it does not handle goes to hook.mjs with the same arguments and
#   stdin: any other --reply, an eval run (CODING_SH_RUN_ID), a host app (T3 Code), a
#   model base URL that may be a gateway's (gateway detection), a session start while
#   `init --proxy` is installed (proxy restart), a relative CODING_SH_HOME, a
#   value it cannot put in JSON as is, and any write that fails (hook.mjs then
#   logs the failure to spool/errors.log).
#
# Lines: a payload that is one line of the form {"...} goes inline as "raw" when
# the whole line, newline included, fits in 1024 bytes, so one write(2)
# appends it (O_APPEND places it at the end of the file as one unit, so lines
# from concurrent hooks never interleave). Shells print through a buffer of
# BUFSIZ bytes, which is 1024 on macOS and musl: a longer line can leave in
# pieces that another hook's line lands between. Any other payload goes verbatim to a side file under
# <agent>/raw/ and the line names it in "rawFile", as hook.mjs does for
# lines over the same 1024 bytes; readers recover it with resolveRaw(). The inline check
# is by shape, not a JSON parse: agents send their serializer's output. Under
# bash and zsh a payload whose braces or brackets do not pair up also goes to a
# side file (where the reader keeps it as text, as hook.mjs does); elsewhere a
# line that fails to parse is skipped and reported by the spool reader.
#
# Session end (stop, session-end, session.idle, afterAgent): touches
# spool/.ingest.pending and starts `node <cli-path> ingest --background` in its
# own session (setsid, or a job-control process group where there is no
# setsid), with stdio on /dev/null so the agent never waits for it. The ingest
# exits at once when another holds the lock; the holder picks up the marker.

exec 2>/dev/null
# Where /bin/sh is dash (Debian, Ubuntu), run under bash instead when it is
# installed: bash 5 has the clock (EPOCHREALTIME) and a read builtin that
# takes a whole payload, so a call starts no other process, where dash needs date(1)
# and cat(1) (each one a fork and exec, about 4 ms each with uutils coreutils).
# --posix: bash skips BASH_ENV. The variable keeps a /bin/bash that is not
# bash from looping.
if [ -z "${BASH_VERSION-}${ZSH_VERSION-}${CODING_SH_HOOK_REEXEC-}" ] && [ -x /bin/bash ]; then
  CODING_SH_HOOK_REEXEC=1
  export CODING_SH_HOOK_REEXEC
  exec /bin/bash --posix "$0" "$@"
fi
LC_ALL=C

# A closed fd 0 is no payload: open it on /dev/null, so every read below sees
# an empty one. Left closed, the pipe of a $(…) takes fd 0, bash leaves it open
# in the child, and $(< /dev/stdin) or $(cat) reads the pipe it writes to and
# never ends. The test is a dup of fd 0 onto fd 3, undone at once (a `<&0`
# tests nothing: shells skip a dup onto the same fd); the braces keep dash,
# which exits on a failed redirection of `:` or `true`, running.
{ :; } 3<&0 || exec </dev/null

case $0 in */*) d=${0%/*} ;; *) d=. ;; esac

# node did not run hook.mjs to its end: it is not on the agent's PATH (127),
# it cannot load hook.mjs, or it died. The event is not captured; the agent
# still gets exit 0 and the --echo-continue reply (a --reply is hook.mjs's to
# check and print). The arguments are read here, since a call can be handed on
# before the script has parsed them.
no_node() {
  [ "${CODING_SH_ECHO_CONTINUE-}" = 1 ] && echo=1
  reply=
  for a in "$@"; do
    [ "$a" = --echo-continue ] && echo=1
    [ "$a" = '--reply={}' ] && reply='{}'
  done
  answer
  exit 0
}
# The reply the agent waits for: --reply={} over --echo-continue, as in hook.mjs.
# A reader of stdout that is gone (EPIPE) is not the hook's failure.
answer() {
  trap '' PIPE
  if [ -n "${reply-}" ]; then
    printf '%s\n' "$reply" || :
  elif [ -n "${echo-}" ]; then
    printf '{"continue":true}\n' || :
  fi
}
# Hand the whole call to hook.mjs (stdin untouched) and wait for it. Not an
# exec: node's exit status must never be the hook's. --sh-pids gives hook.mjs
# the pid and ppid to record, those of the hook process the agent started.
to_node() {
  node "$d/hook.mjs" "--sh-pids=$$,$PPID" "$@" || no_node "$@"
  exit 0
}
# The same with the payload already read (cat dropped its trailing newlines).
to_node_with() {
  node "$d/hook.mjs" "--sh-pids=$$,$PPID" "$@" <<PAYLOAD || no_node "$@"
$raw
PAYLOAD
  exit 0
}

[ $# -ge 2 ] || to_node "$@"
agent=$1
event=$2
echo=
reply=
[ "${CODING_SH_ECHO_CONTINUE-}" = 1 ] && echo=1
if [ $# -gt 2 ]; then
  [ $# -eq 3 ] || to_node "$@"
  case $3 in
    --echo-continue) echo=1 ;;
    # The reply Antigravity's hooks give ({}: no opinion); hook.mjs checks any other.
    '--reply={}') reply='{}' ;;
    *) to_node "$@" ;;
  esac
fi
case $agent in "" | *[!a-z0-9._-]* | [!a-z0-9]* | *..*) to_node "$@" ;; esac
[ ${#agent} -le 64 ] || to_node "$@"
case $event in "" | *[!A-Za-z0-9._:-]*) to_node "$@" ;; esac

[ -n "${CODING_SH_RUN_ID-}${T3CODE_THREAD_ID-}" ] && to_node "$@"
case ${CODEX_INTERNAL_ORIGINATOR_OVERRIDE-} in [Tt]3*) to_node "$@" ;; esac
# A model base URL: hook.mjs works out which gateway it is (integrations/gateway),
# except for a loopback URL (the coding.sh proxy of `init --proxy`) on a port no
# gateway uses by default, with no gateway's own URL variable set. The ports and
# variables are GATEWAYS' (test/capture/hook.test.ts checks they match).
for v in "${ANTHROPIC_BASE_URL-}" "${OPENAI_BASE_URL-}" "${OPENAI_API_BASE-}"; do
  case $v in
    "") continue ;;
    http://127.0.0.1:*) p=${v#http://127.0.0.1:} ;;
    http://localhost:*) p=${v#http://localhost:} ;;
    *) to_node "$@" ;;
  esac
  p=${p%%/*}
  case $p in "" | *[!0-9]* | 8317) to_node "$@" ;; esac
  [ -n "${LITELLM_PROXY_API_BASE-}${LITELLM_PROXY_URL-}${LITELLM_BASE_URL-}${PORTKEY_GATEWAY_URL-}${RAMP_ROUTER_BASE_URL-}${TFY_GATEWAY_URL-}${KONG_PROXY_URL-}${BIFROST_URL-}${BIFROST_BASE_URL-}${CLIPROXYAPI_URL-}" ] && to_node "$@"
done

if [ -n "${CODING_SH_HOME-}" ]; then
  case $CODING_SH_HOME in /*) home=$CODING_SH_HOME ;; *) to_node "$@" ;; esac
else
  [ -n "${HOME-}" ] || to_node "$@"
  home=$HOME/.coding.sh
fi
case $home in *[\"\\]* | *[[:cntrl:]]*) to_node "$@" ;; esac

case $event in
  [Ss][Ee][Ss][Ss][Ii][Oo][Nn][Ss][Tt][Aa][Rr][Tt] | [Ss][Ee][Ss][Ss][Ii][Oo][Nn][._-][Ss][Tt][Aa][Rr][Tt])
    [ "${CODING_SH_NO_PROXY_AUTOSTART-}" != 1 ] && [ -e "$home/proxy-installs.json" ] && to_node "$@" ;;
esac

end=
case $event in
  [Ss][Tt][Oo][Pp] | [Ss][Ee][Ss][Ss][Ii][Oo][Nn][Ee][Nn][Dd] | [Ss][Ee][Ss][Ss][Ii][Oo][Nn][._-][Ee][Nn][Dd] | [Ss][Ee][Ss][Ss][Ii][Oo][Nn].[Ii][Dd][Ll][Ee] | [Aa][Ff][Tt][Ee][Rr][Aa][Gg][Ee][Nn][Tt])
    [ "${CODING_SH_NO_AUTO_INGEST-}" != 1 ] && end=1 ;;
esac

# Optional fields, each a value JSON takes as is.
extra=
if [ "$agent" = claude-code ] && [ -n "${CLAUDE_CODE_ENTRYPOINT-}" ]; then
  case $CLAUDE_CODE_ENTRYPOINT in *[!A-Za-z0-9._:-]*) to_node "$@" ;; esac
  [ ${#CLAUDE_CODE_ENTRYPOINT} -le 64 ] || to_node "$@"
  extra=",\"entrypoint\":\"$CLAUDE_CODE_ENTRYPOINT\""
fi
# The agent sessions whose shell started this agent (spool/spawned.ts).
spawned=
for v in "${CLAUDE_CODE_SESSION_ID-}" "${CODEX_THREAD_ID-}" "${CODEX_TOOL_CALL_ID-}"; do
  case $v in *[!A-Za-z0-9._:-]*) to_node "$@" ;; esac
  [ ${#v} -le 128 ] || to_node "$@"
done
[ -n "${CLAUDE_CODE_SESSION_ID-}" ] && spawned="{\"agent\":\"claude-code\",\"session\":\"$CLAUDE_CODE_SESSION_ID\"}"
if [ -n "${CODEX_THREAD_ID-}" ]; then
  [ -n "$spawned" ] && spawned="$spawned,"
  if [ -n "${CODEX_TOOL_CALL_ID-}" ]; then
    spawned="$spawned{\"agent\":\"codex\",\"session\":\"$CODEX_THREAD_ID\",\"toolCallId\":\"$CODEX_TOOL_CALL_ID\"}"
  else
    spawned="$spawned{\"agent\":\"codex\",\"session\":\"$CODEX_THREAD_ID\"}"
  fi
fi
[ -n "$spawned" ] && extra="$extra,\"spawnedBy\":[$spawned]"

# The payload. A TTY is nobody piping one: never wait for a human.
raw=
if [ ! -t 0 ]; then
  if [ "${BASH_VERSINFO-0}" -ge 5 ]; then
    # bash's read builtin takes -N characters from a pipe or a socket (Node
    # agents give hooks a socketpair) a block per read(2), with no process
    # start. Not in POSIX mode, where it reads a byte per read(2), about 1 ms
    # per KB. Past 256 KB, cat is cheaper.
    psx=
    case :${SHELLOPTS-}: in *:posix:*) psx=1; set +o posix ;; esac
    IFS= read -r -N 262144 raw
    [ -n "$psx" ] && set -o posix
    if [ ${#raw} -ge 262144 ]; then
      rest=$(cat) || readfail=1
      raw=$raw$rest
    fi
    # As $(cat) would: no trailing newlines.
    nl='
'
    raw=${raw%"${raw##*[!$nl]}"}
  elif [ -n "${BASH_VERSION-}${ZSH_VERSION-}" ] && { [ -p /dev/stdin ] || [ ! -d /proc/self/fd ]; } && raw=$(< /dev/stdin); then
    # Older bash (macOS) and zsh read a file into $(< file) without cat. That
    # needs /dev/stdin to open: a pipe, or anything on macOS and the BSDs,
    # where opening it duplicates fd 0. On Linux a socket does not open there
    # and a file reopens at offset 0. A failed open reads nothing: cat reads it.
    :
  else
    raw=$(cat) || readfail=1
  fi
fi

# Capture paused: the payload is read (above, as for a capture, with no cat
# under bash), and only its session id is kept.
case ${CODING_SH_DISABLE-} in
  1 | true)
    sid=
    for k in '"session_id":"' '"session_id": "' '"conversation_id":"' '"conversation_id": "' '"sessionId":"' '"sessionId": "' '"conversationId":"' '"conversationId": "'; do
      case $raw in
        *"$k"*)
          rest=${raw#*"$k"}
          sid=${rest%%\"*}
          break ;;
      esac
    done
    case $sid in
      "" | *[!A-Za-z0-9._:-]*) ;;
      *)
        if [ ${#sid} -le 128 ]; then
          umask 077
          { [ -d "$home/spool" ] || mkdir -p "$home/spool"; } && printf '%s\n' "$sid" >>"$home/spool/disabled-sessions"
        fi ;;
    esac
    answer
    exit 0 ;;
esac

# Milliseconds since the epoch: bash 5 and zsh have EPOCHREALTIME (trusted only
# there, and only with a whole seconds count: another shell, bash 3.2 included,
# could inherit a stale exported copy), else date(1) (GNU and macOS print
# nanoseconds for %N; a date without it prints "N").
ert=
{ [ "${BASH_VERSINFO-0}" -ge 5 ] || [ -n "${ZSH_VERSION-}" ]; } && ert=${EPOCHREALTIME-}
case $ert in
  [1-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*[.,][0-9]*)
    s=${ert%[.,]*}
    f=${ert#*[.,]}000
    f=${f%"${f#???}"} ;;
  *)
    t=$(date +%s%N)
    case $t in
      "" | *[!0-9]*) s=$(date +%s); f=000 ;;
      *) s=${t%?????????}; f=${t#"$s"}; f=${f%??????} ;;
    esac ;;
esac
case $s in "" | *[!0-9]*) to_node_with "$@" ;; esac
# A leading zero would make $((…)) read the milliseconds as octal.
case $f in 00?) f=${f#00} ;; 0??) f=${f#0} ;; esac
ts=$((s * 1000 + f))

# The UTC day (days-from-civil, inverted), for <agent>/<yyyy-mm-dd>.jsonl.
z=$((s / 86400 + 719468))
era=$((z / 146097))
doe=$((z - era * 146097))
yoe=$(((doe - doe / 1460 + doe / 36524 - doe / 146096) / 365))
doy=$((doe - (365 * yoe + yoe / 4 - yoe / 100)))
mp=$(((5 * doy + 2) / 153))
dom=$((doy - (153 * mp + 2) / 5 + 1))
mon=$((mp < 10 ? mp + 3 : mp - 9))
year=$((yoe + era * 400 + (mon <= 2)))
[ $mon -lt 10 ] && mon=0$mon
[ $dom -lt 10 ] && dom=0$dom
day=$year-$mon-$dom

# cwd: the payload's "cwd" when it is a plain string near the start and not
# inside a nested object or list (tool_input.cwd), else the process cwd (agents
# run hooks in the session's directory). The payload itself is kept as sent.
cwd=
for k in '"cwd":"' '"cwd": "'; do
  case $raw in
    *"$k"*)
      pre=${raw%%"$k"*}
      case ${pre#?} in *[{[]*) break ;; esac
      if [ ${#pre} -le 1024 ]; then
        rest=${raw#"$pre$k"}
        cwd=${rest%%\"*}
        case $cwd in *\\* | *[[:cntrl:]]*) cwd= ;; esac
      fi
      break ;;
  esac
done
if [ -z "$cwd" ]; then
  cwd=$PWD
  case $cwd in "" | *[\"\\]* | *[[:cntrl:]]*) to_node_with "$@" ;; esac
fi

[ -n "$end" ] && um=$(umask)
umask 077

dir=$home/spool/$agent
[ -d "$dir" ] || mkdir -p "$dir" || to_node_with "$@"
# The day's file, or its latest numbered continuation. The 64 MB cap is soft:
# one call in 256 measures the file (wc(1) is a process start, kept out of the
# hook's p95) and moves on to the next number.
file=$dir/$day.jsonl
n=1
while [ -e "$dir/$day.$n.jsonl" ]; do
  file=$dir/$day.$n.jsonl
  n=$((n + 1))
done
if [ $(($$ % 256)) -eq 0 ] && [ -f "$file" ]; then
  size=$(wc -c <"$file")
  size=${size##* }
  case $size in "" | *[!0-9]*) ;; *) [ "$size" -ge 67108864 ] && file=$dir/$day.$n.jsonl ;; esac
fi

meta="{\"v\":0,\"agent\":\"$agent\",\"event\":\"$event\",\"ts\":$ts,\"pid\":$$,\"ppid\":$PPID,\"cwd\":\"$cwd\"$extra"
line=
if [ -z "$raw" ]; then
  line="$meta,\"raw\":\"\"}"
else
  case $raw in
    "{}" | '{"'*"}")
      case $raw in
        *'
'*) ;;
        *) line="$meta,\"raw\":$raw}"; [ ${#line} -le 1023 ] || line= ;;
      esac ;;
  esac
  # Braces or brackets that do not pair up ({"a":1}}): not JSON, so not inline.
  # Pattern substitution is bash and zsh only; eval keeps dash from parsing it.
  if [ -n "$line" ] && [ -n "${BASH_VERSION-}${ZSH_VERSION-}" ]; then
    eval 'o=${raw//[!\{]/} c=${raw//[!\}]/} lo=${raw//[!\[]/} lc=${raw//[!\]]/}'
    [ ${#o} -eq ${#c} ] && [ ${#lo} -eq ${#lc} ] || line=
  fi
fi
side=
if [ -z "$line" ]; then
  [ -d "$dir/raw" ] || mkdir -p "$dir/raw" || to_node_with "$@"
  side=$dir/raw/$ts-$$-sh.json
  set -C
  printf '%s' "$raw" >"$side" || to_node_with "$@"
  set +C
  line="$meta,\"rawFile\":\"$side\"}"
fi
if ! printf '%s\n' "$line" >>"$file"; then
  # Nothing references the side file: don't leave the payload behind.
  [ -n "$side" ] && rm -f "$side"
  to_node_with "$@"
fi
if [ -n "${readfail-}" ]; then
  printf '{"ts":%s,"pid":%s,"agent":"%s","event":"%s","where":"hook.sh","error":"reading stdin failed: the payload may be cut short"}\n' "$ts" "$$" "$agent" "$event" >>"$home/spool/errors.log"
fi

answer

# After the reply, so the agent is never kept waiting on the spawn.
if [ -n "$end" ]; then
  printf '' >"$home/spool/.ingest.pending"
  cli=
  [ -r "$home/bin/cli-path" ] && IFS= read -r cli <"$home/bin/cli-path"
  if [ -n "$cli" ] && [ -f "$cli" ]; then
    if command -v setsid >/dev/null; then
      (umask "$um"; NODE_OPTIONS= exec setsid node "$cli" ingest --background) </dev/null >/dev/null 2>&1 &
    else
      set -m
      (umask "$um"; NODE_OPTIONS= exec node "$cli" ingest --background) </dev/null >/dev/null 2>&1 &
    fi
  fi
fi
exit 0
