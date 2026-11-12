// Weight edits in the CLI: `sessions` lists a session that holds nothing but an edit and finds
// it by tag and by count, and `show` prints the Weight edits row and one line per edit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const A = "a".repeat(64);
const B = "b".repeat(64);
const EDITS = "sess-edits";
const PLAIN = "sess-plain";

describe("weight edits in the CLI", () => {
  let root = "";
  let env: Record<string, string>;
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", cwd: root });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const ids = (...args: string[]) => (JSON.parse(cli("sessions", ...args, "--json")) as { sessions: { id: string }[] }).sessions.map((s) => s.id).sort();

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "csh-weights-cli-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    env = {
      PATH: process.env.PATH ?? "",
      ["HO" + "ME"]: home,
      USERPROFILE: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      CURSOR_CONFIG_DIR: join(root, "cursor"),
      OPENCODE_CONFIG_DIR: join(root, "opencode"),
      OPENCODE_DB: join(root, "opencode.db"),
      CODING_SH_NO_AUTO_INGEST: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      TZ: "UTC",
    };
    const ctx = await openContext({ env, cwd: root });
    const t0 = Date.now() - 3600e3;
    const put = async (evs: AgentEvent[]) => {
      await ctx.index.putEvents(evs);
      await ctx.index.upsertSession(buildSession(evs));
    };
    const e = { v: 0 as const, sessionId: EDITS, agent: "weights-run" };
    // What a client that posts only the edit leaves behind: no turn, no tool call, no model call.
    await put([
      { ...e, id: "w-0", ts: t0, kind: "session.start", payload: { name: "weights.edit" } },
      { ...e, id: "w-1", ts: t0 + 100, kind: "notification", payload: { kind: "weights.edit", tensor: "model.layers.15.mlp.down_proj.weight", shape: [4096, 11008], changed: 65536, l2: 0.0183, maxAbs: 0.004, baseSha256: A, editedSha256: B } },
      { ...e, id: "w-2", ts: t0 + 200, kind: "notification", payload: { kind: "weights.edit", changed: 1024, l2: 0.002, maxAbs: 0.001 } },
      { ...e, id: "w-3", ts: t0 + 300, kind: "session.end", payload: {} },
    ]);
    const p = { v: 0 as const, sessionId: PLAIN, agent: "codex" };
    await put([
      { ...p, id: "p-0", ts: t0, kind: "session.start", payload: {} },
      { ...p, id: "p-1", ts: t0 + 1, kind: "user.message", payload: { text: "hello" } },
      { ...p, id: "p-2", ts: t0 + 2, kind: "turn.end", payload: {} },
    ]);
    await ctx.close();
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("sessions lists a session that holds only weight edits, and finds it by tag and by count", () => {
    assert.deepEqual(ids(), [EDITS, PLAIN].sort(), "not hidden as an empty session");
    assert.deepEqual(ids("--flag", "weights:edited"), [EDITS]);
    assert.deepEqual(ids("--where", "flag:weights:edited"), [EDITS]);
    assert.deepEqual(ids("--where", "weights.edits>0"), [EDITS]);
    assert.deepEqual(ids("--where", "weights.changed>=66560"), [EDITS]);
    assert.deepEqual(ids("--where", "weights.changed>66560"), []);
    assert.deepEqual(ids("--where", "-flag:weights:edited"), [PLAIN]);
  });

  it("show prints the Weight edits row and one line per edit", () => {
    const text = cli("show", EDITS);
    assert.match(text, /Weight edits\s+2 edits, 1 tensor, 66,560 weights changed/);
    assert.match(text, /weights\s+model\.layers\.15\.mlp\.down_proj\.weight \[4096×11008\] · 65,536 of 45,088,768 weights · L2 0\.0183 · max 0\.004 · aaaaaaaaaaaa → bbbbbbbbbbbb/);
    assert.match(text, /weights\s+1,024 weights · L2 0\.002 · max 0\.001/, "an edit captured without its name still says what changed");
    assert.doesNotMatch(text, /^\s*\+\S+\s+notification\s*$/m, "no blank notification line");
    const j = JSON.parse(cli("show", EDITS, "--json")) as { session: { flags: string[]; stats: { weightEdits?: unknown } } };
    assert.deepEqual(j.session.stats.weightEdits, { events: 2, tensors: 1, weightsChanged: 66560 });
    assert.ok(j.session.flags.includes("weights:edited"));
  });

  it("a session with no weight edit has no row", () => {
    assert.doesNotMatch(cli("show", PLAIN), /Weight edits/);
    const j = JSON.parse(cli("show", PLAIN, "--json")) as { session: { stats: Record<string, unknown> } };
    assert.equal(Object.hasOwn(j.session.stats, "weightEdits"), false);
  });
});
