// Synthetic long agent sessions for scale and derail tests. No real user data:
// every prompt, path and output is made up here from a seeded PRNG, so the same
// options always write the same bytes.
//
// One Claude Code session runs for `hours` (default 12) across a UTC day
// boundary and is resumed twice under the same id (`claude --resume` keeps the
// id), with auto compactions, Agent-tool subagents, user idle between turns, and
// six planted derails at known times (see `manifest.derails`). It is written
// both ways coding.sh captures Claude Code:
//   claude/projects/-work-longrun/<sid>.jsonl (+ subagents/)   transcript, for `ingest --backfill`
//   spool/claude-code/<yyyy-mm-dd>.<pid>.jsonl                hook lines, for spool ingest
// plus one Codex rollout resumed under the same thread id (`codex resume`):
//   codex/sessions/<yyyy>/<mm>/<dd>/rollout-…-<id>.jsonl
//
//   node test/fixtures/longrun/generate.ts --out <dir> [--hours 12] [--scale 1] [--seed 7]
//
// `scale` multiplies the tool-call rate (0.25 writes about a quarter of the
// events over the same hours), for tests that need a smaller session.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GenOptions {
  out: string;
  hours?: number;
  scale?: number;
  seed?: number;
  /** Session start, ms epoch (default 2026-11-03T16:00:00Z, so a 12 h run crosses midnight UTC). */
  start?: number;
}

export interface PlantedDerail {
  flag: string;
  /** Time of the first event of the derail (the onset a detector should report). */
  ts: number;
  note: string;
}

