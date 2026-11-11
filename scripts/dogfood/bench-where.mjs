#!/usr/bin/env node
// `--where` on a store the size of a heavy real one: 3,600 sessions, 1.4M events,
// about 3.6 GB. Synthetic and deterministic (seeded PRNG); never reads a real home.
//
//   node scripts/dogfood/bench-where.mjs gen <db> [--events 1400000] [--sessions 3600] [--memory]
//   node scripts/dogfood/bench-where.mjs run <db> [--runs 5] [--json]
//
// `gen` writes the store with the code in this checkout. --memory adds what a harness
// audit looks for (bench.mjs harness-audit): each session's load notification and, for
// about one event in 25, a read, edit or write of a memory, instruction or other .md
// file. They come from their own PRNG, so the rest of the store is the same with or
// without them, but for what ingest derives from those events: each session's
// stats.memoryUse, and the cursor that says every session row was folded by this checkout
// (the audit reads the rows then, as it does in a store ingest wrote). `run` opens it (applying any
// pending migration, timed), then times each query cold (first run after open) and
// warm (median of --runs), through the same functions the CLI, viewer and MCP call.
// A query with a budget fails the run (exit 1) when its warm median is over it.
import { statSync } from "node:fs";
import { parseArgs } from "node:util";

const SRC = new URL("../../packages/coding.sh/src/", import.meta.url);
const { SqliteIndexStore } = await import(new URL("store/sqlite.ts", SRC).href);
const { parseWhere } = await import(new URL("query/where.ts", SRC).href);
const run = await import(new URL("query/run.ts", SRC).href);
const { memoryUseOfEvents } = await import(new URL("core/memory-use.ts", SRC).href);
const { foldStamp } = await import(new URL("core/sessions.ts", SRC).href);
const { REFOLD_CURSOR } = await import(new URL("core/ingest.ts", SRC).href);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { events: { type: "string", default: "1400000" }, sessions: { type: "string", default: "3600" }, runs: { type: "string", default: "5" }, json: { type: "boolean", default: false }, memory: { type: "boolean", default: false } },
});
const [cmd, db] = positionals;
if (!db || (cmd !== "gen" && cmd !== "run")) {
  console.error("usage: bench-where.mjs gen|run <db> [--events N] [--sessions N] [--memory] [--runs N] [--json]");
  process.exit(2);
}

// ---------------------------------------------------------------- generator

let seed = 0x2f6b9e1d;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[pairs.length - 1][0];
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const WORDS = "the a to of and in is it that for on with as this be at by from or an are not was we can will should if then retry error test build migration flaky timeout config deploy handler route schema index query cache session token model agent tool file path read write edit diff patch commit branch merge rebase lint format type check server client request response status worker queue job".split(" ");
const text = (n) => {
  let out = "";
  while (out.length < n) out += pick(WORDS) + (rnd() < 0.08 ? ".\n" : " ");
  return out.slice(0, n);
};
const TOOLS = [["Bash", 30], ["Read", 25], ["Edit", 12], ["Grep", 10], ["Glob", 5], ["Write", 4], ["WebSearch", 2], ["Task", 2], ["TodoWrite", 2], ["mcp__github__create_issue", 2], ["mcp__github__get_pull_request", 2], ["mcp__linear__list_issues", 1.5], ["mcp__playwright__browser_click", 1.5], ["mcp__context7__get_docs", 1]];
const AGENTS = [["claude-code", 45], ["codex", 40], ["antigravity", 10], ["cursor", 5]];
const MODELS = { "claude-code": ["claude-opus-5-5", "claude-sonnet-5-5"], codex: ["gpt-6.1-sol", "gpt-6.1-mini"], antigravity: ["gemini-3-pro"], cursor: ["claude-sonnet-5-5", "gpt-6.1-sol"] };
const REPOS = Array.from({ length: 40 }, (_, i) => `/work/repo-${i}`);
const FLAGS = [["compaction", 12], ["no-verification", 8], ["premature-completion", 1], ["repeated-tool-failure", 0.5]];
const ERRORS = ["ENOENT: no such file or directory", "exit code 1", "command timed out after 120000ms", "permission denied", "api error 529 overloaded", "string to replace not found in file"];

