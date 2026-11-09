// `export --evidence`: a browsable, redacted, deterministic tree of raw traces.
// The fixture index is the real Claude Code and Codex hook captures
// (test/fixtures/adapters), ingested with a small inline cap so long tool
// outputs go to blobs, plus one session written straight to the index with
// secrets in it (the export must redact on its own, not trust the store).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { ADAPTERS } from "../../src/adapters/index.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { safeJoin, safeName, writeEvidence } from "../../src/core/evidence.ts";
import { ingest } from "../../src/core/ingest.ts";
import { createRedactor } from "../../src/core/redact.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { FIXTURES, local } from "../adapters/_helpers.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  roots.push(d);
  return d;
};

// Built at run time so no key-shaped literal sits in the source.
const KEY = ["sk-ant-", "api03-", "Zq8Rt2Lm5Np7Xv1Kc4Wd9Hs3"].join("");
const GH = ["ghp_", "R7tYp2Qm9Lx4Vb8Nc3Hd6Kf1Js5Wg0Az2UeTq"].join("");

let index: MemoryIndexStore;
let blobs: MemoryBlobStore;
let sessions: Session[];

/** Every file under `dir`, relative path → bytes. */
function tree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p).split("\\").join("/"), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

before(async () => {
  const root = tmp("csh-evidence-");
  const env = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
  const config = defaultConfig(env);
  config.capture.maxInlineBytes = 256;
  for (const agent of ["claude-code", "codex"]) {
    const dir = join(env.CODING_SH_HOME, "spool", agent);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-11-01.jsonl"), local(readFileSync(join(FIXTURES, agent, "hooks.spool.jsonl"), "utf8")));
  }
  index = new MemoryIndexStore();
  blobs = new MemoryBlobStore();
  await ingest({ config, index, blobs, adapters: new Map(ADAPTERS.map((a) => [a.id, a])), env, lock: false });

  // A session written straight to the index, unredacted, with a long output in a blob.
  const long = `${"x".repeat(300)} token ${GH} end`;
  const ref = await blobs.put(long);
  const raw: AgentEvent[] = [
    { id: "r1", v: 0, sessionId: "../raw:session", ts: 1_800_000_000_000, agent: "codex", kind: "user.message", payload: { text: `use ${KEY} for the API` } },
    { id: "r2", v: 0, sessionId: "../raw:session", ts: 1_800_000_000_100, agent: "codex", kind: "tool.start", payload: { tool: "Bash", toolUseId: "t1", input: { command: `curl -H 'x-api-key: ${KEY}' https://api.example.com` } } },
    { id: "r3", v: 0, sessionId: "../raw:session", ts: 1_800_000_000_200, agent: "codex", kind: "tool.end", payload: { tool: "Bash", toolUseId: "t1", ok: true, output: `${long.slice(0, 200)}…` }, blobs: [ref] },
    { id: "r4", v: 0, sessionId: "../raw:session", ts: 1_800_000_000_300, agent: "codex", kind: "tool.start", payload: { tool: "Bash", toolUseId: "t2", input: { command: "rg missing src" } } },
    { id: "r5", v: 0, sessionId: "../raw:session", ts: 1_800_000_000_400, agent: "codex", kind: "tool.end", payload: { tool: "Bash", toolUseId: "t2", ok: false, exitCode: 1, output: "" } },
  ];
  await index.putEvents(raw);
  await index.upsertSession(buildSession(raw));
  sessions = await index.listSessions({ limit: 100 });
});

const redactor = () => createRedactor({ redact: ["secrets"] });

