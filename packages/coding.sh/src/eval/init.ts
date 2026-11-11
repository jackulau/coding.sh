// `coding.sh eval init` (and the MCP tool eval_init): scaffold an eval suite in
// <project>/evals/<name>/ from one of three sources, so the first eval is a few
// minutes away (Anthropic, "Demystifying evals for AI agents": start with 20 to
// 50 tasks from real failures, unambiguous tasks with reference solutions,
// balanced should / should-not sets, code graders first):
//
//   sessions  failed or flagged sessions in this repo → repo tasks (tasks/<name>/)
//   skill     a skill's should / should_not prompts   → triggers.toml
//   cases     an app or prompt's cases + its command  → cases.jsonl, graders
//
// Prompts and cases can come from the caller (a file, the MCP caller) or from a
// model (`--draft`); drafted content is marked draft. The suite is plain files
// to read, edit and commit; `coding.sh eval run <name>` runs it.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { version } from "../cli/meta.ts";
import { sha256Hex } from "../core/ids.ts";
import { failureFlags } from "../core/sessions.ts";
import { stringifyToml } from "../core/toml.ts";
import type { BlobStore, IndexStore, Session } from "../core/types.ts";
import { parseCases, formatFromPath, slugify } from "../datasets/dataset.ts";
import type { ChatProvider } from "../judge/providers.ts";
import { toPosix } from "../runner/fsutil.ts";
import { snapshotOps, type SnapshotOps } from "../runner/git.ts";
import { insideDir } from "./decision.ts";
import { CANDIDATE_POOL, rankSessions, rejectSummary } from "./candidates.ts";
import { draftCases, draftTriggers, type DraftedCase } from "./draft.ts";
import { type SuitePurpose } from "./report.ts";
import { DEFAULT_TRIALS, SUITE_FILE, SUITES_DIR, type SuiteKind, type SuiteSpec } from "./suite-spec.ts";
import { draftTaskFromSession, exportTaskDir } from "./task.ts";
import { referenceTestEdits } from "./test-edits.ts";
import { validateTask } from "./validate.ts";
import { sessionMatcher } from "../query/run.ts";
import type { Query } from "../query/where.ts";
import { parseTriggerSpec, readSkill, siblingSkills, TriggerSpecError } from "./trigger.ts";

export type InitSource = "sessions" | "skill" | "cases";
export const INIT_SOURCES: readonly InitSource[] = ["sessions", "skill", "cases"];
/** Sessions `eval init --sessions` drafts at most, newest first. */
export const DEFAULT_SESSION_LIMIT = 10;
export const DEFAULT_SINCE_MS = 14 * 86_400_000;
/** A TODO prompt or case `eval run` refuses until it is replaced. */
export const TODO = "TODO:";

export interface InitCase {
  input: unknown;
  expected?: unknown;
  /** false: a should-not / edge case. */
  should?: boolean;
  id?: string;
  note?: string;
}

export interface InitOpts {
  name: string;
  /** Project root: the suite goes to <root>/evals/<name>. */
  root: string;
  source: InitSource;
  purpose?: SuitePurpose;
  trials?: number;
  /** Replace an existing suite dir, unless it holds files eval init did not write (or that changed since). */
  force?: boolean;
  /** With force: delete those files too. */
  forceAll?: boolean;
  /** Agent that runs the suite (tasks, triggers). */
  agent?: string;
  // sessions
  sessionIds?: string[];
  since?: number;
  limit?: number;
  /** Sessions under this directory instead of `root`, or "all": another checkout or worktree of the same project. */
  sessionsRepo?: string;
  verifier?: string;
  hiddenTests?: string[];
  /** Sessions matching this query (`sessions --where` syntax) instead of only failed or flagged ones. */
  where?: Query;
  /**
   * Validate each drafted task (eval/validate.ts) before it goes into the suite. The verifier
   * decides what the session's own diff is: the reference when it passes the end state, a near
   * miss when it fails it. Tasks that pass validation get status "validated". A diff that
   * changes the verifier's own tests (eval/test-edits.ts) is a near miss either way.
   */
  validate?: { workRoot: string; k?: number; passToPass?: boolean; env?: Record<string, string> };
  // skill
  skill?: string;
  should?: string[];
  shouldNot?: string[];
  // cases
  /** A cases file to use as is (JSONL, JSON or CSV), referenced from suite.json. */
  casesFile?: string;
  cases?: InitCase[];
  command?: string;
  url?: string;
  /** What the app or skill should do, in plain words: the judge's rubric and the drafting brief. */
  description?: string;
  /** Ask `provider` to draft the prompts or cases the caller didn't give. */
  draft?: boolean;
  /** Who wrote the given prompts or cases when it wasn't the user (e.g. the agent calling the MCP tool): they are marked draft. */
  draftedBy?: string;
  provider?: ChatProvider;
  signal?: AbortSignal;
}

