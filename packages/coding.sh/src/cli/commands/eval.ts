// coding.sh eval init|run|new|import|validate|crosscheck|audit|trigger|list|export
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { paths } from "../../core/paths.ts";
import { materialize, shadowRepoPath, snapshotDir } from "../../core/snapshot.ts";
import type { EvalTask, RunResult } from "../../core/types.ts";
import { crossCheckMeta, crossCheckVerifier, DEFAULT_CROSSCHECK_MAX, formatCrossCheck } from "../../eval/crosscheck.ts";
import { StatementError } from "../../eval/statement.ts";
import { draftTaskFromSession, exportHarbor, exportTaskDir, importTaskDir, readInstructionArg, verifierPathWarnings } from "../../eval/task.ts";
import { formatValidation, validateTask } from "../../eval/validate.ts";
import {
  auditArms,
  confirmWitness,
  formatAudit,
  promoteWitnesses,
  replayWitnesses,
  taskWitnesses,
  withAudit,
  withWitnesses,
  witnessId,
  type AuditReport,
  type ConfirmWitnessResult,
  type Witness,
} from "../../eval/witness.ts";
import { toPosix } from "../../runner/fsutil.ts";
import { git } from "../../runner/git.ts";
import { providerFromSpec, type LlmProviderSpec } from "../../graders/index.ts";
import { positiveInt, UsageError } from "../args.ts";
import { autoIngest, jsonArg, list, notFoundWithBacklog, oneLine, resolveSession, resolveTask, str, withContext } from "../common.ts";
import { ago, CliError, clean } from "../output.ts";
import type { CommandContext } from "../types.ts";
import type { Context } from "../../core/context.ts";

/** By id or unique name. */
const getTask = (ctx: Context, ref: string): Promise<EvalTask> => resolveTask(ctx, ref);

/**
 * One task dir: an exported task (task.json with a start snapshot), a
 * hand-written one whose repo/ dir is the start tree, one whose task.json
 * names `"start": {"commit": "<rev>"}` of a git repo (`repo`, relative to the
 * task dir; default the repo the task dir is in), or none: an empty tree.
 */
export async function importDir(dir: string, ctx: Context, env: NodeJS.ProcessEnv): Promise<EvalTask> {
  if (!existsSync(join(dir, "task.json"))) throw new Error("no task.json in it");
  const repo = join(dir, "repo");
  let start: EvalTask["start"] | undefined;
  if (existsSync(repo)) start = await snapshotDir(repo, env);
  else {
    const json = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as { start?: { snapshot?: string; repoRoot?: unknown; commit?: unknown; repo?: unknown } };
    if (json.start?.commit !== undefined && !json.start.snapshot) start = await commitStart(dir, json.start.commit, json.start.repo);
    else if (json.start?.snapshot) await checkStartSnapshot(dir, json.start.snapshot, json.start.repoRoot, env);
    else {
      const empty = join(paths(env).repos, "empty-start");
      await mkdir(empty, { recursive: true });
      start = await snapshotDir(empty, env);
    }
  }
  return importTaskDir(dir, ctx.blobs, start ? { start } : {});
}

/**
 * A task.json that points at a start snapshot (an export made before repo/ was
 * written, or `eval init`'s suite) only imports where that snapshot is: in this
 * home's shadow repo for repoRoot, or in the git repo at repoRoot.
 */
async function checkStartSnapshot(dir: string, snapshot: string, repoRoot: unknown, env: NodeJS.ProcessEnv): Promise<void> {
  const where = typeof repoRoot === "string" && repoRoot ? repoRoot : undefined;
  const fix = `export it again with coding.sh eval export <task> --out <DIR> where it was made (the export then carries its start tree as repo/), or add a repo/ dir with the start files`;
  if (!where) throw new Error(`${dir}/task.json: start snapshot ${snapshot.slice(0, 12)} names no repoRoot; ${fix}`);
  const shadow = shadowRepoPath(where, env);
  const has = async (gitDir: string) => (await git([`--git-dir=${gitDir}`, "cat-file", "-e", `${snapshot}^{commit}`], dir)).exitCode === 0;
  if (existsSync(join(shadow, "HEAD")) && (await has(shadow))) return;
  if (existsSync(where) && (await git(["-C", where, "cat-file", "-e", `${snapshot}^{commit}`], dir)).exitCode === 0) return;
  throw new Error(`${dir}/task.json: start snapshot ${snapshot.slice(0, 12)} is not in this home (it was made for ${where}); ${fix}`);
}

