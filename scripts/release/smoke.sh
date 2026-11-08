#!/bin/sh
# Pre-publish smoke test: packs every npm package and the Python SDK, installs
# them into throwaway prefixes with a throwaway HOME, and exercises each one the
# way a user would. Nothing is published and the real HOME is never touched.
#
#   scripts/release/smoke.sh               # from the repository root, after `npm ci`
#   CODING_SH_SMOKE_PG_URL=postgres://... scripts/release/smoke.sh   # also run the store on Postgres
#   CODING_SH_SMOKE_CH_URL=clickhouse://... scripts/release/smoke.sh # also run the store on ClickHouse
#
# CODING_SH_SMOKE_NPM_DIR / CODING_SH_SMOKE_PY_DIR test already-built tarballs,
# sdists and wheels (the release workflow passes the exact files it publishes).
#
# Needs Node 22.15+, npm, curl and python3 (with venv).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$(mktemp -d)
SERVE_PID=
cleanup() { [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
export HOME="$W/home" NO_UPDATE_NOTIFIER=1 CODING_SH_NO_UPDATE_CHECK=1 npm_config_update_notifier=false
mkdir -p "$HOME/.claude" "$W/pack" "$W/app"
step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

step "pack"
if [ -n "${CODING_SH_SMOKE_NPM_DIR:-}" ]; then
  cp "$CODING_SH_SMOKE_NPM_DIR"/*.tgz "$W/pack/"
else
  for p in coding.sh sdk store-postgres blob-s3 store-clickhouse; do
    (cd "$ROOT/packages/$p" && { [ ! -f scripts/build.mjs ] || node scripts/build.mjs >/dev/null; } \
      && npm pack --silent --pack-destination "$W/pack" >/dev/null)
  done
fi
ls "$W/pack"
[ "$(find "$W/pack" -name "*.tgz" | wc -l)" -eq 5 ] || fail "expected 5 npm tarballs"
for t in "$W"/pack/*.tgz; do
  bad=$(tar -tzf "$t" | grep -E '(^|/)(test|tests|fixtures?|__tests__|\.env[^/]*|\.npmrc|[^/]*\.pem|[^/]*\.test\.[a-z]+|src/[^/]*\.ts)$' || true)
  [ -z "$bad" ] || fail "$(basename "$t") ships: $bad"
  mkdir -p "$W/x" && tar -xzf "$t" -C "$W/x"
  if grep -rIlE 'sk-ant-api[0-9A-Za-z_-]{20,}|ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{40,}|AKIA[0-9A-Z]{16}|npm_[0-9A-Za-z]{36}|BEGIN [A-Z ]*PRIVATE KEY' "$W/x" >/dev/null; then
    fail "$(basename "$t") contains something that looks like a secret"
  fi
  rm -rf "$W/x"
done
CLI=$(ls "$W"/pack/coding.sh-[0-9]*.tgz)

step "coding.sh: global install into a clean prefix"
npm i -g --silent --no-fund --no-audit --prefix "$W/prefix" "$CLI" "$W"/pack/coding.sh-store-*.tgz
B="$W/prefix/bin/coding.sh"
"$B" --version
"$W/prefix/bin/codingsh" --version >/dev/null
"$B" init --agent claude-code --dry-run
[ ! -f "$HOME/.claude/settings.json" ] || fail "init --dry-run wrote settings.json"

step "coding.sh ui: start and stop"
"$B" ui --port 0 --no-open >"$W/ui.out" 2>"$W/ui.err" &
UI_PID=$!
i=0; until grep -q '^http' "$W/ui.out" 2>/dev/null; do i=$((i+1)); [ $i -lt 100 ] || fail "ui did not start: $(cat "$W/ui.err")"; sleep 0.1; done
UI_URL=$(head -n 1 "$W/ui.out")
code=$(curl -s -o /dev/null -L -c "$W/jar" -b "$W/jar" -w '%{http_code}' "$UI_URL")
[ "$code" = 200 ] || fail "ui returned $code"
echo "ui ${UI_URL%%\?*} -> $code"
kill -INT "$UI_PID"; st=0; wait "$UI_PID" || st=$?
[ "$st" = 0 ] || [ "$st" = 130 ] || fail "ui exited $st"
curl -s -o /dev/null --max-time 2 "$UI_URL" && fail "ui still answering after stop"
echo "ui stopped (exit $st)"

step "store plugins resolve from the global install"
NODE_PATH="$W/prefix/lib/node_modules" node --input-type=module -e '
const s3 = await import("coding.sh-store-s3");
const pg = await import("coding.sh-store-postgres");
const ch = await import("coding.sh-store-clickhouse");
if (typeof s3.blobStore !== "function" || typeof pg.indexStore !== "function" || typeof pg.blobStore !== "function" || typeof ch.indexStore !== "function") throw new Error("plugin factory missing");
s3.blobStore("s3://bucket/prefix?region=auto&endpoint=http://127.0.0.1:9");
console.log("store-s3, store-postgres and store-clickhouse load");
' 2>/dev/null || (cd "$W/prefix/lib/node_modules/coding.sh" && node --input-type=module -e '
const s3 = await import("coding.sh-store-s3"); const pg = await import("coding.sh-store-postgres"); const ch = await import("coding.sh-store-clickhouse");
if (typeof s3.blobStore !== "function" || typeof pg.indexStore !== "function" || typeof ch.indexStore !== "function") throw new Error("plugin factory missing");
console.log("store-s3, store-postgres and store-clickhouse load");')

step "coding.sh types: a TypeScript consumer of coding.sh/schema and coding.sh/store"
cd "$W/app"
printf '{"name":"app","private":true,"type":"module"}\n' >package.json
npm i --silent --no-fund --no-audit "$CLI" "$(ls "$W"/pack/coding.sh-sdk-*.tgz)"
cat >check.ts <<'EOF'
import type { BlobStore, IndexStore } from "coding.sh/store";
import { observe, trace, span, flush, init, stats } from "@codingdotsh/sdk";
export type T = [BlobStore, IndexStore, typeof observe, typeof trace, typeof span, typeof flush, typeof init, typeof stats];
EOF
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --skipLibCheck false --module nodenext --moduleResolution nodenext --target es2022 --types node --typeRoots "$ROOT/node_modules/@types" check.ts
echo "types resolve"

step "@codingdotsh/sdk: import and send a trace to a local coding.sh serve"
"$B" serve --port 0 >"$W/serve.out" 2>"$W/serve.err" &
SERVE_PID=$!
i=0; until grep -q '^http' "$W/serve.out" 2>/dev/null; do i=$((i+1)); [ $i -lt 150 ] || fail "serve did not start: $(cat "$W/serve.err")"; sleep 0.1; done
SERVE_URL=$(head -n 1 "$W/serve.out")
echo "serve $SERVE_URL"
CODING_SH_URL="$SERVE_URL" CODING_SH_SERVICE=smoke-js node --input-type=module -e '
import { trace, span, flush, stats } from "@codingdotsh/sdk";
const out = await trace("smoke-js-turn", async () => {
  await span("tool", "lookup", async () => ({ ok: true }), { input: { id: 1 } });
  return "done";
}, { sessionId: "smoke-js-session", input: "hello" });
if (out !== "done") throw new Error("trace changed the return value");
if (!(await flush(5000))) throw new Error("flush timed out: " + JSON.stringify(stats()));
const s = stats();
if (s.sent < 1 || s.failed || s.dropped) throw new Error("sdk stats " + JSON.stringify(s));
console.log("sdk sent", JSON.stringify(s));
'

step "coding-sh (Python): build, install, import and send a trace"
python3 -m venv "$W/venv"
if [ -n "${CODING_SH_SMOKE_PY_DIR:-}" ]; then
  mkdir -p "$W/pydist" && cp "$CODING_SH_SMOKE_PY_DIR"/* "$W/pydist/"
else
  "$W/venv/bin/pip" install -q --disable-pip-version-check build
  (cd "$ROOT/packages/sdk-python" && "$W/venv/bin/python" -m build -q --outdir "$W/pydist" . >/dev/null)
  rm -rf "$ROOT/packages/sdk-python/build" "$ROOT"/packages/sdk-python/src/*.egg-info
fi
ls "$W/pydist"
for f in "$W"/pydist/*; do
  case "$f" in
    *.whl) list=$("$W/venv/bin/python" -m zipfile -l "$f") ;;
    *.tar.gz) list=$(tar -tzf "$f") ;;
  esac
  echo "$list" | grep -Eq '(^|/)tests?/|harness\.ts|__pycache__' && fail "$(basename "$f") ships tests or caches"
done
"$W/venv/bin/pip" install -q --disable-pip-version-check "$W"/pydist/*.whl
CODING_SH_URL="$SERVE_URL" CODING_SH_SERVICE=smoke-py "$W/venv/bin/python" -I -c '
import coding_sh
print("coding_sh", coding_sh.__version__)
with coding_sh.trace("smoke-py-turn", session_id="smoke-py-session", input="hello"):
    with coding_sh.span("tool", "lookup", input={"id": 1}) as s:
        s.set_output({"ok": True})
assert coding_sh.flush(5), "flush timed out"
'

step "both SDK sessions reached the server"
i=0
until "$B" sessions --json 2>/dev/null | grep -q smoke-py-session && "$B" sessions --json 2>/dev/null | grep -q smoke-js-session; do
  i=$((i+1)); [ $i -lt 50 ] || { "$B" sessions --json >&2 || true; fail "sessions not found in the store"; }; sleep 0.2
done
echo "found smoke-js-session and smoke-py-session"
kill "$SERVE_PID"; wait "$SERVE_PID" 2>/dev/null || true; SERVE_PID=

if [ -n "${CODING_SH_SMOKE_PG_URL:-}" ]; then
  step "coding.sh-store-postgres: serve on Postgres, SDK trace, read back with the CLI"
  export CODING_SH_STORE_URL="$CODING_SH_SMOKE_PG_URL"
  "$B" serve --port 0 >"$W/pg.out" 2>"$W/pg.err" &
  SERVE_PID=$!
  i=0; until grep -q '^http' "$W/pg.out" 2>/dev/null; do i=$((i+1)); [ $i -lt 150 ] || fail "serve on postgres did not start: $(cat "$W/pg.err")"; sleep 0.1; done
  CODING_SH_URL=$(head -n 1 "$W/pg.out") node --input-type=module -e '
import { trace, flush } from "@codingdotsh/sdk";
await trace("smoke-pg-turn", async () => "ok", { sessionId: "smoke-pg-session" });
if (!(await flush(5000))) throw new Error("flush timed out");'
  i=0; until "$B" sessions --json 2>/dev/null | grep -q smoke-pg-session; do i=$((i+1)); [ $i -lt 50 ] || fail "session not in postgres"; sleep 0.2; done
  echo "found smoke-pg-session in postgres"
  kill "$SERVE_PID"; wait "$SERVE_PID" 2>/dev/null || true; SERVE_PID=
  unset CODING_SH_STORE_URL
fi

if [ -n "${CODING_SH_SMOKE_CH_URL:-}" ]; then
  step "coding.sh-store-clickhouse: serve on ClickHouse, SDK trace, read back with the CLI"
  export CODING_SH_STORE_URL="$CODING_SH_SMOKE_CH_URL"
  "$B" serve --port 0 >"$W/ch.out" 2>"$W/ch.err" &
  SERVE_PID=$!
  i=0; until grep -q '^http' "$W/ch.out" 2>/dev/null; do i=$((i+1)); [ $i -lt 150 ] || fail "serve on clickhouse did not start: $(cat "$W/ch.err")"; sleep 0.1; done
  CODING_SH_URL=$(head -n 1 "$W/ch.out") node --input-type=module -e '
import { trace, flush } from "@codingdotsh/sdk";
await trace("smoke-ch-turn", async () => "ok", { sessionId: "smoke-ch-session" });
if (!(await flush(5000))) throw new Error("flush timed out");'
  i=0; until "$B" sessions --json 2>/dev/null | grep -q smoke-ch-session; do i=$((i+1)); [ $i -lt 50 ] || fail "session not in clickhouse"; sleep 0.2; done
  echo "found smoke-ch-session in clickhouse"
  kill "$SERVE_PID"; wait "$SERVE_PID" 2>/dev/null || true; SERVE_PID=
  unset CODING_SH_STORE_URL
fi

step "install.sh with a local tarball (today's GitHub-release path, offline)"
CODING_SH_TARBALL="$CLI" CODING_SH_NO_INIT=1 npm_config_prefix="$W/prefix2" PATH="$W/prefix2/bin:$PATH" sh "$ROOT/install.sh"
"$W/prefix2/bin/coding.sh" --version

printf '\nSMOKE OK\n'
