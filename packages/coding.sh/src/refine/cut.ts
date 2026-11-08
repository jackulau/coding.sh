// The cut proposer: when a refine climb aims at cost or time (`--objective
// cost`, `wall`, `llm`, `tokens`, `turns` or `size`), the proposer is shown
// what made the suite's runs slow or expensive (drivers.ts) and asked for
// edits that cut it (find/replace, or a whole section by its heading): shorter
// or deleted sections, merged duplicates, steps the agent does not need.
// Unlike the add-only proposer (propose.ts) a cut may delete and reword, so the
// protected-line check and the critics still run on the result before any
// trial: a cut that deletes or relaxes a protected line is rejected there.
//
// Pure apart from hashing; the user prompt goes through the redactor.
import { createRedactor } from "../core/redact.ts";
import { candidateId } from "./propose.ts";
import { readOnlySection, type HarnessText, type ProtectedLine } from "./protect.ts";

export const MAX_CUT_EDITS = 40;

/** One edit: an exact substring (`find`) or a whole section (`section`, its heading line) and what replaces it. */
export interface CutEdit {
  find?: string;
  section?: string;
  replace: string;
}

export interface Cut {
  edits: CutEdit[];
  rationale: string;
}

export const CUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    edits: { type: "array", items: { type: "object", properties: { find: { type: "string" }, section: { type: "string" }, replace: { type: "string" } }, required: ["replace"], additionalProperties: false } },
    rationale: { type: "string" },
  },
  required: ["edits", "rationale"],
  additionalProperties: false,
};

export const CUT_SYSTEM = `You make the instruction file a coding agent reads at the start of every session (CLAUDE.md, AGENTS.md, a rule or a skill) cheaper and faster to follow, without making the agent worse at its tasks.
You get the file, what made the agent's recent eval runs slow or expensive, the lines you may not touch, and cuts that were tested before and not kept.
Propose edits that remove what the runs show costs time or tokens and does not help: long background sections, repeated rules, examples the agent does not need, steps that make it read or run more than the task needs.
Rules:
- An edit is {"find": "...", "replace": "..."}, where "find" is an exact substring of the file long enough to occur exactly once, or {"section": "## Heading", "replace": "..."}, which covers that heading line and everything under it up to the next heading of the same or a higher level. "replace" is the new text ("" deletes it). Use "section" to drop or shorten a whole section.
- At most ${MAX_CUT_EDITS} edits. Keep every instruction the tasks depend on: how to build, test and verify, and every rule about safety.
- Never delete, reword or weaken a READ-ONLY line, and never add a line that tells the agent to skip, disable or edit tests, CI or verifiers, use --no-verify or force-push, or broaden permissions.
- Do not repeat a cut listed as not kept. A cut whose pass rate fell removed at least one line the tasks need (most often a rule about what the code must do): keep such lines. The rest of that cut may still be safe to remove.
Reply with JSON only: {"edits": [{"find": "...", "replace": "..."}, {"section": "...", "replace": ""}], "rationale": "..."}. The rationale says what you cut and why it should not cost quality, in one or two sentences.`;

/** A cut tested and not kept, as the proposer sees it. */
export interface RejectedCut {
  id: string;
  verdict: string;
  reasons: readonly string[];
  /** Removed lines (the first few, when `removedCount` is larger). */
  removed: readonly string[];
  removedCount?: number;
  /** The sections the cut took lines from. */
  sections?: readonly CutSection[];
}

/** What a cut took from one section of the file. */
export interface CutSection {
  heading: string;
  /** Non-blank lines removed from the section, and the section's non-blank lines. */
  removed: number;
  lines: number;
}

/**
 * What the proposer sees of a rejected cut: the sections it took lines from
 * (so a cut that removed everything is not read as being about its first few
 * lines), and the lines themselves when there are only a few.
 */
