// The person's turns in a Claude Code session its hooks captured, stored the way ingest stores them: each
// spool line through normalize when the hook starts an ingest (a Stop or a SessionEnd), source "hook" on the
// events that name none, then buildSession. The transcript entries are synthetic, shaped like the hooks-real
// fixture's (Claude Code 2.1.319, no api-request records: a call starts at the entry before it).
import assert from "node:assert/strict";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { ClaudeTranscriptConverter } from "../../src/adapters/_shared/claude-transcript.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { SpoolLine } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { testCtx, tmpEnv, writeFile, type TmpEnv } from "./_helpers.ts";

const SID = "6f1e2d3c-4b5a-4968-8778-a6b5c4d3e2f1";
const MODEL = "claude-opus-4-5";
const T = Date.parse("2026-11-09T07:00:00.000Z");
const iso = (at: number) => new Date(T + at).toISOString();

type Entry = Record<string, unknown>;
const entry = (uuid: string, at: number, rest: Entry): Entry => ({ uuid, timestamp: iso(at), sessionId: SID, cwd: "/work/demo", entrypoint: "cli", isSidechain: false, ...rest });
const prompt = (uuid: string, at: number, content: string): Entry => entry(uuid, at, { type: "user", promptId: `p-${uuid}`, message: { role: "user", content } });
const reply = (msg: string, at: number, block: Entry, stop = "end_turn"): Entry =>
  entry(`${msg}-${at}`, at, { type: "assistant", message: { id: msg, type: "message", role: "assistant", model: MODEL, content: [block], stop_reason: stop, usage: { input_tokens: 10, output_tokens: 20 } } });
const result = (id: string, at: number, promptId: string, content: string): Entry =>
  entry(`r-${id}`, at, { type: "user", promptId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: true }] } });

let t: TmpEnv;
let transcript: string;
before(() => {
  t = tmpEnv();
  transcript = join(t.home, ".claude", "projects", "-work-demo", `${SID}.jsonl`);
});
after(() => t.restore());

const line = (event: string, at: number, raw: Entry = {}, path = transcript): SpoolLine => ({
  v: 0,
  agent: "claude-code",
  event,
  ts: T + at,
  pid: 7000,
  cwd: "/work/demo",
  entrypoint: "cli",
  raw: { session_id: SID, transcript_path: path, cwd: "/work/demo", hook_event_name: event, ...raw },
});
const stop = (at: number, said: string) => line("Stop", at, { stop_hook_active: false, last_assistant_message: said });

/** Ingests spool lines: normalize, and source "hook" on the events that name none. */
async function ingest(lines: SpoolLine[]): Promise<AgentEvent[]> {
  const { ctx } = testCtx();
  const out: AgentEvent[] = [];
  for (const l of lines) for (const e of await claudeCode.normalize(l, ctx)) out.push({ ...e, source: e.source ?? "hook" });
  return out;
}

/**
 * A live capture: the transcript grows as the session goes, and each Stop or SessionEnd ingests the lines
 * written since the last ingest, reading the transcript as it is then. Lines left at the end are ingested last.
 */
async function live(entries: Entry[], lines: SpoolLine[]): Promise<AgentEvent[]> {
  writeFile(transcript, "");
  const out: AgentEvent[] = [];
  let written = 0;
  let pending: SpoolLine[] = [];
  const write = (until: number) => {
    for (; written < entries.length && Date.parse(entries[written]!.timestamp as string) <= until; written++) appendFileSync(transcript, `${JSON.stringify(entries[written])}\n`);
  };
  for (const l of lines) {
    write(l.ts);
    pending.push(l);
    if (l.event === "Stop" || l.event === "SessionEnd") {
      out.push(...(await ingest(pending)));
      pending = [];
    }
  }
  write(Infinity);
  out.push(...(await ingest(pending)));
  return out;
}

