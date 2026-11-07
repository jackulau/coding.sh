// Fake executables that run on every platform.
//
// A test "binary" is a node script with a shebang. Windows cannot run that by
// name, so there it also gets the `.cmd` shim npm would write for it: the same
// layout a real npm-installed agent CLI has on Windows.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The `.cmd` file npm's cmd-shim writes for a node bin `target` (a file next to it). */
export function npmCmdShim(target: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    "",
  ].join("\r\n");
}

/** Write `dir/name` as a node script (plus `name.cmd` on Windows) and return the script path. */
export function nodeBin(dir: string, name: string, js: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  // The absolute node: a test PATH may hold nothing but the fake bins.
  writeFileSync(p, `#!${process.execPath}\n${js}`);
  chmodSync(p, 0o755);
  if (process.platform === "win32") writeFileSync(`${p}.cmd`, npmCmdShim(name));
  return p;
}

/** A fake `name` that prints `stdout` (plus a newline) and exits with `code`. */
export function printBin(dir: string, name: string, stdout: string, code = 0): string {
  return nodeBin(dir, name, `process.stdout.write(${JSON.stringify(`${stdout}\n`)});\nprocess.exitCode = ${code};\n`);
}

/** `dirs` joined into a PATH value with this platform's separator. */
export function pathOf(...dirs: (string | undefined)[]): string {
  return dirs.filter(Boolean).join(delimiter);
}
