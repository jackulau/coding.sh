// coding.sh eval init [name]: scaffold an eval suite in evals/<name>/ (see
// eval/init.ts). Flags pick the source; on a terminal with no source flag it
// asks. Ends with the command that runs the suite and, where the suite can run
// on a fresh checkout, a CI workflow.
import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { repoRoot } from "../../core/git.ts";
import { providerFromSpec, type LlmProviderSpec } from "../../graders/index.ts";
import { DEFAULT_SINCE_MS, initSuite, InitError, type InitOpts, type InitResult, type InitSource } from "../../eval/init.ts";
import { DraftError } from "../../eval/draft.ts";
import type { SuitePurpose } from "../../eval/report.ts";
import { parseAge, positiveInt, UsageError } from "../args.ts";
import { autoIngest, jsonArg, list, resolveSession, str, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { readFile } from "node:fs/promises";

const SOURCES_HELP = [
  "coding.sh eval init --sessions                                  # tasks from failed or flagged sessions in this repo",
  "coding.sh eval init --skill .claude/skills/<name>               # should / should-not prompts for a skill",
  "coding.sh eval init --cases cases.jsonl --command 'node app.mjs' # cases for an app or prompt",
  "coding.sh eval init --describe 'what the app does' --command 'node app.mjs' --draft",
];

/** --describe: inline text or @FILE. */
async function textArg(v: string | undefined, flag: string): Promise<string | undefined> {
  if (v === undefined || !v.startsWith("@")) return v;
  try {
    return await readFile(v.slice(1), "utf8");
  } catch {
    throw new UsageError(`--${flag}: can't read ${v.slice(1)}`, { reason: "not_found" });
  }
}

/** --draft [PROVIDER|JSON]: the model that writes draft prompts or cases. */
async function draftProvider(c: CommandContext) {
  const v = c.flags.draft;
  if (v === undefined || v === false) return undefined;
  const raw = typeof v === "string" && v ? v : "anthropic";
  const spec = (raw.trim().startsWith("{") || raw.endsWith(".json") ? await jsonArg(raw, "--draft") : { provider: raw }) as LlmProviderSpec;
  const model = str(c.flags["draft-model"]);
  try {
    return providerFromSpec({ ...spec, ...(model ? { model } : {}) }, { env: c.env });
  } catch (e) {
    throw new UsageError(`Invalid --draft: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_value" });
  }
}

function sourceFromFlags(c: CommandContext): InitSource | undefined {
  const f = c.flags;
  const picked = [
    f.sessions === true || list(f.session).length ? ("sessions" as const) : undefined,
    str(f.skill) ? ("skill" as const) : undefined,
    str(f.cases) || str(f.describe) || str(f.command) || str(f.url) ? ("cases" as const) : undefined,
  ].filter((x): x is InitSource => !!x);
  if (picked.length > 1) throw new UsageError(`Pick one source: ${picked.map((p) => (p === "sessions" ? "--sessions" : p === "skill" ? "--skill" : "--cases/--describe")).join(" or ")}`, { reason: "invalid_argument" });
  return picked[0];
}

/** The skill dirs a project has, for the interactive prompt. */
function projectSkills(root: string): string[] {
  const out: string[] = [];
  for (const base of [".claude/skills", ".agents/skills", "skills"]) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) if (existsSync(join(dir, d, "SKILL.md"))) out.push(`${base}/${d}`);
  }
  return out;
}

/** Interactive: ask for what the flags didn't say. */
async function askSource(c: CommandContext, root: string, o: Partial<InitOpts>): Promise<Partial<InitOpts>> {
  const { out } = c;
  out.note("What do you want to evaluate?");
  out.note("  1  my agent, on tasks from sessions that failed in this repo");
  out.note("  2  a skill: does the agent load it when it should, and only then");
  out.note("  3  an app or prompt: inputs, expected answers, a command that answers them");
  const pick = await out.ask("1, 2 or 3?", { default: "1" });
  if (pick === "2") {
    const skills = projectSkills(root);
    if (skills.length) out.note(`Skills here: ${skills.join(", ")}`);
    const skill = await out.ask("Skill dir?", skills[0] ? { default: skills[0] } : {});
    if (!skill) throw new UsageError("A skill suite needs the skill dir", { reason: "missing_argument" });
    return { ...o, source: "skill", skill };
  }
  if (pick === "3") {
    const casesFile = await out.ask("Cases file (JSONL of {\"input\", \"expected\"}; leave empty to describe the app instead)?");
    let description: string | undefined;
    let draft = false;
    if (!casesFile) {
      description = await out.ask("What should the app do, in a sentence or two?");
      draft = await out.confirm("Have a model draft cases from that? (needs ANTHROPIC_API_KEY)", { defaultYes: true });
    }
    const command = await out.ask("Command that answers one case (it gets the case input as JSON on stdin and prints the answer)?");
    if (!command) throw new UsageError("A cases suite needs the command that answers each case", { reason: "missing_argument" });
    return { ...o, source: "cases", command, ...(casesFile ? { casesFile } : {}), ...(description ? { description } : {}), ...(draft ? { draft } : {}) };
  }
  if (pick !== "1") throw new UsageError(`Answer 1, 2 or 3, got ${JSON.stringify(pick)}`, { reason: "invalid_argument" });
  return { ...o, source: "sessions" };
}

/** How long `eval init --sessions` waits for an ingest already running before reading the index. */
const SESSION_INGEST_WAIT_MS = 30_000;

function defaultName(o: Partial<InitOpts>): string {
  if (o.source === "skill" && o.skill) return basename(o.skill.replace(/\/SKILL\.md$/i, "").replace(/\/+$/, ""));
  if (o.source === "cases" && o.casesFile) return basename(o.casesFile, extname(o.casesFile));
  return o.source === "sessions" ? "failures" : "app";
}

export async function evalInit(c: CommandContext): Promise<number> {
  const { out, flags } = c;
  const root = (await repoRoot(c.cwd)) ?? c.cwd;
  const purpose = str(flags.purpose) as SuitePurpose | undefined;
  const sinceRaw = str(flags.since);
  const trials = positiveInt(flags.trials, "trials");
  const limit = positiveInt(flags.limit, "limit");
  let o: Partial<InitOpts> = {
    root,
    ...(purpose ? { purpose } : {}),
    ...(trials ? { trials } : {}),
    ...(flags.force === true || flags["force-all"] === true ? { force: true } : {}),
    ...(flags["force-all"] === true ? { forceAll: true } : {}),
    ...(str(flags.agent) ? { agent: str(flags.agent)! } : {}),
    ...(list(flags.session).length ? { sessionIds: list(flags.session) } : {}),
    ...(sinceRaw ? { since: parseAge(sinceRaw, "since") } : {}),
    ...(limit ? { limit } : {}),
    ...(str(flags.verifier) ? { verifier: str(flags.verifier)! } : {}),
    ...(list(flags["hidden-test"]).length ? { hiddenTests: list(flags["hidden-test"]) } : {}),
    ...(str(flags.skill) ? { skill: str(flags.skill)! } : {}),
    ...(list(flags.should).length ? { should: list(flags.should) } : {}),
    ...(list(flags["should-not"]).length ? { shouldNot: list(flags["should-not"]) } : {}),
    ...(str(flags.cases) ? { casesFile: str(flags.cases)! } : {}),
    ...(str(flags.command) ? { command: str(flags.command)! } : {}),
    ...(str(flags.url) ? { url: str(flags.url)! } : {}),
  };
  const description = await textArg(str(flags.describe), "describe");
  if (description) o.description = description;
  const source = sourceFromFlags(c);
  if (source) o.source = source;
  else if (out.interactive) o = await askSource(c, root, o);
  else throw new UsageError(`Say what to build the suite from:\n  ${SOURCES_HELP.join("\n  ")}`, { reason: "missing_argument", suggestion: "coding.sh eval init --sessions" });
  const provider = await draftProvider(c);
  if (provider) {
    o.draft = true;
    o.provider = provider;
  } else if (o.draft) {
    o.provider = providerFromSpec({ provider: "anthropic" }, { env: c.env });
  }
  let name = c.positionals[0];
  if (!name) name = out.interactive && !source ? await out.ask("Suite name?", { default: defaultName(o) }) : defaultName(o);
  o.name = name;
  o.signal = c.signal;

  const r = await withContext(c, async (ctx) => {
    // The session that just ended may still be in the ingest its hook started: wait for it, then ingest the rest.
    if (o.source === "sessions") await autoIngest(ctx, { lockWaitMs: SESSION_INGEST_WAIT_MS });
    // `latest` and id prefixes, as in `eval new`.
    if (o.sessionIds) o.sessionIds = await Promise.all(o.sessionIds.map(async (id) => (await resolveSession(ctx, id)).id));
    if (o.draft) out.note(`Drafting with ${o.provider!.name} ${o.provider!.model}…`);
    try {
      return await initSuite(o as InitOpts, { index: ctx.index, blobs: ctx.blobs });
    } catch (e) {
      if (e instanceof InitError || e instanceof DraftError) {
        throw new CliError(e.message, {
          reason: "init_failed",
          ...(o.source === "sessions" && !o.sessionIds ? { next: ["List failed sessions:", `coding.sh sessions --where is:flagged --since ${Math.round((o.since ?? DEFAULT_SINCE_MS) / 86_400_000) * 2}d`] } : {}),
        });
      }
      throw e;
    }
  });
  render(c, r, root);
  return 0;
}

function render(c: CommandContext, r: InitResult, root: string): void {
  const { out } = c;
  if (out.json) {
    out.data({ outcome: "created", ...r, dir: relative(root, r.dir) || "." });
    return;
  }
  const what = r.kind === "tasks" ? plural(r.tasks?.length ?? 0, "task") : r.kind === "triggers" ? "skill trigger prompts" : "cases";
  out.ok(`Wrote ${r.purpose} suite ${r.name} (${what}) to ${relative(root, r.dir) || "."}${r.drafted ? ", DRAFT: read it before trusting a score" : ""}`);
  for (const f of r.files) out.note(f);
  for (const t of r.tasks ?? []) out.row(t.name, `${t.verifier || "no verifier"} · from session ${t.sessionId.slice(0, 8)}`);
  for (const n of r.notes) out.warn(n);
  out.note("");
  out.note(
    r.purpose === "capability"
      ? "Capability suite: tasks the agent can't do reliably yet. Its score starts low; `eval run` reports it and never fails on it."
      : "Regression suite: should pass nearly every time. `eval run` exits 1 when a task fails most of its trials.",
  );
  out.note(`Trials: ${r.spec.trials} per ${r.kind === "cases" ? "case" : r.kind === "triggers" ? "prompt" : "task"}; the report gives pass@${r.spec.trials} (passed at least once) and pass^${r.spec.trials} (passed every time).`);
  out.next(r.todo ? "Fill in the TODO prompts, then run it" : "Run it", r.run);
  if (r.ci) {
    out.note("");
    out.note(`To run it on every pull request, save this as .github/workflows/evals-${r.name}.yml:`);
    out.print(r.ci);
  } else {
    out.note("");
    out.note("These tasks start from snapshots of this machine's repo, so they run here, not in CI. Gate a change to your setup with:");
    out.note(`  coding.sh compare <before> <after> --tag suite:${r.name} --k 3`);
  }
}
