// Aider (aider.chat). Tier C: no hooks or plugins, so live capture is `coding.sh run -- aider …`
// (the wrapper spools under agent id "aider"; normalize delegates to the wrapper normalizer).
//
// Verified against aider 0.86.2 (2026-02-12) args.py / base_coder.py / io.py:
// - Scripting: `aider --message "<prompt>" --yes-always --no-auto-commits --no-stream --no-pretty`
//   (+ --no-check-update, --no-analytics for one run; --analytics-disable is PERMANENT, never use it).
//   --no-show-release-notes too: on a version's first run --yes-always answers "see what's new?"
//   and aider opens the release notes in a browser (seen on Windows CI).
// - Per-message usage on stdout: "Tokens: 2.1k sent, 1.2k cache write, 3k cache hit, 345 received.
//   Cost: $0.01 message, $0.02 session." (cache parts and Cost are optional; counts use k suffixes).
// - .aider.chat.history.md has no session id and lives at each repo root, so there is no backfill.
//   The wrapper's session.start keeps aider's argv: the prompt (--message/-m/--msg) and --model
//   come from there.
// - Config: .aider.conf.yml in ~, git root, cwd (later wins); `-c file` loads only that file.
import { join } from "node:path";
import type { Adapter, AgentRunOutput, DetectResult, FileChange, HarnessBundle, NormalizeContext, RunSpec, SpoolLine } from "../../core/types.ts";
import type { AgentEvent, Usage } from "../../schema/index.ts";
import { Emitter, binVersion, emitText, findBinary, hasFlag, isObj, overlayHome, runEnv, spawnAgent, spoolIdParts, toRunOutput } from "./_util.ts";
import { normalizeWrapperLine } from "./wrapper.ts";
import { costFrom, pricesFor, resolvePrice } from "../../core/pricing.ts";

const ID = "aider";

/** "2.1k" → 2100, "12k" → 12000, "345" → 345. */
function tok(s: string): number {
  const m = /^([\d.]+)\s*([kKmM]?)$/.exec(s.trim().replace(/,/g, ""));
  if (!m) return 0;
  const n = Number(m[1]);
  return Math.round(m[2]?.toLowerCase() === "k" ? n * 1000 : m[2]?.toLowerCase() === "m" ? n * 1e6 : n);
}

/** Sum aider's per-message "Tokens: …" lines; cost is the last reported session total. */
export function parseAiderUsage(text: string): Usage | undefined {
  let u: Usage | undefined;
  const t = text.replace(/\x1b\[[0-9;]*m/g, "");
  for (const m of t.matchAll(/Tokens:\s*([^\n]*?)\s+received\./g)) {
    const parts = `${m[1]} received`.split(/,\s+/);
    u ??= {};
    const n: Record<string, number> = {};
    for (const p of parts) {
      const mm = /^([\d.,]+\s*[kKmM]?)\s+(sent|received|cache write|cache hit)$/.exec(p.trim());
      if (mm) n[mm[2]!] = (n[mm[2]!] ?? 0) + tok(mm[1]!);
    }
    // "sent" counts the cache reads once and the cache writes twice (src/capture/aider.ts):
    // inputTokens is the uncached part, as everywhere else in coding.sh.
    const read = n["cache hit"] ?? 0;
    const write = n["cache write"] ?? 0;
    if (n.sent !== undefined) u.inputTokens = (u.inputTokens ?? 0) + Math.max(0, n.sent - read - 2 * write);
    if (n.received !== undefined) u.outputTokens = (u.outputTokens ?? 0) + n.received;
    if (n["cache write"] !== undefined) u.cacheWriteTokens = (u.cacheWriteTokens ?? 0) + write;
    if (n["cache hit"] !== undefined) u.cacheReadTokens = (u.cacheReadTokens ?? 0) + read;
  }
  let cost: number | undefined;
  for (const m of t.matchAll(/Cost:\s*\$([\d.]+)\s+message,\s*\$([\d.]+)\s+session/g)) cost = Number(m[2]);
  if (cost !== undefined) u = { ...(u ?? {}), costUsd: cost };
  return u;
}

/** Value of the last `--flag value` / `--flag=value` among `names` in an argv. */
export function argValue(args: string[], ...names: string[]): string | undefined {
  let v: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (names.includes(a) && i + 1 < args.length) v = args[++i];
    else {
      const eq = a.indexOf("=");
      if (eq > 0 && names.includes(a.slice(0, eq))) v = a.slice(eq + 1);
    }
  }
  return v;
}

/**
 * A model reply's cost from its tokens, not Aider's figure: for Anthropic models
 * Aider prices the cache tokens it already counted in "sent" a second time
 * (a reply of 1,500 input, 2,400 cache write, 12,000 cache hit and 30 output
 * tokens on Claude Sonnet comes out at $0.06075; its tokens price to $0.01755).
 * When the price table has the model, the cost is left to ingest's pricing
 * (marked estimated) and Aider's figure stays in payload.aiderCostUsd; a
 * model with no price keeps Aider's figure.
 */
