#!/usr/bin/env node
// Command task for coding.sh (or any harness): reads a case input as JSON on
// stdin, runs it against the local eve agent with eve's own client, and prints
// {reply, replies, sessionId, status} as JSON on stdout.
//
//   echo '"What is the weather in Paris?"' | npm run --silent ask
//   echo '{"messages":["Weather in Paris?","And the weather in London?"]}' | node scripts/ask.mjs
//
// Env: EVE_URL (default http://127.0.0.1:2000).
import { Client } from "eve/client";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString("utf8").trim();
let input;
try {
  input = JSON.parse(raw);
} catch {
  input = raw; // plain text prompt
}
const messages = typeof input === "string" ? [input] : typeof input?.message === "string" ? [input.message] : input?.messages;
if (!Array.isArray(messages) || !messages.length) {
  console.error('expected "text", {"message": "..."} or {"messages": ["...", ...]} on stdin');
  process.exit(2);
}

const client = new Client({ baseUrl: process.env.EVE_URL ?? "http://127.0.0.1:2000" });
const replies = [];
let session;
let result;
for (const message of messages) {
  if (!session) {
    const created = await client.sessions.create({ message });
    session = created.session;
    result = await created.delivery.result();
  } else {
    result = await (await session.send(message)).result();
  }
  if (result.status !== "completed") break;
  replies.push(result.reply ?? "");
}

// Results carry no event log, so read the recorded stream once for the calls.
const toolCalls = [];
const byId = new Map();
if (session) {
  for await (const ev of session.stream({ startIndex: 0, follow: false })) {
    if (ev.type === "call.requested") {
      const call = { tool: ev.data.capability?.name, kind: ev.data.capability?.kind, input: ev.data.input };
      byId.set(ev.data.callId, call);
      toolCalls.push(call);
    } else if (ev.type === "call.settled" && byId.has(ev.data.callId)) {
      Object.assign(byId.get(ev.data.callId), { ok: ev.data.outcome === "completed", output: ev.data.output });
    }
  }
  await session.end().catch(() => {});
}

console.log(
  JSON.stringify({
    reply: replies.at(-1) ?? "",
    replies,
    sessionId: result?.sessionId,
    status: result?.status,
    outcome: result?.outcome,
    toolCalls,
    subagents: toolCalls.filter((c) => c.kind === "agent").map((c) => c.tool),
    error: result?.error,
  }),
);
process.exitCode = result?.status === "completed" ? 0 : 1;
