// `coding.sh doctor --conformance` end to end, from source, against fixture
// homes in a temp HOME: one JSON document, exit codes 0/1/2, and no store.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURES, PKG_ROOT } from "../adapters/_helpers.ts";
import { loadDb } from "./_cases.ts";

const MAIN = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const roots: string[] = [];

/** Runs the CLI with a fresh HOME and store dir and only the given agent variables. */
function doctor(args: string[], extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "csh-conf-"));
  roots.push(home);
  const store = join(home, "store");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), CODING_SH_HOME: store, NO_COLOR: "1", ...extra };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, "doctor", ...args], { env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, home, storeCreated: existsSync(store) };
}

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("doctor --conformance", () => {
  it("--json prints one document; a clean real fixture exits 0 and no store is created", () => {
    const r = doctor(["--conformance", "--agent", "claude-code", "--since", "3650d", "--json"], { CLAUDE_CONFIG_DIR: join(FIXTURES, "claude-code", "real", "config") });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout) as { ok: boolean; score: number; agents: { adapter: string; status: string; report: { counts: { events: number } } }[] };
    assert.equal(doc.ok, true);
    assert.equal(doc.score, 1);
    assert.equal(doc.agents.length, 1);
    assert.equal(doc.agents[0]!.adapter, "claude-code");
    assert.equal(doc.agents[0]!.status, "clean");
    assert.ok(doc.agents[0]!.report.counts.events > 0);
    assert.equal(r.storeCreated, false, "the store dir must not be created");
  });

  it("an OpenCode database in an unknown schema (F3) exits 1 and names the rule and finding", () => {
    const db = join(mkdtempSync(join(tmpdir(), "csh-conf-db-")), "opencode.db");
    roots.push(join(db, ".."));
    loadDb(join(PKG_ROOT, "test", "fixtures", "conformance", "f3-opencode-unknown-schema.db.json"), db);
    const r = doctor(["--conformance", "--agent", "opencode", "--since", "3650d"], { OPENCODE_DB: db });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout + r.stderr, /empty-backfill 1 \(F3\)/);
    assert.match(r.stdout, /0\/1 agents conform/);
    assert.equal(r.storeCreated, false);
    const j = doctor(["--conformance", "--agent", "opencode", "--since", "3650d", "--json"], { OPENCODE_DB: db });
    assert.equal(j.status, 1);
    assert.equal((JSON.parse(j.stdout) as { ok: boolean }).ok, false);
  });

  it("no transcripts since the cut is not a failure", () => {
    const r = doctor(["--conformance"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /no agent transcripts since 7d/);
    assert.equal(r.storeCreated, false);
  });

  it("usage errors exit 2", () => {
    assert.equal(doctor(["--since", "7d"]).status, 2);
    assert.equal(doctor(["--conformance", "--max-events", "0"]).status, 2);
    assert.equal(doctor(["--conformance", "--since", "yesterday-ish"]).status, 2);
  });
});
