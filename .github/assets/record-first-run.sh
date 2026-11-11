#!/bin/bash
# Records first-run.gif: a real `npx coding.sh` (the latest release on npm) in a throwaway HOME
# that holds the sessions sample-sessions.mjs writes, then `npx coding.sh usage --by model`.
# Run from the repo root (macOS or Linux; needs expect, asciinema 3, agg and ImageMagick):
#
#   .github/assets/record-first-run.sh
#
# The shell runs with a clean environment: HOME, the npm prefix and PATH all point into the temp
# dir, so no real agent config, store or global npm package is read or written. `claude` and
# `codex` on that PATH are stubs that only answer --version, so init finds both agents. T3 Code
# shows up when its app is installed on the machine that records. npx's own download spinner is
# cut and its wait capped at 0.6 s; everything else is the recorded output and timing.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/bin" "$T/prefix/bin"
for b in node npm npx; do ln -s "$(command -v $b)" "$T/bin/$b"; done
printf '#!/bin/sh\n[ "$1" = --version ] && { echo "2.4.1 (Claude Code)"; exit 0; }\nexit 1\n' > "$T/bin/claude"
printf '#!/bin/sh\n[ "$1" = --version ] && { echo "codex-cli 0.171.0"; exit 0; }\nexit 1\n' > "$T/bin/codex"
chmod +x "$T/bin/claude" "$T/bin/codex"
CLEAN=(env -i HOME="$T/home" PATH="$T/prefix/bin:$T/bin:/usr/bin:/bin" TERM=xterm-256color LANG=en_US.UTF-8
  BASH_SILENCE_DEPRECATION_WARNING=1 PS1='$ ' npm_config_prefix="$T/prefix" npm_config_yes=true
  npm_config_update_notifier=false CODING_SH_NO_UPDATE_CHECK=1)
"${CLEAN[@]}" node "$here/sample-sessions.mjs" "$T/home" > /dev/null
"${CLEAN[@]}" npx coding.sh --version > /dev/null   # fill the npx cache, so the take shows no download

cat > "$T/take.exp" <<'EOF'
set timeout 90
expect_after timeout { puts stderr "timed out"; exit 3 }
proc typeit {s} { foreach c [split $s ""] { send -- $c; expect -re {.}; after [expr {60 + int(rand()*50)}] } }
spawn -noecho bash --norc --noprofile
expect -re {\$ $}
after 600
typeit "npx coding.sh"
after 300; send "\r"
expect -re {Y/n}
after 1400; send "y"; after 300; send "\r"
expect -re {\$ $}
after 2200
typeit "npx coding.sh usage --by model"
after 300; send "\r"
expect -re {\$ $}
after 500
send "exit\r"
expect eof
EOF
{ echo '#!/bin/sh'; printf 'exec'; printf ' %q' "${CLEAN[@]}" expect "$T/take.exp"; echo; } > "$T/take.sh"
chmod +x "$T/take.sh"
grep -q '^exec env -i ' "$T/take.sh" && [ "$(wc -l < "$T/take.sh")" -eq 2 ] || { echo "bad take.sh" >&2; exit 1; }
(cd "$T" && asciinema rec --headless --window-size 100x33 -c "$T/take.sh" "$T/take.cast" > /dev/null)

python3 - "$T/take.cast" "$T/trim.cast" <<'EOF'
import json, re, sys
lines = open(sys.argv[1]).read().splitlines()
out, pending = [], 0.0
for d, kind, data in (json.loads(l) for l in lines[1:]):
    if kind != "o":
        continue
    if data.startswith("exit"):
        break
    text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", data)
    if text and all("⠀" <= c <= "⣿" for c in text):  # npx's spinner frame
        pending += d
        continue
    out.append([round(min(pending + d, 0.6), 3) if pending else d, kind, data])
    pending = 0.0
shown = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", "".join(e[2] for e in out))
if not (shown.startswith("$ npx coding.sh") and "Imported 9 past sessions" in shown and "claude-opus-5-5" in shown):
    sys.exit("the take is not the expected first run:\n" + shown[:400])
open(sys.argv[2], "w").write(lines[0] + "\n" + "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in out))
EOF
agg --idle-time-limit 2 --last-frame-duration 6 --fps-cap 30 "$T/trim.cast" "$T/raw.gif" > /dev/null 2>&1
magick "$T/raw.gif" -layers Optimize "$here/first-run.gif"
echo "wrote .github/assets/first-run.gif ($(wc -c < "$here/first-run.gif" | tr -d ' ') bytes)"
