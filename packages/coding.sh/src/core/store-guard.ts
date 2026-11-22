// The guards around the store in a coding.sh home. Index migrations are one-way,
// so a newer build that migrates a store strands every older install that shares
// it: on 2026-11-08 a run from a source checkout migrated a real ~/.coding.sh
// from index schema v8 to v9 and the installed CLI could not open it again.
//
// 1. sourceRunRefusal: coding.sh run from a git checkout of this repo (src/*.ts,
//    or a dist/ built inside one) does not open the default home unless told to.
// 2. ownerGuard, before pending index migrations of a home's index:
//    - they wait for the install that owns the store, the CLI named in
//      <home>/bin/cli-path (init and update write it, and hooks start that CLI);
//    - they wait for a release newer than the store's last writer (the stamp
//      store/upgrade.ts WRITER_KEY): a build of the same or an older version
//      that knows a newer schema is not the release that follows it;
//    - a store with no stamp (written before 0.1.6) is never migrated by a run
//      from a source checkout.
//    Each refusal changes nothing and names `upgrade-store` as a command that
//    runs the install that refused (upgradeStoreCommand): it migrates on
//    request, keeps a copy of the index and can put it back.
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../cli/meta.ts";
import { cliCommand, quoteArg, windowsShell } from "../cli/next-steps.ts";
import { runningCli } from "../mcp/launch.ts";
import type { StoreWriter } from "../store/upgrade.ts";
import { isNewer } from "../update/semver.ts";
import { dataHome } from "./paths.ts";

/** The first `n` bytes of `file` as text ("" when it can't be read). */
function head(file: string, n = 8192): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(n);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, n, 0));
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The CLI that the user's shell starts for the bin nextStepBin names, or
 * undefined when no directory on PATH has that bin. It is the bin's real path:
 * npm links it to dist/cli.mjs on macOS and Linux, and on Windows writes
 * shims that run node on dist/cli.mjs, codingsh.cmd for PowerShell and cmd
 * (and npx) and the extensionless sh script `coding.sh` for Git Bash.
 */