export interface GenManifest {
  sessionId: string;
  codexSessionId: string;
  cwd: string;
  start: number;
  end: number;
  /** Times the session was resumed (`claude --resume`). */
  resumes: number[];
  compactions: number;
  subagents: number;
  toolCalls: number;
  prompts: number;
  derails: PlantedDerail[];
  files: { transcript: string; spool: string[]; codex: string; claudeConfigDir: string; codexHome: string; spoolDir: string };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const CWD = "/work/longrun";
const VERSION = "2.1.300";
const MODEL = "claude-opus-4-5";
const SRC = ["src/cache.ts", "src/config.ts", "src/server.ts", "src/router.ts", "src/store.ts", "src/queue.ts", "src/auth.ts", "src/log.ts", "src/metrics.ts", "src/worker.ts", "src/retry.ts", "src/http.ts"];
const TESTS = SRC.map((f) => f.replace("src/", "test/").replace(".ts", ".test.ts"));
const WORDS = ["cache", "retry", "timeout", "queue", "token", "router", "handler", "config", "parser", "session", "worker", "metrics", "backoff", "lease", "flush"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => iso(ms).slice(0, 10);
const hex = (n: number, w = 12) => n.toString(16).padStart(w, "0").slice(-w);

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output: string;
  ok: boolean;
  /** Tool wall time. */
  ms: number;
  toolUseResult?: unknown;
}

/** Writes the fixture tree under opts.out and returns what is in it. */
export function generateLongSession(opts: GenOptions): GenManifest {
  const hours = opts.hours ?? 12;
  const scale = opts.scale ?? 1;
  const rnd = mulberry32(opts.seed ?? 7);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const start = opts.start ?? Date.UTC(2026, 10, 3, 16, 0, 0);
  const end = start + hours * HOUR;
  const sid = `5e55a0de-0000-4000-8000-${hex(opts.seed ?? 7)}`;
  const codexId = `0193feed-0000-7000-8000-${hex(opts.seed ?? 7)}`;

  const claudeDir = join(opts.out, "claude");
  const projDir = join(claudeDir, "projects", "-work-longrun");
  const subDir = join(projDir, sid, "subagents");
  const spoolDir = join(opts.out, "home", "spool");
  const codexHome = join(opts.out, "codex");
  mkdirSync(subDir, { recursive: true });
  mkdirSync(join(spoolDir, "claude-code"), { recursive: true });

  const transcript: string[] = [];
  const spool = new Map<string, string[]>(); // file name → lines
  const base = { sessionId: sid, cwd: CWD, version: VERSION, gitBranch: "main", userType: "external", entrypoint: "cli" };
  let t = start;
  let seq = 0;
  let pid = 41000;
  let context = 24_000; // tokens in the window right now
  let compactions = 0;
  let subagents = 0;
  let toolCalls = 0;
  let prompts = 0;
  const derails: PlantedDerail[] = [];
  const resumes: number[] = [];
  const uuid = (p: string) => `${p}-${hex(++seq, 10)}`;
  const hook = (event: string, raw: Record<string, unknown>, ts = t) => {
    const file = `${day(ts)}.${pid}.jsonl`;
    const lines = spool.get(file) ?? [];
    lines.push(JSON.stringify({ v: 0, agent: "claude-code", event, ts, pid: pid + (seq % 7) + 1, ppid: pid, cwd: CWD, raw: { session_id: sid, cwd: CWD, permission_mode: "default", hook_event_name: event, ...raw } }));
    spool.set(file, lines);
  };
  const entry = (o: Record<string, unknown>) => transcript.push(JSON.stringify({ ...base, ...o }));

  const usage = () => {
    const out = between(20, 260);
    const fresh = between(20, 320);
    context += fresh + out;
    return { input_tokens: fresh, output_tokens: out, cache_read_input_tokens: Math.max(0, context - fresh), cache_creation_input_tokens: between(0, 600) };
  };

  /** One model call that asks for one tool, the tool's result, and both hook lines. */
  const call = (c: ToolCall, opt: { sub?: { id: string; lines: string[] } } = {}) => {
    const think = between(300, 1800);
    const msg = `msg_${hex(++seq, 16)}`;
    const id = `toolu_${hex(seq, 16)}`;
    t += think;
    const a = { type: "assistant", uuid: uuid("a"), parentUuid: null, timestamp: iso(t), requestId: `req_${msg}`, message: { id: msg, type: "message", role: "assistant", model: opt.sub ? "claude-haiku-4-5" : MODEL, content: [{ type: "tool_use", id, name: c.name, input: c.input }], stop_reason: "tool_use", usage: usage() } };
    const callTs = t;
    t += c.ms;
    const u = { type: "user", uuid: uuid("u"), parentUuid: null, timestamp: iso(t), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: c.output, is_error: !c.ok }] }, toolUseResult: c.toolUseResult ?? c.output };
    if (opt.sub) {
      const sb = { ...base, isSidechain: true, agentId: opt.sub.id };
      opt.sub.lines.push(JSON.stringify({ ...sb, ...a }), JSON.stringify({ ...sb, ...u }));
      return;
    }
    toolCalls++;
    entry(a);
    entry(u);
    hook("PreToolUse", { tool_name: c.name, tool_use_id: id, tool_input: c.input }, callTs + 5);
    hook(c.ok ? "PostToolUse" : "PostToolUseFailure", { tool_name: c.name, tool_use_id: id, tool_input: c.input, ...(c.ok ? { tool_response: c.toolUseResult ?? c.output } : { error: c.output }), duration_ms: c.ms }, t - 5);
    if (context > 168_000) compact("auto");
  };

  const compact = (trigger: "auto" | "manual") => {
    t += between(2000, 5000);
    compactions++;
    hook("PreCompact", { trigger }, t - 1500);
    entry({ type: "system", subtype: "compact_boundary", uuid: uuid("s"), timestamp: iso(t), content: "Conversation compacted", compactMetadata: { trigger, preTokens: context, postTokens: 18_000, durationMs: 3000 } });
    entry({ type: "user", uuid: uuid("u"), parentUuid: null, timestamp: iso(t + 1), message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. Summary: synthetic." }, isCompactSummary: true });
    context = 18_000 + between(0, 4000);
  };

  // ---- tool call makers (healthy work)
  const read = (f = pick(SRC)): ToolCall => ({ name: "Read", input: { file_path: `${CWD}/${f}` }, output: Array.from({ length: 12 }, (_, i) => `${i + 1}\texport const ${pick(WORDS)}${i} = ${i};`).join("\n"), ok: true, ms: between(20, 200) });
  const grep = (pattern = pick(WORDS), ok = true): ToolCall => ({ name: "Grep", input: { pattern, path: `${CWD}/src` }, output: ok ? `${pick(SRC)}:${between(1, 400)}: ${pattern}()` : "No matches found", ok: true, ms: between(30, 300) });
  const edit = (f = pick(SRC), from?: string, to?: string): ToolCall => {
    const old_string = from ?? `const ${pick(WORDS)}Limit = ${between(1, 99)};`;
    const new_string = to ?? `const ${pick(WORDS)}Limit = ${between(100, 999)};`;
    return { name: "Edit", input: { file_path: `${CWD}/${f}`, old_string, new_string }, output: `The file ${CWD}/${f} has been updated.`, ok: true, ms: between(30, 150), toolUseResult: { filePath: `${CWD}/${f}`, oldString: old_string, newString: new_string } };
  };
  const test = (failed: number, file = pick(TESTS)): ToolCall => {
    const passed = between(180, 240);
    const out = `\n RUN  v3.2.4 ${CWD}\n\n ${failed ? `✗ ${file} > case ${between(1, 30)}` : `✓ ${file}`}\n\n Test Files  ${failed ? `1 failed | ${between(20, 30)} passed` : `${between(20, 31)} passed`} (31)\n      Tests  ${failed ? `${failed} failed | ` : ""}${passed} passed (${passed + failed})\n`;
    return { name: "Bash", input: { command: "npx vitest run", description: "Run tests" }, output: failed ? `Error: Exit code 1${out}` : out, ok: failed === 0, ms: between(2500, 8000) };
  };
  const bash = (command: string, ok = true, ms = between(200, 3000), output = ok ? "done" : "Error: Exit code 1\ncommand failed"): ToolCall => ({ name: "Bash", input: { command }, output, ok, ms });

  /** A healthy edit-test cycle: look around, change something, check it. */
  const cycle = () => {
    for (let i = between(1, 3); i > 0; i--) call(rnd() < 0.7 ? read() : grep());
    const f = pick(SRC);
    for (let i = between(1, 3); i > 0; i--) call(edit(f));
    if (rnd() < 0.35) {
      call(test(between(1, 3)));
      call(read(f));
      call(edit(f));
    }
    call(test(0));
  };

  const subagent = () => {
    const id = hex(between(1, 0xffffff), 6) + hex(++subagents, 4);
    const type = pick(["Explore", "general-purpose", "Plan"]);
    const lines: string[] = [];
    const toolId = `toolu_${hex(++seq, 16)}`;
    const msg = `msg_${hex(seq, 16)}`;
    t += between(800, 3000);
    const callTs = t;
    entry({ type: "assistant", uuid: uuid("a"), parentUuid: null, timestamp: iso(t), requestId: `req_${msg}`, message: { id: msg, type: "message", role: "assistant", model: MODEL, content: [{ type: "tool_use", id: toolId, name: "Agent", input: { description: `Survey ${pick(WORDS)} usage`, prompt: `Find every place that uses ${pick(WORDS)}`, subagent_type: type } }], stop_reason: "tool_use", usage: usage() } });
    hook("PreToolUse", { tool_name: "Agent", tool_use_id: toolId, tool_input: { subagent_type: type } }, t + 5);
    hook("SubagentStart", { agent_id: id, agent_type: type }, t + 10);
    const sb = { ...base, isSidechain: true, agentId: id };
    lines.push(JSON.stringify({ ...sb, type: "user", uuid: uuid("su"), timestamp: iso(t + 20), message: { role: "user", content: `Find every place that uses ${pick(WORDS)}` } }));
    const saved = context;
    context = 6000;
    for (let i = between(12, 40) * scale; i > 0; i--) call(rnd() < 0.6 ? read() : grep(), { sub: { id, lines } });
    context = saved;
    t += between(1000, 4000);
    lines.push(JSON.stringify({ ...sb, type: "assistant", uuid: uuid("sa"), timestamp: iso(t), message: { id: `msg_${hex(++seq, 16)}`, role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: `Found ${between(2, 9)} call sites.` }], stop_reason: "end_turn", usage: { input_tokens: 400, output_tokens: 30, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } }));
    writeFileSync(join(subDir, `agent-${id}.jsonl`), lines.join("\n") + "\n");
    writeFileSync(join(subDir, `agent-${id}.meta.json`), JSON.stringify({ agentType: type, description: `Survey usage`, toolUseId: toolId, finished: true }));
    hook("SubagentStop", { agent_id: id, agent_type: type, last_assistant_message: "Found call sites." }, t);
    hook("PostToolUse", { tool_name: "Agent", tool_use_id: toolId, tool_input: { subagent_type: type }, tool_response: "Found call sites." }, t + 5);
    entry({ type: "user", uuid: uuid("u"), parentUuid: null, timestamp: iso(t + 10), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: [{ type: "text", text: "Found call sites." }] }] }, toolUseResult: { status: "completed", agentId: id } });
    toolCalls++;
    void callTs;
  };

  const prompt = (text: string) => {
    prompts++;
    entry({ type: "user", uuid: uuid("u"), parentUuid: null, timestamp: iso(t), message: { role: "user", content: text }, promptId: `p${prompts}` });
    hook("UserPromptSubmit", { prompt: text }, t);
  };
  const reply = (turnStart: number) => {
    t += between(1500, 5000);
    const msg = `msg_${hex(++seq, 16)}`;
    const text = `Done with step ${prompts}: ${pick(WORDS)} handling updated and the suite passes.`;
    entry({ type: "assistant", uuid: uuid("a"), parentUuid: null, timestamp: iso(t), requestId: `req_${msg}`, message: { id: msg, type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text }], stop_reason: "end_turn", usage: usage() } });
    entry({ type: "system", subtype: "turn_duration", uuid: uuid("s"), timestamp: iso(t + 50), durationMs: t + 50 - turnStart, isMeta: true });
    hook("Stop", { stop_hook_active: false, last_assistant_message: text }, t + 60);
    t += 60;
  };
  const sessionStart = (source: string) => hook("SessionStart", { source, model: MODEL }, t - 40);
  const sessionEnd = () => hook("SessionEnd", { reason: "prompt_input_exit" }, t + 500);

  // ---- the timeline: three runs (start, two resumes), turns of work, planted derails at fixed hours.
  const at = (h: number) => start + h * HOUR;
  const plan: { h: number; run: () => void; done?: boolean }[] = [
    {
      h: 2.5,
      run: () => {
        // looping: the same two calls back and forth, nothing changes in between.
        derails.push({ flag: "looping", ts: t + 1, note: "Read + Grep of the same file and pattern, 6 times each" });
        for (let i = 0; i < 6; i++) {
          call({ ...read("src/router.ts"), output: "1\texport const route = 1;" });
          call(grep("resolveRoute", false));
        }
      },
    },
    {
      h: 4,
      run: () => {
        derails.push({ flag: "failure-streak", ts: t + 1, note: "7 failed shell commands in a row" });
        for (const cmd of ["npm run build", "npx tsc --noEmit", "node dist/cli.js --help", "npm run build -- --force", "rm -rf dist && npm run build", "npx tsc -p tsconfig.build.json", "npm run build:types"]) call(bash(cmd, false));
      },
    },
    {
      h: 6.5,
      run: () => {
        derails.push({ flag: "churn", ts: t + 1, note: "src/cache.ts edited back and forth 4 times" });
        const a = "const ttlMs = 30_000;";
        const b = "const ttlMs = 5 * 60_000;";
        for (let i = 0; i < 4; i++) {
          call(i % 2 === 0 ? edit("src/cache.ts", a, b) : edit("src/cache.ts", b, a));
          call(test(1, "test/cache.test.ts"));
        }
      },
    },
    {
      h: 9,
      run: () => {
        derails.push({ flag: "no-progress", ts: t + 1, note: "110 reads and searches going round the same 22 files and patterns, context climbing, no edit or test" });
        // Going in circles: the same handful of files and searches, over and over, each
        // read pulling more into the context. Too far apart to count as a loop.
        const circle: (() => ToolCall)[] = [...SRC.map((f) => () => read(f)), ...WORDS.slice(0, 10).map((w) => () => grep(`${w}Handler`))];
        for (let i = 0; i < 110; i++) {
          context += 1500;
          call(circle[i % circle.length]!());
        }
      },
    },
    {
      h: 10.5,
      run: () => {
        derails.push({ flag: "stalled", ts: t + 1, note: "a shell command hung for 22 minutes mid-turn" });
        call(bash("npm run e2e", false, 22 * MIN, "Error: Exit code 143\nTerminated"));
      },
    },
    {
      h: 11.3,
      run: () => {
        derails.push({ flag: "context-thrash", ts: t + 1, note: "two compactions 5 minutes apart" });
        compact("auto");
        for (let i = 0; i < 6; i++) {
          context += 24_000;
          call(read());
        }
        compact("auto");
      },
    },
  ];
  // Runs: [start, end) in hours; each resume is `claude --resume <sid>` after the previous process exited.
  const runs = [
    { from: 0, to: 4.6 },
    { from: 5.2, to: 9.8 },
    { from: 10.1, to: hours },
  ].filter((r) => r.from < hours);
  const healthyQuirks = (turn: number) => {
    // Normal patterns that must NOT be flagged: polling a background job, a few failed
    // greps while exploring, a 9-minute test run, the same test command run twice.
    if (turn % 7 === 3) for (let i = 0; i < 6; i++) call({ name: "BashOutput", input: { bash_id: "bg_1" }, output: "still running", ok: true, ms: 30_000 });
    if (turn % 5 === 1) for (let i = 0; i < 3; i++) call(bash(`test -f ${pick(SRC)}.bak`, false, 40, "Error: Exit code 1"));
    if (turn % 9 === 4) call({ ...test(0), ms: 9 * MIN });
    if (turn % 4 === 2) {
      call(test(0));
      call(test(0));
    }
    if (turn % 11 === 6) for (let i = 0; i < 40; i++) call(rnd() < 0.5 ? read() : grep()); // a research stretch
  };

  let turn = 0;
  for (const [ri, r] of runs.entries()) {
    t = at(r.from);
    pid += 1000;
    if (ri > 0) resumes.push(t);
    sessionStart(ri === 0 ? "startup" : "resume");
    while (t < at(r.to) - 20 * MIN) {
      // User think time between turns; once a run, a long coffee break.
      t += turn % 9 === 8 ? between(35, 50) * MIN : between(1, 4) * MIN;
      const turnStart = t;
      prompt(`Step ${turn + 1}: ${pick(["tighten", "fix", "refactor", "speed up", "test"])} the ${pick(WORDS)} ${pick(["path", "module", "handling", "edge cases"])}`);
      const due = plan.find((p) => !p.done && t >= at(p.h));
      if (due) {
        due.done = true;
        call(read());
        due.run();
        call(edit());
        call(test(0));
      } else {
        healthyQuirks(turn);
        if (turn % 2 === 1) subagent();
        if (turn % 4 === 3) subagent();
        // Work for 10–25 minutes of agent time per turn.
        const until = t + between(14, 28) * MIN;
        while (t < until) {
          cycle();
          if (scale < 1) t += Math.round(((1 - scale) / scale) * between(20_000, 60_000));
        }
      }
      reply(turnStart);
      turn++;
    }
    sessionEnd();
  }

  transcript.push(JSON.stringify({ type: "ai-title", aiTitle: "Long synthetic session", sessionId: sid }));
  const transcriptPath = join(projDir, `${sid}.jsonl`);
  writeFileSync(transcriptPath, transcript.join("\n") + "\n");
  const spoolFiles: string[] = [];
  for (const [name, lines] of spool) {
    const p = join(spoolDir, "claude-code", name);
    writeFileSync(p, lines.join("\n") + "\n");
    spoolFiles.push(p);
  }
  const codex = codexRollout(codexHome, codexId, start, rnd);
  return {
    sessionId: sid,
    codexSessionId: codexId,
    cwd: CWD,
    start,
    end: t,
    resumes,
    compactions,
    subagents,
    toolCalls,
    prompts,
    derails,
    files: { transcript: transcriptPath, spool: spoolFiles, codex, claudeConfigDir: claudeDir, codexHome, spoolDir },
  };
}

