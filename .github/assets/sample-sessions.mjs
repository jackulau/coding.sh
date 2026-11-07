// Writes made-up sessions into a throwaway HOME for the README screenshots (viewer-session.png,
// viewer-sessions.png), so the viewer shows a mix of agents and no real session data:
//   - six Claude Code transcripts   $HOME/.claude/projects/-home-dev-coding-sh/<id>.jsonl
//   - three Codex CLI rollouts      $HOME/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
//   - four Vercel AI SDK traces from a bot that labels coding.sh issues (service.name "coding-sh-triage"),
//     as OTLP/JSON in $HOME/otlp-traces.json, POSTed to <collector>/v1/traces when a URL is given
// Everything is timed relative to now (the last six hours).
//
// Regenerate (from the repo root):
//   R=$(mktemp -d)
//   export HOME=$R/home CODING_SH_HOME=$R/home/.coding.sh CODEX_HOME=$R/home/.codex CODING_SH_NO_UPDATE_CHECK=1
//   CLI=packages/coding.sh/src/cli/main.ts
//   node $CLI collector --port 0 --json > $R/collector.json & C=$!
//   until [ -s $R/collector.json ]; do sleep 0.2; done
//   node .github/assets/sample-sessions.mjs "$HOME" "$(node -p "require('$R/collector.json').url")"
//   kill $C
//   node $CLI ingest --backfill
//   node $CLI sessions      # 13 sessions: 6 claude-code, 3 codex, 4 coding-sh-triage
//   node $CLI ui --port 4320 --no-open & U=$!
//   node .github/assets/capture-readme.mjs http://127.0.0.1:4320/   # 1280 wide, 2x, dark
//   kill $U
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[2];
const collector = process.argv[3];
if (!home) {
  console.error("usage: node sample-sessions.mjs <home> [collector-url]");
  process.exit(2);
}
const cwd = "/home/dev/coding.sh";
const now = Date.now();

// ---------------------------------------------------------------- Claude Code

