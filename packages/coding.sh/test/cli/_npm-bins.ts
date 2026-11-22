// The bins `npm i -g coding.sh` puts on PATH, so a test can put an install there without npm.
// Windows: npm's cmd shim codingsh.cmd (PowerShell and cmd) and its sh shim coding.sh (Git
// Bash), next to node_modules. macOS and Linux: <prefix>/bin/coding.sh, a link to the CLI. The
// shim texts are npm 11's cmd-shim for a bin that starts with `#!/usr/bin/env node`.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { npmCmdShim } from "../_bin.ts";

/** The sh script npm's cmd-shim writes on Windows for a node bin `target` (relative to it, with `/`). */
export function npmShShim(target: string): string {
  return [
    "#!/bin/sh",
    `basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")`,
    "",
    "case `uname` in",
    "    *CYGWIN*|*MINGW*|*MSYS*)",
    "        if command -v cygpath > /dev/null 2>&1; then",
    '            basedir=`cygpath -w "$basedir"`',
    "        fi",
    "    ;;",
    "esac",
    "",
    'if [ -x "$basedir/node" ]; then',
    `  exec "$basedir/node"  "$basedir/${target}" "$@"`,
    "else ",
    `  exec node  "$basedir/${target}" "$@"`,
    "fi",
    "",
  ].join("\n");
}

/**
 * Writes the bins of a global npm install of `cli` (…/node_modules/coding.sh/dist/cli.mjs) and
 * returns the directory PATH names for them: on Windows the directory that holds node_modules,
 * with codingsh.cmd and the sh coding.sh in it; elsewhere the bin/ beside it, with coding.sh a
 * link to `cli`.
 */
export function npmBins(cli: string): string {
  const lib = dirname(dirname(dirname(dirname(cli))));
  const target = relative(lib, cli);
  if (process.platform === "win32") {
    writeFileSync(join(lib, "codingsh.cmd"), npmCmdShim(target.replaceAll("/", "\\")));
    writeFileSync(join(lib, "coding.sh"), npmShShim(target.replaceAll("\\", "/")));
    return lib;
  }
  const bin = join(dirname(lib), "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(relative(bin, cli), join(bin, "coding.sh"));
  return bin;
}