describe("writeEvidence", () => {
  it("has the fixture sessions: both real captures and the raw one", () => {
    assert.ok(sessions.length >= 3, `${sessions.length} sessions`);
    assert.ok(sessions.some((s) => s.agent === "claude-code"));
    assert.ok(sessions.filter((s) => s.agent === "codex").length >= 2);
  });

  it("writes byte-identical trees on two runs", async () => {
    const a = tmp("csh-ev-a-");
    const b = tmp("csh-ev-b-");
    const ra = await writeEvidence({ index, blobs, sessions, dir: a, redactor: redactor() });
    // A different session order in, the same tree out.
    const rb = await writeEvidence({ index, blobs, sessions: [...sessions].reverse(), dir: b, redactor: redactor() });
    assert.deepEqual({ ...ra, dir: "" }, { ...rb, dir: "" });
    const ta = tree(a);
    const tb = tree(b);
    assert.deepEqual([...ta.keys()], [...tb.keys()]);
    for (const [k, v] of ta) assert.ok(v.equals(tb.get(k)!), `${k} differs`);
    // A third run into the same directory rewrites the same bytes.
    await writeEvidence({ index, blobs, sessions, dir: a, redactor: redactor() });
    for (const [k, v] of tree(a)) assert.ok(v.equals(ta.get(k)!), `${k} changed on rewrite`);
  });

  it("holds no secrets", async () => {
    const dir = tmp("csh-ev-secrets-");
    await writeEvidence({ index, blobs, sessions, dir, redactor: redactor() });
    let markers = 0;
    for (const [k, v] of tree(dir)) {
      const text = v.toString("utf8");
      assert.ok(!text.includes(KEY), `${k} holds the Anthropic key`);
      assert.ok(!text.includes(GH), `${k} holds the GitHub token`);
      assert.doesNotMatch(text, /sk-ant-api03-[A-Za-z0-9]{8}|ghp_[A-Za-z0-9]{20}/, k);
      markers += (text.match(/\[redacted:/g) ?? []).length;
    }
    assert.ok(markers >= 4, `${markers} markers`);
  });

  it("has every session's tool calls, with whole outputs read back from blobs", async () => {
    const dir = tmp("csh-ev-tools-");
    await writeEvidence({ index, blobs, sessions, dir, redactor: redactor() });
    const files = tree(dir);
    for (const s of sessions) {
      const name = safeName(s.id);
      const events = await index.listEvents(s.id);
      const ids = new Set(events.filter((e) => e.kind === "tool.start" || e.kind === "tool.end").map((e) => e.payload.toolUseId));
      const tools = [...files.keys()].filter((k) => k.startsWith(`${name}/tools/`));
      assert.equal(tools.length, ids.size, `${s.id}: one file per tool call`);
      assert.ok(files.has(`${name}/index.md`) && files.has(`${name}/session.json`) && files.has(`${name}/events.jsonl`));
      const jsonl = files.get(`${name}/events.jsonl`)!.toString().trim().split("\n");
      assert.equal(jsonl.length, events.length);
      // Every tool.end's output (as stored, without the cut mark) is in its file.
      for (const e of events.filter((x) => x.kind === "tool.end" && typeof x.payload.output === "string" && x.payload.output)) {
        const head = (e.payload.output as string).replace(/…$/, "").slice(0, 120);
        const hit = tools.some((k) => files.get(k)!.toString().includes(redactor().string(head)));
        assert.ok(hit, `${s.id}: output of ${String(e.payload.toolUseId)} in a tool file`);
      }
    }
    // A blob that is not the input (a whole hook line kept aside) is not shown as the input.
    for (const k of [...files.keys()].filter((x) => x.includes("/tools/"))) assert.doesNotMatch(files.get(k)!.toString(), /hook_event_name/, k);
    // A cut output comes back whole from its blob.
    const raw = files.get(`${safeName("../raw:session")}/tools/0001-bash.txt`)!.toString();
    assert.match(raw, /x{300} token \[redacted:github-token\] end/);
    assert.match(raw, /## input[\s\S]*curl -H 'x-api-key: \[redacted:/);
    const top = files.get("index.md")!.toString();
    for (const s of sessions) assert.ok(top.includes(`(${safeName(s.id)}/index.md)`), s.id);
    const idx = files.get(`${safeName("../raw:session")}/index.md`)!.toString();
    assert.match(idx, /- 0003 \+0\.200s tool\.end Bash ok: x+… → \[tools\/0001-bash\.txt\]/);
    assert.match(idx, /benign tool failures/);
  });

  it("caps files and says what it left out", async () => {
    const dir = tmp("csh-ev-cap-");
    const r = await writeEvidence({ index, blobs, sessions, dir, redactor: redactor(), maxFileBytes: 300, maxEventsBytes: 600 });
    assert.ok(r.cut > 0);
    const files = tree(dir);
    const raw = files.get(`${safeName("../raw:session")}/tools/0001-bash.txt`)!.toString();
    assert.match(raw, /… cut: \d+ more bytes\n$/);
    const jsonl = files.get(`${safeName("../raw:session")}/events.jsonl`)!.toString().trim().split("\n");
    assert.deepEqual(Object.keys(JSON.parse(jsonl.at(-1)!)), ["cut", "eventsLeftOut"]);
  });

  it("keeps every path inside the directory", () => {
    assert.equal(safeName("../raw:session").includes("/"), false);
    assert.match(safeName("../raw:session"), /^__\.\.?_?raw_session-[0-9a-f]{8}$|^_+raw_session-[0-9a-f]{8}$|^[\w.-]+-[0-9a-f]{8}$/);
    assert.equal(safeName("11111111-2222-4333-8444-555555555555"), "11111111-2222-4333-8444-555555555555");
    assert.notEqual(safeName("a/b"), safeName("a_b"));
    assert.throws(() => safeJoin("/tmp/x", "..", "y"), /outside/);
    assert.throws(() => safeJoin("/tmp/x", "/etc/passwd"), /outside/);
    assert.ok(safeJoin("/tmp/x", "a", "b.txt").endsWith(join("x", "a", "b.txt")));
  });
});

describe("coding.sh export --evidence", () => {
  it("writes the tree, prints the directory, refuses a non-empty one without --force, and filters like export", async () => {
    const { tmpEnv } = await import("../adapters/_helpers.ts");
    const { cli, event: ev, seed, session } = await import("../query/_seed.ts");
    const env = tmpEnv();
    try {
      await seed(env.dataHome, {
        sessions: [session("s1"), session("s2", { agent: "codex" })],
        events: [
          ev("s1", 1, { payload: { text: `my key is ${KEY}` } }),
          ev("s1", 2, { kind: "tool.start", payload: { tool: "Bash", toolUseId: "u1", input: { command: "npm test" } } }),
          ev("s1", 3, { kind: "tool.end", payload: { tool: "Bash", toolUseId: "u1", ok: false, output: "Exit code 1\nnot ok 1" } }),
          ev("s2", 1),
        ],
      });
      const out = join(tmp("csh-ev-cli-"), "traces");
      const r = cli(["export", "--evidence", out, "--agent", "claude-code"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), out);
      assert.match(r.stderr, /Wrote 1 session, 5 files/);
      const files = tree(out);
      assert.deepEqual([...files.keys()], ["index.md", "s1/events.jsonl", "s1/index.md", "s1/session.json", "s1/tools/0001-bash.txt"]);
      assert.ok(![...files.values()].some((b) => b.toString().includes(KEY)));
      assert.match(files.get("s1/tools/0001-bash.txt")!.toString(), /npm test[\s\S]*not ok 1/);

      const again = cli(["export", "--evidence", out, "--json"]);
      assert.equal(again.status, 1);
      assert.equal(JSON.parse(again.stderr).reason, "target_exists");
      const forced = cli(["export", "--evidence", out, "--force", "--json"]);
      assert.equal(forced.status, 0, forced.stderr);
      assert.deepEqual({ ...JSON.parse(forced.stdout), dir: "", bytes: 0 }, { outcome: "written", dir: "", sessions: 2, files: 8, bytes: 0, cut: 0 });

      assert.equal(cli(["export", "events", "--evidence", out]).status, 2);
      assert.equal(cli(["export"]).status, 2);
    } finally {
      env.restore();
    }
  });
});
