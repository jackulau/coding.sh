import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { Replay } from "../../src/core/replay.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { collect, FIXTURES, loadSpool, moreEnv, testCtx } from "../adapters/more/_helpers.ts";

const T0 = 1_762_400_000_000;
const SID = "replay-test";
let seq = 0;
function e(kind: AgentEvent["kind"], payload: Record<string, unknown>, over: Partial<AgentEvent> = {}): AgentEvent {
  seq++;
  return { id: `${SID}-e${seq}`, v: 0, sessionId: SID, ts: T0 + seq * 1000, agent: "claude-code", kind, cwd: "/work/demo", payload, ...over };
}
let tid = 0;
/** A tool call: tool.start then tool.end, with extra events (file.change, …) after the end. */
function call(tool: string, input: unknown, end: Record<string, unknown> = {}, extra: (id: string) => AgentEvent[] = () => []): AgentEvent[] {
  const id = `t${++tid}`;
  return [e("tool.start", { tool, toolUseId: id, input }), e("tool.end", { tool, toolUseId: id, ok: true, ...end }), ...extra(id)];
}
const SESSION = { id: SID, agent: "claude-code", startedAt: T0, cwd: "/work/demo", repo: { root: "/work/demo" } } as unknown as Session;
const noBlobs = { blob: async () => undefined };

