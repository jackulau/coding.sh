// coding.sh replay <session> --step N --fork: the model call that made step N,
// sent again with a changed harness (experiments/fork.ts); with --run, Claude
// Code run from step N in a copy of the session's directory
// (experiments/fork-run.ts); with --save-case, the step as an eval case
// (experiments/fork-case.ts).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context } from "../../core/context.ts";
import { repoRoot } from "../../core/git.ts";
import { pricesFor } from "../../core/pricing.ts";
import type { Replay } from "../../core/replay.ts";
import { caseExpectation, saveForkCase } from "../../experiments/fork-case.ts";
import { firstPrompt, runFork, type ForkRunResult } from "../../experiments/fork-run.ts";
import { bundleChange, emptyChange, ForkError, forkStep, parseWith, prepareFork, requestContextFiles, type ForkResult, type HarnessChange } from "../../experiments/fork.ts";
import { hasReplayAuth, REPLAY_KEY_ENV, REPLAY_OAUTH_ENV } from "../../experiments/replay.ts";
import { SUITES_DIR } from "../../eval/suite-spec.ts";
import { proxySettings } from "../../proxy/state.ts";
import type { Session } from "../../schema/index.ts";
import { positiveInt, UsageError } from "../args.ts";
import { list, oneLine, str } from "../common.ts";
import { clean, CliError, duration, plural, usd, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";

const MAX_TRIALS = 10;

/** The change the flags ask for: --harness first, then --with, --model and --system on top. */
export async function changeFromFlags(c: CommandContext, ctx: Context): Promise<HarnessChange> {
  const change = emptyChange();
  const ref = str(c.flags.harness);
  if (ref) {
    const bundle = await ctx.index.getBundle(ref);
    if (!bundle) throw new CliError(`Can't find harness bundle ${JSON.stringify(ref)}`, { reason: "not_found", next: ["List bundles:", "coding.sh harness list"] });
    await bundleChange(bundle, ctx.blobs, change);
  }
  const read = (p: string) => {
    try {
      return readFileSync(resolve(c.cwd, p), "utf8");
    } catch {
      throw new UsageError(`--with: can't read ${p}`, { reason: "not_found" });
    }
  };
  parseWith(list(c.flags.with), read, change);
  const model = str(c.flags.model);
  if (model) change.set.model = model;
  const system = str(c.flags.system);
  if (system !== undefined) change.set.system = system.startsWith("@") ? read(system.slice(1)) : system;
  return change;
}

export async function fork(c: CommandContext, ctx: Context, s: Session, replay: Replay, n: number): Promise<number> {
  const { out } = c;
  const trials = positiveInt(c.flags.trials, "trials") ?? 1;
  if (trials > MAX_TRIALS) throw new UsageError(`--trials is at most ${MAX_TRIALS}`);
  const runIt = c.flags.run === true;
  const verify = str(c.flags.verify);
  if (verify && !runIt) throw new UsageError("--verify goes with --run");
  const suite = str(c.flags["save-case"]);
  if (suite !== undefined && !/^[\w][\w.-]*$/.test(suite)) throw new UsageError(`--save-case ${JSON.stringify(suite)}: a suite name is letters, digits, dots, dashes and underscores`);
  const change = await changeFromFlags(c, ctx);
  const settings = proxySettings(c.env);
  const prices = pricesFor(ctx.config.pricing);
  const base = { index: ctx.index, blobs: ctx.blobs, sessionId: s.id, ...(s.cwd ? { cwd: s.cwd } : {}), steps: replay.steps, step: n, change };
  let prepared;
  try {
    prepared = await prepareFork(base);
  } catch (e) {
    if (e instanceof ForkError) throw new CliError(e.message, { reason: e.reason, next: e.reason === "no_calls" ? ["Capture through the proxy:", "coding.sh init --proxy"] : [] });
    throw e;
  }
  const { point, rc, edits } = prepared;
  if (!hasReplayAuth(rc.provider, c.env)) {
    const key = REPLAY_KEY_ENV[rc.provider];
    throw new CliError(`--fork calls the ${rc.provider === "anthropic" ? "Anthropic" : "OpenAI"} API, and $${key} is not set`, {
      reason: "missing_api_key",
      next: [`export ${key}=…${rc.provider === "anthropic" ? `   (or a subscription token in $${REPLAY_OAUTH_ENV})` : ""}`],
    });
  }
  for (const e of edits) if (e.how === "absent") out.warn(`${e.path}: not in the stored request, so the fork goes without it already`);

  let result: ForkResult | undefined;
  let run: ForkRunResult | undefined;
  if (runIt) {
    const body = rc.call.request!.body;
    const prompt = firstPrompt(rc.api, body);
    if (!prompt) throw new CliError("The stored request has no prompt to start the agent with", { reason: "no_prompt" });
    const messages = body[rc.api === "responses" ? "input" : "messages"];
    const model = typeof change.set.model === "string" ? change.set.model : typeof body.model === "string" ? body.model : undefined;
    const workdir = str(c.flags.workdir);
    const spin = out.spin(`forking at step ${n}: Claude Code is running…`);
    try {
      run = await runFork({ config: ctx.config, index: ctx.index, blobs: ctx.blobs, env: c.env, session: s, replay, step: n, change, stored: Array.isArray(messages) ? messages : [], prompt, ...(model ? { model } : {}), upstreams: settings.upstreams, ...(workdir ? { base: resolve(c.cwd, workdir) } : {}), ...(verify ? { verify } : {}), signal: c.signal });
    } catch (e) {
      if (e instanceof ForkError) throw new CliError(e.message, { reason: e.reason });
      throw e;
    } finally {
      spin.stop();
    }
    await ctx.ingest().catch(() => undefined);
  } else {
    const spin = out.spin(`forking at step ${n}: ${plural(trials, "call")}…`);
    try {
      result = await forkStep({ ...base, trials, upstreams: settings.upstreams, env: c.env, prices, signal: c.signal });
    } finally {
      spin.stop();
    }
  }

  let saved: { suite: string; dir: string; caseId: string; created: boolean } | undefined;
  if (suite !== undefined) {
    const expected = caseExpectation(rc.recorded, result);
    if (!expected) throw new CliError(`Step ${n}'s recorded reply was text, and the fork gave no single tool call to expect instead, so the case would have nothing to check`, { reason: "nothing_to_check", next: ["Fork with a few trials first:", `coding.sh replay ${s.id.slice(0, 8)} --step ${n} --fork -k 3 --save-case ${suite}`] });
    const root = (await repoRoot(c.cwd)) ?? c.cwd;
    const dir = join(root, SUITES_DIR, suite);
    const caseId = `fork-${s.id.slice(0, 8)}-step${n}`;
    const original = point.call.request!;
    const contextFiles = [...new Set([...change.files.map((f) => f.path).filter((p) => !p.startsWith("~/")), ...requestContextFiles(rc.api, original.body, s.cwd)])].sort();
    const metadata: Record<string, unknown> = { session: s.id, step: n, call: point.call.event.id, label: point.step.label, change: result?.change ?? "" };
    if (rc.recorded) metadata.recorded = rc.recorded;
    if (result) metadata.forked = result.trials.map((t) => t.label);
    if (run) metadata.forked = run.actions.slice(0, 5).map((a) => a.label);
    const r = await saveForkCase({ dir, suite, caseId, request: { ...original, ...(s.cwd ? { cwd: s.cwd } : {}) }, expected, contextFiles, metadata });
    saved = { suite, dir, caseId, created: r.created };
  }

  if (out.json) {
    out.data({ ...(result ?? { sessionId: s.id, step: { n, kind: point.step.kind, label: point.step.label }, call: { id: point.call.event.id, by: point.by }, edits, ...(rc.recorded ? { recorded: { action: rc.recorded } } : {}) }), ...(run ? { run } : {}), ...(saved ? { savedCase: saved } : {}) });
    return run?.verify && !run.verify.ok ? 1 : 0;
  }
  const e = point.call.event;
  out.print(out.style(`Fork of ${oneLine(clean(s.title ?? s.id), 60)} at step ${n} of ${replay.steps.length}`, "bold"));
  const model = typeof rc.call.request?.body.model === "string" ? rc.call.request.body.model : e.model;
  out.print(out.style(`call ${e.id.slice(0, 12)}${model ? ` · ${model}` : ""}${typeof e.payload.messageCount === "number" ? ` · ${plural(e.payload.messageCount, "message")}` : ""} · ${point.by === "tool-use" ? "made the step's tool call" : "the agent's last call before the step"}`, "faint"));
  const changed = edits.filter((x) => x.how !== "absent").map((x) => `${x.path} ${x.how}`);
  for (const [k, v] of Object.entries(change.set)) changed.push(k === "system" ? "system prompt replaced" : `${k}=${String(v)}`);
  out.print(out.style(`harness: ${changed.join(", ") || "as recorded"}`, "faint"));
  out.print();
  if (result) printTrials(out, result);
  if (run) printRun(out, replay, n, run);
  if (saved) {
    out.print();
    out.print(`Saved case ${saved.caseId} in ${saved.dir}${saved.created ? " (new suite)" : ""}`);
    out.print(out.style("Its request file holds the conversation up to this step, redacted as stored. Read it before you commit it.", "faint"));
    out.next("Run it", `coding.sh eval run ${saved.suite}`);
  } else if (result && result.differ) out.next("Keep this step as a regression case", `coding.sh replay ${s.id.slice(0, 8)} --step ${n} --fork ${forkFlags(c)}--save-case forks`);
  return run?.verify && !run.verify.ok ? 1 : 0;
}

function forkFlags(c: CommandContext): string {
  const parts = list(c.flags.with).map((w) => `--with ${w} `);
  const h = str(c.flags.harness);
  if (h) parts.push(`--harness ${h} `);
  const m = str(c.flags.model);
  if (m) parts.push(`--model ${m} `);
  return parts.join("");
}

function printTrials(out: Output, r: ForkResult): void {
  const w = 10;
  out.print(`${"recorded".padEnd(w)}${r.recorded ? clean(r.recorded.label) : out.style("no recorded reply", "faint")}`);
  r.trials.forEach((t, i) => {
    const head = (r.trials.length > 1 ? `forked ${i + 1}` : "forked").padEnd(w);
    if (t.error) return out.print(`${head}${out.style(`error: ${oneLine(t.error, 100)}`, "red")}`);
    const mark = t.differs === true ? out.style("  different", "yellow") : t.differs === false ? out.style("  same", "faint") : "";
    out.print(`${head}${clean(t.label)}${mark}${t.costUsd !== undefined ? out.style(`  ${usd(t.costUsd)}`, "faint") : ""}`);
  });
  const ok = r.trials.filter((t) => !t.error).length;
  if (r.recorded && ok) {
    out.print();
    out.print(r.differ ? `${r.differ} of ${plural(ok, "forked call")} took another action than the recorded one.` : `Every forked call took the recorded action.`);
  }
}

function printRun(out: Output, replay: Replay, n: number, r: ForkRunResult): void {
  const rows = Math.max(Math.min(replay.steps.length - n + 1, 12), Math.min(r.actions.length, 12));
  const w = 52;
  out.print(`${`recorded, from step ${n}`.padEnd(w + 6)}forked`);
  for (let i = 0; i < rows; i++) {
    const st = replay.steps[n - 1 + i];
    const left = st ? `${String(st.n).padStart(4)} ${st.ok === false ? "✗" : st.ok === true ? "✓" : " "} ${oneLine(clean(st.label), w - 8)}` : "";
    const a = r.actions[i];
    const right = a ? `${a.ok === false ? "✗" : a.ok === true ? "✓" : " "} ${oneLine(clean(a.label), 70)}` : "";
    out.print(`${left.padEnd(w + 6)}${right}`);
  }
  const more = r.actions.length - rows;
  if (more > 0) out.print(out.style(`${"".padEnd(w + 6)}… ${plural(more, "more action")}`, "faint"));
  out.print();
  const ws = r.workspace;
  out.print(`Claude Code ${r.timedOut ? "timed out" : r.exitCode === 0 ? "finished" : `exited ${r.exitCode}`} in ${duration(r.durationMs)}${r.costUsd !== undefined ? `, ${usd(r.costUsd)}` : ""}; ${plural(r.spliced, "request")} carried the session's history up to step ${n}.`);
  if (r.result) out.print(out.style(oneLine(clean(r.result), 160), "faint"));
  if (ws.restored.length) out.print(out.style(`Put back as before step ${n}: ${ws.restored.join(", ")}`, "faint"));
  if (ws.unknown.length) out.print(out.style(`Left as they are now (content before step ${n} unknown): ${ws.unknown.join(", ")}`, "yellow"));
  out.print(`Fork directory: ${ws.cwd}`);
  if (r.verify) {
    out.print(r.verify.ok ? out.style(`✓ ${r.verify.command} passed`, "green") : out.style(`✗ ${r.verify.command} failed (exit ${r.verify.exitCode ?? "?"})`, "red"));
    if (!r.verify.ok && r.verify.output.trim()) for (const l of clean(r.verify.output).trimEnd().split("\n").slice(-12)) out.print(`  ${l}`);
  }
  if (r.sessionId) out.next("Replay the fork", `coding.sh replay ${r.sessionId.slice(0, 8)}`);
}
