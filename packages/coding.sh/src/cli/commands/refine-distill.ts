// coding.sh refine distill (AD-3): write the run corpus (src/refine/corpus.ts)
// of an experiment or of this repo's recent sessions, hand it to a coding agent
// that analyzes it with its own code and writes one skill (src/refine/distill.ts),
// then check the skill with the critics and ledger it as a proposed candidate.
// Nothing is applied: `refine test <id>` decides.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAdapter } from "../../adapters/index.ts";
import { corpusDirEntries, writeCorpusDir, type CorpusSource } from "../../refine/corpus.ts";
import { distill, ledgerDraws, preflight, MIN_EPISODES, MIN_FAILURES } from "../../refine/distill.ts";
import { ledgerFile, refineDir } from "../../refine/ledger.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { list, num, requireConsent, str, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { gitRoot, harnessFilesIn, money } from "./exp-ab.ts";

const DISTILLERS = ["claude-code", "codex"] as const;

function count(v: unknown, name: string, dflt: number): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} takes a whole number of at least 0, got ${JSON.stringify(v)}`, { reason: "invalid_argument" });
  return n;
}

export async function refineDistill(c: CommandContext): Promise<number> {
  const { out } = c;
  const root = gitRoot(c.cwd) ?? c.cwd;
  const dir = refineDir(c.env, root);
  const experiment = str(c.flags.experiment);
  const repoFlag = str(c.flags.repo);
  const repo = repoFlag === "all" ? undefined : repoFlag ? resolve(c.cwd, repoFlag) : root;
  const agents = list(c.flags.agent);
  const since = parseSince(str(c.flags.since) ?? "30d");
  const distiller = str(c.flags.distiller) ?? "claude-code";
  if (!(DISTILLERS as readonly string[]).includes(distiller)) throw new UsageError(`--distiller must be one of ${DISTILLERS.join(", ")}`, { reason: "invalid_argument" });
  const model = str(c.flags.model);
  const n = positiveInt(c.flags.n, "n") ?? 1;
  const maxCost = num(c.flags["max-cost"]) ?? 5;
  if (!(maxCost >= 0)) throw new UsageError("--max-cost must be a dollar amount of at least 0", { reason: "invalid_argument" });
  const min = { episodes: count(c.flags["min-episodes"], "min-episodes", MIN_EPISODES), failures: count(c.flags["min-failures"], "min-failures", MIN_FAILURES) };
  const keep = str(c.flags["keep-corpus"]);
  const dryRun = c.flags["dry-run"] === true;
  return withContext(c, async (ctx) => {
    let source: CorpusSource;
    let skillsDir = agents.length && agents.every((a) => a === "codex") ? ".agents/skills" : ".claude/skills";
    if (experiment) {
      const runs = await ctx.index.listRuns({ experimentId: experiment });
      if (!runs.length) throw new CliError(`No runs in experiment ${experiment}`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });
      const b = await ctx.index.getBundle(runs[0]!.bundleId);
      if (b?.agent === "codex") skillsDir = ".agents/skills";
      source = { kind: "experiment", experimentId: experiment };
    } else source = { kind: "sessions", since, ...(repo ? { repo } : {}), ...(agents.length ? { agents } : {}) };
    const work = mkdtempSync(join(tmpdir(), "csh-distill-"));
    try {
      const keepDir = keep ? resolve(c.cwd, keep) : undefined;
      // A dry run writes nothing under --keep-corpus: it checks the directory as a real run would, then builds the corpus in the temp dir.
      if (keepDir && dryRun) corpusDirEntries(keepDir);
      const corpusDir = keepDir && !dryRun ? keepDir : join(work, "corpus");
      const prompt = harnessFilesIn(root);
      const corpus = await writeCorpusDir({ index: ctx.index, source, dir: corpusDir, prompt });
      const refusal = preflight(corpus, min);
      const sourceLabel = experiment ?? "sessions";
      const summary = { source: sourceLabel, episodes: corpus.episodes, failures: corpus.failures, passRate: corpus.passRate, leftOut: corpus.leftOut, skipped: corpus.skipped, truncated: corpus.truncated, ...(keepDir ? { dir: keepDir } : {}) };
      const rate = corpus.passRate === null ? "no verifier (captured sessions)" : `pass rate ${Math.round(corpus.passRate * 100)}%`;
      const corpusLine = `Corpus: ${plural(corpus.episodes, "episode")} from ${experiment ? `experiment ${experiment}` : "captured sessions"}, ${corpus.failures} failing or flagged, ${rate}${corpus.leftOut.runs ? `; left out ${plural(corpus.leftOut.runs, "run")} of held-out tasks ${corpus.leftOut.tasks.join(", ")}` : ""}`;
      if (dryRun) {
        if (out.json) {
          out.data({ dryRun: true, corpus: summary, distiller, model: model ?? null, n, maxCostUsd: maxCost, skillsDir, ...(refusal ? { refusal } : {}) });
          return 0;
        }
        out.print(corpusLine);
        out.print(refusal ? `Would refuse: ${refusal}` : `Would start ${plural(n, `${distiller} session`)} (up to ${money(maxCost)}), each writing one skill under ${skillsDir}/; $0 so far`);
        return 0;
      }
      if (refusal) {
        throw new CliError(`Not enough to distill from: ${refusal}`, {
          reason: "insufficient_data",
          next: experiment ? ["Run more tasks, or lower the bar:", `coding.sh refine distill --experiment ${experiment} --min-episodes ${corpus.episodes} --min-failures ${corpus.failures}`] : ["Look further back, or in every repo:", "coding.sh refine distill --since 90d --repo all"],
        });
      }
      const adapter = getAdapter(distiller);
      if (!adapter?.run) throw new CliError(`Agent ${distiller} has no headless driver here`, { reason: "unsupported_agent" });
      await requireConsent(c, `Start ${plural(n, `${distiller} session`)} on ${plural(corpus.episodes, "episode")} (up to ${money(maxCost)})?`, `coding.sh refine distill${experiment ? ` --experiment ${experiment}` : ""}${n > 1 ? ` --n ${n}` : ""} --yes`);
      const spin = out.spin(`Distilling from ${plural(corpus.episodes, "episode")}…`);
      const r = await distill({ corpusDir, adapter, ...(model ? { model } : {}), n, maxCostUsd: maxCost, workRoot: join(work, "draws"), base: prompt, skillsDir, ...(c.signal ? { signal: c.signal } : {}) }).finally(() => spin.stop());
      const entries = ledgerDraws(dir, r.draws, { corpus, source: sourceLabel, distiller, ...(model ? { model } : {}) });
      const proposed = entries.filter((e) => e.verdict === "proposed");
      if (out.json) {
        out.data({
          ledger: ledgerFile(dir),
          corpus: summary,
          draws: r.draws.map((d) => {
            const e = entries.find((x) => x.provenance.draw === d.draw);
            return { draw: d.draw, ...(d.error ? { error: d.error } : {}), ...(e ? { id: e.id, path: e.files[0]!.path, verdict: e.verdict, reasons: e.reasons } : {}), ...(d.costUsd !== undefined ? { costUsd: d.costUsd } : {}), durationMs: d.durationMs };
          }),
          spentUsd: r.spentUsd,
          ...(r.stopped ? { stopped: r.stopped } : {}),
        });
      } else {
        out.print(corpusLine);
        for (const d of r.draws) {
          const e = entries.find((x) => x.provenance.draw === d.draw);
          if (!e) out.warn(`Draw ${d.draw}: ${d.error}`);
          else if (e.verdict === "proposed") out.ok(`Draw ${d.draw}: ${e.id} ${e.files[0]!.path}`);
          else out.fail(`Draw ${d.draw}: ${e.id} rejected: ${e.reasons.join("; ")}`);
        }
        if (r.stopped) out.warn(r.stopped === "budget" ? `Stopped at --max-cost ${money(maxCost)}` : "Interrupted");
        out.note(`Spent ${money(r.spentUsd)} on ${plural(r.draws.length, "distiller session")}`);
        if (proposed.length) out.next("Test the skill against your current files before anything is applied", `coding.sh refine test ${proposed[0]!.id} --suite <name>`);
      }
      return proposed.length ? 0 : 1;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}
