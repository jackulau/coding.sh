// Blind judging of each run's final reply with coding.sh's own judges (provider claude-code).
//   node analysis/judge.ts <out-dir> <tasks-dir> [model]
// <out-dir> holds runs.json ({run, arm, task, attempt}[]) and answers/<run>.txt.
// Writes <out-dir>/judge.json: a clarity score per run (pointwise) and a verdict per
// (task, attempt) pair (pairwise, in both orders so position bias cancels).
// Imports the judge from coding.sh's source, which the image keeps in $CODING_SH_SRC.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const src = process.env.CODING_SH_SRC ?? "/opt/coding.sh-src";
const { createGrader } = await import(join(src, "graders/index.ts"));
const { claudeCodeProvider, createPairwiseJudge } = await import(join(src, "judge/index.ts"));

const [dir, tasksDir, model = "claude-sonnet-5-5"] = process.argv.slice(2) as [string, string, string?];
type Run = { run: string; arm: string; task: string; attempt: number; superseded?: boolean };
const runs = (JSON.parse(readFileSync(join(dir, "runs.json"), "utf8")) as Run[]).filter((r) => !r.superseded);
const instruction = (task: string) => readFileSync(join(tasksDir, task.replace(/^ab-/, ""), "instruction.md"), "utf8").trim();
const answer = (run: string) => {
  const p = join(dir, "answers", `${run}.txt`);
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
};

const RUBRIC = `You are grading the final reply a coding agent sent to the developer who gave it the task (the input). Judge the reply only as that developer will read it.
Ask: reading it once, does the developer understand what was wrong or what changed, why, and what (if anything) they must do next, without needing a follow-up question?
Reward: correct, specific and complete answers to what was asked; replies that are quick to read and easy to scan.
Penalize: missing, vague or wrong key facts; ambiguity; clipped fragments or dropped words that make the reader reread or guess; padding that adds no information.
Length and politeness earn nothing by themselves.
Score 1.0 for a reply a strong senior engineer would send as is, 0.5 for one that is usable but needs rereading or a follow-up, 0 for one that is unclear or wrong.`;

const grader = await createGrader({ kind: "llm", name: "reply-clarity", rubric: RUBRIC, provider: "claude-code", model, passThreshold: 0.7 });
const pair = createPairwiseJudge({
  name: "reply-clarity-pairwise",
  rubric: `${RUBRIC}\nPick the reply that serves the developer better by this standard. Say tie only when they are equally good.`,
  provider: claudeCodeProvider({ model }),
});

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k] as T);
      }
    }),
  );
  return out;
}

async function retry<R>(fn: () => Promise<R>, fail: (e: unknown) => R): Promise<R> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === 2) return fail(e);
    }
  }
}
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

const point = await pool(runs, 4, async (r) => {
  const out = answer(r.run);
  if (!out) return { ...r, score: null, error: "no answer" };
  return retry(
    async () => {
      const v = await grader.grade({ input: instruction(r.task), output: out });
      return { ...r, score: v.score, pass: v.pass, reason: v.reason };
    },
    (e) => ({ ...r, score: null, error: msg(e) }),
  );
});
process.stderr.write(`pointwise: ${point.filter((p) => p.score !== null).length}/${point.length}\n`);

const keys = [...new Set(runs.map((r) => `${r.task}#${r.attempt}`))].sort();
const pairs = await pool(keys, 2, async (key) => {
  const [task, att] = key.split("#") as [string, string];
  const side = (arm: string) => runs.find((r) => r.task === task && r.attempt === Number(att) && r.arm === arm);
  const a = side("base");
  const b = side("plugin");
  if (!a || !b || !answer(a.run) || !answer(b.run)) return { task, attempt: Number(att), winner: null, error: "missing side" };
  return retry(
    async () => {
      const v = await pair.compare({ input: instruction(task), a: answer(a.run), b: answer(b.run), caseId: key });
      return { task, attempt: Number(att), winner: v.winner, orders: v.orders, consistent: v.consistent, reasons: v.reasons };
    },
    (e) => ({ task, attempt: Number(att), winner: null, error: msg(e) }),
  );
});
writeFileSync(join(dir, "judge.json"), JSON.stringify({ model, rubric: RUBRIC, graderVersion: grader.version, point, pairs }, null, 2));
process.stderr.write(`pairwise: ${pairs.filter((p) => p.winner).length}/${pairs.length}\n`);
