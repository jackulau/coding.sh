// Two guards around the store in a coding.sh home. Index migrations are one-way,
// so a newer build that migrates a store strands every older install that shares
// it: on 2026-11-08 a run from a source checkout migrated a real ~/.coding.sh
// from index schema v8 to v9 and the installed CLI could not open it again.
//
// 1. sourceRunRefusal: coding.sh run from a git checkout of this repo (src/*.ts,
//    or a dist/ built inside one) does not open the default home unless told to.
// 2. ownerGuard: pending index migrations wait for the install that owns the
//    store, the CLI named in <home>/bin/cli-path (init and update write it, and
//    hooks start that CLI). Another install needs `coding.sh upgrade-store`.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../cli/meta.ts";
import { runningCli } from "../mcp/launch.ts";
import { dataHome } from "./paths.ts";

/** The command that migrates a store owned by another install (see ownerGuard). */
export const UPGRADE_STORE = "coding.sh upgrade-store";

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
  constructor(o: { path: string; from: number; to: number; version: string; owner: string; ownerVersion?: string }) {
    const named = o.ownerVersion ? `coding.sh ${o.ownerVersion}` : "coding.sh";
    const detail = `${o.path} is at index schema v${o.from}, and this coding.sh ${o.version} would migrate it to v${o.to}. Your hooks run the ${named} at ${o.owner}, which may not open v${o.to}.`;
    super(`${detail} To migrate it and make this install the one hooks run: ${UPGRADE_STORE}`);
    this.name = "StoreOwnerError";
    this.detail = detail;
    this.path = o.path;
    this.from = o.from;
    this.to = o.to;
    this.version = o.version;
    this.owner = o.owner;
    if (o.ownerVersion !== undefined) this.ownerVersion = o.ownerVersion;
  }
}

/**
 * The check SqliteIndexStore runs before pending migrations of `file`: throws a
 * StoreOwnerError when `file` is the index of `home` and bin/cli-path names an
 * install other than `cli` (the running one; undefined from source). Undefined
 * (no check) for any other file, such as a store named with --store.
 */
export function ownerGuard(home: string, file: string, cli: string | undefined = runningCli()): ((from: number, to: number) => void) | undefined {
  if (resolve(file) !== resolve(home, "index.db")) return undefined;
  return (from, to) => {
    const owner = storeOwner(home);
    if (!owner || owner.cli === cli) return;
    throw new StoreOwnerError({ path: file, from, to, version: version(), owner: owner.cli, ...(owner.version ? { ownerVersion: owner.version } : {}) });
  };
}
