// coding.sh eval new|validate|list|export
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EvalTask } from "../../core/types.ts";
import { draftTaskFromSession, exportHarbor, exportTaskDir, readInstructionArg } from "../../eval/task.ts";
import { formatValidation, validateTask } from "../../eval/validate.ts";
import { positiveInt, UsageError } from "../args.ts";
import { autoIngest, list, oneLine, resolveSession, resolveTask, str, withContext } from "../common.ts";
import { ago, CliError, clean } from "../output.ts";
import type { CommandContext } from "../types.ts";
import type { Context } from "../../core/context.ts";

/** By id or unique name. */
const getTask = (ctx: Context, ref: string): Promise<EvalTask> => resolveTask(ctx, ref);

function taskJson(t: EvalTask): Record<string, unknown> {
  return { id: t.id, name: t.name, status: t.status, sourceSessionId: t.sourceSessionId ?? null, repo: t.start.repoRoot, verifier: t.verifier, tags: t.tags, createdAt: new Date(t.createdAt).toISOString(), validation: t.validation ?? null };
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
          tasks.map((t) => [t.id, oneLine(clean(t.name), 50), t.status, ago(t.createdAt, { tty: out.stdoutTTY }), t.start.repoRoot]),
        );
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
