// The refine proposer (R2-7): a prompt from the findings, the target file, its
// protected lines (READ-ONLY, Z-13) and the edits rejected before, and a parser
// for the model's reply. A proposal is a bounded delta: at most 40 lines,
// appended to the target inside a marked block, so it never rewrites or deletes
// what is there:
//
//   <!-- coding.sh:refine r_3f9a1c02e1 begin -->
//   - Run the tests before you say a change is done.
//   <!-- coding.sh:refine r_3f9a1c02e1 end -->
//
// The block id is the candidate id (candidateId): a hash of the candidate's
// files with every refine block id blanked, so the id inside the text and the
// id of the text agree. Everything sent to the model goes through the
// redactor. Pure apart from hashing.
import { createHash } from "node:crypto";
import { createRedactor } from "../core/redact.ts";
import type { Finding } from "./findings.ts";
import type { MinedFinding } from "./mine.ts";
import { readOnlySection, type HarnessText, type ProtectedLine } from "./protect.ts";

export const MAX_PROPOSAL_LINES = 40;
const MAX_LINE_CHARS = 400;

export interface Proposal {
  lines: string[];
  rationale: string;
}

/** The reply the proposer asks for (providers with structured outputs enforce it). */
export const PROPOSAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    lines: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
  },
  required: ["lines", "rationale"],
  additionalProperties: false,
};

/** An edit tested and not kept, as the proposer sees it. */
export interface RejectedEdit {
  id: string;
  verdict: string;
  reasons: readonly string[];
  /** Lines it added. */
  added: readonly string[];
  /** AE-2, from the ledger: task ids the edit fixed (the base never passed them), */
  fixed?: readonly string[];
  /** made worse (pass rate fell), */
  regressed?: readonly string[];
  /** and left failing (neither arm passed). */
  stillFailing?: readonly string[];
}

/** The PROPOSER_SYSTEM sentence added when the prompt carries per-task reflection (AE-2). */
export const REFLECTION_RULE = "- Aim the new lines at the tasks earlier edits left failing, and never bring back what made a task regress.";

const MAX_REFLECT_IDS = 10;
const idList = (xs: readonly string[]): string => (xs.length > MAX_REFLECT_IDS ? `${xs.slice(0, MAX_REFLECT_IDS).join(", ")} +${xs.length - MAX_REFLECT_IDS} more` : xs.join(", "));

/** "- r_…: fixed t1; still failing t3; regressed t2" for each rejected edit with per-task outcomes; undefined when none has any. */
export function reflectionSection(rejected: readonly RejectedEdit[]): string | undefined {
  const lines: string[] = [];
  for (const r of rejected) {
    const parts: string[] = [];
    if (r.fixed?.length) parts.push(`fixed ${idList(r.fixed)}`);
    if (r.stillFailing?.length) parts.push(`still failing ${idList(r.stillFailing)}`);
    if (r.regressed?.length) parts.push(`regressed ${idList(r.regressed)}`);
    if (parts.length) lines.push(`- ${r.id}: ${parts.join("; ")}`);
  }
  return lines.length ? ["What your earlier edits changed, per task (help the still-failing tasks; never reintroduce a regression):", ...lines].join("\n") : undefined;
}

export const PROPOSER_SYSTEM = `You improve the instruction file a coding agent reads at the start of every session (CLAUDE.md, AGENTS.md, a rule or a skill).
You get the failure patterns seen in the agent's recent sessions, the file as it is, the lines you may not touch, and edits that were tested before and not kept.
Write new lines that would stop the most severe pattern. They are appended to the file inside a marked block; you cannot change or delete existing lines.
Rules:
- At most ${MAX_PROPOSAL_LINES} lines, plain markdown, short imperative sentences. Fewer lines is better.
- General guidance only: no file paths, identifiers or strings taken from one session.
- Never tell the agent to skip, disable or edit tests, CI or verifiers, to use --no-verify or force-push, to broaden permissions, or to make checks pass by any means.
- Never contradict, weaken or add an exception to a READ-ONLY line.
- Do not repeat a line the file already has, or an edit listed as not kept.
Reply with JSON only: {"lines": ["..."], "rationale": "..."}. The rationale says which pattern the lines address and why they should help, in one or two sentences.`;

const MAX_REJECTED = 20;

function findingLines(f: Finding): string[] {
  const s = f.diagnosis.severity;
  const out = [`- ${f.flag}: ${s.level} severity ${s.score}/100 (${f.diagnosis.nature}; ${f.diagnosis.typeIds.join(", ")}); ${f.support.sessions} of ${f.analyzed} sessions over ${f.support.days} day${f.support.days === 1 ? "" : "s"}`];
  for (const e of f.examples) if (e.title) out.push(`  e.g. "${e.title.replace(/\s+/g, " ").slice(0, 160)}"`);
  return out;
}

