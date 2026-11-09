// coding.sh eval trigger <skill>: does the agent load the skill when it should
// and leave it alone when it shouldn't? Runs the prompts of triggers.toml through
// the agent headless (src/eval/trigger.ts) and reports trigger precision and
// recall; with --candidate or --description, a paired A/B of two descriptions.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAdapter } from "../../adapters/index.ts";
import { sortableId } from "../../core/ids.ts";
import { paths } from "../../core/paths.ts";
import { snapshotDir } from "../../core/snapshot.ts";
import type { AgentId, HarnessBundle } from "../../core/types.ts";
import { readInstructionArg } from "../../eval/task.ts";
import {
  defaultProbe,
  formatTrigger,
  parseTriggerSpec,
  probeBundle,
  readSkill,
  runTriggerEval,
  scoreTrigger,
  siblingSkills,
  skillsDirOf,
  TriggerSpecError,
  withDescription,
  type SkillSource,
  type TriggerArm,
  type TriggerObservation,
  type TriggerReport,
  type TriggerSpec,
} from "../../eval/trigger.ts";
import { positiveInt, UsageError } from "../args.ts";
import { requireConsent, str, withContext } from "../common.ts";
import { ensureHookBin } from "../hookbin.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

const SPEC_EXAMPLE = 'skill = "pdf"\n\n[[should]]\nprompt = "Fill in the form fields of invoice.pdf"\n\n[[should_not]]\nprompt = "Rename every .txt file to .md"';

/** What a trigger run hands `eval run` (which prints its own report instead). */
export interface TriggerRunResult {
  spec: TriggerSpec;
  skill: string;
  report: TriggerReport;
  observations: TriggerObservation[];
  experimentId: string;
  file: string;
}

