// show and sessions tell the whole story: show --json keeps whole messages, a failed
// model call shows with its error, a source that cannot see tool calls prints `-`,
// show's Flags row leaves out notes and tags, titles stay on one line off a TTY, and
// trial sessions stay out of the default list.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import * as sessions from "../../src/cli/commands/sessions.ts";
import * as show from "../../src/cli/commands/show.ts";
import { withWholePayload } from "../../src/cli/commands/show.ts";
import { buildSession, FLAGS } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/core/types.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const T0 = 1_800_000_000_000;
const ev = (sessionId: string, id: string, kind: string, payload: Record<string, unknown>, ts: number, extra: Partial<AgentEvent> = {}): AgentEvent =>
  ({ id, v: 1, sessionId, ts, agent: "claude-code", kind, payload, ...extra }) as unknown as AgentEvent; // slop-allow chained-as: events with only the fields the fold and show read

describe("show --json keeps whole messages", () => {
  const ID = "6a1d0e2f-aaaa-4bbb-8ccc-000000000001";
  const prompt = Array.from({ length: 300 }, (_, i) => `line ${String(i).padStart(3, "0")}.`).join(" "); // 3,000 characters
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    const blobs = new FsBlobStore(join(sb.env.CODING_SH_HOME!, "blobs"));
    const raw = await blobs.put(JSON.stringify({ prompt: "the raw hook payload" }));
    const whole = await blobs.put(prompt);
    const output = "x".repeat(5000);
    const outRef = await blobs.put(output);
    await blobs.close();
    const s = mkSession(ID, T0, { title: "long prompt" });
    await sb.seed(
      [s],
      [
        // As the Claude adapter stores it: a cut preview with "…", truncated, the whole text among the event's blobs.
        { ...ev(ID, "u1", "user.message", { text: `${prompt.slice(0, 1536)}…`, truncated: true }, T0 + 1), blobs: [raw, whole] },
        // As offload stores it (serve, OTLP): a preview under the key, the ref under <key>Blob.
        ev(ID, "t1", "tool.end", { tool: "Bash", ok: true, output: output.slice(0, 1024), outputBlob: outRef, truncated: true }, T0 + 2),
        // A blob that does not start with the preview is not the key's whole text.
        { ...ev(ID, "u2", "user.message", { text: "short…", truncated: true }, T0 + 3), blobs: [raw] },
      ],
    );
  });
  after(() => sb.cleanup());

  it("reads a 3,000-character prompt back whole and drops truncated", async () => {
    const r = await runCmd(show, sb, { positionals: [ID], flags: { all: true }, json: true });
    assert.equal(r.error, undefined, String(r.error));
    const events = r.json.events as { id: string; payload: Record<string, unknown> }[];
    const u1 = events.find((e) => e.id === "u1")!;
    assert.equal(u1.payload.text, prompt);
    assert.equal(u1.payload.truncated, undefined);
    const t1 = events.find((e) => e.id === "t1")!;
    assert.equal(t1.payload.output, "x".repeat(5000));
    assert.equal(t1.payload.outputBlob, undefined);
    assert.equal(t1.payload.truncated, undefined);
    const u2 = events.find((e) => e.id === "u2")!;
    assert.equal(u2.payload.text, "short…", "a blob that is not the text's whole is left alone");
    assert.equal(u2.payload.truncated, true);
  });

  it("the text view keeps its clip", async () => {
    const r = await runCmd(show, sb, { positionals: [ID], flags: { events: true } });
    assert.ok(!r.stdout.includes(prompt), "the timeline line is not the whole prompt");
  });

  it("withWholePayload leaves an event with nothing cut as it is", async () => {
    const blobs = new FsBlobStore(join(sb.env.CODING_SH_HOME!, "blobs"));
    const e = ev(ID, "x", "user.message", { text: "hi" }, T0);
    assert.equal(await withWholePayload(e, blobs), e);
    await blobs.close();
  });
});

describe("SDK sessions: a failed model call, and tools the source cannot see", () => {
  const SDK = "7b1d0e2f-aaaa-4bbb-8ccc-000000000002";
  const TRACED = "7b1d0e2f-aaaa-4bbb-8ccc-000000000003";
  const CLAUDE = "7b1d0e2f-aaaa-4bbb-8ccc-000000000004";
  // An SDK call outside trace(): model calls only, no parent span. The second one failed.
  const sdk = (id: string, kind: string, payload: Record<string, unknown>, ts: number) => ev(SDK, id, kind, payload, T0 + ts, { agent: "sdk", source: "sdk" } as Partial<AgentEvent>);
  const sdkEvents = [
    sdk("s0", "session.start", { name: "chat" }, 0),
    sdk("s1", "llm.call", { ok: true, model: "claude-x" }, 10),
    sdk("s2", "llm.call", { ok: false, statusCode: 500, error: "HTTP 500: internal error", model: "claude-x" }, 20),
  ];
  // Inside trace(): the calls have a parent span, so the source could have seen tools.
  const traced = [ev(TRACED, "r0", "session.start", { name: "agent" }, T0, { agent: "sdk", source: "sdk" } as Partial<AgentEvent>), ev(TRACED, "r1", "llm.call", { ok: true }, T0 + 5, { agent: "sdk", source: "sdk", parentId: "r0" } as Partial<AgentEvent>)];
  const claude = [ev(CLAUDE, "c0", "session.start", {}, T0), ev(CLAUDE, "c1", "user.message", { text: "hi" }, T0 + 1), ev(CLAUDE, "c2", "llm.call", { ok: true }, T0 + 2)];
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([buildSession(sdkEvents), buildSession(traced), buildSession(claude)], [...sdkEvents, ...traced, ...claude]);
  });
  after(() => sb.cleanup());

  it("the fold flags the failed call and counts it in stats.llmErrors", () => {
    const s = buildSession(sdkEvents);
    assert.ok(s.flags.includes(FLAGS.llmError), s.flags.join(","));
    assert.equal(s.stats.llmErrors?.count, 1);
    assert.ok(s.flags.includes(FLAGS.toolsUnseen));
    // A later call that worked: the session got past it.
    assert.ok(!buildSession([...sdkEvents, sdk("s3", "llm.call", { ok: true }, 30)]).flags.includes(FLAGS.llmError));
  });

  it("show's timeline prints the failed call with its error, and the summary says the source records model calls only", async () => {
    const r = await runCmd(show, sb, { positionals: [SDK], flags: { events: true } });
    assert.equal(r.error, undefined, String(r.error));
    assert.match(r.stdout, /llm .*failed 500: HTTP 500: internal error/);
    assert.match(r.stdout, /Model errors\s+1 failed model call, first: /);
    assert.match(r.stdout, /tool calls not recorded \(the source records model calls only\)/);
  });

  it("sessions prints - under TOOLS for a model-calls-only SDK session, and 0 for sessions that could have run tools", async () => {
    const r = await runCmd(sessions, sb, { flags: { empty: true } });
    assert.equal(r.error, undefined, String(r.error));
    const row = (id: string) => r.stdout.split("\n").find((l) => l.startsWith(id)) ?? "";
    const tools = (id: string) => row(id).split("\t")[5]; // off a TTY the table is tab-separated
    assert.equal(tools(SDK), "-", row(SDK));
    assert.equal(tools(TRACED), "0", row(TRACED));
    assert.equal(tools(CLAUDE), "0", row(CLAUDE));
  });
});