describe("replay steps and reconstruction", () => {
  test("write, edit, multi-edit and delete rebuild the file at every step; ranges compare the ends", async () => {
    const evs = [
      e("user.message", { text: "make a.txt" }),
      // Claude Code's hook records a new file as an add; a bare Write could be an overwrite.
      ...call("Write", { file_path: "/work/demo/a.txt", content: "one\ntwo\nthree\n" }, {}, (id) => [e("file.change", { path: "/work/demo/a.txt", op: "add", toolUseId: id })]),
      ...call("Edit", { file_path: "/work/demo/a.txt", old_string: "two", new_string: "TWO" }),
      ...call("MultiEdit", { file_path: "a.txt", edits: [{ old_string: "one", new_string: "1" }, { old_string: "three", new_string: "3" }] }),
      ...call("Bash", { command: "npm test" }, { ok: false, exitCode: 1, output: "1 failing", durationMs: 800 }),
      ...call("Bash", { command: "rm a.txt" }, {}, (id) => [e("file.change", { path: "a.txt", op: "delete", toolUseId: id })]),
      e("assistant.message", { text: "done" }),
    ];
    const r = await Replay.load(SESSION, evs, noBlobs);
    const idx = r.index();
    assert.deepEqual(idx.steps.map((s) => s.kind), ["prompt", "edit", "edit", "edit", "shell", "shell", "reply"]);
    assert.deepEqual(idx.files, ["a.txt"]);
    assert.equal(idx.root, "/work/demo");

    assert.deepEqual(r.tree(1), [], "nothing touched before the first edit");
    assert.equal((await r.fileAt("nope.txt", 7)).why, "No step touched it.");
    assert.deepEqual(await r.fileAt("a.txt", 2), { path: "a.txt", exists: true, content: "one\ntwo\nthree\n", changedAt: 2 });
    assert.equal((await r.fileAt("a.txt", 3)).content, "one\nTWO\nthree\n");
    assert.equal((await r.fileAt("/work/demo/a.txt", 4)).content, "1\nTWO\n3\n", "absolute paths resolve to the same file");
    const del = await r.fileAt("a.txt", 6);
    assert.equal(del.exists, false);
    assert.equal(del.changedAt, 6);

    const [c3] = await r.changesAt(3);
    assert.equal(c3!.op, "modify");
    assert.equal(c3!.exact, true);
    assert.match(c3!.diff!, /^-two$/m);
    assert.match(c3!.diff!, /^\+TWO$/m);
    assert.equal((await r.changesAt(2))[0]!.op, "add");
    assert.equal((await r.changesAt(6))[0]!.op, "delete");

    const shell = await r.at(5);
    assert.deepEqual(shell.detail.shell, { command: "npm test", ok: false, exitCode: 1, durationMs: 800, output: "1 failing" });
    assert.deepEqual(shell.tree, [{ path: "a.txt", status: "added", edits: 3, lastStep: 4 }]);
    assert.equal((await r.at(4)).tree[0]!.here, true);
    assert.equal((await r.at(1)).detail.text, "make a.txt");

    const range = await r.range(3, 4);
    assert.equal(range.files.length, 1);
    assert.deepEqual(range.files[0]!.steps, [3, 4]);
    assert.equal(range.files[0]!.exact, true);
    assert.match(range.files[0]!.diff!, /^-one$[\s\S]*^\+1$/m);
    assert.equal((await r.range(2, 4)).files[0]!.op, "add");
    assert.equal((await r.range(2, 6)).files.length, 0, "created and deleted inside the range: no net file");
    await assert.rejects(() => r.at(8), RangeError);
    await assert.rejects(() => r.at(0), RangeError);
  });

  test("an edit before any read or write leaves the file unknown, with the reason, until a read shows it", async () => {
    const evs = [
      ...call("Edit", { file_path: "b.ts", old_string: "x", new_string: "y" }),
      ...call("Read", { file_path: "b.ts" }, { output: "     1\tconst y = 1;\n     2\texport { y };" }),
      ...call("Edit", { file_path: "b.ts", old_string: "const y", new_string: "let y" }),
    ];
    const r = await Replay.load(SESSION, evs, noBlobs);
    const v1 = await r.fileAt("b.ts", 1);
    assert.equal(v1.content, undefined);
    assert.match(v1.why!, /^Step 1 edited it before any step showed its content/);
    const [c1] = await r.changesAt(1);
    assert.equal(c1!.exact, false, "the agent's own diff, not real line numbers");
    assert.match(c1!.diff!, /^-x$/m);
    assert.ok(c1!.why);
    assert.equal((await r.fileAt("b.ts", 2)).content, "const y = 1;\nexport { y };\n");
    assert.equal((await r.fileAt("b.ts", 3)).content, "let y = 1;\nexport { y };\n");
    assert.equal((await r.changesAt(3))[0]!.exact, true);
    // Range from the unknown start: the read inside it supplies the "before".
    const range = await r.range(2, 3);
    assert.equal(range.files[0]!.exact, true);
  });

  test("a read that disagrees with the reconstruction re-syncs the file and reports the outside change", async () => {
    const evs = [
      ...call("Write", { file_path: "c.txt", content: "a\n" }),
      ...call("Bash", { command: "echo b >> c.txt" }),
      ...call("Read", { file_path: "c.txt" }, { output: "     1\ta\n     2\tb" }),
    ];
    const r = await Replay.load(SESSION, evs, noBlobs);
    const [c] = await r.changesAt(3);
    assert.equal(c!.resynced, true);
    assert.match(c!.diff!, /^\+b$/m);
    assert.equal((await r.fileAt("c.txt", 3)).content, "a\nb\n");
  });

  test("apply_patch hunks, Add File and Move to apply in order", async () => {
    const patch = ["*** Begin Patch", "*** Update File: d.py", "@@", " a = 1", "-b = 2", "+b = 3", "*** Add File: e.py", "+print('e')", "*** End Patch"].join("\n");
    const move = ["*** Begin Patch", "*** Update File: e.py", "*** Move to: f.py", "@@", "-print('e')", "+print('f')", "*** End Patch"].join("\n");
    const evs = [
      ...call("Write", { file_path: "d.py", content: "a = 1\nb = 2\n" }),
      ...call("apply_patch", { input: patch }),
      ...call("apply_patch", { input: move }),
    ];
    const r = await Replay.load({ ...SESSION, agent: "codex" } as Session, evs, noBlobs);
    assert.equal((await r.fileAt("d.py", 2)).content, "a = 1\nb = 3\n");
    assert.equal((await r.fileAt("e.py", 2)).content, "print('e')\n");
    assert.equal((await r.fileAt("e.py", 3)).exists, false);
    assert.equal((await r.fileAt("f.py", 3)).content, "print('f')\n");
  });

  test("a failed write changes nothing; an edit whose text is not there makes the file unknown", async () => {
    const evs = [
      ...call("Write", { file_path: "g.txt", content: "keep\n" }),
      ...call("Write", { file_path: "g.txt", content: "lost\n" }, { ok: false, output: "permission denied" }),
      ...call("Edit", { file_path: "g.txt", old_string: "missing", new_string: "x" }),
    ];
    const r = await Replay.load(SESSION, evs, noBlobs);
    assert.equal((await r.fileAt("g.txt", 2)).content, "keep\n");
    const v = await r.fileAt("g.txt", 3);
    assert.equal(v.content, undefined);
    assert.ok(v.why);
  });

  test("a baseline supplies starting content; lazy: blobs are read only for the steps asked about", async () => {
    let reads = 0;
    const evs = [...call("Edit", { file_path: "h.txt", old_string: "old", new_string: "new" })];
    for (let i = 0; i < 2000; i++) evs.push(...call("Bash", { command: `echo ${i}` }, { output: String(i) }));
    const r = await Replay.load(SESSION, evs, { blob: async () => (reads++, undefined), baseline: async (p) => (p === "h.txt" ? "old line\n" : undefined) });
    assert.equal(r.index().steps.length, 2001);
    assert.equal((await r.fileAt("h.txt", 2001)).content, "new line\n");
    assert.equal(reads, 0);
  });
});

