#!/bin/sh
# coding.sh installer:  curl -fsSL https://coding.sh/install | sh
#
# 1. Checks for Node >= 22.15.
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

command -v node >/dev/null 2>&1 || die "Node.js 22.15+ is required. Install it from https://nodejs.org and rerun."
command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."

node -e '
const [maj, min] = process.versions.node.split(".").map(Number);
process.exit(maj > 22 || (maj === 22 && min >= 15) ? 0 : 1);
' || die "Node $(node -v) found; coding.sh needs 22.15 or newer."

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

command -v coding.sh >/dev/null 2>&1 || die "Installed, but coding.sh is not on PATH. Add \"$(npm prefix -g)/bin\" to PATH."

[ "${CODING_SH_NO_INIT:-}" = "1" ] && { say "Done. Run: coding.sh init"; exit 0; }

# stdin is this script when piped into sh; prompts and the viewer use the
# terminal instead. (Opening /dev/tty fails without a controlling terminal.)
has_tty() { (exec </dev/tty) 2>/dev/null; }

status=0
if [ "${CODING_SH_YES:-}" = "1" ]; then
  coding.sh init --yes || status=$?
elif has_tty; then
  coding.sh init </dev/tty || status=$?
else
  # An agent's shell or CI: installed, nothing set up. Name the exact next command
  # (bare `coding.sh` without a terminal only prints help).
  say "Installed. No terminal to ask on, so no agent was set up yet."
  say "Next: coding.sh init --dry-run to see the plan, then coding.sh init --yes (or rerun with CODING_SH_YES=1)."
  exit 0
fi
# Canceled at the prompt: stop here. Other failures were already explained by init.
[ "$status" = "130" ] && exit 130

[ "${CODING_SH_NO_UI:-}" = "1" ] && exit 0
# The viewer is a long-running server: start it only for a person at a
# terminal, never in CI or a Docker build (CODING_SH_YES=1 with no tty).
if has_tty; then coding.sh ui </dev/tty; else say "Done. Run: coding.sh ui"; fi
