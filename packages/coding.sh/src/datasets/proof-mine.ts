// Formal-verification proof-step dataset mining: extracts solved proof-step
// transitions (failing proof check -> proof edit(s) -> passing check with no
// net new escape hatches) and stuck/unresolved proof goals from stored sessions.
// Every string field passes through createRedactor() before leaving this module.
import { isFailureFlag } from "../core/failure-flags.ts";
import {
  checkOutcome,
  isProofConfig,
  isProofLang,
  isProofOutput,
  isProofTestPath,
  isRocqOutput,
  outText,
  PROOF_LANGS,
  proofChange,
  proofCheck,
  proofEnd,
  proofLang,
  proofOutputLang,
  proofStart,
  proofWrite,
  readProofDiff,
  type HasProof,
  type ProofCheck,
  type ProofLang,
} from "../core/proof.ts";
import { createRedactor, type Redactor } from "../core/redact.ts";
import { normalizeTracePath, shellCommand, shellDiffOrigin, shellWrites } from "../core/shell-diff.ts";
import { isShellCall } from "../core/shell-tools.ts";
import type { AgentEvent, Session } from "../schema/index.ts";
import { CaseDeduper, DEFAULT_SHINGLE_SIZE, validateThreshold, type MinScoreFilter, type NearDedupeDrop } from "./curate.ts";
import { caseContentHash, DatasetError, normalizeCase } from "./dataset.ts";
import type { Case, Split } from "./types.ts";

export const PROOF_STEP_OUTCOMES = ["solved", "stuck", "all"] as const;
export type ProofStepOutcomeFilter = (typeof PROOF_STEP_OUTCOMES)[number];
export type ProofStepOutcome = "solved" | "stuck";

export const MAX_ERROR_CHARS = 600;
export const MAX_GOAL_SNIPPET_CHARS = 800;
export const MAX_WINNING_DIFF_CHARS = 2000;
export const MAX_COMMAND_CHARS = 500;

export interface ProofStepInput {
  kind: "proof-step";
  lang: ProofLang;
  file?: string;
  command: string;
  error: string;
  goalSnippet?: string;
}

export interface ProofStepExpectedSolved {
  resolved: true;
  winningDiff?: string;
  winningCheck: string;
  attempts: number;
}

export interface ProofStepExpectedStuck {
  resolved: false;
  attempts: number;
}

export type ProofStepExpected = ProofStepExpectedSolved | ProofStepExpectedStuck;

export type ProofMineDropReason =
  | "min-turns"
  | "min-score"
  | "flagged"
  | "proof-lang"
  | "proof-outcome"
  | "proof-escape"
  | "exact-duplicate"
  | "near-duplicate"
  | "limit";

export interface MineProofStepsOpts {
  sessions: readonly Session[];
  getEvents: (sessionId: string) => Promise<readonly AgentEvent[]>;
  /** Session id to score name to mean numeric score (required only when `minScores` is set). */
  scores?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  minTurns?: number;
  minScores?: readonly MinScoreFilter[];
  excludeFlagged?: boolean;
  /** Optional filter of proof languages to keep. */
  proofLangs?: readonly ProofLang[];
  /** Keep solved transitions, stuck goals, or both (default "all"). */
  outcome?: ProofStepOutcomeFilter;
  dedupeNear?: number;
  split?: Split;
  tags?: string[];
  limit?: number;
  existing?: readonly Case[];
  shingleSize?: number;
}

export interface MineProofStepsReport {
  cases: Case[];
  /** Number of sessions scanned. */
  sessions: number;
  /** Total proof-step episodes discovered before filtering. */
  matched: number;
  kept: number;
  dropped: number;
  droppedBy: Partial<Record<ProofMineDropReason, number>>;
  duplicates: NearDedupeDrop[];
}

interface ExtractedProofStep {
  lang: ProofLang;
  outcome: ProofStepOutcome;
  escapesAdded: number;
  case: Case;
}

interface PendingEpisode {
  key: string;
  lang: ProofLang;
  file?: string;
  firstCommand: string;
  firstError: string;
  lastErrorSig: string;
  goalSnippet?: string;
  attempts: number;
  edits: { file: string; diff: string }[];
  editedViaShell: boolean;
  hatches: Map<string, number>;
}

