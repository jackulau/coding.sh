#!/bin/sh
# Fetch the skill under test at a pinned commit and check its hash. The skill is
# not vendored in this repo: vercel-security-audit by DarlingtonDeveloper, MIT,
# https://github.com/DarlingtonDeveloper/vercel-security-audit
#   fetch-skill.sh <dest>   ->  <dest>/vercel-security-audit/SKILL.md, references/, scripts/, assets/
set -eu
SHA=c219b212a5ccb5d72add0f300c471c4c1fef86a1
TARBALL_SHA256=3c3279ed337c79b9d1890241fd1abce5e4a96495e991209f867e1a60952e38ae
dest=${1:?usage: fetch-skill.sh <dest>}
if [ -f "$dest/vercel-security-audit/SKILL.md" ] && [ "$(cat "$dest/.sha" 2>/dev/null)" = "$SHA" ]; then exit 0; fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -sSfL -o "$tmp/skill.tgz" "https://codeload.github.com/DarlingtonDeveloper/vercel-security-audit/tar.gz/$SHA"
echo "$TARBALL_SHA256  $tmp/skill.tgz" | sha256sum -c - >/dev/null || { echo "fetch-skill: checksum mismatch for $SHA" >&2; exit 1; }
tar xzf "$tmp/skill.tgz" -C "$tmp"
rm -rf "$dest/vercel-security-audit"
mkdir -p "$dest"
cp -R "$tmp/vercel-security-audit-$SHA/skills/vercel-security-audit" "$dest/"
cp "$tmp/vercel-security-audit-$SHA/LICENSE" "$dest/vercel-security-audit.LICENSE"
echo "$SHA" > "$dest/.sha"
