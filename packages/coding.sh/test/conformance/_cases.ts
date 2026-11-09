// Every adapter fixture the conformance tests run: hook/plugin spools
// (normalized line by line) and backfill homes (run through checkAdapter).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { codex } from "../../src/adapters/codex.ts";
import { cursor } from "../../src/adapters/cursor.ts";
import { getAdapter } from "../../src/adapters/index.ts";
import { antigravityAdapter } from "../../src/adapters/more/antigravity.ts";
import { copilotCliAdapter } from "../../src/adapters/more/copilot-cli.ts";
import { droidAdapter } from "../../src/adapters/more/droid.ts";
import { geminiCliAdapter } from "../../src/adapters/more/gemini-cli.ts";
import { gooseAdapter } from "../../src/adapters/more/goose.ts";
import { piAdapter } from "../../src/adapters/more/pi.ts";
import { opencode } from "../../src/adapters/opencode.ts";
import type { Adapter } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { FIXTURES, loadSpool, testCtx } from "../adapters/_helpers.ts";

/** A SQLite file from a dumped {schema, rows} fixture (as test/adapters/real-install.test.ts loads them). */
export function loadDb(file: string, path: string): void {
  const dump = JSON.parse(readFileSync(file, "utf8")) as { schema: string[]; rows: Record<string, Record<string, unknown>[]> };
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  for (const sql of dump.schema) db.exec(sql);
  for (const [table, rows] of Object.entries(dump.rows)) {
    for (const r of rows) {
      const cols = Object.keys(r);
      db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(r) as (string | number | null)[]));
    }
  }
  db.close();
}

export interface BackfillCase {
  name: string;
  adapter: Adapter;
  /** Recorded from a real agent binary (scripts/e2e), not hand-written. */
  real: boolean;
  /** Points the adapter at the fixture; `root` is a fresh temp dir. */
  setup: (root: string) => void;
}

const fx = (...p: string[]) => join(FIXTURES, ...p);

export const BACKFILL_CASES: BackfillCase[] = [
  { name: "claude-code/config", adapter: claudeCode, real: false, setup: () => (process.env.CLAUDE_CONFIG_DIR = fx("claude-code", "config")) },
  { name: "claude-code/edge", adapter: claudeCode, real: false, setup: () => (process.env.CLAUDE_CONFIG_DIR = fx("claude-code", "edge", "config")) },
  { name: "claude-code/fallback", adapter: claudeCode, real: false, setup: () => (process.env.CLAUDE_CONFIG_DIR = fx("claude-code", "fallback", "config")) },
  { name: "claude-code/real", adapter: claudeCode, real: true, setup: () => (process.env.CLAUDE_CONFIG_DIR = fx("claude-code", "real", "config")) },
  { name: "claude-code/hooks-real", adapter: claudeCode, real: true, setup: () => (process.env.CLAUDE_CONFIG_DIR = fx("claude-code", "hooks-real", "config")) },
  { name: "codex/home", adapter: codex, real: false, setup: () => (process.env.CODEX_HOME = fx("codex", "home")) },
  { name: "codex/cut", adapter: codex, real: true, setup: () => (process.env.CODEX_HOME = fx("codex", "cut")) },
  { name: "cursor/config", adapter: cursor, real: false, setup: () => (process.env.CURSOR_DATA_DIR = fx("cursor", "config")) },
  { name: "opencode/data", adapter: opencode, real: false, setup: (root) => ((process.env.XDG_DATA_HOME = fx("opencode", "data")), (process.env.OPENCODE_DB = join(root, "none.db"))) },
  {
    name: "opencode/real",
    adapter: opencode,
    real: true,
    setup: (root) => {
      loadDb(fx("opencode", "real", "opencode.db.json"), join(root, "opencode.db"));
      process.env.OPENCODE_DB = join(root, "opencode.db");
      process.env.XDG_DATA_HOME = join(root, "empty");
    },
  },
  { name: "gemini-cli/home", adapter: geminiCliAdapter, real: false, setup: () => (process.env.GEMINI_CLI_HOME = fx("gemini-cli", "home")) },
  { name: "gemini-cli/paired", adapter: geminiCliAdapter, real: false, setup: () => (process.env.GEMINI_CLI_HOME = fx("gemini-cli", "paired", "home")) },
  { name: "antigravity/home", adapter: antigravityAdapter, real: false, setup: () => (process.env.HOME = fx("antigravity", "home")) },
  { name: "antigravity/db-home", adapter: antigravityAdapter, real: false, setup: () => (process.env.HOME = fx("antigravity", "db-home")) },
  { name: "antigravity/paired", adapter: antigravityAdapter, real: false, setup: () => (process.env.HOME = fx("antigravity", "paired", "home")) },
  { name: "copilot-cli/home", adapter: copilotCliAdapter, real: false, setup: () => (process.env.COPILOT_HOME = fx("copilot-cli", "home", ".copilot")) },
  { name: "copilot-cli/real", adapter: copilotCliAdapter, real: true, setup: () => (process.env.COPILOT_HOME = fx("copilot-cli", "real", "home", ".copilot")) },
  { name: "droid/home", adapter: droidAdapter, real: false, setup: () => (process.env.HOME = fx("droid", "home")) },
  { name: "droid/real", adapter: droidAdapter, real: true, setup: () => (process.env.HOME = fx("droid", "real", "home")) },
  {
    name: "goose/real",
    adapter: gooseAdapter,
    real: true,
    setup: (root) => {
      process.env.GOOSE_PATH_ROOT = join(root, "goose");
      loadDb(fx("goose", "real", "sessions.db.json"), join(root, "goose", "data", "sessions", "sessions.db"));
    },
  },
  { name: "pi/agent", adapter: piAdapter, real: false, setup: () => (process.env.PI_CODING_AGENT_DIR = fx("pi", "agent")) },
  { name: "pi/real", adapter: piAdapter, real: true, setup: () => (process.env.PI_CODING_AGENT_DIR = fx("pi", "real", "home", ".pi", "agent")) },
];