export async function evalTrigger(c: CommandContext, hooks: { onResult?: (r: TriggerRunResult) => void } = {}): Promise<number> {
  const { out } = c;
  const target = c.positionals[0];
  if (!target) throw new UsageError("Missing argument <SKILL>. Usage: coding.sh eval trigger <skill-dir|SKILL.md>", { reason: "missing_argument" });
  const current = await readSkill(resolve(c.cwd, target)).catch((e: Error) => {
    throw new CliError(e.message, { reason: "not_found" });
  });
  if (c.flags.draft !== undefined) return (await import("./eval-trigger-draft.ts")).evalTriggerDraft(c, current, target);
  const specPath = resolve(c.cwd, str(c.flags.spec) ?? join(current.dir, "triggers.toml"));
  const specText = await readFile(specPath, "utf8").catch(() => undefined);
  if (specText === undefined) {
    throw new UsageError(`No trigger spec at ${specPath}. Write one with should and should_not prompts:\n${SPEC_EXAMPLE}`, { reason: "missing_argument", suggestion: `coding.sh eval trigger ${target} --spec <FILE>` });
  }
  let spec;
  try {
    spec = parseTriggerSpec(specText, specPath);
  } catch (e) {
    if (e instanceof TriggerSpecError) throw new UsageError(e.message, { reason: "invalid_file" });
    throw e;
  }
  const skill = spec.skill ?? current.name;

  // The second arm: another skill dir, or this one with a new description.
  const candidateDir = str(c.flags.candidate);
  const descriptionArg = str(c.flags.description);
  if (candidateDir && descriptionArg) throw new UsageError("Pass --candidate or --description, not both", { reason: "invalid_argument" });
  let candidate: SkillSource | undefined;
  let candidateLabel = "";
  if (candidateDir) {
    candidate = await readSkill(resolve(c.cwd, candidateDir)).catch((e: Error) => {
      throw new CliError(`--candidate: ${e.message}`, { reason: "not_found" });
    });
    candidateLabel = `candidate ${candidateDir}`;
  } else if (descriptionArg !== undefined) {
    const text = await readInstructionArg(descriptionArg, c.cwd).catch((e: Error) => {
      throw new UsageError(`--description: ${e.message}`, { reason: "invalid_argument" });
    });
    let md: string;
    try {
      md = withDescription(await readFile(join(current.dir, "SKILL.md"), "utf8"), text);
    } catch (e) {
      throw new UsageError(`--description: ${(e as Error).message}`, { reason: "invalid_file" });
    }
    candidate = { ...current, description: text, override: { "SKILL.md": md } };
    candidateLabel = "--description";
  }
  if (c.flags["fail-on"] !== undefined && !candidate) throw new UsageError("--fail-on regression needs a second arm: --candidate or --description", { reason: "invalid_argument" });
  const minF1 = c.flags["min-f1"];
  if (minF1 !== undefined && (typeof minF1 !== "number" || !(minF1 >= 0 && minF1 <= 1))) throw new UsageError("--min-f1 must be a number from 0 to 1", { reason: "invalid_argument" });

  // Siblings compete for the same prompts and go into every arm.
  const siblingsFlag = str(c.flags.siblings);
  if (siblingsFlag && c.flags["no-siblings"] === true) throw new UsageError("Pass --siblings or --no-siblings, not both", { reason: "invalid_argument" });
  const own = [current.dir, ...(candidate ? [candidate.dir] : [])];
  const siblings = c.flags["no-siblings"] === true ? [] : (await siblingSkills(siblingsFlag ? resolve(c.cwd, siblingsFlag) : dirname(current.dir), own)).filter((s) => s.name !== skill && s.name !== current.name);
  for (const p of spec.shouldNot) if (p.expectSkill && !siblings.some((s) => s.name === p.expectSkill)) out.warn(`expect_skill ${p.expectSkill} is not among the sibling skills, so that route can't be taken`);

  const k = positiveInt(c.flags.k, "k") ?? spec.k;
  const concurrency = positiveInt(c.flags.concurrency, "concurrency") ?? 4;
  const seed = positiveInt(c.flags.seed, "seed") ?? 1;
  const timeoutS = positiveInt(c.flags.timeout, "timeout") ?? spec.timeoutS;
  const harnessRef = str(c.flags.harness);
  const agentFlag = str(c.flags.agent);

  return withContext(c, async (ctx) => {
    let base: HarnessBundle | undefined;
    if (harnessRef) {
      base = await ctx.index.getBundle(harnessRef);
      if (!base) throw new CliError(`Can't find harness bundle ${JSON.stringify(harnessRef)}`, { reason: "not_found", next: ["List bundles:", "coding.sh harness list"] });
      if (agentFlag && agentFlag !== base.agent) throw new UsageError(`--agent ${agentFlag} differs from bundle ${base.name}'s agent ${base.agent}`, { reason: "invalid_argument" });
    }
    const agent = (base?.agent ?? agentFlag ?? "claude-code") as AgentId;
    const adapter = getAdapter(agent);
    if (!adapter) throw new UsageError(`Unknown agent ${JSON.stringify(agent)}`, { reason: "invalid_argument" });
    if (!adapter.run) throw new CliError(`Agent ${agent} has no headless driver, so it can't run trigger probes`, { reason: "unsupported_agent" });
    const model = str(c.flags.model);
    const installed = (s: SkillSource): SkillSource => ({ ...s, name: skill });
    const make = (name: string, s: SkillSource) => probeBundle({ name, agent, ...(model ? { model } : {}), ...(base ? { base } : {}), skills: [installed(s), ...siblings], blobs: ctx.blobs });
    const arms: TriggerArm[] = [{ label: "current", bundle: await make(`trigger-${skill}-current`, current) }];
    if (candidate) arms.push({ label: candidateLabel, bundle: await make(`trigger-${skill}-candidate`, candidate) });
    if (arms.length === 2 && arms[0]!.bundle.id === arms[1]!.bundle.id) throw new UsageError("The candidate installs the same files as the current skill; change its description or files", { reason: "invalid_argument" });

    const prompts = spec.should.length + spec.shouldNot.length;
    const runs = arms.length * prompts * k;
    const armText = arms.length === 2 ? "2 arms" : "1 arm";
    await requireConsent(c, `Run ${plural(runs, "agent session")} (${armText} x ${plural(prompts, "prompt")} x ${k})?`, `coding.sh eval trigger ${target} --yes`);
    if (!out.json) {
      out.note(`${skill} in ${skillsDirOf(agent)}/${skill}/ on ${agent}${siblings.length ? ` with ${plural(siblings.length, "sibling skill")} (${siblings.map((s) => s.name).join(", ")})` : ", no sibling skills"}`);
    }
    if ((await ensureHookBin(c.env)) === "unavailable") out.warn("The coding.sh hook bin is missing and can't be written, so probes fall back to the agent's stdout. Run `coding.sh init` first.");

    // Every probe starts from the same empty tree.
    const empty = join(paths(c.env).repos, "empty-start");
    await mkdir(empty, { recursive: true });
    const start = await snapshotDir(empty, c.env);
    const experimentId = sortableId("trg_");
    const spin = out.spin(`Probing 0/${runs}…`);
    const r = await runTriggerEval({
      spec,
      skill,
      arms,
      k,
      concurrency,
      seed,
      signal: c.drain ?? c.signal,
      runProbe: defaultProbe({ adapterFor: () => adapter, blobs: ctx.blobs, index: ctx.index, start, skill, timeoutMs: timeoutS * 1000, experimentId, ingest: () => ctx.ingest(), signal: c.signal }),
      onProgress: (done, total) => spin.update(`Probing ${done}/${total}…`),
    }).finally(() => spin.stop());
    if (r.cancelled) {
      if (out.json) out.data({ outcome: "cancelled", finished: r.observations.length, total: r.total });
      else out.warn(`Cancelled after ${r.observations.length}/${r.total} probes; no result.`);
      return 1;
    }
    const report = scoreTrigger({ spec, skill, agent, arms, observations: r.observations, k, seed });
    const file = join(paths(c.env).root, "triggers", skill.replace(/[^A-Za-z0-9._-]+/g, "-"), `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ spec: specPath, experimentId, siblings: siblings.map((s) => s.name), ...report }, null, 2)}\n`);

    if (hooks.onResult) {
      hooks.onResult({ spec, skill, report, observations: r.observations, experimentId, file });
      return 0;
    }
    const tested = report.arms[report.arms.length - 1]!;
    const f1Miss = typeof minF1 === "number" && !(tested.metrics.f1 >= minF1);
    const regressed = c.flags["fail-on"] === "regression" && report.delta?.regression === true;
    if (out.json) out.data({ outcome: f1Miss || regressed ? "failed" : "ok", file, experimentId, report });
    else {
      out.print(formatTrigger(report));
      out.print(file);
    }
    if (f1Miss) out.fail(`F1 ${Number.isFinite(tested.metrics.f1) ? tested.metrics.f1.toFixed(2) : "—"} is under --min-f1 ${minF1}`);
    if (regressed) out.fail("B answers fewer prompts right than A (the 95% CI is below 0)");
    return f1Miss || regressed ? 1 : 0;
  });
}