/** The same lines ingested again with the whole transcript on disk: a late ingest, or a reparse. */
async function later(entries: Entry[], lines: SpoolLine[]): Promise<AgentEvent[]> {
  writeFile(transcript, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return ingest(lines);
}

/** A backfill of the transcript (no hooks). */
async function backfill(entries: Entry[]): Promise<AgentEvent[]> {
  const conv = new ClaudeTranscriptConverter(testCtx().ctx, { agent: "claude-code", mode: "full", sessionId: SID, source: `${SID}.jsonl` });
  for (const [i, e] of entries.entries()) await conv.add(e, i + 1);
  return (await conv.finish(true)).map((e) => ({ ...e, source: e.source ?? "transcript" }));
}

const turns = (events: AgentEvent[]) => buildSession(events).stats.turnsByModel;
const rows = (events: AgentEvent[]) => events.map((e) => `${e.kind} ${e.id} ${e.ts - T}`).sort();
const prompts = (events: AgentEvent[]) => events.filter((e) => e.kind === "user.message" && !e.subagentId).sort((a, b) => a.ts - b.ts);

describe("claude-code hook capture: the person's turns", () => {
  it("a turn ends with its own work, not the next turn's first call: a 2-minute gap still gives two 3 s turns", async () => {
    const entries = [
      prompt("u1", 0, "Add a test for the parser"),
      reply("m1", 3000, { type: "text", text: "Added." }),
      prompt("u2", 123_000, "Now update the docs"),
      reply("m2", 126_000, { type: "text", text: "Updated." }),
    ];
    // Each UserPromptSubmit hook runs 150 ms after Claude Code wrote the prompt.
    const lines = [
      line("SessionStart", -1000, { source: "startup" }),
      line("UserPromptSubmit", 150, { prompt: "Add a test for the parser" }),
      stop(3100, "Added."),
      line("UserPromptSubmit", 123_150, { prompt: "Now update the docs" }),
      stop(126_100, "Updated."),
    ];
    const hooked = await live(entries, lines);
    assert.equal(new Set(hooked.map((e) => e.id)).size, hooked.length, "the second Stop reads only its own turn");
    assert.deepEqual(rows(await later(entries, lines)), rows(hooked));
    assert.deepEqual(prompts(hooked).map((e) => e.ts - T), [-1, 122_999]);
    assert.deepEqual(turns(hooked), { [MODEL]: { turns: 2, replied: 1, durationsMs: [3101, 3101] } });
    assert.deepEqual(turns(await backfill(entries)), { [MODEL]: { turns: 2, replied: 1, durationsMs: [3000, 3000] } });
  });

});

describe("claude-code hook capture: when a prompt was written", () => {
  const missing = async (l: SpoolLine): Promise<{ said: string[][]; ts: number[] }> => {
    const said: string[][] = [];
    const events = await claudeCode.normalize(l, { ...testCtx().ctx, missing: (path, session) => void said.push([path, session]) });
    return { said, ts: events.filter((e) => e.kind === "user.message").map((e) => e.ts - T) };
  };

  it("a slash command's prompt takes the time of the entry that records it, and a prompt the transcript does not hold keeps the hook's", async () => {
    writeFile(transcript, `${JSON.stringify(prompt("c1", 0, "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>src</command-args>"))}\n`);
    assert.deepEqual(await missing(line("UserPromptSubmit", 150, { prompt: "/review src" })), { said: [], ts: [-1] });
    assert.deepEqual(await missing(line("UserPromptSubmit", 150, { prompt: "something else" })), { said: [], ts: [150] });
    // A prompt with the same text 20 s earlier is too far away to be this one.
    assert.deepEqual(await missing(line("UserPromptSubmit", 20_000, { prompt: "/review src" })), { said: [], ts: [20_000] });
  });

  it("says when the transcript is gone, or has grown past the prompt, so a reparse keeps the stored rows", async () => {
    const gone = join(t.home, "runs", "run_1", "home", ".claude", "projects", "-work-demo", `${SID}.jsonl`);
    assert.deepEqual(await missing(line("UserPromptSubmit", 150, { prompt: "Add a test" }, gone)), { said: [[gone, SID]], ts: [150] });
    writeFile(transcript, `${JSON.stringify(prompt("u1", 0, "Add a test"))}\n`);
    assert.deepEqual(await missing(line("UserPromptSubmit", 150, { prompt: "Add a test" })), { said: [], ts: [-1] });
    // An hour later the session reads nine 1 MiB tool results: the 8 MB read from the end starts after the prompt.
    const big = JSON.stringify(result("toolu_pad", 3_600_000, "p-u9", "x".repeat(1024 * 1024)));
    appendFileSync(transcript, `${Array.from({ length: 9 }, () => big).join("\n")}\n`);
    assert.deepEqual(await missing(line("UserPromptSubmit", 150, { prompt: "Add a test" })), { said: [[transcript, SID]], ts: [150] });
    rmSync(transcript);
  });
});