/** Mined patterns (`refine mine --json`) as prompt lines: the pattern, its evidence count and support. */
function minedLines(xs: readonly MinedFinding[]): string[] {
  return xs.map((f) => `- ${f.kind}: ${f.label.replace(/\s+/g, " ").slice(0, 200)} (${f.count}x in ${f.support.sessions} sessions over ${f.support.days} day${f.support.days === 1 ? "" : "s"})`);
}

/** The proposer's system and user prompt. The user prompt is redacted. */
export function proposalPrompt(o: { findings: readonly Finding[]; target: HarnessText; protectedLines: readonly ProtectedLine[]; rejected?: readonly RejectedEdit[]; mined?: readonly MinedFinding[] }): { system: string; user: string } {
  const parts: string[] = [];
  parts.push(o.findings.length ? ["Failure patterns in recent sessions, most severe first:", ...o.findings.flatMap(findingLines)].join("\n") : "No session flags were found. Propose lines that make the agent verify its work before it says it is done.");
  parts.push(`The file to extend, ${o.target.path}:\n<file path="${o.target.path}">\n${o.target.text}\n</file>`);
  if (o.mined?.length) parts.push(["Patterns mined across sessions (refine mine), most frequent first:", ...minedLines(o.mined.slice(0, 10))].join("\n"));
  const ro = readOnlySection(o.protectedLines.filter((p) => p.path === o.target.path));
  if (ro) parts.push(ro);
  const rejected = (o.rejected ?? []).slice(-MAX_REJECTED);
  if (rejected.length) {
    parts.push(
      [
        "Tested before and not kept (do not propose these again):",
        ...rejected.map((r) => `- ${r.id} (${r.verdict}: ${r.reasons.join("; ") || "no reason recorded"})${r.added.length ? `\n${r.added.slice(0, 8).map((l) => `    + ${l}`).join("\n")}` : ""}`),
      ].join("\n"),
    );
  }
  const reflect = reflectionSection(rejected);
  if (reflect) parts.push(reflect);
  return { system: reflect ? PROPOSER_SYSTEM.replace("\nReply with JSON only", `\n${REFLECTION_RULE}\nReply with JSON only`) : PROPOSER_SYSTEM, user: createRedactor().string(parts.join("\n\n")) };
}

/** The JSON object in a reply (bare, or inside a code fence or prose). */
function jsonIn(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1];
    const body = fence ?? t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
    return JSON.parse(body);
  }
}

/** The model's reply as a proposal; throws with a plain reason when it is not one. */
export function parseProposal(text: string): Proposal {
  let v: unknown;
  try {
    v = jsonIn(text);
  } catch {
    throw new Error("the reply is not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("the reply is not a JSON object");
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.lines) || !o.lines.every((l) => typeof l === "string")) throw new Error('"lines" must be an array of strings');
  const lines = (o.lines as string[]).flatMap((l) => l.split(/\r?\n/)).map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (!lines.length) throw new Error("the proposal adds no lines");
  if (lines.length > MAX_PROPOSAL_LINES) throw new Error(`the proposal adds ${lines.length} lines, more than ${MAX_PROPOSAL_LINES}`);
  const long = lines.find((l) => l.length > MAX_LINE_CHARS);
  if (long !== undefined) throw new Error(`a line is longer than ${MAX_LINE_CHARS} characters`);
  if (lines.some((l) => /<!--|-->/.test(l))) throw new Error("the proposal contains an HTML comment (markers are added by coding.sh)");
  return { lines, rationale: typeof o.rationale === "string" ? o.rationale.trim() : "" };
}

const BLOCK_ID = /(<!--\s*coding\.sh:refine\s+)r_[0-9a-f]{10}(\s+(?:begin|end)\s*-->)/g;
const PLACEHOLDER = "r_0000000000";

/** "r_" + 10 hex: sha256 over the files (path-sorted), refine block ids blanked. */
export function candidateId(files: readonly HarnessText[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(`${f.path}\u0000${f.text.replace(BLOCK_ID, `$1${PLACEHOLDER}$2`)}\u0000`);
  return `r_${h.digest("hex").slice(0, 10)}`;
}

/** `text` with the lines appended in a marked block. */
export function withRefineBlock(text: string, id: string, lines: readonly string[]): string {
  const head = text.replace(/\s+$/, "");
  return `${head}${head ? "\n\n" : ""}<!-- coding.sh:refine ${id} begin -->\n${lines.join("\n")}\n<!-- coding.sh:refine ${id} end -->\n`;
}

/** The candidate a proposal makes: the target with the block appended, and its id. */
export function proposalCandidate(target: HarnessText, p: Proposal): { id: string; file: HarnessText } {
  const draft = { path: target.path, text: withRefineBlock(target.text, PLACEHOLDER, p.lines) };
  const id = candidateId([draft]);
  return { id, file: { path: target.path, text: withRefineBlock(target.text, id, p.lines) } };
}
