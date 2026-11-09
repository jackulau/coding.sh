// coding.sh upgrade-store [--yes]
//
// Index migrations are one-way, so a store migrates on its own only for the
// install that owns it: the CLI ~/.coding.sh/bin/cli-path names, which hooks
// start (core/store-guard.ts). Any other install stops before migrating and
// points here. This migrates the index and makes the running CLI the owner
// (refreshing the hook bin), so hooks start a coding.sh that can open it.
// Exit codes: 0 migrated or already current, 1 failed, 2 needs --yes.
import { existsSync } from "node:fs";
import { paths } from "../../core/paths.ts";
import { storeOwner, UPGRADE_STORE } from "../../core/store-guard.ts";
import { runningCli } from "../../mcp/launch.ts";
import { loadSqlite } from "../../store/sqlite-open.ts";
import { SQLITE_SCHEMA_VERSION, SqliteIndexStore } from "../../store/sqlite.ts";
import { requireConsent } from "../common.ts";
import { refreshHookBin } from "../hookbin.ts";
import { version } from "../meta.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** The index schema `file` is at (0 before any migration), read without writing. */
async function schemaOf(file: string): Promise<number> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migrations'").get()) return 0;
    return Number((db.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number | null }).v ?? 0);
  } finally {
    db.close();
  }
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const p = paths(env);
  const file = p.index;
  const to = SQLITE_SCHEMA_VERSION;
  if (!existsSync(file)) {
    if (out.json) out.data({ status: "no_store", path: file, to });
    else out.ok(`No store at ${file} yet: nothing to upgrade`);
    return 0;
  }
  const from = await schemaOf(file);
  if (from > to) {
    throw new CliError(`${file} uses index schema v${from}, but this coding.sh ${version()} only knows up to v${to}`, { reason: "store_newer", next: ["Install the latest coding.sh:", "coding.sh update"] });
  }
  const cli = runningCli();
  const owner = storeOwner(p.root);
  const other = owner && owner.cli !== cli ? owner : undefined;
  const takeOver = cli !== undefined && other !== undefined;
  const doc = { path: file, from, to, cli: cli ?? null, previousOwner: owner?.cli ?? null };
  if (from === to && !takeOver) {
    if (out.json) out.data({ status: "current", ...doc, bin: "current" });
    else out.ok(`${file} is at index schema v${to}: nothing to upgrade`);
    return 0;
  }

  const named = other ? `the coding.sh${other.version ? ` ${other.version}` : ""} at ${other.cli}` : "";
  const hooks = takeOver ? `have hooks run this coding.sh ${version()} instead of ${named}` : "";
  const question = from === to ? `${hooks[0]!.toUpperCase()}${hooks.slice(1)}?` : `Migrate ${file} from index schema v${from} to v${to}${hooks ? ` and ${hooks}` : ""}?`;
  await requireConsent(c, question, `${UPGRADE_STORE} --yes`);

  if (from < to) await (await SqliteIndexStore.open(file)).close();
  const bin = cli ? await refreshHookBin(env, cli) : "not_installed";
  if (out.json) {
    out.data({ status: "migrated", ...doc, bin });
    return 0;
  }
  if (from < to) out.ok(`Migrated ${file} to index schema v${to}`);
  if (bin === "refreshed") out.ok(`Hooks now run coding.sh ${version()} (${cli})`);
  // From source there is no bundled CLI for the hooks to start: the old owner still runs them.
  if (!cli && other) out.warn(`Hooks still run ${other.cli}, which may not open v${to}. Run coding.sh init from the install they should run.`);
  return 0;
}
