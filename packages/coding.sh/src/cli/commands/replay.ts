// coding.sh replay <session>: the session as numbered steps, and the files the
// agent touched as of any step, rebuilt from its own tool calls (core/replay.ts).
// No flags: the step list. --step N: what step N did (command and output,
// diffs, the touched files). --step N --to M: what steps N through M changed
// together. --file: one file's content as of the step.
import { createRedactor } from "../../core/redact.ts";
import { loadReplay, snapshotBaseline, type Replay, type ReplayStep, type StepChange, type RangeFile } from "../../core/replay.ts";
import { UsageError, positiveInt } from "../args.ts";
import { autoIngest, oneLine, resolveSession, str, withContext } from "../common.ts";
import { clean, duration, plural, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";

const OUTPUT_LINES = 40;
const TEXT_LINES = 30;

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const step = positiveInt(c.flags.step, "step");
  const to = positiveInt(c.flags.to, "to");
  const file = str(c.flags.file);
  return withContext(c, async (ctx) => {
    await autoIngest(ctx);
    const s = await resolveSession(ctx, c.positionals[0]!);
    const redactor = createRedactor({ redact: ctx.config.capture.redact, patterns: ctx.config.capture.redactPatterns, env: ctx.env });
    const replay = await loadReplay(ctx, s, { baseline: snapshotBaseline(s, ctx.env, redactor) });
    const total = replay.steps.length;
    const check = (n: number, flag: string) => {
      if (n > total) throw new UsageError(`--${flag} ${n} is past the last step (${plural(total, "step")})`);
      return n;
    };
    if (to !== undefined) {
      const range = await replay.range(check(step ?? 1, "step"), check(to, "to"));
      if (out.json) return out.data(range), 0;
      printRange(out, replay, range.from, range.to, range.files, range.unchanged);
      return 0;
    }
    if (step === undefined && file === undefined) {
      const index = replay.index();
      if (out.json) return out.data(index), 0;
      printIndex(out, replay, s.title ?? s.id);
      return 0;
    }
    if (!total) throw new UsageError("This session has no steps to replay");
    const n = check(step ?? total, "step");
    const view = await replay.at(n, { file });
    if (out.json) return out.data(view), 0;
    if (file !== undefined) {
      printFile(out, view.file!, n);
      return 0;
    }
    printStep(out, replay, view);
    return 0;
  });
}

function ok(out: Output, st: ReplayStep): string {
  if (st.ok === true) return out.style("✓", "green");
  if (st.ok === false) return out.style("✗", "red");
  return " ";
}

function stepLine(out: Output, st: ReplayStep, width: number): string {
  const dur = st.durationMs !== undefined ? duration(st.durationMs) : "";
  return `${String(st.n).padStart(width)}  ${st.kind.padEnd(8)} ${ok(out, st)} ${dur.padStart(6)}  ${oneLine(clean(st.label), 100)}`;
}

function printIndex(out: Output, replay: Replay, title: string): void {
  const idx = replay.index();
  out.print(out.style(oneLine(clean(title), 100), "bold"));
  out.print(out.style(`${plural(idx.steps.length, "step")}, ${plural(idx.files.length, "file")} touched${idx.baseline === "snapshot" ? ", start snapshot" : ""}`, "faint"));
  out.print();
  const w = String(idx.steps.length).length;
  for (const st of idx.steps) out.print(stepLine(out, st, w));
  if (!idx.steps.length) return;
  const tree = replay.tree(idx.steps.length);
  if (tree.length) {
    out.print();
    out.print(out.style("Files", "bold"));
    for (const f of tree) out.print(`  ${treeMark(out, f.status)} ${f.path}  ${out.style(f.edits ? `${plural(f.edits, "change")}, last touched at step ${f.lastStep}` : `read at step ${f.lastStep}`, "faint")}`);
  }
  const firstEdit = idx.steps.find((s) => s.files?.some((f) => f.op !== "read"));
  out.next("See what a step did", `coding.sh replay ${replay.session.id.slice(0, 8)} --step ${firstEdit?.n ?? 1}`);
}

function treeMark(out: Output, status: string): string {
  if (status === "added") return out.style("A", "green");
  if (status === "deleted") return out.style("D", "red");
  if (status === "modified") return out.style("M", "yellow");
  return out.style("R", "faint");
}

function printDiff(out: Output, diff: string): void {
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const l = clean(line);
    if (l.startsWith("+++") || l.startsWith("---")) out.print(out.style(l, "bold"));
    else if (l.startsWith("+")) out.print(out.style(l, "green"));
    else if (l.startsWith("-")) out.print(out.style(l, "red"));
    else if (l.startsWith("@@") || l.startsWith("# step")) out.print(out.style(l, "cyan"));
    else out.print(l);
  }
}

