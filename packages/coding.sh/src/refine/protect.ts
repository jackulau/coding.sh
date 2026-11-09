// Protected safety directives (Z-13). A paired success gate cannot see harm
// that never shows up in the batch: in "Masked Erosion" (So, Liu, Long, arXiv
// 2610.38392) it accepted deleting the only sufficient safeguard in 15 of 20
// proposals, and proposers more often rewrote a rule into a conditional
// ("… only when the owner is uncertain") or added a tip against it than deleted
// it. Freezing the safety text worked (§4.7). So harness edits are checked
// lexically, before any A/B:
//
//   protected (C6)          an edit may not delete or reword a protected line
//   relaxes-protected (C7)  an added line may not carve an exception out of one
//
// A line is protected by a marker block (<!-- coding.sh:protect --> …
// <!-- coding.sh:protect end -->), by a `[refine] protect` regex, or, unless
// auto-protection is off, by pairing a gate word (never, ask, confirm, …) with
// a safety topic (credentials, prod, push, --force, delete, …). Fenced code and
// frontmatter are skipped. Pure: files come in as text.
import { stripLine } from "../core/rules.ts";
import { isInstructionHarnessPath } from "../core/harness-paths.ts";

/** A file under a skill dir other than its SKILL.md: a script, reference or template the skill ships. */
export const isSkillAsset = (path: string): boolean => /^\.(?:claude|agents)\/skills\/[^/]+\//.test(path.replace(/\\/g, "/")) && !isInstructionHarnessPath(path);

export interface HarnessText {
  /** Repo-relative POSIX path. */
  path: string;
  text: string;
}

export interface ProtectOpts {
  /** Regex sources; a line matching any is protected (`[refine] protect`). */
  protect?: readonly string[];
  /** Protect gate-word + safety-topic lines automatically. Default true. */
  autoProtect?: boolean;
}

export type ProtectWhy = "marker" | "config" | "auto";

export interface ProtectedLine {
  path: string;
  /** 1-based. */
  line: number;
  /** The line's prose (list marker, heading marks and bold dropped). */
  text: string;
  /** Lower-cased, whitespace-collapsed text: what an edit must keep. */
  norm: string;
  why: ProtectWhy;
}

