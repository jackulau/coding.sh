#!/bin/sh
set -eu
export npm_config_prefix="$TMP/prefix" PATH="$TMP/prefix/bin:$PATH"
npm install -g coding.sh@latest
sh install.sh