export interface InitDeps {
  index: IndexStore;
  blobs: BlobStore;
  /** Snapshot reads (default: the git-backed store). */
  git?: SnapshotOps;
  now?: number;
}

export interface InitResult {
  name: string;
  dir: string;
  kind: SuiteKind;
  purpose: SuitePurpose;
  spec: SuiteSpec;
  /** Files written, relative to the root. */
  files: string[];
  /** What to read or fix before trusting the suite. */
  notes: string[];
  /** Content a model drafted (read it before trusting it). */
  drafted: boolean;
  /** Placeholders the user must fill in before the suite runs. */
  todo: boolean;
  /** The command that runs it. */
  run: string;
  /** A GitHub Actions workflow that runs it, when it can run on a fresh checkout. */
  ci?: string;
  /** Tasks drafted from sessions, by name. */
  tasks?: { id: string; name: string; sessionId: string; verifier: string }[];
}

export class InitError extends Error {
  /** The way out deletes files: the user decides, not an agent. */
  readonly askUser?: true;
  constructor(message: string, opts: { askUser?: boolean } = {}) {
    super(message);
    this.name = "InitError";
    if (opts.askUser) this.askUser = true;
  }
}

/** A file-safe slug, or "" when nothing usable is left. */
const slug = (s: string): string => {
  try {
    return slugify(s);
  } catch {
    return "";
  }
};

/** A suite name: lowercase letters, digits and dashes. */
export function suiteName(raw: string): string {
  const s = slug(raw);
  if (!s) throw new InitError(`suite name ${JSON.stringify(raw)} has no letters or digits`);
  return s;
}

/** In each suite dir: the sha256 of every file eval init wrote, so --force can tell them from yours. */
export const INIT_MANIFEST = ".eval-init.json";

/** Every file under `dir`, suite-relative with forward slashes, the manifest left out. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => toPosix(relative(dir, join(e.parentPath, e.name))))
    .filter((f) => f !== INIT_MANIFEST)
    .sort();
}

/** Record what eval init wrote: `written` (suite-relative files) and everything under each `dirs` entry. */
async function writeManifest(dir: string, written: readonly string[], dirs: readonly string[]): Promise<void> {
  const all = [...written];
  for (const d of dirs) all.push(...(await filesUnder(join(dir, d))).map((f) => `${d}/${f}`));
  const files: Record<string, string> = {};
  for (const f of all.sort()) files[f] = sha256Hex(await readFile(join(dir, f)));
  await writeFile(join(dir, INIT_MANIFEST), `${JSON.stringify({ v: 1, files }, null, 2)}\n`);
}

/** Files in a suite dir that eval init did not write, or that changed since: everything when there is no manifest. */
export async function userFiles(dir: string): Promise<string[]> {
  let known: Record<string, string> = {};
  try {
    const m = JSON.parse(await readFile(join(dir, INIT_MANIFEST), "utf8")) as { files?: Record<string, string> };
    if (m.files && typeof m.files === "object") known = m.files;
  } catch {
    // No manifest (or a broken one): every file is yours.
  }
  const out: string[] = [];
  for (const f of await filesUnder(dir)) if (known[f] !== sha256Hex(await readFile(join(dir, f)))) out.push(f);
  return out;
}