// Every adapter that records tool calls, on its fixtures. `known` lists files whose content
// as of the last step is rebuilt (with a prefix of it); `unknown` lists files left unknown, with why.
type Want = { known?: Record<string, string>; unknown?: string[] };
const SOURCES: { name: string; agent: string; spool?: string; backfill?: () => void; want: Want }[] = [
  { name: "claude-code hooks", agent: "claude-code", spool: "claude-code/hooks.spool.jsonl", want: { known: { "sum.js": "export function sum(a, b) {\n  return Number(a) + Number(b);" } } },
  { name: "claude-code backfill", agent: "claude-code", backfill: () => (process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "config")), want: { known: { "sum.js": "export function sum(a, b)" } } },
  { name: "claude-code real", agent: "claude-code", backfill: () => (process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "real", "config")), want: { known: { "gen.txt": "one\ntwo\n", "notes.txt": "beta\nbravo\n", "out.txt": "hi\n", "sub/inner.txt": "inner\n" } } },
  { name: "codex hooks", agent: "codex", spool: "codex/hooks.spool.jsonl", want: { unknown: ["src/math.ts"] } },
  { name: "codex backfill", agent: "codex", backfill: () => (process.env.CODEX_HOME = join(FIXTURES, "codex", "home")), want: { unknown: ["src/math.ts"] } },
  { name: "copilot-cli hooks", agent: "copilot-cli", spool: "copilot-cli/hooks.spool.jsonl", want: { known: { "README.md": "# Demo\n" }, unknown: ["src/a.ts"] } },
  { name: "copilot-cli real", agent: "copilot-cli", spool: "copilot-cli/real/hooks.spool.jsonl", want: { known: { "hello.txt": "hello from stub\n" } } },
  { name: "copilot-cli real backfill", agent: "copilot-cli", backfill: () => (process.env.COPILOT_HOME = join(FIXTURES, "copilot-cli", "real", "home", ".copilot")), want: { known: { "hello.txt": "hello from stub\n" } } },
  { name: "cursor hooks", agent: "cursor", spool: "cursor/hooks.spool.jsonl", want: { known: { "src/b.js": "export const b = 2;\nexport const c = 3;\n" } } },
  { name: "droid hooks", agent: "droid", spool: "droid/hooks.spool.jsonl", want: { known: { "hello.py": "print('hello')\n" } } },
  { name: "droid real", agent: "droid", spool: "droid/real/hooks.spool.jsonl", want: { known: { "hello.txt": "hello from stub\n" } } },
  { name: "droid real backfill", agent: "droid", backfill: () => (process.env.HOME = join(FIXTURES, "droid", "real", "home")), want: { known: { "hello.txt": "hello from stub\n" } } },
  { name: "gemini-cli hooks", agent: "gemini-cli", spool: "gemini-cli/hooks.spool.jsonl", want: { unknown: ["src/math.ts"] } },
  { name: "goose hooks", agent: "goose", spool: "goose/hooks.spool.jsonl", want: { unknown: ["main.go"] } },
  { name: "goose real", agent: "goose", spool: "goose/real/hooks.spool.jsonl", want: { known: { "hello.txt": "hello from stub\n" } } },
  { name: "opencode v1", agent: "opencode", spool: "opencode/v1.spool.jsonl", want: { known: { "README.md": "# Demo\n\nHello.\n" } } },
  { name: "opencode real", agent: "opencode", spool: "opencode/real/hooks.spool.jsonl", want: { known: { "hello.txt": "hello from stub\n" } } },
  { name: "pi real", agent: "pi", spool: "pi/real/extension.spool.jsonl", want: { known: { "hello.txt": "hello from stub\n" } } },
  { name: "pi real backfill", agent: "pi", backfill: () => (process.env.PI_CODING_AGENT_DIR = join(FIXTURES, "pi", "real", "home", ".pi", "agent")), want: { known: { "hello.txt": "hello from stub\n" } } },
  { name: "amp plugin", agent: "amp", spool: "amp/plugin.spool.jsonl", want: { unknown: ["src/foo.ts"] } },
  { name: "antigravity hooks", agent: "antigravity", spool: "antigravity/hooks.spool.jsonl", want: { unknown: ["src/parse.ts"] } },
  { name: "wrapper", agent: "wrapper", spool: "wrapper/wrapper.spool.jsonl", want: { unknown: ["src/app.py"] } },
];