const TIMED_OUT_TEXT = /\b(?:exec )?command timed out\b|\btimed out after\b|\bexit code 124\b/i;
const EXIT_LINE_RE = /^(?:Error:\s*)?Exit code -?\d+\s*$/i;
const ERROR_LINE_RE = /\berror:|\bError:|\b[1-9]\d* errors?\b|^\*\*\* |\bis violated\b|\[ERROR\]|EXITCODE: ERROR|\b(?:unsolved goals|type mismatch|tactic .* failed|unable to unify|assertion failed|postcondition|precondition|invariant|failed to finish proof|obligations? failed)\b/i;

const FILE_BY_LANG: Record<ProofLang, RegExp> = {
  lean: /([^\s:'"()[\]]+\.lean):\d+:\d+:/,
  rocq: /File "([^"\n]+\.v)", line \d+/,
  dafny: /([^\s:'"()[\]]+\.dfy)\(\d+,\d+\):/,
  verus: /(?:-->\s*|^|\s)([^\s:'"()[\]]+\.rs):\d+:\d+/m,
  isabelle: /"([^"\n]+\.thy)"|([^\s:'"()[\]]+\.thy)/,
  tla: /([^\s:'"()[\]]+\.tla)\b/,
  tlc: /([^\s:'"()[\]]+\.(?:cfg|tla))\b/,
};

const STMT_LINE_RE = /^[+-]?\s*(?:@\[[^\]]*\]\s*|#\[[^\]]*\]\s*)?(?:(?:private|protected|local|global|noncomputable|ghost|static|pub(?:\([^)]*\))?|proof|spec|exec)\s+)*(?:theorem|lemma|corollary|proposition|fact|example|method|function|predicate|THEOREM|LEMMA|PROPOSITION|COROLLARY|fn)\b/i;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function isProofStepOutcomeFilter(v: string): v is ProofStepOutcomeFilter {
  return (PROOF_STEP_OUTCOMES as readonly string[]).includes(v);
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function bumpReason(counts: Partial<Record<ProofMineDropReason, number>>, reason: ProofMineDropReason, delta = 1): void {
  counts[reason] = (counts[reason] ?? 0) + delta;
}

/** Extracts the proof file path referenced by a checker command or its output. */
function extractFileFromOutput(lang: ProofLang, output: string, cwd: string | undefined): string | undefined {
  if (!output) return undefined;
  const re = FILE_BY_LANG[lang];
  const m = re.exec(output);
  const raw = m ? (m[1] ?? m[2]) : undefined;
  return raw ? normalizeTracePath(raw, cwd) : undefined;
}

function firstCheckFile(check: ProofCheck, cwd: string | undefined): string | undefined {
  if (!check.path) return undefined;
  const first = check.path.split(/\s+/).find(Boolean);
  return first ? normalizeTracePath(first, cwd) : undefined;
}

/** Extracts the primary proof error lines from failing checker output. */
function extractProofError(output: string, timedOut: boolean): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0 && !EXIT_LINE_RE.test(l.trim()));
  if (!lines.length) return timedOut ? "proof check timed out" : "proof check failed";
  const start = lines.findIndex((l) => ERROR_LINE_RE.test(l));
  const slice = start >= 0 ? lines.slice(start, start + 6) : lines.slice(0, 6);
  return slice.join("\n").trim();
}

/** Normalizes an error string for comparing repeat failures. */
function normalizeErrorSig(lang: ProofLang, error: string): string {
  const first = error.split(/\r?\n/)[0] ?? error;
  return `${lang}:${first
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)}`;
}

/** Extracts a proof goal or theorem context snippet from checker output or recent proof diff. */
function extractGoalSnippet(lang: ProofLang, output: string, fallbackDiff: string | undefined): string | undefined {
  const lines = output.split(/\r?\n/).map((l) => l.trimEnd());

  if (lang === "lean") {
    const turnstile = lines.findIndex((l) => l.includes("⊢"));
    if (turnstile >= 0) {
      let from = turnstile;
      while (from > 0 && turnstile - from < 5) {
        const prev = lines[from - 1]!.trim();
        if (!prev || /:\d+:\d+:\s*error:/i.test(prev) || EXIT_LINE_RE.test(prev)) break;
        from--;
      }
      const snippet = lines.slice(from, Math.min(lines.length, turnstile + 4)).filter((l) => l.trim()).join("\n");
      if (snippet) return snippet;
    }
  } else if (lang === "isabelle") {
    const goalIdx = lines.findIndex((l) => /\bgoal\s*\(\d+\s+subgoals?\)/i.test(l));
    if (goalIdx >= 0) {
      const snippet = lines.slice(goalIdx, Math.min(lines.length, goalIdx + 6)).filter((l) => l.trim()).join("\n");
      if (snippet) return snippet;
    }
  } else if (lang === "rocq") {
    const eqIdx = lines.findIndex((l) => /^={4,}/.test(l.trim()));
    if (eqIdx >= 0) {
      const from = Math.max(0, eqIdx - 4);
      const snippet = lines.slice(from, Math.min(lines.length, eqIdx + 4)).filter((l) => l.trim()).join("\n");
      if (snippet) return snippet;
    }
  } else if (lang === "verus") {
    const arrowIdx = lines.findIndex((l) => /^\s*-->/.test(l));
    if (arrowIdx >= 0) {
      const snippet = lines.slice(arrowIdx, Math.min(lines.length, arrowIdx + 6)).filter((l) => l.trim()).join("\n");
      if (snippet) return snippet;
    }
  } else if (lang === "dafny") {
    const relIdx = lines.findIndex((l) => /Related location:/i.test(l));
    if (relIdx >= 0) {
      const snippet = lines.slice(Math.max(0, relIdx - 1), Math.min(lines.length, relIdx + 3)).filter((l) => l.trim()).join("\n");
      if (snippet) return snippet;
    }
  } else if (lang === "tlc" || lang === "tla") {
    const stateIdx = lines.findIndex((l) => /^State \d+:/i.test(l.trim()));
    if (stateIdx >= 0) {
      const snippet = lines.slice(stateIdx, Math.min(lines.length, stateIdx + 6)).filter((l) => l.trim()).join("\n");
      if (snippet) return snippet;
    }
  }

  // Fallback: theorem/lemma header or context from the most recent diff on this file.
  if (fallbackDiff) {
    const dLines = fallbackDiff.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("@@") && !l.startsWith("---") && !l.startsWith("+++"));
    const stmtIdx = dLines.findIndex((l) => STMT_LINE_RE.test(l));
    if (stmtIdx >= 0) {
      return dLines.slice(stmtIdx, Math.min(dLines.length, stmtIdx + 5)).join("\n").trim();
    }
  }

  return undefined;
}

/** Builds a bounded, redacted winning diff from the edits made between failure and pass. */
function buildWinningDiff(edits: readonly { file: string; diff: string }[], redactor: Redactor): string | undefined {
  const nonEmpty = edits.filter((e) => e.diff.trim().length > 0);
  if (!nonEmpty.length) return undefined;
  const distinctFiles = new Set(nonEmpty.map((e) => e.file));
  const raw =
    distinctFiles.size > 1
      ? nonEmpty.map((e) => `--- ${e.file}\n${e.diff.trim()}`).join("\n\n")
      : nonEmpty.map((e) => e.diff.trim()).join("\n");
  // Redact before clipping so a secret crossing the length boundary is never left partial.
  const redacted = redactor.string(raw);
  return clip(redacted, MAX_WINNING_DIFF_CHARS);
}

function buildProofCase(
  session: Session,
  ep: PendingEpisode,
  outcome: ProofStepOutcome,
  winningCheck: string | undefined,
  redactor: Redactor,
  opts: { split?: Split; tags?: readonly string[] },
): Case {
  const command = clip(redactor.string(ep.firstCommand), MAX_COMMAND_CHARS);
  const error = clip(redactor.string(ep.firstError), MAX_ERROR_CHARS);
  const file = ep.file ? redactor.string(ep.file) : undefined;
  const goalSnippet = ep.goalSnippet ? clip(redactor.string(ep.goalSnippet), MAX_GOAL_SNIPPET_CHARS) : undefined;

  const input: ProofStepInput = {
    kind: "proof-step",
    lang: ep.lang,
    command,
    error,
  };
  if (file) input.file = file;
  if (goalSnippet) input.goalSnippet = goalSnippet;

  let expected: ProofStepExpected;
  if (outcome === "solved") {
    const solved: ProofStepExpectedSolved = {
      resolved: true,
      winningCheck: clip(redactor.string(winningCheck ?? ep.firstCommand), MAX_COMMAND_CHARS),
      attempts: ep.attempts,
    };
    const diff = buildWinningDiff(ep.edits, redactor);
    if (diff) solved.winningDiff = diff;
    expected = solved;
  } else {
    expected = {
      resolved: false,
      attempts: ep.attempts,
    };
  }

  const metadata: Record<string, unknown> = {
    sourceSessionId: session.id,
    lang: ep.lang,
    outcome,
    attempts: ep.attempts,
    command,
    startedAt: session.startedAt,
  };
  if (file) metadata.file = file;
  if (session.repo?.root) metadata.repo = redactor.string(session.repo.root);

  const tags = [...new Set(["proof-step", `proof:${ep.lang}`, `outcome:${outcome}`, `agent:${session.agent}`, ...(opts.tags ?? [])])];
  const id = `ps_${caseContentHash({ input, expected }).slice(0, 16)}`;

  const raw: Record<string, unknown> = {
    id,
    input,
    expected,
    metadata,
    tags,
    sourceSessionId: session.id,
  };
  if (opts.split) raw.split = opts.split;
  return normalizeCase(raw, `session ${session.id} proof-step`);
}

/**
 * Extracts solved proof-step transitions and stuck/unresolved proof goals from a single session.
 * Pure over `(session, events)` with full redaction of all emitted text fields.
 */
export function extractSessionProofSteps(
  session: Session,
  events: readonly AgentEvent[],
  opts: { split?: Split; tags?: readonly string[]; redactor?: Redactor } = {},
): ExtractedProofStep[] {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.ts ?? 0) - (b.e.ts ?? 0) || a.i - b.i).map((x) => x.e);
  const redactor = opts.redactor ?? createRedactor();
  const baseCwd = session.repo?.root ?? session.cwd;

  const proof: HasProof = {};
  const starts = new Map<string, AgentEvent>();
  const activeChecks = new Map<string, { check: ProofCheck; cmd: string; cwd?: string }>();
  const buildLangs = new Map<string, ProofLang>();
  const lastProofFileByLang = new Map<ProofLang, string>();
  const lastDiffByFile = new Map<string, string>();
  const pending = new Map<string, PendingEpisode>();
  const extracted: ExtractedProofStep[] = [];

  for (const e of sorted) {
    const p = e.payload ?? {};
    const cwd = baseCwd ?? e.cwd;

    if (e.kind === "tool.start") {
      const id = str(p.toolUseId);
      if (id) starts.set(id, e);
      const tool = str(p.tool);
      const cmd = shellCommand(tool, p.input);
      if (cmd === undefined) continue;

      if (isShellCall(tool ?? "", p.input)) {
        proofStart(proof, id, cmd, p.input);
        const check = proofCheck(cmd, p.input);
        if (check && id) activeChecks.set(id, { check, cmd, cwd });
      }

      for (const w of shellWrites(cmd)) {
        const path = normalizeTracePath(w.path, cwd);
        const renamedTo = w.renamedTo === undefined ? undefined : normalizeTracePath(w.renamedTo, cwd);
        proofWrite(proof, e, w, path, renamedTo, id, false);
        const known = proof.proof?.files?.get(path)?.lang;
        const lang = isProofConfig(path) ? undefined : proofLang(path, "", known);
        if (lang) {
          lastProofFileByLang.set(lang, path);
          for (const ep of pending.values()) {
            if (ep.lang === lang && (ep.file === undefined || ep.file === path)) {
              ep.editedViaShell = true;
              if (ep.file === undefined) ep.file = path;
            }
          }
        }
      }
    } else if (e.kind === "file.change") {
      const raw = str(p.path);
      if (!raw) continue;
      const path = normalizeTracePath(raw, cwd);
      const id = str(p.toolUseId);
      const start = id ? starts.get(id) : undefined;
      const origin = shellDiffOrigin(e, start, cwd);
      const moved = str(p.movedTo);
      const to = moved ? normalizeTracePath(moved, cwd) : undefined;
      const diff = str(p.diff) ?? "";
      const truncated = p.diffTruncated === true;
      const priorLang = proof.proof?.files?.get(path)?.lang;

      proofChange(proof, e, { path, to, origin, prot: false, test: false });

      const finalPath = to ?? path;
      const recordedLang = proof.proof?.files?.get(finalPath)?.lang ?? priorLang;
      const isConfig = isProofConfig(finalPath);
      const lang = isConfig ? undefined : proofLang(finalPath, diff, recordedLang);
      const rocqOrTlcConfirmed =
        lang !== "rocq" && lang !== "tlc"
          ? true
          : proof.proof?.files?.has(finalPath) ||
            (lang === "rocq" && proof.proof?.rocq === true) ||
            (lang === "tlc" && proof.proof?.tlc === true);

      if (!lang || !rocqOrTlcConfirmed) continue;

      lastProofFileByLang.set(lang, finalPath);
      if (diff) lastDiffByFile.set(finalPath, diff);

      const parsed = !isProofTestPath(finalPath) && diff ? readProofDiff(finalPath, lang, diff, truncated) : undefined;
      for (const ep of pending.values()) {
        if (ep.lang !== lang) continue;
        if (ep.file !== undefined && ep.file !== finalPath) continue;
        if (ep.file === undefined) ep.file = finalPath;
        ep.edits.push({ file: finalPath, diff });
        if (!ep.goalSnippet && diff) {
          const fallbackGoal = extractGoalSnippet(lang, "", diff);
          if (fallbackGoal) ep.goalSnippet = fallbackGoal;
        }
        if (parsed) {
          for (const [hatchName, delta] of parsed.hatches) {
            ep.hatches.set(hatchName, (ep.hatches.get(hatchName) ?? 0) + delta);
          }
        }
      }
    } else if (e.kind === "tool.end") {
      proofEnd(proof, e);
      const id = str(p.toolUseId);
      const active = id ? activeChecks.get(id) : undefined;
      if (!active) continue;
      activeChecks.delete(id!);

      const { check, cmd } = active;
      const text = outText(p.output ?? p.error);
      let lang: ProofLang | undefined;
      if (isProofLang(check.lang)) {
        lang = check.lang;
      } else if (check.lang === "make" || check.lang === "dune") {
        const bkey = `${check.lang}\u0000${check.target ?? ""}\u0000${check.path ?? ""}`;
        const detected = isRocqOutput(text) ? "rocq" : proofOutputLang(text);
        if (detected) {
          buildLangs.set(bkey, detected);
          lang = detected;
        } else if (buildLangs.has(bkey)) {
          lang = buildLangs.get(bkey);
        } else if (!isProofOutput(text)) {
          continue;
        }
      }
      if (!lang) continue;

      const outcome = checkOutcome(check, p);
      const timedOut = p.timedOut === true || (p.ok === false && TIMED_OUT_TEXT.test(text));
      if (outcome === undefined && !timedOut) continue;

      const isRed = outcome === "red" || timedOut;
      const isGreen = outcome === "green" && !timedOut;
      const explicitFile = firstCheckFile(check, active.cwd) ?? extractFileFromOutput(lang, text, active.cwd);

      if (isRed) {
        const file = explicitFile ?? lastProofFileByLang.get(lang);
        const error = extractProofError(text, timedOut);
        const errSig = normalizeErrorSig(lang, error);
        const goalSnippet = extractGoalSnippet(lang, text, file ? lastDiffByFile.get(file) : undefined);

        const exactKey = `${lang}\u0000${file ?? ""}`;
        let ep = pending.get(exactKey);
        if (!ep && file !== undefined) {
          const untargetedKey = `${lang}\u0000`;
          const untargeted = pending.get(untargetedKey);
          if (untargeted) {
            pending.delete(untargetedKey);
            untargeted.key = exactKey;
            untargeted.file = file;
            pending.set(exactKey, untargeted);
            ep = untargeted;
          }
        }

        if (ep) {
          ep.attempts++;
          ep.lastErrorSig = errSig;
          if (!ep.goalSnippet && goalSnippet) ep.goalSnippet = goalSnippet;
        } else {
          const created: PendingEpisode = {
            key: exactKey,
            lang,
            firstCommand: cmd,
            firstError: error,
            lastErrorSig: errSig,
            attempts: 1,
            edits: [],
            editedViaShell: false,
            hatches: new Map(),
          };
          if (file) created.file = file;
          if (goalSnippet) created.goalSnippet = goalSnippet;
          pending.set(exactKey, created);
        }
      } else if (isGreen) {
        // Bypassed checks (e.g. --no-verify, -o quick_and_dirty) never resolve a failing proof.
        if (check.bypass) continue;

        const matchedKeys: string[] = [];
        for (const [k, ep] of pending) {
          if (ep.lang !== lang) continue;
          if (explicitFile !== undefined && ep.file !== undefined && ep.file !== explicitFile) continue;
          matchedKeys.push(k);
        }

        for (const k of matchedKeys) {
          const ep = pending.get(k)!;
          pending.delete(k);
          if (ep.edits.length === 0 && !ep.editedViaShell) continue;

          let escapesAdded = 0;
          for (const delta of ep.hatches.values()) {
            if (delta > 0) escapesAdded += delta;
          }

          extracted.push({
            lang: ep.lang,
            outcome: "solved",
            escapesAdded,
            case: buildProofCase(session, ep, "solved", cmd, redactor, opts),
          });
        }
      }
    }
  }

  for (const ep of pending.values()) {
    extracted.push({
      lang: ep.lang,
      outcome: "stuck",
      escapesAdded: 0,
      case: buildProofCase(session, ep, "stuck", undefined, redactor, opts),
    });
  }

  return extracted;
}

