// Helpers for the second-wave adapter tests. Builds on ../_helpers.ts and also
// isolates every agent-specific config variable these adapters read, so no test
// ever reads or writes the real ~.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Adapter, AgentRunOutput, RunSpec } from "../../../src/core/types.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import { loadSpool, testCtx, tmpEnv, type TmpEnv } from "../_helpers.ts";
import { nodeBin, pathOf } from "../../_bin.ts";

export { assertGolden, assertWellFormed, collect, FIXTURES, loadSpool, summarize, testCtx, writeFile } from "../_helpers.ts";

const EXTRA_KEYS = [
  "GEMINI_CLI_HOME",
  "COPILOT_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "GOOSE_PATH_ROOT",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "APPDATA",
];

/** tmpEnv() plus every agent config variable unset. */
export function moreEnv(): TmpEnv {
  const saved = Object.fromEntries(EXTRA_KEYS.map((k) => [k, process.env[k]]));
  for (const k of EXTRA_KEYS) delete process.env[k];
  const env = tmpEnv();
  return {
    ...env,
    restore() {
      env.restore();
      for (const k of EXTRA_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    },
  };
}

/** Normalize every line of a spool fixture. */
export async function normalizeFixture(adapter: Adapter, rel: string): Promise<AgentEvent[]> {
  const { ctx } = testCtx();
  const out: AgentEvent[] = [];
  for (const line of loadSpool(rel)) out.push(...(await adapter.normalize(line, ctx)));
  return out;
}

/** Snapshot of every file under dir: relative path ("/"-separated) → content. */
export function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

export const HOOK = "/opt/coding.sh/hook.mjs";

/**
 * The standard install contract on a temp HOME:
 * dry run writes nothing; install writes; re-install is a no-op; uninstall restores the original files.
 */
export async function assertInstallRoundTrip(adapter: Adapter, root: string, opts: { scope: "user" | "project"; projectDir?: string } = { scope: "user" }): Promise<{ installed: Record<string, string> }> {
  const homeDir = join(root, "home");
  const watch = () => ({ ...snapshotDir(homeDir), ...(opts.projectDir ? prefix(snapshotDir(opts.projectDir), "project/") : {}) });
  const before = watch();
  const dry = await adapter.install({ hookCommand: HOOK, scope: opts.scope, projectDir: opts.projectDir, dryRun: true });
  assert.ok(dry.length > 0, "dry run reports planned changes");
  assert.deepEqual(watch(), before, "dry run writes nothing");
  const changes = await adapter.install({ hookCommand: HOOK, scope: opts.scope, projectDir: opts.projectDir, dryRun: false });
  assert.deepEqual(
    changes.map((c) => c.path),
    dry.map((c) => c.path),
    "dry run and install agree",
  );
  const installed = watch();
  assert.notDeepEqual(installed, before, "install writes");
  assert.deepEqual(await adapter.install({ hookCommand: HOOK, scope: opts.scope, projectDir: opts.projectDir, dryRun: false }), [], "re-install is a no-op");
  assert.deepEqual(watch(), installed);
  const dryUn = await adapter.uninstall({ scope: opts.scope, projectDir: opts.projectDir, dryRun: true });
  assert.ok(dryUn.length > 0);
  assert.deepEqual(watch(), installed, "dry-run uninstall writes nothing");
  await adapter.uninstall({ scope: opts.scope, projectDir: opts.projectDir, dryRun: false });
  assert.deepEqual(watch(), before, "uninstall restores the original files");
  assert.deepEqual(await adapter.uninstall({ scope: opts.scope, projectDir: opts.projectDir, dryRun: false }), [], "second uninstall is a no-op");
  return { installed };
}

const prefix = (o: Record<string, string>, p: string) => Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]));

/** A fake agent binary (a node script) that records argv/env and prints `stdout`. */
export function fakeBinary(dir: string, name: string, script: string): string {
  return nodeBin(
    dir,
    name,
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(dir, `${name}.argv.json`))}, JSON.stringify({ argv: process.argv.slice(2), runId: process.env.CODING_SH_RUN_ID, cwd: process.cwd(), env: { CI: process.env.CI, NO_COLOR: process.env.NO_COLOR, GOOSE_MODE: process.env.GOOSE_MODE, GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE } }));
${script}
`,
  );
}

export function readArgv(dir: string, name: string): { argv: string[]; runId: string; cwd: string; env: Record<string, string | undefined> } {
  return JSON.parse(readFileSync(join(dir, `${name}.argv.json`), "utf8"));
}

export function runSpec(cwd: string, binDir: string, over: Partial<RunSpec> = {}): RunSpec {
  return { cwd, instruction: "fix the bug", env: { PATH: pathOf(binDir, process.env.PATH) }, timeoutMs: 20_000, flags: [], runId: "run-42", ...over };
}

export function assertRunOk(r: AgentRunOutput): void {
  assert.equal(r.timedOut, false, r.stderrTail);
  assert.equal(r.exitCode, 0, r.stderrTail);
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
