#!/usr/bin/env bash
# Publishes the packed npm tarballs in DIR, in dependency order (the stores
# peer-depend on coding.sh), skipping any version already on npm.
#
#   scripts/release/publish-npm.sh DIR             # the publish-npm job
#   scripts/release/publish-npm.sh DIR --dry-run   # the verify job, before approval
#
# Both jobs run this same script from the same relative DIR, so a tarball path
# that npm misreads fails the dry run in verify instead of the real publish.
set -euo pipefail
dir=${1:?usage: publish-npm.sh DIR [--dry-run]}
dry=
[ "${2:-}" != "--dry-run" ] || dry=--dry-run

for name in coding.sh @codingdotsh/sdk coding.sh-store-postgres coding.sh-store-s3 coding.sh-store-clickhouse; do
  base=${name#@}
  tgz=$(ls "$dir/${base/\//-}-"[0-9]*.tgz)
  # A bare relative path such as npm/coding.sh-1.2.3.tgz is GitHub shorthand to
  # npm (it runs git ls-remote on github.com/npm/...); ./ makes it a file.
  case "$tgz" in /*|./*) ;; *) tgz="./$tgz" ;; esac
  v=$(tar -xzOf "$tgz" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/${name/\//%2f}/$v")
  case "$code" in
    200) echo "$name@$v is already on npm, skipping"; continue ;;
    404) ;;
    *) echo "::error::registry returned $code for $name@$v"; exit 1 ;;
  esac
  echo "publishing $name@$v${dry:+ (dry run)}"
  npm publish "$tgz" --access public --provenance ${dry:+"$dry"}
done