const dir = join(home, ".claude", "projects", "-home-dev-coding-sh");
mkdirSync(dir, { recursive: true });

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5";
const sessions = [
  { prompt: "coding.sh usage --by model prints NaN for cache hits when a session has no model calls. Fix it and add a test.", model: OPUS, ok: true, mins: 0,
    steps: [["Grep", { pattern: "cacheHit", path: "packages/coding.sh/src" }, "src/cli/commands/usage.ts:88"], ["Read", { file_path: `${cwd}/packages/coding.sh/src/cli/commands/usage.ts` }, "...usage.ts (212 lines)"], ["Edit", { file_path: `${cwd}/packages/coding.sh/src/cli/commands/usage.ts`, old_string: "hits / calls", new_string: "calls ? hits / calls : 0" }, "The file has been updated."], ["Bash", { command: "npm test -w coding.sh -- usage" }, "# pass 14\n# fail 0"]],
    reply: "Guarded the division in usage.ts and added a test for a session with no model calls. 14 tests pass." },
  { prompt: "Add a --since flag to coding.sh search", model: SONNET, ok: true, mins: 42,
    steps: [["Read", { file_path: `${cwd}/packages/coding.sh/src/cli/registry.ts` }, "...registry.ts"], ["Read", { file_path: `${cwd}/packages/coding.sh/src/cli/commands/search.ts` }, "...search.ts"], ["Edit", { file_path: `${cwd}/packages/coding.sh/src/cli/registry.ts`, old_string: "flags: [LIMIT(20)]", new_string: "flags: [SINCE, LIMIT(20)]" }, "The file has been updated."], ["Edit", { file_path: `${cwd}/packages/coding.sh/src/cli/commands/search.ts`, old_string: "const rows =", new_string: "const since = parseSince(flags.since);\n  const rows =" }, "The file has been updated."], ["Bash", { command: "npm test -w coding.sh -- search" }, "# pass 9\n# fail 0"]],
    reply: "search now takes --since (7d, 12h, 30m or a date). Tests pass." },
  { prompt: "The viewer's session list jumps when a new session arrives. Can you make it keep scroll position?", model: OPUS, ok: false, mins: 95,
    steps: [["Read", { file_path: `${cwd}/packages/coding.sh/src/viewer/app.ts` }, "...app.ts"], ["Edit", { file_path: `${cwd}/packages/coding.sh/src/viewer/app.ts`, old_string: "list.innerHTML = html", new_string: "const y = list.scrollTop;\n  list.innerHTML = html;\n  list.scrollTop = y" }, "The file has been updated."]],
    reply: "I kept the scroll offset across re-renders in app.ts. I didn't run the viewer tests." },
  { prompt: "Why does coding.sh doctor warn about the wrapper agent on a fresh install?", model: SONNET, ok: true, mins: 160,
    steps: [["Grep", { pattern: "wrapper", path: "packages/coding.sh/src/cli/commands/doctor.ts" }, "doctor.ts:141"], ["Read", { file_path: `${cwd}/packages/coding.sh/src/cli/commands/doctor.ts` }, "...doctor.ts"], ["Bash", { command: "node packages/coding.sh/src/cli/main.ts doctor --json" }, "{\"ok\":true,\"warnings\":1}"]],
    reply: "doctor treats the wrapper like a hook-based agent and expects hooks it never installs. It should skip the hook check for wrapper." },
  { prompt: "Bump the OTLP receiver body limit to 8 MB and document it", model: OPUS, ok: true, mins: 230,
    steps: [["Grep", { pattern: "MAX_BODY", path: "packages/coding.sh/src/otel" }, "receiver.ts:22"], ["Edit", { file_path: `${cwd}/packages/coding.sh/src/otel/receiver.ts`, old_string: "4 << 20", new_string: "8 << 20" }, "The file has been updated."], ["Edit", { file_path: `${cwd}/docs/guides/explore.md`, old_string: "4 MB", new_string: "8 MB" }, "The file has been updated."], ["Bash", { command: "npm test -w coding.sh -- otel" }, "# pass 31\n# fail 0"]],
    reply: "Raised the limit to 8 MB in receiver.ts and updated the docs. OTLP tests pass." },
  { prompt: "Run the eval suite and tell me what regressed", model: SONNET, ok: true, mins: 300,
    steps: [["Bash", { command: "node packages/coding.sh/src/cli/main.ts exp run evals/cli --json" }, "{\"passed\":46,\"failed\":2}"], ["Read", { file_path: `${cwd}/evals/cli/tasks/show-latest.yaml` }, "...show-latest.yaml"]],
    reply: "46 of 48 tasks pass. show-latest and usage-by-day fail on the new column order." },
];

