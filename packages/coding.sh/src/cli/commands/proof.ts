// coding.sh proof <session>: formal-verification review report for one session.
// Summarizes touched proof and spec files, escape hatches, checker runs, tamper
// findings, verdict and kernel audit hints. --check-disk scans touched proof
// files statically on disk (read-only); --strict exits 1 on tampered/incomplete.
import { attachDiskCheck, buildProofReport, type ProofReport, type ProofVerdict } from "../../core/proof-report.ts";
import { autoIngest, notFoundWithBacklog, oneLine, pendingField, readIngest, resolveSession, withContext } from "../common.ts";
import { clean, duration, plural, type Output, type Style } from "../output.ts";
import type { CommandContext } from "../types.ts";

const VERDICT_STYLE: Record<ProofVerdict, Style> = {
  verified: "green",
  incomplete: "yellow",
  tampered: "red",
  "no-proof": "faint",
};

function formatFileList(files: readonly string[]): string {
  if (!files.length) return "none";
  const head = files.slice(0, 5).join(", ");
  const rest = files.length > 5 ? ` +${files.length - 5} more` : "";
  return `${files.length}: ${head}${rest}`;
}

function formatEscapes(r: ProofReport): string {
  const { added, removed, remaining, kinds } = r.escapes;
  const suffix = kinds.length ? `: ${kinds.join(", ")}` : "";
  return `${remaining} remaining (${added} added, ${removed} removed)${suffix}`;
}

function formatChecks(r: ProofReport): string {
  const c = r.checks;
  if (c.total === 0) return "none";
  const parts = [`${c.total} total (${c.passed} passed, ${c.failed} failed)`];
  if (c.lastOk !== null) parts.push(`last ${c.lastOk ? "ok" : "failed"}`);
  if (c.wholeProject > 0) parts.push(`${c.wholeProject} whole-project`);
  if (c.medianMs !== undefined) parts.push(`median ${duration(c.medianMs)}`);
  return parts.join(", ");
}

function printReport(out: Output, title: string, r: ProofReport): void {
  const badge = out.style(r.verdict, VERDICT_STYLE[r.verdict]);
  out.print(`${out.style(oneLine(clean(title), 90), "bold")}  [${badge}]`);

  const rows: [string, string][] = [
    ["Session", r.sessionId],
    ["Verdict", badge],
    ["Languages", r.langs.length ? r.langs.join(", ") : "none"],
    ["Proof files", formatFileList(r.proofFiles)],
    ["Spec files", r.specUntouched ? "untouched" : `${plural(r.specFilesTouched.length, "file")} touched: ${r.specFilesTouched.slice(0, 5).join(", ")}${r.specFilesTouched.length > 5 ? ` +${r.specFilesTouched.length - 5} more` : ""}`],
    ["Escapes", formatEscapes(r)],
    ["Checks", formatChecks(r)],
  ];

  if (r.diskCheck) {
    const d = r.diskCheck;
    rows.push(["Disk check", `${d.scanned} scanned, ${d.missing} missing, ${plural(d.remainingEscapes.length, "remaining escape")}`]);
  }

  for (const [k, v] of rows) out.print(`  ${k.padEnd(14)}${v}`);

  if (r.tamperFindings.length) {
    out.print();
    out.print(out.style("Tamper findings", "bold"));
    for (const f of r.tamperFindings) {
      const where = f.file ? `${f.file}: ` : "";
      out.print(`  ${out.style("!", "red")} [${f.kind}] ${where}${clean(f.detail)}`);
    }
  }

  if (r.diskCheck?.remainingEscapes.length) {
    out.print();
    out.print(out.style("Disk escapes", "bold"));
    for (const e of r.diskCheck.remainingEscapes) {
      out.print(`  ${out.style("!", "yellow")} ${e.file}:${e.line}  ${e.token}`);
    }
  }

  if (r.verifyHints.length) {
    out.print();
    out.print(out.style("Verify hints", "bold"));
    for (const h of r.verifyHints) out.print(`  ${clean(h)}`);
  }
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const ref = c.positionals[0]!;
  const checkDisk = c.flags["check-disk"] === true;
  const strict = c.flags.strict === true;

  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    let session;
    try {
      session = await resolveSession(ctx, ref);
    } catch (err) {
      throw notFoundWithBacklog(err, backlog);
    }

    const events = await ctx.index.listEvents(session.id);
    let report = buildProofReport(session, events);
    if (checkDisk) {
      report = attachDiskCheck(report, session.repo?.root ?? session.cwd);
    }

    const exitCode = strict && (report.verdict === "tampered" || report.verdict === "incomplete") ? 1 : 0;

    if (out.json) {
      const doc: Record<string, unknown> = { ...report };
      Object.assign(doc, pendingField(backlog));
      out.data(doc);
      return exitCode;
    }

    printReport(out, session.title ?? session.id, report);
    return exitCode;
  }, { create: false });
}