/**
 * Mines formal-verification proof-step cases from stored sessions, applying
 * optional session quality filters, proof language/outcome filters, escape-hatch
 * hygiene, exact and optional near-duplicate filtering, and cap.
 */
export async function mineProofSteps(opts: MineProofStepsOpts): Promise<MineProofStepsReport> {
  if (opts.dedupeNear !== undefined) validateThreshold(opts.dedupeNear, "--dedupe-near");
  if (opts.minTurns !== undefined && (!Number.isSafeInteger(opts.minTurns) || opts.minTurns < 0)) {
    throw new DatasetError(`--min-turns must be a whole number of at least 0, got ${opts.minTurns}`);
  }
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
    throw new DatasetError(`--limit must be a whole number of at least 1, got ${opts.limit}`);
  }
  if (opts.proofLangs?.length) {
    for (const lang of opts.proofLangs) {
      if (!isProofLang(lang)) {
        throw new DatasetError(`invalid proof language ${JSON.stringify(lang)}; must be one of ${PROOF_LANGS.join(", ")}`);
      }
    }
  }
  const wantOutcome: ProofStepOutcomeFilter = opts.outcome ?? "all";
  if (!isProofStepOutcomeFilter(wantOutcome)) {
    throw new DatasetError(`invalid --proof-outcome ${JSON.stringify(wantOutcome)}; must be one of ${PROOF_STEP_OUTCOMES.join(", ")}`);
  }

  const langSet = opts.proofLangs?.length ? new Set<ProofLang>(opts.proofLangs) : undefined;
  const deduper = new CaseDeduper(opts.dedupeNear, opts.shingleSize ?? DEFAULT_SHINGLE_SIZE, opts.existing);
  const redactor = createRedactor();
  const droppedBy: Partial<Record<ProofMineDropReason, number>> = {};
  const duplicates: NearDedupeDrop[] = [];
  let matched = 0;
  let kept = 0;

  for (const s of opts.sessions) {
    if (opts.minTurns !== undefined && (s.stats.turns ?? 0) < opts.minTurns) {
      bumpReason(droppedBy, "min-turns");
      continue;
    }
    if (opts.excludeFlagged && (s.flags ?? []).some(isFailureFlag)) {
      bumpReason(droppedBy, "flagged");
      continue;
    }
    if (opts.minScores?.length) {
      const sScores = opts.scores?.get(s.id);
      const ok = opts.minScores.every((f) => {
        const v = sScores?.get(f.name);
        return v !== undefined && v >= f.min;
      });
      if (!ok) {
        bumpReason(droppedBy, "min-score");
        continue;
      }
    }

    const events = await opts.getEvents(s.id);
    const extractOpts: { split?: Split; tags?: readonly string[]; redactor: Redactor } = { redactor };
    if (opts.split) extractOpts.split = opts.split;
    if (opts.tags?.length) extractOpts.tags = opts.tags;
    const steps = extractSessionProofSteps(s, events, extractOpts);

    for (const step of steps) {
      matched++;
      if (langSet && !langSet.has(step.lang)) {
        bumpReason(droppedBy, "proof-lang");
        continue;
      }
      if (wantOutcome !== "all" && step.outcome !== wantOutcome) {
        bumpReason(droppedBy, "proof-outcome");
        continue;
      }
      if (step.outcome === "solved" && step.escapesAdded > 0) {
        bumpReason(droppedBy, "proof-escape");
        continue;
      }
      if (opts.limit !== undefined && kept >= opts.limit) {
        bumpReason(droppedBy, "limit");
        continue;
      }
      const drop = deduper.consider(step.case);
      if (drop) {
        duplicates.push(drop);
        bumpReason(droppedBy, drop.kind === "exact" ? "exact-duplicate" : "near-duplicate");
        continue;
      }
      kept++;
    }
  }

  const cases = deduper.keptCases();
  let dropped = 0;
  for (const n of Object.values(droppedBy)) {
    if (typeof n === "number") dropped += n;
  }
  return { cases, sessions: opts.sessions.length, matched, kept: cases.length, dropped, droppedBy, duplicates };
}
