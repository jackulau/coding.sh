// coding.sh upgrade-store [--yes] [--restore]
//
// Index migrations are one-way, so a store migrates on its own only for the
// install that owns it (the CLI ~/.coding.sh/bin/cli-path names, which hooks
// start) and only for a release newer than the one that last wrote it
// (core/store-guard.ts). Any other build stops before migrating and points
// here. This migrates the index, keeping a copy of it as it was next to it
// (index.db.v<N>.bak), and makes the running CLI the owner: bin/cli-path names
// it and the hook bin is refreshed, so hooks start a coding.sh that can open it.
//
// --restore puts that copy back. The index it replaces is kept
// (index.db.v<N>.undone), and the store is stamped so that this build does not
// migrate it again on its own. Any coding.sh that knows the copy's schema can
// run it, including one the migration left unable to open the store.
// Exit codes: 0 done or nothing to do, 1 failed, 2 needs --yes.
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, type Lock } from "../../core/lock.ts";
import { paths } from "../../core/paths.ts";
import { storeOwner, UPGRADE_STORE } from "../../core/store-guard.ts";
import { runningCli } from "../../mcp/launch.ts";
import { loadSqlite } from "../../store/sqlite-open.ts";
import { SQLITE_SCHEMA_VERSION, SqliteIndexStore } from "../../store/sqlite.ts";
import { backupPath, listBackups, parseWriter, restoreBackup, StoreNewerError, WRITER_KEY, type StoreWriter } from "../../store/upgrade.ts";
import { lockContention, requireConsent, storeNewerError } from "../common.ts";
import { refreshHookBin } from "../hookbin.ts";
import { version } from "../meta.ts";
import { bytes, CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** The index schema `file` is at (0 before any migration) and its writer stamp, read without writing. */
async function stateOf(file: string): Promise<{ schema: number; writer?: StoreWriter }> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migrations'").get()) return { schema: 0 };
    const schema = Number((db.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number | null }).v ?? 0);
    let writer: StoreWriter | undefined;
    try {
      writer = parseWriter((db.prepare("SELECT value FROM kv WHERE key = ?").get(WRITER_KEY) as { value?: unknown } | undefined)?.value);
    } catch {
      // before v2 there is no kv table
    }
    return { schema, writer };
  } finally {
    db.close();
  }
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Where the owner an upgrade replaced is kept, so --restore can give the hooks back to it. */
const previousOwnerPath = (bin: string): string => join(bin, "cli-path.prev");

/**
 * Makes `cli` the store's owner: bin/cli-path names it, and where init set the
 * hook bin up, the hook and MCP launcher are refreshed from this install too.
 * Without a hook bin only cli-path is written: that names the owner for the
 * guard and installs no capture.
 */
async function ownBin(env: NodeJS.ProcessEnv, cli: string): Promise<"refreshed" | "current" | "not_installed"> {
  const bin = await refreshHookBin(env, cli);
  if (bin === "not_installed") await pointAt(env, cli);
  return bin;
}

async function pointAt(env: NodeJS.ProcessEnv, cli: string): Promise<void> {
  const { atomicWrite } = await import("../../adapters/_shared/files.ts");
  await atomicWrite(paths(env).cliPointer, cli + "\n", 0o644);
}

export async function run(c: CommandContext): Promise<number> {
  if (c.flags.restore === true) return restore(c);
  const { out, env } = c;
  const p = paths(env);
  const file = p.index;
  const to = SQLITE_SCHEMA_VERSION;
  if (!existsSync(file)) {
    if (out.json) out.data({ status: "no_store", path: file, to });
    else out.ok(`No store at ${file} yet: nothing to upgrade`);
    return 0;
  }
  const { schema: from, writer } = await stateOf(file);
  if (from > to) throw storeNewerError(new StoreNewerError({ path: file, schema: from, known: to, writer }), env);
  const cli = runningCli();
  const owner = storeOwner(p.root);
  const other = owner && owner.cli !== cli ? owner : undefined;
  const takeOver = cli !== undefined && other !== undefined;
  // bin/cli-path always ends up naming this CLI, also when it names nothing or a CLI that is gone.
  const repoint = cli !== undefined && readTrimmed(p.cliPointer) !== cli;
  const doc = { path: file, from, to, cli: cli ?? null, previousOwner: owner?.cli ?? null };
  if (from === to && !repoint) {
    if (out.json) out.data({ status: "current", ...doc, bin: "current", cliPath: cli ?? null });
    else out.ok(`${file} is at index schema v${to}: nothing to upgrade`);
    return 0;
  }

  const named = other ? `the coding.sh${other.version ? ` ${other.version}` : ""} at ${other.cli}` : "";
  const hooks = takeOver ? `have hooks run this coding.sh ${version()} instead of ${named}` : "";
  if (from < to || takeOver) {
    const question = from === to ? `${hooks[0]!.toUpperCase()}${hooks.slice(1)}?` : `Migrate ${file} from index schema v${from} to v${to}${hooks ? ` and ${hooks}` : ""}?`;
    await requireConsent(c, question, `${UPGRADE_STORE} --yes`);
  }

  // Opened without the guard: this command is the request it waits for. The store keeps its own copy first.
  if (from < to) await (await SqliteIndexStore.open(file, { writer: version() })).close();
  const backup = from > 0 && from < to && existsSync(backupPath(file, from)) ? backupPath(file, from) : undefined;
  if (takeOver) {
    const { atomicWrite } = await import("../../adapters/_shared/files.ts");
    await atomicWrite(previousOwnerPath(p.bin), other!.cli + "\n", 0o644);
  }
  const bin = cli ? await ownBin(env, cli) : "not_installed";
  if (out.json) {
    out.data({ status: "migrated", ...doc, bin, cliPath: readTrimmed(p.cliPointer) ?? null, backup: backup ?? null });
    return 0;
  }
  if (from < to) out.ok(`Migrated ${file} to index schema v${to}`);
  if (backup) out.note(`The index as it was is kept at ${backup}. ${UPGRADE_STORE} --restore puts it back; delete it once this version works for you.`);
  if (cli) out.ok(`${bin === "not_installed" ? "This store is now owned by" : "Hooks now run"} coding.sh ${version()} (${cli})`);
  // From source there is no bundled CLI for the hooks to start: the old owner still runs them.
  if (!cli && other) out.warn(`Hooks still run ${other.cli}, which may not open v${to}. Run coding.sh init from the install they should run.`);
  return 0;
}