/** A task's start tree as a commit of a git repo: `repo` (relative to the task dir) or the repo holding the task dir. */
async function commitStart(dir: string, commit: unknown, repo: unknown): Promise<EvalTask["start"]> {
  if (typeof commit !== "string" || !commit.trim()) throw new Error(`${dir}/task.json: "start.commit" must be a commit sha or ref`);
  if (repo !== undefined && typeof repo !== "string") throw new Error(`${dir}/task.json: "start.repo" must be a path`);
  const from = resolve(dir, repo ?? ".");
  const top = await git(["rev-parse", "--show-toplevel"], from);
  if (top.exitCode !== 0) throw new Error(`${dir}/task.json: "start.commit" needs a git repo, and ${from} is not in one`);
  const root = resolve(top.stdoutTail.trim());
  const sha = await git(["rev-parse", "--verify", "--quiet", `${commit.trim()}^{commit}`], root);
  if (sha.exitCode !== 0) throw new Error(`${dir}/task.json: commit ${commit.trim()} is not in ${root} (fetch it first)`);
  const full = sha.stdoutTail.trim();
  return { repoRoot: root, snapshot: full, head: full };
}

/**
 * `--witness <FILE>` is written at its path relative to the current dir (its name when
 * outside it); `--witness <REPO_PATH>=<FILE>` names the repo path.
 */
function witnessPaths(arg: string, cwd: string): { path: string; file: string } {
  const eq = arg.indexOf("=");
  if (eq > 0 && !existsSync(resolve(cwd, arg))) return { path: toPosix(arg.slice(0, eq)), file: resolve(cwd, arg.slice(eq + 1)) };
  const file = resolve(cwd, arg);
  const rel = relative(cwd, file);
  return { path: toPosix(rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : basename(file)), file };
}

