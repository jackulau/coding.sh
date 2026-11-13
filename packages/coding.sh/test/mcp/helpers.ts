// Shared fixtures for the MCP server tests: a temp HOME/CODING_SH_HOME seeded
// through the real store, and a raw line-level stdio client.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { ExperimentResult } from "../../src/datasets/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MAIN = join(PKG, "src", "mcp", "main.ts");

export interface World {
  root: string;
  env: Record<string, string>;
  /** A directory with .git where sessions A and D ran. */
  repo: string;
  now: number;
}

const dirs: string[] = [];

export function makeWorld(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-mcp-")));
  dirs.push(root);
  return worldAt(root);
}

/** A world rooted at `root` (HOME at root/home, data at `data`, default HOME/.coding.sh). */
export function worldAt(root: string, data = join(root, "home", ".coding.sh")): World {
  const home = join(root, "home");
  const repo = join(root, "repos", "parser");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(root, "repos", "docs"), { recursive: true });
  mkdirSync(data, { recursive: true });
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: data,
    PATH: process.env.PATH ?? "",
    TZ: "UTC",
    NO_COLOR: "1",
  };
  return { root, env, repo, now: Date.now() };
}

export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

let n = 0;
function ev(sessionId: string, agent: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown> = {}, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `${sessionId}-${n++}`, v: 0, sessionId, agent, ts, kind, payload, ...extra };
}

/** Ground truth for assertions, computed from the seed spec. */
export const SEED = {
  a: "sess-a",
  b: "sess-b",
  c: "sess-c",
  d: "sess-d",
  expA: "exp-a",
  expB: "exp-b",
  /** llm.call durations in the last 7 days, all sessions. */
  llmMs: [1200, 2500, 800, 900],
} as const;

export async function seed(w: World): Promise<void> {
  const { now, repo } = w;
  const H = 3600e3;
  const repoState = { root: repo, head: "abc1234", branch: "main" };
  const a0 = now - 2 * H;
  const A = "sess-a";
  const ctxA = { cwd: repo, repo: repoState, model: "claude-opus-4-5" };
  const a: AgentEvent[] = [
    ev(A, "claude-code", a0, "session.start", { source: "startup" }, ctxA),
    ev(A, "claude-code", a0 + 1000, "user.message", { text: "Fix the failing parser tests in src/parse.ts" }, ctxA),
    ev(A, "claude-code", a0 + 2000, "llm.call", { ttftMs: 300, ok: true }, { ...ctxA, durationMs: 1200, usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.01 } }),
  ];
  for (let i = 1; i <= 3; i++) {
    a.push(ev(A, "claude-code", a0 + 3000 * i + 1000, "tool.start", { tool: "Bash", toolUseId: `t${i}`, input: { command: "npm test" } }, ctxA));
    a.push(ev(A, "claude-code", a0 + 3000 * i + 2000, "tool.end", { tool: "Bash", toolUseId: `t${i}`, ok: false, output: "Error: expected 3 to equal 4 in parse.test.ts" }, { ...ctxA, durationMs: 3900 + i * 100 }));
  }
  a.push(
    ev(A, "claude-code", a0 + 20_000, "llm.call", { ttftMs: 600, ok: true }, { ...ctxA, durationMs: 2500, usage: { inputTokens: 1500, outputTokens: 300, costUsd: 0.02 } }),
    ev(A, "claude-code", a0 + 21_000, "subagent.start", { subagentId: "sub1", type: "Explore", description: "Find every caller of parseExpr" }, ctxA),
    ev(A, "claude-code", a0 + 26_000, "subagent.end", { subagentId: "sub1", ok: true }, { ...ctxA, durationMs: 5000 }),
    ev(A, "claude-code", a0 + 27_000, "assistant.message", { text: "All tests pass now." }, ctxA),
    ev(A, "claude-code", a0 + 60_000, "user.message", { text: "No, that's wrong: the tests still fail on the edge case." }, ctxA),
    ev(A, "claude-code", a0 + 61_000, "tool.start", { tool: "Edit", toolUseId: "t4", input: { file_path: "src/parse.ts" } }, ctxA),
    ev(A, "claude-code", a0 + 61_050, "tool.end", { tool: "Edit", toolUseId: "t4", ok: true }, { ...ctxA, durationMs: 50 }),
    ev(A, "claude-code", a0 + 61_100, "file.change", { path: "src/parse.ts", op: "modify" }, ctxA),
    ev(A, "claude-code", a0 + 62_000, "assistant.message", { text: "Fixed the edge case." }, ctxA),
    ev(A, "claude-code", a0 + 600_000, "session.end", { reason: "exit" }, ctxA),
  );

  const B = "sess-b";
  const b0 = now - 26 * H;
  const ctxB = { cwd: join(w.root, "repos", "docs"), model: "gpt-5" };
  const b: AgentEvent[] = [
    ev(B, "codex", b0, "session.start", {}, ctxB),
    ev(B, "codex", b0 + 500, "user.message", { text: "Add a README section about install" }, ctxB),
    ev(B, "codex", b0 + 1000, "llm.call", { ok: true }, { ...ctxB, durationMs: 800, usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.005 } }),
    ev(B, "codex", b0 + 2000, "tool.start", { tool: "read_file", toolUseId: "r1", input: { path: "README.md" } }, ctxB),
    ev(B, "codex", b0 + 2020, "tool.end", { tool: "read_file", toolUseId: "r1", ok: true }, { ...ctxB, durationMs: 20 }),
    ev(B, "codex", b0 + 60_000, "session.end", {}, ctxB),
  ];

  const C = "sess-c";
  const c0 = a0 + 30_000;
  const ctxC = { cwd: repo, repo: repoState, model: "claude-haiku-4-5" };
  const c: AgentEvent[] = [
    ev(C, "claude-code", c0, "session.start", { parentSessionId: A, subagentId: "sub2", subagentType: "general-purpose" }, ctxC),
    ev(C, "claude-code", c0 + 100, "user.message", { text: "Search for TODO comments in src" }, ctxC),
    ev(C, "claude-code", c0 + 200, "llm.call", { ok: true }, { ...ctxC, durationMs: 900, usage: { inputTokens: 300, outputTokens: 50, costUsd: 0.001 } }),
    ev(C, "claude-code", c0 + 1000, "tool.start", { tool: "Grep", toolUseId: "g1", input: { pattern: "TODO" } }, ctxC),
    ev(C, "claude-code", c0 + 1120, "tool.end", { tool: "Grep", toolUseId: "g1", ok: true }, { ...ctxC, durationMs: 120 }),
    ev(C, "claude-code", c0 + 5000, "session.end", {}, ctxC),
  ];

  const D = "sess-d";
  const d0 = now - 5 * 60e3;
  const ctxD = { cwd: repo, repo: repoState, model: "claude-opus-4-5" };
  const d: AgentEvent[] = [
    ev(D, "claude-code", d0, "session.start", {}, ctxD),
    ev(D, "claude-code", d0 + 100, "user.message", { text: "Refactor the tokenizer for speed" }, ctxD),
  ];

  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    for (const evs of [a, b, c, d]) {
      await ctx.index.putEvents(evs);
      await ctx.index.upsertSession(buildSession(evs));
    }
    const store = new FileEvalStore({ env: w.env, index: ctx.index });
    await store.putExperiment(experiment(SEED.expA, "baseline", now - H, [true, true, false, true]));
    await store.putExperiment(experiment(SEED.expB, "candidate", now - H / 2, [true, false, false, false]));
  } finally {
    await ctx.close();
  }
}