/** A Codex thread run for two hours, then resumed (`codex resume <id>`) an hour later in the same rollout file. */
function codexRollout(home: string, id: string, start: number, rnd: () => number): string {
  const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const d = new Date(start);
  const dir = join(home, "sessions", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  let t = start;
  let ord = 0;
  let n = 0;
  let total = 0;
  const put = (type: string, payload: unknown) => lines.push(JSON.stringify({ timestamp: iso(t), type, payload, ordinal: ++ord }));
  put("session_meta", { id, session_id: id, timestamp: iso(t), cwd: CWD, originator: "codex_cli_rs", cli_version: "0.166.0", source: "cli", model_provider: "openai" });
  const turnBlock = (k: number) => {
    const turnId = `turn-${String(k).padStart(4, "0")}`;
    put("turn_context", { turn_id: turnId, cwd: CWD, model: "gpt-5.5" });
    put("event_msg", { type: "task_started", turn_id: turnId });
    put("event_msg", { type: "user_message", message: `Codex step ${k}`, kind: "plain" });
    for (let i = between(8, 20); i > 0; i--) {
      t += between(1500, 8000);
      const callId = `call_${++n}`;
      put("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: i % 4 === 0 ? "npx vitest run" : `rg -n ${WORDS[i % WORDS.length]} src` }), call_id: callId });
      const inTok = between(4000, 9000);
      total += inTok;
      put("token_usage_record", { thread_id: id, turn_id: turnId, session_id: id, response_id: `resp_${n}`, usage: { input_tokens: inTok, cached_input_tokens: inTok - 500, cache_write_input_tokens: 0, output_tokens: 80, reasoning_output_tokens: 10, total_tokens: inTok + 80 } });
      t += between(300, 4000);
      put("response_item", { type: "function_call_output", call_id: callId, output: i % 4 === 0 ? " Test Files  12 passed (12)\n      Tests  140 passed (140)\n" : "src/a.ts:1: match" });
    }
    t += 2000;
    put("event_msg", { type: "agent_message", message: `Codex step ${k} done.` });
    put("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: "done" });
  };
  let k = 0;
  while (t < start + 2 * HOUR) {
    turnBlock(++k);
    t += between(2, 8) * MIN;
  }
  t += HOUR; // the process exits; `codex resume` appends to the same file later
  while (t < start + 4 * HOUR) {
    turnBlock(++k);
    t += between(2, 8) * MIN;
  }
  void total;
  const p = join(dir, `rollout-${iso(start).slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// CLI: node test/fixtures/longrun/generate.ts --out <dir> [--hours 12] [--scale 1] [--seed 7]
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const out = arg("out");
  if (!out) {
    process.stderr.write("usage: node test/fixtures/longrun/generate.ts --out <dir> [--hours 12] [--scale 1] [--seed 7]\n");
    process.exit(2);
  }
  const m = generateLongSession({ out, hours: Number(arg("hours") ?? 12), scale: Number(arg("scale") ?? 1), seed: Number(arg("seed") ?? 7) });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(m, null, 2));
  process.stdout.write(JSON.stringify({ ...m, files: undefined }, null, 2) + "\n");
}
