// Shared builders for tool-eval tests.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_USAGE_PATTERNS } from "../../src/toolevals/tap/cli.ts";
import type { CliTarget, ToolMetrics, ToolTask, TrialResult } from "../../src/toolevals/types.ts";

export const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const FAKE_CLI = join(FIX, "fake-cli.mjs");
export const FAKE_MCP = { legacy: join(FIX, "fake-mcp-legacy.mjs"), modern: join(FIX, "fake-mcp-modern.mjs") } as const;

const dirs: string[] = [];
export function tmp(prefix = "csh-te-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function cliTarget(over: Partial<CliTarget> = {}): CliTarget {
  return { name: "fake", kind: "cli", bin: "fake-cli", command: [process.execPath, FAKE_CLI], usageExitCodes: [2], usagePatterns: DEFAULT_USAGE_PATTERNS, helpCrawl: true, ...over };
}

export function task(over: Partial<ToolTask> = {}): ToolTask {
  return {
    id: "t1",
    target: "fake",
    split: "dev",
    tags: [],
    instruction: "Greet bob using fake-cli and reply with its output.",
    setup: { commands: [], files: {}, env: {} },
    checks: [{ kind: "output", contains: ["hello bob"] }],
    budget: {},
    status: "validated",
    source: "test",
    ...over,
  };
}

export function metrics(over: Partial<ToolMetrics> = {}): ToolMetrics {
  return {
    success: true,
    turns: 3,
    turnsSource: "llm.call",
    toolCalls: 2,
    targetCalls: 2,
    invalidCalls: 0,
    invalidRate: 0,
    invalidKinds: {},
    failedCalls: 0,
    helpLookups: 0,
    helpBytesRead: 0,
    retries: 0,
    selfCorrections: 0,
    recoveryRate: null,
    firstCallCorrect: true,
    callsToFirstCorrect: 1,
    timeToFirstCorrectMs: 10,
    efficiency: null,
    usage: { inputTokens: 1000, outputTokens: 100 },
    costUsd: 0.01,
    costSource: "estimated",
    wallMs: 5000,
    latencySource: "model-driver",
    subagents: 0,
    subagentTargetCalls: 0,
    subagentTokenShare: null,
    tapCoverage: null,
    ...over,
  };
}

let seq = 0;
export function trial(taskId: string, variant: string, driver: string, attempt: number, pass: boolean, m: Partial<ToolMetrics> = {}): TrialResult {
  return {
    id: `trial_${++seq}`,
    experimentId: "texp_test",
    taskId,
    variant,
    driver,
    attempt,
    childSessionIds: [],
    pass,
    checks: [{ kind: "output", pass }],
    metrics: metrics({ success: pass, ...m }),
    startedAt: 0,
    endedAt: 1,
  };
}