function experiment(id: string, name: string, at: number, passes: boolean[]): ExperimentResult {
  const passed = passes.filter(Boolean).length;
  return {
    id,
    name,
    dataset: { id: "arith", name: "arith", version: "v1" },
    task: { kind: "command", ref: "./agent" },
    graders: [{ id: "exact", version: "1", kind: "exact" }],
    trials: 1,
    createdAt: at,
    finishedAt: at + 1000,
    runs: passes.map((p, i) => ({ caseId: `c${i}`, trial: 0, output: "x", latencyMs: 10, grades: [{ graderId: "exact", result: { pass: p, score: p ? 1 : 0 } }], pass: p, startedAt: at })),
    summary: {
      n: passes.length,
      cases: passes.length,
      passed,
      errors: 0,
      passRate: { p: passed / passes.length, lo: 0, hi: 1 },
      ciMethod: "wilson",
      graders: [{ id: "exact", kind: "exact", n: passes.length, passed, errors: 0, meanScore: passed / passes.length, passRate: { p: passed / passes.length, lo: 0, hi: 1 } }],
      latencyMs: { mean: 10, median: 10, p90: 10, max: 10 },
    },
  };
}

// ------------------------------------------------------------ raw stdio client

export interface Rpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export class RawClient {
  readonly child: ChildProcess;
  /** Every stdout line, in order (to prove stdout carries only protocol frames). */
  readonly lines: string[] = [];
  stderr = "";
  private buf = "";
  private nextId = 1;
  private readonly waiters = new Map<string, (r: Rpc) => void>();
  private readonly exited: Promise<number | null>;

  /** `argv`: the server to run, by default the one in src. */
  constructor(env: Record<string, string>, cwd: string, argv: string[] = ["--no-warnings", MAIN]) {
    this.child = spawn(process.execPath, argv, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.lines.push(line);
        let m: Rpc;
        try {
          m = JSON.parse(line) as Rpc;
        } catch {
          continue;
        }
        const w = this.waiters.get(String(m.id));
        if (w) {
          this.waiters.delete(String(m.id));
          w(m);
        }
      }
    });
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (c: string) => (this.stderr += c));
    this.exited = new Promise((r) => this.child.on("exit", (code) => r(code)));
  }

  /** Sends a raw line; resolves with the response to `id` when given. */
  sendRaw(line: string, id?: string | number | null): Promise<Rpc> | undefined {
    const p = id !== undefined ? new Promise<Rpc>((r) => this.waiters.set(String(id), r)) : undefined;
    this.child.stdin!.write(line + "\n");
    return p;
  }

  request(method: string, params?: Record<string, unknown>): Promise<Rpc> {
    const id = this.nextId++;
    return this.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }), id)!;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  }

  async initialize(version = "2025-06-18"): Promise<Rpc> {
    const r = await this.request("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "test", version: "0" } });
    this.notify("notifications/initialized");
    return r;
  }

  /** tools/call (legacy era) returning the result object. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<{ structuredContent?: Record<string, unknown>; content: { type: string; text: string }[]; isError?: boolean }> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: rpc error ${r.error.code} ${r.error.message}`);
    return r.result as never;
  }

  async close(): Promise<number | null> {
    this.child.stdin!.end();
    return this.exited;
  }
}