function taskJson(t: EvalTask): Record<string, unknown> {
  return { id: t.id, name: t.name, status: t.status, sourceSessionId: t.sourceSessionId ?? null, repo: t.start.repoRoot, verifier: t.verifier, tags: t.tags, createdAt: new Date(t.createdAt).toISOString(), validation: t.validation ?? null, ...(t.meta?.crossCheck ? { crossCheck: t.meta.crossCheck } : {}) };
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  // The spec and flags are checked before the store opens.
  if (c.action === "trigger") return (await import("./eval-trigger.ts")).evalTrigger(c);
  if (c.action === "init") return (await import("./eval-init.ts")).evalInit(c);
  if (c.action === "run") return (await import("./eval-run.ts")).evalRun(c);
  if (c.action === "candidates") return (await import("./eval-candidates.ts")).evalCandidates(c);
  return withContext(c, async (ctx) => {
    switch (c.action) {
      case "new": {
        const statement = str(c.flags.statement) as "first-prompt" | "ledger" | undefined;
        const judgeArg = str(c.flags.judge);
        if (judgeArg && statement !== "ledger") throw new UsageError("--judge needs --statement ledger", { reason: "invalid_argument" });
        let provider;
        if (judgeArg) {
          const spec = (await jsonArg(judgeArg, "--judge")) as LlmProviderSpec;
          if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new UsageError('--judge must be a provider spec, e.g. {"provider":"anthropic","model":"…"}', { reason: "invalid_value" });
          try {
            provider = providerFromSpec(spec, { env: c.env });
          } catch (e) {
            throw new UsageError(`Invalid --judge: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_value" });
          }
        }
        const backlog = await autoIngest(ctx);
        const s = await resolveSession(ctx, c.positionals[0]!).catch((e) => Promise.reject(notFoundWithBacklog(e, backlog)));
        const verifier = str(c.flags.verifier);
        const name = str(c.flags.name);
        const instructionArg = str(c.flags.instruction);
        let instruction: string | undefined;
        if (instructionArg !== undefined) {
          try {
            instruction = await readInstructionArg(instructionArg, c.cwd);
          } catch (e) {
            throw new UsageError(`Bad --instruction: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_value" });
          }
        }
        let task;
        try {
          task = await draftTaskFromSession({
            index: ctx.index,
            blobs: ctx.blobs,
            sessionId: s.id,
            ...(statement ? { statement } : {}),
            ...(provider ? { provider } : {}),
            ...(name ? { name } : {}),
            ...(instruction ? { instruction } : {}),
            ...(verifier ? { verifierCommand: verifier } : {}),
            ...(list(c.flags.setup).length ? { setup: list(c.flags.setup) } : {}),
            ...(list(c.flags["hidden-test"]).length ? { hiddenTests: list(c.flags["hidden-test"]) } : {}),
            ...(list(c.flags.tag).length ? { tags: list(c.flags.tag) } : {}),
          });
        } catch (e) {
          if (e instanceof StatementError) {
            throw new CliError(`Couldn't write a requirement ledger for ${s.id}: ${e.message}`, { reason: "draft_failed", next: ["Retry, use another model, or take one obligation per user turn:", `coding.sh eval new ${s.id} --statement ledger`] });
          }
          throw new CliError(`Couldn't draft a task from ${s.id}: ${e instanceof Error ? e.message : String(e)}`, { reason: "draft_failed" });
        }
        await ctx.index.putTask(task);
        const notes = task.meta.notes;
        if (out.json) {
          out.data({ outcome: "created", task: taskJson(task), notes });
          return 0;
        }
        out.ok(`Drafted ${task.name}`);
        out.row("Verifier", task.verifier.command || "none: pass --verifier");
        if (task.meta.obligations?.length) {
          const skip = new Set(task.meta.notImplemented ?? []);
          out.print("Obligations:");
          for (const o of task.meta.obligations) {
            const state = o.status === "superseded" ? ` (superseded by ${o.supersededBy})` : skip.has(o.id) ? " (not built, left out)" : "";
            out.print(`  ${o.id} ${oneLine(o.text, 100)}${state}  [${o.evidence.join(", ")}]`);
          }
        }
        for (const n of notes.slice(0, 5)) out.warn(n);
        out.print(task.id);
        out.next("Check the task is fair before using it", `coding.sh eval validate ${task.id}`);
        return 0;
      }
      case "validate": {
        const tag = str(c.flags.tag);
        if (!c.positionals.length && !tag) throw new UsageError("Name a task, or pass --tag <TAG> to validate every task with that tag", { reason: "missing_argument" });
        const tasks: EvalTask[] = [];
        for (const ref of c.positionals) tasks.push(await getTask(ctx, ref));
        if (tag) {
          const tagged = (await ctx.index.listTasks({ tag })).filter((t) => t.status !== "archived");
          if (!tagged.length) throw new CliError(`No tasks have the tag ${JSON.stringify(tag)}`, { reason: "not_found", next: ["List tasks and their tags:", "coding.sh eval list --json"] });
          tasks.push(...tagged.sort((a, b) => a.name.localeCompare(b.name)));
        }
        const unique = [...new Map(tasks.map((t) => [t.id, t])).values()];
        const k = positiveInt(c.flags.k, "k") ?? 5;
        const workRoot = await mkdtemp(join(tmpdir(), "codingsh-validate-"));
        const many = unique.length > 1;
        const docs: Record<string, unknown>[] = [];
        let failed = 0;
        try {
          for (const [i, task] of unique.entries()) {
            const spin = out.spin(many ? `Validating ${task.name} (${i + 1}/${unique.length})…` : "Validating…");
            let o;
            try {
              o = await validateTask({
                task,
                blobs: ctx.blobs,
                workRoot,
                k,
                index: ctx.index,
                keep: c.flags.keep === true,
                strictCoupling: c.flags["strict-coupling"] === true,
                signal: c.signal,
                ...(many ? {} : { onStep: (st: { label: string; pass: boolean }) => out.note(`${st.label}: ${st.pass ? "pass" : "fail"}`) }),
              });
            } finally {
              spin.stop();
            }
            if (!o.report.ok) failed++;
            docs.push({ outcome: o.report.ok ? "validated" : "rejected", task: taskJson(o.task), report: o.report, errors: o.errors, notes: o.notes, steps: o.steps });
            if (out.json) continue;
            if (!many) {
              out.print(formatValidation(o));
              if (o.report.ok) out.ok(`${task.id} validated`);
              else out.fail(`${task.id} did not validate`);
            } else if (o.report.ok) out.ok(`${task.name} validated`);
            else out.fail(`${task.name} did not validate${o.errors[0] ? `: ${oneLine(o.errors[0]).slice(0, 160)}` : ""}`);
          }
          if (out.json) out.data(many ? { tasks: docs, validated: unique.length - failed, rejected: failed } : docs[0]!);
          else if (many) {
            out.print(`${unique.length - failed} of ${unique.length} tasks validated`);
            if (failed) out.next("See why a task did not validate", "coding.sh eval validate <task>");
          }
          return failed ? 1 : 0;
        } finally {
          if (c.flags.keep !== true) await rm(workRoot, { recursive: true, force: true });
          else out.note(`Work directories kept in ${workRoot}`);
        }
      }
      case "crosscheck": {
        const task = await getTask(ctx, c.positionals[0]!);
        const max = positiveInt(c.flags.max, "max") ?? DEFAULT_CROSSCHECK_MAX;
        const judgeArg = str(c.flags.judge);
        const spec = (judgeArg ? await jsonArg(judgeArg, "--judge") : {}) as LlmProviderSpec;
        if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new UsageError('--judge must be a provider spec, e.g. {"provider":"anthropic","model":"…"}', { reason: "invalid_value" });
        let provider;
        try {
          provider = providerFromSpec(spec, { env: c.env });
        } catch (e) {
          throw new UsageError(`Invalid --judge: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_value" });
        }
        const experimentId = str(c.flags.experiment);
        const runs: RunResult[] = await ctx.index.listRuns({ taskId: task.id, ...(experimentId ? { experimentId } : {}) });
        const solver = str(c.flags.solver);
        if (solver) {
          const bundle = await ctx.index.getBundle(solver);
          if (!bundle) throw new CliError(`Can't find harness bundle ${JSON.stringify(solver)}`, { reason: "not_found", next: ["List bundles:", "coding.sh harness list"] });
          const { getAdapter } = await import("../../adapters/index.ts");
          const adapter = getAdapter(bundle.agent);
          if (!adapter?.run) throw new CliError(`Agent ${bundle.agent} has no headless driver, so bundle ${bundle.name} can't solve the task`, { reason: "unsupported_agent" });
          const { runTask } = await import("../../runner/run.ts");
          const { captureRedactor } = await import("../../runner/verifier-output.ts");
          const spin = out.spin(`Solving ${task.name} with ${bundle.name}…`);
          try {
            runs.push(await runTask({ task, bundle, adapter, blobs: ctx.blobs, index: ctx.index, redactor: captureRedactor(ctx.config, ctx.env), signal: c.signal, ingest: () => ctx.ingest() }));
          } finally {
            spin.stop();
          }
        }
        if (!runs.length) {
          throw new CliError(`No stored runs of ${task.name}${experimentId ? ` in experiment ${experimentId}` : ""} to cross-check`, {
            reason: "not_found",
            next: ["Run the task first, or solve it once here:", `coding.sh eval crosscheck ${task.id} --solver <BUNDLE>`],
          });
        }
        const spin = out.spin(`Cross-checking up to ${max} run(s) of ${task.name}…`);
        let result;
        try {
          // The reviewer takes runs oldest first; a fresh solver attempt is moved to the front so --max never skips it.
          const ordered = solver ? [{ ...runs.at(-1)!, startedAt: -Infinity }, ...runs.slice(0, -1)] : runs;
          result = await crossCheckVerifier({ task, runs: ordered, blobs: ctx.blobs, provider, max, signal: c.signal });
        } finally {
          spin.stop();
        }
        // Shared with `judge calibrate --grader <verifier>` (EM-11): the same counts, source "blind-solver".
        const updated: EvalTask = { ...task, meta: { ...(task.meta ?? {}), crossCheck: crossCheckMeta(result) } };
        if (result.checked) await ctx.index.putTask(updated);
        const coupling = task.validation?.coupling ?? [];
        if (out.json) out.data({ outcome: result.checked ? "checked" : "nothing_checked", crossCheck: result, coupling });
        else out.print(formatCrossCheck(result, coupling));
        return result.checked && !result.errors.length ? 0 : 1;
      }
      case "audit": {
        const task = await getTask(ctx, c.positionals[0]!);
        const experimentId = str(c.flags.experiment);
        if (!experimentId) throw new UsageError("Missing --experiment <ID>: an audit replays one experiment's passing runs", { reason: "missing_argument" });
        const witnessArg = str(c.flags.witness);
        const witnessCmd = str(c.flags["witness-cmd"]);
        if (!!witnessArg !== !!witnessCmd) throw new UsageError("--witness <FILE> and --witness-cmd <CMD> go together: the test file and the command that runs it", { reason: "missing_argument" });
        const runs = await ctx.index.listRuns({ taskId: task.id, experimentId });
        if (!runs.length) throw new CliError(`No runs of ${task.name} in experiment ${experimentId}`, { reason: "not_found", next: ["List experiments:", "coding.sh exp list"] });
        const workRoot = await mkdtemp(join(tmpdir(), "codingsh-audit-"));
        try {
          let current = task;
          let fresh: { witness: Witness; confirm: ConfirmWitnessResult } | undefined;
          if (witnessArg && witnessCmd) {
            const { path, file } = witnessPaths(witnessArg, c.cwd);
            let data: Uint8Array;
            try {
              data = await readFile(file);
            } catch {
              throw new UsageError(`Can't read --witness ${file}`, { reason: "invalid_value" });
            }
            const witness: Witness = {
              id: witnessId(path, data, witnessCmd),
              path,
              blob: await ctx.blobs.put(data),
              command: witnessCmd,
              requirement: str(c.flags.requirement) ?? "",
              source: "manual",
              status: "confirmed",
              createdAt: Date.now(),
            };
            const spin = out.spin(`Checking ${path} passes the reference…`);
            let confirm: ConfirmWitnessResult;
            try {
              confirm = await confirmWitness({ task, witness, blobs: ctx.blobs, workRoot, signal: c.signal });
            } finally {
              spin.stop();
            }
            fresh = { witness, confirm };
            if (!confirm.ok) {
              if (out.json) out.data({ outcome: "witness_rejected", task: task.id, experimentId, witness: { path, command: witnessCmd }, confirm });
              else {
                out.fail(`Witness ${path} rejected: ${confirm.error}`);
                if (confirm.tail) out.print(confirm.tail);
              }
              return 1;
            }
            current = withWitnesses(current, [witness]);
          }
          const witnesses = taskWitnesses(current).filter((w) => w.status === "confirmed");
          if (!witnesses.length) {
            throw new CliError(`${task.name} has no witnesses yet`, { reason: "missing_argument", next: ["Give it one:", `coding.sh eval audit ${task.id} --experiment ${experimentId} --witness <FILE> --witness-cmd <CMD>`] });
          }
          const spin = out.spin(`Replaying ${witnesses.length} witness(es) on the passing runs…`);
          let report: AuditReport;
          try {
            report = await replayWitnesses({ task: current, runs, witnesses, blobs: ctx.blobs, workRoot, experimentId, countAmbiguous: c.flags["count-ambiguous"] === true, signal: c.signal });
          } finally {
            spin.stop();
          }
          current = withAudit(current, experimentId, report);
          let notes: string[] = [];
          if (c.flags.promote === true) ({ task: current, notes } = promoteWitnesses(current, report.witnesses));
          await ctx.index.putTask(current);
          const names = new Map<string, string>();
          for (const a of auditArms(report, runs)) {
            const b = await ctx.index.getBundle(a.bundleId);
            names.set(a.bundleId, b ? `${b.name} (${a.bundleId.slice(0, 8)})` : a.bundleId.slice(0, 8));
          }
          if (out.json) {
            out.data({
              outcome: "audited",
              task: task.id,
              experimentId,
              ...(fresh ? { witness: { id: fresh.witness.id, path: fresh.witness.path, command: fresh.witness.command, confirm: fresh.confirm } } : {}),
              arms: auditArms(report, runs),
              report,
              ...(c.flags.promote === true ? { promoted: report.witnesses, verifier: current.verifier.command } : {}),
              notes,
            });
            return 0;
          }
          if (fresh) out.ok(`Witness ${fresh.witness.path} passes the reference ${fresh.confirm.refPassed}/${fresh.confirm.k}${fresh.confirm.noopFails ? " and fails the start" : "; note: it also passes the untouched start"}`);
          out.print(formatAudit(report, runs, witnesses, (b) => names.get(b) ?? b.slice(0, 8)));
          for (const n of notes) out.note(n);
          return 0;
        } finally {
          await rm(workRoot, { recursive: true, force: true });
        }
      }
      case "list": {
        const status = str(c.flags.status) as EvalTask["status"] | undefined;
        const tag = str(c.flags.tag);
        const tasks = await ctx.index.listTasks({ ...(status ? { status } : {}), ...(tag ? { tag } : {}) });
        if (out.json) {
          out.data({ tasks: tasks.map(taskJson) });
          return 0;
        }
        if (!tasks.length) {
          out.note("No tasks");
          out.next("Draft one from a session", "coding.sh eval new latest");
          return 0;
        }
        out.table(
          ["ID", "NAME", "STATUS", "CREATED", "REPO"],
          tasks.map((t) => [t.id, oneLine(clean(t.name), 50), t.status, ago(t.createdAt), t.start.repoRoot]),
        );
        return 0;
      }
      case "import": {
        if (!c.positionals.length) throw new UsageError("Missing argument <DIR>. Usage: coding.sh eval import <DIR>...", { reason: "missing_argument" });
        const imported: EvalTask[] = [];
        for (const arg of c.positionals) {
          const dir = resolve(c.cwd, arg);
          let task: EvalTask;
          try {
            task = await importDir(dir, ctx, c.env);
          } catch (e) {
            throw new CliError(`Couldn't import ${arg}: ${e instanceof Error ? e.message : String(e)}`, { reason: "invalid_file" });
          }
          await ctx.index.putTask(task);
          imported.push(task);
        }
        const warnings = imported.flatMap((t) => verifierPathWarnings(t).map((w) => `${t.name}: ${w}`));
        if (out.json) {
          out.data({ outcome: "imported", tasks: imported.map(taskJson), ...(warnings.length ? { warnings } : {}) });
          return 0;
        }
        for (const t of imported) out.ok(`${t.name}  ${t.id}`);
        for (const w of warnings) out.warn(w);
        out.next("Run them in a harness A/B", `coding.sh compare <A> <B>${imported[0]?.tags[0] ? ` --tag ${imported[0].tags[0]}` : ` --task ${imported[0]?.id}`}`);
        return 0;
      }
      case "export": {
        const task = await getTask(ctx, c.positionals[0]!);
        const outDir = str(c.flags.out);
        if (!outDir) throw new UsageError("Missing --out <DIR>", { reason: "missing_argument" });
        const dir = resolve(c.cwd, outDir);
        if (existsSync(dir) && readdirSync(dir).length && c.flags.force !== true) {
          throw new CliError(`Can't export to ${dir}: the directory is not empty`, { reason: "conflict", askUser: true, next: ["Replace its contents (deletes what is there):", `coding.sh eval export ${task.id} --out ${outDir} --force`] });
        }
        const format = str(c.flags.format) ?? "coding.sh";
        // The source session as an ATIF-v1.8 trajectory: the whole export for atif, solution/trajectory.json for harbor.
        let trajectory: unknown;
        if ((format === "atif" || format === "harbor") && task.sourceSessionId && (await ctx.index.getSession(task.sourceSessionId))) {
          const { atifFromStore } = await import("../../eval/atif.ts");
          const { createRedactor } = await import("../../core/redact.ts");
          const cfg = ctx.config.capture;
          trajectory = await atifFromStore(ctx.index, task.sourceSessionId, { redactor: createRedactor({ redact: cfg.redact, patterns: cfg.redactPatterns, env: c.env }), ...(cfg.mode === "metadata" ? { mode: "metadata" as const } : {}) });
        }
        if (format === "atif" && !trajectory) {
          throw new CliError(`${task.name} has no source session in the store to export as a trajectory`, { reason: "not_found", next: ["Export the task itself:", `coding.sh eval export ${task.id} --out ${outDir} --format harbor`] });
        }
        const replaced = existsSync(dir) && readdirSync(dir).length > 0;
        if (replaced) await rm(dir, { recursive: true, force: true });
        if (format === "harbor") await exportHarbor(task, dir, ctx.blobs, trajectory ? { trajectory } : {});
        else if (format === "atif") {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "trajectory.json"), `${JSON.stringify(trajectory, null, 2)}\n`);
        } else await exportTaskDir(task, dir, ctx.blobs, { materializeStart: (start, dest) => materialize({ root: start.repoRoot, head: start.head, snapshot: start.snapshot }, dest, c.env) });
        if (out.json) out.data({ outcome: replaced ? "replaced" : "exported", task: task.id, path: dir, format: str(c.flags.format) ?? "coding.sh" });
        else {
          if (replaced) out.row("Replaced", dir);
          out.print(dir);
        }
        return 0;
      }
    }
    throw new UsageError(`Unknown eval command ${c.action}`);
  }, { create: c.action !== "list" && c.action !== "export" });
}
