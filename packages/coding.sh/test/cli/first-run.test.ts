// First-run polish found in launch dogfooding: a short init plan, blockers
// before the Y/n prompt, doctor's wrapper row, `show <prefix>`, and short
// local times in tables.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { shortPath } from "../../src/cli/changes.ts";
import { resolveSession } from "../../src/cli/common.ts";
import { run as init } from "../../src/cli/commands/init.ts";
import { startedText } from "../../src/cli/commands/show.ts";
import { ago, CliError, localTime, Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import type { Context } from "../../src/core/context.ts";
import type { Session } from "../../src/core/types.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

let t: TmpEnv;
beforeEach(() => {
  t = tmpEnv();
  process.env.PATH = join(t.root, "nobin"); // no agent binaries
  process.env.NO_UPDATE_NOTIFIER = "1";
  const hook = join(t.root, "dist", "hook.mjs");
  writeFile(hook, "// hook\n");
  process.env.CODING_SH_HOOK_SOURCE = hook;
});
afterEach(() => {
  delete process.env.CODING_SH_HOOK_SOURCE;
  t.restore();
});

interface Captured {
  stdout: string;
  stderr: string;
  /** stderr as it stood when the Y/n question was asked (undefined: never asked). */
  atPrompt?: string;
  code?: number;
  error?: unknown;
}

async function runInit(flags: Record<string, string | boolean | string[]>, opts: { interactive?: boolean; cwd?: string } = {}): Promise<Captured> {
  const cap: Captured = { stdout: "", stderr: "" };
  const env = { ...process.env, NO_COLOR: "1", CI: "" };
  const out = new Output({
    json: false,
    env,
    stdout: { write: (s: string) => ((cap.stdout += s), true), isTTY: false },
    stderr: { write: (s: string) => ((cap.stderr += s), true), isTTY: opts.interactive === true },
    stdin: { isTTY: opts.interactive === true },
  });
  out.confirm = async () => {
    cap.atPrompt = cap.stderr;
    return false; // answer "n": nothing is written
  };
  const c: CommandContext = { flags: { mcp: false, ...flags }, positionals: [], rest: [], out, env, cwd: opts.cwd ?? t.home, debug: false, signal: new AbortController().signal };
  try {
    cap.code = await init(c);
  } catch (e) {
    cap.error = e;
  }
  // Human output uses native separators (~\.claude\settings.json on Windows); match one spelling.
  if (process.platform === "win32") {
    cap.stdout = cap.stdout.replaceAll("\\", "/");
    cap.stderr = cap.stderr.replaceAll("\\", "/");
    cap.atPrompt = cap.atPrompt?.replaceAll("\\", "/");
  }
  return cap;
}

describe("init --dry-run prints a short per-agent plan", () => {
  test("agent, scope, files and blockers; no diffs unless --diff", async () => {
    const r = await runInit({ agent: ["claude-code", "cursor"], "dry-run": true });
    assert.equal(r.code, 0, String(r.error ?? r.stderr));
    const lines = r.stdout.trimEnd().split("\n");
    assert.ok(lines.length <= 12, `short plan, got ${lines.length} lines:\n${r.stdout}`);
    assert.match(r.stdout, /^ {2}Claude Code \(user scope\)\n {4}create {2}~\/\.claude\/settings\.json {2}hooks\n {4}! Claude Code is not installed on this machine/m);
    assert.match(r.stdout, /^ {2}Cursor CLI \(user scope\)\n {4}create {2}~\/\.cursor\/hooks\.json {5}hooks\n {4}! Cursor CLI is not installed on this machine/m);
    assert.match(r.stdout, /^ {2}coding\.sh\n {4}create {2}\S+\/bin\/hook\.mjs$/m);
    assert.doesNotMatch(r.stdout, /^\s+\+/m, "no diff lines");
    assert.match(r.stderr, /Dry run: nothing written\. Add --diff for the full edits\./);

    const d = await runInit({ agent: ["claude-code"], "dry-run": true, diff: true });
    assert.match(d.stdout, /^ {4}\+ {4}"SessionStart": \[$/m, "--diff adds the edits");
  });

  test("project scope shows files relative to the project", async () => {
    const proj = join(t.home, "code", "proj");
    mkdirSync(proj, { recursive: true });
    const r = await runInit({ agent: ["cursor"], scope: "project", "dry-run": true }, { cwd: proj });
    assert.match(r.stdout, /Cursor CLI \(project scope\)\n {4}create {2}\.\/\.cursor\/hooks\.json {2}hooks/);
  });
});

describe("init lists blockers before the Y/n prompt", () => {
  test("a missing agent binary and hooks in the other scope are shown before the question", async () => {
    // claude-code hooked in user scope first.
    const first = await runInit({ agent: ["claude-code"], yes: true });
    assert.equal(first.code, 0, String(first.error ?? first.stderr));
    const proj = join(t.home, "code", "proj");
    mkdirSync(proj, { recursive: true });

    const r = await runInit({ agent: ["claude-code", "cursor"], scope: "project" }, { interactive: true, cwd: proj });
    assert.ok(r.atPrompt !== undefined, "asked once");
    assert.match(r.atPrompt, /Claude Code \(project scope\)\n(?: {4}! .*\n)* {4}! skipping hooks: already installed in user scope \(~\/\.claude\/settings\.json\); --force installs both/);
    assert.match(r.atPrompt, /Cursor CLI \(project scope\)\n {4}create {2}\.\/\.cursor\/hooks\.json {2}hooks\n {4}! Cursor CLI is not installed on this machine/);
    assert.ok(r.error instanceof CliError && r.error.reason === "canceled", "answered no");
    assert.equal(r.stderr, r.atPrompt, "nothing printed after the answer but the cancel");
  });
});

describe("short paths", () => {
  test("closest of cwd and home", () => {
    const env = { HOME: "/h/me" };
    assert.equal(shortPath("/h/me/.claude/settings.json", env, "/h"), "~/.claude/settings.json");
    assert.equal(shortPath("/h/me/code/p/.cursor/hooks.json", env, "/h/me/code/p"), "./.cursor/hooks.json");
    assert.equal(shortPath("/h/me/.claude.json", env, "/h/me"), "~/.claude.json");
    assert.equal(shortPath("/etc/x", env, "/h/me"), "/etc/x");
  });
});

function session(id: string, startedAt: number, title = id): Session {
  return { id, agent: "claude-code", title, startedAt, endedAt: startedAt + 1000, stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, subagents: 0 } } as unknown as Session;
}

describe("show <prefix> resolves a unique session id prefix, like git", () => {
  const now = Date.now();
  const ids = ["9f1c2e7a-4b1d-4c55-9a0e-1f2a3b4c5d6e", "9f1c88d0-7e2a-4f19-b3c4-5d6e7f8a9b0c", "a3b4c5d6-1111-4222-8333-944445555666", "proj/9f1c-x"];

  for (const kind of ["memory", "sqlite"] as const) {
    test(`${kind} store: unique prefix, ambiguous prefix, too short, exact id`, async () => {
      const index = kind === "memory" ? new MemoryIndexStore() : await SqliteIndexStore.open(join(t.root, "index.db"));
      await index.migrate();
      for (const [i, id] of ids.entries()) await index.upsertSession(session(id, now - i * 60e3));
      const ctx = { index } as unknown as Context;
      try {
        assert.equal((await resolveSession(ctx, "9f1c2e")).id, ids[0]);
        assert.equal((await resolveSession(ctx, "a3b4")).id, ids[2]);
        assert.equal((await resolveSession(ctx, ids[1]!)).id, ids[1]);
        assert.equal((await resolveSession(ctx, "proj/")).id, ids[3], "project-scoped ids too");
        await assert.rejects(resolveSession(ctx, "9f1c"), (e: CliError) => {
          assert.equal(e.reason, "ambiguous");
          assert.match(e.message, /Session id prefix "9f1c" is ambiguous/);
          assert.match(e.message, new RegExp(`^  ${ids[0]}  claude-code  just now`, "m"));
          assert.match(e.message, new RegExp(`^  ${ids[1]}  claude-code  1m ago`, "m"));
          assert.deepEqual((e.data as { candidates: { id: string }[] }).candidates.map((x) => x.id), [ids[0], ids[1]]);
          return true;
        });
        await assert.rejects(resolveSession(ctx, "9f1"), (e: CliError) => e.reason === "not_found" && /at least 4 characters/.test(e.message));
        await assert.rejects(resolveSession(ctx, "ffff"), (e: CliError) => e.reason === "not_found" && !/at least/.test(e.message));
        // LIKE/GLOB metacharacters are plain characters in a prefix.
        await assert.rejects(resolveSession(ctx, "9f1%"), (e: CliError) => e.reason === "not_found");
      } finally {
        await index.close();
      }
    });
  }
});

describe("times in CLI tables: short and local; --json keeps ISO", () => {
  const now = new Date(2026, 10, 6, 14, 30).getTime();
  test("relative under a day, then the local date and time", () => {
    assert.equal(ago(now - 400, { now }), "just now");
    assert.equal(ago(now + 5000, { now }), "just now", "clock skew");
    assert.equal(ago(now - 12e3, { now }), "12s ago");
    assert.equal(ago(now - 3 * 60e3, { now }), "3m ago");
    assert.equal(ago(now - 5 * 3600e3, { now }), "5h ago");
    assert.equal(ago(new Date(2026, 10, 4, 9, 5).getTime(), { now }), "Nov 4 09:05");
    assert.equal(ago(new Date(2025, 10, 6, 14, 2).getTime(), { now }), "Nov 6 2025");
    assert.equal(ago(undefined), "-");
    assert.equal(localTime(new Date(2026, 0, 2, 3, 4).getTime(), now), "Jan 2 03:04");
  });

  test("show's Started row", () => {
    assert.equal(startedText(now - 3 * 60e3, now), "Nov 6 14:27 (3m ago)");
    assert.equal(startedText(new Date(2026, 10, 1, 8, 0).getTime(), now), "Nov 1 08:00");
  });
});