export async function initSuite(o: InitOpts, deps: InitDeps): Promise<InitResult> {
  const name = suiteName(o.name);
  const dir = join(o.root, SUITES_DIR, name);
  const rel = toPosix(relative(o.root, dir));
  if (existsSync(join(dir, SUITE_FILE)) && !o.force) throw new InitError(`${rel} already exists. Replacing it deletes the suite's files: ask the user, and pass --force only once they approve`, { askUser: true });
  if (o.force && !o.forceAll && existsSync(dir)) {
    const yours = await userFiles(dir);
    if (yours.length) {
      const shown = yours.slice(0, 8).join(", ") + (yours.length > 8 ? `, and ${yours.length - 8} more` : "");
      throw new InitError(`${rel} has files eval init did not write, or that changed since: ${shown}. Move them out first, or ask the user and pass --force-all (it deletes them) only once they approve`, { askUser: true });
    }
  }
  if (o.trials !== undefined && !(Number.isInteger(o.trials) && o.trials >= 1)) throw new InitError("trials must be a whole number ≥ 1");
  const trials = o.trials ?? DEFAULT_TRIALS;
  const built = o.source === "sessions" ? await fromSessions(o, deps, name, dir) : o.source === "skill" ? await fromSkill(o, name, dir) : await fromCases(o, name, dir);
  const spec: SuiteSpec = { name, purpose: o.purpose ?? built.purpose, trials, ...built.fields };
  if (o.force && existsSync(dir)) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const [rel, text] of Object.entries(built.files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
    files.push(toPosix(relative(o.root, join(dir, rel))));
  }
  for (const t of built.tasks ?? []) {
    await exportTaskDir(t.task, join(dir, "tasks", t.dir), deps.blobs);
    files.push(toPosix(relative(o.root, join(dir, "tasks", t.dir))) + "/");
  }
  await writeFile(join(dir, SUITE_FILE), `${JSON.stringify(spec, null, 2)}\n`);
  files.unshift(toPosix(relative(o.root, join(dir, SUITE_FILE))));
  await writeManifest(dir, [SUITE_FILE, ...Object.keys(built.files).map(toPosix)], (built.tasks ?? []).map((t) => `tasks/${toPosix(t.dir)}`));
  const kind: SuiteKind = o.source === "sessions" ? "tasks" : o.source === "skill" ? "triggers" : "cases";
  const run = `coding.sh eval run ${name}`;
  const ci = kind === "tasks" ? undefined : ciWorkflow(name, kind, spec.agent);
  return {
    name,
    dir,
    kind,
    purpose: spec.purpose,
    spec,
    files,
    notes: built.notes,
    drafted: built.drafted,
    todo: built.todo,
    run,
    ...(ci ? { ci } : {}),
    ...(built.tasks ? { tasks: built.tasks.map((t) => ({ id: t.task.id, name: t.task.name, sessionId: t.sessionId, verifier: t.task.verifier.command })) } : {}),
  };
}

interface Built {
  purpose: SuitePurpose;
  fields: Partial<SuiteSpec>;
  /** Suite-relative path → content. */
  files: Record<string, string>;
  notes: string[];
  drafted: boolean;
  todo: boolean;
  tasks?: { task: Awaited<ReturnType<typeof draftTaskFromSession>>; dir: string; sessionId: string }[];
}

// ------------------------------------------------------------ sessions

/** Tag on a task drafted from a session that went wrong (isFlagged): `eval run` reports which of these now pass. */
export const CAPTURED_FAILURE_TAG = "captured-failure";

/** A session that went wrong: a failure flag (not a tag), or tests still failing. */
export const isFlagged = (s: Session): boolean => failureFlags(s.flags).length > 0 || (s.stats.testsFailed ?? 0) > 0;

/** Recent root sessions in the project (only failed or flagged ones unless `flaggedOnly` is false), newest first, at most CANDIDATE_POOL. */
export async function recentSessions(o: Pick<InitOpts, "root" | "since" | "sessionsRepo">, index: IndexStore, now: number, flaggedOnly = true): Promise<Session[]> {
  const since = now - (o.since ?? DEFAULT_SINCE_MS);
  const where = o.sessionsRepo;
  const all = await index.listSessions({ ...(where ? {} : { repoRoot: o.root }), runId: null, parentSessionId: null, since });
  return all
    .filter((s) => (!flaggedOnly || isFlagged(s)) && s.startedAt >= since && (!where || where === "all" || insideDir(where, s.repo?.root) || insideDir(where, s.cwd)))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, CANDIDATE_POOL);
}