function tokenPriced(e: AgentEvent): void {
  const u = e.usage;
  if (!u || typeof u.costUsd !== "number" || !((u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0))) return;
  const model = e.model ?? (typeof e.payload.responseModel === "string" ? e.payload.responseModel : undefined);
  if (!resolvePrice(model, pricesFor())) return;
  const { costUsd, ...tokens } = u;
  e.usage = tokens;
  e.payload = { ...e.payload, aiderCostUsd: costUsd };
}

/**
 * The usage of a `run` of aider, priced like a hook-path reply (tokenPriced): when the price
 * table has the model, the cost comes from the tokens, since Aider's session cost counts the
 * cache tokens twice for Anthropic models. A model with no price keeps Aider's figure.
 */
export function aiderRunUsage(u: Usage | undefined, model: string | undefined): Usage | undefined {
  if (!u || typeof u.costUsd !== "number") return u;
  const { costUsd, ...tokens } = u;
  if (!((tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0) + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0))) return u;
  const hit = resolvePrice(model, pricesFor());
  return hit ? { ...tokens, costUsd: costFrom(tokens, hit.price) } : { ...tokens, costUsd };
}

/** Wrapper events, plus the prompt and model aider was started with. */
export async function normalizeAider(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  const events = await normalizeWrapperLine(line, ctx);
  for (const e of events) if (e.kind === "llm.call") tokenPriced(e);
  const start = events.find((e) => e.kind === "session.start");
  const raw = isObj(line.raw) ? line.raw : {};
  if (!start || !Array.isArray(raw.args)) return events;
  const args = raw.args.filter((a): a is string => typeof a === "string");
  const model = argValue(args, "--model");
  const prompt = argValue(args, "--message", "--msg", "-m");
  if (model) start.model = model;
  if (prompt) {
    const em = new Emitter(ctx, { agent: line.agent, sessionId: start.sessionId, ts: start.ts, cwd: start.cwd, runId: line.runId, model }, [...spoolIdParts(line, start.sessionId, ctx), "prompt"]);
    await emitText(em, ctx, "user.message", prompt);
    events.push(...em.events);
  }
  return events;
}

export const aiderAdapter: Adapter = {
  id: ID,
  displayName: "Aider",
  tier: "C",
  // 2 (0.1.2): prompt and model from aider's argv. 3: live usage (llm.usage lines from the wrapper).
  // 4: a reply's cost from its tokens when the model has a price (Aider's figure counts cache twice).
  // 5: stdout usage: inputTokens is "sent" less the cache reads and twice the cache writes.
  parseVersion: 5,
  async detect(): Promise<DetectResult> {
    const binary = findBinary(["aider"]);
    const r: DetectResult = { installed: !!binary, hooked: false, notes: ["Aider has no hooks. Capture with `coding.sh run -- aider …`."] };
    if (binary) {
      r.binary = binary;
      const v = await binVersion(binary);
      if (v) r.version = v;
    }
    return r;
  },
  async install(): Promise<FileChange[]> {
    return [];
  },
  async uninstall(): Promise<FileChange[]> {
    return [];
  },
  normalize: normalizeAider,
  async run(spec: RunSpec): Promise<AgentRunOutput> {
    const bin = findBinary(["aider"], { ...process.env, ...spec.env }) ?? "aider";
    const args = ["--message", spec.instruction];
    for (const [flag, ...alts] of [["--yes-always"], ["--no-auto-commits", "--auto-commits"], ["--no-dirty-commits", "--dirty-commits"], ["--no-stream", "--stream"], ["--no-pretty", "--pretty"], ["--no-check-update", "--check-update"], ["--no-analytics", "--analytics"], ["--no-gitignore", "--gitignore"], ["--no-show-model-warnings", "--show-model-warnings"], ["--no-show-release-notes", "--show-release-notes"]] as const) {
      if (!hasFlag(spec.flags, flag, ...alts)) args.push(flag);
    }
    if (spec.model && !hasFlag(spec.flags, "--model")) args.push("--model", spec.model);
    args.push(...spec.flags);
    let all = "";
    const r = await spawnAgent({
      stdoutFile: spec.stdoutFile,
      bin,
      args,
      cwd: spec.cwd,
      env: runEnv(spec, { AIDER_CHECK_UPDATE: "false" }),
      timeoutMs: spec.timeoutMs,
      onLine: (l) => {
        if (/Tokens:|Cost:/.test(l)) all += `${l}\n`;
      },
    });
    return toRunOutput(r, undefined, aiderRunUsage(parseAiderUsage(all), argValue(args, "--model")));
  },
  harnessFiles() {
    return { project: [".aider.conf.yml", "CONVENTIONS.md", ".aiderignore", ".aider.model.settings.yml", ".aider.model.metadata.json"], user: ["~/.aider.conf.yml", "~/.aider.model.settings.yml", "~/.aider.model.metadata.json"] };
  },
  async overlay(bundle: HarnessBundle, runDir: string) {
    // HOME stays (aider reads API keys from ~/.env). A bundle-provided user config replaces the
    // user's via -c, which loads only that file.
    const flags = bundle.files["~/.aider.conf.yml"] ? ["-c", join(overlayHome(runDir), ".aider.conf.yml")] : [];
    return { env: { AIDER_CHECK_UPDATE: "false", AIDER_ANALYTICS: "false" }, flags };
  },
};