describe("replay on adapter fixtures", () => {
  const env = moreEnv();
  after(() => env.restore());
  for (const s of SOURCES) {
    test(s.name, async () => {
      const adapter = ADAPTERS.find((a) => a.id === s.agent)!;
      const { ctx, blobs } = testCtx();
      let events: AgentEvent[] = [];
      if (s.spool) for (const line of loadSpool(s.spool)) events.push(...(await adapter.normalize({ ...line, agent: line.agent ?? s.agent } as never, ctx)));
      else {
        s.backfill!();
        events = await collect(adapter.backfill!(ctx));
      }
      const bySession = new Map<string, AgentEvent[]>();
      for (const ev of events) (bySession.get(ev.sessionId) ?? bySession.set(ev.sessionId, []).get(ev.sessionId)!).push(ev);
      const seen = new Map<string, { content?: string; why?: string }>();
      for (const [sid, evs] of bySession) {
        const session = { id: sid, agent: s.agent, cwd: evs.find((x) => x.cwd)?.cwd } as unknown as Session;
        const r = await Replay.load(session, evs, { blob: async (ref) => blobs.get(ref) });
        const idx = r.index();
        assert.ok(idx.steps.every((st, i) => st.n === i + 1), "steps are numbered 1..n");
        for (const f of idx.files) {
          const v = await r.fileAt(f, idx.steps.length);
          seen.set(f, { content: v.content, why: v.why });
          // Every step's view resolves without throwing, and every change names a known op.
          for (const st of idx.steps.filter((x) => x.files?.some((y) => y.path === f))) for (const c of (await r.at(st.n)).changes) assert.ok(["add", "modify", "delete"].includes(c.op));
        }
        if (idx.steps.length > 1) await r.range(1, idx.steps.length);
      }
      for (const [path, prefix] of Object.entries(s.want.known ?? {})) {
        const got = seen.get(path);
        assert.ok(got, `${path} is touched (files: ${[...seen.keys()].join(", ")})`);
        assert.ok(got.content?.startsWith(prefix), `${path} rebuilt: got ${JSON.stringify(got.content)} (${got.why ?? ""})`);
      }
      for (const path of s.want.unknown ?? []) {
        const got = seen.get(path);
        assert.ok(got, `${path} is touched`);
        assert.equal(got.content, undefined, `${path} stays unknown`);
        assert.ok(got.why && /^Step \d+ /.test(got.why), `${path} says why: ${got.why}`);
      }
    });
  }
});