const base = now - 6 * 3600_000;
sessions.forEach((s, i) => {
  const sid = `5a3e0000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
  let t = base + s.mins * 60_000;
  const iso = () => new Date(t).toISOString();
  const common = { sessionId: sid, cwd, version: "2.4.1", gitBranch: "main", userType: "external", entrypoint: "cli" };
  const rows = [{ type: "mode", mode: "default", sessionId: sid }];
  let u = 0;
  const uuid = () => `u${i}-${u++}`;
  rows.push({ ...common, type: "user", uuid: uuid(), parentUuid: null, timestamp: iso(), message: { role: "user", content: s.prompt }, promptId: `p${i}` });
  let input = 3200, cache = 14000;
  s.steps.forEach(([name, inp, out], k) => {
    t += 1800 + k * 900;
    const id = `toolu_${i}_${k}`;
    rows.push({ ...common, type: "assistant", uuid: uuid(), parentUuid: null, timestamp: iso(), requestId: `req_${i}_${k}`,
      message: { id: `msg_${i}_${k}`, type: "message", role: "assistant", model: s.model, content: [{ type: "tool_use", id, name, input: inp }], stop_reason: "tool_use",
        usage: { input_tokens: input, output_tokens: 120 + k * 40, cache_read_input_tokens: cache, cache_creation_input_tokens: 600 } } });
    t += name === "Bash" ? 6400 : 300;
    rows.push({ ...common, type: "user", uuid: uuid(), parentUuid: null, timestamp: iso(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out, is_error: false }] } });
    input += 900; cache += 4000;
  });
  t += 2500;
  rows.push({ ...common, type: "assistant", uuid: uuid(), parentUuid: null, timestamp: iso(), requestId: `req_${i}_end`,
    message: { id: `msg_${i}_end`, type: "message", role: "assistant", model: s.model, content: [{ type: "text", text: s.reply }], stop_reason: "end_turn",
      usage: { input_tokens: input, output_tokens: 180, cache_read_input_tokens: cache, cache_creation_input_tokens: 0 } } });
  writeFileSync(join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
});
console.log(`wrote ${sessions.length} Claude Code sessions to ${dir}`);

// ---------------------------------------------------------------- Codex CLI
// Steps: ["exec", cmd, output, exitCode] or ["patch", repo-relative file, unified diff body].
// Each step is one model response (one token_usage_record), then a final answer.

const codex = [
  { prompt: "The codex adapter reports exit code 0 when exec_command output isn't JSON. Parse the \"Process exited with code N\" line and add a test.", effort: "high", mins: 120,
    steps: [
      ["exec", "rg -n \"exit_code\" packages/coding.sh/src/adapters/codex.ts", "553:      const exit = num(meta.exit_code) ?? num(obj(parsed).exit_code);\n", 0],
      ["patch", "packages/coding.sh/src/adapters/codex.ts", "@@ -553,1 +553,2 @@\n-      const exit = num(meta.exit_code) ?? num(obj(parsed).exit_code);\n+      const exit = num(meta.exit_code) ?? num(obj(parsed).exit_code) ??\n+        num(/^Process exited with code (\\d+)$/m.exec(String(p.output))?.[1]);\n"],
      ["patch", "packages/coding.sh/test/adapters/codex.test.ts", "@@ -212,0 +213,6 @@\n+test(\"plain-text exec_command output keeps its exit code\", async () => {\n+  const ev = await convert(rollout([call(\"exec_command\"), output(\"Process exited with code 2\\nOutput:\\nboom\")]));\n+  const end = ev.find((e) => e.kind === \"tool.end\");\n+  assert.equal(end?.payload.exitCode, 2);\n+  assert.equal(end?.payload.ok, false);\n+});\n"],
      ["exec", "node --test packages/coding.sh/test/adapters/codex.test.ts", "✔ plain-text exec_command output keeps its exit code (4.1ms)\n# tests 38\n# suites 0\n# pass 38\n# fail 0\n# cancelled 0\n# skipped 0\n# duration_ms 612.4\n", 0],
    ],
    reply: "exec_command results now take the exit code from the \"Process exited with code N\" line when the output isn't JSON, so a failing command no longer shows as ok. Added a test; all 38 codex adapter tests pass." },
  { prompt: "How does the OTLP receiver avoid storing the same span twice when an exporter retries?", effort: "medium", mins: 205,
    steps: [
      ["exec", "rg -n \"spanEventId|INSERT OR IGNORE\" packages/coding.sh/src", "packages/coding.sh/src/otel/map.ts:680:      id: id ?? spanEventId(traceId, spanId, slot),\npackages/coding.sh/src/store/sqlite.ts:497:    INSERT OR IGNORE INTO events (id, session_id, ts, kind, payload)\n", 0],
      ["exec", "sed -n 40,70p packages/coding.sh/src/otel/ids.ts", "export function spanEventId(traceId: string, spanId: string, slot: number): string {\n  return hashParts(\"otel-span\", traceId, spanId, String(slot));\n}\n", 0],
    ],
    reply: "Every event mapped from a span gets an id hashed from traceId, spanId and a fixed slot number (map.ts). The store inserts with INSERT OR IGNORE, so a retried batch produces the same ids and is dropped. That's why the slot numbers in map.ts must stay stable." },
  { prompt: "coding.sh gc should print what it deleted as JSON with --json", effort: "medium", mins: 290,
    steps: [
      ["exec", "sed -n 1,60p packages/coding.sh/src/cli/commands/gc.ts", "export async function run(c: CommandContext): Promise<number> {\n  const r = await gc(ctx, { dryRun });\n  out.print(`Deleted ${r.spool} spool files, ${r.blobs} blobs`);\n", 0],
      ["patch", "packages/coding.sh/src/cli/commands/gc.ts", "@@ -14,1 +14,2 @@\n-  out.print(`Deleted ${r.spool} spool files, ${r.blobs} blobs`);\n+  if (out.json) out.data(r);\n+  else out.print(`Deleted ${r.spool} spool files, ${r.blobs} blobs`);\n"],
      ["exec", "npm test -w coding.sh -- gc", "# tests 7\n# pass 7\n# fail 0\n", 0],
    ],
    reply: "gc --json now prints the deletion counts as one JSON document. The gc tests pass." },
];

const pad = (n) => String(n).padStart(2, "0");
codex.forEach((s, i) => {
  const id = `019a5e00-${pad(i + 1)}00-7000-8000-00000000000${i + 1}`;
  const turn = `turn-${i + 1}`;
  const start = base + s.mins * 60_000;
  const d = new Date(start); // Codex names rollout folders and files in local time
  const day = join(home, ".codex", "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  const fileTs = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  let t = start;
  const rows = [];
  const add = (type, payload) => rows.push({ timestamp: new Date(t).toISOString(), type, payload, ordinal: rows.length });
  const item = (it, t0 = t) => add("event_msg", { type: "item_completed", thread_id: id, turn_id: turn, item: it, started_at_ms: t0, completed_at_ms: t });
  let input = 9000, cached = 6000, resp = 0;
  const usage = (out) => {
    resp++;
    add("token_usage_record", { thread_id: id, turn_id: turn, session_id: id, response_id: `resp_${i + 1}_${resp}`,
      usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out, reasoning_output_tokens: Math.round(out / 2), total_tokens: input + out } });
    input += 1400; cached += 1200;
  };

  add("session_meta", { id, session_id: id, timestamp: new Date(t).toISOString(), cwd, originator: "codex_cli_rs", cli_version: "0.171.0", source: "cli", thread_source: "user", model_provider: "openai", git: { branch: "main", commit_hash: "c4c9cce" }, base_instructions: { text: "You are Codex." } });
  t += 1; add("turn_context", { turn_id: turn, cwd, model: "gpt-6.1-sol", effort: s.effort });
  t += 1; add("event_msg", { type: "task_started", turn_id: turn, started_at: Math.floor(t / 1000) });
  t += 8; item({ type: "UserMessage", id: `um-${i + 1}`, content: [{ type: "text", text: s.prompt, text_elements: [] }] });
  s.steps.forEach(([kind, a, b, exit], k) => {
    const call = `call_${i + 1}_${k + 1}`;
    t += 2200 + k * 700;
    add("response_item", { type: "reasoning", id: `rs_${i + 1}_${k + 1}`, summary: [], encrypted_content: "x" });
    t += 300;
    if (kind === "exec") {
      add("response_item", { type: "function_call", status: "completed", id: `fc_${i + 1}_${k + 1}`, name: "exec_command", arguments: JSON.stringify({ cmd: a, workdir: cwd }), call_id: call });
      t += 40; usage(90 + k * 30);
      t += /--test|npm test/.test(a) ? 5200 : 400;
      add("response_item", { type: "function_call_output", call_id: call, output: `Process exited with code ${exit}\nOutput:\n${b}` });
    } else {
      add("response_item", { type: "custom_tool_call", status: "completed", id: `ctc_${i + 1}_${k + 1}`, name: "apply_patch", input: `*** Begin Patch\n*** Update File: ${a}\n${b}*** End Patch\n`, call_id: call });
      t += 40; usage(260 + k * 40);
      const t0 = t; t += 60;
      item({ type: "FileChange", id: call, changes: { [`${cwd}/${a}`]: { type: "update", unified_diff: b, move_path: null } }, status: "completed" }, t0);
      t += 50; add("response_item", { type: "custom_tool_call_output", call_id: call, output: [{ type: "input_text", text: `Success. Updated the following files:\nM ${a}` }] });
    }
  });
  t += 2600; usage(220);
  t += 100; item({ type: "AgentMessage", id: `am-${i + 1}`, content: [{ type: "Text", text: s.reply }], phase: "final_answer" });
  t += 100; add("event_msg", { type: "task_complete", turn_id: turn, last_agent_message: s.reply, started_at: Math.floor(start / 1000), completed_at: Math.floor(t / 1000), duration_ms: t - start, time_to_first_token_ms: 840 });
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-${fileTs}-${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
});
console.log(`wrote ${codex.length} Codex sessions to ${join(home, ".codex", "sessions")}`);

// ---------------------------------------------------------------- coding-sh-triage (OTel, Vercel AI SDK)
// One trace per GitHub issue: ai.generateText (root) → ai.generateText.doGenerate model calls and
// ai.toolCall spans as its children. No conversation id, so each trace is its own session.

const MODEL = "gpt-6.1-terra";
const tickets = [
  { mins: 175, prompt: "Issue #412: coding.sh usage shows $0.00 for Cursor sessions",
    tools: [["getIssue", { number: 412 }, { title: "coding.sh usage shows $0.00 for Cursor sessions", author: "dvdk", comments: 2 }],
      ["searchDocs", { query: "cursor hooks tokens cost" }, [{ title: "Agents: Cursor", url: "/docs/agents#cursor" }]]],
    answer: "Labels: question, usage. Cursor's hooks report no tokens, so there is nothing to price. Reply with the Cursor section of the agents page." },
  { mins: 228, prompt: "Issue #413: Docs link to /docs/otel is broken",
    tools: [["searchDocs", { query: "otel" }, [{ title: "OpenTelemetry", url: "/docs/otel" }]]],
    answer: "Labels: docs. The page lives at /docs/otel; the README links /docs/otel/. Fix the trailing slash." },
  { mins: 262, prompt: "Issue #414: serve returns 413 for large OTLP batches",
    tools: [["getIssue", { number: 414 }, { error: "GitHub API timeout after 5000ms" }, true],
      ["getIssue", { number: 414 }, { title: "serve returns 413 for large OTLP batches", author: "mira-o", comments: 4 }],
      ["searchDocs", { query: "OTLP body limit" }, [{ title: "Production: limits", url: "/docs/production#limits" }]]],
    answer: "Labels: bug, serve. Batches over the 8 MB body limit get 413. Point to the limits section and suggest a smaller exporter batch size." },
  { mins: 335, prompt: "Issue #415: Add a Kiro CLI adapter",
    tools: [["getIssue", { number: 415 }, { title: "Add a Kiro CLI adapter", author: "tq", comments: 1 }],
      ["searchDocs", { query: "Kiro" }, [{ title: "Agents: Kiro", url: "/docs/agents#kiro" }]]],
    answer: "Labels: enhancement, adapters. Kiro is captured today without prompts or tool calls; an adapter would read its local session files." },
];

const hex = (n, len) => n.toString(16).padStart(len, "0");
const nanos = (ms) => String(BigInt(Math.round(ms)) * 1_000_000n);
const attr = (key, v) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: typeof v === "string" ? v : JSON.stringify(v) } });
const spans = [];
tickets.forEach((tk, i) => {
  const traceId = `7e1a9c3577b34da6a3ce929d0e0e47${hex(i + 1, 2)}`;
  const rootId = `a1${hex(i + 1, 6)}00000000`;
  let n = 0;
  const sid = () => `b${hex(i + 1, 3)}${hex(++n, 12)}`;
  const start = base + tk.mins * 60_000;
  let t = start + 5;
  const common = [attr("ai.model.id", MODEL), attr("ai.model.provider", "openai.responses"), attr("ai.telemetry.functionId", "label-issue"), attr("resource.name", "label-issue")];
  let prompt = 820, totalIn = 0, totalOut = 0;
  const messages = [{ role: "system", content: "You label GitHub issues on jackulau/coding.sh. Pick labels from the repo's label list and say why in one line." }, { role: "user", content: [{ type: "text", text: tk.prompt }] }];
  const doGenerate = (toolCall, text) => {
    const out = toolCall ? 38 : 96;
    const s = { traceId, spanId: sid(), parentSpanId: rootId, name: "ai.generateText.doGenerate", kind: 3, startTimeUnixNano: nanos(t), endTimeUnixNano: nanos(t += toolCall ? 900 : 1700),
      attributes: [...common, attr("ai.operationId", "ai.generateText.doGenerate"), attr("operation.name", "ai.generateText.doGenerate label-issue"),
        attr("ai.prompt.messages", messages), attr("ai.response.finishReason", toolCall ? "tool-calls" : "stop"),
        ...(toolCall ? [attr("ai.response.toolCalls", [{ toolCallType: "function", toolCallId: toolCall.id, toolName: toolCall.name, args: JSON.stringify(toolCall.args) }])] : [attr("ai.response.text", text)]),
        attr("ai.usage.promptTokens", prompt), attr("ai.usage.completionTokens", out),
        attr("gen_ai.system", "openai.responses"), attr("gen_ai.request.model", MODEL), attr("gen_ai.response.model", MODEL),
        attr("gen_ai.usage.input_tokens", prompt), attr("gen_ai.usage.output_tokens", out)],
      status: { code: 0 }, events: [] };
    totalIn += prompt; totalOut += out; prompt += 240;
    spans.push(s);
  };
  tk.tools.forEach(([name, args, result, failed], k) => {
    const call = { id: `call_${i + 1}_${k + 1}`, name, args };
    doGenerate(call);
    t += 10;
    const s = { traceId, spanId: sid(), parentSpanId: rootId, name: "ai.toolCall", kind: 1, startTimeUnixNano: nanos(t), endTimeUnixNano: nanos(t += failed ? 5000 : 180 + k * 60),
      attributes: [attr("ai.operationId", "ai.toolCall"), attr("operation.name", "ai.toolCall label-issue"), attr("ai.toolCall.name", name), attr("ai.toolCall.id", call.id), attr("ai.toolCall.args", args),
        ...(failed ? [] : [attr("ai.toolCall.result", result)])],
      status: failed ? { code: 2, message: result.error } : { code: 0 },
      events: failed ? [{ timeUnixNano: nanos(t), name: "exception", attributes: [attr("exception.type", "TimeoutError"), attr("exception.message", result.error)] }] : [] };
    spans.push(s);
    messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: call.id, toolName: name, result }] });
    t += 10;
  });
  doGenerate(undefined, tk.answer);
  spans.push({ traceId, spanId: rootId, name: "ai.generateText", kind: 1, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(t + 20),
    attributes: [...common, attr("ai.operationId", "ai.generateText"), attr("operation.name", "ai.generateText label-issue"),
      attr("ai.prompt", { system: messages[0].content, prompt: tk.prompt }), attr("ai.response.text", tk.answer), attr("ai.response.finishReason", "stop"),
      attr("ai.usage.promptTokens", totalIn), attr("ai.usage.completionTokens", totalOut)],
    status: { code: 0 }, events: [] });
});

const otlp = {
  resourceSpans: [{
    resource: { attributes: [attr("service.name", "coding-sh-triage"), attr("service.version", "0.4.2"), attr("deployment.environment", "production")] },
    scopeSpans: [{ scope: { name: "ai", version: "6.0.0" }, spans }],
  }],
};
const otlpFile = join(home, "otlp-traces.json");
writeFileSync(otlpFile, JSON.stringify(otlp, null, 2) + "\n");
console.log(`wrote ${tickets.length} coding-sh-triage traces (${spans.length} spans) to ${otlpFile}`);

if (collector) {
  const res = await fetch(new URL("/v1/traces", collector), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(otlp) });
  const body = await res.text();
  if (!res.ok) {
    console.error(`POST ${collector}/v1/traces failed: ${res.status} ${body}`);
    process.exit(1);
  }
  console.log(`posted to ${new URL("/v1/traces", collector)}: ${res.status} ${body}`);
}