describe("show: the Flags row leaves out notes and tags", () => {
  const ids = ["9d1d0e2f-aaaa-4bbb-8ccc-000000000006", "9d1d0e2f-aaaa-4bbb-8ccc-000000000007", "9d1d0e2f-aaaa-4bbb-8ccc-000000000008"];
  const flagSets = [["compaction", "gateway:vercel"], ["compaction", "no-verification"], []];
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed(flagSets.map((flags, i) => mkSession(ids[i]!, T0 + i * 1000, { flags })));
  });
  after(() => sb.cleanup());

  it("prints a Flags row only for the session with a failure flag, without compaction", async () => {
    const flagRows = async (id: string) => {
      const r = await runCmd(show, sb, { positionals: [id] });
      assert.equal(r.error, undefined, String(r.error));
      return r.stdout.split("\n").filter((l) => l.trimStart().startsWith("Flags")).map((l) => l.trim().split(/\s+/));
    };
    assert.deepEqual(await flagRows(ids[0]!), []);
    assert.deepEqual(await flagRows(ids[1]!), [["Flags", "no-verification"]]);
    assert.deepEqual(await flagRows(ids[2]!), []);
  });
});

describe("sessions: long titles and trial sessions", () => {
  const USER = "8c1d0e2f-aaaa-4bbb-8ccc-000000000005";
  const TRIAL = "8c1d0e2f-aaaa-4bbb-8ccc-000000000006";
  const title = `Refactor ${"the parser and its tests ".repeat(8)}`.slice(0, 200);
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([mkSession(USER, T0, { title, flags: ["no-verification"] }), mkSession(TRIAL, T0 + 1000, { title: "trial", runId: "run-1", flags: ["no-verification"] } as Partial<ReturnType<typeof mkSession>>)]);
  });
  after(() => sb.cleanup());

  it("a 200-character title prints clipped on one line off a TTY, and whole in --json", async () => {
    assert.equal(title.length, 200);
    const r = await runCmd(sessions, sb, {});
    const line = r.stdout.split("\n").find((l) => l.startsWith(USER))!;
    assert.ok(line, r.stdout);
    assert.ok(!line.includes(title), "clipped");
    const cell = line.split("\t")[6]!;
    assert.match(cell, /…$/);
    assert.ok(cell.length <= 100 && cell.length > 90, cell);
    const j = await runCmd(sessions, sb, { json: true });
    assert.equal(j.json.sessions.find((s: { id: string }) => s.id === USER).title, title);
  });

  it("lists the user's session, says one trial was left out, and --include-runs lists both", async () => {
    const r = await runCmd(sessions, sb, {});
    assert.ok(r.stdout.includes(USER));
    assert.ok(!r.stdout.includes(TRIAL), "the trial stays out");
    assert.match(r.stderr, /1 session from eval, compare or exp runs not shown \(--include-runs\)/);
    const j = await runCmd(sessions, sb, { json: true });
    assert.deepEqual(j.json.sessions.map((s: { id: string }) => s.id), [USER]);
    assert.equal(j.json.hiddenRuns, 1);
    const all = await runCmd(sessions, sb, { flags: { "include-runs": true }, json: true });
    assert.deepEqual(all.json.sessions.map((s: { id: string }) => s.id).sort(), [USER, TRIAL].sort());
    assert.equal(all.json.hiddenRuns, undefined);
  });

  it("is:flagged leaves the trial out too, and a query that names runs picks them itself", async () => {
    const flagged = await runCmd(sessions, sb, { flags: { where: "is:flagged" }, json: true });
    assert.deepEqual(flagged.json.sessions.map((s: { id: string }) => s.id), [USER]);
    assert.equal(flagged.json.hiddenRuns, 1);
    const runs = await runCmd(sessions, sb, { flags: { where: "is:run" }, json: true });
    assert.deepEqual(runs.json.sessions.map((s: { id: string }) => s.id), [TRIAL]);
  });
});