// Gate words. The prohibitions count anywhere in a sentence; the others only
// open one ("Ask the owner before …", "Only deploy from main", "Always verify …"),
// since "only", "before" and "check" are everywhere in descriptive prose.
const GATE_STRONG = /\b(?:never|do not|don't|must not)\b/i;
const GATE_LEAD = /^(?:[*_]*)(?:always\s+|first,?\s+|please\s+)?(?:only|before|ask|confirm|verify|check|require|requires)\b/i;
const gate = (sentence: string): boolean => GATE_STRONG.test(sentence) || GATE_LEAD.test(sentence.trim());
/** Longer sentences are descriptions, not rules. */
const MAX_DIRECTIVE_CHARS = 240;

/** Safety topics, each with an id so two lines can share one. */
const TOPICS: readonly [string, RegExp][] = [
  ["credential", /\bcredentials?\b/i],
  ["secret", /\bsecrets?\b/i],
  // Credentials, not design or LLM tokens.
  ["token", /\b(?:access|auth|api|bearer|refresh|session|oauth|github|gh|npm|pypi|personal access|secret|deploy) tokens?\b/i],
  ["password", /\bpasswords?\b/i],
  ["api-key", /\bapi[ _-]?keys?\b/i],
  ["env-file", /(?:^|[^\w.])\.env\b/i],
  ["prod", /\bprod(?:uction)?\b/i],
  ["deploy", /(?<![\w-])deploy(?:s|ed|ing|ments?)?\b(?!-)/i],
  ["push", /(?<![\w-])push(?:es|ed|ing)?\b(?! notifications?\b| back\b)(?!-)/i],
  ["force", /(?:^|[^\w-])--force\b|\bforce[- ]push\w*/i],
  ["destructive", /\bdestructive(?:ly)?\b/i],
  ["key", /\b(?:service[ -]role|private|secret|signing|ssh|access|master) keys?\b|\b(?:commit|hard-?code|print|log|leak|expose|paste)\w*\s+(?:\S+\s+){0,3}?keys?\b/i],
  ["no-verify", /(?:^|[^\w-])--no-verify\b/i],
  ["rm-rf", /\brm\s+-(?:rf|fr)\b/i],
  ["delete", /\bdelet(?:e|es|ed|ing|ion)\b/i],
  ["drop", /\bdrop(?:s|ped|ping)? (?:the |a |any )?(?:tables?|databases?|db|schemas?|columns?|collections?|indexes|index)\b/i],
  ["reset-hard", /\breset\s+--hard\b/i],
  ["migrate", /(?<![\w-])migrat(?:e|es|ed|ing|ions?)\b(?!-)/i],
  ["permission", /\bpermissions?\b/i],
  ["sudo", /\bsudo\b/i],
  ["chmod", /\bchmod\b/i],
  ["payment", /\bpayments?\b/i],
  ["pii", /\bPII\b/],
  ["personal-data", /\bpersonal data\b/i],
  ["another-user", /\b(?:another|other) users?(?:'s|')?\b/i],
  ["owner", /\bowners?\b(?!\/)/i],
  ["dry-run", /\bdry[ -]run\b/i],
  ["backup", /\bbackups?\b/i],
];

/** A relaxing cue: wording that turns a rule into a conditional or waives it. */
const RELAX_CUE =
  /\b(?:skip(?:s|ped|ping)?|no need|unnecessary|avoid (?:extra|redundant)|only\b[^.;:]{0,60}?\b(?:when|if)|unless|don't bother|without (?:asking|confirming|checking|verifying)|redundant (?:checks?|verifications?)|already (?:yours|verified|safe))\b/i;

/** Words too common to tie an added line to a protected one. */
const STOP = new Set(
  "about above after again also always another anything because been before being below between both cannot could does doing done each either every everything extra first from have here into just keep less like make many more most much must need needed never next once only other over prefer really same should since some such sure than that their them then there these they thing things this those through very want were what when where which while will with without would your yours obvious ambiguous unless skip skipping skipped already redundant unnecessary bother check checks checked checking confirm confirms confirmed confirmation verify verified asking confirming verifying require requires required".split(
    " ",
  ),
);

const MARK_BEGIN = /^\s*<!--\s*coding\.sh:protect\s*-->\s*$/i;
const MARK_END = /^\s*<!--\s*coding\.sh:protect\s+end\s*-->\s*$/i;
const COMMENT = /^\s*<!--.*-->\s*$/;

const quotes = (s: string): string => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** What an edit must keep of a line: its prose, lower-cased, whitespace collapsed. */
export function normLine(raw: string): string {
  return quotes(stripLine(raw)).replace(/\s+/g, " ").trim().toLowerCase();
}

/** Safety-topic ids a line names. */
export function safetyTopics(text: string): string[] {
  return TOPICS.filter(([, re]) => re.test(text)).map(([id]) => id);
}

/** A line's sentences: split after . ! or ? where the next one starts. */
const sentences = (text: string): string[] => quotes(text).split(/(?<=[.!?])\s+(?=[A-Z`"'(*_[])/);
const normSentence = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** True when a line pairs a gate word with a safety topic (auto-protection). */
export function isSafetyDirective(text: string): boolean {
  // Gate word and topic must share a sentence. A line that starts lower-case
  // continues a hard-wrapped sentence: when a new sentence starts later on the
  // line, the leading fragment (the tail of the previous one) is not judged.
  const parts = sentences(text);
  if (/^[a-z]/.test(text) && parts.length > 1) parts.shift();
  return parts.some((t) => t.length <= MAX_DIRECTIVE_CHARS && gate(t) && safetyTopics(t).length > 0);
}

/** True when an added line waives or conditions a rule ("skip …", "only … when …", "unless …"). */
export function hasRelaxingCue(text: string): boolean {
  return RELAX_CUE.test(quotes(text));
}

/** Prose lines of a file with their 1-based numbers: frontmatter, fenced code, blank lines and lone HTML comments skipped; marker state tracked. */
function proseLines(text: string): { line: number; raw: string; marked: boolean }[] {
  const lines = text.split(/\r?\n/);
  const out: { line: number; raw: string; marked: boolean }[] = [];
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (end > 0) i = end + 1;
  }
  let fence: string | undefined;
  let marked = false;
  for (; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (MARK_BEGIN.test(raw)) {
      marked = true;
      continue;
    }
    if (MARK_END.test(raw)) {
      marked = false;
      continue;
    }
    const f = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (!fence) fence = f[1]![0];
      else if (f[1]![0] === fence) fence = undefined;
      continue;
    }
    if (fence || !raw.trim() || COMMENT.test(raw)) continue;
    out.push({ line: i + 1, raw, marked });
  }
  return out;
}

/** Compiles `[refine] protect` regex sources; throws a readable error on a bad one. */
export function compileProtect(sources: readonly string[] = []): RegExp[] {
  return sources.map((s) => {
    try {
      return new RegExp(s);
    } catch (e) {
      throw new SyntaxError(`refine.protect: invalid regex ${JSON.stringify(s)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

/**
 * The protected lines in a set of harness files, in path then line order. A
 * marker beats config, config beats auto. Config regexes test the line's prose
 * (list marker and bold dropped), so `^Use pnpm` matches "- Use pnpm …".
 */
export function protectedLines(files: readonly HarnessText[], opts: ProtectOpts = {}): ProtectedLine[] {
  files = files.filter((f) => !isSkillAsset(f.path));
  const res = compileProtect(opts.protect);
  const auto = opts.autoProtect !== false;
  const out: ProtectedLine[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    for (const { line, raw, marked } of proseLines(f.text)) {
      const text = stripLine(raw);
      if (!text) continue;
      // Headings and table rows are structure or reference, not rules: only a marker or a config regex protects one.
      const heading = /^\s*(?:>\s*)*(?:#{1,6}\s|\|)/.test(raw);
      const why: ProtectWhy | undefined = marked ? "marker" : res.some((re) => re.test(text)) ? "config" : auto && !heading && isSafetyDirective(text) ? "auto" : undefined;
      if (why) out.push({ path: f.path, line, text, norm: normLine(raw), why });
    }
  }
  return out;
}

export type ProtectCritic = "protected" | "relaxes-protected";

export interface ProtectRejection {
  critic: ProtectCritic;
  /** `protected-line: AGENTS.md:12 "…" (auto)` or `relaxes-protected: "…" vs AGENTS.md:12`. */
  reason: string;
  /** The protected line the edit removed, reworded or relaxed. */
  protected: ProtectedLine;
  /** relaxes-protected: the added line. */
  added?: { path: string; line: number; text: string };
}

export interface ProtectCheck {
  /** No rejection left after overrides. */
  ok: boolean;
  /** Protected lines in the before files. */
  protected: ProtectedLine[];
  rejections: ProtectRejection[];
  /** Rejections waived by an override (`path:line` of the protected line). */
  overridden: ProtectRejection[];
  /** Overrides that matched no rejection (a typo, or the edit no longer touches that line). */
  unusedOverrides: string[];
}

const cut = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const where = (p: ProtectedLine): string => `${p.path}:${p.line}`;

const backticks = (s: string): Set<string> => new Set([...s.matchAll(/`([^`\n]+)`/g)].map((m) => (m[1] as string).trim().toLowerCase()).filter((t) => t.length >= 2));
const contentWords = (s: string): Set<string> => new Set((quotes(s).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));

/** How strongly an added line is tied to a protected one: shared backticked tokens, shared content words, shared safety topics. 0: unrelated. */
function anchorScore(added: string, p: ProtectedLine): number {
  const bt = backticks(p.text);
  const shareBt = [...backticks(added)].filter((t) => bt.has(t)).length;
  const words = contentWords(p.text);
  const shareWords = [...contentWords(added)].filter((w) => words.has(w)).length;
  const topics = new Set(safetyTopics(p.text));
  const shareTopics = safetyTopics(added).filter((t) => topics.has(t)).length;
  return shareBt * 3 + shareTopics * 2 + shareWords;
}

/** `path:line` → the parsed override; throws on a malformed one. */
export function parseOverride(v: string): { path: string; line: number } {
  const m = /^(.+):(\d+)$/.exec(v.trim());
  if (!m || Number(m[2]) < 1) throw new SyntaxError(`expected PATH:LINE (the protected line's path and 1-based line), got ${JSON.stringify(v)}`);
  return { path: (m[1] as string).replace(/\\/g, "/").replace(/^\.\//, ""), line: Number(m[2]) };
}

/**
 * C6 and C7 on an edit from `before` to `after` (path → text; a path missing
 * from `after` was deleted). C6 rejects every protected line of `before` whose
 * text is gone from the same path in `after` (deleted, reworded or moved to
 * another file). C7 rejects every added line (not in that path's `before`)
 * with a relaxing cue that is tied to a protected line by a shared backticked
 * token, content word or safety topic. Only the line's new sentences count: an
 * edited paragraph keeps the sentences it had, and those relax nothing new.
 * `allow` lists `path:line` of protected lines the edit may touch.
 */
export function checkProtected(before: readonly HarnessText[], after: readonly HarnessText[], opts: ProtectOpts & { allow?: readonly string[]; protected?: readonly ProtectedLine[] } = {}): ProtectCheck {
  // A skill's scripts and data aren't instructions, so they carry no protected lines.
  before = before.filter((f) => !isSkillAsset(f.path));
  after = after.filter((f) => !isSkillAsset(f.path));
  const prot = opts.protected ? [...opts.protected] : protectedLines(before, opts);
  const beforeBy = new Map(before.map((f) => [f.path, f.text]));
  const afterBy = new Map(after.map((f) => [f.path, f.text]));
  const normsOf = (text: string | undefined): Set<string> => new Set(text === undefined ? [] : text.split(/\r?\n/).map(normLine).filter(Boolean));
  const afterNorms = new Map([...afterBy].map(([p, t]) => [p, normsOf(t)]));
  const rejections: ProtectRejection[] = [];

  for (const p of prot) {
    if (afterNorms.get(p.path)?.has(p.norm)) continue;
    rejections.push({ critic: "protected", reason: `protected-line: ${where(p)} "${cut(p.text)}" (${p.why})`, protected: p });
  }

  for (const f of [...after].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const before = beforeBy.get(f.path);
    const was = normsOf(before);
    const wasSentences = new Set(before === undefined ? [] : proseLines(before).flatMap(({ raw }) => sentences(stripLine(raw)).map(normSentence)));
    for (const { line, raw } of proseLines(f.text)) {
      const norm = normLine(raw);
      if (!norm || was.has(norm)) continue;
      const text = sentences(stripLine(raw))
        .filter((s) => !wasSentences.has(normSentence(s)))
        .join(" ");
      if (!hasRelaxingCue(text)) continue;
      let best: ProtectedLine | undefined;
      let bestScore = 0;
      for (const p of prot) {
        const s = anchorScore(text, p);
        if (s > bestScore) {
          best = p;
          bestScore = s;
        }
      }
      if (!best) continue;
      rejections.push({ critic: "relaxes-protected", reason: `relaxes-protected: "${cut(text)}" vs ${where(best)}`, protected: best, added: { path: f.path, line, text } });
    }
  }

  const allow = (opts.allow ?? []).map((v) => ({ v, ...parseOverride(v) }));
  const used = new Set<string>();
  const kept: ProtectRejection[] = [];
  const overridden: ProtectRejection[] = [];
  for (const r of rejections) {
    const hit = allow.find((a) => a.path === r.protected.path && a.line === r.protected.line);
    if (hit) {
      used.add(hit.v);
      overridden.push(r);
    } else kept.push(r);
  }
  return { ok: kept.length === 0, protected: prot, rejections: kept, overridden, unusedOverrides: allow.filter((a) => !used.has(a.v)).map((a) => a.v) };
}

/** The proposer prompt's read-only section ("" with nothing protected). */
export function readOnlySection(lines: readonly ProtectedLine[]): string {
  if (!lines.length) return "";
  return ["READ-ONLY (do not edit, reword, weaken or add exceptions to):", ...lines.map((p) => `- ${where(p)}: ${p.text}`)].join("\n");
}