async function pickSessions(o: InitOpts, index: IndexStore, now: number): Promise<{ sessions: Session[]; notes: string[] }> {
  if (o.sessionIds?.length) {
    const out: Session[] = [];
    for (const id of o.sessionIds) {
      const s = await index.getSession(id);
      if (!s) throw new InitError(`no session ${id}`);
      out.push(s);
    }
    return { sessions: out, notes: [] };
  }
  // Ranked (eval/candidates.ts): sessions that can't become a task are left out, the rest go best first.
  let pool = await recentSessions(o, index, now, !o.where);
  if (o.where) {
    const match = sessionMatcher(index, o.where.root);
    const hits: Session[] = [];
    for (const s of pool) if (await match(s)) hits.push(s);
    pool = hits;
  }
  const ranked = await rankSessions(index, pool, { now });
  const byId = new Map(pool.map((s) => [s.id, s]));
  const sessions = ranked.filter((c) => c.eligible).slice(0, o.limit ?? DEFAULT_SESSION_LIMIT).map((c) => byId.get(c.sessionId)!);
  const rejected = rejectSummary(ranked);
  return { sessions, notes: rejected ? [`left out ${ranked.filter((c) => !c.eligible).length} ${o.where ? "matching" : "flagged"} session(s) that can't become a task: ${rejected} (coding.sh eval candidates --all lists them)`] : [] };
}

