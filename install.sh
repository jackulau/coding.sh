#!/bin/sh
# coding.sh installer:  curl -fsSL https://coding.sh/install | sh
#
# 1. Checks for Node >= 22.16.
# 2. Installs coding.sh: from npm when the registry has it (npm i -g coding.sh@<version>),
#    otherwise the tarball attached to the GitHub release. Both are the same bytes.
# 3. Runs `coding.sh init`: detects your agents, shows one plan (capture hooks +
#    the coding.sh MCP server for each agent), asks once (Y/n) before writing.
# 4. Opens the local viewer.
#
# Env: CODING_SH_VERSION=v0.1.0 pins a release. CODING_SH_TARBALL=<path or url> installs that tarball. CODING_SH_YES=1 skips the prompt.
#      CODING_SH_SOURCE=npm|github forces a source (default: npm if published, else github).
#      CODING_SH_NO_INIT=1 installs only. CODING_SH_NO_UI=1 skips opening the viewer.
set -eu

REPO="jackulau/coding.sh"
say() { printf '%s\n' "$*" >&2; }
die() { say "coding.sh: $*"; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js 22.16+ is required. Install it from https://nodejs.org and rerun."
command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

node -e '
const [maj, min] = process.versions.node.split(".").map(Number);
process.exit(maj > 22 || (maj === 22 && min >= 16) ? 0 : 1);
' || die "Node $(node -v) found; coding.sh needs 22.16 or newer."

SOURCE="${CODING_SH_SOURCE:-auto}"
case "$SOURCE" in auto|npm|github) ;; *) die "CODING_SH_SOURCE must be npm or github, got $SOURCE." ;; esac

# Prints the version npm would install for coding.sh@$1, or nothing when the
# registry (your configured one, so mirrors work) does not have it.
npm_has() {
  npm view "coding.sh@$1" version --fetch-retries=1 --fetch-timeout=15000 2>/dev/null \
    | tail -n 1 | awk '{print $NF}' | tr -d "'"
}

if [ -n "${CODING_SH_TARBALL:-}" ]; then
  # Local or custom tarball (tests, mirrors, air-gapped installs).
  URL="$CODING_SH_TARBALL"
  VERSION="from $URL"
else
  VERSION="${CODING_SH_VERSION:-}"
  URL=
  if [ "$SOURCE" != "github" ]; then
    SPEC="${VERSION#v}"
    NPM_VERSION=$(npm_has "${SPEC:-latest}")
    case "$NPM_VERSION" in [0-9]*.[0-9]*.[0-9]*) ;; *) NPM_VERSION= ;; esac
    if [ -n "$NPM_VERSION" ]; then
      VERSION="v$NPM_VERSION"
      URL="coding.sh@$NPM_VERSION"
    elif [ "$SOURCE" = "npm" ]; then
      die "npm has no coding.sh${VERSION:+ $VERSION}. Unset CODING_SH_SOURCE to install from GitHub."
    fi
  fi
  if [ -z "$URL" ]; then
    if [ -z "$VERSION" ]; then
      VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1) || true
      [ -n "$VERSION" ] || die "Could not find the latest release of $REPO."
    fi
    NUM="${VERSION#v}"
    URL="https://github.com/$REPO/releases/download/$VERSION/coding.sh-$NUM.tgz"
  fi
fi

say "Installing coding.sh $VERSION"
npm install -g --silent --no-fund --no-audit "$URL" >&2 || die "npm install failed. Try: npm install -g $URL"

# Where npm put the shims: <prefix>/bin on POSIX, <prefix> itself on Windows.
PREFIX=$(npm prefix -g 2>/dev/null || true)
WINDOWS=
case "$(uname -s 2>/dev/null || true)" in
  MINGW*|MSYS*|CYGWIN*) BIN_DIR="$PREFIX"; WINDOWS=1 ;;
  *) BIN_DIR="$PREFIX/bin" ;;
esac
CSH=coding.sh
if [ -n "$PREFIX" ]; then
  BIN_POSIX="$BIN_DIR"
  command -v cygpath >/dev/null 2>&1 && BIN_POSIX=$(cygpath -u "$BIN_DIR" 2>/dev/null || printf '%s' "$BIN_DIR")
  # Use the binary just installed, not whichever coding.sh comes first on PATH.
  if [ -f "$BIN_POSIX/coding.sh" ]; then
    CSH="$BIN_POSIX/coding.sh"
    FIRST=$(command -v coding.sh 2>/dev/null || true)
    case "$FIRST" in
      "") say "coding.sh: installed in \"$BIN_DIR\", which is not on PATH. Add it to PATH to run coding.sh." ;;
      */*)
        # Another coding.sh comes first on PATH (an older global install, say):
        # `coding.sh` would run that one, not the version just installed.
        if ! [ "$FIRST" -ef "$CSH" ] && [ "$FIRST" != "$CSH" ]; then
          OTHER_V=$("$FIRST" --version </dev/null 2>/dev/null | head -n 1 || true)
          say "coding.sh: another coding.sh (${OTHER_V:+$OTHER_V, }$FIRST) comes first on PATH; put \"$BIN_DIR\" ahead of it, or remove it."
        fi ;;
    esac
  fi
fi
[ "$CSH" != coding.sh ] || command -v coding.sh >/dev/null 2>&1 || die "Installed, but coding.sh is not on PATH. Add \"$BIN_DIR\" to PATH."

# Prints the command to run next. On Windows npm also writes an extensionless sh
# shim named coding.sh, and PowerShell and cmd pick it over coding.sh.cmd/.ps1
# (PowerShell then fails or opens it in the .sh file's app), so name `codingsh`
# for them: the same CLI under a name without a dot.
win_note() {
  [ -z "$WINDOWS" ] || say "In PowerShell or cmd, type codingsh instead of coding.sh${1:+ (codingsh $1)}: there, coding.sh opens npm's sh script instead of running it."
}
next() { say "Done. Run: coding.sh $1"; win_note "$1"; }

[ "${CODING_SH_NO_INIT:-}" = "1" ] && { next init; exit 0; }

# stdin is this script when piped into sh; prompts and the viewer use the
# terminal instead. (Opening /dev/tty fails without a controlling terminal.)
has_tty() { (exec </dev/tty) 2>/dev/null; }

status=0
if [ "${CODING_SH_YES:-}" = "1" ]; then
  "$CSH" init --yes || status=$?
elif has_tty; then
  "$CSH" init </dev/tty || status=$?
else
  # An agent's shell or CI: installed, nothing set up. Name the exact next command
  # (bare `coding.sh` without a terminal only prints help).
  say "Installed. No terminal to ask on, so no agent was set up yet."
  say "Next: coding.sh init --dry-run to see the plan, then coding.sh init --yes (or rerun with CODING_SH_YES=1)."
  win_note
  exit 0
fi
# Canceled at the prompt: stop here. Other failures were already explained by init.
[ "$status" = "130" ] && exit 130

[ "${CODING_SH_NO_UI:-}" = "1" ] && { win_note; exit 0; }
# The viewer is a long-running server: start it only for a person at a
# terminal, never in CI or a Docker build (CODING_SH_YES=1 with no tty).
if has_tty; then win_note ui; "$CSH" ui </dev/tty; else next ui; fi