export interface SpoolCase {
  rel: string;
  real: boolean;
  /** Env the hooks' transcript reads need. */
  setup?: () => void;
}

export const SPOOL_CASES: SpoolCase[] = [
  { rel: "claude-code/hooks.spool.jsonl", real: false, setup: () => (process.env.CLAUDE_CONFIG_DIR = fx("claude-code", "config")) },
  { rel: "codex/hooks.spool.jsonl", real: false, setup: () => (process.env.CODEX_HOME = fx("codex", "home")) },
  { rel: "codex/code-mode/hooks.spool.jsonl", real: false },
  { rel: "cursor/hooks.spool.jsonl", real: false, setup: () => (process.env.CURSOR_DATA_DIR = fx("cursor", "config")) },
  { rel: "opencode/v1.spool.jsonl", real: false },
  { rel: "opencode/v2.spool.jsonl", real: false },
  { rel: "opencode/real/hooks.spool.jsonl", real: true },
  { rel: "gemini-cli/hooks.spool.jsonl", real: false },
  { rel: "gemini-cli/paired/hooks.spool.jsonl", real: false },
  { rel: "antigravity/hooks.spool.jsonl", real: false },
  { rel: "antigravity/paired/hooks.spool.jsonl", real: false },
  { rel: "copilot-cli/hooks.spool.jsonl", real: false },
  { rel: "copilot-cli/real/hooks.spool.jsonl", real: true },
  { rel: "droid/hooks.spool.jsonl", real: false },
  { rel: "droid/real/hooks.spool.jsonl", real: true },
  { rel: "goose/hooks.spool.jsonl", real: false },
  { rel: "goose/real/hooks.spool.jsonl", real: true },
  { rel: "pi/extension.spool.jsonl", real: false },
  { rel: "pi/real/extension.spool.jsonl", real: true },
  { rel: "amp/plugin.spool.jsonl", real: false },
  { rel: "wrapper/wrapper.spool.jsonl", real: false },
  { rel: "wrapper/real/aider.spool.jsonl", real: true },
];

/** Every line of a spool fixture through its agent's normalize. */
export async function normalizeSpool(rel: string): Promise<AgentEvent[]> {
  const { ctx } = testCtx();
  const out: AgentEvent[] = [];
  for (const line of loadSpool(rel)) {
    const a = getAdapter(line.agent);
    if (!a) throw new Error(`${rel}: no adapter ${line.agent}`);
    out.push(...(await a.normalize(line, ctx)));
  }
  return out;
}