export function pathCli(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const win = platform === "win32";
  const p = win ? win32 : posix;
  const cmd = win && (windowsShell(env, platform) || env.npm_command === "exec");
  const value = env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  for (const dir of value.split(win ? ";" : ":")) {
    if (!dir) continue;
    const bin = p.join(dir, cmd ? "codingsh.cmd" : "coding.sh");
    let link: boolean;
    try {
      if (!statSync(bin).isFile()) continue;
      link = lstatSync(bin).isSymbolicLink();
    } catch {
      continue;
    }
    if (link) return realpathOr(bin);
    // npm's shims, read here rather than with spawn.ts cmdShimTarget, which loads node:child_process:
    //   codingsh.cmd  "%_prog%"  "%dp0%\node_modules\coding.sh\dist\cli.mjs" %*
    //   coding.sh     exec node  "$basedir/node_modules/coding.sh/dist/cli.mjs" "$@"
    const shim = cmd ? /"%_prog%"[^"\r\n]*"%dp0%\\([^"\r\n]+)"\s+%\*/i.exec(head(bin)) : /^#!\/bin\/sh\n[\s\S]*?\bexec node\b[^"\n]*"\$basedir\/([^"\n]+)"\s+"\$@"/.exec(head(bin));
    if (shim?.[1]) return realpathOr(p.join(p.dirname(bin), shim[1]));
    return cmd ? undefined : realpathOr(bin);
  }
  return undefined;
}

/**
 * `upgrade-store` with `args`, as a command that runs this install: through the
 * bin on PATH (cliCommand) when that bin starts `cli`, the running CLI, and as
 * `node <cli> upgrade-store` when it starts another install or there is none,
 * so the command migrates with the build that printed it. From source (`cli`
 * undefined) there is no install to name: cliCommand. `o.onPath` replaces
 * pathCli (tests).
 */
export function upgradeStoreCommand(
  args: readonly string[] = [],
  o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; cli?: string; onPath?: string } = {},
): string {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const cli = "cli" in o ? o.cli : runningCli();
  const command = ["upgrade-store", ...args];
  if (cli === undefined) return cliCommand(env, command, platform);
  const onPath = "onPath" in o ? o.onPath : pathCli(env, platform);
  const same = (a: string, b: string) => (platform === "win32" ? win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase() : a === b);
  if (onPath !== undefined && same(onPath, cli)) return cliCommand(env, command, platform);
  return ["node", ...[cli, ...command].map((a) => quoteArg(a, env, platform))].join(" ");
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function inside(file: string, dir: string): boolean {
  const r = relative(dir, file);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** The nearest directory holding a package.json, a few levels up from `file` (dist/ and src/ sit just below it). */
function packageRoot(file: string): string | undefined {
  let dir = dirname(file);
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/**
 * The package root when this code runs from a source checkout: its package has
 * src/cli/main.ts next to it, which the published package (dist/ only) never
 * ships. That covers src/*.ts run directly and the dist/ `npm run build` writes
 * inside the checkout. A checkout's dist run through a link from outside it
 * (`npm link`, `npm i -g <folder>`: argv[1] is the global path, its realpath the
 * checkout) is an install. Undefined for an install.
 */
export function sourceCheckout(self: string = fileURLToPath(import.meta.url), argv1: string | undefined = process.argv[1]): string | undefined {
  const root = packageRoot(self);
  if (!root || !existsSync(join(root, "src", "cli", "main.ts"))) return undefined;
  if (argv1 && !inside(resolve(argv1), root) && inside(realpathOr(argv1), root)) return undefined;
  return root;
}

/**
 * Why this run must not open the default home, as one line, or undefined when it
 * may: an installed coding.sh, CODING_SH_HOME, a store URL (--store), the opt-in
 * CODING_SH_DEV_REAL_STORE=1, or the checkout's own dist when init installed it
 * (bin/cli-path names it, so hooks already run this code).
 */
export function sourceRunRefusal(env: NodeJS.ProcessEnv, at: { self?: string; argv1?: string } = {}): string | undefined {
  if (env.CODING_SH_HOME?.trim() || env.CODING_SH_STORE_URL?.trim() || env.CODING_SH_DEV_REAL_STORE === "1") return undefined;
  const argv1 = "argv1" in at ? at.argv1 : process.argv[1];
  const root = sourceCheckout(at.self, argv1);
  if (!root) return undefined;
  const cli = runningCli(argv1);
  if (cli && storeOwner(dataHome(env))?.cli === cli) return undefined;
  return `coding.sh is running from a source checkout (${root}), so it won't open your real store in ${dataHome(env)}: set CODING_SH_HOME to a temp dir (CODING_SH_HOME=$(mktemp -d)), or CODING_SH_DEV_REAL_STORE=1 to use the real store.`;
}

/** The install that owns the store in `home`: the CLI bin/cli-path names, when that file still exists. */
export function storeOwner(home: string): { cli: string; version?: string } | undefined {
  let cli: string;
  try {
    cli = readFileSync(join(home, "bin", "cli-path"), "utf8").trim();
  } catch {
    return undefined;
  }
  if (!cli || !existsSync(cli)) return undefined;
  return { cli, version: packageVersion(cli) };
}

function packageVersion(cli: string): string | undefined {
  const root = packageRoot(cli);
  if (!root) return undefined;
  try {
    const v = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Pending index migrations refused because another install owns the store. */
export class StoreOwnerError extends Error {
  readonly path: string;
  readonly from: number;
  readonly to: number;
  readonly version: string;
  readonly owner: string;
  readonly ownerVersion?: string;
  /** The message without the command to run (the CLI prints that as its next step). */
  readonly detail: string;
  /** The command that migrates the store with this install (upgradeStoreCommand). */
  readonly command: string;
  constructor(o: { path: string; from: number; to: number; version: string; owner: string; ownerVersion?: string; command?: string }) {
    const named = o.ownerVersion ? `coding.sh ${o.ownerVersion}` : "coding.sh";
    const detail = `${o.path} is at index schema v${o.from}, and this coding.sh ${o.version} would migrate it to v${o.to}. Your hooks run the ${named} at ${o.owner}, which may not open v${o.to}.`;
    const command = o.command ?? upgradeStoreCommand();
    super(`${detail} To migrate it and make this install the one hooks run: ${command}`);
    this.name = "StoreOwnerError";
    this.detail = detail;
    this.command = command;
    this.path = o.path;
    this.from = o.from;
    this.to = o.to;
    this.version = o.version;
    this.owner = o.owner;
    if (o.ownerVersion !== undefined) this.ownerVersion = o.ownerVersion;
  }
}

/** Pending index migrations refused because this build is not a release newer than the store's last writer. */
export class StoreVersionError extends Error {
  readonly path: string;
  readonly from: number;
  readonly to: number;
  readonly version: string;
  /** The version that last wrote the store; unset for a store without a stamp opened from a source checkout. */
  readonly writer?: string;
  /** The message without the command to run (the CLI prints that as its next step). */
  readonly detail: string;
  /** The command that migrates the store with this build (upgradeStoreCommand). */
  readonly command: string;
  constructor(o: { path: string; from: number; to: number; version: string; writer?: string; command?: string }) {
    const why = o.writer
      ? `It was last written by coding.sh ${o.writer}, and this coding.sh ${o.version} is not a newer release, so it would migrate it to v${o.to} only when asked.`
      : `This coding.sh ${o.version} runs from a source checkout, so it would migrate it to v${o.to} only when asked.`;
    const detail = `${o.path} is at index schema v${o.from}. ${why} A migration is one-way: a coding.sh that knows only v${o.from} can't open the store after.`;
    const command = o.command ?? upgradeStoreCommand();
    super(`${detail} To migrate it with this build (a copy of the index is kept): ${command}`);
    this.name = "StoreVersionError";
    this.detail = detail;
    this.command = command;
    this.path = o.path;
    this.from = o.from;
    this.to = o.to;
    this.version = o.version;
    if (o.writer !== undefined) this.writer = o.writer;
  }
}

/**
 * The check SqliteIndexStore runs before pending migrations of `file`, the index
 * of `home` (undefined, no check, for any other file, such as a store named with
 * --store). It throws
 * - a StoreOwnerError when bin/cli-path names an install other than `cli` (the
 *   running one; undefined from source);
 * - a StoreVersionError when the store holds data and this build is not newer
 *   than its last writer, or it has no stamp and this is a source checkout.
 * Each names upgradeStoreCommand for `cli`. `at` replaces the running version,
 * whether this is a source checkout and the environment the command is built
 * for (tests).
 */
export function ownerGuard(
  home: string,
  file: string,
  cli: string | undefined = runningCli(),
  at: { version?: string; source?: boolean; env?: NodeJS.ProcessEnv } = {},
): ((from: number, to: number, writer?: StoreWriter) => void) | undefined {
  if (resolve(file) !== resolve(home, "index.db")) return undefined;
  return (from, to, writer) => {
    const running = at.version ?? version();
    const owner = storeOwner(home);
    const command = () => upgradeStoreCommand([], { cli, env: at.env ?? process.env });
    if (owner && owner.cli !== cli) throw new StoreOwnerError({ path: file, from, to, version: running, owner: owner.cli, ...(owner.version ? { ownerVersion: owner.version } : {}), command: command() });
    if (from === 0) return; // a new index: nothing to strand
    if (writer ? !isNewer(running, writer.version) : (at.source ?? sourceCheckout() !== undefined)) {
      throw new StoreVersionError({ path: file, from, to, version: running, writer: writer?.version, command: command() });
    }
  };
}