async function fromSessions(o: InitOpts, deps: InitDeps, name: string, _dir: string): Promise<Built> {
  const now = deps.now ?? Date.now();
  const picked = await pickSessions(o, deps.index, now);
  const sessions = picked.sessions;
  if (!sessions.length) {
    const days = Math.round((o.since ?? DEFAULT_SINCE_MS) / 86_400_000);
    const where = o.sessionsRepo === "all" ? "any repo" : (o.sessionsRepo ?? o.root);
    const why = picked.notes.length ? ` that can become a task (${picked.notes[0]})` : "";
    throw new InitError(`no ${o.where ? "matching" : "failed or flagged"} sessions${why} in ${where} in the last ${days} days (coding.sh sessions --where is:flagged lists them); name sessions with --session <id>${o.sessionsRepo ? "" : ", or look in another checkout with --repo <DIR|all>"}`);
  }
  const notes: string[] = [...picked.notes];
  const tasks: NonNullable<Built["tasks"]> = [];
  const used = new Set<string>();
  const agents = new Map<string, number>();
  let attempts = 0;
  let validated = 0;
  for (const s of sessions) {
    let task;
    try {
      task = await draftTaskFromSession({
        index: deps.index,
        blobs: deps.blobs,
        ...(deps.git ? { git: deps.git } : {}),
        sessionId: s.id,
        ...(o.verifier ? { verifierCommand: o.verifier } : {}),
        ...(o.hiddenTests?.length ? { hiddenTests: o.hiddenTests } : {}),
        tags: [`suite:${name}`, ...(isFlagged(s) ? [CAPTURED_FAILURE_TAG] : [])],
        ...(deps.now ? { now: deps.now } : {}),
      });
    } catch (e) {
      notes.push(`skipped session ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    let d = slug(task.name).slice(0, 48) || "task";
    for (let i = 2; used.has(d); i++) d = `${slug(task.name).slice(0, 44)}-${i}`;
    // A failed session's diff is what the agent got wrong: a near miss the
    // verifier must fail, not the reference solution it must pass. With
    // validation, the verifier decides: a diff that passes it is a reference.
    let failed = isFlagged(s) && !!task.referencePatch;
    // Neither holds for a diff that changes the verifier's own tests: it passes
    // the verifier whatever the code does, so it is a near miss before any run.
    const testEdits = task.referencePatch && task.verifier.command && (o.validate || !failed) ? await referenceTestEdits(task, (await deps.blobs.getText(task.referencePatch)) ?? "", await snapshotOps(deps.git)) : [];
    if (testEdits.length) {
      failed = true;
      notes.push(`${d}: the session's diff changes the tests the verifier runs (${[...new Set(testEdits.map((f) => `${f.kind} ${f.path}`))].join(", ")}), so it is kept as a near miss, not the reference; add reference.patch, a fix that leaves the tests alone, then coding.sh eval validate`);
    } else if (o.validate && task.referencePatch && task.verifier.command) {
      const v = await validateTask({ task, blobs: deps.blobs, workRoot: o.validate.workRoot, k: o.validate.k ?? 1, ...(deps.git ? { git: deps.git } : {}), ...(o.validate.passToPass === false ? { passToPass: false } : {}), ...(o.validate.env ? { env: o.validate.env } : {}) });
      failed = !v.report.ok && v.report.referencePasses.passed === 0 && isFlagged(s);
      if (v.report.ok) {
        task = { ...task, status: v.task.status, validation: v.task.validation };
        validated++;
      } else if (failed) notes.push(`${d}: the session's end state fails the verifier, so its diff is kept as a near miss; add reference.patch, a correct fix, then coding.sh eval validate`);
      else notes.push(`${d}: not validated: ${[...v.errors, ...(v.report.errors ?? [])][0] ?? validationGap(v.report)}`);
    }
    if (failed) task = { ...task, referencePatch: undefined, nearMissPatches: [task.referencePatch!, ...(task.nearMissPatches ?? [])] };
    await deps.index.putTask(task);
    used.add(d);
    tasks.push({ task, dir: d, sessionId: s.id });
    if (failed) attempts++;
    agents.set(s.agent, (agents.get(s.agent) ?? 0) + 1);
    if (!task.verifier.command) notes.push(`${d}: no verifier; set "verifier.command" in tasks/${d}/task.json to a command that passes only when the task is solved`);
    else if (task.meta.verifierSource !== "given") notes.push(`${d}: verifier guessed (${task.verifier.command}); make sure it covers this task only`);
  }
  if (!tasks.length) throw new InitError(`couldn't draft a task from any of ${sessions.length} session(s): ${notes.join("; ")}`);
  if (o.validate) notes.unshift(`${validated} of ${tasks.length} task(s) validated: the verifier fails the start, passes the session's end state and fails the near misses`);
  if (attempts) {
    notes.push(
      `the agent's failed attempt is saved as near-misses/001.patch (the verifier must fail it). Add reference.patch, a correct fix, to ${attempts === tasks.length ? "each task dir" : "those task dirs"}; then coding.sh eval import evals/${name}/tasks/<task> loads it and coding.sh eval validate <task> checks the verifier fails before the fix and passes after`,
    );
  }
  const agent = o.agent ?? [...agents.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "claude-code";
  return { purpose: "capability", fields: { description: `Tasks from ${tasks.length} failed or flagged session(s)`, tasks: "tasks", agent }, files: {}, notes, drafted: false, todo: false, tasks };
}

/** The first check a validation failed, in words. */
function validationGap(r: { noopFails: boolean; referencePasses: { passed: number; of: number }; nearMissesFail: { failed: number; of: number }; leakage: string[] }): string {
  if (!r.noopFails) return "the verifier already passes before any change";
  if (r.referencePasses.passed < r.referencePasses.of) return `the session's end state passed ${r.referencePasses.passed} of ${r.referencePasses.of} verifier runs`;
  if (r.nearMissesFail.failed < r.nearMissesFail.of) return `${r.nearMissesFail.of - r.nearMissesFail.failed} near miss(es) passed the verifier`;
  if (r.leakage.length) return `the instruction leaks the fix: ${r.leakage[0]}`;
  return "see coding.sh eval validate";
}

// ------------------------------------------------------------ skill

async function fromSkill(o: InitOpts, name: string, dir: string): Promise<Built> {
  if (!o.skill) throw new InitError("a skill suite needs the skill dir (--skill <DIR>)");
  const skillPath = resolve(o.root, o.skill);
  const skill = await readSkill(skillPath).catch((e: Error) => {
    throw new InitError(e.message);
  });
  const notes: string[] = [];
  let should = o.should?.filter((p) => p.trim()) ?? [];
  let shouldNot = o.shouldNot?.filter((p) => p.trim()) ?? [];
  const fields: Partial<SuiteSpec> = { description: skill.description || `Routing for ${skill.name}`, skill: toPosix(relative(dir, skill.dir)) || ".", ...(o.agent ? { agent: o.agent } : {}) };
  // The skill's own triggers.toml (what `eval trigger <skill>` reads): the suite points at it instead of a copy.
  const own = join(skill.dir, "triggers.toml");
  if (!should.length && !shouldNot.length && !o.draft && existsSync(own)) {
    let spec;
    try {
      spec = parseTriggerSpec(await readFile(own, "utf8"), own);
    } catch (e) {
      throw new InitError(e instanceof TriggerSpecError ? e.message : `can't read ${own}: ${(e as Error).message}`);
    }
    notes.push(`uses the skill's own triggers.toml (${spec.should.length} should, ${spec.shouldNot.length} should-not prompts); edit it there`);
    return { purpose: "regression", fields: { ...fields, triggers: toPosix(relative(dir, own)) }, files: {}, notes, drafted: false, todo: false };
  }
  let drafted = false;
  let todo = false;
  if (o.draftedBy && (should.length || shouldNot.length)) {
    drafted = true;
    notes.push(`${o.draftedBy} wrote the prompts: read each one, fix it or delete it`);
  }
  if ((!should.length || !shouldNot.length) && o.draft) {
    if (!o.provider) throw new InitError("--draft needs a model");
    const siblings = await siblingSkills(dirname(skill.dir), [skill.dir]);
    const d = await draftTriggers(o.provider, { skill: skill.name, description: skill.description || o.description || skill.name, siblings, ...(o.signal ? { signal: o.signal } : {}) });
    if (!should.length) should = d.should;
    if (!shouldNot.length) shouldNot = d.shouldNot;
    drafted = true;
    notes.push(`${o.provider.name} ${o.provider.model} drafted the prompts: read each one, fix it or delete it`);
  }
  if (!should.length || !shouldNot.length) {
    todo = true;
    if (!should.length) should = [`${TODO} a request where ${skill.name} should load`, `${TODO} the same need in other words`, `${TODO} a harder or rarer case it covers`];
    if (!shouldNot.length) shouldNot = [`${TODO} a near miss that shares words with ${skill.name} but needs something else`, `${TODO} an unrelated request`, `${TODO} a request another skill handles`];
    notes.push(`replace the ${TODO} prompts in triggers.toml (aim for 10 or more per side), or rerun with --draft to have a model write them`);
  }
  if (should.length + shouldNot.length < 20 && !todo) notes.push("aim for 10 or more prompts per side: a few prompts only show large differences");
  const header = [
    `# Trigger prompts for the ${skill.name} skill: should loads it, should_not leaves it alone.`,
    ...(drafted ? ["# DRAFT: a model wrote these. Read every prompt; delete or fix the ones a person would grade differently."] : []),
    "# Run: coding.sh eval run " + name,
    "",
  ].join("\n");
  const toml = stringifyToml({ skill: skill.name, should: should.map((prompt) => ({ prompt })), should_not: shouldNot.map((prompt) => ({ prompt })) });
  return {
    purpose: "regression",
    fields: { ...fields, triggers: "triggers.toml" },
    files: { "triggers.toml": `${header}${toml}` },
    notes,
    drafted,
    todo,
  };
}

// ------------------------------------------------------------ cases

const SHORT = 80;
const short = (v: unknown) => typeof v === "string" ? v.length <= SHORT && !v.includes("\n") : typeof v === "number" || typeof v === "boolean";

/**
 * Code graders first: exact when every case has a short expected answer, a
 * reference-based judge when the answers are long, a rubric judge when there
 * are none.
 */
export function chooseGraders(cases: readonly { expected?: unknown }[], description?: string): { graders: Record<string, unknown>[]; judge: boolean } {
  const withExpected = cases.filter((c) => c.expected !== undefined && c.expected !== null && c.expected !== "");
  if (cases.length && withExpected.length === cases.length && withExpected.every((c) => short(c.expected))) {
    return { graders: [{ kind: "exact", normalize: { caseInsensitive: true, collapseWhitespace: true } }], judge: false };
  }
  if (withExpected.length) {
    return { graders: [{ kind: "llm", name: "matches-expected", rubric: "Pass when the output gives the same answer as the expected output. Wording may differ; facts, numbers and decisions may not." }], judge: true };
  }
  const goal = description?.trim().replace(/\s+/g, " ");
  return { graders: [{ kind: "llm", name: "does-the-job", rubric: goal ? `Pass when the output does this, correctly and completely: ${goal}` : "Pass when the output fully and correctly answers the input." }], judge: true };
}

function caseId(input: unknown, used: Set<string>): string {
  const base = slug(typeof input === "string" ? input.split(/\s+/).slice(0, 6).join(" ") : JSON.stringify(input)).slice(0, 40) || "case";
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
}

async function fromCases(o: InitOpts, name: string, dir: string): Promise<Built> {
  if (!o.command && !o.url) throw new InitError("a cases suite needs what answers each case: --command '<cmd>' (gets the input as JSON on stdin, prints the answer) or --url <URL>");
  if (o.command && o.url) throw new InitError("give --command or --url, not both");
  const notes: string[] = [];
  const files: Record<string, string> = {};
  let casesRef: string;
  let cases: InitCase[];
  let drafted = false;
  if (o.casesFile) {
    const file = resolve(o.root, o.casesFile);
    const text = await readFile(file, "utf8").catch(() => {
      throw new InitError(`can't read ${o.casesFile}`);
    });
    cases = parseCases(text, formatFromPath(file)) as InitCase[];
    if (!cases.length) throw new InitError(`${o.casesFile} has no cases`);
    casesRef = toPosix(relative(dir, file));
  } else {
    cases = o.cases?.length ? [...o.cases] : [];
    if (cases.length && o.draftedBy) {
      drafted = true;
      notes.push(`${o.draftedBy} wrote ${cases.length} cases: read each one and its expected answer before trusting a score`);
    }
    if (!cases.length && o.draft) {
      if (!o.provider) throw new InitError("--draft needs a model");
      if (!o.description?.trim()) throw new InitError("--draft needs --describe '<what the app does>' to write cases from");
      const d: DraftedCase[] = await draftCases(o.provider, { description: o.description, ...(o.signal ? { signal: o.signal } : {}) });
      cases = d.map((c) => ({ input: c.input, ...(c.expected !== undefined ? { expected: c.expected } : {}), should: c.should, ...(c.note ? { note: c.note } : {}) }));
      drafted = true;
      notes.push(`${o.provider.name} ${o.provider.model} drafted ${cases.length} cases: read each one and its expected answer before trusting a score`);
    }
    if (!cases.length) throw new InitError("a cases suite needs cases: --cases <FILE> (JSONL of {\"input\", \"expected\"}), or --describe '<what the app does>' --draft to have a model write them");
    const used = new Set<string>();
    const lines = cases.map((c) => {
      const tags = c.should === undefined ? undefined : [c.should ? "should" : "should-not"];
      const meta = { ...(drafted ? { draft: true } : {}), ...(c.note ? { note: c.note } : {}) };
      return JSON.stringify({ id: c.id ?? caseId(c.input, used), input: c.input, ...(c.expected !== undefined ? { expected: c.expected } : {}), ...(tags ? { tags } : {}), ...(Object.keys(meta).length ? { metadata: meta } : {}) });
    });
    files["cases.jsonl"] = `${lines.join("\n")}\n`;
    casesRef = "cases.jsonl";
  }
  const should = cases.filter((c) => c.should !== false).length;
  if (cases.some((c) => c.should !== undefined) && (should === 0 || should === cases.length)) notes.push("every case tests the same side: add cases where the behavior should not happen, so a change that overdoes it shows up");
  if (cases.length < 20) notes.push(`${cases.length} case${cases.length === 1 ? "" : "s"}: grow toward 20 to 50 from real failures; a small suite only shows large changes`);
  const { graders, judge } = chooseGraders(cases, o.description);
  if (judge) notes.push("the grader is a model judge (ANTHROPIC_API_KEY, at ANTHROPIC_BASE_URL when set): label 20 or more runs in coding.sh ui, then coding.sh judge calibrate <experiment>, before you trust its verdicts");
  const task = o.command ? { kind: "command", command: o.command } : { kind: "http", url: o.url };
  return {
    purpose: "regression",
    fields: { ...(o.description ? { description: o.description } : {}), cases: casesRef, task, graders },
    files,
    notes,
    drafted,
    todo: false,
  };
}

// ------------------------------------------------------------ CI

/**
 * A GitHub Actions workflow that runs the suite on every pull request with the
 * coding.sh action (action.yml at the repo root, pinned to this release): `eval
 * run` exits 1 when a regression suite regresses, and the action writes the
 * report to the step summary and one pull request comment.
 */
export function ciWorkflow(name: string, kind: SuiteKind, agent?: string, release = version()): string {
  const needsClaude = kind === "triggers" && (agent ?? "claude-code") === "claude-code";
  return [
    `name: evals (${name})`,
    "on: pull_request",
    "",
    "permissions:",
    "  contents: read",
    "  pull-requests: write",
    "",
    "jobs:",
    "  evals:",
    "    runs-on: ubuntu-latest",
    "    env:",
    "      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...(needsClaude
      ? ["      - uses: actions/setup-node@v4", "        with:", "          node-version: 22", "      - name: Install Claude Code", "        run: npm install -g @anthropic-ai/claude-code"]
      : []),
    `      - uses: jackulau/coding.sh@v${release}`,
    "        with:",
    `          command: eval run ${name} --yes`,
    "",
  ].join("\n");
}

/** `basename` of the suite dir, for messages. */
export const suiteLabel = (dir: string): string => basename(dir);