function rejectedDetail(r: RejectedCut): string {
  const n = r.removedCount ?? r.removed.length;
  const out: string[] = [];
  if (r.sections?.length) {
    const parts = r.sections.slice(0, 12).map((s) => (s.removed === s.lines ? `all of "${s.heading}" (${s.removed})` : `${s.removed} of ${s.lines} lines in "${s.heading}"`));
    out.push(`    removed ${n} line${n === 1 ? "" : "s"}: ${parts.join(", ")}${r.sections.length > 12 ? ", …" : ""}`);
  }
  if (n <= 8 || !r.sections?.length) out.push(...r.removed.slice(0, 8).map((l) => `    - ${l}`));
  return out.length ? `\n${out.join("\n")}` : "";
}

const MAX_REJECTED = 12;

/** The cut proposer's system and user prompt. The user prompt is redacted. */
export function cutPrompt(o: { target: HarnessText; drivers: readonly string[]; objective: string; protectedLines: readonly ProtectedLine[]; rejected?: readonly RejectedCut[] }): { system: string; user: string } {
  const parts: string[] = [];
  parts.push(`Goal: lower ${o.objective} per run while the suite's pass rate holds.`);
  parts.push(o.drivers.length ? ["What the last eval runs show:", ...o.drivers].join("\n") : "No runs recorded yet: cut what the file repeats or does not need.");
  parts.push(`The file to cut, ${o.target.path} (${Buffer.byteLength(o.target.text)} bytes):\n<file path="${o.target.path}">\n${o.target.text}\n</file>`);
  const ro = readOnlySection(o.protectedLines.filter((p) => p.path === o.target.path));
  if (ro) parts.push(ro);
  const rejected = (o.rejected ?? []).slice(-MAX_REJECTED);
  if (rejected.length) {
    parts.push(
      [
        "Tested before and not kept (a quality loss means one of its removed lines is needed, not all of them; a cut that held quality but saved too little can go further):",
        ...rejected.map((r) => `- ${r.id} (${r.verdict}: ${r.reasons.slice(0, 2).join("; ") || "no reason recorded"})${rejectedDetail(r)}`),
      ].join("\n"),
    );
  }
  return { system: CUT_SYSTEM, user: createRedactor().string(parts.join("\n\n")) };
}

function jsonIn(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1];
    return JSON.parse(fence ?? t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  }
}

/** The model's reply as a cut; throws with a plain reason when it is not one. */
export function parseCut(text: string): Cut {
  let v: unknown;
  try {
    v = jsonIn(text);
  } catch {
    throw new Error("the reply is not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("the reply is not a JSON object");
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.edits)) throw new Error('"edits" must be an array');
  const edits: CutEdit[] = [];
  for (const e of o.edits) {
    const x = (e ?? {}) as Record<string, unknown>;
    const key = typeof x.find === "string" ? "find" : typeof x.section === "string" ? "section" : undefined;
    if (!e || typeof e !== "object" || !key || typeof x.replace !== "string" || (x.find !== undefined && x.section !== undefined)) throw new Error('each edit must be {"find": string, "replace": string} or {"section": string, "replace": string}');
    const at = (x[key] as string).trim() ? (x[key] as string) : "";
    if (!at) throw new Error(`an edit has an empty "${key}"`);
    const replace = x.replace as string;
    if (/<!--\s*coding\.sh:/.test(replace)) throw new Error("an edit adds a coding.sh marker");
    edits.push(key === "find" ? { find: at, replace } : { section: at, replace });
  }
  if (!edits.length) throw new Error("the cut has no edits");
  if (edits.length > MAX_CUT_EDITS) throw new Error(`the cut has ${edits.length} edits, more than ${MAX_CUT_EDITS}`);
  return { edits, rationale: typeof o.rationale === "string" ? o.rationale.trim() : "" };
}

const count = (text: string, s: string): number => {
  let n = 0;
  for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + 1)) n++;
  return n;
};

/** Markdown headings outside code fences: level, the heading line, and where the line starts. */
function headings(src: string): { level: number; text: string; at: number }[] {
  const out: { level: number; text: string; at: number }[] = [];
  let pos = 0;
  let fence = false;
  for (const l of src.split("\n")) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+\S/.exec(l);
    if (m) out.push({ level: m[1]!.length, text: l.trim(), at: pos });
    pos += l.length + 1;
  }
  return out;
}