// --memory draws from its own sequence (mulberry32, like rnd above).
let memSeed = 0x51ed270b;
const mrnd = () => {
  memSeed = (memSeed + 0x6d2b79f5) | 0;
  let t = memSeed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const mpick = (xs) => xs[Math.floor(mrnd() * xs.length)];
const mtext = (n) => {
  let out = "";
  while (out.length < n) out += mpick(WORDS) + " ";
  return out.slice(0, n);
};

async function gen(path, nEvents, nSessions, memory) {
  const store = await SqliteIndexStore.open(path);
  const now = Date.now();
  // Heavy-tailed sizes, one session of 154,773 events like the real store's largest.
  const raw = Array.from({ length: nSessions }, () => Math.exp(4.2 + 1.7 * gauss()));
  const fixed = Math.min(154_773, Math.floor(nEvents / 8));
  const scale = (nEvents - fixed) / raw.reduce((a, b) => a + b, 0);
  const sizes = raw.map((x) => Math.max(3, Math.round(x * scale)));
  sizes[0] = fixed;
  let written = 0;
  const t0 = performance.now();
  let batch = [];
  const flush = async () => {
    if (batch.length) await store.putEvents(batch);
    batch = [];
  };
  for (let i = 0; i < nSessions; i++) {
    const id = `bench-${String(i).padStart(5, "0")}-${Math.floor(rnd() * 1e9).toString(36)}`;
    const agent = i === 0 ? "codex" : weighted(AGENTS);
    const model = pick(MODELS[agent]);
    const cwd = pick(REPOS) + (rnd() < 0.3 ? "/packages/app" : "");
    const startedAt = now - Math.floor(rnd() * 60 * 86_400_000);
    const parent = i > 10 && rnd() < 0.35 ? `bench-parent-${i}` : undefined;
    let ts = startedAt;
    let seq = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    let turns = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let compactions = 0;
    // With --memory: the events a session fold reads for stats.memoryUse.
    const audited = [];
    const ev = (kind, payload, over = {}) => {
      ts += 50 + Math.floor(rnd() * 4000);
      batch.push({ id: `${id}-${seq++}`, v: 0, sessionId: id, ts, agent, model, cwd, kind, payload, ...(turns ? { turnId: `${id}-t${turns}` } : {}), ...over });
      if (memory && kind === "tool.start") audited.push(batch.at(-1));
    };
    const n = sizes[i];
    while (seq < n) {
      turns++;
      ev("user.message", { text: text(80 + Math.floor(rnd() * 600)) });
      const steps = 2 + Math.floor(rnd() * 30);
      for (let s = 0; s < steps && seq < n; s++) {
        const inT = 2000 + Math.floor(rnd() * 150_000);
        const outT = 50 + Math.floor(rnd() * 3000);
        tokensIn += inT;
        tokensOut += outT;
        const llmOk = rnd() > 0.01;
        ev("llm.call", { provider: agent === "codex" ? "openai" : "anthropic", ok: llmOk, ...(llmOk ? {} : { error: "api error 529 overloaded", statusCode: 529 }), ttftMs: 300 + Math.floor(rnd() * 5000) }, { durationMs: 500 + Math.floor(rnd() * 30_000), usage: { inputTokens: inT, outputTokens: outT, costUsd: inT * 3e-6 + outT * 15e-6 } });
        const tool = weighted(TOOLS);
        const mcp = tool.startsWith("mcp__") ? tool.split("__")[1] : undefined;
        const tid = `tu${seq}`;
        const input = tool === "Bash" ? { command: `npm test -- ${pick(WORDS)}` } : tool === "Grep" ? { pattern: pick(WORDS) } : { file_path: `${cwd}/src/${pick(WORDS)}.ts` };
        ev("tool.start", { tool, toolUseId: tid, input, ...(mcp ? { server: mcp } : {}) });
        const ok = rnd() > 0.06;
        toolCalls++;
        if (!ok) toolErrors++;
        const outLen = Math.floor(-Math.log(1 - rnd()) * 3400);
        ev("tool.end", { tool, toolUseId: tid, ok, ...(mcp ? { server: mcp } : {}), output: text(outLen), ...(ok ? {} : { error: pick(ERRORS) }) }, { durationMs: 5 + Math.floor(rnd() * 20_000) });
        if (rnd() < 0.002) {
          compactions++;
          ev("context.compact", { trigger: "auto" });
        }
      }
      ev("assistant.message", { text: text(100 + Math.floor(rnd() * 1500)) });
      if (batch.length >= 5000) await flush();
    }
    await flush();
    if (memory) {
      const mem = `/home/user/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/memory`;
      let m = 0;
      const mev = (kind, payload, at = startedAt + Math.floor(mrnd() * Math.max(1, ts - startedAt))) => audited.push(batch[batch.push({ id: `${id}-m${m++}`, v: 0, sessionId: id, ts: at, agent, model, cwd, kind, payload }) - 1]);
      const call = (tool, input) => mev("tool.start", { tool, toolUseId: `mu${m}`, input });
      mev("notification", { kind: "harness.loaded", loadedBy: "nested_memory", paths: [`${cwd}/src/CLAUDE.md`] }, startedAt + 1);
      for (let k = Math.ceil(n / 25); k > 0; k--) {
        const r = mrnd();
        const file = `${mem}/${mpick(WORDS)}.md`;
        if (r < 0.3) call("Read", { file_path: r < 0.1 ? `${cwd}/CLAUDE.md` : file });
        else if (r < 0.45) call("Bash", { command: `cat ${file}`, description: "read the notes" });
        else if (r < 0.6) {
          call("Edit", { file_path: file, old_string: mtext(400), new_string: mtext(600) });
          mev("file.change", { path: file, op: "modify" });
        } else if (r < 0.65) call("Skill", { skill: mpick(["pdf", "review", "deploy"]) });
        // A .md file that is no memory file: the audit has to read the call to tell.
        else call("Write", { file_path: `${cwd}/docs/${mpick(WORDS)}.md`, content: mtext(4000) });
      }
      written += m;
      await flush();
    }
    written += seq;
    const flags = FLAGS.filter(([, w]) => rnd() * 100 < w).map(([f]) => f);
    if (compactions && !flags.includes("compaction")) flags.push("compaction");
    const memoryUse = memory ? memoryUseOfEvents(audited, cwd) : undefined;
    const row = {
      id, agent, model, cwd, startedAt, endedAt: rnd() < 0.05 ? ts : undefined, title: text(40 + Math.floor(rnd() * 60)).replace(/\n/g, " "),
      stats: { events: seq, turns, toolCalls, toolErrors, filesChanged: Math.floor(rnd() * 20), usage: { inputTokens: tokensIn, outputTokens: tokensOut, costUsd: tokensIn * 3e-6 + tokensOut * 15e-6 }, ...(rnd() < 0.2 ? { testsPassed: Math.floor(rnd() * 200), testsFailed: rnd() < 0.3 ? 1 + Math.floor(rnd() * 5) : 0 } : {}) },
      flags,
      ...(parent ? { parent: { sessionId: parent, eventId: `${parent}-e`, subagentId: id, type: pick(["explorer", "worker", "general-purpose"]) } } : {}),
    };
    if (memoryUse) row.stats.memoryUse = memoryUse;
    await store.upsertSession(row);
    if (i % 200 === 0) process.stderr.write(`\r${i}/${nSessions} sessions, ${written.toLocaleString()} events, ${Math.round(performance.now() - t0) / 1000}s   `);
  }
  if (memory) await store.setCursor(REFOLD_CURSOR, foldStamp());
  await store.close();
  process.stderr.write(`\nwrote ${written.toLocaleString()} events in ${Math.round(performance.now() - t0) / 1000}s\n`);
}

// ---------------------------------------------------------------- queries

/** The most the warm median of an event filter that stands alone may take, in ms. */
const ALONE_BUDGET_MS = 500;

// Each query runs through the same entry points the CLI, viewer API and MCP use: [name, run, budget in ms].
const QUERIES = [
  ["sessions agent:codex cost>0.5 sort:-cost", (s) => run.findSessions(s, parseWhere("agent:codex cost>0.5 sort:-cost"), { limit: 50 })],
  ["sessions tool:Bash ok:false", (s) => run.findSessions(s, parseWhere("tool:Bash ok:false"), { limit: 50 })],
  ["sessions mcp:github", (s) => run.findSessions(s, parseWhere("mcp:github"), { limit: 50 })],
  ["sessions kind:context.compact -flag:compaction", (s) => run.findSessions(s, parseWhere("kind:context.compact -flag:compaction"), { limit: 50 })],
  ["sessions tool:Bash ok:false since:7d sort:-tools", (s) => run.findSessions(s, parseWhere("tool:Bash ok:false since:7d sort:-tools"), { limit: 50 })],
  // An event key with no other clause (EZ-5): these read every event until events_duration and events_error.
  // The store's durations stop at 30 s and its timeouts say "timed out", so these are the bounds that match rows.
  ["sessions event.duration>20s", (s) => run.findSessions(s, parseWhere("event.duration>20s"), { limit: 50 }), ALONE_BUDGET_MS],
  ["sessions error:*timed*", (s) => run.findSessions(s, parseWhere("error:*timed*"), { limit: 50 }), ALONE_BUDGET_MS],
  // As reported, on a store where neither matches: the whole index is still read for the answer.
  ["sessions event.duration>60s", (s) => run.findSessions(s, parseWhere("event.duration>60s"), { limit: 50 }), ALONE_BUDGET_MS],
  ["sessions error:*timeout*", (s) => run.findSessions(s, parseWhere("error:*timeout*"), { limit: 50 }), ALONE_BUDGET_MS],
  ["facets agent,model,repo,flag", (s) => run.facetCounts(s, {}, ["agent", "model", "repo", "flag"])],
  ["facets tool,mcp,kind", (s) => run.facetCounts(s, {}, ["tool", "mcp", "kind"])],
  ["facets tool | ok:false", (s) => run.facetCounts(s, parseWhere("ok:false"), ["tool"])],
  ["facets tool,mcp | agent:codex since:7d", (s) => run.facetCounts(s, parseWhere("agent:codex since:7d"), ["tool", "mcp"])],
  ["search migration | tool:Bash", (s) => run.searchWhere(s, "migration", parseWhere("tool:Bash"), { limit: 50 })],
];
const EVENT_QUERIES = [
  ["events tool:Bash ok:false since:7d", "tool:Bash ok:false since:7d"],
  ["events kind:llm.call ok:false", "kind:llm.call ok:false"],
  ["events mcp:github", "mcp:github"],
  ["events kind:tool.end event.duration>15s agent:codex", "kind:tool.end event.duration>15s agent:codex"],
  ["events error:timed", "kind:tool.end error:timed since:7d"],
  ["events retry flaky", "retry flaky tool:Bash"],
];

/** A result row with its budget, when the query has one. */
function budgeted(row, budgetMs, over) {
  if (budgetMs) Object.assign(row, { budgetMs, over });
  return row;
}

async function bench(path, runs) {
  const size = statSync(path).size;
  const t0 = performance.now();
  const store = await SqliteIndexStore.open(path);
  const openMs = performance.now() - t0;
  const all = [...QUERIES];
  if (run.findEvents) for (const [name, q] of EVENT_QUERIES) all.push([name, (s) => run.findEvents(s, parseWhere(q), { limit: 50 })]);
  const rows = [];
  for (const [name, fn, budgetMs] of all) {
    const c0 = performance.now();
    let out;
    try {
      out = await fn(store);
    } catch (e) {
      rows.push(budgeted({ name, error: String(e.message || e) }, budgetMs, true));
      continue;
    }
    const cold = performance.now() - c0;
    const warm = [];
    for (let i = 0; i < runs; i++) {
      const w0 = performance.now();
      await fn(store);
      warm.push(performance.now() - w0);
    }
    warm.sort((a, b) => a - b);
    const n = Array.isArray(out) ? out.length : out.sessions ? out.sessions.length : out.items ? out.items.length : Object.values(out).reduce((a, v) => a + v.length, 0);
    const warmMs = Math.round(warm[Math.floor(warm.length / 2)] * 10) / 10;
    rows.push(budgeted({ name, rows: n, coldMs: Math.round(cold), warmMs, maxMs: Math.round(warm[warm.length - 1]) }, budgetMs, warmMs > budgetMs));
  }
  await store.close();
  const sizeAfter = statSync(path).size;
  return { db: path, events: undefined, openMs: Math.round(openMs), sizeMB: Math.round(size / 1e6), sizeAfterMB: Math.round(sizeAfter / 1e6), rows };
}

if (cmd === "gen") await gen(db, Number(values.events), Number(values.sessions), values.memory);
else {
  const r = await bench(db, Number(values.runs));
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`open (migrations) ${r.openMs} ms · ${r.sizeMB} MB -> ${r.sizeAfterMB} MB`);
    for (const x of r.rows) console.log(x.error ? `${x.name.padEnd(52)} ERROR ${x.error}` : `${x.name.padEnd(52)} ${String(x.rows).padStart(5)} rows  cold ${String(x.coldMs).padStart(6)} ms  warm ${String(x.warmMs).padStart(7)} ms  max ${x.maxMs} ms${x.budgetMs ? `  budget ${x.budgetMs} ms${x.over ? " OVER" : ""}` : ""}`);
  }
  const over = r.rows.filter((x) => x.over);
  if (over.length) {
    console.error(`over budget: ${over.map((x) => `${x.name} (${x.error ? "error" : `${x.warmMs} ms`} > ${x.budgetMs} ms)`).join(", ")}`);
    process.exitCode = 1;
  }
}