/** Folds the WAL of `file` into it and closes it; false when another process keeps frames in it. */
async function emptyWal(file: string): Promise<boolean> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch {
    return false;
  } finally {
    db.close();
  }
  try {
    return statSync(`${file}-wal`).size === 0;
  } catch {
    return true;
  }
}

/** Stamps the restored index as written by this build, so it migrates it again only when asked (core/store-guard.ts). */
async function stamp(file: string, schema: number): Promise<void> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()) return;
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(WRITER_KEY, JSON.stringify({ version: version(), schema, at: Date.now() } satisfies StoreWriter), Date.now());
  } finally {
    db.close();
  }
}

async function restore(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const p = paths(env);
  const file = p.index;
  const known = SQLITE_SCHEMA_VERSION;
  const { schema: current } = existsSync(file) ? await stateOf(file) : { schema: 0 };
  const backups = existsSync(file) ? listBackups(file).filter((b) => b.schema < current) : [];
  const backup = backups.find((b) => b.schema <= known);
  if (!backup) {
    const tooNew = backups[0];
    // Only a newer coding.sh helps when the copy, or the store itself, is past this one.
    const update: [string, string] | undefined = tooNew || current > known ? ["Install the latest coding.sh:", "coding.sh update"] : undefined;
    throw new CliError(
      tooNew ? `The index from before the migration (${tooNew.path}) is at schema v${tooNew.schema}, but this coding.sh ${version()} only knows up to v${known}` : `No index from before a migration is kept next to ${file}: nothing to restore`,
      { reason: tooNew ? "store_newer" : "no_backup", next: update },
    );
  }
  const doc = { path: file, from: current, to: backup.schema, backup: backup.path };
  await requireConsent(c, `Put back the index from before the migration (schema v${backup.schema}, ${bytes(backup.bytes)}) in place of ${file} (schema v${current})? What was indexed since stays in the replaced index, which is kept.`, `${UPGRADE_STORE} --restore --yes`);

  // No ingest may write the index while it is swapped.
  let lock: Lock | undefined;
  if (existsSync(p.spool)) {
    try {
      lock = await acquireLock(p.ingestLock, { waitMs: 5000 });
    } catch (e) {
      if (!lockContention(e)) throw e;
      throw new CliError(`Can't restore: an ingest is running (${(e as Error).message})`, { reason: "locked", next: ["Wait for it to finish, then run:", `${UPGRADE_STORE} --restore`] });
    }
  }
  let undone: string;
  try {
    if (!(await emptyWal(file))) {
      throw new CliError(`Can't restore: another process keeps ${file} busy`, { reason: "locked", next: ["Close other coding.sh commands (coding.sh ui, a running ingest), then run:", `${UPGRADE_STORE} --restore`] });
    }
    undone = restoreBackup(file, backup, current);
    // A build that knows a newer schema would migrate the restored index again at its next open.
    if (backup.schema < known) await stamp(file, backup.schema);
  } finally {
    lock?.release();
  }

  // Hooks must start a coding.sh that opens the restored schema: this one when it is at that
  // schema, else the owner the upgrade replaced.
  const cli = runningCli();
  const prev = readTrimmed(previousOwnerPath(p.bin));
  let hooks: string | undefined;
  if (backup.schema === known) {
    if (cli) await ownBin(env, cli);
    hooks = cli;
  } else if (prev && existsSync(prev) && prev !== readTrimmed(p.cliPointer)) {
    await pointAt(env, prev);
    hooks = prev;
  }
  rmSync(previousOwnerPath(p.bin), { force: true });
  const pointer = readTrimmed(p.cliPointer);
  // bin/cli-path still names a coding.sh that knows a newer schema: its ingests now wait for upgrade-store.
  const waits = backup.schema < known && cli !== undefined && pointer === cli;
  if (out.json) {
    out.data({ status: "restored", ...doc, undone, cliPath: pointer ?? null });
    return 0;
  }
  out.ok(`Put back ${file} at index schema v${backup.schema}`);
  out.note(`The index it replaced (schema v${current}) is kept at ${undone}; delete it when you no longer need it.`);
  if (hooks) out.ok(`Hooks run ${hooks}`);
  if (backup.schema < known) out.note(`This coding.sh ${version()} knows schema v${known}: it migrates this store again only through ${UPGRADE_STORE}.`);
  if (waits) out.warn(`Hooks start this coding.sh, so nothing is indexed until a coding.sh that opens v${backup.schema} runs init, or you run ${UPGRADE_STORE}. Captures wait in the spool meanwhile.`);
  return 0;
}