function clip(out: Output, text: string, max: number, indent = "  "): void {
  const lines = clean(text).replace(/\n$/, "").split("\n");
  for (const l of lines.slice(0, max)) out.print(indent + l);
  if (lines.length > max) out.print(out.style(`${indent}… ${plural(lines.length - max, "more line", "more lines")} (--json for all)`, "faint"));
}

function printChange(out: Output, ch: StepChange | RangeFile): void {
  if (ch.diff) printDiff(out, ch.diff);
  else out.print(out.style(`${ch.op} ${ch.path}: no diff recorded`, "faint"));
  if (ch.diffTruncated) out.print(out.style("  (diff cut short)", "faint"));
  if (!ch.exact && ch.diff) out.print(out.style("  The diff above is the change as the agent recorded it, without the whole file around it.", "faint"));
  if (ch.why) out.print(out.style(`  Content after this unknown: ${ch.why}`, "yellow"));
}

function printStep(out: Output, replay: Replay, view: Awaited<ReturnType<Replay["at"]>>): void {
  const st = view.step;
  const head = `Step ${st.n} of ${view.steps}  ${st.kind}${st.tool ? ` (${st.tool})` : ""}`;
  out.print(out.style(head, "bold") + (st.ok !== undefined ? `  ${ok(out, st)}` : "") + (st.durationMs !== undefined ? `  ${duration(st.durationMs)}` : ""));
  if (st.kind !== "shell") out.print(oneLine(clean(st.label), 120));
  const d = view.detail;
  if (d.shell) {
    out.print();
    out.print(out.style(`$ ${clean(d.shell.command)}`, "cyan"));
    const facts = [d.shell.exitCode !== undefined ? `exit ${d.shell.exitCode}` : d.shell.ok === false ? "failed" : d.shell.ok === true ? "ok" : "no result recorded", d.shell.durationMs !== undefined ? duration(d.shell.durationMs) : ""].filter(Boolean);
    out.print(out.style(facts.join(" · "), "faint"));
    if (d.shell.output) clip(out, d.shell.output, OUTPUT_LINES);
    if (d.shell.outputTruncated) out.print(out.style("  (output cut short when stored; --json has the blob ref)", "faint"));
  } else if (d.text !== undefined) {
    out.print();
    clip(out, d.text, TEXT_LINES);
  } else if (d.output !== undefined && st.kind !== "edit") {
    out.print();
    clip(out, d.output, 12);
  }
  if (view.changes.length) {
    out.print();
    out.print(out.style(`Changes (${view.changes.length})`, "bold"));
    for (const ch of view.changes) {
      if (ch.resynced) out.print(out.style(`  ${ch.path} differed from the replay here; this read shows what changed outside the edit tools.`, "faint"));
      printChange(out, ch);
    }
  }
  if (view.tree.length) {
    out.print();
    out.print(out.style(`Files as of step ${st.n}`, "bold"));
    for (const f of view.tree) out.print(`  ${treeMark(out, f.status)} ${f.path}${f.here ? out.style("  ← this step", "cyan") : ""}`);
  }
  const touched = view.tree.find((f) => f.here && f.status !== "read") ?? view.tree.find((f) => f.here);
  if (touched) out.next("See the whole file at this step", `coding.sh replay ${replay.session.id.slice(0, 8)} --step ${st.n} --file ${touched.path}`);
}

function printFile(out: Output, f: NonNullable<Awaited<ReturnType<Replay["at"]>>["file"]>, n: number): void {
  if (f.content === undefined) {
    out.print(out.style(`${f.path} as of step ${n}: content unknown`, "bold"));
    out.print(f.why ?? "No step showed its content.");
    return;
  }
  if (f.exists === false) {
    out.print(out.style(`${f.path} does not exist as of step ${n}${f.changedAt ? ` (deleted at step ${f.changedAt})` : ""}`, "bold"));
    return;
  }
  out.print(out.style(`${f.path} as of step ${n}${f.changedAt ? `, last changed at step ${f.changedAt}` : ", unchanged so far"}`, "faint"));
  out.print(clean(f.content).replace(/\n$/, ""));
  if (f.contentTruncated) out.print(out.style("(cut at 1 MiB)", "faint"));
  if (f.approxEol) out.print(out.style("(rebuilt from a numbered read: the final newline is assumed)", "faint"));
}

function printRange(out: Output, replay: Replay, from: number, to: number, files: RangeFile[], unchanged: string[]): void {
  out.print(out.style(`Steps ${from} to ${to} of ${replay.steps.length}: ${plural(files.length, "file")} changed`, "bold"));
  if (unchanged.length) out.print(out.style(`Changed and then restored: ${unchanged.join(", ")}`, "faint"));
  for (const f of files) {
    out.print();
    out.print(out.style(`${f.op} ${f.path}  (${f.steps.length === 1 ? "step" : "steps"} ${f.steps.join(", ")})`, "faint"));
    printChange(out, f);
  }
}