/** Where a section edit applies: its heading line through the line before the next heading of the same or a higher level. */
function sectionSpan(src: string, section: string): { at: number; end: number } {
  const hs = headings(src);
  const want = section.trim();
  const hits = hs.filter((h) => h.text === want);
  if (hits.length !== 1) throw new Error(`the section "${short(want)}" is ${hits.length ? `a heading ${hits.length} times` : "not a heading"} in the file, not once`);
  const h = hits[0]!;
  const next = hs.find((x) => x.at > h.at && x.level <= h.level);
  return { at: h.at, end: next ? next.at : src.length };
}

const short = (s: string) => `${s.slice(0, 60).replace(/\n/g, "\\n")}${s.length > 60 ? "…" : ""}`;

/**
 * The text with every edit applied. Each `find` must occur exactly once in the
 * original, each `section` must be a heading line exactly once, and no two
 * edits may overlap; CRLF files are matched as LF and written back as CRLF.
 */
export function applyCut(text: string, edits: readonly CutEdit[]): string {
  const crlf = text.includes("\r\n");
  const src = crlf ? text.replace(/\r\n/g, "\n") : text;
  const spans: { at: number; end: number; replace: string }[] = [];
  for (const e of edits) {
    const replace = e.replace.replace(/\r\n/g, "\n");
    if (e.section !== undefined) {
      const span = sectionSpan(src, e.section);
      // A replaced section keeps the blank line before the next heading.
      spans.push({ ...span, replace: replace && !replace.endsWith("\n") ? `${replace}\n${span.end < src.length ? "\n" : ""}` : replace });
      continue;
    }
    const find = (e.find ?? "").replace(/\r\n/g, "\n");
    const n = find ? count(src, find) : 0;
    if (n !== 1) throw new Error(`"${short(find)}" occurs ${n} times in the file, not once`);
    const at = src.indexOf(find);
    spans.push({ at, end: at + find.length, replace });
  }
  spans.sort((a, b) => a.at - b.at);
  for (let i = 1; i < spans.length; i++) if (spans[i]!.at < spans[i - 1]!.end) throw new Error("two edits overlap");
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += src.slice(pos, s.at) + s.replace;
    pos = s.end;
  }
  out += src.slice(pos);
  // A deleted section can leave a run of blank lines behind.
  out = out.replace(/\n{3,}/g, "\n\n");
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

/** The candidate a cut makes, and its id. */
export function cutCandidate(target: HarnessText, cut: Cut): { id: string; file: HarnessText } {
  const text = applyCut(target.text, cut.edits);
  if (text === target.text) throw new Error("the cut changes nothing");
  const file = { path: target.path, text };
  return { id: candidateId([file]), file };
}

/** The sections of `before` that lost non-blank lines in `after`, in file order (lines matched as a multiset, like removedLines). */
export function cutSections(before: string, after: string): CutSection[] {
  const left = new Map<string, number>();
  for (const l of after.split(/\r?\n/)) left.set(l, (left.get(l) ?? 0) + 1);
  const out: CutSection[] = [];
  let cur: CutSection = { heading: "(top of file)", removed: 0, lines: 0 };
  let fence = false;
  for (const l of before.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^#{1,6}\s+\S/.test(l)) {
      if (cur.removed) out.push(cur);
      cur = { heading: l.trim().slice(0, 70), removed: 0, lines: 0 };
    }
    if (!l.trim()) continue;
    cur.lines++;
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else cur.removed++;
  }
  if (cur.removed) out.push(cur);
  return out;
}

/** Non-blank lines of `before` that `after` no longer has (as a multiset), for the log and the rejected list. */
export function removedLines(before: string, after: string): string[] {
  const left = new Map<string, number>();
  for (const l of after.split(/\r?\n/)) left.set(l, (left.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of before.split(/\r?\n/)) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else if (l.trim()) out.push(l);
  }
  return out;
}
