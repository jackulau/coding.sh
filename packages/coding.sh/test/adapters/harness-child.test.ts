// A real cross-harness child (TB-7): Claude Code's Bash tool ran `codex exec`, both
// with coding.sh's hooks, recorded by scripts/e2e/harness-child-capture.mjs (pinned
// Claude Code 2.1.319 and Codex 0.167.0 against the stub model). Codex's hooks
// inherited CLAUDE_CODE_SESSION_ID, so its spool lines name the Claude Code session
// (spawnedBy), and ingest links the Codex session to it as a child of type "harness".
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { SpoolLine } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest } from "../../src/core/ingest.ts";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { FIXTURES } from "./_helpers.ts";

const FIXTURE = join(FIXTURES, "harness", "claude-runs-codex");
const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const expected = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8")) as { claude: string; codex: string };
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The fixture's home copied to a temp dir, with /home/user (the scrubbed home) pointed at it. */
function home(edit: (line: SpoolLine) => SpoolLine = (l) => l): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "csh-harness-")));
  dirs.push(dir);
  const root = join(dir, "home");
  cpSync(join(FIXTURE, "home"), root, { recursive: true });
  for (const f of readdirSync(root, { recursive: true })) {
    const p = join(root, String(f));
    if (!/\.jsonl?$/.test(p)) continue;
    let text = readFileSync(p, "utf8").split("/home/user").join(JSON.stringify(root).slice(1, -1));
    if (p.includes(join(".coding.sh", "spool")) && p.endsWith(".jsonl"))
      text = text
        .split("\n")
        .map((l) => (l.trim() ? JSON.stringify(edit(JSON.parse(l) as SpoolLine)) : l))
        .join("\n");
    writeFileSync(p, text);
  }
  return root;
}

async function ingestHome(root: string) {
  const env = { HOME: root, CODING_SH_HOME: join(root, ".coding.sh"), CLAUDE_CONFIG_DIR: join(root, ".claude"), CODEX_HOME: join(root, ".codex") };
  const index = new MemoryIndexStore();
  const r = await ingest({ config: defaultConfig(env), index, blobs: new MemoryBlobStore(), adapters: new Map(ADAPTERS.map((a) => [a.id, a])), env, lock: false });
  assert.deepEqual(r.errors, []);
  return index;
}

describe("harness child: Claude Code runs codex exec (real capture)", () => {
  it("the spool shows Codex's hooks saw the Claude Code session id", () => {
    const lines = readdirSync(join(FIXTURE, "home", ".coding.sh", "spool", "codex"))
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(FIXTURE, "home", ".coding.sh", "spool", "codex", f), "utf8").split("\n").filter(Boolean))
      .map((l) => JSON.parse(l) as SpoolLine);
    assert.ok(lines.length > 0);
    for (const l of lines) assert.deepEqual(l.spawnedBy, [{ agent: "claude-code", session: expected.claude }], l.event);
  });

  it("links the Codex session to the Claude Code session as a child of type harness", async () => {
    const index = await ingestHome(home());
    const codex = await index.getSession(expected.codex);
    assert.equal(codex?.agent, "codex");
    assert.equal(codex?.parent?.sessionId, expected.claude);
    assert.equal(codex?.parent?.type, "harness");
    const claude = await index.getSession(expected.claude);
    assert.equal(claude?.agent, "claude-code");
    assert.equal(claude?.parent, undefined);
    assert.deepEqual((await index.listSessions({ parentSessionId: expected.claude })).map((s) => s.id), [expected.codex]);
  });

  it("without the env marker, links it from Claude Code's Bash call that ran codex", async () => {
    const index = await ingestHome(home(({ spawnedBy: _drop, ...l }) => l));
    const codex = await index.getSession(expected.codex);
    assert.equal(codex?.parent?.sessionId, expected.claude);
    assert.equal(codex?.parent?.type, "harness");
    assert.ok(codex?.parent?.eventId, "names the Bash call");
  });

  it("the CLI stores the link, and `show` lists the Codex session under the Claude Code one as a harness child", () => {
    const root = home();
    const env = { ...process.env, ["HO" + "ME"]: root, USERPROFILE: root, CODING_SH_HOME: join(root, ".coding.sh"), CLAUDE_CONFIG_DIR: join(root, ".claude"), CODEX_HOME: join(root, ".codex"), CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", cwd: root });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    run("ingest", "--json");
    const sessions = (JSON.parse(run("sessions", "--subagents", "--empty", "--json")) as { sessions: { id: string; parentSessionId: string | null }[] }).sessions;
    assert.equal(sessions.find((s) => s.id === expected.codex)?.parentSessionId, expected.claude);
    assert.equal(sessions.find((s) => s.id === expected.claude)?.parentSessionId, null);
    assert.match(run("show", expected.claude), new RegExp(`└ ${expected.codex}  harness codex `));
  });

  it("does not link when the times do not overlap", async () => {
    // Every Claude Code line an hour earlier: its Bash call ended long before Codex started.
    const index = await ingestHome(home(({ spawnedBy: _drop, ...l }) => (l.agent === "claude-code" ? { ...l, ts: l.ts - 3_600_000 } : l)));
    const codex = await index.getSession(expected.codex);
    assert.ok(codex);
    assert.equal(codex.parent, undefined);
  });
});
