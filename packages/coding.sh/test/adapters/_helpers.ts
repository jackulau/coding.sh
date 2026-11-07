// Shared helpers for adapter conformance tests. Every test runs with HOME and
// CODING_SH_HOME pointed at throwaway dirs, so the real ~ is never touched.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashParts, sha256Hex } from "../../src/core/ids.ts";
import type { NormalizeContext, SpoolLine } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

export const PKG_ROOT = realpathSync(join(import.meta.dirname, "..", ".."));
export const FIXTURES = join(PKG_ROOT, "test", "fixtures", "adapters");
const TOKEN = "${FIXTURES}";

/** Replace the machine-specific fixture root with a token (and back). */
export const portable = (s: string) => s.split(FIXTURES).join(TOKEN);
export const local = (s: string) => s.split(TOKEN).join(FIXTURES);

export interface TestCtx {
  ctx: NormalizeContext;
  blobs: Map<string, string>;
}

/** In-memory NormalizeContext; blob refs hash the portable form so goldens are machine-independent. */
export function testCtx(maxInlineBytes = 4096): TestCtx {
  const blobs = new Map<string, string>();
  const ctx: NormalizeContext = {
    maxInlineBytes,
    id: (...parts) => hashParts(...parts.map((p) => (typeof p === "string" ? portable(p) : p))),
    async blob(data) {
      const text = portable(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
      const ref = sha256Hex(text);
      blobs.set(ref, text);
      return ref;
    },
  };
  return { ctx, blobs };
}

/** Spool lines from a fixture JSONL (with ${FIXTURES} expanded). */
export function loadSpool(rel: string): SpoolLine[] {
  return readFileSync(join(FIXTURES, rel), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(local(l)) as SpoolLine);
}

/** Compare against a golden JSON file; UPDATE_GOLDEN=1 rewrites it. */
export function assertGolden(rel: string, actual: unknown): void {
  const path = join(FIXTURES, rel);
  const text = portable(JSON.stringify(actual, null, 2)) + "\n";
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    if (process.env.UPDATE_GOLDEN !== "1") assert.fail(`golden ${rel} did not exist; wrote it — re-run`);
    return;
  }
  assert.deepEqual(JSON.parse(text), JSON.parse(readFileSync(path, "utf8")), `golden mismatch: ${rel} (UPDATE_GOLDEN=1 to accept)`);
}

/** Basic invariants every normalized event must satisfy. */
export function assertWellFormed(events: AgentEvent[]): void {
  const ids = new Set<string>();
  for (const e of events) {
    assert.match(e.id, /^[0-9a-f]{64}$/);
    assert.equal(e.v, 0);
    assert.ok(e.sessionId, "sessionId");
    assert.ok(Number.isFinite(e.ts), "ts");
    assert.ok(!ids.has(e.id), `duplicate id ${e.id} (${e.kind})`);
    ids.add(e.id);
    assert.ok(Buffer.byteLength(JSON.stringify(e.payload)) < 4096, `payload too large for ${e.kind}`);
  }
}

export interface TmpEnv {
  home: string;
  dataHome: string;
  root: string;
  restore(): void;
}

/** Point HOME / CODING_SH_HOME (and agent config env vars) at a fresh temp dir. */
export function tmpEnv(): TmpEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-adapters-")));
  const home = join(root, "home");
  const dataHome = join(root, "coding.sh");
  mkdirSync(home, { recursive: true });
  const keys = ["HOME", "USERPROFILE", "CODING_SH_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CURSOR_CONFIG_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_DB", "PATH"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) if (k !== "PATH") delete process.env[k];
  process.env.HOME = home;
  process.env.CODING_SH_HOME = dataHome;
  return {
    home,
    dataHome,
    root,
    restore() {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** Compact view for readable goldens. */
export function summarize(events: AgentEvent[]): unknown[] {
  return events.map((e) => {
    const o: Record<string, unknown> = { kind: e.kind, sessionId: e.sessionId, ts: e.ts, payload: e.payload };
    for (const k of ["id", "turnId", "parentId", "subagentId", "model", "durationMs", "usage", "blobs", "runId", "cwd", "agentVersion"] as const) {
      if (e[k] !== undefined) o[k] = e[k];
    }
    return o;
  });
}

/**
 * Put a fake `name` executable (a /bin/sh script printing `stdout`) on an
 * isolated PATH that contains nothing else, so a real install is never found.
 */
export function fakeBin(env: TmpEnv, name: string, stdout: string): string {
  const dir = join(env.root, "bin");
  const path = join(dir, name);
  // printf is a shell builtin: the isolated PATH has no coreutils.
  writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${stdout.replaceAll("'", "'\\''")}'\n`);
  chmodSync(path, 0o755);
  process.env.PATH = dir;
  return path;
}
