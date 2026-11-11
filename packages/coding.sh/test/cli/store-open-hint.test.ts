// The CLI and MCP side of the store-open hint: commands report what named the store, a read
// through --store never creates a SQLite file, and Node without FTS5 gets its own next step.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { storeOpenError } from "../../src/cli/common.ts";
import { NoFts5Error } from "../../src/store/sqlite.ts";
import { CLI } from "../query/_seed.ts";

const root = mkdtempSync(join(tmpdir(), "csh-store-hint-"));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, HOME: join(root, "h"), CODING_SH_HOME: join(root, "cs"), CLAUDE_CONFIG_DIR: join(root, "c"), CODEX_HOME: join(root, "x"), CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" };
mkdirSync(env.HOME, { recursive: true });
const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", timeout: 120_000 });

test("sessions with a typo in --store sqlite://: store_missing, and no file is created", () => {
  const typo = join(root, "typo.db");
  const r = cli("sessions", "--json", "--store", `sqlite://${typo}`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const j = JSON.parse(r.stderr) as { reason: string; next: string[] };
  assert.equal(j.reason, "store_missing");
  assert.match(j.next.join(" "), /--store/);
  assert.equal(existsSync(typo), false);
});

test("every read with a typo in --store sqlite:// is store_missing and creates nothing; a write still creates the store", () => {
  const reads = [["usage"], ["dataset", "list"], ["score", "list"], ["score", "configs"], ["eval", "list"], ["exp", "list"], ["exp", "show", "latest"], ["replay", "latest"], ["sessions"], ["stats"], ["search", "x"], ["show", "latest"], ["export", "sessions"], ["tree", "latest"], ["cache", "doctor"], ["diff-calls", "latest"]];
  for (const argv of reads) {
    const dir = join(root, `typo-${argv.join("-")}`);
    const r = cli(...argv, "--json", "--store", `sqlite://${join(dir, "index.db")}`);
    assert.equal(r.status, 1, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal((JSON.parse(r.stderr) as { reason: string }).reason, "store_missing", argv.join(" "));
    assert.equal(existsSync(join(dir, "index.db")), false, `${argv.join(" ")} created a stray index.db`);
  }
  const made = join(root, "written", "index.db");
  const w = cli("ingest", "--json", "--store", `sqlite://${made}`);
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.equal(existsSync(made), true);
});

test("a --store that does not open: the hint names --store, not the config", () => {
  const r = cli("sessions", "--json", "--store", "nosuch://x");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const j = JSON.parse(r.stderr) as { reason: string; next: string[] };
  assert.equal(j.reason, "store_unavailable");
  assert.match(j.next.join(" "), /--store|CODING_SH_STORE_URL/);
  assert.doesNotMatch(j.next.join(" "), /config path/);
});

test("a Node without FTS5: reason no_fts5, next step installs Node 22.16", () => {
  const e = storeOpenError(new NoFts5Error(), {});
  assert.equal(e.reason, "no_fts5");
  assert.deepEqual(e.next, ["Install Node 22.16 or newer"]);
});

test("the MCP server's store error follows the same source", () => {
  const src = readFileSync(new URL("../../src/mcp/server.ts", import.meta.url), "utf8");
  assert.match(src, /storeOpenNext\(env\)/);
  assert.doesNotMatch(src, /Check the \[store\] section of \\`coding\.sh config path\\`/);
});
