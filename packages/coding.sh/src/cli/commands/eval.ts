// coding.sh eval new|import|validate|crosscheck|audit|list|export
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { paths } from "../../core/paths.ts";
import { snapshotDir } from "../../core/snapshot.ts";
import type { EvalTask, RunResult } from "../../core/types.ts";
import { crossCheckMeta, crossCheckVerifier, DEFAULT_CROSSCHECK_MAX, formatCrossCheck } from "../../eval/crosscheck.ts";
import { draftTaskFromSession, exportHarbor, exportTaskDir, importTaskDir, readInstructionArg } from "../../eval/task.ts";
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
import { providerFromSpec, type LlmProviderSpec } from "../../graders/index.ts";
import { positiveInt, UsageError } from "../args.ts";
import { autoIngest, jsonArg, list, oneLine, resolveSession, resolveTask, str, withContext } from "../common.ts";
import { ago, CliError, clean } from "../output.ts";
import type { CommandContext } from "../types.ts";
import type { Context } from "../../core/context.ts";

/** By id or unique name. */
const getTask = (ctx: Context, ref: string): Promise<EvalTask> => resolveTask(ctx, ref);

/**
 * One task dir: an exported task (task.json with a start snapshot), or a
 * hand-written one whose repo/ dir is the start tree (none: an empty tree).
 */
async function importDir(dir: string, ctx: Context, env: NodeJS.ProcessEnv): Promise<EvalTask> {
  if (!existsSync(join(dir, "task.json"))) throw new Error("no task.json in it");
  const repo = join(dir, "repo");
  let start: EvalTask["start"] | undefined;
  if (existsSync(repo)) start = await snapshotDir(repo, env);
  else {
    const json = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as { start?: { snapshot?: string } };
    if (!json.start?.snapshot) {
      const empty = join(paths(env).repos, "empty-start");
      await mkdir(empty, { recursive: true });
      start = await snapshotDir(empty, env);
    }
  }
  return importTaskDir(dir, ctx.blobs, start ? { start } : {});
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
  return withContext(c, async (ctx) => {
    switch (c.action) {
      case "new": {
        await autoIngest(ctx);
        const s = await resolveSession(ctx, c.positionals[0]!);
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
            ...(name ? { name } : {}),
            ...(instruction ? { instruction } : {}),
            ...(verifier ? { verifierCommand: verifier } : {}),
            ...(list(c.flags.setup).length ? { setup: list(c.flags.setup) } : {}),
            ...(list(c.flags["hidden-test"]).length ? { hiddenTests: list(c.flags["hidden-test"]) } : {}),
            ...(list(c.flags.tag).length ? { tags: list(c.flags.tag) } : {}),
          });
        } catch (e) {
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
        for (const n of notes.slice(0, 5)) out.warn(n);
        out.print(task.id);
        out.next("Check the task is fair before using it", `coding.sh eval validate ${task.id}`);
        return 0;
      }
      case "validate": {
        const task = await getTask(ctx, c.positionals[0]!);
        const k = positiveInt(c.flags.k, "k") ?? 5;
        const workRoot = await mkdtemp(join(tmpdir(), "codingsh-validate-"));
        const spin = out.spin("Validating…");
        try {
          const o = await validateTask({
            task,
            blobs: ctx.blobs,
            workRoot,
            k,
            index: ctx.index,
            keep: c.flags.keep === true,
            strictCoupling: c.flags["strict-coupling"] === true,
            signal: c.signal,
            onStep: (st) => out.note(`${st.label}: ${st.pass ? "pass" : "fail"}`),
          });
          spin.stop();
          if (out.json) out.data({ outcome: o.report.ok ? "validated" : "rejected", task: taskJson(o.task), report: o.report, errors: o.errors, notes: o.notes });
          else {
            out.print(formatValidation(o));
            if (o.report.ok) out.ok(`${task.id} validated`);
            else out.fail(`${task.id} did not validate`);
          }
          return o.report.ok ? 0 : 1;
        } finally {
          spin.stop();
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
          const spin = out.spin(`Solving ${task.name} with ${bundle.name}…`);
          try {
            runs.push(await runTask({ task, bundle, adapter, blobs: ctx.blobs, index: ctx.index, signal: c.signal, ingest: () => ctx.ingest() }));
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
        if (out.json) {
          out.data({ outcome: "imported", tasks: imported.map(taskJson) });
          return 0;
        }
        for (const t of imported) out.ok(`${t.name}  ${t.id}`);
        out.next("Run them in a harness A/B", `coding.sh compare <A> <B>${imported[0]?.tags[0] ? ` --tag ${imported[0].tags[0]}` : ` --task ${imported[0]?.id}`}`);
        return 0;
      }
      case "export": {
        const task = await getTask(ctx, c.positionals[0]!);
        const outDir = str(c.flags.out);
        if (!outDir) throw new UsageError("Missing --out <DIR>", { reason: "missing_argument" });
        const dir = resolve(c.cwd, outDir);
        if (existsSync(dir) && readdirSync(dir).length && c.flags.force !== true) {
          throw new CliError(`Can't export to ${dir}: the directory is not empty`, { reason: "conflict", next: ["Replace its contents:", `coding.sh eval export ${task.id} --out ${outDir} --force`] });
        }
        const replaced = existsSync(dir) && readdirSync(dir).length > 0;
        if (replaced) await rm(dir, { recursive: true, force: true });
        if (str(c.flags.format) === "harbor") await exportHarbor(task, dir, ctx.blobs);
        else await exportTaskDir(task, dir, ctx.blobs);
        if (out.json) out.data({ outcome: replaced ? "replaced" : "exported", task: task.id, path: dir, format: str(c.flags.format) ?? "coding.sh" });
        else {
          if (replaced) out.row("Replaced", dir);
          out.print(dir);
        }
        return 0;
      }
    }
    throw new UsageError(`Unknown eval command ${c.action}`);
  });
}
