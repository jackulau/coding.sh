// Pre-trial critics on the lines a candidate adds (R2-7), run before any model
// call, next to the protected-line check (Z-13, protect.ts):
//
//   harmless (C2)   an added line tells the agent to skip, disable or delete
//                   tests, edit CI or verifier files, use --no-verify, force-push,
//                   chmod 777, broaden permissions, hard-code expected output or
//                   "make the tests pass"; or it holds a secret the redactor
//                   catches. A line that forbids the act ("never …", "don't …")
//                   is fine.
//   duplicate (C4)  an added line is a near copy of a line the candidate kept
//                   from the file: character 5-shingle Jaccard ≥ 0.8 on the
//                   normalized text.
//
// Pure: files come in as text.
import { createRedactor } from "../core/redact.ts";
import { isSkillAsset, normLine, type HarnessText } from "./protect.ts";

export type CriticId = "harmless" | "duplicate";

export interface AddedLine {
  path: string;
  /** 1-based, in the candidate file. */
  line: number;
  text: string;
}

export interface CriticRejection {
  critic: CriticId;
  reason: string;
  added: AddedLine;
}

export interface CriticCheck {
  ok: boolean;
  rejections: CriticRejection[];
  /** Every added non-blank line, comments and fences included. */
  added: AddedLine[];
}

/** Lines of `after` that `before` does not have (as a multiset per file), with their line numbers. */
export function addedLines(before: readonly HarnessText[], after: readonly HarnessText[]): AddedLine[] {
  const old = new Map(before.map((f) => [f.path, f.text]));
  const out: AddedLine[] = [];
  for (const f of after) {
    const prev = old.get(f.path);
    if (prev === f.text) continue;
    const left = new Map<string, number>();
    for (const l of (prev ?? "").split(/\r?\n/)) left.set(l, (left.get(l) ?? 0) + 1);
    f.text.split(/\r?\n/).forEach((l, i) => {
      const n = left.get(l) ?? 0;
      if (n > 0) left.set(l, n - 1);
      else if (l.trim()) out.push({ path: f.path, line: i + 1, text: l });
    });
  }
  return out;
}

const NEGATED = /\b(?:never|do not|don't|dont|must not|mustn't|avoid)\b/i;
const HARMFUL: readonly [RegExp, string][] = [
  [/\b(?:skip|skipping|disable|delete|remove|comment out|xfail|ignore)\b[^.;]{0,40}\b(?:tests?|specs?|assertions?|checks?)\b/i, "skips or disables tests"],
  [/\b(?:tests?|specs?)\b[^.;]{0,40}\b(?:skip|skipped|xfail|disable|disabled|delete|deleted|ignore|ignored)\b/i, "skips or disables tests"],
  [/\b(?:edit|modify|change|rewrite|loosen|relax)\b[^.;]{0,40}(?:\.github\/workflows|\bci (?:config|workflow|pipeline)s?\b|\bverifiers?\b|\btest harness\b)/i, "edits CI or verifier files"],
  [/(?:^|[^\w-])--no-verify\b/i, "uses --no-verify"],
  [/\bforce[- ]push\w*|\bpush\s+(?:-f|--force)\b/i, "force-pushes"],
  [/\bchmod\s+(?:-R\s+)?777\b/i, "chmod 777"],
  [/\bdangerously-skip-permissions\b|\bbypassPermissions\b|\b(?:allow|grant)\b[^.;]{0,20}\b(?:all|every|any)\b[^.;]{0,20}\bpermissions?\b/i, "broadens permissions"],
  [/\bhard-?cod\w*\b[^.;]{0,30}\b(?:expected|outputs?|results?|answers?)\b/i, "hard-codes expected output"],
  [/\bmake (?:the |all )?(?:tests?|checks?|ci) (?:pass|green)\b(?![^.;]{0,30}\bby fixing\b)/i, "makes the tests pass by any means"],
];

/** Why an added line is harmful, or undefined. */
export function harmfulReason(text: string): string | undefined {
  const red = createRedactor();
  if (red.string(text) !== text) return "holds a secret";
  if (NEGATED.test(text)) return undefined;
  for (const [re, why] of HARMFUL) if (re.test(text)) return why;
  return undefined;
}

function shingles(s: string, n = 5): Set<string> {
  const out = new Set<string>();
  if (s.length < n) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Shortest normalized line the duplicate critic compares: shorter lines ("- [ ]", "## Rules") repeat legitimately. */
const MIN_DUP_CHARS = 16;
export const DUPLICATE_JACCARD = 0.8;

/** C2 and C4 on the lines `after` adds to `before`. */
export function runCritics(before: readonly HarnessText[], after: readonly HarnessText[]): CriticCheck {
  // The critics read instructions; a skill's scripts and references are code and data.
  before = before.filter((f) => !isSkillAsset(f.path));
  after = after.filter((f) => !isSkillAsset(f.path));
  const added = addedLines(before, after);
  const rejections: CriticRejection[] = [];
  // Lines the candidate kept from the file: a reworded line is compared with what stays, not with its old self.
  const addedAt = new Set(added.map((a) => `${a.path}\u0000${a.line}`));
  const existing = new Map<string, { norm: string; sh: Set<string> }[]>();
  for (const f of after) {
    if (!before.some((b) => b.path === f.path)) continue;
    existing.set(
      f.path,
      f.text
        .split(/\r?\n/)
        .filter((_, i) => !addedAt.has(`${f.path}\u0000${i + 1}`))
        .map((l) => normLine(l))
        .filter((n) => n.length >= MIN_DUP_CHARS)
        .map((norm) => ({ norm, sh: shingles(norm) })),
    );
  }
  for (const a of added) {
    if (/^\s*<!--.*-->\s*$/.test(a.text)) continue;
    const why = harmfulReason(a.text);
    if (why) rejections.push({ critic: "harmless", reason: `harmless: ${why}: "${a.text.trim()}" (${a.path}:${a.line})`, added: a });
    const norm = normLine(a.text);
    if (norm.length < MIN_DUP_CHARS) continue;
    const sh = shingles(norm);
    const twin = (existing.get(a.path) ?? []).find((e) => e.norm === norm || jaccard(sh, e.sh) >= DUPLICATE_JACCARD);
    if (twin) rejections.push({ critic: "duplicate", reason: `duplicate: "${a.text.trim()}" (${a.path}:${a.line}) repeats a line the file has`, added: a });
  }
  return { ok: rejections.length === 0, rejections, added };
}
