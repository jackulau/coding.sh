// coding.sh eval trigger <skill> --draft: write triggers.toml next to the skill
// from its SKILL.md, its sibling skills and the prompts of captured sessions that
// loaded it or a sibling (eval/trigger-draft.ts).
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { repoRoot } from "../../core/git.ts";
import { createRedactor } from "../../core/redact.ts";
import { DraftError } from "../../eval/draft.ts";
import { siblingSkills, type SkillSource } from "../../eval/trigger.ts";
import { ALL_REPOS, DRAFT_N, draftTriggerSpec, MINE_SINCE_MS, mineTriggerPrompts, renderTriggerToml, skillCard, type MinedPrompts } from "../../eval/trigger-draft.ts";
import { FileJudgeCache } from "../../judge/cache.ts";
import { parseAge, positiveInt, UsageError } from "../args.ts";
import { autoIngest, str, withContext } from "../common.ts";
import { version } from "../meta.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { draftProvider } from "./eval-init.ts";

export async function evalTriggerDraft(c: CommandContext, current: SkillSource, target: string): Promise<number> {
  const { out, flags } = c;
  const file = resolve(c.cwd, str(flags.spec) ?? join(current.dir, "triggers.toml"));
  const dryRun = flags["dry-run"] === true;
  if (existsSync(file) && flags.force !== true && !dryRun) {
    throw new UsageError(`${relative(c.cwd, file) || file} exists; pass --force to replace it, or --dry-run to print a draft`, { reason: "exists", askUser: true, suggestion: `coding.sh eval trigger ${target} --draft --dry-run` });
  }
  const n = positiveInt(flags.n, "n") ?? DRAFT_N;
  const since = str(flags.since) ? parseAge(str(flags.since)!, "since") : MINE_SINCE_MS;
  const traces = flags["no-traces"] !== true;
  // The draft is committed with the skill: prompts come from this repo's sessions unless --repo widens it.
  const repoFlag = str(flags.repo);
  const repo = repoFlag === ALL_REPOS ? ALL_REPOS : repoFlag ? resolve(c.cwd, repoFlag) : ((await repoRoot(c.cwd)) ?? c.cwd);
  const provider = await draftProvider(c);
  if (!provider) throw new UsageError("--draft needs a model", { reason: "missing_argument" });

  const siblingsFlag = str(flags.siblings);
  const siblings = flags["no-siblings"] === true ? [] : (await siblingSkills(siblingsFlag ? resolve(c.cwd, siblingsFlag) : dirname(current.dir), [current.dir])).filter((s) => s.name !== current.name);
  const card = await skillCard(current);

  const run = async (mined: MinedPrompts) => {
    let d;
    try {
      d = await draftTriggerSpec(card, siblings, mined, { n, provider, cache: FileJudgeCache.forEnv(c.env) });
    } catch (e) {
      if (e instanceof DraftError) throw new CliError(`Couldn't draft trigger prompts: ${e.message}`, { reason: "draft_failed", next: ["Retry, or write triggers.toml by hand:", `coding.sh eval trigger ${target} --help`] });
      throw e;
    }
    const toml = renderTriggerToml(d, { version: version(), date: new Date().toISOString().slice(0, 10) });
    const traced = [...d.should, ...d.shouldNot].filter((p) => p.source.startsWith("trace:")).length;
    if (!dryRun) await writeFile(file, toml);
    if (out.json) {
      const data: Record<string, unknown> = { outcome: dryRun ? "dry_run" : "written", file, skill: d.skill, should: d.should, shouldNot: d.shouldNot, traced, sessions: mined.sessions, calls: d.calls, warnings: d.warnings };
      // The directory the sessions were read from, or "all". With --no-traces none were read.
      if (traces) data.repo = repo;
      out.data(data);
      return 0;
    }
    if (dryRun) out.print(toml.trimEnd());
    for (const w of d.warnings) out.warn(w);
    if (!traces) out.note("Drafted from SKILL.md only (--no-traces)");
    else if (!traced) out.note(`No captured session ${repo === ALL_REPOS ? "" : `${repoFlag ? `under ${repo}` : "in this repo"} `}in the last ${Math.round(since / 86_400_000)} days loaded ${current.name} or a sibling skill, so every prompt is model-drafted${repo === ALL_REPOS ? "" : " (--repo all reads every repo's sessions)"}`);
    if (dryRun) return 0;
    out.ok(`Wrote ${relative(c.cwd, file) || file}: ${d.should.length} should and ${d.shouldNot.length} should_not prompts, ${traced} from captured sessions`);
    out.next("Read and fix the prompts, then run them", `coding.sh eval trigger ${target} -k 3`);
    return 0;
  };

  if (!traces) return run({ should: [], shouldNot: [], sessions: 0 });
  return withContext(c, async (ctx) => {
    await autoIngest(ctx);
    const cfg = ctx.config.capture;
    const redactor = createRedactor({ redact: cfg.redact, patterns: cfg.redactPatterns, env: c.env });
    return run(await mineTriggerPrompts(ctx.index, { skill: current.name, siblings: siblings.map((s) => s.name), repo, since, redactor }));
  });
}
